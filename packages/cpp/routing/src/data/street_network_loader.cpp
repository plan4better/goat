#include "street_network_loader.h"
#include "h3_util.h"

#include "../output/sql_export.h"

#include <cmath>
#include <cstdlib>
#include <duckdb.hpp>
#include <filesystem>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace routing::data
{

    using routing::output::sql_escape;

    static bool is_glob_or_file_path(std::string const &path)
    {
        if (path.find('*') != std::string::npos ||
            path.find('?') != std::string::npos)
        {
            return true;
        }
        auto pos = path.rfind(".parquet");
        return pos != std::string::npos && pos + 8 == path.size();
    }

    static std::string parquet_scan_relation(std::string const &edge_dir)
    {
        std::string escaped = sql_escape(edge_dir);
        std::ostringstream rel;
        if (is_glob_or_file_path(edge_dir))
        {
            rel << "read_parquet('" << escaped << "', hive_partitioning=true)";
            return rel.str();
        }

        // Use a recursive glob so flat and partitioned layouts are both matched.
        rel << "read_parquet('"
            << escaped << "/**/*.parquet', hive_partitioning=true)";
        return rel.str();
    }

    static std::string node_scan_relation(std::string const &node_dir)
    {
        std::string escaped = sql_escape(node_dir);
        std::ostringstream rel;
        // Same handling as the edge scan: a caller may name one parquet file
        // rather than a directory. Without this, a bundle artifact would have to
        // put its two files in separate subdirectories, since globbing a single
        // directory holding both would union their schemas.
        if (is_glob_or_file_path(node_dir))
        {
            rel << "read_parquet('" << escaped << "', hive_partitioning=true)";
            return rel.str();
        }
        rel << "read_parquet('" << escaped << "/**/*.parquet', hive_partitioning=true)";
        return rel.str();
    }

    static std::string sql_in_list(std::vector<std::string> const &vals)
    {
        std::ostringstream ss;
        ss << "(";
        for (size_t i = 0; i < vals.size(); ++i)
        {
            if (i)
                ss << ",";
            ss << "'" << vals[i] << "'";
        }
        ss << ")";
        return ss.str();
    }

    static std::string sql_int_list(std::vector<int32_t> const &vals)
    {
        std::ostringstream ss;
        ss << "(";
        for (size_t i = 0; i < vals.size(); ++i)
        {
            if (i)
                ss << ",";
            ss << vals[i];
        }
        ss << ")";
        return ss.str();
    }

    static std::vector<Edge> load_edges_impl(
        duckdb::Connection &con,
        std::string const &edge_dir,
        std::string const &node_dir,
        SpatialFilter const &filter,
        std::vector<std::string> const &valid_classes,
        RoutingMode mode,
        bool load_geometry)
    {
        auto const &h3_3_cells = filter.h3_3_cells;
        auto const &h3_6_cells = filter.h3_6_cells;

        std::vector<Edge> edges;

        std::string parquet_scan = parquet_scan_relation(edge_dir);
        std::string node_scan = node_scan_relation(node_dir);

        bool has_node_x_3857 = false;
        bool has_node_y_3857 = false;
        bool has_node_h3_3 = false;
        bool has_node_h3_6 = false;
        auto node_schema = con.Query("DESCRIBE SELECT * FROM " + node_scan + " LIMIT 0");
        if (node_schema->HasError())
        {
            throw std::runtime_error(
                "Failed to read node dataset schema: " + node_schema->GetError());
        }
        for (size_t row = 0; row < node_schema->RowCount(); ++row)
        {
            auto col_name = node_schema->GetValue(0, row).GetValue<std::string>();
            if (col_name == "x_3857")
            {
                has_node_x_3857 = true;
            }
            else if (col_name == "y_3857")
            {
                has_node_y_3857 = true;
            }
            else if (col_name == "h3_3")
            {
                has_node_h3_3 = true;
            }
            else if (col_name == "h3_6")
            {
                has_node_h3_6 = true;
            }
        }

        // The H3 columns exist to prune a hive-partitioned dataset. An uploaded
        // street network omits them, so every reference to them has to be
        // conditional, and the bbox below narrows those datasets instead.
        bool has_edge_h3_3 = false;
        bool has_edge_h3_6 = false;
        auto edge_schema =
            con.Query("DESCRIBE SELECT * FROM " + parquet_scan + " LIMIT 0");
        if (edge_schema->HasError())
        {
            throw std::runtime_error(
                "Failed to read edge dataset schema: " + edge_schema->GetError());
        }
        for (size_t row = 0; row < edge_schema->RowCount(); ++row)
        {
            auto col_name = edge_schema->GetValue(0, row).GetValue<std::string>();
            if (col_name == "h3_3")
            {
                has_edge_h3_3 = true;
            }
            else if (col_name == "h3_6")
            {
                has_edge_h3_6 = true;
            }
        }

        std::string node_x_expr;
        std::string node_y_expr;
        if (has_node_x_3857 && has_node_y_3857)
        {
            node_x_expr = "TRY_CAST(x_3857 AS DOUBLE)";
            node_y_expr = "TRY_CAST(y_3857 AS DOUBLE)";
        }
        else
        {
            // Fallback for existing node dumps that only contain HEXEWKB geom.
            node_x_expr = "ST_X(ST_GeomFromHEXEWKB(geom)) * PI()/180.0 * 6378137.0";
            node_y_expr = "LN(TAN(PI()/4.0 + ST_Y(ST_GeomFromHEXEWKB(geom)) * PI()/360.0)) * 6378137.0";
        }

        // Without H3 columns there is nothing to prune on, so narrow by the
        // query's bbox instead: a node reachable from a starting point cannot lie
        // outside it. Comparing the stored columns rather than the projected
        // aliases lets DuckDB skip row groups on their statistics.
        std::string node_bbox_predicate;
        if (filter.bbox)
        {
            bool const stored = has_node_x_3857 && has_node_y_3857;
            auto const &b = *filter.bbox;
            std::ostringstream pred;
            pred << std::setprecision(17)
                 << (stored ? "x_3857" : node_x_expr)
                 << " BETWEEN " << b.min_x << " AND " << b.max_x << " AND "
                 << (stored ? "y_3857" : node_y_expr)
                 << " BETWEEN " << b.min_y << " AND " << b.max_y;
            node_bbox_predicate = pred.str();
        }

        std::ostringstream sql;
        sql << "WITH node_coords AS ("
            << "  SELECT "
            << "    TRY_CAST(id AS BIGINT) AS node_id, "
            << "    " << node_x_expr << " AS x_3857, "
            << "    " << node_y_expr << " AS y_3857 "
            << "  FROM " << node_scan;
        if (has_node_h3_3 && !h3_3_cells.empty())
        {
            sql << " WHERE h3_3 IN " << sql_int_list(h3_3_cells);
            if (has_node_h3_6 && !h3_6_cells.empty())
            {
                sql << " AND h3_6 IN " << sql_int_list(h3_6_cells);
            }
        }
        else if (has_node_h3_6 && !h3_6_cells.empty())
        {
            sql << " WHERE h3_6 IN " << sql_int_list(h3_6_cells);
        }
        else if (!node_bbox_predicate.empty())
        {
            sql << " WHERE " << node_bbox_predicate;
        }
        sql
            << ") "
            // h3_3/h3_6 are deliberately not selected: they are pruning keys, and
            // nothing downstream reads the values.
            << "SELECT e.id, e.source, e.target, e.length_m, e.length_3857, "
            << "class_, impedance_slope, impedance_slope_reverse, "
            << "impedance_surface, maxspeed_forward, maxspeed_backward, "
            << (load_geometry ? "coordinates_3857, " : "")
            << "src_nodes.x_3857 AS source_x, "
            << "src_nodes.y_3857 AS source_y, "
            << "dst_nodes.x_3857 AS target_x, "
            << "dst_nodes.y_3857 AS target_y "
            << "FROM " << parquet_scan << " e "
            << "JOIN node_coords src_nodes ON src_nodes.node_id = e.source "
            << "JOIN node_coords dst_nodes ON dst_nodes.node_id = e.target "
            << "WHERE class_ IN " << sql_in_list(valid_classes);

        if (has_edge_h3_3 && !h3_3_cells.empty())
            sql << " AND h3_3 IN " << sql_int_list(h3_3_cells);
        if (has_edge_h3_6 && !h3_6_cells.empty())
            sql << " AND h3_6 IN " << sql_int_list(h3_6_cells);

        // For active mobility, filter primary roads by speed limit
        if (mode != RoutingMode::Car)
        {
            sql << " AND (class_ != 'primary' OR "
                << "(maxspeed_forward IS NOT NULL AND maxspeed_forward <= 50) OR "
                << "(maxspeed_backward IS NOT NULL AND maxspeed_backward <= 50))";
        }

        auto result = con.Query(sql.str());
        if (result->HasError())
        {
            throw std::runtime_error("DuckDB query failed: " +
                                     result->GetError());
        }

        edges.reserve(result->RowCount());
        while (true)
        {
            auto chunk = result->Fetch();
            if (!chunk || chunk->size() == 0)
            {
                break;
            }

            auto const count = chunk->size();
            duckdb::UnifiedVectorFormat id_vec;
            duckdb::UnifiedVectorFormat source_vec;
            duckdb::UnifiedVectorFormat target_vec;
            duckdb::UnifiedVectorFormat length_m_vec;
            duckdb::UnifiedVectorFormat length_3857_vec;
            duckdb::UnifiedVectorFormat class_vec;
            duckdb::UnifiedVectorFormat slope_vec;
            duckdb::UnifiedVectorFormat slope_reverse_vec;
            duckdb::UnifiedVectorFormat surface_vec;
            duckdb::UnifiedVectorFormat speed_fwd_vec;
            duckdb::UnifiedVectorFormat speed_back_vec;
            duckdb::UnifiedVectorFormat source_x_vec;
            duckdb::UnifiedVectorFormat source_y_vec;
            duckdb::UnifiedVectorFormat target_x_vec;
            duckdb::UnifiedVectorFormat target_y_vec;

            chunk->data[0].ToUnifiedFormat(count, id_vec);
            chunk->data[1].ToUnifiedFormat(count, source_vec);
            chunk->data[2].ToUnifiedFormat(count, target_vec);
            chunk->data[3].ToUnifiedFormat(count, length_m_vec);
            chunk->data[4].ToUnifiedFormat(count, length_3857_vec);
            chunk->data[5].ToUnifiedFormat(count, class_vec);
            chunk->data[6].ToUnifiedFormat(count, slope_vec);
            chunk->data[7].ToUnifiedFormat(count, slope_reverse_vec);
            chunk->data[8].ToUnifiedFormat(count, surface_vec);
            chunk->data[9].ToUnifiedFormat(count, speed_fwd_vec);
            chunk->data[10].ToUnifiedFormat(count, speed_back_vec);
            // coordinates_3857 occupies column 11 when requested, shifting the
            // node coordinates that follow it.
            int col_offset = load_geometry ? 1 : 0;
            chunk->data[11 + col_offset].ToUnifiedFormat(count, source_x_vec);
            chunk->data[12 + col_offset].ToUnifiedFormat(count, source_y_vec);
            chunk->data[13 + col_offset].ToUnifiedFormat(count, target_x_vec);
            chunk->data[14 + col_offset].ToUnifiedFormat(count, target_y_vec);

            auto const *id_data = reinterpret_cast<int64_t const *>(id_vec.data);
            auto const *source_data = reinterpret_cast<int64_t const *>(source_vec.data);
            auto const *target_data = reinterpret_cast<int64_t const *>(target_vec.data);
            auto const *length_m_data = reinterpret_cast<double const *>(length_m_vec.data);
            auto const *length_3857_data = reinterpret_cast<double const *>(length_3857_vec.data);
            auto const *class_data = reinterpret_cast<duckdb::string_t const *>(class_vec.data);
            auto const *slope_data = reinterpret_cast<double const *>(slope_vec.data);
            auto const *slope_reverse_data = reinterpret_cast<double const *>(slope_reverse_vec.data);
            auto const *surface_data = reinterpret_cast<float const *>(surface_vec.data);
            auto const *speed_fwd_data = reinterpret_cast<int16_t const *>(speed_fwd_vec.data);
            auto const *speed_back_data = reinterpret_cast<int16_t const *>(speed_back_vec.data);
            auto const *source_x_data = reinterpret_cast<double const *>(source_x_vec.data);
            auto const *source_y_data = reinterpret_cast<double const *>(source_y_vec.data);
            auto const *target_x_data = reinterpret_cast<double const *>(target_x_vec.data);
            auto const *target_y_data = reinterpret_cast<double const *>(target_y_vec.data);

            for (duckdb::idx_t i = 0; i < count; ++i)
            {
                auto rid_id = id_vec.sel->get_index(i);
                auto rid_source = source_vec.sel->get_index(i);
                auto rid_target = target_vec.sel->get_index(i);
                auto rid_length_m = length_m_vec.sel->get_index(i);
                auto rid_length_3857 = length_3857_vec.sel->get_index(i);
                auto rid_class = class_vec.sel->get_index(i);
                auto rid_slope = slope_vec.sel->get_index(i);
                auto rid_slope_reverse = slope_reverse_vec.sel->get_index(i);
                auto rid_surface = surface_vec.sel->get_index(i);
                auto rid_speed_fwd = speed_fwd_vec.sel->get_index(i);
                auto rid_speed_back = speed_back_vec.sel->get_index(i);
                auto rid_source_x = source_x_vec.sel->get_index(i);
                auto rid_source_y = source_y_vec.sel->get_index(i);
                auto rid_target_x = target_x_vec.sel->get_index(i);
                auto rid_target_y = target_y_vec.sel->get_index(i);

                // An unmeasurable edge is dropped rather than loaded: every
                // cost derived from a non-finite length is non-finite too, and
                // NaN never compares true, so such an edge cannot be traversed
                // anyway — it would only spread NaN through the graph.
                if (!length_m_vec.validity.RowIsValid(rid_length_m) ||
                    !length_3857_vec.validity.RowIsValid(rid_length_3857) ||
                    !std::isfinite(length_m_data[rid_length_m]) ||
                    !std::isfinite(length_3857_data[rid_length_3857]))
                    continue;

                Edge e;
                e.id = id_data[rid_id];
                e.source = source_data[rid_source];
                e.target = target_data[rid_target];
                e.length_m = length_m_data[rid_length_m];
                e.length_3857 = length_3857_data[rid_length_3857];
                e.class_ = class_data[rid_class].GetString();
                e.impedance_slope = slope_vec.validity.RowIsValid(rid_slope)
                                        ? slope_data[rid_slope]
                                        : 0.0;
                e.impedance_slope_reverse = slope_reverse_vec.validity.RowIsValid(rid_slope_reverse)
                                                ? slope_reverse_data[rid_slope_reverse]
                                                : 0.0;
                e.impedance_surface = surface_vec.validity.RowIsValid(rid_surface)
                                         ? surface_data[rid_surface]
                                         : 0.0f;
                e.maxspeed_forward = speed_fwd_vec.validity.RowIsValid(rid_speed_fwd)
                                        ? speed_fwd_data[rid_speed_fwd]
                                        : static_cast<int16_t>(0);
                e.maxspeed_backward = speed_back_vec.validity.RowIsValid(rid_speed_back)
                                         ? speed_back_data[rid_speed_back]
                                         : static_cast<int16_t>(0);
                e.source_coord = {source_x_data[rid_source_x], source_y_data[rid_source_y]};
                e.target_coord = {target_x_data[rid_target_x], target_y_data[rid_target_y]};

                // Parse geometry for active mobility (column 11 when present)
                if (load_geometry)
                {
                    auto geom_val = chunk->GetValue(11, i);
                    if (!geom_val.IsNull())
                    {
                        auto &coord_list = duckdb::ListValue::GetChildren(geom_val);
                        e.geometry.reserve(coord_list.size());
                        for (auto &pt_val : coord_list)
                        {
                            auto &pt = duckdb::ListValue::GetChildren(pt_val);
                            if (pt.size() < 2 || pt[0].IsNull() || pt[1].IsNull())
                                continue;
                            // A single unusable vertex must not fail every
                            // route on the network. GetValue on a NULL raises
                            // a DuckDB internal error naming neither the edge
                            // nor the column, and non-finite ordinates poison
                            // every cost computed from the geometry.
                            auto const x = pt[0].GetValue<double>();
                            auto const y = pt[1].GetValue<double>();
                            if (!std::isfinite(x) || !std::isfinite(y))
                                continue;
                            e.geometry.push_back({x, y});
                        }
                    }
                }
                if (e.geometry.size() < 2)
                    e.geometry = {e.source_coord, e.target_coord};

                e.cost = 0.0;
                e.reverse_cost = 0.0;
                edges.push_back(std::move(e));
            }
        }

        return edges;
    }


    std::vector<Edge> load_edges(
        duckdb::Connection &con,
        std::string const &edge_dir,
        std::string const &node_dir,
        std::vector<Point3857> const &starting_points,
        double buffer_meters,
        std::vector<std::string> const &valid_classes,
        RoutingMode mode,
        bool load_geometry)
    {
        auto filter = compute_spatial_filter(con, starting_points, buffer_meters);
        return load_edges_impl(con, edge_dir, node_dir, filter,
                               valid_classes, mode, load_geometry);
    }

    std::vector<Edge> load_edges(
        duckdb::Connection &con,
        std::string const &edge_dir,
        std::string const &node_dir,
        SpatialFilter const &filter,
        std::vector<std::string> const &valid_classes,
        RoutingMode mode,
        bool load_geometry)
    {
        return load_edges_impl(con, edge_dir, node_dir, filter,
                               valid_classes, mode, load_geometry);
    }

} // namespace routing::data
