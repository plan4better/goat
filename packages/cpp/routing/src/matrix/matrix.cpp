#include "matrix.h"

#include "../data/duckdb_setup.h"
#include "../input/validation.h"
#include "../kernel/dijkstra.h"
#include "../network/network_prep.h"
#include "../output/sql_export.h"
#include "../pt/pt_pipeline.h"

#include <cmath>
#include <cstdint>
#include <duckdb.hpp>
#include <filesystem>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace routing::matrix
{

    namespace
    {
        // Build a RequestConfig from a MatrixConfig for reusing
        // edge loading, cost computation, and snapping infrastructure.
        RequestConfig matrix_to_request_config(
            MatrixConfig const &cfg,
            std::vector<Point3857> const &starting_points)
        {
            RequestConfig rcfg;
            rcfg.mode = cfg.mode;
            rcfg.cost_type = cfg.cost_type;
            rcfg.max_cost = cfg.max_cost;
            rcfg.speed_km_h = cfg.speed_km_h;
            rcfg.edge_dir = cfg.edge_dir;
            rcfg.node_dir = cfg.node_dir;
            rcfg.starting_points = starting_points;
            rcfg.steps = 1; // unused by matrix, but required by validation
            // PT fields
            rcfg.timetable_path = cfg.timetable_path;
            rcfg.departure_time = cfg.departure_time;
            rcfg.max_transfers = cfg.max_transfers;
            rcfg.departure_window = cfg.departure_window;
            rcfg.transit_modes = cfg.transit_modes;
            rcfg.access_mode = cfg.access_mode;
            rcfg.egress_mode = cfg.egress_mode;
            rcfg.access_cost_type = cfg.access_cost_type;
            rcfg.egress_cost_type = cfg.egress_cost_type;
            rcfg.access_max_cost = cfg.access_max_cost;
            rcfg.egress_max_cost = cfg.egress_max_cost;
            rcfg.access_speed_km_h = cfg.access_speed_km_h;
            rcfg.egress_speed_km_h = cfg.egress_speed_km_h;
            rcfg.transfer_cost = cfg.transfer_cost;
            rcfg.shade_weight = cfg.shade_weight;
            rcfg.heat_weight = cfg.heat_weight;
            rcfg.slope_walk_weight = cfg.slope_walk_weight;
            return rcfg;
        }
    } // namespace

    void compute(MatrixConfig const &cfg)
    {
        if (cfg.origins.empty())
            throw std::runtime_error("At least one origin is required");
        if (cfg.destinations.empty())
            throw std::runtime_error("At least one destination is required");
        if (cfg.edge_dir.empty())
            throw std::runtime_error("edge_dir is required");
        if (cfg.output_path.empty())
            throw std::runtime_error("output_path is required");
        input::validate_environmental_weights(cfg);

        size_t n_origins = cfg.origins.size();
        size_t n_dests = cfg.destinations.size();

        duckdb::DuckDB db(nullptr);
        duckdb::Connection con(db);
        data::ensure_required_extensions_loaded(con);

        std::vector<double> matrix(n_origins * n_dests,
                                    std::numeric_limits<double>::quiet_NaN());

        // Helper: read destination costs from a cost array into the matrix row.
        auto read_dest_costs = [&](size_t oi,
                                    std::vector<double> const &costs,
                                    std::vector<int32_t> const &dest_nodes)
        {
            for (size_t di = 0; di < n_dests; ++di)
            {
                int32_t node = dest_nodes[di];
                if (node < 0 || node >= static_cast<int32_t>(costs.size()))
                    continue;
                double cost = costs[node];
                if (std::isfinite(cost) && cost <= cfg.max_cost)
                    matrix[oi * n_dests + di] = cost;
            }
        };

        if (cfg.mode == RoutingMode::PublicTransport)
        {
            if (cfg.reverse)
                throw std::runtime_error(
                    "Reverse PT is not supported by the matrix; use "
                    "compute_od_costs.");
            // Load timetable once for all origins.
            auto tt = nigiri::timetable::read(
                std::filesystem::path{cfg.timetable_path});

            // PT: run the pipeline per origin, sharing the timetable.
            for (size_t oi = 0; oi < n_origins; ++oi)
            {
                auto rcfg = matrix_to_request_config(
                    cfg, {cfg.origins[oi]});
                input::validate(rcfg);

                auto pt_result = pt::run_pt_pipeline_with_destinations(
                    rcfg, con, cfg.destinations, &*tt);

                read_dest_costs(oi, pt_result.field.costs,
                                pt_result.extra_node_ids);
            }
        }
        else
        {
            network::StreetMatrixPrepInput prep_in{
                .origins = cfg.origins,
                .destinations = cfg.destinations,
                .mode = cfg.mode,
                .cost_type = cfg.cost_type,
                .max_cost = cfg.max_cost,
                .speed_km_h = cfg.speed_km_h,
                .edge_dir = cfg.edge_dir,
                .node_dir = cfg.node_dir,
                .shade_weight = cfg.shade_weight,
                .heat_weight = cfg.heat_weight,
                .slope_walk_weight = cfg.slope_walk_weight,
            };
            auto prep = network::prepare_street_matrix_network(con, prep_in);

            bool use_distance = (cfg.cost_type == CostType::Distance);
            if (!cfg.reverse)
            {
                for (size_t oi = 0; oi < n_origins; ++oi)
                {
                    int32_t start = prep.origin_nodes[oi];
                    if (start < 0)
                        continue;
                    auto costs = kernel::dijkstra(
                        prep.adj, std::vector<int32_t>{start},
                        cfg.max_cost, use_distance);
                    read_dest_costs(oi, costs, prep.destination_nodes);
                }
            }
            else
            {
                // Reverse: one Dijkstra per destination on the transposed
                // graph → cost[n→d] for all n; scatter into column di.
                for (size_t di = 0; di < n_dests; ++di)
                {
                    int32_t start = prep.destination_nodes[di];
                    if (start < 0)
                        continue;
                    auto costs = kernel::dijkstra(
                        prep.rev_adj, std::vector<int32_t>{start},
                        cfg.max_cost, use_distance);
                    for (size_t oi = 0; oi < n_origins; ++oi)
                    {
                        int32_t node = prep.origin_nodes[oi];
                        if (node < 0 || node >= static_cast<int32_t>(costs.size()))
                            continue;
                        double cost = costs[node];
                        if (std::isfinite(cost) && cost <= cfg.max_cost)
                            matrix[oi * n_dests + di] = cost;
                    }
                }
            }
        }

        // Stage the matrix in a TEMP TABLE via the Appender, then export to
        // parquet (write_query_to_parquet creates the parent directory).
        {
            bool const has_origin_ids = cfg.origin_ids.size() == n_origins;
            bool const has_dest_ids = cfg.destination_ids.size() == n_dests;

            con.Query("DROP TABLE IF EXISTS _matrix_tmp");
            con.Query("CREATE TEMP TABLE _matrix_tmp "
                      "(origin VARCHAR, destination VARCHAR, travel_cost INTEGER)");

            {
                duckdb::Appender appender(con, "_matrix_tmp");
                for (size_t oi = 0; oi < n_origins; ++oi)
                {
                    std::string const &o_id = has_origin_ids
                        ? cfg.origin_ids[oi]
                        : std::to_string(oi);

                    for (size_t di = 0; di < n_dests; ++di)
                    {
                        double c = matrix[oi * n_dests + di];
                        if (cfg.sparse && std::isnan(c))
                            continue;
                        std::string const &d_id = has_dest_ids
                            ? cfg.destination_ids[di]
                            : std::to_string(di);

                        appender.BeginRow();
                        appender.Append(duckdb::Value(o_id));
                        appender.Append(duckdb::Value(d_id));
                        if (std::isnan(c))
                            appender.Append(duckdb::Value());
                        else
                            appender.Append(static_cast<int32_t>(std::round(c)));
                        appender.EndRow();
                    }
                }
            }

            output::write_query_to_parquet(
                con, "SELECT * FROM _matrix_tmp", cfg.output_path,
                "Travel cost matrix parquet export failed");
            con.Query("DROP TABLE _matrix_tmp");
        }
    }

} // namespace routing::matrix
