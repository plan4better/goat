#include "hexagon_builder.h"
#include "hex_resolution.h"
#include "sql_export.h"
#include "steps.h"

#include "../geometry/field_sampler.h"

#include <duckdb.hpp>
#include <sstream>
#include <stdexcept>

namespace routing::output
{

namespace
{
static constexpr char kHexagonFeaturesTempTable[] = "routing_hexagon_features_tmp";
// EPSG:3857 units between samples along an edge: well under a cell's width.
static constexpr double kSampleSpacing = 20.0;
} // namespace

std::string const &hexagon_features_table_name()
{
    static std::string const table_name = kHexagonFeaturesTempTable;
    return table_name;
}

int64_t materialize_hexagon_features_table(ReachabilityField const &field,
                                           RequestConfig const &cfg,
                                           duckdb::Connection &con)
{
    double budget = cfg.cost_budget();

    auto drop_features = con.Query(std::string("DROP TABLE IF EXISTS ") +
                                   kHexagonFeaturesTempTable);
    if (drop_features->HasError())
        throw std::runtime_error("Failed to drop hexagon features temp table: " +
                                 drop_features->GetError());

    if (!field.network)
        return 0;

    // Build (x, y, cost) samples using the shared field sampler.
    auto const samples = geometry::sample_reachability_field(
        field, budget, cfg.cost_type == CostType::Distance, kSampleSpacing);

    con.Query("DROP TABLE IF EXISTS hex_sample_points");
    con.Query("CREATE TEMP TABLE hex_sample_points (x DOUBLE, y DOUBLE, cost DOUBLE)");
    {
        duckdb::Appender appender(con, "hex_sample_points");
        for (auto const &s : samples)
        {
            appender.BeginRow();
            appender.Append(s.x);
            appender.Append(s.y);
            appender.Append(s.cost);
            appender.EndRow();
        }
    }

    std::string const step_cost_expr =
        step_for_cost_sql("min_cost", compute_step_cutoffs(cfg));

    int32_t resolution = hex_resolution_for_mode(cfg.mode);

    std::ostringstream create_sql;
    create_sql << "CREATE TEMP TABLE " << kHexagonFeaturesTempTable << " AS "
               << "WITH wgs84 AS ("
               << "  SELECT ST_X(ST_Transform(ST_Point(x, y), 'EPSG:3857', 'OGC:CRS84')) AS lng, "
               << "         ST_Y(ST_Transform(ST_Point(x, y), 'EPSG:3857', 'OGC:CRS84')) AS lat, "
               << "         cost FROM hex_sample_points"
               << "), "
               << "sampled_cells AS ("
               << "  SELECT "
               << "    h3_latlng_to_cell(lat, lng, " << resolution << ") AS cell, "
               << "    min(cost) AS min_cost "
               << "  FROM wgs84 "
               << "  GROUP BY 1"
               << "), "
               << "enriched AS ("
               << "  SELECT cell, min_cost, "
               << "    " << step_cost_expr << " AS step_cost "
               << "  FROM sampled_cells"
               << ") "
               << "SELECT cell, "
               << "  " << resolution << " AS resolution, "
               << "  min_cost, step_cost, "
               << "  ST_GeomFromWKB(h3_cell_to_boundary_wkb(cell)) AS geometry "
               << "FROM enriched";

    auto create_features = con.Query(create_sql.str());
    if (create_features->HasError())
        throw std::runtime_error("Hexagon features materialization failed: " +
                                 create_features->GetError());

    con.Query("DROP TABLE IF EXISTS hex_sample_points");

    return count_rows(con, kHexagonFeaturesTempTable);
}

} // namespace routing::output
