#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <stdexcept>

#include "date/date.h"
#include "nigiri/common/interval.h"
#include "nigiri/loader/load.h"
#include "nigiri/timetable.h"
#include "utl/progress_tracker.h"

#include "pipeline.h"
#include "preprocessing/access_egress_table.h"
#include "types.h"

namespace py = pybind11;

PYBIND11_MODULE(_routing, m)
{
    m.doc() = "C++ routing engine with Python bindings";

    auto elapsed_ms = [](std::chrono::steady_clock::time_point start,
                         std::chrono::steady_clock::time_point end) -> double
    {
        return std::chrono::duration_cast<std::chrono::duration<double, std::milli>>(
                   end - start)
            .count();
    };

    py::enum_<routing::RoutingMode>(m, "RoutingMode")
        .value("Walking", routing::RoutingMode::Walking)
        .value("Bicycle", routing::RoutingMode::Bicycle)
        .value("Pedelec", routing::RoutingMode::Pedelec)
        .value("Car", routing::RoutingMode::Car)
        .value("PublicTransport", routing::RoutingMode::PublicTransport);

    py::enum_<routing::CostType>(m, "CostType")
        .value("Time", routing::CostType::Time)
        .value("Distance", routing::CostType::Distance);

    py::enum_<routing::CatchmentType>(m, "CatchmentType")
        .value("Polygon", routing::CatchmentType::Polygon)
        .value("Network", routing::CatchmentType::Network)
        .value("HexagonalGrid", routing::CatchmentType::HexagonalGrid)
        .value("PointGrid", routing::CatchmentType::PointGrid);

    py::enum_<routing::OutputFormat>(m, "OutputFormat")
        .value("GeoJSON", routing::OutputFormat::GeoJSON)
        .value("Parquet", routing::OutputFormat::Parquet);

    py::enum_<routing::ShapeStyle>(m, "ShapeStyle")
        .value("Combined", routing::ShapeStyle::Combined)
        .value("Separated", routing::ShapeStyle::Separated);

    py::class_<routing::Point3857>(m, "Point3857")
        .def(py::init<double, double>())
        .def_readwrite("x", &routing::Point3857::x)
        .def_readwrite("y", &routing::Point3857::y);

    py::class_<routing::RequestConfig>(m, "RequestConfig")
        .def(py::init<>())
        .def_readwrite("starting_points", &routing::RequestConfig::starting_points)
        .def_readwrite("mode", &routing::RequestConfig::mode)
        .def_readwrite("cost_type", &routing::RequestConfig::cost_type)
        .def_readwrite("max_cost", &routing::RequestConfig::max_cost)
        .def_readwrite("steps", &routing::RequestConfig::steps)
        .def_readwrite("speed_km_h", &routing::RequestConfig::speed_km_h)
        .def_readwrite("edge_dir", &routing::RequestConfig::edge_dir)
        .def_readwrite("node_dir", &routing::RequestConfig::node_dir)
        .def_readwrite("timetable_path", &routing::RequestConfig::timetable_path)
        .def_readwrite("output_path", &routing::RequestConfig::output_path)
        .def_readwrite("catchment_type", &routing::RequestConfig::catchment_type)
        .def_readwrite("output_format", &routing::RequestConfig::output_format)
        .def_readwrite("shape_style", &routing::RequestConfig::shape_style)
        .def_readwrite("polygon_difference", &routing::RequestConfig::polygon_difference)
        .def_readwrite("departure_time", &routing::RequestConfig::departure_time)
        .def_readwrite("max_transfers", &routing::RequestConfig::max_transfers)
        // PT access/egress
        .def_readwrite("access_mode", &routing::RequestConfig::access_mode)
        .def_readwrite("egress_mode", &routing::RequestConfig::egress_mode)
        .def_readwrite("access_cost_type", &routing::RequestConfig::access_cost_type)
        .def_readwrite("egress_cost_type", &routing::RequestConfig::egress_cost_type)
        .def_readwrite("access_max_cost", &routing::RequestConfig::access_max_cost)
        .def_readwrite("egress_max_cost", &routing::RequestConfig::egress_max_cost)
        .def_readwrite("access_speed_km_h", &routing::RequestConfig::access_speed_km_h)
        .def_readwrite("egress_speed_km_h", &routing::RequestConfig::egress_speed_km_h)
        .def_readwrite("transfer_cost", &routing::RequestConfig::transfer_cost)
        // Transit mode filter, departure window, and explicit cutoffs
        .def_readwrite("transit_modes", &routing::RequestConfig::transit_modes)
        .def_readwrite("departure_window", &routing::RequestConfig::departure_window)
        // PointGrid settings
        .def_readwrite("grid_points_path", &routing::RequestConfig::grid_points_path)
        .def_readwrite("grid_snap_distance", &routing::RequestConfig::grid_snap_distance)
        .def_readwrite("cutoffs", &routing::RequestConfig::cutoffs)
        // Environmental walkability parameters
        .def_readwrite("shade_weight", &routing::RequestConfig::shade_weight)
        .def_readwrite("heat_weight", &routing::RequestConfig::heat_weight)
        .def_readwrite("slope_walk_weight", &routing::RequestConfig::slope_walk_weight);

    py::class_<routing::MatrixConfig>(m, "MatrixConfig")
        .def(py::init<>())
        .def_readwrite("origins", &routing::MatrixConfig::origins)
        .def_readwrite("destinations", &routing::MatrixConfig::destinations)
        .def_readwrite("origin_ids", &routing::MatrixConfig::origin_ids)
        .def_readwrite("destination_ids", &routing::MatrixConfig::destination_ids)
        .def_readwrite("mode", &routing::MatrixConfig::mode)
        .def_readwrite("cost_type", &routing::MatrixConfig::cost_type)
        .def_readwrite("max_cost", &routing::MatrixConfig::max_cost)
        .def_readwrite("speed_km_h", &routing::MatrixConfig::speed_km_h)
        .def_readwrite("edge_dir", &routing::MatrixConfig::edge_dir)
        .def_readwrite("node_dir", &routing::MatrixConfig::node_dir)
        .def_readwrite("output_path", &routing::MatrixConfig::output_path)
        // PT settings
        .def_readwrite("timetable_path", &routing::MatrixConfig::timetable_path)
        .def_readwrite("departure_time", &routing::MatrixConfig::departure_time)
        .def_readwrite("max_transfers", &routing::MatrixConfig::max_transfers)
        .def_readwrite("departure_window", &routing::MatrixConfig::departure_window)
        .def_readwrite("transit_modes", &routing::MatrixConfig::transit_modes)
        .def_readwrite("access_mode", &routing::MatrixConfig::access_mode)
        .def_readwrite("egress_mode", &routing::MatrixConfig::egress_mode)
        .def_readwrite("access_cost_type", &routing::MatrixConfig::access_cost_type)
        .def_readwrite("egress_cost_type", &routing::MatrixConfig::egress_cost_type)
        .def_readwrite("access_max_cost", &routing::MatrixConfig::access_max_cost)
        .def_readwrite("egress_max_cost", &routing::MatrixConfig::egress_max_cost)
        .def_readwrite("access_speed_km_h", &routing::MatrixConfig::access_speed_km_h)
        .def_readwrite("egress_speed_km_h", &routing::MatrixConfig::egress_speed_km_h)
        .def_readwrite("transfer_cost", &routing::MatrixConfig::transfer_cost)
        .def_readwrite("reverse", &routing::MatrixConfig::reverse)
        .def_readwrite("sparse", &routing::MatrixConfig::sparse)
        // Environmental walkability parameters
        .def_readwrite("shade_weight", &routing::MatrixConfig::shade_weight)
        .def_readwrite("heat_weight", &routing::MatrixConfig::heat_weight)
        .def_readwrite("slope_walk_weight", &routing::MatrixConfig::slope_walk_weight);

    py::enum_<routing::HeatmapType>(m, "HeatmapType")
        .value("Gravity",        routing::HeatmapType::Gravity)
        .value("ClosestAverage", routing::HeatmapType::ClosestAverage)
        .value("Connectivity",   routing::HeatmapType::Connectivity)
        .value("TwoSFCA",        routing::HeatmapType::TwoSFCA);

    py::enum_<routing::TwoSFCAType>(m, "TwoSFCAType")
        .value("Standard", routing::TwoSFCAType::Standard)
        .value("E2SFCA",   routing::TwoSFCAType::E2SFCA)
        .value("M2SFCA",   routing::TwoSFCAType::M2SFCA);

    py::enum_<routing::GravityDecay>(m, "GravityDecay")
        .value("Gaussian",    routing::GravityDecay::Gaussian)
        .value("Exponential", routing::GravityDecay::Exponential)
        .value("Linear",      routing::GravityDecay::Linear)
        .value("Power",       routing::GravityDecay::Power)
        .value("Cumulative",  routing::GravityDecay::Cumulative);

    py::class_<routing::Opportunity>(m, "Opportunity")
        .def(py::init<>())
        .def(py::init([](std::vector<routing::Point3857> seeds, double w,
                         routing::Point3857 const &rep) {
                 routing::Opportunity o;
                 o.seeds = std::move(seeds);
                 o.weight = w;
                 o.rep = rep;
                 return o;
             }),
             py::arg("seeds"), py::arg("weight"), py::arg("rep"))
        .def_readwrite("seeds",  &routing::Opportunity::seeds)
        .def_readwrite("weight", &routing::Opportunity::weight)
        .def_readwrite("rep",    &routing::Opportunity::rep);

    py::class_<routing::HeatmapConfig>(m, "HeatmapConfig")
        .def(py::init<>())
        .def_readwrite("opportunities",   &routing::HeatmapConfig::opportunities)
        .def_readwrite("mode",            &routing::HeatmapConfig::mode)
        .def_readwrite("cost_type",       &routing::HeatmapConfig::cost_type)
        .def_readwrite("max_cost",        &routing::HeatmapConfig::max_cost)
        .def_readwrite("speed_km_h",      &routing::HeatmapConfig::speed_km_h)
        .def_readwrite("edge_dir",        &routing::HeatmapConfig::edge_dir)
        .def_readwrite("node_dir",        &routing::HeatmapConfig::node_dir)
        .def_readwrite("area_cell_centroids", &routing::HeatmapConfig::area_cell_centroids)
        // Formula
        .def_readwrite("heatmap_type",    &routing::HeatmapConfig::heatmap_type)
        .def_readwrite("decay",           &routing::HeatmapConfig::decay)
        .def_readwrite("sensitivity",     &routing::HeatmapConfig::sensitivity)
        .def_readwrite("max_sensitivity", &routing::HeatmapConfig::max_sensitivity)
        .def_readwrite("closest_k",       &routing::HeatmapConfig::closest_k)
        .def_readwrite("two_sfca_type",   &routing::HeatmapConfig::two_sfca_type)
        .def_readwrite("demand_path",     &routing::HeatmapConfig::demand_path)
        // PT (mode == PublicTransport)
        .def_readwrite("timetable_path",  &routing::HeatmapConfig::timetable_path)
        .def_readwrite("arrival_time",    &routing::HeatmapConfig::arrival_time)
        .def_readwrite("max_transfers",   &routing::HeatmapConfig::max_transfers)
        .def_readwrite("transit_modes",   &routing::HeatmapConfig::transit_modes)
        .def_readwrite("access_mode",     &routing::HeatmapConfig::access_mode)
        .def_readwrite("egress_mode",     &routing::HeatmapConfig::egress_mode)
        .def_readwrite("access_max_time", &routing::HeatmapConfig::access_max_time)
        .def_readwrite("egress_max_time", &routing::HeatmapConfig::egress_max_time)
        .def_readwrite("transfer_cost",   &routing::HeatmapConfig::transfer_cost)
        .def_readwrite("access_table_path", &routing::HeatmapConfig::access_table_path)
        .def_readwrite("egress_table_path", &routing::HeatmapConfig::egress_table_path)
        .def_readwrite("connectivity_output_resolution", &routing::HeatmapConfig::connectivity_output_resolution)
        // Output
        .def_readwrite("output_path",     &routing::HeatmapConfig::output_path)
        // Environmental walkability parameters
        .def_readwrite("shade_weight",    &routing::HeatmapConfig::shade_weight)
        .def_readwrite("heat_weight",     &routing::HeatmapConfig::heat_weight)
        .def_readwrite("slope_walk_weight", &routing::HeatmapConfig::slope_walk_weight);

    py::class_<routing::preprocessing::AccessEgressConfig>(m, "AccessEgressConfig")
        .def(py::init<>())
        .def_readwrite("timetable_path", &routing::preprocessing::AccessEgressConfig::timetable_path)
        .def_readwrite("edge_dir",       &routing::preprocessing::AccessEgressConfig::edge_dir)
        .def_readwrite("node_dir",       &routing::preprocessing::AccessEgressConfig::node_dir)
        .def_readwrite("output_path",    &routing::preprocessing::AccessEgressConfig::output_path)
        .def_readwrite("mode",           &routing::preprocessing::AccessEgressConfig::mode)
        .def_readwrite("max_min",        &routing::preprocessing::AccessEgressConfig::max_min)
        .def_readwrite("speed_km_h",     &routing::preprocessing::AccessEgressConfig::speed_km_h)
        .def_readwrite("chunk_size",     &routing::preprocessing::AccessEgressConfig::chunk_size)
        .def_readwrite("chunk_max_span_m", &routing::preprocessing::AccessEgressConfig::chunk_max_span_m)
        .def_readwrite("fold_samples",   &routing::preprocessing::AccessEgressConfig::fold_samples)
        .def_readwrite("spacing_m",      &routing::preprocessing::AccessEgressConfig::spacing_m);

    // Long C++ work releases the GIL for its duration.
    //
    // Windmill's worker sends a liveness ping from Python. A call that holds the
    // GIL blocks that ping for as long as it runs, so a large job looks like a dead
    // worker and the job is restarted — which, for a bundle import, re-runs it
    // against a bundle whose members already exist. Released around the computation
    // only: `py::print` below touches Python objects and needs the GIL back.
    m.def("compute_catchment",
          [elapsed_ms](routing::RequestConfig const &config)
          {
              auto t0 = std::chrono::steady_clock::now();
              std::string result;
              {
                  py::gil_scoped_release release;
                  result = routing::compute_catchment(config);
              }
              auto t1 = std::chrono::steady_clock::now();
              py::print("[routing] compute_catchment total_ms=",
                        elapsed_ms(t0, t1));
              return result;
          },
          py::arg("config"),
          "Run the full routing pipeline and dispatch output by RequestConfig.output_format");

    m.def("compute_travel_cost_matrix",
          &routing::compute_travel_cost_matrix,
          py::arg("config"),
          py::call_guard<py::gil_scoped_release>(),
          "Compute many-to-many travel cost matrix between origins and destinations");

    m.def("compute_heatmap",
          [elapsed_ms](routing::HeatmapConfig const &config)
          {
              auto t0 = std::chrono::steady_clock::now();
              {
                  py::gil_scoped_release release;
                  routing::compute_heatmap(config);
              }
              auto t1 = std::chrono::steady_clock::now();
              py::print("[routing] compute_heatmap total_ms=",
                        elapsed_ms(t0, t1));
          },
          py::arg("config"),
          "Compute per-origin accessibility heatmap (Gravity / ClosestAverage) "
          "against a fixed opportunity layer");

    m.def("compute_od_costs",
          [elapsed_ms](routing::HeatmapConfig const &config)
          {
              auto t0 = std::chrono::steady_clock::now();
              {
                  py::gil_scoped_release release;
                  routing::compute_od_costs(config);
              }
              auto t1 = std::chrono::steady_clock::now();
              py::print("[routing] compute_od_costs total_ms=",
                        elapsed_ms(t0, t1));
          },
          py::arg("config"),
          "Emit the raw per-(cell, opportunity) OD cost relation "
          "(orig_cell, dest_cell, cost) from the reachability pipeline to "
          "config.output_path. Used by Huff v2 for its PT OD matrix.");

    m.def("build_access_egress_table",
          [elapsed_ms](routing::preprocessing::AccessEgressConfig const &config)
          {
              auto t0 = std::chrono::steady_clock::now();
              std::string out;
              {
                  py::gil_scoped_release release;
                  out = routing::preprocessing::build_access_egress_table(config);
              }
              auto t1 = std::chrono::steady_clock::now();
              py::print("[routing] build_access_egress_table total_ms=",
                        elapsed_ms(t0, t1));
              return out;
          },
          py::arg("config"),
          "Precompute a PT access/egress lookup table for one mode "
          "(stop_idx, h3_index, cost_minutes). Writes ZSTD parquet to "
          "config.output_path and returns the path");

    m.def("build_timetable",
          [](std::string const &gtfs_path, std::string const &out_path,
             std::string const &start_date, int length_days,
             unsigned link_stop_distance)
          {
              // Parse the "YYYY-MM-DD" start date.
              int y = 0, mo = 0, d = 0;
              if (std::sscanf(start_date.c_str(), "%d-%d-%d", &y, &mo, &d) != 3)
              {
                  throw std::invalid_argument(
                      "start_date must be formatted YYYY-MM-DD");
              }
              if (length_days <= 0)
              {
                  throw std::invalid_argument("length_days must be positive");
              }

              auto const start = date::sys_days{
                  date::year{y} / date::month(static_cast<unsigned>(mo)) /
                  date::day(static_cast<unsigned>(d))};
              auto const window = nigiri::interval<date::sys_days>{
                  start, start + date::days{length_days}};

              nigiri::loader::loader_config cfg{};
              cfg.link_stop_distance_ = link_stop_distance;

              // nigiri's loader reports progress via utl's thread-local tracker;
              // activate a (silent) one so the loader doesn't abort.
              utl::activate_progress_tracker("nigiri");

              auto tt = nigiri::loader::load(
                  {nigiri::loader::timetable_source{"gtfs", gtfs_path, cfg}},
                  nigiri::loader::finalize_options{},
                  window);
              tt.write(std::filesystem::path{out_path});
          },
          py::arg("gtfs_path"),
          py::arg("out_path"),
          py::arg("start_date"),
          py::arg("length_days"),
          py::arg("link_stop_distance") = 100U,
          py::call_guard<py::gil_scoped_release>(),
          "Build a nigiri .bin PT timetable from a GTFS feed (zip or directory) "
          "covering [start_date, start_date + length_days), generating transfer "
          "footpaths within link_stop_distance metres, and write it to out_path.");
}
