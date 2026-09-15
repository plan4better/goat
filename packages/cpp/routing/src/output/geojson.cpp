#include "geojson.h"

#include "grid_contour_common.h"
#include "hexagon_builder.h"
#include "network_builder.h"
#include "point_grid_builder.h"
#include "polygon_builder.h"

#include "../geometry/grid_surface_builder.h"
#include "../geometry/jsolines_processor.h"

#include <duckdb.hpp>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>

namespace routing::output
{

namespace
{
std::string empty_feature_collection()
{
    return "{\"type\":\"FeatureCollection\",\"features\":[]}";
}

std::string run_single_value_query(duckdb::Connection &con,
                                   std::string const &sql,
                                   std::string const &error_prefix)
{
    auto result = con.Query(sql);
    if (result->HasError())
    {
        throw std::runtime_error(error_prefix + result->GetError());
    }
    if (result->RowCount() == 0 || result->GetValue(0, 0).IsNull())
    {
        return empty_feature_collection();
    }
    return result->GetValue(0, 0).GetValue<std::string>();
}

std::string build_network_geojson(duckdb::Connection &con)
{
    std::ostringstream sql;
    sql << "SELECT CAST(json_object("
        << "  'type', 'FeatureCollection', "
        << "  'features', COALESCE(json_group_array(feature), CAST('[]' AS JSON))"
        << ") AS VARCHAR) "
        << "FROM ("
        << "  SELECT json_object("
        << "    'type', 'Feature', "
        << "    'geometry', CAST(ST_AsGeoJSON(geometry) AS JSON), "
        << "    'properties', json_object('step_cost', step_cost)"
        << "  ) AS feature "
        << "  FROM " << network_features_table_name() << " "
        << "  ORDER BY edge_id"
        << ") t";
    return run_single_value_query(con, sql.str(), "Network GeoJSON export failed: ");
}

std::string build_hexagon_geojson(duckdb::Connection &con)
{
    std::ostringstream sql;
    sql << "SELECT CAST(json_object("
        << "  'type', 'FeatureCollection', "
        << "  'features', COALESCE(json_group_array(feature), CAST('[]' AS JSON))"
        << ") AS VARCHAR) "
        << "FROM ("
        << "  SELECT json_object("
        << "    'type', 'Feature', "
        << "    'geometry', CAST(ST_AsGeoJSON(geometry) AS JSON), "
        << "    'properties', json_object("
        << "      'h3', h3_h3_to_string(cell), "
        << "      'resolution', resolution, "
        << "      'cost', min_cost, "
        << "      'step_cost', step_cost"
        << "    )"
        << "  ) AS feature "
        << "  FROM " << hexagon_features_table_name() << " "
        << "  ORDER BY h3_h3_to_string(cell)"
        << ") t";
    return run_single_value_query(con, sql.str(), "Hexagon GeoJSON export failed: ");
}

std::string build_point_grid_geojson(duckdb::Connection &con)
{
    std::ostringstream sql;
    sql << "SELECT CAST(json_object("
        << "  'type', 'FeatureCollection', "
        << "  'features', COALESCE(json_group_array(feature), CAST('[]' AS JSON))"
        << ") AS VARCHAR) "
        << "FROM ("
        << "  SELECT json_object("
        << "    'type', 'Feature', "
        << "    'geometry', CAST(ST_AsGeoJSON(geometry) AS JSON), "
        << "    'properties', json_object("
        << "      'id', id, "
        << "      'cost', cost, "
        << "      'step_cost', step_cost"
        << "    )"
        << "  ) AS feature "
        << "  FROM " << point_grid_features_table_name() << " "
        << "  ORDER BY id"
        << ") t";
    return run_single_value_query(con, sql.str(), "Point grid GeoJSON export failed: ");
}

std::string build_polygon_geojson(duckdb::Connection &con)
{
    std::ostringstream sql;
    sql << "SELECT CAST(json_object("
        << "  'type', 'FeatureCollection', "
        << "  'features', COALESCE(json_group_array(feature), CAST('[]' AS JSON))"
        << ") AS VARCHAR) "
        << "FROM ("
        << "  SELECT json_object("
        << "    'type', 'Feature', "
        << "    'geometry', CAST(ST_AsGeoJSON(geometry) AS JSON), "
        << "    'properties', json_object('step_cost', step_cost)"
        << "  ) AS feature "
        << "  FROM " << polygon_features_table_name() << " "
        << "  ORDER BY step_cost"
        << ") t";
    return run_single_value_query(con, sql.str(), "Polygon GeoJSON export failed: ");
}

} // namespace

std::string build_grid_contour_geojson_from_features(
    std::vector<TaggedFeature> const &all_features,
    RequestConfig const &cfg,
    duckdb::Connection &con)
{
    if (all_features.empty())
        return empty_feature_collection();

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

    // Materialize each step so ST_MakeValid runs once (see parquet.cpp).
    con.Query("DROP TABLE IF EXISTS _iso_raw");
    run_step("CREATE TEMP TABLE _iso_raw AS "
             "SELECT origin_idx, cluster_idx, step_cost, ST_MakeValid(geom) AS geom "
             "FROM (VALUES " + values.str() +
             ") v(origin_idx, cluster_idx, step_cost, geom)", "isoline repair");

    std::string source_table = "_iso_raw";
    if (cfg.polygon_difference)
    {
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

    std::ostringstream sql;
    sql << "SELECT CAST(json_object("
        << "  'type', 'FeatureCollection', "
        << "  'features', COALESCE(json_group_array(feature), CAST('[]' AS JSON))"
        << ") AS VARCHAR) "
        << "FROM ("
        << "  SELECT json_object("
        << "    'type', 'Feature', "
        << "    'geometry', CAST(ST_AsGeoJSON(geom) AS JSON), "
        << "    'properties', json_object('step_cost', step_cost, "
        << "                               'origin_idx', origin_idx)"
        << "  ) AS feature "
        << "  FROM ("
        << "    SELECT origin_idx, cluster_idx, step_cost, "
        << "      CASE WHEN ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON') THEN geom "
        << "           WHEN ST_GeometryType(geom) = 'GEOMETRYCOLLECTION' "
        << "             THEN ST_CollectionExtract(geom, 3) "
        << "           ELSE NULL END AS geom "
        << "    FROM " << source_table
        << "  ) sub "
        << "  WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) "
        << "  ORDER BY origin_idx, cluster_idx, step_cost"
        << ") t";

    auto result = con.Query(sql.str());
    if (result->HasError())
        throw std::runtime_error("Grid contour GeoJSON failed: " + result->GetError());
    if (result->RowCount() == 0 || result->GetValue(0, 0).IsNull())
        return empty_feature_collection();
    return result->GetValue(0, 0).GetValue<std::string>();
}

namespace
{

std::string build_grid_contour_geojson(
    std::vector<ReachabilityField> const &fields,
    RequestConfig const &cfg,
    duckdb::Connection &con)
{
    auto const cutoffs = compute_step_cutoffs(cfg);
    int const zoom = geometry::grid_zoom_for_mode(cfg.mode);
    std::vector<TaggedFeature> all_features;
    for (size_t oi = 0; oi < fields.size(); ++oi)
        append_field_grid_features(all_features, fields[oi],
                                   static_cast<int32_t>(oi), zoom, cutoffs, cfg);
    return build_grid_contour_geojson_from_features(all_features, cfg, con);
}

} // namespace

std::string build_geojson_output(std::vector<ReachabilityField> const &fields,
                                 RequestConfig const &cfg,
                                 duckdb::Connection &con)
{
    if (fields.empty())
        return empty_feature_collection();
    auto const &field = fields[0]; // non-polygon branches use a single field

    switch (cfg.catchment_type)
    {
    case CatchmentType::Network:
    {
        auto const feature_count = materialize_network_features_table(field, cfg, con);
        if (feature_count == 0)
        {
            return empty_feature_collection();
        }
        return build_network_geojson(con);
    }
    case CatchmentType::Polygon:
    {
        // Active mobility and PT use grid contour (marching squares) for
        // tighter, network-faithful polygons. Car uses concave hull.
        if (cfg.mode != RoutingMode::Car)
        {
            return build_grid_contour_geojson(fields, cfg, con);
        }
        auto const feature_count = materialize_polygon_features_table(fields, cfg, con);
        if (feature_count == 0)
        {
            return empty_feature_collection();
        }
        return build_polygon_geojson(con);
    }
    case CatchmentType::HexagonalGrid:
    {
        auto const feature_count = materialize_hexagon_features_table(field, cfg, con);
        if (feature_count == 0)
        {
            return empty_feature_collection();
        }
        return build_hexagon_geojson(con);
    }
    case CatchmentType::PointGrid:
    {
        auto const feature_count = materialize_point_grid_features_table(field, cfg, con);
        if (feature_count == 0)
        {
            return empty_feature_collection();
        }
        return build_point_grid_geojson(con);
    }
    default:
        return empty_feature_collection();
    }
}

} // namespace routing::output
