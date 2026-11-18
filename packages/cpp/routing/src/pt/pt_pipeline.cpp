#include "pt_pipeline.h"

#include "access.h"
#include "combine_catchments.h"
#include "egress.h"
#include "nigiri_routing.h"
#include "stop_finder.h"
#include "timetable_io.h"

#include "../kernel/dijkstra.h"
#include "../kernel/graph_builder.h"
#include "../kernel/mode_selector.h"
#include "../kernel/reachability_field.h"
#include "../kernel/snap.h"

#include <nigiri/timetable.h>

#include <chrono>
#include <cstdio>
#include <memory>
#include <unordered_set>

namespace routing::pt
{

    namespace
    {
        std::vector<Edge> merge_edge_sets(
            std::vector<Edge> egress_edges,
            std::vector<Edge> access_edges)
        {
            std::unordered_set<int64_t> seen;
            seen.reserve(egress_edges.size());
            for (auto const &e : egress_edges)
                seen.insert(e.id);

            for (auto &e : access_edges)
            {
                if (seen.find(e.id) == seen.end())
                    egress_edges.push_back(std::move(e));
            }
            return egress_edges;
        }
    } // namespace

    // Core PT pipeline logic. When extra_points is non-empty, snaps them
    // onto the combined network and returns their node IDs.
    // When pre_tt is provided, skips timetable loading.
    PtPipelineResult run_pt_pipeline_impl(
        RequestConfig const &cfg,
        duckdb::Connection &con,
        std::vector<Point3857> const &extra_points,
        nigiri::timetable const *pre_tt = nullptr)
    {
        auto t0 = std::chrono::steady_clock::now();
        auto elapsed = [&]() {
            auto now = std::chrono::steady_clock::now();
            double ms = std::chrono::duration<double, std::milli>(now - t0).count();
            t0 = now;
            return ms;
        };

        // 1. Load timetable (or reuse pre-loaded)
        std::unique_ptr<MappedTimetable> owned_tt;
        nigiri::timetable const *tt;
        if (pre_tt)
        {
            tt = pre_tt;
        }
        else
        {
            owned_tt = std::make_unique<MappedTimetable>(cfg.timetable_path);
            tt = owned_tt->get();
            std::fprintf(stderr, "[PT] 1. Load timetable: %.0f ms\n", elapsed());
        }

        // 2. Access leg
        auto access = compute_access(cfg, con, *tt);
        std::fprintf(stderr, "[PT] 2. Access leg (%zu edges, %zu seeds): %.0f ms\n",
                     access.raw_edges.size(), access.seeds.size(), elapsed());

        // 3. RAPTOR transit search
        auto transit_costs = run_raptor(*tt, access.seeds, cfg);
        size_t reachable_stops = 0;
        for (auto const &c : transit_costs)
            if (c.has_value()) ++reachable_stops;
        std::fprintf(stderr, "[PT] 3. RAPTOR (%zu reachable stops, window=%d): %.0f ms\n",
                     reachable_stops, cfg.departure_window, elapsed());

        // 4. Egress leg: load street network around reachable stops
        auto egress_edges = load_egress_edges(cfg, con, *tt, transit_costs);
        std::fprintf(stderr, "[PT] 4. Load egress edges (%zu edges): %.0f ms\n",
                     egress_edges.size(), elapsed());

        if (egress_edges.empty())
        {
            // No reachable stops — snap extra points onto the access network.
            std::vector<int32_t> extra_ids;
            if (!extra_points.empty())
            {
                RequestConfig egress_cfg = cfg;
                egress_cfg.mode = cfg.egress_mode;
                if (cfg.egress_speed_km_h > 0.0)
                    egress_cfg.speed_km_h = cfg.egress_speed_km_h;
                extra_ids = kernel::snap_origins(
                    access.net, extra_points, egress_cfg);
            }
            return {
                kernel::make_reachability_field(
                    std::move(access.costs), std::move(access.net)),
                std::move(extra_ids)};
        }

        // 5. Build combined network
        auto combined_edges = merge_edge_sets(
            std::move(egress_edges), std::move(access.raw_edges));

        RequestConfig egress_cfg = cfg;
        egress_cfg.mode = cfg.egress_mode;
        if (cfg.egress_speed_km_h > 0.0)
            egress_cfg.speed_km_h = cfg.egress_speed_km_h;

        kernel::compute_costs(combined_edges, egress_cfg);
        auto combined_net = kernel::build_sub_network(combined_edges);
        // combined_edges remain usable after build_sub_network: geometry was
        // std::move'd into EdgeInfo, but compute_costs only reads
        // length_m/class_/impedance fields which are still intact.
        std::fprintf(stderr, "[PT] 5. Build combined network (%zu edges, %d nodes): %.0f ms\n",
                     combined_net.source.size(), combined_net.node_count, elapsed());

        // 6. Snap origins, stops, and extra destination points.
        RequestConfig access_cfg = cfg;
        access_cfg.mode = cfg.access_mode;
        if (cfg.access_speed_km_h > 0.0)
            access_cfg.speed_km_h = cfg.access_speed_km_h;
        auto start_nodes = kernel::snap_origins(
            combined_net, cfg.starting_points, access_cfg);

        // Only snap stops that RAPTOR actually reached.
        auto all_stop_coords = get_stop_coords_3857(*tt);
        std::vector<Point3857> reachable_coords;
        std::vector<size_t> reachable_indices;
        for (size_t i = 0; i < transit_costs.size(); ++i)
        {
            if (transit_costs[i].has_value() &&
                *transit_costs[i] < cfg.max_cost)
            {
                reachable_coords.push_back(all_stop_coords[i]);
                reachable_indices.push_back(i);
            }
        }

        std::vector<int32_t> stop_nodes(all_stop_coords.size(), -1);
        if (!reachable_coords.empty())
        {
            auto snapped = kernel::snap_origins(
                combined_net, reachable_coords, egress_cfg,
                kMaxStopSnapDistanceMeters);
            for (size_t j = 0; j < snapped.size(); ++j)
                stop_nodes[reachable_indices[j]] = snapped[j];
        }

        // Snap extra destination points onto the combined network.
        std::vector<int32_t> extra_ids;
        if (!extra_points.empty())
            extra_ids = kernel::snap_origins(
                combined_net, extra_points, egress_cfg);

        std::vector<int32_t> valid_starts;
        for (auto s : start_nodes)
            if (s >= 0)
                valid_starts.push_back(s);

        double access_budget;
        if (cfg.access_max_cost > 0.0)
        {
            if (cfg.access_cost_type == CostType::Distance)
            {
                double speed = (cfg.access_speed_km_h > 0.0)
                                   ? cfg.access_speed_km_h : cfg.speed_km_h;
                access_budget = cfg.access_max_cost / (speed * 1000.0 / 60.0);
            }
            else
            {
                access_budget = cfg.access_max_cost;
            }
        }
        else
        {
            access_budget = cfg.max_cost;
        }

        std::fprintf(stderr, "[PT] 6. Snap (origins=%zu, stops=%zu): %.0f ms\n",
                     valid_starts.size(), reachable_coords.size(), elapsed());

        // 7. Access Dijkstra on combined network
        std::vector<double> access_costs;
        if (cfg.access_mode != cfg.egress_mode ||
            (cfg.access_speed_km_h > 0.0 &&
             cfg.access_speed_km_h != cfg.egress_speed_km_h))
        {
            kernel::compute_costs(combined_edges, access_cfg);

            std::vector<std::vector<AdjEntry>> adj(combined_net.node_count);
            // Recosted edges from the original load
            for (size_t i = 0; i < combined_edges.size() &&
                               i < combined_net.source.size(); ++i)
            {
                double const c = combined_edges[i].cost;
                double const rc = combined_edges[i].reverse_cost;
                if (c >= 0.0 && c < 99999.0)
                    adj[combined_net.source[i]].push_back(
                        {combined_net.target[i], c});
                if (rc >= 0.0 && rc < 99999.0)
                    adj[combined_net.target[i]].push_back(
                        {combined_net.source[i], rc});
            }
            // Connector edges added by snap (not in combined_edges)
            for (size_t i = combined_edges.size(); i < combined_net.source.size(); ++i)
            {
                double const c = combined_net.cost[i];
                double const rc = combined_net.reverse_cost[i];
                if (c >= 0.0 && c < 99999.0)
                    adj[combined_net.source[i]].push_back(
                        {combined_net.target[i], c});
                if (rc >= 0.0 && rc < 99999.0)
                    adj[combined_net.target[i]].push_back(
                        {combined_net.source[i], rc});
            }
            access_costs = kernel::dijkstra(
                adj, valid_starts, access_budget, /*use_distance=*/false);
        }
        else
        {
            auto adj = kernel::build_adjacency_list(combined_net);
            access_costs = kernel::dijkstra(
                adj, valid_starts, access_budget, /*use_distance=*/false);
        }

        std::fprintf(stderr, "[PT] 7. Access Dijkstra: %.0f ms\n", elapsed());

        // 8. Egress Dijkstra on combined network
        auto egress_costs = compute_egress_costs(
            combined_net, combined_edges, stop_nodes, transit_costs, cfg);
        std::fprintf(stderr, "[PT] 8. Egress Dijkstra: %.0f ms\n", elapsed());

        // 9. Merge
        auto result = PtPipelineResult{
            merge_fields(
                std::move(access_costs), egress_costs, std::move(combined_net)),
            std::move(extra_ids)};
        std::fprintf(stderr, "[PT] 9. Merge: %.0f ms\n", elapsed());
        return result;
    }

    ReachabilityField run_pt_pipeline(RequestConfig const &cfg,
                                      duckdb::Connection &con)
    {
        return run_pt_pipeline_impl(cfg, con, {}).field;
    }

    PtPipelineResult run_pt_pipeline_with_destinations(
        RequestConfig const &cfg,
        duckdb::Connection &con,
        std::vector<Point3857> const &extra_points,
        nigiri::timetable const *pre_tt)
    {
        return run_pt_pipeline_impl(cfg, con, extra_points, pre_tt);
    }

} // namespace routing::pt
