#include "grid_surface_builder.h"

#include "../kernel/kdtree.h"

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
// The smallest snap radius, in EPSG:3857 units.
constexpr double kMinSnapRadius = 200.0;
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
    return std::max(kMinSnapRadius, step * 8.0);
}

} // namespace

std::vector<FieldCluster> cluster_field(
    ReachabilityField const &field, RequestConfig const &cfg, int zoom)
{
    std::vector<FieldCluster> result;

    double const step = mercator_pixel_size(zoom);
    double const link_distance = 2.0 * snap_radius_for_step(step);

    auto samples = sample_reachability_field(
        field, cfg.cost_budget(), cfg.cost_type == CostType::Distance, step);
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

    // Cells farther than this from every sample stay no-data. The grid is
    // padded by as much, so a cell the kernel fills never falls outside it:
    // a smaller pad cut the contour off straight where the budget still
    // reached past it.
    double const max_snap = snap_radius_for_step(mercator_pixel_size(zoom));
    double min_x = cluster.min_x - max_snap;
    double min_y = cluster.min_y - max_snap;
    double max_x = cluster.max_x + max_snap;
    double max_y = cluster.max_y + max_snap;

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

            // Neither rounded nor capped at the budget: the contour at a
            // cutoff is interpolated between the cells either side of it, so
            // a cell just past the budget keeps its cost, and a rounded cost
            // would move the line by up to half a unit (half a minute).
            surface[static_cast<size_t>(row) * width_px + col] =
                dedup[idx].cost + off_street_cost(dist * ground_scale, cfg);
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
