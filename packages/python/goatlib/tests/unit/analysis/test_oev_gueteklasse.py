"""Tests for OevGueteklasseTool (ÖV-Güteklassen / Public Transport Quality Classes)."""

from pathlib import Path

import duckdb
import pytest
from goatlib.analysis.accessibility import (
    STATION_CONFIG_DEFAULT,
    OevGueteklasseParams,
    OevGueteklasseStationConfig,
    OevGueteklasseTool,
    PTTimeWindow,
)
from goatlib.analysis.schemas.oev_gueteklasse import CatchmentType

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def test_data_dir() -> Path:
    """Return the test data directory."""
    # Test data is at /app/packages/python/goatlib/tests/data/analysis
    return Path(__file__).parent.parent.parent / "data" / "analysis"


@pytest.fixture
def gtfs_data_dir() -> Path:
    """Return the GTFS data directory."""
    # Data is at /app/data/gtfs (root data folder)
    return (
        Path(__file__).parent.parent.parent.parent.parent.parent.parent
        / "data"
        / "gtfs"
    )


@pytest.fixture
def result_dir() -> Path:
    """Return the result directory for test outputs."""
    # Use global test result folder at /app/packages/python/goatlib/tests/result/
    result_path = Path(__file__).parent.parent.parent / "result"
    result_path.mkdir(parents=True, exist_ok=True)
    return result_path


@pytest.fixture
def munich_districts_path(test_data_dir: Path) -> Path:
    """Return path to Munich districts geojson."""
    return test_data_dir / "munich_districts.geojson"


@pytest.fixture
def stops_path(gtfs_data_dir: Path) -> Path:
    """Return path to GTFS stops parquet."""
    path = gtfs_data_dir / "stops.parquet"
    if not path.exists():
        pytest.skip(f"GTFS stops file not found: {path}")
    return path


@pytest.fixture
def stop_times_path(gtfs_data_dir: Path) -> Path:
    """Return path to GTFS stop_times parquet."""
    path = gtfs_data_dir / "stop_times_optimized.parquet"
    if not path.exists():
        pytest.skip(f"GTFS stop_times file not found: {path}")
    return path


@pytest.fixture
def time_window_weekday() -> PTTimeWindow:
    """Return a typical weekday morning time window (7:00-9:00)."""
    return PTTimeWindow(
        weekday="weekday",
        from_time=25200,  # 7:00
        to_time=32400,  # 9:00
    )


@pytest.fixture
def time_window_saturday() -> PTTimeWindow:
    """Return a Saturday morning time window (7:00-9:00)."""
    return PTTimeWindow(
        weekday="saturday",
        from_time=25200,  # 7:00
        to_time=32400,  # 9:00
    )


# =============================================================================
# Unit Tests - PTTimeWindow
# =============================================================================


class TestPTTimeWindow:
    """Tests for PTTimeWindow schema."""

    def test_weekday_column_mapping(self):
        """Test weekday column name mapping."""
        assert (
            PTTimeWindow(weekday="weekday", from_time=0, to_time=3600).weekday_column
            == "is_weekday"
        )
        assert (
            PTTimeWindow(weekday="saturday", from_time=0, to_time=3600).weekday_column
            == "is_saturday"
        )
        assert (
            PTTimeWindow(weekday="sunday", from_time=0, to_time=3600).weekday_column
            == "is_sunday"
        )

    def test_time_string_conversion(self):
        """Test conversion of seconds to HH:MM:SS format."""
        tw = PTTimeWindow(weekday="weekday", from_time=25200, to_time=32400)
        assert tw.from_time_str == "07:00:00"
        assert tw.to_time_str == "09:00:00"

    def test_time_window_minutes(self):
        """Test calculation of time window in minutes."""
        tw = PTTimeWindow(weekday="weekday", from_time=25200, to_time=32400)
        assert tw.time_window_minutes == 120.0  # 2 hours

    def test_overflow_time(self):
        """Test handling of times > 24:00 (common in GTFS)."""
        tw = PTTimeWindow(
            weekday="weekday", from_time=86400, to_time=90000
        )  # 24:00 - 25:00
        assert tw.from_time_str == "24:00:00"
        assert tw.to_time_str == "25:00:00"


