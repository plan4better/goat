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

// The cost of the walk from the street to a point `ground_m` metres away: the
// metres themselves for distance, else the time at the speed the catchment
// leaves the street at. For PT that is the egress leg's speed, the leg that
// reaches the area around a stop; a run without a speed walks at 5 km/h.
double off_street_cost(double ground_m, RequestConfig const &cfg);

struct CostSample
{
    double x;  // EPSG:3857
    double y;
    double cost;
};

// A reachability field as cost samples, the one sampling every grid-like
// catchment output (polygon, hexagon, point grid) builds on:
//   - one sample per network node within the budget;
//   - samples every `spacing` EPSG:3857 units along each reached edge, and at
//     its inner vertices, costed by edge_point_cost. They follow the edge's
//     geometry where it is loaded, else the straight line between its nodes.
std::vector<CostSample> sample_reachability_field(
    ReachabilityField const &field,
    double budget,
    bool use_distance,
    double spacing);

} // namespace routing::geometry
