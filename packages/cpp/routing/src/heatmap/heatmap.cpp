#include "heatmap.h"

#include "../network/network_prep.h"

#include "../data/duckdb_setup.h"
#include "../input/validation.h"
#include "../kernel/dijkstra.h"
#include "../kernel/dijkstra_k_nearest.h"
#include "../output/hex_resolution.h"
#include "../output/sql_export.h"
#include "../pt/nigiri_routing.h"

#include <nigiri/routing/query.h>
#include <nigiri/timetable.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <duckdb.hpp>
#include <filesystem>
#include <iomanip>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace routing::heatmap
{

using output::sql_escape;
using output::write_query_to_parquet;

namespace
{

// Arc-length spacing for sampling a reached edge's polyline, in metres.
// Coarser than the catchment hexagon builder's 20 m: heatmaps bin to H3 8/9/10,
// whose cells are wide enough that 40 m still lands a sample in every covered
// cell. Do not raise this as a performance tweak — it moves where sample points
// fall, so boundary cells gain or lose their only sample and their min cost
// shifts. Measured at 50 m: 14% fewer samples, no wall-clock gain at 300k
// samples, and 4 cells plus one score changed by >100%.
constexpr double kHeatmapSampleSpacingM = 40.0;

// Resettable stopwatch — each call returns ms since the previous call
// (or since construction).
struct PhaseTimer
{
    std::chrono::steady_clock::time_point t0 = std::chrono::steady_clock::now();
    double elapsed_ms()
    {
        auto now = std::chrono::steady_clock::now();
        double ms = std::chrono::duration<double, std::milli>(now - t0).count();
        t0 = now;
        return ms;
    }
};

// Engine-boundary sanity check. Most field-level constraints are enforced
// by the Python schema layer; this guards against direct C++ misuse.
void validate(HeatmapConfig const &cfg)
{
    if (cfg.opportunities.empty())
        throw std::runtime_error("At least one opportunity is required");
    if (cfg.edge_dir.empty())
        throw std::runtime_error("edge_dir is required");
    if (cfg.output_path.empty())
        throw std::runtime_error("output_path is required");
    if (!(cfg.max_cost > 0.0))
        throw std::invalid_argument("max_cost must be positive");
    // An unlimited budget is bounded by the area network instead, which only
    // the street ClosestAverage path loads.
    if (std::isinf(cfg.max_cost) &&
        (cfg.heatmap_type != HeatmapType::ClosestAverage ||
         cfg.mode == RoutingMode::PublicTransport ||
         cfg.area_cell_centroids.empty()))
        throw std::runtime_error(
            "An unlimited max_cost needs a street-mode ClosestAverage "
            "with area_cell_centroids");
    input::validate_environmental_weights(cfg);
    if (cfg.mode == RoutingMode::PublicTransport)
    {
        // PT goes through run_pt (reverse RAPTOR + precomputed access/egress
        // lookup tables), for all three heatmap types incl. connectivity.
        if (cfg.timetable_path.empty())
            throw std::runtime_error("PT heatmap requires timetable_path");
        if (cfg.access_table_path.empty() || cfg.egress_table_path.empty())
            throw std::runtime_error(
                "PT heatmap requires access_table_path and egress_table_path");
        if (cfg.arrival_time <= 0)
            throw std::runtime_error("PT heatmap requires a positive arrival_time");
    }
    if (cfg.heatmap_type == HeatmapType::Gravity)
    {
        if (cfg.sensitivity <= 0.0)
            throw std::runtime_error("sensitivity must be positive");
        if (cfg.max_sensitivity <= 0.0)
            throw std::runtime_error("max_sensitivity must be positive");
    }
    else if (cfg.heatmap_type == HeatmapType::ClosestAverage)
    {
        if (cfg.closest_k < 1 || cfg.closest_k > 10)
            throw std::runtime_error("closest_k must be in [1, 10]");
    }
    // Connectivity needs no formula-specific knobs.
}

// Half the Earth's WGS84 circumference (m); inverse-Mercator projection of
// EPSG:3857 to (lng, lat).
constexpr double kHalfCirc = 40075016.68557849 / 2.0;

inline double merc_x_to_lng(double x) { return (x / kHalfCirc) * 180.0; }
inline double merc_y_to_lat(double y)
{
    return std::atan(std::sinh(y / (kHalfCirc / M_PI))) * 180.0 / M_PI;
}

// Shared: radial network prep around the opportunities + per-opportunity
// reverse-Dijkstra + reachability-field sampling, projected to H3 cells →
// `out_table`(cell BIGINT, opp_idx INTEGER, min_cost DOUBLE). Used by both the
// street heatmap and the PT direct-leg (which calls it with the access mode).
//
// Takes the network prep input struct directly (instead of a long positional
// parameter list) so routing weights cannot be silently transposed at call
// sites. The search runs on the reverse adjacency (G^T): a Dijkstra from an
// opportunity yields inbound costs v→opp in the original graph, which is the
// pedestrian direction (cell origin → opportunity destination). This already
// handles asymmetric walking costs (uphill vs downhill) — no cost swapping is
// needed; swapping would double-reverse and invert the slope penalty.
void build_reach_per_opp(duckdb::Connection &con,
                         network::HeatmapNetworkPrepInput const &prep_in,
                         int32_t h3_resolution,
                         double spacing_m, std::string const &out_table,
                         std::vector<std::pair<int32_t, int32_t>> const &seed_offsets,
                         PhaseTimer &timer, int32_t closest_k = 1)
{
    auto prep = network::prepare_radial_street_network(con, prep_in);
    std::fprintf(
        stderr,
        "[Pipeline] Network prep (%d nodes, %zu edges, %zu seeds): %.0f ms\n",
        prep.net.node_count, prep.net.source.size(), prep_in.opportunities.size(),
        timer.elapsed_ms());

    bool const use_distance = (prep_in.cost_type == CostType::Distance);
    double const max_cost = prep_in.max_cost;
    auto const &net = prep.net;

    // Incident edges by source node, as a CSR built once and reused across all
    // opportunities, so reachability sampling can walk only the edges labelled
    // by each reached subgraph instead of scanning every edge per opportunity.
    std::vector<int32_t> inc_off(net.node_count + 1, 0);
    for (size_t i = 0; i < net.source.size(); ++i)
        if (net.source[i] >= 0 && net.source[i] < net.node_count)
            ++inc_off[net.source[i] + 1];
    for (int32_t u = 0; u < net.node_count; ++u)
        inc_off[u + 1] += inc_off[u];
    std::vector<int32_t> inc_edges(inc_off[net.node_count]);
    {
        std::vector<int32_t> pos(inc_off.begin(),
                                 inc_off.begin() + net.node_count);
        for (size_t i = 0; i < net.source.size(); ++i)
            if (net.source[i] >= 0 && net.source[i] < net.node_count)
                inc_edges[pos[net.source[i]]++] = static_cast<int32_t>(i);
    }
    // Reused across opportunities — avoids reallocating/zeroing node_count
    // arrays per reverse-Dijkstra (the dominant cost at scale).
    kernel::DijkstraScratch scratch(static_cast<size_t>(net.node_count));

    // Per-opportunity reverse-Dijkstra; sample the reachability field; stream
    // (lng, lat, opp_idx, cost) rows via Appender::AppendDataChunk with a
    // STANDARD_VECTOR_SIZE buffer (the row-at-a-time API dominated wall time).
    // Aggregate incrementally: an opportunity's samples are folded into
    // <out_table> in batches, flushed only at opportunity boundaries. The flat
    // _hm_samples scratch therefore never holds more than one batch. Because a
    // given (cell, opp_idx) group's rows all belong to one opportunity, they
    // never span a batch, so the per-batch GROUP BY is identical to aggregating
    // the whole table once — the reached cell is still counted exactly once.
    constexpr size_t kAggFlushRows = 5'000'000;
    std::string const samples_ddl =
        "CREATE TEMP TABLE _hm_samples "
        "(lng DOUBLE, lat DOUBLE, opp_idx INTEGER, cost DOUBLE)";
    con.Query("DROP TABLE IF EXISTS _hm_samples");
    con.Query(samples_ddl);
    con.Query("DROP TABLE IF EXISTS " + out_table);
    con.Query("CREATE TEMP TABLE " + out_table +
              " (cell BIGINT, opp_idx INTEGER, min_cost DOUBLE)");
    std::string const agg_sql =
        "INSERT INTO " + out_table +
        " SELECT h3_latlng_to_cell(lat, lng, " + std::to_string(h3_resolution) +
        ")::BIGINT AS cell, opp_idx, GREATEST(ROUND(MIN(cost)), 1) AS min_cost"
        " FROM _hm_samples GROUP BY 1, opp_idx";
    {
        auto appender = std::make_unique<duckdb::Appender>(con, "_hm_samples");
        duckdb::vector<duckdb::LogicalType> chunk_types{
            duckdb::LogicalType::DOUBLE,
            duckdb::LogicalType::DOUBLE,
            duckdb::LogicalType::INTEGER,
            duckdb::LogicalType::DOUBLE,
        };
        duckdb::DataChunk chunk;
        chunk.Initialize(duckdb::Allocator::DefaultAllocator(), chunk_types);
        double *lng_col = nullptr;
        double *lat_col = nullptr;
        int32_t *opp_col = nullptr;
        double *cost_col = nullptr;
        auto refresh_pointers = [&]() {
            lng_col = duckdb::FlatVector::GetData<double>(chunk.data[0]);
            lat_col = duckdb::FlatVector::GetData<double>(chunk.data[1]);
            opp_col = duckdb::FlatVector::GetData<int32_t>(chunk.data[2]);
            cost_col = duckdb::FlatVector::GetData<double>(chunk.data[3]);
        };
        refresh_pointers();
        size_t chunk_pos = 0;
        auto flush_chunk = [&]() {
            if (chunk_pos == 0) return;
            chunk.SetCardinality(chunk_pos);
            appender->AppendDataChunk(chunk);
            chunk.Reset();
            refresh_pointers();
            chunk_pos = 0;
        };

        size_t unsnapped = 0;
        size_t total_samples = 0;
        size_t last_drain_at = 0;

        // Walk one reached edge, emitting a sample every spacing_m of arc
        // length with cost linear in the arc fraction between the endpoint
        // costs. Uses the edge polyline when geometry is loaded and the
        // endpoint chord otherwise. Shared by both sampling paths below, which
        // differ only in how they obtain (cost_u, cost_t) for an opportunity.
        auto sample_edge = [&](int32_t const eidx, int32_t const u,
                               int32_t const t, int32_t const opp_idx,
                               double const cost_u, double const cost_t) {
            auto const &geom = net.edges[eidx].geometry;
            Point3857 const chord[2] = {net.node_coords[u], net.node_coords[t]};
            Point3857 const *pts = (geom.size() >= 2) ? geom.data() : chord;
            size_t const npts = (geom.size() >= 2) ? geom.size() : 2;

            double total = 0.0;
            for (size_t j = 1; j < npts; ++j)
            {
                double const ex = pts[j].x - pts[j - 1].x;
                double const ey = pts[j].y - pts[j - 1].y;
                total += std::sqrt(ex * ex + ey * ey);
            }
            if (total <= spacing_m) return;  // endpoints suffice

            double next_s = spacing_m;  // interior points only
            double acc = 0.0;
            for (size_t j = 1; j < npts && next_s < total; ++j)
            {
                double const ex = pts[j].x - pts[j - 1].x;
                double const ey = pts[j].y - pts[j - 1].y;
                double const seg = std::sqrt(ex * ex + ey * ey);
                while (next_s < total && next_s <= acc + seg)
                {
                    double const segfrac = (seg > 0.0) ? (next_s - acc) / seg : 0.0;
                    double const frac = next_s / total;
                    double const cost = cost_u + frac * (cost_t - cost_u);
                    next_s += spacing_m;
                    if (cost > max_cost) continue;
                    lng_col[chunk_pos] = merc_x_to_lng(pts[j - 1].x + segfrac * ex);
                    lat_col[chunk_pos] = merc_y_to_lat(pts[j - 1].y + segfrac * ey);
                    opp_col[chunk_pos] = opp_idx;
                    cost_col[chunk_pos] = cost;
                    if (++chunk_pos == STANDARD_VECTOR_SIZE) flush_chunk();
                    ++total_samples;
                }
                acc += seg;
            }
        };
        // Aggregate the current batch of _hm_samples into <out_table> and clear
        // the scratch. Called only at opportunity boundaries (see invariant
        // above). Recreating the table avoids MVCC bloat from repeated DELETEs.
        auto drain = [&]() {
            flush_chunk();
            appender.reset();  // destroy -> flushed rows become visible
            auto rr = con.Query(agg_sql);
            if (rr->HasError())
                throw std::runtime_error(
                    "Heatmap per-(cell, opp) cost failed: " + rr->GetError());
            con.Query("DROP TABLE IF EXISTS _hm_samples");
            con.Query(samples_ddl);
            appender = std::make_unique<duckdb::Appender>(con, "_hm_samples");
            last_drain_at = total_samples;
        };
        // ------------------------------------------------------------------
        // k > 1 ClosestAverage: one k-nearest traversal instead of one
        // Dijkstra per opportunity. Each node keeps its k cheapest distinct
        // opportunities; samples are emitted per label, so the output shape
        // and the reducer are unchanged.
        //
        // Edge samples need the same opportunity at both endpoints, and
        // pruning can drop one side, so an edge-crossed cell may miss a
        // candidate the per-opportunity path would have found. Validate
        // against that path before trusting this for a given workload.
        // ------------------------------------------------------------------
        if (closest_k > 1)
        {
            std::vector<kernel::DijkstraSource> sources;
            sources.reserve(prep.opportunity_nodes.size());
            for (size_t oi = 0; oi < seed_offsets.size(); ++oi)
            {
                auto const [start_seed, count] = seed_offsets[oi];
                bool any = false;
                for (int32_t j = 0; j < count; ++j)
                {
                    int32_t const n = prep.opportunity_nodes[start_seed + j];
                    if (n < 0) continue;
                    sources.push_back({n, static_cast<int32_t>(oi)});
                    any = true;
                }
                if (!any) ++unsnapped;
            }

            kernel::KNearestScratch k_scratch(
                static_cast<size_t>(net.node_count), closest_k);
            auto const labelled = kernel::dijkstra_k_nearest(
                prep.rev_adj, sources, max_cost, use_distance, k_scratch);

            for (int32_t u : labelled)
            {
                auto const &c = net.node_coords[u];
                double const lng = merc_x_to_lng(c.x);
                double const lat = merc_y_to_lat(c.y);
                std::size_t const b = k_scratch.base(u);
                int32_t const n = k_scratch.n_labels(u);
                for (int32_t i = 0; i < n; ++i)
                {
                    lng_col[chunk_pos] = lng;
                    lat_col[chunk_pos] = lat;
                    opp_col[chunk_pos] = k_scratch.group[b + i];
                    cost_col[chunk_pos] = k_scratch.cost[b + i];
                    if (++chunk_pos == STANDARD_VECTOR_SIZE) flush_chunk();
                    ++total_samples;
                }
            }
            for (int32_t u : labelled)
            {
                std::size_t const bu = k_scratch.base(u);
                int32_t const nu = k_scratch.n_labels(u);
                if (nu == 0) continue;
                for (int32_t ei = inc_off[u]; ei < inc_off[u + 1]; ++ei)
                {
                    int32_t const eidx = inc_edges[ei];
                    int32_t const t = net.target[eidx];
                    if (t < 0 || k_scratch.n_labels(t) == 0) continue;

                    for (int32_t li = 0; li < nu; ++li)
                    {
                        int32_t const opp = k_scratch.group[bu + li];
                        double const cost_u = k_scratch.cost[bu + li];
                        double cost_t = k_scratch.cost_of(t, opp);
                        if (cost_t < 0.0)
                        {
                            // Pruned or unreached at the far end. A label cost is the
                            // cost from a node *to* the opportunity, so if the
                            // edge is traversable t->u then
                            //   cost(t->opp) <= reverse_cost + cost(u->opp),
                            // a valid upper bound. Using it keeps the
                            // opportunity in play instead of dropping the whole
                            // interpolation (which loses edge-crossed cells).
                            // Bounds only overestimate, so a sample can come out
                            // too expensive but never too cheap. One-way edges
                            // admit no bound and still skip.
                            double const rc = net.reverse_cost[eidx];
                            if (rc < 0.0 || rc >= 99999.0) continue;
                            cost_t = cost_u + (use_distance ? rc : rc / 60.0);
                        }
                        sample_edge(eidx, u, t, opp, cost_u, cost_t);
                    }
                    // A single pass cannot drain on opportunity boundaries, so
                    // batches may split a (cell, opp) group; the consolidation
                    // after the loop folds those duplicates back together.
                    if (total_samples - last_drain_at >= kAggFlushRows) drain();
                }
            }
            drain();
        }
        else
        for (size_t oi = 0; oi < seed_offsets.size(); ++oi)
        {   // per-opportunity path (gravity, 2SFCA, ClosestAverage k == 1)
            auto const [start_seed, count] = seed_offsets[oi];
            std::vector<int32_t> group_nodes;
            group_nodes.reserve(count);
            for (int32_t k = 0; k < count; ++k)
            {
                int32_t const n = prep.opportunity_nodes[start_seed + k];
                if (n >= 0) group_nodes.push_back(n);
            }
            if (group_nodes.empty()) { ++unsnapped; continue; }
            // cost[v] = distance from v to the nearest seed.
            auto const reached = kernel::dijkstra_reached(
                prep.rev_adj, group_nodes, max_cost, use_distance, scratch);
            int32_t const opp_idx = static_cast<int32_t>(oi);

            // Sample the reached subgraph: one point per node, plus points
            // interpolated along each reached edge's polyline.
            for (int32_t u : reached)
            {
                auto const &c = net.node_coords[u];
                lng_col[chunk_pos] = merc_x_to_lng(c.x);
                lat_col[chunk_pos] = merc_y_to_lat(c.y);
                opp_col[chunk_pos] = opp_idx;
                cost_col[chunk_pos] = scratch.cost[u];
                if (++chunk_pos == STANDARD_VECTOR_SIZE) flush_chunk();
                ++total_samples;
            }
            for (int32_t u : reached)
            {
                double const cost_u = scratch.cost[u];
                for (int32_t k = inc_off[u]; k < inc_off[u + 1]; ++k)
                {
                    int32_t const eidx = inc_edges[k];
                    int32_t const t = net.target[eidx];
                    if (t < 0 || !scratch.reached(t)) continue;
                    double const cost_t = scratch.cost[t];

                    sample_edge(eidx, u, t, opp_idx, cost_u, cost_t);
                }
            }
            // Opportunity boundary: safe to aggregate the batch (this opp's
            // samples are complete, so no (cell, opp) group is split).
            if (total_samples - last_drain_at >= kAggFlushRows) drain();
        }
        drain();
        if (closest_k > 1)
        {
            auto cc = con.Query(
                "CREATE OR REPLACE TEMP TABLE " + out_table + " AS SELECT cell,"
                " opp_idx, MIN(min_cost) AS min_cost FROM " + out_table +
                " GROUP BY cell, opp_idx");
            if (cc->HasError())
                throw std::runtime_error("k-nearest consolidation failed: " +
                                         cc->GetError());
        }
        std::fprintf(stderr,
                     "[Pipeline] Dijkstras + sampling (%zu opps, %zu unsnapped, "
                     "%zu samples): %.0f ms\n",
                     seed_offsets.size() - unsnapped, unsnapped, total_samples,
                     timer.elapsed_ms());
    }
    con.Query("DROP TABLE IF EXISTS _hm_samples");

    std::fprintf(stderr, "[Pipeline] Per-(cell, opp) cost (%s): %.0f ms\n",
                 out_table.c_str(), timer.elapsed_ms());
}

// Shared: _hm_opp_meta(opp_idx, opp_cell, weight) from the opportunity points.
void build_opp_meta(duckdb::Connection &con,
                    std::vector<Opportunity> const &opportunities,
                    int32_t h3_resolution)
{
    std::ostringstream sql;
    sql << std::setprecision(15);
    sql << "CREATE OR REPLACE TEMP TABLE _hm_opp_meta AS SELECT * FROM (VALUES ";
    bool first = true;
    for (size_t oi = 0; oi < opportunities.size(); ++oi)
    {
        if (!first) sql << ",";
        first = false;
        double const lat = merc_y_to_lat(opportunities[oi].rep.y);
        double const lng = merc_x_to_lng(opportunities[oi].rep.x);
        // opp_count is 1 per opportunity; it lets the shared reducer treat a
        // row as N co-located opportunities (used by the PT path, which groups
        // opportunities by cell). x/y (Web Mercator) let the PT path derive a
        // per-group representative point for the direct (no-transit) leg.
        sql << "(" << oi << ", h3_latlng_to_cell(" << lat << ", " << lng << ", "
            << h3_resolution << ")::BIGINT, " << opportunities[oi].weight
            << ", 1, " << opportunities[oi].rep.x << ", "
            << opportunities[oi].rep.y << ")";
    }
    sql << ") v(opp_idx, opp_cell, weight, opp_count, x_3857, y_3857)";
    auto r = con.Query(sql.str());
    if (r->HasError())
        throw std::runtime_error("Heatmap opp-meta build failed: " +
                                 r->GetError());
}

// Shared: gravity / closest-average / connectivity reducer over
// _hm_per_opp(cell, opp_idx, min_cost) + _hm_opp_meta(opp_idx, opp_cell,
// weight) → parquet (h3_index, score) at cfg.output_path.
void reduce_and_export(HeatmapConfig const &cfg, duckdb::Connection &con,
                       PhaseTimer &timer)
{
    {
        double const inv_sensitivity_norm =
            cfg.max_sensitivity / std::max(cfg.sensitivity, 1.0);

        // Distance-decay W(min_cost), shared by Gravity and 2SFCA.
        std::string decay_expr;
        switch (cfg.decay)
        {
        case GravityDecay::Gaussian:
            decay_expr =
                "EXP(-1.0 * POW(min_cost / " + std::to_string(cfg.max_cost) +
                ", 2) * " + std::to_string(inv_sensitivity_norm) + ")";
            break;
        case GravityDecay::Exponential:
            decay_expr =
                "EXP(-1.0 * (1.0 / " + std::to_string(inv_sensitivity_norm) +
                ") * (min_cost / " + std::to_string(cfg.max_cost) + "))";
            break;
        case GravityDecay::Linear:
            decay_expr =
                "GREATEST(0.0, 1.0 - (min_cost / " +
                std::to_string(cfg.max_cost) + "))";
            break;
        case GravityDecay::Power:
            decay_expr =
                "POW(GREATEST(min_cost / " + std::to_string(cfg.max_cost) +
                ", 1e-9), -1.0 * (1.0 / " +
                std::to_string(inv_sensitivity_norm) + "))";
            break;
        case GravityDecay::Cumulative:
            // Typed DOUBLE so the score column matches the other decays: bare
            // literals here are DECIMAL, and summing them against an integer
            // weight would emit DECIMAL(38,1) instead.
            decay_expr =
                "CASE WHEN min_cost <= " + std::to_string(cfg.max_cost) +
                " THEN 1.0::DOUBLE ELSE 0.0::DOUBLE END";
            break;
        }

        if (cfg.heatmap_type == HeatmapType::TwoSFCA)
        {
            // W = decay for E2SFCA/M2SFCA, binary (1) for standard 2SFCA.
            std::string const W =
                (cfg.two_sfca_type == TwoSFCAType::Standard) ? std::string("1.0")
                                                             : decay_expr;
            // Step-2 weight: 1 / W / W^2 for standard / E2SFCA / M2SFCA.
            std::string const W2 =
                (cfg.two_sfca_type == TwoSFCAType::M2SFCA)
                    ? "(" + decay_expr + " * " + decay_expr + ")"
                : (cfg.two_sfca_type == TwoSFCAType::E2SFCA)
                    ? decay_expr
                    : std::string("1.0");

            // Per-cell demand (cell BIGINT, demand DOUBLE).
            auto rd = con.Query(
                "CREATE OR REPLACE TEMP TABLE _hm_demand AS "
                "SELECT cell::BIGINT AS cell, demand::DOUBLE AS demand "
                "FROM read_parquet('" + cfg.demand_path + "')");
            if (rd->HasError())
                throw std::runtime_error("2SFCA demand load failed: " +
                                         rd->GetError());

            // Step 1: R_j = capacity_j / SUM(demand * W) over reached cells.
            std::ostringstream s1;
            s1 << std::setprecision(15);
            s1 << "CREATE OR REPLACE TEMP TABLE _hm_ratios AS "
               << "SELECT po.opp_idx AS opp_idx, "
               << "MAX(om.weight) / NULLIF(SUM(d.demand * " << W
               << "), 0) AS ratio "
               << "FROM _hm_per_opp po "
               << "JOIN _hm_demand d USING (cell) "
               << "JOIN _hm_opp_meta om USING (opp_idx) "
               << "WHERE po.min_cost <= " << cfg.max_cost << " "
               << "GROUP BY po.opp_idx";
            auto r1 = con.Query(s1.str());
            if (r1->HasError())
                throw std::runtime_error("2SFCA step 1 failed: " +
                                         r1->GetError());

            // Step 2: A_cell = SUM(R_j * W2) over supplies reaching the cell.
            std::ostringstream s2;
            s2 << std::setprecision(15);
            s2 << "CREATE OR REPLACE TEMP TABLE _hm_results AS "
               << "SELECT po.cell AS cell, "
               << "SUM(r.ratio * " << W2 << ") AS score "
               << "FROM _hm_per_opp po "
               << "JOIN _hm_ratios r USING (opp_idx) "
               << "WHERE po.min_cost <= " << cfg.max_cost << " "
               << "GROUP BY po.cell";
            auto r2 = con.Query(s2.str());
            if (r2->HasError())
                throw std::runtime_error("2SFCA step 2 failed: " +
                                         r2->GetError());
        }
        else
        {
        std::ostringstream sql;
        sql << std::setprecision(15);
        sql << "CREATE OR REPLACE TEMP TABLE _hm_results AS ";

        if (cfg.heatmap_type == HeatmapType::Gravity)
        {
            sql << "SELECT po.cell, "
                << "       SUM(om.weight * " << decay_expr << ") AS score "
                << "FROM _hm_per_opp po "
                << "JOIN _hm_opp_meta om USING (opp_idx) "
                << "WHERE po.min_cost <= " << cfg.max_cost << " "
                << "GROUP BY po.cell";
        }
        else if (cfg.heatmap_type == HeatmapType::ClosestAverage)
        {
            int const k = std::max(1, cfg.closest_k);
            // Count-weighted average of the k closest opportunities. Each row
            // represents om.opp_count co-located opportunities at the same
            // cost; `prev` is how many closer opportunities precede this row,
            // so `take` is how many of this row's opportunities fall within the
            // first k. With opp_count = 1 (street) this reduces to "average of
            // the k smallest min_cost".
            sql << "WITH joined AS ("
                << "  SELECT po.cell, po.min_cost, om.opp_count AS cnt "
                << "  FROM _hm_per_opp po "
                << "  JOIN _hm_opp_meta om USING (opp_idx) ";
            if (std::isfinite(cfg.max_cost))
                sql << "  WHERE po.min_cost <= " << cfg.max_cost;
            sql << "), ranked AS ("
                << "  SELECT cell, min_cost, cnt, "
                << "         COALESCE(SUM(cnt) OVER ("
                << "             PARTITION BY cell ORDER BY min_cost "
                << "             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING"
                << "         ), 0) AS prev "
                << "  FROM joined"
                << ") "
                << "SELECT cell, SUM(min_cost * take) / SUM(take) AS score FROM ("
                << "  SELECT cell, min_cost, "
                << "         LEAST(cnt, GREATEST(0, " << k << " - prev)) AS take "
                << "  FROM ranked"
                << ") WHERE take > 0 "
                << "GROUP BY cell";
        }
        else // HeatmapType::Connectivity
        {
            sql << "SELECT om.opp_cell AS cell, "
                << "       SUM(h3_cell_area(po.cell, 'm^2')) AS score "
                << "FROM _hm_per_opp po "
                << "JOIN _hm_opp_meta om USING (opp_idx) "
                << "WHERE po.min_cost <= " << cfg.max_cost << " "
                << "GROUP BY om.opp_cell";
        }

        auto r = con.Query(sql.str());
        if (r->HasError())
            throw std::runtime_error("Heatmap reducer SQL failed: " +
                                     r->GetError());
        }
    }
    std::fprintf(stderr, "[Pipeline] Reducer: %.0f ms\n", timer.elapsed_ms());

    output::write_query_to_parquet(
        con, "SELECT cell AS h3_index, score FROM _hm_results",
        cfg.output_path, "Heatmap parquet export failed");
    std::fprintf(stderr, "[Pipeline] Parquet output: %.0f ms\n",
                 timer.elapsed_ms());
}

// Default speed (km/h) for an access/egress routing mode. Car cost actually
// comes from per-edge OSM maxspeed; its value only sizes the load buffer.
double default_mode_speed(RoutingMode m)
{
    switch (m)
    {
    case RoutingMode::Bicycle: return 15.0;
    case RoutingMode::Pedelec: return 23.0;
    case RoutingMode::Car:     return 50.0;
    default:                   return 5.0;  // Walking
    }
}

// PT heatmap: arrive-by reverse pipeline. Opportunities are grouped by egress
// cell; per group:
//   egress lookup (cell → stops) → reverse RAPTOR → access lookup
//   (boarding stops → cells), MIN'd against a direct same-mode walk/bike leg
//   from the group → _hm_per_opp → shared reducer. Access/egress legs come
//   from precomputed per-mode lookup tables; transit from nigiri; the direct
//   leg is an on-the-fly reverse Dijkstra bounded by the access time limit.
void run_pt(HeatmapConfig const &cfg, duckdb::Connection &con,
            PhaseTimer &timer)
{
    if (cfg.opportunities.empty())
        return;

    // Output and area-summing cells use the fixed PT resolution (res-9, == the
    // access/egress lookup resolution). No extent-based coarsening — the output
    // resolution must not vary with the reference-area size (reproducibility).
    int32_t const h3_resolution =
        output::hex_resolution_for_mode(RoutingMode::PublicTransport);
    int32_t const output_resolution = h3_resolution;
    std::fprintf(stderr, "[Pipeline] Output resolution: h3-%d\n",
                 output_resolution);

    // 1. Load the timetable.
    auto owned_tt =
        nigiri::timetable::read(std::filesystem::path{cfg.timetable_path});
    nigiri::timetable const *tt = &*owned_tt;
    std::fprintf(stderr, "[Pipeline] Load timetable (%u locations): %.0f ms\n",
                 tt->n_locations(), timer.elapsed_ms());

    // 2. Access + egress lookup tables (per-mode parquet) as DuckDB views.
    {
        auto a = con.Query(
            "CREATE OR REPLACE TEMP VIEW _access AS SELECT * FROM read_parquet('"
            + sql_escape(cfg.access_table_path) + "')");
        if (a->HasError())
            throw std::runtime_error("PT: load access table failed: " +
                                     a->GetError());
        auto e = con.Query(
            "CREATE OR REPLACE TEMP VIEW _egress AS SELECT * FROM read_parquet('"
            + sql_escape(cfg.egress_table_path) + "')");
        if (e->HasError())
            throw std::runtime_error("PT: load egress table failed: " +
                                     e->GetError());
    }

    // 3. Opportunity metadata, then group opportunities by egress cell.
    //    Opportunities in the same res-9 cell share egress stops, so their
    //    reverse RAPTOR is identical — routing per distinct cell instead of
    //    per opportunity collapses the dominant cost for clustered layers
    //    (e.g. 10k opportunities → a few hundred distinct cells). Each group
    //    keeps the summed weight + opportunity count so gravity and
    //    closest-average still score per opportunity.
    build_opp_meta(con, cfg.opportunities, h3_resolution);
    {
        auto r = con.Query(
            "CREATE OR REPLACE TEMP TABLE _grp AS "
            "SELECT (row_number() OVER (ORDER BY opp_cell)) - 1 AS grp_idx, "
            "       opp_cell AS grp_cell, SUM(weight) AS weight, "
            "       COUNT(*) AS opp_count, "
            "       AVG(x_3857) AS rep_x, AVG(y_3857) AS rep_y "
            "FROM _hm_opp_meta GROUP BY opp_cell");
        if (r->HasError())
            throw std::runtime_error("PT: group build failed: " + r->GetError());
    }
    size_t n_grps = 0;
    {
        auto r = con.Query("SELECT COUNT(*) FROM _grp");
        n_grps = static_cast<size_t>(r->GetValue(0, 0).GetValue<int64_t>());
    }

    // 4. Egress stops per group (group cell → stops within egress budget).
    {
        std::ostringstream sql;
        sql << "CREATE OR REPLACE TEMP TABLE _egress_stops AS "
            << "SELECT g.grp_idx, e.stop_idx, e.cost_minutes AS egress_min "
            << "FROM _grp g JOIN _egress e ON e.h3_index = g.grp_cell "
            << "WHERE e.cost_minutes <= " << cfg.egress_max_time << " "
            << "ORDER BY g.grp_idx";
        auto r = con.Query(sql.str());
        if (r->HasError())
            throw std::runtime_error("PT: egress lookup failed: " +
                                     r->GetError());
    }

    // 5. Per-group reverse RAPTOR seeded from each group's egress stops →
    //    _pt_reach(grp_idx, stop_idx, cost_min = egress + transfer + transit).
    //    The searches are independent (one_to_all only reads the const
    //    timetable), so they run across a small thread pool. The DuckDB
    //    appender isn't thread-safe, so each thread collects into its own
    //    buffer and we append serially after the join.
    con.Query("DROP TABLE IF EXISTS _pt_reach");
    con.Query("CREATE TEMP TABLE _pt_reach "
              "(grp_idx INTEGER, stop_idx UINTEGER, cost_min DOUBLE)");
    size_t total_reach = 0;  // drives access-join chunk sizing (6b)
    {
        // Build per-group seed lists (serial; cheap). Egress walk + the
        // transit→egress transfer penalty are baked into the seed offset.
        struct GroupSeeds
        {
            int32_t grp;
            std::vector<nigiri::routing::offset> seeds;
        };
        std::vector<GroupSeeds> groups;
        {
            auto rows = con.Query(
                "SELECT grp_idx, stop_idx, egress_min FROM _egress_stops "
                "ORDER BY grp_idx");
            if (rows->HasError())
                throw std::runtime_error("PT: read egress stops failed: " +
                                         rows->GetError());
            size_t const n = rows->RowCount();
            int cur_grp = -1;
            for (size_t i = 0; i < n; ++i)
            {
                int const grp = rows->GetValue(0, i).GetValue<int32_t>();
                uint32_t const stop = rows->GetValue(1, i).GetValue<uint32_t>();
                double const egress_min =
                    rows->GetValue(2, i).GetValue<double>();
                if (grp != cur_grp) { groups.push_back({grp, {}}); cur_grp = grp; }
                double const seed_min = egress_min + cfg.transfer_cost;
                groups.back().seeds.push_back(nigiri::routing::offset{
                    nigiri::location_idx_t{stop},
                    nigiri::duration_t{
                        static_cast<int16_t>(std::lround(seed_min))},
                    0U});
            }
        }

        // Run the reverse RAPTOR for the groups in parallel, striped across
        // threads, collecting (grp, stop, cost) into per-thread buffers.
        struct Reach { int32_t grp; uint32_t stop; double cost; };
        constexpr unsigned kRaptorThreads = 2;
        std::vector<std::vector<Reach>> out(kRaptorThreads);
        std::atomic<size_t> done{0};
        std::atomic<size_t> reach_count{0};
        std::mutex log_mtx;
        auto const raptor_t0 = std::chrono::steady_clock::now();
        constexpr size_t kRaptorProgressEvery = 250;

        auto worker = [&](unsigned tid) {
            auto &buf = out[tid];
            for (size_t gi = tid; gi < groups.size(); gi += kRaptorThreads)
            {
                auto const &g = groups[gi];
                auto reached = pt::run_reverse_raptor(
                    *tt, g.seeds, cfg.arrival_time,
                    static_cast<int>(cfg.max_cost), cfg.max_transfers,
                    cfg.transit_modes);
                for (auto const &pr : reached)
                    buf.push_back({g.grp, pr.first, pr.second});
                reach_count += reached.size();
                size_t const n = ++done;
                if (n % kRaptorProgressEvery == 0)
                {
                    double const ms = std::chrono::duration_cast<
                        std::chrono::duration<double, std::milli>>(
                        std::chrono::steady_clock::now() - raptor_t0).count();
                    std::lock_guard<std::mutex> lk(log_mtx);
                    std::fprintf(stderr,
                        "[Pipeline]   Reverse RAPTOR: %zu/%zu groups, %zu "
                        "reaches (%.0f ms)\n",
                        n, groups.size(), reach_count.load(), ms);
                }
            }
        };
        std::vector<std::thread> threads;
        for (unsigned t = 0; t < kRaptorThreads; ++t)
            threads.emplace_back(worker, t);
        for (auto &th : threads) th.join();

        // Serial append of all per-thread results.
        {
            duckdb::Appender appender(con, "_pt_reach");
            for (auto const &buf : out)
                for (auto const &r : buf)
                {
                    appender.BeginRow();
                    appender.Append<int32_t>(r.grp);
                    appender.Append<uint32_t>(r.stop);
                    appender.Append<double>(r.cost);
                    appender.EndRow();
                }
            appender.Close();
        }
        total_reach = reach_count.load();
        std::fprintf(
            stderr,
            "[Pipeline] Reverse RAPTOR (%zu groups routed, %zu boarding reaches): %.0f ms\n",
            groups.size(), total_reach, timer.elapsed_ms());
    }

    // 6a. Direct leg: reverse-Dijkstra in the access mode from each group's
    //     representative point (single-mode walk/bike to the opportunity, no
    //     transit), bounded by the access time limit (willingness-to-walk is a
    //     fixed threshold; mirrors the catchment). Run per group, not per
    //     opportunity — co-located opportunities share the same walk reach.
    std::vector<Point3857> grp_points;
    {
        auto rows = con.Query("SELECT rep_x, rep_y FROM _grp ORDER BY grp_idx");
        if (rows->HasError())
            throw std::runtime_error("PT: read group points failed: " +
                                     rows->GetError());
        grp_points.reserve(rows->RowCount());
        for (size_t i = 0; i < rows->RowCount(); ++i)
            grp_points.push_back(Point3857{
                rows->GetValue(0, i).GetValue<double>(),
                rows->GetValue(1, i).GetValue<double>()});
    }
    // One seed per group: identity offsets.
    std::vector<std::pair<int32_t, int32_t>> direct_offsets;
    direct_offsets.reserve(grp_points.size());
    for (int32_t i = 0; i < static_cast<int32_t>(grp_points.size()); ++i)
        direct_offsets.push_back({i, 1});
    network::HeatmapNetworkPrepInput const direct_prep_in{
        .opportunities = grp_points,
        .mode = cfg.access_mode,
        .cost_type = CostType::Time,
        .max_cost = static_cast<double>(cfg.access_max_time),
        .speed_km_h = default_mode_speed(cfg.access_mode),
        .edge_dir = cfg.edge_dir,
        .node_dir = cfg.node_dir,
        .area_cells = nullptr,
        .shade_weight = 0.0,
        .heat_weight = 0.0,
        .slope_walk_weight = 0.0,
    };
    build_reach_per_opp(con, direct_prep_in,
                        output_resolution, kHeatmapSampleSpacingM,
                        "_direct_per_opp", direct_offsets, timer,
                        /*closest_k=*/1);

    // 6b. PT-chain cells: boarding-stop cost + access walk, per (cell, group).
    //
    // The access join is the pipeline's memory hot-spot: each reached stop
    // fans out to ~60 access cells, so it is a many-to-many join whose
    // intermediate scales with total boarding reaches. Grouping by egress cell
    // (step 3) already shrinks this sharply for clustered layers; two further
    // guards keep peak memory bounded regardless of group count:
    //   (1) materialize only the access rows for stops actually reached
    //       (and within the access budget) once, so the join build side is
    //       small and we never re-scan the full lookup parquet; and
    //   (2) run the join+aggregate in group-range chunks sized to a target
    //       number of reaches, capping the live join intermediate per chunk.
    {
        std::ostringstream used;
        used << "CREATE OR REPLACE TEMP TABLE _access_used AS "
             << "SELECT a.stop_idx, a.h3_index, a.cost_minutes FROM _access a "
             << "WHERE a.cost_minutes <= " << cfg.access_max_time << " "
             << "  AND a.stop_idx IN (SELECT DISTINCT stop_idx FROM _pt_reach)";
        auto ru = con.Query(used.str());
        if (ru->HasError())
            throw std::runtime_error("PT: access-used build failed: " +
                                     ru->GetError());

        con.Query("DROP TABLE IF EXISTS _pt_per_opp");
        con.Query("CREATE TEMP TABLE _pt_per_opp "
                  "(cell BIGINT, opp_idx INTEGER, min_cost DOUBLE)");

        // ~1M reaches/chunk → bounded join intermediate (~60M rows). Dense
        // groups (high reaches/group) get small chunks; sparse layers run in
        // one pass.
        constexpr size_t kTargetReachPerChunk = 1'000'000;
        size_t chunk_grps = n_grps;
        if (total_reach > kTargetReachPerChunk && n_grps > 1)
            chunk_grps = std::max<size_t>(
                1, n_grps * kTargetReachPerChunk / total_reach);

        for (size_t lo = 0; lo < n_grps; lo += chunk_grps)
        {
            size_t const hi = std::min(n_grps, lo + chunk_grps);
            // cost_min already includes egress + transit + the transit→egress
            // transfer penalty (baked into the seed). Add the access walk plus
            // the access→transit transfer penalty here, mirroring catchment.
            // grp_idx is carried through as opp_idx for the shared reducer.
            std::ostringstream sql;
            sql << std::setprecision(15);
            // Roll the access cell up to the output resolution (no-op when
            // output_resolution == the table's resolution; coarsens to the
            // res-8 parent for large spreads). MIN over the children gives the
            // cheapest access into the coarser cell.
            sql << "INSERT INTO _pt_per_opp "
                << "SELECT h3_cell_to_parent(a.h3_index, " << output_resolution
                << ")::BIGINT AS cell, pr.grp_idx AS opp_idx, "
                << "       GREATEST(ROUND(MIN(pr.cost_min + a.cost_minutes + "
                << cfg.transfer_cost << ")), 1) AS min_cost "
                << "FROM _pt_reach pr JOIN _access_used a "
                << "  ON a.stop_idx = pr.stop_idx "
                << "WHERE pr.grp_idx >= " << lo << " AND pr.grp_idx < " << hi
                << " GROUP BY 1, 2";
            auto r = con.Query(sql.str());
            if (r->HasError())
                throw std::runtime_error("PT: access join failed: " +
                                         r->GetError());
        }
    }

    // 6c. Combine the direct walk leg + PT chain → _hm_per_opp = MIN per
    //     (cell, group), bounded by the total journey budget. opp_idx carries
    //     the group index.
    {
        std::ostringstream sql;
        sql << "CREATE OR REPLACE TEMP TABLE _hm_per_opp AS "
            << "SELECT cell, opp_idx, MIN(min_cost) AS min_cost FROM ("
            << "  SELECT cell, opp_idx, min_cost FROM _direct_per_opp "
            << "  UNION ALL "
            << "  SELECT cell, opp_idx, min_cost FROM _pt_per_opp"
            << ") WHERE min_cost <= " << cfg.max_cost << " GROUP BY 1, 2";
        auto r = con.Query(sql.str());
        if (r->HasError())
            throw std::runtime_error("PT: combine direct+PT failed: " +
                                     r->GetError());
    }
    std::fprintf(stderr, "[Pipeline] Access join + direct + combine: %.0f ms\n",
                 timer.elapsed_ms());

    // 7. Reducer meta: one row per group (grp_idx as the reducer's opp_idx),
    //    carrying the summed weight + opportunity count so gravity sums and
    //    closest-average counts score per opportunity, not per group.
    //    Connectivity keys its output by opp_cell; grp_cell is res-9 (forced by
    //    the egress-table join) but connectivity opportunities are the AOI
    //    cells the caller rasterized at cfg.connectivity_output_resolution, so
    //    roll grp_cell up to that parent resolution. Gravity/closest keep the
    //    res-9 grp_cell unchanged.
    {
        std::string const opp_cell_expr =
            cfg.heatmap_type == HeatmapType::Connectivity
                ? "h3_cell_to_parent(grp_cell, " +
                      std::to_string(cfg.connectivity_output_resolution) + ")"
                : "grp_cell";
        auto r = con.Query(
            "CREATE OR REPLACE TEMP TABLE _hm_opp_meta AS "
            "SELECT grp_idx AS opp_idx, " + opp_cell_expr + " AS opp_cell, "
            "       weight, opp_count FROM _grp");
        if (r->HasError())
            throw std::runtime_error("PT: group meta build failed: " +
                                     r->GetError());
    }

    // _hm_per_opp + _hm_opp_meta are now built; build_reachability_relation's
    // emit callback decides whether to reduce (heatmap) or export (OD matrix).
}

void run_street(HeatmapConfig const &cfg, duckdb::Connection &con,
                PhaseTimer &timer)
{
    if (cfg.opportunities.empty())
        return;

    // Flatten seeds for network prep; seed_offsets[i] = opportunity i's
    // [start, count) range.
    std::vector<Point3857> opp_points;
    std::vector<std::pair<int32_t, int32_t>> seed_offsets;
    seed_offsets.reserve(cfg.opportunities.size());
    for (auto const &o : cfg.opportunities)
    {
        int32_t const start = static_cast<int32_t>(opp_points.size());
        for (auto const &p : o.seeds) opp_points.push_back(p);
        seed_offsets.push_back({start, static_cast<int32_t>(o.seeds.size())});
    }

    int32_t const h3_resolution = output::hex_resolution_for_mode(cfg.mode);

    // ClosestAverage with k = 1 asks only "how far is the nearest opportunity",
    // which one multi-source Dijkstra answers directly — cost[v] is already the
    // cost to the nearest source. Collapsing every opportunity into a single group
    // replaces N per-opportunity traversals with one.
    //
    // Exact, not an approximation: a cell's cost is the min over its sampled
    // points, and min commutes with the min over opportunities, so
    //   min_p min_o cost(p,o) == min_o min_p cost(p,o) == the cell's nearest.
    // The reducer then sees one row per cell; with k = 1 its take is that row,
    // so its output is unchanged.
    //
    // k > 1 still needs per-opportunity costs (the k smallest distinct
    // opportunities per cell), so it keeps the per-opportunity path.
    bool const collapse_to_nearest =
        cfg.heatmap_type == HeatmapType::ClosestAverage && cfg.closest_k == 1;
    if (collapse_to_nearest)
    {
        seed_offsets.assign(
            1, {0, static_cast<int32_t>(opp_points.size())});
    }

    // k == 1 collapses to a single nearest-source traversal above; k > 1 uses
    // the k-nearest traversal inside build_reach_per_opp. Every other formula
    // needs per-opportunity costs and keeps closest_k = 1.
    int32_t const closest_k =
        (cfg.heatmap_type == HeatmapType::ClosestAverage && !collapse_to_nearest)
            ? std::max(1, cfg.closest_k)
            : 1;
    network::HeatmapNetworkPrepInput const prep_in{
        .opportunities = opp_points,
        .mode = cfg.mode,
        .cost_type = cfg.cost_type,
        .max_cost = cfg.max_cost,
        .speed_km_h = cfg.speed_km_h,
        .edge_dir = cfg.edge_dir,
        .node_dir = cfg.node_dir,
        .area_cells = &cfg.area_cell_centroids,
        .shade_weight = cfg.shade_weight,
        .heat_weight = cfg.heat_weight,
        .slope_walk_weight = cfg.slope_walk_weight,
    };
    build_reach_per_opp(con, prep_in,
                        h3_resolution, kHeatmapSampleSpacingM, "_hm_per_opp",
                        seed_offsets, timer, closest_k);
    if (collapse_to_nearest)
    {
        // One synthetic meta row to match the single emitted opp_idx. weight and
        // rep are unused by the ClosestAverage reducer (it reads only opp_count),
        // and opp_count = 1 gives take = 1 at k = 1.
        std::vector<Opportunity> collapsed(1);
        collapsed[0].weight = 1.0;
        collapsed[0].rep = cfg.opportunities.front().rep;
        build_opp_meta(con, collapsed, h3_resolution);
    }
    else
    {
        build_opp_meta(con, cfg.opportunities, h3_resolution);
    }
    // _hm_per_opp + _hm_opp_meta are now built; build_reachability_relation's
    // emit callback decides whether to reduce (heatmap) or export (OD matrix).
}

// Configure the DuckDB connection: extensions + a spill directory (the PT
// intermediates can otherwise exhaust RAM). The memory limit is DuckDB's own
// default, a share of the container's memory.
void configure_connection(HeatmapConfig const &cfg, duckdb::Connection &con,
                          PhaseTimer &timer)
{
    data::ensure_required_extensions_loaded(con);
    {
        std::error_code ec;
        std::filesystem::path spill =
            std::filesystem::path(cfg.output_path).parent_path();
        if (spill.empty())
            spill = std::filesystem::temp_directory_path(ec);
        con.Query("SET temp_directory='" + spill.string() + "'");
    }
    std::fprintf(stderr, "[Pipeline] DuckDB init: %.0f ms\n",
                 timer.elapsed_ms());
}

// Build the per-(cell, opportunity) reachability cost tables (_hm_per_opp +
// _hm_opp_meta). Shared by the heatmap reducer and the OD-cost emitter.
void run_reachability(HeatmapConfig const &cfg, duckdb::Connection &con,
                      PhaseTimer &timer)
{
    if (cfg.mode == RoutingMode::PublicTransport)
        run_pt(cfg, con, timer);
    else
        run_street(cfg, con, timer);
}

// Export the reachability relation as a raw OD cost matrix:
// (orig_cell, dest_cell, cost), one row per reachable (cell, opportunity)
// pair. dest_cell is the opportunity's cell from _hm_opp_meta. `con` holds the
// temp tables built by the shared reachability engine.
void export_od_costs(HeatmapConfig const &cfg, duckdb::Connection &con)
{
    std::ostringstream sql;
    sql << "COPY (SELECT p.cell AS orig_cell, om.opp_cell AS dest_cell, "
        << "CAST(ROUND(p.min_cost) AS INTEGER) AS cost "
        << "FROM _hm_per_opp p JOIN _hm_opp_meta om USING (opp_idx)) "
        << "TO '" << sql_escape(cfg.output_path) << "' (FORMAT PARQUET)";
    auto r = con.Query(sql.str());
    if (r->HasError())
        throw std::runtime_error("OD cost export failed: " + r->GetError());
}

} // namespace

void build_reachability_relation(
    HeatmapConfig const &cfg,
    std::function<void(duckdb::Connection &)> const &emit)
{
    validate(cfg);
    PhaseTimer timer;
    duckdb::DuckDB db(nullptr);
    duckdb::Connection con(db);
    configure_connection(cfg, con, timer);
    run_reachability(cfg, con, timer);
    emit(con);
}

void compute(HeatmapConfig const &cfg)
{
    build_reachability_relation(cfg, [&](duckdb::Connection &con) {
        PhaseTimer timer;
        reduce_and_export(cfg, con, timer);
    });
}

void compute_od_costs(HeatmapConfig const &cfg)
{
    build_reachability_relation(cfg, [&](duckdb::Connection &con) {
        export_od_costs(cfg, con);
    });
}

} // namespace routing::heatmap
