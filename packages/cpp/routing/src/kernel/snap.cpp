#include "snap.h"
#include "kdtree.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <unordered_set>
#include <vector>

namespace routing::kernel
{

    static constexpr double kCarConnectorSpeedKmH = 50.0 * 0.8;
    // Max snap distance in GROUND metres. Node coords are EPSG:3857, which is
    // inflated by 1/cos(lat) == cosh(y/R), so this is converted per-origin.
    static constexpr double kDefaultMaxSnapDistance = 500.0;
    static constexpr double kWebMercatorR = 6378137.0;

    namespace
    {

    struct Projection
    {
        Point3857 point;
        double dist;
        double frac;
    };

    struct SnapCandidate
    {
        size_t edge_idx;
        Projection proj;
    };

    Projection project_onto_segment(Point3857 const &p,
                                     Point3857 const &a,
                                     Point3857 const &b)
    {
        double abx = b.x - a.x;
        double aby = b.y - a.y;
        double ab_len2 = abx * abx + aby * aby;

        if (ab_len2 < 1e-12)
        {
            double dx = p.x - a.x;
            double dy = p.y - a.y;
            return {a, std::sqrt(dx * dx + dy * dy), 0.0};
        }

        double t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / ab_len2;
        t = std::max(0.0, std::min(1.0, t));

        Point3857 proj{a.x + t * abx, a.y + t * aby};
        double dx = p.x - proj.x;
        double dy = p.y - proj.y;
        return {proj, std::sqrt(dx * dx + dy * dy), t};
    }

    double connector_cost(double snap_distance_m, RequestConfig const &cfg)
    {
        if (cfg.cost_type == CostType::Distance)
            return snap_distance_m;

        double speed_km_h = cfg.speed_km_h;
        if (cfg.mode == RoutingMode::Car)
            speed_km_h = (cfg.speed_km_h > 0.0) ? cfg.speed_km_h
                                                 : kCarConnectorSpeedKmH;
        double speed_m_s = speed_km_h / 3.6;
        if (speed_m_s <= 0.0)
            speed_m_s = kCarConnectorSpeedKmH / 3.6;

        return snap_distance_m / speed_m_s;
    }

    std::vector<std::vector<size_t>> build_node_edge_index(
        SubNetwork const &net, size_t base_node_count)
    {
        std::vector<std::vector<size_t>> node_edges(base_node_count);
        for (size_t i = 0; i < net.source.size(); ++i)
        {
            auto s = static_cast<size_t>(net.source[i]);
            auto t = static_cast<size_t>(net.target[i]);
            if (s < base_node_count)
                node_edges[s].push_back(i);
            if (t < base_node_count)
                node_edges[t].push_back(i);
        }
        return node_edges;
    }

    // Find the nearest snap candidate for a single origin (closest edge projection).
    SnapCandidate find_best_snap(
        Point3857 const &origin,
        KdTree2D const &tree,
        std::vector<std::vector<size_t>> const &node_edges,
        SubNetwork const &net,
        size_t base_node_count,
        size_t base_edge_count,
        double max_snap_distance,
        int k_nearest_nodes)
    {
        auto nearest_nodes = tree.k_nearest(origin, k_nearest_nodes);

        std::unordered_set<size_t> checked_edges;
        SnapCandidate best{};
        best.proj.dist = std::numeric_limits<double>::infinity();

        for (auto const &[node_idx, node_dist] : nearest_nodes)
        {
            if (node_idx < 0 || static_cast<size_t>(node_idx) >= base_node_count)
                continue;
            // Early exit: if the nearest node is already far beyond our best
            // candidate there's no point checking further nodes.
            if (node_dist > max_snap_distance * 2.0 &&
                best.proj.dist < max_snap_distance)
                break;

            for (size_t ei : node_edges[static_cast<size_t>(node_idx)])
            {
                if (ei >= base_edge_count)
                    continue;
                // Only street edges. A connector or split half injected for
                // an earlier point is no street: a point snapped onto one
                // hangs off that point's spur instead of the network.
                if (net.edges[ei].id < 0)
                    continue;
                if (!checked_edges.insert(ei).second)
                    continue;

                auto const &src = net.node_coords[net.source[ei]];
                auto const &tgt = net.node_coords[net.target[ei]];
                auto proj = project_onto_segment(origin, src, tgt);

                if (proj.dist < best.proj.dist)
                    best = {ei, proj};
            }
        }

        return best;
    }

