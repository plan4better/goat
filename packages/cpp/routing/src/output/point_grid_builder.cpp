#include "point_grid_builder.h"

#include "sql_export.h"

#include "../kernel/kdtree.h"

#include <cmath>
#include <duckdb.hpp>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace routing::output
{

namespace
{
static constexpr char kPointGridFeaturesTempTable[] = "routing_point_grid_features_tmp";
static constexpr double kDefaultSnapDistance = 500.0; // meters in EPSG:3857
static constexpr double kSampleSpacing = 20.0;       // meters between interpolated points

struct SamplePoint
{
    double x; // web mercator
    double y;
    double cost;
};

int64_t count_rows(duckdb::Connection &con, std::string const &table)
{
    auto result = con.Query("SELECT count(*) FROM " + table);
    if (result->HasError())
        throw std::runtime_error("Failed to count rows in " + table + ": " +
                                 result->GetError());
    return result->GetValue(0, 0).GetValue<int64_t>();
}

} // namespace

std::string const &point_grid_features_table_name()
{
    static std::string const table_name = kPointGridFeaturesTempTable;
    return table_name;
}

int64_t materialize_point_grid_features_table(ReachabilityField const &field,
                                              RequestConfig const &cfg,
                                              duckdb::Connection &con)
{
    if (!field.network)
        return 0;

    auto const &net = *field.network;
    double const budget = cfg.cost_budget();
    double const snap_dist = (cfg.grid_snap_distance > 0.0)
                                 ? cfg.grid_snap_distance
                                 : kDefaultSnapDistance;
    double const speed_m_s = (cfg.speed_km_h > 0.0)
                                 ? (cfg.speed_km_h * 1000.0 / 3600.0)
                                 : (5.0 * 1000.0 / 3600.0);

    // 1. Build sample points from node coords + edge interpolation (C++)
    std::vector<SamplePoint> points;
    points.reserve(net.node_count);

    for (int32_t nid = 0; nid < net.node_count; ++nid)
    {
        double cost = field.costs[nid];
        if (!std::isfinite(cost) || cost > budget)
            continue;
        auto const &c = net.node_coords[nid];
        points.push_back({c.x, c.y, cost});
    }

    for (size_t i = 0; i < net.source.size(); ++i)
    {
        int32_t s = net.source[i];
        int32_t t = net.target[i];
        if (s < 0 || t < 0 ||
            s >= static_cast<int32_t>(field.costs.size()) ||
            t >= static_cast<int32_t>(field.costs.size()))
            continue;

        double src_cost = field.costs[s];
        double tgt_cost = field.costs[t];
        if (!std::isfinite(src_cost) || !std::isfinite(tgt_cost))
            continue;
        if (std::min(src_cost, tgt_cost) > budget)
            continue;

        double length = net.length_3857[i];
        if (length <= kSampleSpacing)
            continue;

        auto const &sc = net.node_coords[s];
        auto const &tc = net.node_coords[t];
        double dx = tc.x - sc.x;
        double dy = tc.y - sc.y;

        int n_splits = static_cast<int>(std::floor(length / kSampleSpacing));
        for (int n = 1; n < n_splits; ++n)
        {
            double frac = static_cast<double>(n) / n_splits;
            double cost = src_cost + frac * (tgt_cost - src_cost);
            if (cost > budget)
                continue;
            points.push_back({sc.x + frac * dx, sc.y + frac * dy, cost});
        }
    }

    if (points.empty())
        return 0;

    // 2. Build KD-tree
    std::vector<Point3857> kd_coords(points.size());
    for (size_t i = 0; i < points.size(); ++i)
        kd_coords[i] = {points[i].x, points[i].y};
    kernel::KdTree2D tree(kd_coords);

    // 3. Read grid points from parquet, snap each to nearest sample point
    std::string points_path = sql_escape(cfg.grid_points_path);
    auto grid_result = con.Query(
        "SELECT id, CAST(x_3857 AS DOUBLE) AS x, CAST(y_3857 AS DOUBLE) AS y "
        "FROM read_parquet('" + points_path + "')");

    if (grid_result->HasError())
        throw std::runtime_error("Failed to read grid points: " +
                                 grid_result->GetError());

    // Build step_cost expression
    std::string step_cost_expr;
    if (!cfg.cutoffs.empty())
    {
        std::ostringstream cases;
        cases << "CASE ";
        for (int c : cfg.cutoffs)
            cases << "WHEN cost <= " << c << " THEN " << c << " ";
        cases << "ELSE " << cfg.cutoffs.back() << " END";
        step_cost_expr = cases.str();
    }
    else
    {
        double const step_size = (cfg.steps > 0)
            ? (budget / static_cast<double>(cfg.steps))
            : 0.0;
        if (cfg.steps <= 0 || step_size <= 0.0)
            step_cost_expr = "cost";
        else
        {
            std::ostringstream expr;
            expr << "CEIL(cost / " << sql_double(step_size) << ") * "
                 << sql_double(step_size);
            step_cost_expr = expr.str();
        }
    }

    // 4. Snap grid points and write results to temp table
    con.Query(std::string("DROP TABLE IF EXISTS ") + kPointGridFeaturesTempTable);
    con.Query(std::string("CREATE TEMP TABLE ") + kPointGridFeaturesTempTable +
              " (id INTEGER, cost DOUBLE, step_cost DOUBLE, x DOUBLE, y DOUBLE)");

    {
        duckdb::Appender appender(con, kPointGridFeaturesTempTable);
        while (true)
        {
            auto chunk = grid_result->Fetch();
            if (!chunk || chunk->size() == 0)
                break;

            for (size_t row = 0; row < chunk->size(); ++row)
            {
                int64_t id = chunk->GetValue(0, row).GetValue<int64_t>();
                double gx = chunk->GetValue(1, row).GetValue<double>();
                double gy = chunk->GetValue(2, row).GetValue<double>();

                auto [idx, dist] = tree.nearest_within({gx, gy}, snap_dist);
                if (idx < 0)
                    continue;

                double base_cost = points[idx].cost;
                double walk_cost = (cfg.cost_type == CostType::Distance)
                                       ? dist
                                       : (dist / speed_m_s) / 60.0;
                double total = base_cost + walk_cost;
                if (total > budget)
                    continue;

                appender.BeginRow();
                appender.Append(static_cast<int32_t>(id));
                appender.Append(std::round(total));
                appender.Append(0.0); // placeholder, computed below
                appender.Append(gx);
                appender.Append(gy);
                appender.EndRow();
            }
        }
    }

    // 5. Update step_cost and add geometry
    std::string final_sql =
        std::string("CREATE TEMP TABLE routing_point_grid_final AS "
        "SELECT id, CAST(ROUND(cost) AS DOUBLE) AS cost, "
        "CAST(") + step_cost_expr + " AS INTEGER) AS cost_step, "
        "ST_Transform(ST_Point(x, y), 'EPSG:3857', 'OGC:CRS84') AS geometry "
        "FROM " + kPointGridFeaturesTempTable;

    con.Query(std::string("DROP TABLE IF EXISTS routing_point_grid_final"));
    auto final_result = con.Query(final_sql);
    if (final_result->HasError())
        throw std::runtime_error("Point grid final table failed: " +
                                 final_result->GetError());

    // Swap tables
    con.Query(std::string("DROP TABLE IF EXISTS ") + kPointGridFeaturesTempTable);
    con.Query(std::string("ALTER TABLE routing_point_grid_final RENAME TO ") +
              kPointGridFeaturesTempTable);

    return count_rows(con, kPointGridFeaturesTempTable);
}

} // namespace routing::output
