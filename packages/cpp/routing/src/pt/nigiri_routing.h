#pragma once

#include "../types.h"

#include <nigiri/timetable.h>
#include <nigiri/routing/query.h>

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace routing::pt
{

    // Run RAPTOR one-to-all forward search from the given seed stops over
    // the departure window [departure_time, departure_time +
    // departure_window) (one minute when the window is 0 or 1) and return
    // the minimum cost per destination across the window's departures
    // (nigiri's one_to_all_window, one range search for the window).
    // Returns a vector indexed by location_idx_t integer value.
    // Empty optional means the stop is unreachable within the budget.
    // Value is total travel time in minutes (access walk + transit).
    std::vector<std::optional<double>> run_raptor(
        nigiri::timetable const &tt,
        std::vector<nigiri::routing::offset> const &seed_stops,
        RequestConfig const &cfg);

    // Reverse (arrive-by) one-to-all RAPTOR for the PT heatmap. For every stop
    // from which `seeds` can be reached so as to arrive by `arrival_min`
    // within `max_travel` minutes, returns (location_idx, total minutes).
    // `seeds` carry the per-stop egress offsets (alighting stop → opportunity),
    // so the returned minutes already include egress + transit. Cost is
    // symmetric with the forward search; only the result extraction differs
    // (scan best_ for reached stops + sign flip, since backward durations are
    // negative).
    std::vector<std::pair<std::uint32_t, double>> run_reverse_raptor(
        nigiri::timetable const &tt,
        std::vector<nigiri::routing::offset> const &seeds,
        std::int64_t arrival_min,
        int max_travel,
        int max_transfers,
        std::vector<std::string> const &transit_modes);

} // namespace routing::pt
