#include "polygon_builder.h"

#include "sql_export.h"
#include "steps.h"

#include <algorithm>
#include <duckdb.hpp>
#include <cmath>
#include <numeric>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace routing::output
{

namespace
{
static constexpr char kPolygonFeaturesTempTable[] = "routing_polygon_features_tmp";
static constexpr double kConcaveHullRatio = 0.2;

// Union-find: assign a contiguous component ID to every node whose cost is
// within max_cost. Nodes connected via traversable edges both within budget
// get the same ID. Unreachable nodes get component_id = -1.
std::vector<int32_t> compute_node_components(ReachabilityField const &field,
                                              double max_cost)
{
    int32_t const n = field.node_count;
    std::vector<int32_t> parent(n);
    std::iota(parent.begin(), parent.end(), 0);

    auto find = [&](int32_t x) -> int32_t
    {
        while (parent[x] != x)
        {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };

    auto const &net = *field.network;
    for (size_t i = 0; i < net.source.size(); ++i)
    {
        int32_t s = net.source[i];
        int32_t t = net.target[i];
        if (s < 0 || t < 0 || s >= n || t >= n)
            continue;
        if (!std::isfinite(field.costs[s]) || field.costs[s] > max_cost)
            continue;
        if (!std::isfinite(field.costs[t]) || field.costs[t] > max_cost)
            continue;
        if (net.cost[i] >= 99999.0 && net.reverse_cost[i] >= 99999.0)
            continue;
        int32_t ra = find(s);
        int32_t rb = find(t);
        if (ra != rb)
            parent[ra] = rb;
    }

    std::unordered_map<int32_t, int32_t> id_map;
    std::vector<int32_t> components(n, -1);
    int32_t next_id = 0;
    for (int32_t v = 0; v < n; ++v)
    {
        if (!std::isfinite(field.costs[v]) || field.costs[v] > max_cost)
            continue;
        int32_t root = find(v);
        auto [it, inserted] = id_map.try_emplace(root, next_id);
        if (inserted)
            ++next_id;
        components[v] = it->second;
    }
    return components;
}

} // namespace

std::string const &polygon_features_table_name()
{
    static std::string const table_name = kPolygonFeaturesTempTable;
    return table_name;
}

int64_t materialize_polygon_features_table(
    std::vector<ReachabilityField> const &fields,
    RequestConfig const &cfg,
    duckdb::Connection &con)
{
    if (fields.empty())
        return 0;

    auto drop_features = con.Query(std::string("DROP TABLE IF EXISTS ") +
                                   kPolygonFeaturesTempTable);
    if (drop_features->HasError())
        throw std::runtime_error("Failed to drop polygon features temp table: " +
                                 drop_features->GetError());

    // reached_nodes: one row per reachable node per origin.
    auto drop_nodes = con.Query("DROP TABLE IF EXISTS reached_nodes");
    if (drop_nodes->HasError())
        throw std::runtime_error("Failed to drop reached_nodes: " +
                                 drop_nodes->GetError());
    auto create_nodes = con.Query(
        "CREATE TEMP TABLE reached_nodes ("
        "  origin_idx INTEGER, node_id INTEGER, cost DOUBLE, x DOUBLE, y DOUBLE"
        ")");
    if (create_nodes->HasError())
        throw std::runtime_error("Failed to create reached_nodes: " +
                                 create_nodes->GetError());

    // node_step_components: component ID per (origin, step, node).
    auto drop_comp = con.Query("DROP TABLE IF EXISTS node_step_components");
    if (drop_comp->HasError())
        throw std::runtime_error("Failed to drop node_step_components: " +
                                 drop_comp->GetError());
    auto create_comp = con.Query(
        "CREATE TEMP TABLE node_step_components ("
        "  origin_idx INTEGER, step_cost DOUBLE, node_id INTEGER, component_id INTEGER"
        ")");
    if (create_comp->HasError())
        throw std::runtime_error("Failed to create node_step_components: " +
                                 create_comp->GetError());

    // Downsample interior nodes for concave hull performance.
    // Only applied for large networks; small catchments keep all nodes.
    // Boundary nodes (cost near a step threshold) are always kept.
    static constexpr int32_t kDownsampleThreshold = 50000;
    static constexpr int32_t kDownsampleFactor = 10;
    auto const step_costs = compute_step_cutoffs(cfg);

    int64_t total_reached_across_fields = 0;
    int64_t reached_node_total = 0;

    {
        duckdb::Appender nodes_appender(con, "reached_nodes");
        for (size_t oi = 0; oi < fields.size(); ++oi)
        {
            auto const &field = fields[oi];

            int64_t total_reachable = 0;
            for (int32_t nid = 0; nid < field.node_count; ++nid)
            {
                double const cost = field.costs[static_cast<std::size_t>(nid)];
                if (std::isfinite(cost) && cost >= 0.0 && cost <= cfg.cost_budget())
                    ++total_reachable;
            }
            bool const downsample = total_reachable > kDownsampleThreshold;
            int32_t sample_counter = 0;

            for (int32_t nid = 0; nid < field.node_count; ++nid)
            {
                double const cost = field.costs[static_cast<std::size_t>(nid)];
                if (!std::isfinite(cost) || cost < 0.0 || cost > cfg.cost_budget())
                    continue;
                if (!field.network ||
                    static_cast<std::size_t>(nid) >= field.network->node_coords.size())
                    continue;

                if (downsample)
                {
                    bool is_boundary = false;
                    for (double sc : step_costs)
                    {
                        if (std::abs(cost - sc) < sc * 0.1)
                        {
                            is_boundary = true;
                            break;
                        }
                    }
                    if (!is_boundary && (sample_counter++ % kDownsampleFactor) != 0)
                        continue;
                }

                auto const &coord = field.network->node_coords[static_cast<std::size_t>(nid)];
                nodes_appender.BeginRow();
                nodes_appender.Append(static_cast<int32_t>(oi));
                nodes_appender.Append(nid);
                nodes_appender.Append(cost);
                nodes_appender.Append(coord.x);
                nodes_appender.Append(coord.y);
                nodes_appender.EndRow();
                ++reached_node_total;
            }

            total_reached_across_fields += total_reachable;
        }
    }

    if (reached_node_total == 0)
        return 0;

    {
        duckdb::Appender comp_appender(con, "node_step_components");
        for (size_t oi = 0; oi < fields.size(); ++oi)
        {
            auto const &field = fields[oi];
            for (double const step : step_costs)
            {
                auto const comps = compute_node_components(field, step);
                for (int32_t nid = 0; nid < field.node_count; ++nid)
                {
                    if (comps[static_cast<std::size_t>(nid)] < 0)
                        continue;
                    comp_appender.BeginRow();
                    comp_appender.Append(static_cast<int32_t>(oi));
                    comp_appender.Append(step);
                    comp_appender.Append(nid);
                    comp_appender.Append(comps[static_cast<std::size_t>(nid)]);
                    comp_appender.EndRow();
                }
            }
        }
    }

    // One concave hull per (origin_idx, step_cost, component_id).
    // component_id is step-local AND origin-local: two reached nodes share a
    // component only if they are graph-connected within that step's budget
    // FROM the same origin's Dijkstra.
    // Adaptive ratio: smoother for small catchments, tighter for large ones.
    double ratio = (total_reached_across_fields < 10000) ? 0.5
                 : (total_reached_across_fields < 50000) ? 0.3
                 : kConcaveHullRatio;
    std::string const hull_ratio = std::to_string(ratio);

    // Materialize the per-component concave hulls once. Left as a CTE it is
    // referenced twice (total_hulls + bands_per_component), which re-runs the
    // (expensive) ST_ConcaveHull for every component.
    con.Query("DROP TABLE IF EXISTS _poly_hulls_pc");
    {
        auto r = con.Query(
            "CREATE TEMP TABLE _poly_hulls_pc AS "
            "SELECT c.origin_idx, c.step_cost, c.component_id, "
            "       ST_ConcaveHull(ST_Union_Agg(ST_Point(n.x, n.y)), " + hull_ratio + ", false) AS geom "
            "FROM node_step_components c "
            "JOIN reached_nodes n "
            "  ON n.origin_idx = c.origin_idx AND n.node_id = c.node_id "
            "GROUP BY c.origin_idx, c.step_cost, c.component_id "
            "HAVING count(*) >= 3");
        if (r->HasError())
            throw std::runtime_error("Polygon hulls materialization failed: " +
                                     r->GetError());
    }

    std::string create_sql;
    if (cfg.polygon_difference)
    {
        // For each component at step k, subtract the *total* coverage at step k-1
        // (all components for the SAME origin unioned). Two components that were
        // separate at step k-1 and merged at step k are still handled correctly.
        create_sql =
            std::string("CREATE TEMP TABLE ") + kPolygonFeaturesTempTable + " AS "
            "WITH total_hulls AS ("
            "  SELECT origin_idx, step_cost, ST_MakeValid(ST_Union_Agg(geom)) AS geom"
            "  FROM _poly_hulls_pc"
            "  WHERE geom IS NOT NULL"
            "  GROUP BY origin_idx, step_cost"
            "), total_hulls_prev AS ("
            "  SELECT origin_idx, step_cost, geom,"
            "         LAG(geom) OVER (PARTITION BY origin_idx ORDER BY step_cost) AS prev_geom"
            "  FROM total_hulls"
            "), bands_per_component AS ("
            "  SELECT c.origin_idx, c.step_cost, c.component_id,"
            "         ST_MakeValid("
            "           CASE WHEN t.prev_geom IS NULL THEN c.geom"
            "                ELSE ST_Difference(c.geom, t.prev_geom) END"
            "         ) AS geom"
            "  FROM _poly_hulls_pc c"
            "  JOIN total_hulls_prev t"
            "    ON t.origin_idx = c.origin_idx AND t.step_cost = c.step_cost"
            "), hulls AS ("
            "  SELECT origin_idx, step_cost, ST_MakeValid(ST_Union_Agg(geom)) AS geom"
            "  FROM bands_per_component"
            "  WHERE geom IS NOT NULL"
            "    AND ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON')"
            "  GROUP BY origin_idx, step_cost"
            "), normalized AS ("
            "  SELECT origin_idx, step_cost,"
            "         CASE"
            "           WHEN ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON') THEN geom"
            "           ELSE NULL"
            "         END AS geom"
            "  FROM hulls"
            ") "
            "SELECT"
            "  step_cost,"
            "  ST_Transform(geom, 'EPSG:3857', 'OGC:CRS84') AS geometry "
            "FROM normalized "
            "WHERE geom IS NOT NULL "
            "ORDER BY origin_idx, step_cost";
    }
    else
    {
        create_sql =
            std::string("CREATE TEMP TABLE ") + kPolygonFeaturesTempTable + " AS "
            "WITH hulls AS ("
            "  SELECT origin_idx, step_cost, ST_MakeValid(ST_Union_Agg(geom)) AS geom"
            "  FROM _poly_hulls_pc"
            "  WHERE geom IS NOT NULL"
            "  GROUP BY origin_idx, step_cost"
            "), normalized AS ("
            "  SELECT origin_idx, step_cost,"
            "         CASE"
            "           WHEN ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON') THEN geom"
            "           ELSE NULL"
            "         END AS geom"
            "  FROM hulls"
            ") "
            "SELECT"
            "  step_cost,"
            "  ST_Transform(geom, 'EPSG:3857', 'OGC:CRS84') AS geometry "
            "FROM normalized "
            "WHERE geom IS NOT NULL "
            "ORDER BY origin_idx, step_cost";
    }

    auto create_features = con.Query(create_sql);
    if (create_features->HasError())
        throw std::runtime_error("Polygon features materialization failed: " +
                                 create_features->GetError());

    return count_rows(con, kPolygonFeaturesTempTable);
}

} // namespace routing::output
