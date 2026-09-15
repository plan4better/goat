#include "catchment.h"

#include "../data/duckdb_setup.h"
#include "../geometry/grid_surface_builder.h"
#include "../input/validation.h"
#include "../kernel/dijkstra.h"
#include "../kernel/reachability_field.h"
#include "../network/network_prep.h"
#include "../output/geojson.h"
#include "../output/grid_contour_common.h"
#include "../output/parquet.h"
#include "../pt/pt_pipeline.h"

#include <chrono>
#include <cstdio>
#include <duckdb.hpp>
#include <functional>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

namespace routing::catchment
{

    namespace
    {
        struct PreparedNetwork
        {
            SubNetwork net;
            std::vector<int32_t> valid_starts;
            // Where each valid start sat in cfg.starting_points. Starts that
            // fail to snap are dropped above, so position in `valid_starts` is
            // not the caller's index — and the caller needs its own index back
            // to attribute a catchment to the point that produced it.
            std::vector<int32_t> valid_start_inputs;
        };

        void validate_request(RequestConfig &cfg)
        {
            input::validate(cfg);
        }

        // Radial street-network prep for catchment: runs the shared loading
        // core (edges → costs → SubNetwork → snap) and applies catchment's
        // policy of keeping only the snapped (connected) starting points.
        PreparedNetwork prepare_catchment_network(RequestConfig const &cfg,
                                                  duckdb::Connection &con,
                                                  bool load_geometry = false)
        {
            auto prep = network::prepare_radial_network(con, cfg, load_geometry);

            PreparedNetwork prepared{.net = std::move(prep.net),
                                     .valid_starts = {},
                                     .valid_start_inputs = {}};
            prepared.valid_starts.reserve(prep.snapped_nodes.size());
            prepared.valid_start_inputs.reserve(prep.snapped_nodes.size());
            for (size_t i = 0; i < prep.snapped_nodes.size(); ++i)
            {
                if (prep.snapped_nodes[i] >= 0)
                {
                    prepared.valid_starts.push_back(prep.snapped_nodes[i]);
                    prepared.valid_start_inputs.push_back(static_cast<int32_t>(i));
                }
            }
            if (prepared.valid_starts.empty())
            {
                throw std::runtime_error(
                    "Starting point(s) are disconnected from the street network.");
            }

            return prepared;
        }

        std::vector<double> run_reachability_dijkstra(
            SubNetwork const &net,
            std::vector<int32_t> const &valid_starts,
            RequestConfig const &cfg)
        {
            bool use_distance = (cfg.cost_type == CostType::Distance);
            auto adj = kernel::build_adjacency_list(net);
            return kernel::dijkstra(adj, valid_starts, cfg.cost_budget(),
                                    use_distance);
        }

        std::string dispatch_geojson_output(std::vector<ReachabilityField> const &fields,
                                            RequestConfig const &cfg,
                                            duckdb::Connection &con)
        {
            return output::build_geojson_output(fields, cfg, con);
        }

        std::string dispatch_parquet_output(std::vector<ReachabilityField> const &fields,
                                            RequestConfig const &cfg,
                                            duckdb::Connection &con)
        {
            output::write_parquet_output(fields, cfg, con);
            return "";
        }

        ReachabilityField build_reachability_field(
            RequestConfig &cfg,
            duckdb::Connection &con)
        {
            validate_request(cfg);

            // Load geometry into C++ when output needs edge polylines:
            // - Jsolines polygon (non-car) for grid surface interpolation
            // - Network output for edge clipping + WKT construction
            // Car polygon (concave hull), hexagon, and point grid use node coords only.
            bool load_geom = (cfg.catchment_type == CatchmentType::Network) ||
                             (cfg.catchment_type == CatchmentType::Polygon &&
                              cfg.mode != RoutingMode::Car);

            ReachabilityField field;

            if (cfg.mode == RoutingMode::PublicTransport)
            {
                field = pt::run_pt_pipeline(cfg, con);
            }
            else
            {
                auto prepared = prepare_catchment_network(cfg, con, load_geom);
                auto costs = run_reachability_dijkstra(prepared.net,
                                                       prepared.valid_starts,
                                                       cfg);
                field = kernel::make_reachability_field(std::move(costs),
                                                        std::move(prepared.net));
            }


            return field;
        }

