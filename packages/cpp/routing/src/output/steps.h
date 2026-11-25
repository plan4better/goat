#pragma once

#include "../types.h"

#include <string>
#include <vector>

namespace routing::output
{

// The band limits of a request, ascending: its explicit cutoffs, else `steps`
// equal steps up to the budget.
std::vector<double> compute_step_cutoffs(RequestConfig const &cfg);

// The band a cost falls in, the one rule every catchment output uses: the
// first limit at or above it (the last, for a cost past them all).
double step_for_cost(double cost, std::vector<double> const &cutoffs);

// step_for_cost as a SQL expression over the column `expr`.
std::string step_for_cost_sql(std::string const &expr,
                              std::vector<double> const &cutoffs);

} // namespace routing::output
