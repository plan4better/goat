#pragma once

#include "../types.h"
#include "steps.h"

#include <cstdint>
#include <string>
#include <vector>

namespace routing::output
{

// One marching-squares contour band. Each feature carries:
//   origin_idx — index into the request's starting points, distinguishing
//                features for shape_style=separated;
//   cluster_idx — index of the spatial cluster within that origin's field.
//                Combined catchments with widely-spread origins decompose
//                into multiple disjoint clusters so each per-cluster grid
//                stays bounded by the catchment radius. The cluster index
//                must be carried through SQL band-difference JOINs so a
//                step_cost in cluster A is differenced against the same
//                cluster's previous step, not another cluster's.
struct TaggedFeature
{
    int32_t origin_idx;
    int32_t cluster_idx;
    double step_cost;
    std::string multipolygon_wkt;
};

// Build cost grid + jsolines for one reachability field, append the
// resulting bands (tagged with origin_idx) to `out`. The intermediate
// cost grid is freed before returning, so callers can stream this per
// origin without holding all grids in memory at once.
void append_field_grid_features(
    std::vector<TaggedFeature> &out,
    ReachabilityField const &field,
    int32_t origin_idx,
    int zoom,
    std::vector<double> const &cutoffs,
    RequestConfig const &cfg);

} // namespace routing::output
