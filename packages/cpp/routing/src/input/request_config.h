#pragma once

#include "../types.h"

#include <string>
#include <vector>

namespace routing::input
{

    // Multiplier applied to the user-supplied speed when sizing the H3 buffer
    // for active-mobility edge loading (Walking/Bicycle/Pedelec, plus PT
    // access/egress legs that ride on the active network).
    inline constexpr double kActiveBufferSpeedMultiplier = 0.8;

    // Fixed buffer speed for Car edge loading. Car routing costs come from
    // per-edge OSM maxspeed (not cfg.speed_km_h), so the user-supplied speed
    // can't size the load — this is the worst-case effective speed used to
    // bound the H3 search radius around starting points / PT stops.
    inline constexpr double kCarBufferSpeedKmH = 50.0;

    std::vector<std::string> valid_classes(RoutingMode mode);

    // Tiered-loading split of valid_classes(mode), used when loading a street
    // network across a large extent (e.g. wide travel-cost matrices): skeleton
    // classes (arterials) are loaded across the whole bbox, detail classes
    // (local roads) only in small circles around points.
    //
    // detail_classes(mode) is exactly valid_classes(mode) minus
    // skeleton_classes(mode), so the two partitions can never drift from the
    // canonical taxonomy.
    std::vector<std::string> skeleton_classes(RoutingMode mode);
    std::vector<std::string> detail_classes(RoutingMode mode);

    double buffer_distance(RequestConfig const &cfg);

} // namespace routing::input
