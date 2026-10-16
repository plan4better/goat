#pragma once

#include "../types.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <queue>
#include <vector>

namespace routing::kernel
{

    // Reusable scratch for running many bounded Dijkstras over the *same* graph
    // (e.g. one per opportunity in a heatmap). Avoids the dominant cost of the
    // naive version — reallocating and zero-filling two node_count-sized arrays
    // per call — by generation-stamping: `cost[v]` is valid only when
    // `gen[v] == cur`, so resetting a run is O(1) (++cur).
    struct DijkstraScratch
    {
        std::vector<double> cost;
        std::vector<std::uint32_t> gen;   // gen[v]==cur ⟺ cost[v] set this run
        std::vector<std::uint32_t> done;  // done[v]==cur ⟺ v settled this run
        std::uint32_t cur = 0u;

        explicit DijkstraScratch(std::size_t node_count)
            : cost(node_count), gen(node_count, 0u), done(node_count, 0u) {}

        void begin()
        {
            // ++cur invalidates all prior stamps in O(1). On the (4-billionth)
            // wraparound, clear the stamps once so cur==0 entries don't alias.
            if (++cur == 0u)
            {
                std::fill(gen.begin(), gen.end(), 0u);
                std::fill(done.begin(), done.end(), 0u);
                cur = 1u;
            }
        }
        bool reached(std::int32_t v) const { return gen[v] == cur; }
    };

    // Bounded multi-source Dijkstra over reusable scratch: every source is
    // seeded at cost 0, so cost[v] is the cost to the nearest source. Returns
    // the reached nodes (cost < travel_budget); read their costs from
    // scratch.cost. Work is O(reached · log reached), not O(node_count).
    inline std::vector<std::int32_t>
    dijkstra_reached(std::vector<std::vector<AdjEntry>> const &adj,
                     std::vector<std::int32_t> const &sources,
                     double travel_budget, bool use_distance,
                     DijkstraScratch &scratch)
    {
        scratch.begin();
        std::vector<std::int32_t> reached;
        using PQEntry = std::pair<double, std::int32_t>;
        std::priority_queue<PQEntry, std::vector<PQEntry>, std::greater<>> pq;
        for (std::int32_t src : sources)
        {
            if (src < 0 || src >= static_cast<std::int32_t>(adj.size()))
                continue;
            if (scratch.gen[src] != scratch.cur)
            {
                scratch.cost[src] = 0.0;
                scratch.gen[src] = scratch.cur;
                pq.push({0.0, src});
            }
        }
        while (!pq.empty())
        {
            auto [d, u] = pq.top();
            pq.pop();
            if (d >= travel_budget)
                break;
            if (scratch.done[u] == scratch.cur)
                continue;
            scratch.done[u] = scratch.cur;
            reached.push_back(u);
            for (auto const &[v, w] : adj[u])
            {
                double const edge_cost = use_distance ? w : (w / 60.0);
                double const new_cost = d + edge_cost;
                if (scratch.gen[v] != scratch.cur || new_cost < scratch.cost[v])
                {
                    scratch.cost[v] = new_cost;
                    scratch.gen[v] = scratch.cur;
                    pq.push({new_cost, v});
                }
            }
        }
        return reached;
    }

    // Build adjacency list from flat SubNetwork arrays.
    inline std::vector<std::vector<AdjEntry>>
    build_adjacency_list(SubNetwork const &net)
    {
        std::vector<std::vector<AdjEntry>> adj(net.node_count);
        for (size_t i = 0; i < net.source.size(); ++i)
        {
            if (net.cost[i] >= 0.0 && net.cost[i] < 99999.0)
                adj[net.source[i]].push_back(
                    {net.target[i], net.cost[i]});
            if (net.reverse_cost[i] >= 0.0 && net.reverse_cost[i] < 99999.0)
                adj[net.target[i]].push_back(
                    {net.source[i], net.reverse_cost[i]});
        }
        return adj;
    }

    // Build the reverse-graph adjacency list. For every directed edge u→v
    // in the original graph G, the reverse graph G^T contains v→u with the
    // same cost. So a Dijkstra from node s on G^T gives, for every node v,
    // the shortest path cost v→s in the original G. For symmetric costs
    // (e.g. walking without environmental weights, where
    // cost == reverse_cost), G^T is structurally identical to G; for
    // asymmetric costs — car one-ways (reverse_cost=99999) and walking with
    // slope/shade/heat penalties — the transposed costs preserve direction.
    inline std::vector<std::vector<AdjEntry>>
    build_reverse_adjacency_list(SubNetwork const &net)
    {
        std::vector<std::vector<AdjEntry>> adj(net.node_count);
        for (size_t i = 0; i < net.source.size(); ++i)
        {
            // Forward edge u→v in G becomes v→u in G^T.
            if (net.cost[i] >= 0.0 && net.cost[i] < 99999.0)
                adj[net.target[i]].push_back(
                    {net.source[i], net.cost[i]});
            // The reverse direction of an edge in G (encoded as reverse_cost
            // applied to v→u traversal) becomes a forward edge u→v in G^T.
            if (net.reverse_cost[i] >= 0.0 && net.reverse_cost[i] < 99999.0)
                adj[net.source[i]].push_back(
                    {net.target[i], net.reverse_cost[i]});
        }
        return adj;
    }

    // Bounded multi-source Dijkstra returning a cost array of size node_count
    // (unreachable = +inf). travel_budget caps exploration: minutes for time
    // mode, meters for distance. Each source carries its own initial cost — PT
    // egress seeds destination stops at their transit cost; the overload below
    // seeds every source at 0.
    inline std::vector<double>
    dijkstra(std::vector<std::vector<AdjEntry>> const &adj,
             std::vector<std::pair<std::int32_t, double>> const &sources,
             double travel_budget, bool use_distance)
    {
        std::int32_t const node_count = static_cast<std::int32_t>(adj.size());
        constexpr double kInf = std::numeric_limits<double>::infinity();
        std::vector<double> cost(node_count, kInf);
        std::vector<bool> visited(node_count, false);

        using PQEntry = std::pair<double, std::int32_t>;
        std::priority_queue<PQEntry, std::vector<PQEntry>, std::greater<>> pq;

        for (auto const &[src, initial_cost] : sources)
        {
            if (src >= 0 && src < node_count && initial_cost < travel_budget)
            {
                if (initial_cost < cost[src])
                {
                    cost[src] = initial_cost;
                    pq.push({initial_cost, src});
                }
            }
        }

        while (!pq.empty())
        {
            auto [d, u] = pq.top();
            pq.pop();
            if (d >= travel_budget)
                break;
            if (visited[u])
                continue;
            visited[u] = true;

            for (auto const &[v, w] : adj[u])
            {
                double const edge_cost = use_distance ? w : (w / 60.0);
                double const new_cost = cost[u] + edge_cost;
                if (new_cost < cost[v])
                {
                    cost[v] = new_cost;
                    pq.push({new_cost, v});
                }
            }
        }
        return cost;
    }

    // Zero-cost sources: every source enters the search at 0.
    inline std::vector<double>
    dijkstra(std::vector<std::vector<AdjEntry>> const &adj,
             std::vector<std::int32_t> const &sources, double travel_budget,
             bool use_distance)
    {
        std::vector<std::pair<std::int32_t, double>> seeded;
        seeded.reserve(sources.size());
        for (std::int32_t src : sources)
            seeded.emplace_back(src, 0.0);
        return dijkstra(adj, seeded, travel_budget, use_distance);
    }

} // namespace routing::kernel
