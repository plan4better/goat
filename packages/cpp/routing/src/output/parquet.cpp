#include "parquet.h"

#include "grid_contour_common.h"
#include "hexagon_builder.h"
#include "network_builder.h"
#include "point_grid_builder.h"
#include "polygon_builder.h"
#include "sql_export.h"

#include "../geometry/grid_surface_builder.h"
#include "../geometry/jsolines_processor.h"

#include <chrono>
#include <cstdio>
#include <duckdb.hpp>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>

namespace routing::output
{

namespace
{

void write_network_parquet(ReachabilityField const &field,
                           RequestConfig const &cfg,
                           duckdb::Connection &con,
                           std::string const &output_path)
{
    auto const feature_count = materialize_network_features_table(field, cfg, con);
    if (feature_count == 0)
        throw std::runtime_error("No reachable edges found for parquet export.");

    std::ostringstream body;
    body << "  SELECT "
         << "    CAST(row_number() OVER (ORDER BY edge_id) AS INTEGER) AS id, "
         << "    CAST(ROUND(step_cost) AS INTEGER) AS cost_step, "
         << "    geometry "
         << "  FROM " << network_features_table_name();
    write_query_to_parquet(con, body.str(), output_path,
                           "Network parquet export failed");
}

void write_hexagonal_grid_parquet(ReachabilityField const &field,
                                  RequestConfig const &cfg,
                                  duckdb::Connection &con,
                                  std::string const &output_path)
{
    auto const feature_count = materialize_hexagon_features_table(field, cfg, con);
    if (feature_count == 0)
    {
        throw std::runtime_error("No reachable edges found for hexagonal parquet export.");
    }

    std::ostringstream body;
    body << "  SELECT "
         << "    CAST(row_number() OVER (ORDER BY h3_h3_to_string(cell)) AS INTEGER) AS id, "
         << "    CAST(ROUND(step_cost) AS INTEGER) AS cost_step, "
         << "    geometry "
         << "  FROM " << hexagon_features_table_name();
    write_query_to_parquet(con, body.str(), output_path,
                           "Hexagonal grid parquet export failed");
}

void write_polygon_parquet(std::vector<ReachabilityField> const &fields,
                           RequestConfig const &cfg,
                           duckdb::Connection &con,
                           std::string const &output_path)
{
    auto const feature_count = materialize_polygon_features_table(fields, cfg, con);
    if (feature_count == 0)
    {
        throw std::runtime_error("No reachable polygons found for parquet export.");
    }

    std::ostringstream body;
    body << "  SELECT "
         << "    CAST(row_number() OVER (ORDER BY step_cost) AS INTEGER) AS id, "
         << "    CAST(ROUND(step_cost) AS INTEGER) AS cost_step, "
         << "    geometry "
         << "  FROM " << polygon_features_table_name();
    write_query_to_parquet(con, body.str(), output_path,
                           "Polygon parquet export failed");
}

} // namespace

void write_grid_contour_parquet_from_features(
    std::vector<TaggedFeature> const &all_features,
    RequestConfig const &cfg,
    duckdb::Connection &con,
    std::string const &output_path)
{
    if (all_features.empty())
        throw std::runtime_error("No reachable polygons for grid contour parquet export.");

    auto t0 = std::chrono::steady_clock::now();
    auto elapsed = [&]() {
        auto now = std::chrono::steady_clock::now();
        double ms = std::chrono::duration<double, std::milli>(now - t0).count();
        t0 = now;
        return ms;
    };

    // Load jsolines WKT into a temp table, apply difference if needed, export
    con.Query("INSTALL spatial; LOAD spatial;");

    // VALUES list keyed by (origin_idx, cluster_idx, step_cost); the band
    // difference partitions by (origin_idx, cluster_idx).
    std::ostringstream values;
    values << std::setprecision(15);
    for (size_t i = 0; i < all_features.size(); ++i)
    {
        if (i > 0) values << ",";
        values << "(" << all_features[i].origin_idx << ", "
               << all_features[i].cluster_idx << ", "
               << all_features[i].step_cost << ", "
               << "ST_GeomFromText('" << all_features[i].multipolygon_wkt << "'))";
    }

    auto run_step = [&](std::string const &q, char const *what) {
        auto r = con.Query(q);
        if (r->HasError())
            throw std::runtime_error(std::string(what) + " failed: " + r->GetError());
    };

    // Materialize each step into its own temp table so ST_MakeValid runs
    // exactly once (a fused CTE lets DuckDB re-evaluate it). jsolines emits
    // self-intersecting rings that ST_Difference/consumers reject, so repair
    // up front.
    con.Query("DROP TABLE IF EXISTS _iso_raw");
    run_step("CREATE TEMP TABLE _iso_raw AS "
             "SELECT origin_idx, cluster_idx, step_cost, ST_MakeValid(geom) AS geom "
             "FROM (VALUES " + values.str() +
             ") v(origin_idx, cluster_idx, step_cost, geom)", "isoline repair");

    std::string source_table = "_iso_raw";
    if (cfg.polygon_difference)
    {
        // Concentric bands = successive difference of cumulative isochrones;
        // the previous band comes from a LAG window (per origin/cluster,
        // ordered by step_cost), not a self-join.
        con.Query("DROP TABLE IF EXISTS _iso_bands");
        run_step("CREATE TEMP TABLE _iso_bands AS "
                 "WITH ordered AS (SELECT origin_idx, cluster_idx, step_cost, geom, "
                 "  LAG(geom) OVER (PARTITION BY origin_idx, cluster_idx "
                 "                  ORDER BY step_cost) AS prev_geom FROM _iso_raw) "
                 "SELECT origin_idx, cluster_idx, step_cost, "
                 "  CASE WHEN prev_geom IS NULL THEN geom "
                 "       ELSE ST_Difference(geom, prev_geom) END AS geom "
                 "FROM ordered", "isoline band difference");
        source_table = "_iso_bands";
    }

    con.Query("DROP TABLE IF EXISTS routing_grid_polygon_tmp");
    run_step("CREATE TEMP TABLE routing_grid_polygon_tmp AS SELECT "
             "  CAST(row_number() OVER (ORDER BY origin_idx, cluster_idx, step_cost) AS INTEGER) AS id, "
             "  CAST(ROUND(step_cost) AS INTEGER) AS cost_step, "
             // Which starting point produced this band. Both callers tag by
             // origin, so this is always present; what differs is that only a
             // Separated run carries the caller's own index (see
             // `valid_start_inputs`). Consumers that do not want it drop it.
             "  CAST(origin_idx AS INTEGER) AS origin_idx, "
             "  CASE WHEN ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON') THEN geom "
             "       WHEN ST_GeometryType(geom) = 'GEOMETRYCOLLECTION' "
             "         THEN ST_CollectionExtract(geom, 3) ELSE NULL END AS geometry "
             "FROM " + source_table +
             " WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) "
             "ORDER BY origin_idx, cluster_idx, step_cost", "isoline export");
    std::fprintf(stderr, "[Output] DuckDB geom conversion + difference: %.0f ms\n", elapsed());

    write_query_to_parquet(con, "SELECT * FROM routing_grid_polygon_tmp",
                           output_path, "Grid contour parquet export failed");
    std::fprintf(stderr, "[Output] COPY to parquet: %.0f ms\n", elapsed());
}

namespace
{

void write_grid_contour_parquet(
    std::vector<ReachabilityField> const &fields,
    RequestConfig const &cfg,
    duckdb::Connection &con,
    std::string const &output_path)
{
    if (fields.empty())
        throw std::runtime_error("No reachable area for grid contour parquet export.");
    auto const cutoffs = compute_step_cutoffs(cfg);
    int const zoom = geometry::grid_zoom_for_mode(cfg.mode);
    std::vector<TaggedFeature> all_features;
    for (size_t oi = 0; oi < fields.size(); ++oi)
        append_field_grid_features(all_features, fields[oi],
                                   static_cast<int32_t>(oi), zoom, cutoffs, cfg);
    write_grid_contour_parquet_from_features(all_features, cfg, con, output_path);
}

void write_point_grid_parquet(ReachabilityField const &field,
                              RequestConfig const &cfg,
                              duckdb::Connection &con,
                              std::string const &output_path)
{
    auto const feature_count = materialize_point_grid_features_table(field, cfg, con);
    if (feature_count == 0)
    {
        throw std::runtime_error("No reachable grid points for parquet export.");
    }

    std::ostringstream body;
    body << "  SELECT "
         << "    CAST(id AS INTEGER) AS id, "
         << "    CAST(ROUND(cost) AS DOUBLE) AS cost, "
         << "    cost_step, "
         << "    geometry "
         << "  FROM " << point_grid_features_table_name() << " "
         << "  ORDER BY id";
    write_query_to_parquet(con, body.str(), output_path,
                           "Point grid parquet export failed");
}

void write_empty_parquet(std::string const &output_path,
                         duckdb::Connection &con)
{
    write_query_to_parquet(
        con,
        "  SELECT "
        "    CAST(NULL AS INTEGER) AS id, "
        "    CAST(NULL AS INTEGER) AS cost_step, "
        "    CAST(NULL AS VARCHAR) AS geometry "
        "  WHERE FALSE",
        output_path, "Empty parquet export failed");
}

} // namespace

void write_parquet_output(std::vector<ReachabilityField> const &fields,
                          RequestConfig const &cfg,
                          duckdb::Connection &con)
{
    if (fields.empty())
    {
        write_empty_parquet(cfg.output_path, con);
        return;
    }
    auto const &field = fields[0]; // non-polygon branches use a single field

    switch (cfg.catchment_type)
    {
    case CatchmentType::Network:
        write_network_parquet(field, cfg, con, cfg.output_path);
        return;
    case CatchmentType::Polygon:
        if (cfg.mode != RoutingMode::Car)
        {
            write_grid_contour_parquet(fields, cfg, con, cfg.output_path);
        }
        else
        {
            write_polygon_parquet(fields, cfg, con, cfg.output_path);
        }
        return;
    case CatchmentType::HexagonalGrid:
        write_hexagonal_grid_parquet(field, cfg, con, cfg.output_path);
        return;
    case CatchmentType::PointGrid:
        write_point_grid_parquet(field, cfg, con, cfg.output_path);
        return;
    default:
        write_empty_parquet(cfg.output_path, con);
        return;
    }
}

} // namespace routing::output
