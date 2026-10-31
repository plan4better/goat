#pragma once

#include "../types.h"
#include "h3_util.h"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace duckdb
{
    class Connection;
}

namespace routing::data
{

    // Load edges from parquet files using DuckDB.
    // When load_geometry is true, coordinates_3857 is parsed into Edge::geometry.
    std::vector<Edge> load_edges(duckdb::Connection &con,
                                 std::string const &edge_dir,
                                 std::string const &node_dir,
                                 std::vector<Point3857> const &starting_points,
                                 double buffer_meters,
                                 std::vector<std::string> const &valid_classes,
                                 RoutingMode mode,
                                 bool load_geometry = false);

    // Variant with a pre-computed spatial filter.
    std::vector<Edge> load_edges(duckdb::Connection &con,
                                 std::string const &edge_dir,
                                 std::string const &node_dir,
                                 SpatialFilter const &filter,
                                 std::vector<std::string> const &valid_classes,
                                 RoutingMode mode,
                                 bool load_geometry = false);

    // coordinates_3857 of the given edges; edges without 2 usable points are absent.
    std::unordered_map<int64_t, std::vector<Point3857>> load_edge_geometry(
        duckdb::Connection &con,
        std::string const &edge_dir,
        SpatialFilter const &filter,
        std::vector<int64_t> const &edge_ids);

} // namespace routing::data