    // Inject a snap candidate into the network permanently.
    int32_t inject_snap(SubNetwork &net, SnapCandidate const &cand,
                        Point3857 const &origin, RequestConfig const &cfg)
    {
        size_t edge_idx = cand.edge_idx;
        int32_t src_node = net.source[edge_idx];
        int32_t tgt_node = net.target[edge_idx];
        double frac = cand.proj.frac;

        int32_t proj_node = net.node_count++;
        net.node_coords.push_back(cand.proj.point);

        int32_t origin_node = net.node_count++;
        net.node_coords.push_back(origin);

        // Connector: origin → projected point on edge. The projection distance
        // is in EPSG:3857 units; the cost is ground metres (or their walking
        // time), the same as every street edge, so it is scaled back by
        // cos(lat) — at 48°N the projected length is half as long again.
        double const snap_ground_m =
            cand.proj.dist / std::cosh(origin.y / kWebMercatorR);
        double snap_cost = connector_cost(snap_ground_m, cfg);
        net.source.push_back(origin_node);
        net.target.push_back(proj_node);
        net.cost.push_back(snap_cost);
        net.reverse_cost.push_back(snap_cost);
        net.length_3857.push_back(cand.proj.dist);
        net.edges.push_back({kConnectorEdgeId, {}});

        double fwd_cost = net.cost[edge_idx];
        double rev_cost = net.reverse_cost[edge_idx];

        Point3857 const &src_coord = net.node_coords[src_node];
        Point3857 const &tgt_coord = net.node_coords[tgt_node];

        double dx_t = cand.proj.point.x - tgt_coord.x;
        double dy_t = cand.proj.point.y - tgt_coord.y;
        double dist_to_tgt = std::sqrt(dx_t * dx_t + dy_t * dy_t);

        double dx_s = cand.proj.point.x - src_coord.x;
        double dy_s = cand.proj.point.y - src_coord.y;
        double dist_to_src = std::sqrt(dx_s * dx_s + dy_s * dy_s);

        // Split edge: projected point → target
        net.source.push_back(proj_node);
        net.target.push_back(tgt_node);
        net.cost.push_back(fwd_cost * (1.0 - frac));
        net.reverse_cost.push_back(rev_cost * (1.0 - frac));
        net.length_3857.push_back(dist_to_tgt);
        net.edges.push_back({kSplitToTargetEdgeId, {}});

        // Split edge: projected point → source
        net.source.push_back(proj_node);
        net.target.push_back(src_node);
        net.cost.push_back(rev_cost * frac);
        net.reverse_cost.push_back(fwd_cost * frac);
        net.length_3857.push_back(dist_to_src);
        net.edges.push_back({kSplitToSourceEdgeId, {}});

        net.splits.push_back({static_cast<int32_t>(edge_idx), proj_node, frac});

        return origin_node;
    }

    } // namespace

    std::vector<int32_t> snap_origins(SubNetwork &net,
                                      std::vector<Point3857> const &origins,
                                      RequestConfig const &cfg,
                                      double max_snap_distance,
                                      int k_nearest_nodes)
    {
        std::vector<int32_t> start_nodes;
        start_nodes.reserve(origins.size());

        if (net.node_coords.empty() || origins.empty())
        {
            start_nodes.assign(origins.size(), -1);
            return start_nodes;
        }

        if (max_snap_distance <= 0.0)
            max_snap_distance = kDefaultMaxSnapDistance;

        size_t const base_node_count = net.node_coords.size();
        size_t const base_edge_count = net.source.size();

        net.node_coords.reserve(base_node_count + origins.size() * 2);

        // For many origins a shared full-network tree + edge index is cheaper
        // than repeating the bbox filter + tree build per origin.
        static constexpr size_t kPerOriginThreshold = 100;
        bool const use_shared_tree = origins.size() > kPerOriginThreshold;

        // Shared structures (built once when use_shared_tree is true).
        std::unique_ptr<KdTree2D> shared_tree;
        std::vector<std::vector<size_t>> shared_node_edges;

        if (use_shared_tree)
        {
            shared_tree = std::make_unique<KdTree2D>(net.node_coords);
            shared_node_edges = build_node_edge_index(net, base_node_count);
        }

        for (size_t i = 0; i < origins.size(); ++i)
        {
            auto const &origin = origins[i];
            // max_snap_distance is ground metres; convert to EPSG:3857 units at
            // this origin's latitude (1/cos(lat) == cosh(y/R)).
            double const local_max =
                max_snap_distance * std::cosh(origin.y / kWebMercatorR);

            if (use_shared_tree)
            {
                auto best = find_best_snap(
                    origin, *shared_tree, shared_node_edges, net,
                    base_node_count, base_edge_count,
                    local_max, k_nearest_nodes);

                if (!std::isfinite(best.proj.dist) ||
                    best.proj.dist > local_max)
                    start_nodes.push_back(-1);
                else
                    start_nodes.push_back(
                        inject_snap(net, best, origin, cfg));
                continue;
            }

            // Per-origin bbox: only nodes within snap distance matter.
            double const bmin_x = origin.x - local_max;
            double const bmax_x = origin.x + local_max;
            double const bmin_y = origin.y - local_max;
            double const bmax_y = origin.y + local_max;

            std::vector<Point3857> local_coords;
            std::vector<int32_t> local_to_global;

            for (size_t n = 0; n < base_node_count; ++n)
            {
                auto const &c = net.node_coords[n];
                if (c.x >= bmin_x && c.x <= bmax_x &&
                    c.y >= bmin_y && c.y <= bmax_y)
                {
                    local_to_global.push_back(static_cast<int32_t>(n));
                    local_coords.push_back(c);
                }
            }

            if (local_coords.empty())
            {
                start_nodes.push_back(-1);
                continue;
            }

            // Build small KD-tree + edge index over only the nearby nodes.
            KdTree2D tree(local_coords);

            std::vector<int32_t> global_to_local(base_node_count, -1);
            for (size_t j = 0; j < local_to_global.size(); ++j)
                global_to_local[local_to_global[j]] = static_cast<int32_t>(j);

            size_t local_count = local_coords.size();
            std::vector<std::vector<size_t>> local_node_edges(local_count);
            for (size_t e = 0; e < base_edge_count; ++e)
            {
                auto s = net.source[e];
                auto t = net.target[e];
                if (s >= 0 && static_cast<size_t>(s) < base_node_count &&
                    global_to_local[s] >= 0)
                    local_node_edges[global_to_local[s]].push_back(e);
                if (t >= 0 && static_cast<size_t>(t) < base_node_count &&
                    global_to_local[t] >= 0)
                    local_node_edges[global_to_local[t]].push_back(e);
            }

            auto best = find_best_snap(
                origin, tree, local_node_edges, net,
                local_count, base_edge_count,
                local_max, k_nearest_nodes);

            if (!std::isfinite(best.proj.dist) ||
                best.proj.dist > local_max)
                start_nodes.push_back(-1);
            else
                start_nodes.push_back(
                    inject_snap(net, best, origin, cfg));
        }

        return start_nodes;
    }

} // namespace routing::kernel
