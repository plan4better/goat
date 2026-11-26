#include "grid_contour_common.h"

#include "../geometry/grid_surface_builder.h"
#include "../geometry/jsolines_processor.h"

namespace routing::output
{

void append_field_grid_features(
    std::vector<TaggedFeature> &out,
    ReachabilityField const &field,
    int32_t origin_idx,
    int zoom,
    std::vector<double> const &cutoffs,
    RequestConfig const &cfg)
{
    auto clusters = geometry::cluster_field(field, cfg, zoom);
    for (size_t ci = 0; ci < clusters.size(); ++ci)
    {
        auto grid = geometry::build_cost_grid_from_cluster(clusters[ci], cfg, zoom);
        if (grid.surface.empty() || grid.width < 2 || grid.height < 2)
            continue;
        auto feats = geometry::build_jsolines_wkt(
            grid.surface, grid.width, grid.height,
            grid.west, grid.north, grid.step_x, grid.step_y,
            cutoffs);
        out.reserve(out.size() + feats.size());
        for (auto const &f : feats)
            out.push_back({origin_idx, static_cast<int32_t>(ci),
                           f.step_cost, f.multipolygon_wkt});
        // grid + samples + jsolines features all freed at end of iteration.
    }
}

} // namespace routing::output
