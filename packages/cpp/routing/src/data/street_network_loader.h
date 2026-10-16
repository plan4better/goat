#pragma once

#include "../types.h"
#include "h3_util.h"

#include <cstdint>
#include <string>
#include <vector>

namespace duckdb
{
    class Connection;
}

namespace routing::data
{

    // Which optional Parquet columns to project. The caller decides (e.g.
    // walking with a positive weight); the loader only projects and never
    // interprets routing weights, so mode-specific rules stay caller-side.
    struct EdgeColumnSelection
    {
        bool need_shade = false;
        bool need_heat = false;
    };

    // Load edges from parquet files using DuckDB.
    // When load_geometry is true, coordinates_3857 is parsed into Edge::geometry.
    // `columns` selects which environmental impedance columns to read from
    // Parquet: they are only projected when requested, so standard routing
    // skips those column chunks entirely (pushdown).
    std::vector<Edge> load_edges(duckdb::Connection &con,
                                 std::string const &edge_dir,
                                 std::string const &node_dir,
                                 std::vector<Point3857> const &starting_points,
                                 double buffer_meters,
                                 std::vector<std::string> const &valid_classes,
                                 RoutingMode mode,
                                 bool load_geometry = false,
                                 EdgeColumnSelection columns = {});

    // Variant with a pre-computed spatial filter.
    std::vector<Edge> load_edges(duckdb::Connection &con,
                                 std::string const &edge_dir,
                                 std::string const &node_dir,
                                 SpatialFilter const &filter,
                                 std::vector<std::string> const &valid_classes,
                                 RoutingMode mode,
                                 bool load_geometry = false,
                                 EdgeColumnSelection columns = {});

} // namespace routing::data