# =============================================================================
# Unit Tests - OevGueteklasseStationConfig
# =============================================================================


class TestOevGueteklasseStationConfig:
    """Tests for station configuration schema."""

    def test_default_config_structure(self):
        """Test that default config has all required fields."""
        config = STATION_CONFIG_DEFAULT
        assert len(config.groups) > 0
        assert len(config.time_frequency) == 6
        assert len(config.categories) == 6
        assert len(config.classification) > 0

    def test_default_config_groups(self):
        """Test default route type to group mapping."""
        config = STATION_CONFIG_DEFAULT
        # Rail types should be group A
        assert config.groups["2"] == "A"  # Rail
        assert config.groups["1"] == "A"  # Subway
        # Tram should be group B
        assert config.groups["0"] == "B"  # Tram
        # Bus should be group C
        assert config.groups["3"] == "C"  # Bus

    def test_default_config_time_frequency(self):
        """Test default time frequency thresholds."""
        config = STATION_CONFIG_DEFAULT
        assert config.time_frequency == [5, 10, 20, 40, 60, 120]

    def test_custom_config(self):
        """Test creating a custom configuration."""
        custom_config = OevGueteklasseStationConfig(
            groups={"3": "C"},  # Only bus
            time_frequency=[10, 30, 60],
            categories=[
                {"C": 1},
                {"C": 2},
                {"C": 3},
            ],
            classification={
                "1": {300: "1", 500: "2"},
                "2": {300: "2", 500: "3"},
                "3": {300: "3"},
            },
        )
        assert custom_config.groups["3"] == "C"
        assert len(custom_config.time_frequency) == 3

    def test_standard_route_type_mapping_expands_to_extended(self):
        """Standard GTFS route type mappings should auto-populate known extended route types."""
        custom_config = OevGueteklasseStationConfig(
            groups={"0": "B", "1": "A", "2": "A", "3": "C", "7": "B"},
            time_frequency=[10],
            categories=[{"A": 1, "B": 1, "C": 2}],
            classification={
                "1": {300: "1"},
                "2": {300: "2"},
            },
        )

        assert custom_config.groups["900"] == "B"
        assert custom_config.groups["901"] == "B"
        assert custom_config.groups["401"] == "A"
        assert custom_config.groups["100"] == "A"
        assert custom_config.groups["701"] == "C"
        assert custom_config.groups["1400"] == "B"

    def test_invalid_time_frequency_not_increasing(self):
        """Reject non-increasing time_frequency values."""
        with pytest.raises(
            ValueError, match="time_frequency must be strictly increasing"
        ):
            OevGueteklasseStationConfig(
                groups={"3": "C"},
                time_frequency=[10, 10, 30],
                categories=[{"C": 1}, {"C": 2}, {"C": 3}],
                classification={
                    "1": {300: "1"},
                    "2": {300: "2"},
                    "3": {300: "3"},
                },
            )

    def test_invalid_categories_length(self):
        """Reject config when category rows and thresholds have different length."""
        with pytest.raises(
            ValueError, match="categories length must match time_frequency length"
        ):
            OevGueteklasseStationConfig(
                groups={"3": "C"},
                time_frequency=[10, 30, 60],
                categories=[{"C": 1}, {"C": 2}],
                classification={
                    "1": {300: "1"},
                    "2": {300: "2"},
                },
            )

    def test_invalid_missing_classification_category(self):
        """Reject config when used station categories are missing in classification."""
        with pytest.raises(
            ValueError,
            match="classification is missing station categories used in categories",
        ):
            OevGueteklasseStationConfig(
                groups={"3": "C"},
                time_frequency=[10, 30],
                categories=[{"C": 1}, {"C": 2}],
                classification={
                    "1": {300: "1"},
                },
            )

    def test_invalid_classification_class_non_positive(self):
        """Reject PT classes that are not positive integer strings."""
        with pytest.raises(
            ValueError,
            match="classification PT class values must be positive integer strings",
        ):
            OevGueteklasseStationConfig(
                groups={"3": "C"},
                time_frequency=[10],
                categories=[{"C": 1}],
                classification={
                    "1": {300: "0"},
                },
            )

    def test_valid_classification_class_above_f(self):
        """Allow PT classes above 6 to support extended class letters beyond F."""
        config = OevGueteklasseStationConfig(
            groups={"3": "C"},
            time_frequency=[10],
            categories=[{"C": 1}],
            classification={
                "1": {300: "7"},
            },
        )
        assert config.classification["1"][300] == "7"


