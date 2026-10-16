#include "network_prep.h"

#include "../data/h3_util.h"
#include "../data/street_network_loader.h"
#include "../input/request_config.h"
#include "../kernel/dijkstra.h"
#include "../kernel/graph_builder.h"
#include "../kernel/mode_selector.h"
#include "../kernel/snap.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <duckdb.hpp>
#include <stdexcept>
#include <unordered_set>

namespace routing::network
{

namespace
{

// Distances inherited from the pre-refactor matrix code:
// - kBboxMarginM: pad the bbox-based H3 filter (skeleton or all-classes load).
// - kDetailBufferM: per-point radius for detail (local-road) load when the
//   overall extent is large enough to trigger tiered loading.
constexpr double kBboxMarginM = 10000.0;
constexpr double kDetailBufferM = 5000.0;
constexpr double kTieredLoadExtentThresholdM = 10000.0;
// Extra rings of H3 res-6 cells grown around the cells overlapping the area's
// hull; those already reach past it, so none are needed.
constexpr int kAreaCoverRings = 0;

// Build a minimal RequestConfig for downstream helpers (cost compute,
// snapping) that only consume mode/cost_type/max_cost/speed.
RequestConfig make_rcfg(StreetMatrixPrepInput const &in)
{
    RequestConfig rcfg;
    rcfg.mode = in.mode;
    rcfg.cost_type = in.cost_type;
    rcfg.max_cost = in.max_cost;
    rcfg.speed_km_h = in.speed_km_h;
    rcfg.edge_dir = in.edge_dir;
    rcfg.node_dir = in.node_dir;
    rcfg.starting_points = in.origins;  // never read past this point
    rcfg.steps = 1;
    rcfg.shade_weight = in.shade_weight;
    rcfg.heat_weight = in.heat_weight;
    rcfg.slope_walk_weight = in.slope_walk_weight;
    return rcfg;
}

// Convex hull (Andrew's monotone chain), counter-clockwise, no repeated end.
std::vector<Point3857> convex_hull(std::vector<Point3857> pts)
{
    std::sort(pts.begin(), pts.end(), [](auto const &a, auto const &b) {
        return a.x < b.x || (a.x == b.x && a.y < b.y);
    });
    if (pts.size() < 3)
        return pts;
    auto cross = [](Point3857 const &o, Point3857 const &a, Point3857 const &b) {
        return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };
    std::vector<Point3857> hull(2 * pts.size());
    size_t k = 0;
    for (size_t i = 0; i < pts.size(); ++i)
    {
        while (k >= 2 && cross(hull[k - 2], hull[k - 1], pts[i]) <= 0) --k;
        hull[k++] = pts[i];
    }
    for (size_t i = pts.size() - 1, t = k + 1; i > 0; --i)
    {
        while (k >= t && cross(hull[k - 2], hull[k - 1], pts[i - 1]) <= 0) --k;
        hull[k++] = pts[i - 1];
    }
    hull.resize(k - 1);
    return hull;
}

// Cost, build and snap a loaded edge set — the tail shared by the radial and
// the area load.
RadialNetworkPrep finish_radial_network(std::vector<Edge> edges,
                                        RequestConfig const &cfg)
{
    if (edges.empty())
        throw std::runtime_error(
            "No edges loaded. Check edge_dir and H3 cell coverage.");

    kernel::compute_costs(edges, cfg);

    RadialNetworkPrep out;
    out.net = kernel::build_sub_network(edges);
    // Snap after the network is finalized: snap_origins may insert connector
    // nodes / split edges, so any adjacency list must be built afterwards.
    out.snapped_nodes = kernel::snap_origins(out.net, cfg.starting_points, cfg);
    return out;
}

} // namespace

// Environmental columns are only relevant for walking with a positive weight.
// The routing-mode rule lives here (caller-side), so the data loader only
// receives a plain column request and stays free of routing domain logic.
inline data::EdgeColumnSelection env_columns(RoutingMode mode,
                                             double shade_weight,
                                             double heat_weight)
{
    return {.need_shade = (mode == RoutingMode::Walking && shade_weight > 0.0),
            .need_heat = (mode == RoutingMode::Walking && heat_weight > 0.0)};
}

RadialNetworkPrep prepare_radial_network(
    duckdb::Connection &con,
    RequestConfig const &cfg,
    bool load_geometry)
{
    if (cfg.starting_points.empty())
        throw std::runtime_error("prepare_radial_network: no starting points");

    double const buffer_m = input::buffer_distance(cfg);
    auto const classes = input::valid_classes(cfg.mode);

    auto edges = data::load_edges(
        con, cfg.edge_dir, cfg.node_dir,
        cfg.starting_points, buffer_m, classes, cfg.mode, load_geometry,
        env_columns(cfg.mode, cfg.shade_weight, cfg.heat_weight));
    return finish_radial_network(std::move(edges), cfg);
}

StreetMatrixPrep prepare_street_matrix_network(
    duckdb::Connection &con,
    StreetMatrixPrepInput const &in)
{
    if (in.origins.empty())
        throw std::runtime_error("prepare_street_matrix_network: no origins");
    if (in.destinations.empty())
        throw std::runtime_error("prepare_street_matrix_network: no destinations");

    // Union of origins + destinations defines the bbox/snap set.
    std::vector<Point3857> all_points;
    all_points.reserve(in.origins.size() + in.destinations.size());
    all_points.insert(all_points.end(), in.origins.begin(), in.origins.end());
    all_points.insert(all_points.end(), in.destinations.begin(), in.destinations.end());

    auto rcfg = make_rcfg(in);

    double bmin_x = all_points[0].x, bmax_x = bmin_x;
    double bmin_y = all_points[0].y, bmax_y = bmin_y;
    for (auto const &p : all_points)
    {
        bmin_x = std::min(bmin_x, p.x); bmax_x = std::max(bmax_x, p.x);
        bmin_y = std::min(bmin_y, p.y); bmax_y = std::max(bmax_y, p.y);
    }
    double const dx = bmax_x - bmin_x;
    double const dy = bmax_y - bmin_y;
    double const extent = std::sqrt(dx * dx + dy * dy);

    // Convert to ground units
    double const tiered_threshold = data::ground_to_mercator(
        kTieredLoadExtentThresholdM,
        std::abs(bmax_y) > std::abs(bmin_y) ? bmax_y : bmin_y);

    std::vector<Edge> edges;
    if (extent > tiered_threshold)
    {
        // Tiered: classified roads across the full bbox + local roads in
        // small per-point circles. Avoids loading every residential street
        // in (e.g.) a 100 km matrix request. The class partition is derived
        // from the canonical taxonomy (input::valid_classes) so it can't drift.
        auto const skeleton_classes = input::skeleton_classes(in.mode);
        auto const detail_classes = input::detail_classes(in.mode);

        auto bbox_filter = data::compute_spatial_filter_bbox(
            con, bmin_x, bmin_y, bmax_x, bmax_y, kBboxMarginM);
        auto const cols = env_columns(in.mode, in.shade_weight, in.heat_weight);
        auto skeleton = data::load_edges(
            con, in.edge_dir, in.node_dir, bbox_filter, skeleton_classes, in.mode,
            /*load_geometry=*/false, cols);
        auto detail = data::load_edges(
            con, in.edge_dir, in.node_dir, all_points, kDetailBufferM,
            detail_classes, in.mode, /*load_geometry=*/false,
            cols);

        std::unordered_set<int64_t> seen;
        seen.reserve(skeleton.size() + detail.size());
        edges.reserve(skeleton.size() + detail.size());
        for (auto &e : skeleton)
        {
            seen.insert(e.id);
            edges.push_back(std::move(e));
        }
        for (auto &e : detail)
            if (seen.find(e.id) == seen.end())
                edges.push_back(std::move(e));
    }
    else
    {
        // Small extent: all classes via bbox corridor.
        auto classes = input::valid_classes(in.mode);
        auto bbox_filter = data::compute_spatial_filter_bbox(
            con, bmin_x, bmin_y, bmax_x, bmax_y, kBboxMarginM);
        edges = data::load_edges(
            con, in.edge_dir, in.node_dir, bbox_filter, classes, in.mode,
            /*load_geometry=*/false,
            env_columns(in.mode, in.shade_weight, in.heat_weight));
    }

    if (edges.empty())
        throw std::runtime_error("No edges loaded. Check edge_dir and coverage.");

    kernel::compute_costs(edges, rcfg);

    StreetMatrixPrep out;
    out.net = kernel::build_sub_network(edges);
    // Snap both point sets before building the adjacency list:
    // snap_origins may insert connector nodes and split edges, so the
    // adjacency must be (re)built once the network is finalized.
    out.origin_nodes      = kernel::snap_origins(out.net, in.origins,      rcfg);
    out.destination_nodes = kernel::snap_origins(out.net, in.destinations, rcfg);
    out.adj = kernel::build_adjacency_list(out.net);
    out.rev_adj = kernel::build_reverse_adjacency_list(out.net);
    return out;
}

HeatmapNetworkPrep prepare_radial_street_network(
    duckdb::Connection &con,
    HeatmapNetworkPrepInput const &in)
{
    if (in.opportunities.empty())
        throw std::runtime_error(
            "prepare_radial_street_network: no opportunities");

    // Build a RequestConfig stub so the shared radial core can size the buffer
    // and snap the opportunities as "starting points".
    RequestConfig rcfg;
    rcfg.mode = in.mode;
    rcfg.cost_type = in.cost_type;
    rcfg.max_cost = in.max_cost;
    rcfg.speed_km_h = in.speed_km_h;
    rcfg.edge_dir = in.edge_dir;
    rcfg.node_dir = in.node_dir;
    rcfg.starting_points = in.opportunities;
    rcfg.steps = 1;
    rcfg.shade_weight = in.shade_weight;
    rcfg.heat_weight = in.heat_weight;
    rcfg.slope_walk_weight = in.slope_walk_weight;

    // Geometry needed: the sampler interpolates along each edge's polyline.
    bool const over_area = in.area_cells && !in.area_cells->empty();
    RadialNetworkPrep core;
    if (over_area)
    {
        std::array<double, 4> b{in.area_cells->front().x,
                                in.area_cells->front().y,
                                in.area_cells->front().x,
                                in.area_cells->front().y};
        for (auto const &p : *in.area_cells)
        {
            b[0] = std::min(b[0], p.x);
            b[1] = std::min(b[1], p.y);
            b[2] = std::max(b[2], p.x);
            b[3] = std::max(b[3], p.y);
        }
        RequestConfig bcfg = rcfg;
        bcfg.cost_type = CostType::Time;
        bcfg.max_cost = in.mode == RoutingMode::Car ? input::kMaxTimeCarMin
                                                     : input::kMaxTimeActiveMin;
        double const buffer_m = input::buffer_distance(bcfg);
        // The buffer bounds which opportunities count; the network covers the
        // hull of the area and those, so routes to them stay connected while
        // the area's bbox corners stay unloaded.
        double const margin = data::ground_to_mercator(
            buffer_m, std::abs(b[3]) > std::abs(b[1]) ? b[3] : b[1]);
        std::vector<Point3857> extent = *in.area_cells;
        for (auto const &p : in.opportunities)
            if (p.x >= b[0] - margin && p.x <= b[2] + margin &&
                p.y >= b[1] - margin && p.y <= b[3] + margin)
                extent.push_back(p);
        auto const filter = data::compute_spatial_filter_polygon(
            con, convex_hull(std::move(extent)), kAreaCoverRings);
        core = finish_radial_network(
            data::load_edges(con, in.edge_dir, in.node_dir, filter,
                             input::valid_classes(in.mode), in.mode,
                             /*load_geometry=*/true,
                             env_columns(in.mode, in.shade_weight, in.heat_weight)),
            rcfg);
    }
    else
    {
        core = prepare_radial_network(con, rcfg, /*load_geometry=*/true);
    }

    HeatmapNetworkPrep out;
    out.net = std::move(core.net);
    out.opportunity_nodes = std::move(core.snapped_nodes);
    if (over_area)
        kernel::snap_origins(out.net, *in.area_cells, rcfg);
    out.fwd_adj = kernel::build_adjacency_list(out.net);
    out.rev_adj = kernel::build_reverse_adjacency_list(out.net);
    return out;
}

} // namespace routing::network
