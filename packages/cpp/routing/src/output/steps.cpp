#include "steps.h"

#include "sql_export.h"

#include <sstream>

namespace routing::output
{

std::vector<double> compute_step_cutoffs(RequestConfig const &cfg)
{
    std::vector<double> cutoffs;
    if (!cfg.cutoffs.empty())
    {
        cutoffs.reserve(cfg.cutoffs.size());
        for (int c : cfg.cutoffs)
            cutoffs.push_back(static_cast<double>(c));
        return cutoffs;
    }
    // Validation requires steps > 0 without cutoffs; one band otherwise.
    int const steps = (cfg.steps > 0) ? cfg.steps : 1;
    double const step_size = cfg.cost_budget() / static_cast<double>(steps);
    cutoffs.reserve(static_cast<size_t>(steps));
    for (int i = 1; i < steps; ++i)
        cutoffs.push_back(step_size * static_cast<double>(i));
    // The budget itself, not step_size * steps, which may round below it.
    cutoffs.push_back(cfg.cost_budget());
    return cutoffs;
}

double step_for_cost(double cost, std::vector<double> const &cutoffs)
{
    for (double c : cutoffs)
        if (cost <= c)
            return c;
    return cutoffs.empty() ? cost : cutoffs.back();
}

std::string step_for_cost_sql(std::string const &expr,
                              std::vector<double> const &cutoffs)
{
    if (cutoffs.empty())
        return expr;
    std::ostringstream sql;
    sql << "CASE";
    for (double c : cutoffs)
        sql << " WHEN " << expr << " <= " << sql_double(c) << " THEN "
            << sql_double(c);
    sql << " ELSE " << sql_double(cutoffs.back()) << " END";
    return sql.str();
}

} // namespace routing::output