class TestOevGueteklasseFrequencyIntervals:
    """Tests for frequency-to-interval mapping behavior."""

    def test_frequency_equal_threshold_maps_to_matching_interval(self):
        """Frequency exactly on threshold should map to that threshold interval (<=)."""
        config = OevGueteklasseStationConfig(
            groups={"3": "C"},
            time_frequency=[5, 10, 20],
            categories=[
                {"C": 1},
                {"C": 2},
                {"C": 3},
            ],
            classification={
                "1": {300: "1"},
                "2": {300: "2"},
                "3": {300: "3"},
            },
        )
        time_window = PTTimeWindow(
            weekday="weekday",
            from_time=0,
            to_time=7200,
        )

        tool = OevGueteklasseTool()
        try:
            tool.con.execute("""
                CREATE OR REPLACE TABLE station_trip_counts AS
                SELECT
                    'stop_1' AS stop_id,
                    'Stop 1' AS stop_name,
                    NULL::VARCHAR AS parent_station,
                    48.1::DOUBLE AS stop_lat,
                    11.5::DOUBLE AS stop_lon,
                    ST_Point(11.5, 48.1) AS geom,
                    3::INTEGER AS route_type,
                    12::INTEGER AS trip_count
            """)
            tool.con.execute(
                "CREATE TABLE gtfs_stations "
                "(stop_id VARCHAR, stop_name VARCHAR, geom GEOMETRY)"
            )

            tool._calculate_station_categories(config, time_window)
            row = tool.con.execute("""
                SELECT time_interval, station_category, frequency_minutes
                FROM station_categories
                WHERE stop_id = 'stop_1'
            """).fetchone()

            assert row is not None
            time_interval, station_category, frequency_minutes = row
            assert frequency_minutes == pytest.approx(10.0)
            assert time_interval == 2
            assert station_category == 2
        finally:
            tool.cleanup()


# =============================================================================
# Integration Tests - OevGueteklasseTool
# =============================================================================


