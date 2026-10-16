#pragma once

#include "../types.h"

#include <cmath>
#include <stdexcept>

namespace routing::input
{

    void validate(RequestConfig &cfg);

    // Shared environmental walkability validation for all street entry points.
    // Each config exposes shade/heat/slope weights plus mode/cost_type.
    template <typename ConfigT>
    inline void validate_environmental_weights(ConfigT const &cfg)
    {
        if (cfg.shade_weight < 0.0 || !std::isfinite(cfg.shade_weight) || cfg.shade_weight > 5.0)
            throw std::invalid_argument("shade_weight must be between 0.0 and 5.0");
        if (cfg.heat_weight < 0.0 || !std::isfinite(cfg.heat_weight) || cfg.heat_weight > 5.0)
            throw std::invalid_argument("heat_weight must be between 0.0 and 5.0");
        if (cfg.slope_walk_weight < 0.0 || !std::isfinite(cfg.slope_walk_weight) || cfg.slope_walk_weight > 3.0)
            throw std::invalid_argument("slope_walk_weight must be between 0.0 and 3.0");
        if (cfg.shade_weight > 0.0 || cfg.heat_weight > 0.0 || cfg.slope_walk_weight > 0.0)
        {
            if (cfg.mode != RoutingMode::Walking)
                throw std::invalid_argument(
                    "Environmental walkability weights are only supported for Walking mode");
            if (cfg.cost_type != CostType::Time)
                throw std::invalid_argument(
                    "Environmental walkability weights are only supported for Time cost type");
        }
    }

} // namespace routing::input
