#include "grid_surface_builder.h"

#include "../kernel/kdtree.h"
#include "field_sampler.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <queue>
#include <unordered_map>
#include <vector>

namespace routing::geometry
{

namespace
{

constexpr double kEarthCircumference = 40075016.68557849;
constexpr double kHaloMeters = 200.0;
// Web Mercator sphere radius. Distances in EPSG:3857 are inflated by
// 1/cos(lat); ground metres = mercator metres * cos(lat) = merc / cosh(y/R).
constexpr double kMercatorRadius = 6378137.0;

double mercator_pixel_size(int zoom)
{
    double z_s = static_cast<double>(1 << zoom) * 256.0;
    return kEarthCircumference / z_s;
}

double merc_x_to_pixel(double x, int zoom)
{
    return (x + kEarthCircumference / 2.0) / mercator_pixel_size(zoom);
}

double merc_y_to_pixel(double y, int zoom)
{
    // Pixel y increases downward, mercator y increases upward.
    return (kEarthCircumference / 2.0 - y) / mercator_pixel_size(zoom);
}

// Snap radius used by the kernel when filling cells: cells farther from
// any sample than this are left as no-data. Linkage distance for clusters
// is 2× this so two samples that could compete for the same cell never
// land in different clusters.
double snap_radius_for_step(double step)
{
    return std::max(kHaloMeters, step * 8.0);
}

// Sample points along edge geometries stored in C++ Edge structs, each costed
// by edge_point_cost. Used for active mobility modes where
// geometry is loaded upfront.
void split_edges_cpp(
    ReachabilityField const &field,
    double split_distance,
    double budget,
    bool use_distance,
    std::vector<SamplePoint> &out)
{
    if (!field.network)
        return;

    auto const &net = *field.network;
    auto const splits_by_edge = index_splits(net);
    std::vector<EdgeAnchor> anchors;
    for (size_t i = 0; i < net.edges.size(); ++i)
    {
        int32_t src = net.source[i];
        int32_t tgt = net.target[i];
        if (src < 0 || tgt < 0 ||
            src >= static_cast<int32_t>(field.costs.size()) ||
            tgt >= static_cast<int32_t>(field.costs.size()))
            continue;

        edge_anchors(field, i, splits_by_edge, anchors);
        bool reached = false;
        for (auto const &a : anchors)
            reached = reached || std::isfinite(a.cost);
        if (!reached)
            continue;

        auto const &geom = net.edges[i].geometry;
        if (geom.size() < 2)
            continue;

        double total_length = net.length_3857[i];
        if (total_length <= 0.0)
            continue;

        double const fwd = net.cost[i];
        double const rev = net.reverse_cost[i];
        double prev_agg = 0.0;
        for (size_t g = 0; g + 1 < geom.size(); ++g)
        {
            double dx = geom[g + 1].x - geom[g].x;
            double dy = geom[g + 1].y - geom[g].y;
            double seg_len = std::sqrt(dx * dx + dy * dy);
            double agg = prev_agg + seg_len;

            int n_splits = static_cast<int>(std::floor(seg_len / split_distance));
            for (int n = 1; n <= n_splits; ++n)
            {
                double d = n * split_distance;
                double frac_seg = d / seg_len;
                double x = geom[g].x + frac_seg * dx;
                double y = geom[g].y + frac_seg * dy;
                double frac_edge = (prev_agg + d) / total_length;
                double cost = edge_point_cost(anchors, frac_edge, fwd, rev,
                                              use_distance);
                if (cost <= budget)
                    out.push_back({x, y, cost});
            }

            if (g + 2 < geom.size())
            {
                double frac_edge = agg / total_length;
                double cost = edge_point_cost(anchors, frac_edge, fwd, rev,
                                              use_distance);
                if (cost <= budget)
                    out.push_back({geom[g + 1].x, geom[g + 1].y, cost});
            }

            prev_agg = agg;
        }
    }
}

std::vector<SamplePoint> collect_field_samples(
    ReachabilityField const &field, double split_distance, double budget,
    bool use_distance)
{
    std::vector<SamplePoint> samples;
    if (!field.network || field.costs.empty())
        return samples;
    auto const &net = *field.network;
    samples.reserve(net.node_count);
    for (int32_t i = 0; i < net.node_count; ++i)
    {
        double cost = field.costs[i];
        if (!std::isfinite(cost) || cost > budget)
            continue;
        auto const &c = net.node_coords[i];
        samples.push_back({c.x, c.y, cost});
    }
    split_edges_cpp(field, split_distance, budget, use_distance, samples);
    return samples;
}

} // namespace

std::vector<FieldCluster> cluster_field(
    ReachabilityField const &field, RequestConfig const &cfg, int zoom)
{
    std::vector<FieldCluster> result;

    double const step = mercator_pixel_size(zoom);
    double const link_distance = 2.0 * snap_radius_for_step(step);

    auto samples = collect_field_samples(field, step, cfg.cost_budget(),
                                         cfg.cost_type == CostType::Distance);
    if (samples.empty())
        return result;

    // Bin samples into a coarse grid at link_distance. Two samples in
    // non-adjacent bins are guaranteed > link_distance apart, so no grid
    // cell can ever see both within snap range.
    auto pack = [](int32_t bx, int32_t by) -> int64_t {
        return (static_cast<int64_t>(by) << 32)
             | (static_cast<int64_t>(static_cast<uint32_t>(bx)));
    };
    auto unpack = [](int64_t k) -> std::pair<int32_t, int32_t> {
        return {static_cast<int32_t>(static_cast<uint32_t>(k & 0xFFFFFFFFULL)),
                static_cast<int32_t>(k >> 32)};
    };

    std::unordered_map<int64_t, std::vector<size_t>> bin_to_samples;
    bin_to_samples.reserve(samples.size() / 4);
    for (size_t i = 0; i < samples.size(); ++i)
    {
        int32_t bx = static_cast<int32_t>(std::floor(samples[i].x / link_distance));
        int32_t by = static_cast<int32_t>(std::floor(samples[i].y / link_distance));
        bin_to_samples[pack(bx, by)].push_back(i);
    }

    // Connected components of bins (8-way neighbors).
    std::unordered_map<int64_t, int> bin_to_cluster;
    int n_clusters = 0;
    for (auto const &kv : bin_to_samples)
    {
        auto [seed_it, seeded] = bin_to_cluster.try_emplace(kv.first, n_clusters);
        if (!seeded) continue;
        std::queue<int64_t> q;
        q.push(kv.first);
        while (!q.empty())
        {
            int64_t k = q.front(); q.pop();
            auto [kx, ky] = unpack(k);
            for (int dy = -1; dy <= 1; ++dy)
                for (int dx = -1; dx <= 1; ++dx)
                {
                    if (dx == 0 && dy == 0) continue;
                    int64_t nk = pack(kx + dx, ky + dy);
                    if (!bin_to_samples.count(nk)) continue;
                    auto [it, inserted] = bin_to_cluster.try_emplace(nk, n_clusters);
                    if (inserted) q.push(nk);
                }
        }
        ++n_clusters;
    }

    // Group samples by cluster, compute per-cluster bbox.
    result.assign(static_cast<size_t>(n_clusters), FieldCluster{});
    for (auto &c : result)
    {
        c.min_x = c.min_y =  std::numeric_limits<double>::infinity();
        c.max_x = c.max_y = -std::numeric_limits<double>::infinity();
    }
    for (auto const &kv : bin_to_samples)
    {
        int ci = bin_to_cluster[kv.first];
        auto &c = result[ci];
        for (size_t i : kv.second)
        {
            auto const &s = samples[i];
            c.samples.push_back(s);
            c.min_x = std::min(c.min_x, s.x); c.max_x = std::max(c.max_x, s.x);
            c.min_y = std::min(c.min_y, s.y); c.max_y = std::max(c.max_y, s.y);
        }
    }

    // Drop empty clusters defensively (shouldn't happen by construction).
    result.erase(std::remove_if(result.begin(), result.end(),
        [](FieldCluster const &c) { return c.samples.empty(); }),
        result.end());
    return result;
}

CostGrid build_cost_grid_from_cluster(
    FieldCluster const &cluster, RequestConfig const &cfg, int zoom)
{
    CostGrid grid{};
    if (cluster.samples.empty())
        return grid;

    double const budget = cfg.cost_budget();

    // Pad the tight cluster bbox by the kernel halo so off-network cells
    // along the edge get a neighbor within snap range.
    double min_x = cluster.min_x - kHaloMeters;
    double min_y = cluster.min_y - kHaloMeters;
    double max_x = cluster.max_x + kHaloMeters;
    double max_y = cluster.max_y + kHaloMeters;

    double const px_bl_x = std::floor(merc_x_to_pixel(min_x, zoom));
    double const px_bl_y = std::floor(merc_y_to_pixel(min_y, zoom));
    double const px_tr_x = std::floor(merc_x_to_pixel(max_x, zoom));
    double const px_tr_y = std::floor(merc_y_to_pixel(max_y, zoom));

    int32_t const width_px = static_cast<int32_t>(px_tr_x - px_bl_x);
    int32_t const height_px = static_cast<int32_t>(px_bl_y - px_tr_y);
    if (width_px < 2 || height_px < 2)
        return grid;

    double const step_x = (max_x - min_x) / width_px;
    double const step_y = (max_y - min_y) / height_px;

    // Deduplicate samples per pixel cell (keep cheapest).
    std::vector<SamplePoint> dedup;
    {
        std::unordered_map<int64_t, size_t> best_per_pixel;
        best_per_pixel.reserve(cluster.samples.size());
        for (size_t i = 0; i < cluster.samples.size(); ++i)
        {
            int64_t px = static_cast<int64_t>(
                std::round(merc_x_to_pixel(cluster.samples[i].x, zoom)));
            int64_t py = static_cast<int64_t>(
                std::round(merc_y_to_pixel(cluster.samples[i].y, zoom)));
            int64_t key = py * 1'000'000LL + px;
            auto it = best_per_pixel.find(key);
            if (it == best_per_pixel.end())
                best_per_pixel[key] = i;
            else if (cluster.samples[i].cost < cluster.samples[it->second].cost)
                it->second = i;
        }
        dedup.reserve(best_per_pixel.size());
        for (auto const &[_, idx] : best_per_pixel)
            dedup.push_back(cluster.samples[idx]);
    }

    // KD-tree over deduplicated samples.
    std::vector<Point3857> kd_coords(dedup.size());
    for (size_t i = 0; i < dedup.size(); ++i)
        kd_coords[i] = {dedup[i].x, dedup[i].y};
    kernel::KdTree2D tree(kd_coords);

    double const speed_m_per_s = (cfg.speed_km_h > 0.0)
        ? (cfg.speed_km_h * 1000.0 / 3600.0)
        : (5.0 * 1000.0 / 3600.0);
    double const max_snap = snap_radius_for_step(std::max(step_x, step_y));
    double const kNoData = std::numeric_limits<int32_t>::max();

    std::vector<double> surface(
        static_cast<size_t>(width_px) * height_px, kNoData);

    for (int32_t row = 0; row < height_px; ++row)
    {
        double gy = max_y - (row + 0.5) * step_y;
        // Convert the euclidean snap leg from Web Mercator metres to ground
        // metres so it is charged at the same rate as the routed network cost
        // (which is in true ground units). Scale is constant along a row.
        double const ground_scale = 1.0 / std::cosh(gy / kMercatorRadius);
        for (int32_t col = 0; col < width_px; ++col)
        {
            double gx = min_x + (col + 0.5) * step_x;

            auto [idx, dist] = tree.nearest_within({gx, gy}, max_snap);
            if (idx < 0) continue;

            double base_cost = dedup[idx].cost;
            double ground_dist = dist * ground_scale;
            double walk_cost = (cfg.cost_type == CostType::Distance)
                ? ground_dist
                : (ground_dist / speed_m_per_s) / 60.0;
            double total = std::round(base_cost + walk_cost);
            if (total <= budget)
                surface[static_cast<size_t>(row) * width_px + col] = total;
        }
    }

    grid.surface = std::move(surface);
    grid.width = width_px;
    grid.height = height_px;
    grid.west = min_x;
    grid.north = max_y;
    grid.step_x = step_x;
    grid.step_y = step_y;
    return grid;
}

} // namespace routing::geometry
