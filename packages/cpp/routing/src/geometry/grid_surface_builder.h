#pragma once

#include "../types.h"
#include "field_sampler.h"

#include <cstdint>
#include <vector>

namespace routing::geometry
{

    struct CostGrid
    {
        std::vector<double> surface;   // row-major, height × width
        int32_t width;
        int32_t height;
        double west;    // web mercator x of left edge (pixel-aligned)
        double north;   // web mercator y of top edge (pixel-aligned)
        double step_x;  // web mercator units per pixel column
        double step_y;  // web mercator units per pixel row
    };

    // Return a grid zoom level appropriate for the routing mode.
    inline int grid_zoom_for_mode(RoutingMode mode)
    {
        switch (mode)
        {
        case RoutingMode::Walking: return 13;
        default:                  return 11;
        }
    }

    using SamplePoint = CostSample;

    // A spatially-disjoint patch of a reachability field. Splitting a field
    // into clusters keeps cost-grid cell counts proportional to actual
    // catchment coverage rather than the field's full bounding rectangle —
    // critical for Combined catchments with widely-spread origins where the
    // empty space between origins would otherwise dominate the grid.
    struct FieldCluster
    {
        std::vector<SamplePoint> samples;
        double min_x, min_y, max_x, max_y;  // tight bbox over samples (no pad)
    };

    // Partition a field's reachable region into clusters. Two samples land
    // in different clusters only if they are far enough apart that no grid
    // cell could see both within the kernel snap range — so the per-cluster
    // grid produces the same surface as a single field-spanning grid would,
    // at a fraction of the cell count.
    std::vector<FieldCluster> cluster_field(
        ReachabilityField const &field,
        RequestConfig const &cfg,
        int zoom);

    // Rasterize one pre-collected cluster.
    CostGrid build_cost_grid_from_cluster(
        FieldCluster const &cluster,
        RequestConfig const &cfg,
        int zoom);

} // namespace routing::geometry
