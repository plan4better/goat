#pragma once

#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace routing
{

    struct Point3857
    {
        double x;
        double y;
    };

    struct Edge
    {
        int64_t id;
        int64_t source;
        int64_t target;
        double length_m;
        double length_3857;
        double cost;
        double reverse_cost;
        double impedance_slope;
        double impedance_slope_reverse;
        float impedance_surface;
        int16_t maxspeed_forward;
        int16_t maxspeed_backward;
        std::string class_;
        Point3857 source_coord;
        Point3857 target_coord;
        std::vector<Point3857> geometry;
    };

    enum class RoutingMode : uint8_t
    {
        Walking,
        Bicycle,
        Pedelec,
        Car,
        PublicTransport,
    };

    enum class CostType : uint8_t
    {
        Time,
        Distance,
    };

    enum class CatchmentType : uint8_t
    {
        Polygon,
        Network,
        HexagonalGrid,
        PointGrid,
    };

    enum class OutputFormat : uint8_t
    {
        GeoJSON,
        Parquet,
    };

    enum class ShapeStyle : uint8_t
    {
        Combined,
        Separated,
    };

    struct RequestConfig
    {
        std::vector<Point3857> starting_points;
        RoutingMode mode;
        CostType cost_type;
        double max_cost;   // budget: minutes (time) or meters (distance)
        int steps;
        double speed_km_h;
        std::string edge_dir;
        std::string node_dir;
        std::string timetable_path;  // nigiri binary (PT mode)
        std::string output_path;
        CatchmentType catchment_type = CatchmentType::Network;
        OutputFormat output_format = OutputFormat::GeoJSON;
        ShapeStyle shape_style = ShapeStyle::Combined;
        bool polygon_difference;
        int64_t departure_time = 0;  // unix minutes since epoch (PT mode)
        int max_transfers = 5;       // RAPTOR transfer limit (PT mode)

        double cost_budget() const noexcept { return max_cost; }

        // PT access/egress settings
        RoutingMode access_mode = RoutingMode::Walking;
        RoutingMode egress_mode = RoutingMode::Walking;
        CostType access_cost_type = CostType::Time;
        CostType egress_cost_type = CostType::Time;
        double access_max_cost = 0.0;      // 0 → use default (15 min / 500 m)
        double egress_max_cost = 0.0;      // 0 → use default (15 min / 500 m)
        double access_speed_km_h = 0.0;    // 0 → falls back to speed_km_h (time cost type only)
        double egress_speed_km_h = 0.0;    // 0 → falls back to speed_km_h (time cost type only)
        double transfer_cost = 2.0;        // minutes added at access→transit and transit→egress transitions

        // PT transit mode filter (empty → all modes allowed)
        std::vector<std::string> transit_modes;

        // Number of minutes to sweep around departure_time (0 → single departure).
        // Runs RAPTOR for each minute in [departure_time, departure_time + window)
        // and keeps the best (minimum) arrival cost per destination stop.
        int departure_window = 0;

        // PointGrid: path to parquet file with grid points (id, x_3857, y_3857)
        std::string grid_points_path;
        // PointGrid: max snapping distance in meters (0 → default 500m)
        double grid_snap_distance = 0.0;

        // Explicit output step thresholds (empty → derive from max_cost / steps)
        std::vector<int> cutoffs;
    };

    struct MatrixConfig
    {
        std::vector<Point3857> origins;
        std::vector<Point3857> destinations;
        std::vector<std::string> origin_ids;      // passthrough IDs (empty → 0-based index)
        std::vector<std::string> destination_ids;  // passthrough IDs (empty → 0-based index)
        RoutingMode mode;
        CostType cost_type;
        double max_cost;       // budget: minutes (time) or meters (distance)
        double speed_km_h;
        std::string edge_dir;
        std::string node_dir;      // explicit node dir (empty = infer from edge_dir)
        std::string output_path;   // parquet output

        // PT settings (only used when mode == PublicTransport)
        std::string timetable_path;
        int64_t departure_time = 0;    // unix minutes since epoch
        int max_transfers = 5;
        int departure_window = 0;
        std::vector<std::string> transit_modes;
        RoutingMode access_mode = RoutingMode::Walking;
        RoutingMode egress_mode = RoutingMode::Walking;
        CostType access_cost_type = CostType::Time;
        CostType egress_cost_type = CostType::Time;
        double access_max_cost = 0.0;
        double egress_max_cost = 0.0;
        double access_speed_km_h = 0.0;
        double egress_speed_km_h = 0.0;
        double transfer_cost = 2.0;

        // Reverse mode (street only): seed the search from the destination side
        // on the transposed graph, so cost[origin->destination] is recovered
        // while running one Dijkstra per destination. Output schema unchanged.
        // (Reverse PT is served by compute_od_costs, not here.)
        bool reverse = false;
        bool sparse = false;  // emit only reachable pairs
    };

    struct MatrixEntry
    {
        int32_t origin_id;
        int32_t destination_id;
        double cost;  // minutes or meters, +inf if unreachable
    };

    enum class HeatmapType : uint8_t
    {
        Gravity,         // sum_j weight_j × decay(cost_ij)
        ClosestAverage,  // mean cost of the K closest reachable opportunities
        Connectivity,    // sum of H3 cell areas reachable to each opportunity
        TwoSFCA,         // two-step floating catchment area (supply vs demand)
    };

    enum class GravityDecay : uint8_t
    {
        Gaussian,     // exp(-(cost/max_cost)^2 × max_sensitivity/sensitivity)
        Exponential,  // exp(-(sensitivity/max_sensitivity) × cost/max_cost)
        Linear,       // max(0, 1 - cost/max_cost)
        Power,        // (cost/max_cost)^(-sensitivity/max_sensitivity)
        Cumulative,   // 1 if cost <= max_cost else 0
    };

    enum class TwoSFCAType : uint8_t
    {
        Standard,  // binary catchment (W = 1 in both steps)
        E2SFCA,    // enhanced: decay-weight demand (step 1) and ratio (step 2)
        M2SFCA,    // modified: step-2 weight squared
    };

    struct Opportunity
    {
        std::vector<Point3857> seeds;  // >=1 network seeds; polygon → cell centroids
        double weight = 1.0;  // gravity potential / connectivity contribution
        Point3857 rep;        // representative point (centroid) for opp_meta
    };

    struct HeatmapConfig
    {
        // Pre-extracted opportunity points + weights.
        std::vector<Opportunity> opportunities;

        // Routing
        RoutingMode mode = RoutingMode::Walking;
        CostType cost_type = CostType::Time;
        double max_cost = 15.0;     // minutes (time) or meters (distance)
        double speed_km_h = 5.0;
        std::string edge_dir;
        std::string node_dir;       // empty → inferred from edge_dir
        // Street modes: reference-area cell centroids (EPSG:3857). When set,
        // the network loads over their area instead of around the
        // opportunities, and each is snapped in (500 m, as connectivity's
        // origins) so a cell without a street gets its cost via the nearest
        // one. Lets ClosestAverage run with an unlimited (+inf) max_cost.
        std::vector<Point3857> area_cell_centroids;

        // Formula
        HeatmapType heatmap_type = HeatmapType::Gravity;
        GravityDecay decay = GravityDecay::Gaussian;
        // Caller-visible sensitivity; max_sensitivity is the normalization
        // anchor (same convention as goatlib gravity tool — default 1e6).
        double sensitivity = 300000.0;
        double max_sensitivity = 1000000.0;
        int closest_k = 3;          // ClosestAverage only

        // --- 2SFCA (heatmap_type == TwoSFCA) ---
        TwoSFCAType two_sfca_type = TwoSFCAType::Standard;
        // Per-cell demand parquet (cell BIGINT, demand DOUBLE), rasterized
        // caller-side from the demand layer at the output H3 resolution.
        std::string demand_path;

        // --- PT heatmap (mode == PublicTransport) ---
        // Reverse (arrive-by) RAPTOR + precomputed access/egress lookup tables.
        std::string timetable_path;
        int64_t arrival_time = 0;       // unix minutes since epoch (arrive-by)
        int max_transfers = 5;
        std::vector<std::string> transit_modes;
        // Access (home→boarding stop) and egress (alighting stop→opp) legs:
        // each a routing mode whose precomputed
        // (stop_idx, h3_index, cost_minutes) lookup table is loaded from the
        // given parquet and capped at the given minutes (≤ the table's max).
        RoutingMode access_mode = RoutingMode::Walking;
        RoutingMode egress_mode = RoutingMode::Walking;
        int access_max_time = 20;       // minutes
        int egress_max_time = 20;       // minutes
        // Penalty (minutes) added at the access→transit and transit→egress
        // boundaries, matching the catchment PT pipeline (RequestConfig).
        double transfer_cost = 2.0;
        std::string access_table_path;  // accessegress parquet for access_mode
        std::string egress_table_path;  // accessegress parquet for egress_mode

        // PT connectivity only: H3 resolution of the output cells, which MUST
        // equal the resolution the caller rasterized the AOI opportunities at
        // (they are the same cells). The egress lookup runs at res-9, so the
        // res-9 group cell is rolled up to this parent resolution for the
        // output. Single source of truth lives caller-side; keep in sync.
        // Default matches the caller-side fallback (finest = egress-lookup res).
        int connectivity_output_resolution = 9;

        // Output
        std::string output_path;    // parquet: (h3_index BIGINT, score DOUBLE)
    };

    struct MatrixResult
    {
        std::vector<MatrixEntry> entries;
        std::vector<double> destination_min_cost; // per destination: best cost from any origin
    };

    struct AdjEntry
    {
        int32_t target;
        double cost;
    };

    // Lightweight per-edge info retained after compaction for output phase.
    struct EdgeInfo
    {
        int64_t id;
        std::vector<Point3857> geometry; // populated for jsolines only
    };

    struct SubNetwork
    {
        std::vector<EdgeInfo> edges;
        std::vector<int32_t> source;
        std::vector<int32_t> target;
        std::vector<double> cost;
        std::vector<double> reverse_cost;
        std::vector<double> length_3857;
        std::vector<Point3857> node_coords;
        int32_t node_count;
    };

    struct ReachabilityField
    {
        std::vector<double> costs;
        int32_t node_count;
        std::shared_ptr<SubNetwork const> network;
    };

} // namespace routing
