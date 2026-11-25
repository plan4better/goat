#include "network_builder.h"

#include "sql_export.h"
#include "steps.h"

#include "../geometry/field_sampler.h"

#include <algorithm>
#include <cmath>
#include <duckdb.hpp>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace routing::output
{

namespace
{
static constexpr char kNetworkFeaturesTempTable[] = "routing_network_features_tmp";

// The stretch of `geom` from `lo` to `hi` (fractions of its length) as an
// EPSG:3857 WKT linestring; empty if the stretch has no length.
std::string build_substring_wkt(std::vector<Point3857> const &geom,
                                double lo, double hi)
{
    if (geom.size() < 2 || !(hi > lo))
        return "";

    double total_length = 0.0;
    for (size_t i = 0; i + 1 < geom.size(); ++i)
    {
        double dx = geom[i + 1].x - geom[i].x;
        double dy = geom[i + 1].y - geom[i].y;
        total_length += std::sqrt(dx * dx + dy * dy);
    }
    if (total_length <= 0.0)
        return "";

    double const from = lo * total_length;
    double const to = hi * total_length;
    std::ostringstream wkt;
    wkt << std::setprecision(10) << "LINESTRING(";
    int emitted = 0;
    auto emit = [&](double x, double y) {
        wkt << (emitted++ ? "," : "") << x << " " << y;
    };

    double agg = 0.0;
    for (size_t i = 0; i + 1 < geom.size() && agg <= to; ++i)
    {
        double dx = geom[i + 1].x - geom[i].x;
        double dy = geom[i + 1].y - geom[i].y;
        double seg_len = std::sqrt(dx * dx + dy * dy);
        double const next = agg + seg_len;
        if (next > from && seg_len > 0.0)
        {
            if (emitted == 0)
            {
                double f = (from - agg) / seg_len;
                emit(geom[i].x + f * dx, geom[i].y + f * dy);
            }
            if (next >= to)
            {
                double f = (to - agg) / seg_len;
                emit(geom[i].x + f * dx, geom[i].y + f * dy);
                break;
            }
            emit(geom[i + 1].x, geom[i + 1].y);
        }
        agg = next;
    }
    if (emitted < 2)
        return "";
    wkt << ")";
    return wkt.str();
}

// A stretch of an edge reachable within the budget, as fractions of the edge
// from its source, and the cost it is reached at.
struct Reach
{
    double lo;
    double hi;
    double cost;
};

// The stretches of an edge reachable within `budget`: from each anchor (an
// end, or the point where a snap split it) as far as the remaining budget
// goes at the edge's own cost in each direction. Overlapping stretches merge,
// at the cheaper anchor's cost; an edge reached from both ends whose middle
// is out of reach keeps two.
std::vector<Reach> reachable_stretches(std::vector<geometry::EdgeAnchor> const &anchors,
                                       double fwd, double rev, double budget,
                                       bool use_distance)
{
    auto usable = [](double c) { return c >= 0.0 && c < 99999.0; };
    double const scale = use_distance ? 1.0 : 1.0 / 60.0;
    std::vector<Reach> reach;
    for (auto const &a : anchors)
    {
        if (!std::isfinite(a.cost) || a.cost > budget)
            continue;
        double const left = budget - a.cost;
        double hi = a.frac;
        double lo = a.frac;
        if (usable(fwd))
            hi = (fwd > 0.0) ? a.frac + left / (fwd * scale) : 1.0;
        if (usable(rev))
            lo = (rev > 0.0) ? a.frac - left / (rev * scale) : 0.0;
        lo = std::max(lo, 0.0);
        hi = std::min(hi, 1.0);
        if (hi > lo)
            reach.push_back({lo, hi, a.cost});
    }
    std::sort(reach.begin(), reach.end(),
              [](Reach const &x, Reach const &y) { return x.lo < y.lo; });
    std::vector<Reach> merged;
    for (auto const &r : reach)
    {
        if (!merged.empty() && r.lo <= merged.back().hi)
        {
            merged.back().hi = std::max(merged.back().hi, r.hi);
            merged.back().cost = std::min(merged.back().cost, r.cost);
        }
        else
            merged.push_back(r);
    }
    return merged;
}

// The pieces of a reachable stretch, each within one band: cut wherever the
// cost along it crosses a cutoff, so an edge spanning several bands is drawn
// in each of them. Between the cuts below the cost is monotone, so a piece's
// middle tells its band. `cost` of each piece is its step cost.
std::vector<Reach> band_pieces(Reach const &stretch,
                               std::vector<geometry::EdgeAnchor> const &anchors,
                               double fwd, double rev, bool use_distance,
                               std::vector<double> const &cutoffs)
{
    auto usable = [](double c) { return c >= 0.0 && c < 99999.0; };
    double const scale = use_distance ? 1.0 : 1.0 / 60.0;
    double const fwd_u = usable(fwd) ? fwd * scale : 0.0;
    double const rev_u = usable(rev) ? rev * scale : 0.0;

    // Where the cost could change band or slope: each anchor, where its cost
    // reaches each cutoff in either direction, and where two anchors' costs
    // meet.
    std::vector<double> cuts{stretch.lo, stretch.hi};
    for (auto const &a : anchors)
    {
        if (!std::isfinite(a.cost))
            continue;
        cuts.push_back(a.frac);
        for (double c : cutoffs)
        {
            if (c <= a.cost)
                continue;
            if (fwd_u > 0.0)
                cuts.push_back(a.frac + (c - a.cost) / fwd_u);
            if (rev_u > 0.0)
                cuts.push_back(a.frac - (c - a.cost) / rev_u);
        }
        for (auto const &b : anchors)
        {
            if (b.frac <= a.frac || !std::isfinite(b.cost) ||
                fwd_u + rev_u <= 0.0)
                continue;
            cuts.push_back((b.cost - a.cost + b.frac * rev_u + a.frac * fwd_u) /
                           (fwd_u + rev_u));
        }
    }
    std::sort(cuts.begin(), cuts.end());

    constexpr double kEps = 1e-9;
    std::vector<Reach> pieces;
    for (size_t k = 0; k + 1 < cuts.size(); ++k)
    {
        double const f0 = std::max(cuts[k], stretch.lo);
        double const f1 = std::min(cuts[k + 1], stretch.hi);
        if (f1 - f0 <= kEps)
            continue;
        double const cost = step_for_cost(
            geometry::edge_point_cost(anchors, 0.5 * (f0 + f1), fwd, rev,
                                      use_distance),
            cutoffs);
        if (!pieces.empty() && pieces.back().cost == cost &&
            f0 - pieces.back().hi <= kEps)
            pieces.back().hi = f1;
        else
            pieces.push_back({f0, f1, cost});
    }
    return pieces;
}

} // namespace

std::string const &network_features_table_name()
{
    static std::string const table_name = kNetworkFeaturesTempTable;
    return table_name;
}

int64_t materialize_network_features_table(ReachabilityField const &field,
                                           RequestConfig const &cfg,
                                           duckdb::Connection &con)
{
    if (!field.network)
        return 0;

    auto const &net = *field.network;
    double budget = cfg.cost_budget();

    con.Query(std::string("DROP TABLE IF EXISTS ") + kNetworkFeaturesTempTable);
    con.Query(std::string("CREATE TEMP TABLE ") + kNetworkFeaturesTempTable +
              " (edge_id BIGINT, step_cost DOUBLE, wkt TEXT)");

    int64_t count = 0;
    {
        duckdb::Appender appender(con, kNetworkFeaturesTempTable);

        bool const use_distance = (cfg.cost_type == CostType::Distance);
        auto const cutoffs = compute_step_cutoffs(cfg);
        auto const splits_by_edge = geometry::index_splits(net);
        std::vector<geometry::EdgeAnchor> anchors;
        for (size_t i = 0; i < net.source.size(); ++i)
        {
            int32_t s = net.source[i];
            int32_t t = net.target[i];
            if (s < 0 || t < 0 ||
                s >= static_cast<int32_t>(field.costs.size()) ||
                t >= static_cast<int32_t>(field.costs.size()))
                continue;
            // The two halves of an edge a snap split (ids -2 and -3): the
            // edge itself is drawn, from the split point too.
            if (net.edges[i].id == kSplitToTargetEdgeId ||
                net.edges[i].id == kSplitToSourceEdgeId)
                continue;

            geometry::edge_anchors(field, i, splits_by_edge, anchors);
            auto const stretches = reachable_stretches(
                anchors, net.cost[i], net.reverse_cost[i], budget, use_distance);
            if (stretches.empty())
                continue;

            // Use edge geometry if available, else straight line between nodes
            auto const &geom = net.edges[i].geometry;
            std::vector<Point3857> const *pts = &geom;
            std::vector<Point3857> fallback;
            if (geom.size() < 2)
            {
                fallback = {net.node_coords[s], net.node_coords[t]};
                pts = &fallback;
            }

            for (auto const &r : stretches)
            {
                for (auto const &piece : band_pieces(r, anchors, net.cost[i],
                                                     net.reverse_cost[i],
                                                     use_distance, cutoffs))
                {
                    std::string wkt =
                        build_substring_wkt(*pts, piece.lo, piece.hi);
                    if (wkt.empty())
                        continue;
                    appender.BeginRow();
                    appender.Append(net.edges[i].id);
                    appender.Append(piece.cost);
                    appender.Append(duckdb::Value(wkt));
                    appender.EndRow();
                    ++count;
                }
            }
        }
    }

    if (count == 0)
        return 0;

    // Convert WKT (EPSG:3857) to geometry and transform to WGS84
    std::string upgrade_sql =
        std::string("CREATE TEMP TABLE routing_network_geom AS "
        "SELECT edge_id, step_cost, "
        "ST_Transform(ST_GeomFromText(wkt), 'EPSG:3857', 'OGC:CRS84') AS geometry "
        "FROM ") + kNetworkFeaturesTempTable;

    con.Query("DROP TABLE IF EXISTS routing_network_geom");
    auto result = con.Query(upgrade_sql);
    if (result->HasError())
        throw std::runtime_error("Network geometry conversion failed: " +
                                 result->GetError());

    con.Query(std::string("DROP TABLE ") + kNetworkFeaturesTempTable);
    con.Query(std::string("ALTER TABLE routing_network_geom RENAME TO ") +
              kNetworkFeaturesTempTable);

    return count;
}

} // namespace routing::output