class TestOevGueteklasseTool:
    """Integration tests for OevGueteklasseTool."""

    def test_tool_initialization(self):
        """Test that the tool initializes correctly."""
        tool = OevGueteklasseTool()
        assert tool.con is not None
        tool.cleanup()

    def test_oev_gueteklasse_weekday(
        self,
        munich_districts_path: Path,
        stops_path: Path,
        stop_times_path: Path,
        time_window_weekday: PTTimeWindow,
        result_dir: Path,
    ):
        """Test ÖV-Güteklassen calculation for weekday morning."""
        output_path = result_dir / "unit_oev_gueteklasse_weekday.parquet"
        stations_output_path = (
            result_dir / "unit_oev_gueteklasse_weekday_stations.parquet"
        )

        params = OevGueteklasseParams(
            reference_area_path=str(munich_districts_path),
            stops_path=str(stops_path),
            stop_times_path=str(stop_times_path),
            time_window=time_window_weekday,
            output_path=str(output_path),
            stations_output_path=str(stations_output_path),
        )

        tool = OevGueteklasseTool()
        result = tool.run(params)

        # Verify results
        assert output_path.exists(), "Output file should exist"
        assert stations_output_path.exists(), "Stations output file should exist"
        assert result["total_stations"] > 0, "Should have found stations"
        assert result["stations_with_service"] > 0, "Should have stations with service"

        # Verify output structure
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM '{output_path}'").fetchdf()
        assert "pt_class" in df.columns
        assert "pt_class_label" in df.columns
        assert "geometry" in df.columns

        # pt_class should be 1-6
        assert df["pt_class"].min() >= 1
        assert df["pt_class"].max() <= 6

        # pt_class_label should be A-F
        valid_labels = {"A", "B", "C", "D", "E", "F"}
        assert set(df["pt_class_label"].unique()).issubset(valid_labels)

        # Verify geometries are POLYGON and valid (QGIS compatibility)
        geom_check = con.execute(f"""
            SELECT
                pt_class_label,
                ST_GeometryType(geometry) as geom_type,
                ST_IsValid(geometry) as is_valid
            FROM '{output_path}'
        """).fetchall()
        for label, geom_type, is_valid in geom_check:
            assert (
                geom_type == "POLYGON"
            ), f"Class {label} should be POLYGON, got {geom_type}"
            assert is_valid, f"Class {label} geometry should be valid"

        # Verify we have multiple polygons per class (exploded from multipolygons)
        polygon_counts = con.execute(f"""
            SELECT pt_class_label, COUNT(*) as cnt
            FROM '{output_path}'
            GROUP BY pt_class_label
        """).fetchall()
        for label, count in polygon_counts:
            assert count > 0, f"Class {label} should have at least one polygon"

        # Verify stations output
        stations_df = con.execute(f"SELECT * FROM '{stations_output_path}'").fetchdf()
        assert "stop_id" in stations_df.columns
        assert "station_category" in stations_df.columns
        assert "frequency_minutes" in stations_df.columns

        con.close()

        print("\n=== ÖV-Güteklassen Weekday Results ===")
        print(f"Total stations in area: {result['total_stations']}")
        print(f"Stations with service: {result['stations_with_service']}")
        print(f"Quality class distribution: {result['quality_class_counts']}")

    def test_oev_gueteklasse_network_catchment(
        self,
        munich_districts_path: Path,
        stops_path: Path,
        stop_times_path: Path,
        time_window_weekday: PTTimeWindow,
        result_dir: Path,
    ):
        """Walking the distances along the network serves less area than circles."""
        pytest.importorskip("routing")
        from goatlib.config.settings import settings

        if not Path(settings.routing.street_network_edges_base_path).exists():
            pytest.skip("Street network not found")

        areas: dict[str, dict[str, float]] = {}
        for catchment_type in (CatchmentType.buffer, CatchmentType.network):
            output_path = (
                result_dir / f"unit_oev_gueteklasse_{catchment_type.value}.parquet"
            )
            OevGueteklasseTool().run(
                OevGueteklasseParams(
                    reference_area_path=str(munich_districts_path),
                    stops_path=str(stops_path),
                    stop_times_path=str(stop_times_path),
                    time_window=time_window_weekday,
                    output_path=str(output_path),
                    catchment_type=catchment_type,
                )
            )
            con = duckdb.connect()
            con.execute("INSTALL spatial; LOAD spatial;")
            areas[catchment_type.value] = dict(
                con.execute(f"""
                    SELECT pt_class_label, SUM(ST_Area_Spheroid(geometry))
                    FROM '{output_path}'
                    GROUP BY pt_class_label
                """).fetchall()
            )
            invalid = con.execute(
                f"SELECT COUNT(*) FROM '{output_path}' WHERE NOT ST_IsValid(geometry)"
            ).fetchone()[0]
            con.close()
            assert invalid == 0

        # A single class can grow (a smaller A leaves more room for B), but
        # the area served at all shrinks.
        assert areas["network"], "Network catchments should produce classes"
        assert sum(areas["network"].values()) < sum(areas["buffer"].values())

    def test_oev_gueteklasse_saturday(
        self,
        munich_districts_path: Path,
        stops_path: Path,
        stop_times_path: Path,
        time_window_saturday: PTTimeWindow,
        result_dir: Path,
    ):
        """Test ÖV-Güteklassen calculation for Saturday morning."""
        output_path = result_dir / "unit_oev_gueteklasse_saturday.parquet"

        params = OevGueteklasseParams(
            reference_area_path=str(munich_districts_path),
            stops_path=str(stops_path),
            stop_times_path=str(stop_times_path),
            time_window=time_window_saturday,
            output_path=str(output_path),
        )

        tool = OevGueteklasseTool()
        result = tool.run(params)

        assert output_path.exists()
        assert result["total_stations"] > 0

        # Saturday should generally have fewer services than weekday
        print("\n=== ÖV-Güteklassen Saturday Results ===")
        print(f"Total stations in area: {result['total_stations']}")
        print(f"Stations with service: {result['stations_with_service']}")
        print(f"Quality class distribution: {result['quality_class_counts']}")

    def test_oev_gueteklasse_custom_config(
        self,
        munich_districts_path: Path,
        stops_path: Path,
        stop_times_path: Path,
        time_window_weekday: PTTimeWindow,
        result_dir: Path,
    ):
        """Test ÖV-Güteklassen with custom station configuration."""
        output_path = result_dir / "unit_oev_gueteklasse_custom.parquet"

        # Simplified config - only consider rail (type 2) and bus (type 3)
        custom_config = OevGueteklasseStationConfig(
            groups={
                "2": "A",  # Rail
                "100": "A",  # Railway
                "109": "A",  # S-Bahn
                "3": "C",  # Bus
                "700": "C",  # Bus service
            },
            time_frequency=[10, 20, 40, 60, 120, 180],
            categories=[
                {"A": 1, "C": 2},
                {"A": 2, "C": 3},
                {"A": 3, "C": 4},
                {"A": 4, "C": 5},
                {"A": 5, "C": 6},
                {"A": 6, "C": 7},
            ],
            classification={
                "1": {400: "1", 800: "2"},
                "2": {400: "2", 800: "3"},
                "3": {400: "3", 800: "4"},
                "4": {400: "4", 800: "5"},
                "5": {400: "5", 800: "6"},
                "6": {400: "6"},
                "7": {400: "6"},
            },
        )

        params = OevGueteklasseParams(
            reference_area_path=str(munich_districts_path),
            stops_path=str(stops_path),
            stop_times_path=str(stop_times_path),
            time_window=time_window_weekday,
            output_path=str(output_path),
            station_config=custom_config,
        )

        tool = OevGueteklasseTool()
        result = tool.run(params)

        assert output_path.exists()
        print("\n=== ÖV-Güteklassen Custom Config Results ===")
        print(f"Quality class distribution: {result['quality_class_counts']}")


# =============================================================================
# Edge Case Tests
# =============================================================================


class TestOevGueteklasseEdgeCases:
    """Edge case tests for OevGueteklasseTool."""

    def test_evening_time_window(
        self,
        munich_districts_path: Path,
        stops_path: Path,
        stop_times_path: Path,
        result_dir: Path,
    ):
        """Test with evening time window when services are less frequent."""
        output_path = result_dir / "unit_oev_gueteklasse_evening.parquet"

        time_window = PTTimeWindow(
            weekday="weekday",
            from_time=72000,  # 20:00
            to_time=79200,  # 22:00
        )

        params = OevGueteklasseParams(
            reference_area_path=str(munich_districts_path),
            stops_path=str(stops_path),
            stop_times_path=str(stop_times_path),
            time_window=time_window,
            output_path=str(output_path),
        )

        tool = OevGueteklasseTool()
        result = tool.run(params)

        assert output_path.exists()
        # Evening should have fewer high-quality classes
        print("\n=== ÖV-Güteklassen Evening Results ===")
        print(f"Quality class distribution: {result['quality_class_counts']}")
