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

std::vector<CostSample> sample_reachability_field(
    ReachabilityField const &field,
    double budget,
    bool use_distance,
    double spacing_m)
{
    std::vector<CostSample> samples;
    if (!field.network)
        return samples;

    auto const &net = *field.network;

    // Reserve a generous upper bound — most networks won't hit this.
    samples.reserve(static_cast<size_t>(net.node_count) +
                    net.source.size());

    // 1. Per-node samples.
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

    // 2. Edge samples (straight line between node coords), each costed by
    //    edge_point_cost.
    for (size_t i = 0; i < net.source.size(); ++i)
    {
        int32_t const s = net.source[i];
        int32_t const t = net.target[i];
        if (s < 0 || t < 0 ||
            s >= static_cast<int32_t>(field.costs.size()) ||
            t >= static_cast<int32_t>(field.costs.size()))
            continue;

        edge_anchors(field, i, splits_by_edge, anchors);
        double cheapest = std::numeric_limits<double>::infinity();
        for (auto const &a : anchors)
            cheapest = std::min(cheapest, a.cost);
        if (!(cheapest <= budget))
            continue;

        double const length = net.length_3857[i];
        if (length <= spacing_m)
            continue;  // node endpoints suffice for short edges

        auto const &sc = net.node_coords[s];
        auto const &tc = net.node_coords[t];
        double const dx = tc.x - sc.x;
        double const dy = tc.y - sc.y;

        int const n_splits = static_cast<int>(std::floor(length / spacing_m));
        for (int n = 1; n < n_splits; ++n)
        {
            double const frac = static_cast<double>(n) / n_splits;
            double const cost = edge_point_cost(
                anchors, frac, net.cost[i], net.reverse_cost[i], use_distance);
            if (cost > budget)
                continue;
            samples.push_back({sc.x + frac * dx, sc.y + frac * dy, cost});
        }
    }

    return samples;
}

} // namespace routing::geometry
