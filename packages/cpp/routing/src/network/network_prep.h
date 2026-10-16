#pragma once

#include "../types.h"

#include <string>
#include <vector>

namespace duckdb { class Connection; }

namespace routing
{
struct RequestConfig;
}

namespace routing::network
{

// ---------------------------------------------------------------------------
// Shared radial (point-buffer) network prep core
// ---------------------------------------------------------------------------

// Result of the shared radial prep: a finalized SubNetwork plus the snapped
// node index for each of cfg.starting_points (parallel; -1 = unsnappable).
// Adjacency-list construction and any "drop unsnapped points" policy are left
// to the caller, since catchment and heatmap differ there.
struct RadialNetworkPrep
{
    SubNetwork net;
    std::vector<int32_t> snapped_nodes;  // parallel to cfg.starting_points
};

// Load edges in H3 cells touching buffers around cfg.starting_points, compute
// costs, build the SubNetwork, and snap the starting points — the sequence
// shared by the catchment pipeline and the heatmap. `load_geometry` pulls edge
// polylines into the network (needed by network/polygon catchment output).
//
// PT mode is NOT handled here — callers branch on cfg.mode beforehand.
RadialNetworkPrep prepare_radial_network(
    duckdb::Connection &con,
    RequestConfig const &cfg,
    bool load_geometry = false);

// ---------------------------------------------------------------------------
// Travel-cost-matrix prep (tiered loading over a wide extent)
// ---------------------------------------------------------------------------

struct StreetMatrixPrep
{
    SubNetwork net;
    std::vector<std::vector<AdjEntry>> adj;
    std::vector<std::vector<AdjEntry>> rev_adj;  // transposed graph (reverse mode)
    std::vector<int32_t> origin_nodes;       // -1 → unsnapped
    std::vector<int32_t> destination_nodes;  // -1 → unsnapped
};

struct StreetMatrixPrepInput
{
    std::vector<Point3857> const &origins;
    std::vector<Point3857> const &destinations;
    RoutingMode mode;
    CostType cost_type;
    double max_cost;
    double speed_km_h;
    std::string const &edge_dir;
    std::string const &node_dir;
    double shade_weight = 0.0;
    double heat_weight = 0.0;
    double slope_walk_weight = 0.0;
};

// Loads edges around the union of `origins` and `destinations` (tiered loading
// for large extents), builds a SubNetwork + adjacency list once, and snaps both
// point sets. PT mode is NOT handled here.
StreetMatrixPrep prepare_street_matrix_network(
    duckdb::Connection &con,
    StreetMatrixPrepInput const &in);

// ---------------------------------------------------------------------------
// Heatmap prep (radial core + reverse adjacency)
// ---------------------------------------------------------------------------

// The forward adjacency supports forward queries; the reverse adjacency lets
// the heatmap run Dijkstra-from-opportunity queries that yield correct
// "access cost from node v to the opportunity" values even on asymmetric
// graphs (car one-ways, walking with slope/shade/heat penalties).
struct HeatmapNetworkPrep
{
    SubNetwork net;
    std::vector<std::vector<AdjEntry>> fwd_adj;
    std::vector<std::vector<AdjEntry>> rev_adj;
    std::vector<int32_t> opportunity_nodes;  // -1 if unsnappable
};

struct HeatmapNetworkPrepInput
{
    std::vector<Point3857> const &opportunities;
    RoutingMode mode;
    CostType cost_type;
    double max_cost;       // max over per-opp budgets, used for buffer sizing
    double speed_km_h;
    std::string const &edge_dir;
    std::string const &node_dir;
    // When non-empty, edges load over the H3 cover of the convex hull of these
    // points and the opportunities within the mode's maximum travel time,
    // instead of around the opportunities, and the points are snapped in after
    // them (connector node + edges, no traversal of their own).
    std::vector<Point3857> const *area_cells = nullptr;
    // Environmental walkability parameters (modular multi-criteria impedance)
    double shade_weight = 0.0;
    double heat_weight = 0.0;
    double slope_walk_weight = 0.0;
};

// Radial prep for the heatmap: runs the shared radial core (snapping the
// opportunities), or loads over `area_cells` when set, then builds both forward and
// reverse adjacency lists.
HeatmapNetworkPrep prepare_radial_street_network(
    duckdb::Connection &con,
    HeatmapNetworkPrepInput const &in);

} // namespace routing::network