        // Streaming path for shape_style=Separated grid contours: produce one
        // reachability field at a time, build its grid + jsolines features,
        // discard the field before moving to the next origin. Caps cost-vector
        // memory at 1× node_count instead of N× node_count.
        std::string compute_catchment_separated_streaming(
            RequestConfig &cfg,
            duckdb::Connection &con,
            std::function<double()> const &elapsed)
        {
            validate_request(cfg);
            bool const load_geom = true;  // jsolines needs edge geometry

            auto prepared = prepare_catchment_network(cfg, con, load_geom);
            auto net_ptr = std::make_shared<SubNetwork const>(std::move(prepared.net));
            bool const use_distance = (cfg.cost_type == CostType::Distance);
            auto adj = kernel::build_adjacency_list(*net_ptr);

            std::fprintf(stderr,
                         "[Pipeline] Separated infra (n_origins=%zu, %d nodes, %zu edges): %.0f ms\n",
                         prepared.valid_starts.size(),
                         net_ptr->node_count,
                         net_ptr->source.size(),
                         elapsed());

            auto const cutoffs = output::compute_step_cutoffs(cfg);
            int const zoom = geometry::grid_zoom_for_mode(cfg.mode);

            std::vector<output::TaggedFeature> features;
            for (size_t oi = 0; oi < prepared.valid_starts.size(); ++oi)
            {
                auto costs = kernel::dijkstra(adj,
                                              std::vector<int32_t>{prepared.valid_starts[oi]},
                                              cfg.cost_budget(), use_distance);
                ReachabilityField field;
                field.costs = std::move(costs);
                field.node_count = net_ptr->node_count;
                field.network = net_ptr;
                output::append_field_grid_features(features, field,
                                                    prepared.valid_start_inputs[oi],
                                                    zoom, cutoffs, cfg);
                // `field` (and its costs vector) destructed here.
            }
            std::fprintf(stderr,
                         "[Pipeline] Streamed %zu origins into %zu contour features: %.0f ms\n",
                         prepared.valid_starts.size(), features.size(), elapsed());

            if (cfg.output_format == OutputFormat::GeoJSON)
                return output::build_grid_contour_geojson_from_features(features, cfg, con);
            output::write_grid_contour_parquet_from_features(features, cfg, con,
                                                              cfg.output_path);
            return "";
        }

        bool wants_separated_streaming(RequestConfig const &cfg)
        {
            return cfg.shape_style == ShapeStyle::Separated &&
                   cfg.catchment_type == CatchmentType::Polygon &&
                   cfg.mode != RoutingMode::PublicTransport &&
                   cfg.mode != RoutingMode::Car;
        }
    } // namespace

    std::string compute(RequestConfig const &cfg_in)
    {
        auto cfg = cfg_in; // mutable copy for validation defaults

        auto t0 = std::chrono::steady_clock::now();
        auto elapsed = [&]() {
            auto now = std::chrono::steady_clock::now();
            double ms = std::chrono::duration<double, std::milli>(now - t0).count();
            t0 = now;
            return ms;
        };

        duckdb::DuckDB db(nullptr);
        duckdb::Connection con(db);
        data::ensure_required_extensions_loaded(con);
        std::fprintf(stderr, "[Pipeline] DuckDB init: %.0f ms\n", elapsed());

        if (wants_separated_streaming(cfg))
        {
            auto result = compute_catchment_separated_streaming(cfg, con, elapsed);
            std::fprintf(stderr, "[Pipeline] %s output: %.0f ms\n",
                         cfg.output_format == OutputFormat::GeoJSON
                             ? "GeoJSON" : "Parquet",
                         elapsed());
            return result;
        }

        std::vector<ReachabilityField> fields;
        fields.push_back(build_reachability_field(cfg, con));
        std::fprintf(stderr, "[Pipeline] Reachability field (%d nodes, %zu edges): %.0f ms\n",
                     fields[0].node_count,
                     fields[0].network ? fields[0].network->source.size() : 0,
                     elapsed());

        if (cfg.output_format == OutputFormat::GeoJSON)
        {
            auto result = dispatch_geojson_output(fields, cfg, con);
            std::fprintf(stderr, "[Pipeline] GeoJSON output: %.0f ms\n", elapsed());
            return result;
        }

        if (cfg.output_format == OutputFormat::Parquet)
        {
            auto result = dispatch_parquet_output(fields, cfg, con);
            std::fprintf(stderr, "[Pipeline] Parquet output: %.0f ms\n", elapsed());
            return result;
        }

        return "";
    }

} // namespace routing::catchment
