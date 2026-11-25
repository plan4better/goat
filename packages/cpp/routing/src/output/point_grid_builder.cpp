#include "point_grid_builder.h"

#include "sql_export.h"
#include "steps.h"

#include "../geometry/field_sampler.h"
#include "../kernel/kdtree.h"

#include <cmath>
#include <duckdb.hpp>
#include <stdexcept>
#include <vector>

namespace routing::output
{

namespace
{
static constexpr char kPointGridFeaturesTempTable[] = "routing_point_grid_features_tmp";
// Ground metres a grid point may lie from the street it is reached from.
static constexpr double kDefaultSnapDistance = 500.0;
// EPSG:3857 units between samples along an edge.
static constexpr double kSampleSpacing = 20.0;
// Web Mercator sphere radius: EPSG:3857 lengths are ground metres times
// cosh(y / R).
static constexpr double kMercatorRadius = 6378137.0;
} // namespace

std::string const &point_grid_features_table_name()
{
    static std::string const table_name = kPointGridFeaturesTempTable;
    return table_name;
}

int64_t materialize_point_grid_features_table(ReachabilityField const &field,
                                              RequestConfig const &cfg,
                                              duckdb::Connection &con)
{
    if (!field.network)
        return 0;

    double const budget = cfg.cost_budget();
    double const snap_ground_m = (cfg.grid_snap_distance > 0.0)
                                     ? cfg.grid_snap_distance
                                     : kDefaultSnapDistance;
    auto const cutoffs = compute_step_cutoffs(cfg);

    // Each grid point takes the nearest sample's cost plus the walk to it, as
    // a polygon's grid cell does.
    auto const points = geometry::sample_reachability_field(
        field, budget, cfg.cost_type == CostType::Distance, kSampleSpacing);
    if (points.empty())
        return 0;
    std::vector<Point3857> kd_coords(points.size());
    for (size_t i = 0; i < points.size(); ++i)
        kd_coords[i] = {points[i].x, points[i].y};
    kernel::KdTree2D tree(kd_coords);

    std::string points_path = sql_escape(cfg.grid_points_path);
    auto grid_result = con.Query(
        "SELECT id, CAST(x_3857 AS DOUBLE) AS x, CAST(y_3857 AS DOUBLE) AS y "
        "FROM read_parquet('" + points_path + "')");
    if (grid_result->HasError())
        throw std::runtime_error("Failed to read grid points: " +
                                 grid_result->GetError());

    con.Query(std::string("DROP TABLE IF EXISTS ") + kPointGridFeaturesTempTable);
    con.Query(std::string("CREATE TEMP TABLE ") + kPointGridFeaturesTempTable +
              " (id INTEGER, cost DOUBLE, cost_step INTEGER, x DOUBLE, y DOUBLE)");
    {
        duckdb::Appender appender(con, kPointGridFeaturesTempTable);
        while (true)
        {
            auto chunk = grid_result->Fetch();
            if (!chunk || chunk->size() == 0)
                break;

            for (size_t row = 0; row < chunk->size(); ++row)
            {
                int64_t id = chunk->GetValue(0, row).GetValue<int64_t>();
                double gx = chunk->GetValue(1, row).GetValue<double>();
                double gy = chunk->GetValue(2, row).GetValue<double>();

                // EPSG:3857 lengths here are ground metres times this.
                double const stretch = std::cosh(gy / kMercatorRadius);
                auto [idx, dist] =
                    tree.nearest_within({gx, gy}, snap_ground_m * stretch);
                if (idx < 0)
                    continue;

                double const total =
                    points[idx].cost + geometry::off_street_cost(dist / stretch, cfg);
                if (total > budget)
                    continue;

                appender.BeginRow();
                appender.Append(static_cast<int32_t>(id));
                appender.Append(total);
                appender.Append(static_cast<int32_t>(
                    std::round(step_for_cost(total, cutoffs))));
                appender.Append(gx);
                appender.Append(gy);
                appender.EndRow();
            }
        }
    }

    con.Query("DROP TABLE IF EXISTS routing_point_grid_final");
    auto final_result = con.Query(
        std::string("CREATE TEMP TABLE routing_point_grid_final AS "
                    "SELECT id, cost, cost_step, "
                    "ST_Transform(ST_Point(x, y), 'EPSG:3857', 'OGC:CRS84') AS geometry "
                    "FROM ") + kPointGridFeaturesTempTable);
    if (final_result->HasError())
        throw std::runtime_error("Point grid final table failed: " +
                                 final_result->GetError());
    con.Query(std::string("DROP TABLE IF EXISTS ") + kPointGridFeaturesTempTable);
    con.Query(std::string("ALTER TABLE routing_point_grid_final RENAME TO ") +
              kPointGridFeaturesTempTable);

    return count_rows(con, kPointGridFeaturesTempTable);
}

} // namespace routing::output
