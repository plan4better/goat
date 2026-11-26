#include "field_sampler.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace routing::geometry
{

std::unordered_multimap<int32_t, EdgeSplit> index_splits(SubNetwork const &net)
{
    std::unordered_multimap<int32_t, EdgeSplit> out;
    for (auto const &sp : net.splits)
        out.emplace(sp.edge, sp);
    return out;
}

void edge_anchors(ReachabilityField const &field, size_t i,
                  std::unordered_multimap<int32_t, EdgeSplit> const &splits_by_edge,
                  std::vector<EdgeAnchor> &out)
{
    auto const &net = *field.network;
    out.clear();
    out.push_back({0.0, field.costs[net.source[i]]});
    out.push_back({1.0, field.costs[net.target[i]]});
    auto [first, last] = splits_by_edge.equal_range(static_cast<int32_t>(i));
    for (auto it = first; it != last; ++it)
        if (it->second.node >= 0 &&
            it->second.node < static_cast<int32_t>(field.costs.size()))
            out.push_back({it->second.frac, field.costs[it->second.node]});
}

double off_street_cost(double ground_m, RequestConfig const &cfg)
{
    if (cfg.cost_type == CostType::Distance)
        return ground_m;
    double speed_km_h = cfg.speed_km_h;
    if (cfg.mode == RoutingMode::PublicTransport && cfg.egress_speed_km_h > 0.0)
        speed_km_h = cfg.egress_speed_km_h;
    if (!(speed_km_h > 0.0))
        speed_km_h = 5.0;
    return ground_m / (speed_km_h * 1000.0 / 3600.0) / 60.0;
}

std::vector<CostSample> sample_reachability_field(
    ReachabilityField const &field,
    double budget,
    bool use_distance,
    double spacing)
{
    std::vector<CostSample> samples;
    if (!field.network || field.costs.empty() || !(spacing > 0.0))
        return samples;

    auto const &net = *field.network;
    samples.reserve(static_cast<size_t>(net.node_count) + net.source.size());

    for (int32_t nid = 0; nid < net.node_count; ++nid)
    {
        double const cost = field.costs[nid];
        if (!std::isfinite(cost) || cost > budget)
            continue;
        auto const &c = net.node_coords[nid];
        samples.push_back({c.x, c.y, cost});
    }

    auto const splits_by_edge = index_splits(net);
    std::vector<EdgeAnchor> anchors;
    std::vector<Point3857> straight(2);
    for (size_t i = 0; i < net.source.size(); ++i)
    {
        int32_t const s = net.source[i];
        int32_t const t = net.target[i];
        if (s < 0 || t < 0 ||
            s >= static_cast<int32_t>(field.costs.size()) ||
            t >= static_cast<int32_t>(field.costs.size()))
            continue;
        // The halves of an edge a snap split: the edge itself is sampled,
        // from the split point too, and along its geometry.
        if (net.edges[i].id == kSplitToTargetEdgeId ||
            net.edges[i].id == kSplitToSourceEdgeId)
            continue;

        edge_anchors(field, i, splits_by_edge, anchors);
        double cheapest = std::numeric_limits<double>::infinity();
        for (auto const &a : anchors)
            cheapest = std::min(cheapest, a.cost);
        if (!(cheapest <= budget))
            continue;

        std::vector<Point3857> const *line = &net.edges[i].geometry;
        if (line->size() < 2)
        {
            straight[0] = net.node_coords[s];
            straight[1] = net.node_coords[t];
            line = &straight;
        }
        auto const &geom = *line;

        double total = 0.0;
        for (size_t g = 0; g + 1 < geom.size(); ++g)
            total += std::hypot(geom[g + 1].x - geom[g].x,
                                geom[g + 1].y - geom[g].y);
        if (total <= 0.0)
            continue;

        auto push = [&](double x, double y, double along) {
            double const cost = edge_point_cost(
                anchors, along / total, net.cost[i], net.reverse_cost[i],
                use_distance);
            if (cost <= budget)
                samples.push_back({x, y, cost});
        };

        double along = 0.0;
        for (size_t g = 0; g + 1 < geom.size(); ++g)
        {
            double const dx = geom[g + 1].x - geom[g].x;
            double const dy = geom[g + 1].y - geom[g].y;
            double const seg_len = std::hypot(dx, dy);
            for (double d = spacing; d < seg_len; d += spacing)
                push(geom[g].x + d / seg_len * dx, geom[g].y + d / seg_len * dy,
                     along + d);
            along += seg_len;
            // Inner vertices; the two ends are the nodes, sampled above.
            if (g + 2 < geom.size())
                push(geom[g + 1].x, geom[g + 1].y, along);
        }
    }

    return samples;
}

} // namespace routing::geometry
