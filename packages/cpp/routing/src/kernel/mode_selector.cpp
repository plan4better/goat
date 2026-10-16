#include "mode_selector.h"

#include <algorithm>
#include <cmath>

namespace routing::kernel
{

    static constexpr double kBicycleFootwaySpeed = 5.0 / 3.6; // m/s
    static constexpr double kCarSpeedFactor = 0.8;
    static constexpr double kOneWayCost = 99999.0;

    static bool is_footway(std::string const &cls)
    {
        return cls == "pedestrian" || cls == "crosswalk";
    }

    void compute_costs(std::vector<Edge> &edges, RequestConfig const &cfg)
    {
        double speed_ms =
            (cfg.mode != RoutingMode::Car) ? (cfg.speed_km_h / 3.6) : 0.0;

        for (auto &e : edges)
        {
            if (cfg.cost_type == CostType::Distance)
            {
                e.cost = e.length_m;
                e.reverse_cost = e.length_m;
                continue;
            }

            // Time-based costs (seconds)
            switch (cfg.mode)
            {
            case RoutingMode::Walking:
                {
                    // Walking is directed once slope_walk_weight is active:
                    // forward uses impedance_slope, backward uses
                    // impedance_slope_reverse. The [0.0, 1.0] clamp lives here
                    // (not in the data loader) so bicycle/pedelec keep their
                    // downhill (<0) and steep (>1) slope signals intact.
                    auto calc_multiplier = [&](double slope_imp) {
                        double m = 1.0;
                        if (cfg.shade_weight > 0.0 && e.impedance_shade > 0.0f)
                        {
                            m += cfg.shade_weight * static_cast<double>(e.impedance_shade);
                        }
                        if (cfg.heat_weight > 0.0 && e.impedance_heat > 0.0f)
                        {
                            m += cfg.heat_weight * static_cast<double>(e.impedance_heat);
                        }
                        if (cfg.slope_walk_weight > 0.0 && std::isfinite(slope_imp) && slope_imp > 0.0)
                        {
                            m += cfg.slope_walk_weight * std::clamp(slope_imp, 0.0, 1.0);
                        }
                        return m;
                    };
                    e.cost = (e.length_m * calc_multiplier(e.impedance_slope)) / speed_ms;
                    e.reverse_cost = (e.length_m * calc_multiplier(e.impedance_slope_reverse)) / speed_ms;
                }
                break;

            case RoutingMode::Bicycle:
                if (is_footway(e.class_))
                {
                    e.cost = e.length_m / kBicycleFootwaySpeed;
                    e.reverse_cost = e.length_m / kBicycleFootwaySpeed;
                }
                else
                {
                    e.cost = (e.length_m *
                              (1.0 + e.impedance_slope + e.impedance_surface)) /
                             speed_ms;
                    e.reverse_cost =
                        (e.length_m * (1.0 + e.impedance_slope_reverse +
                                       e.impedance_surface)) /
                        speed_ms;
                }
                break;

            case RoutingMode::Pedelec:
                if (is_footway(e.class_))
                {
                    e.cost = e.length_m / kBicycleFootwaySpeed;
                    e.reverse_cost = e.length_m / kBicycleFootwaySpeed;
                }
                else
                {
                    e.cost = (e.length_m * (1.0 + e.impedance_surface)) / speed_ms;
                    e.reverse_cost =
                        (e.length_m * (1.0 + e.impedance_surface)) / speed_ms;
                }
                break;

            case RoutingMode::Car:
                if (e.maxspeed_forward > 0)
                {
                    double fwd_speed =
                        (static_cast<double>(e.maxspeed_forward) * kCarSpeedFactor) /
                        3.6;
                    e.cost = e.length_m / fwd_speed;
                }
                else
                {
                    e.cost = kOneWayCost;
                }
                if (e.maxspeed_backward > 0)
                {
                    double rev_speed =
                        (static_cast<double>(e.maxspeed_backward) * kCarSpeedFactor) /
                        3.6;
                    e.reverse_cost = e.length_m / rev_speed;
                }
                else
                {
                    e.reverse_cost = kOneWayCost;
                }
                break;
            }
        }
    }

} // namespace routing::kernel
