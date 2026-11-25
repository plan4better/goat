#pragma once

#include "../types.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <unordered_map>
#include <vector>

namespace routing::geometry
{

// A point of an edge whose cost the field knows: an end (frac 0 at the
// source, 1 at the target) or the point where a snap split it.
struct EdgeAnchor
{
    double frac;
    double cost;
};

// The cost of the point at `frac` along an edge: reached from whichever anchor
// gets there cheaper, at the edge's own cost in that direction. `fwd` and
// `rev` are the edge's cost and reverse_cost (seconds, or metres for
// distance); a direction the Dijkstra cannot traverse is never used. A
// straight line between the two end costs would undercut a point reached from
// both ends: an edge of 10 min with both ends at 14 min costs 19 min in its
// middle. And an edge an origin was snapped onto costs almost nothing next to
// that origin, whatever its ends cost.
inline double edge_point_cost(std::vector<EdgeAnchor> const &anchors,
                              double frac, double fwd, double rev,
                              bool use_distance)
{
    auto usable = [](double c) { return c >= 0.0 && c < 99999.0; };
    double const scale = use_distance ? 1.0 : 1.0 / 60.0;
    frac = std::clamp(frac, 0.0, 1.0);
    double best = std::numeric_limits<double>::infinity();
    for (auto const &a : anchors)
    {
        if (!std::isfinite(a.cost))
            continue;
        double const d = frac - a.frac;
        if (d == 0.0)
            best = std::min(best, a.cost);
        else if (d > 0.0 && usable(fwd))
            best = std::min(best, a.cost + d * fwd * scale);
        else if (d < 0.0 && usable(rev))
            best = std::min(best, a.cost - d * rev * scale);
    }
    return best;
}

// The anchors of edge `i`, its ends and any splits, into `out`.
// `splits_by_edge` comes from index_splits.
void edge_anchors(ReachabilityField const &field, size_t i,
                  std::unordered_multimap<int32_t, EdgeSplit> const &splits_by_edge,
                  std::vector<EdgeAnchor> &out);

// The network's snap splits, by the edge they split.
std::unordered_multimap<int32_t, EdgeSplit> index_splits(SubNetwork const &net);

struct CostSample
{
    double x_3857;
    double y_3857;
    double cost;
};

// Project a per-node reachability cost field onto a flat list of (x, y,
// cost) samples via:
//   - one sample per network node with finite cost <= budget;
//   - samples along each edge at `spacing_m` between source and target
//     node coords, costed by edge_point_cost. Skips edges shorter than
//     spacing.
//
// The samples lie on the straight line between node endpoints (no edge
// geometry polylines). Suitable for downstream H3 cell aggregation where
// the cell takes the min cost of all samples that land in it — small
// approximation error inside a cell is dominated by the cheapest sample.
//
// Used by:
//   - hexagon_builder for hexagonal-catchment output.
//   - heatmap_v2 per-opportunity for per-cell access-cost accumulation.
std::vector<CostSample> sample_reachability_field(
    ReachabilityField const &field,
    double budget,
    bool use_distance,
    double spacing_m = 20.0);

} // namespace routing::geometry
