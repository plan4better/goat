"""Tests for TripCountStationTool (Public Transport Trip Count per Station)."""

from collections.abc import Callable
from pathlib import Path

import duckdb
import pytest
from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.accessibility import (
    TRANSPORT_MODE_MAPPING,
    PTTimeWindow,
    TripCountStationParams,
    TripCountStationTool,
)
from goatlib.analysis.schemas.base import PTTimeWindow as BasePTTimeWindow
from goatlib.tools.style_contract import Expectation
from goatlib.tools.trip_count import TripCountToolParams, TripCountToolRunner

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def test_data_dir() -> Path:
    """Return the test data directory."""
    # Test data is at /app/packages/python/goatlib/tests/data/analysis
    return Path(__file__).parent.parent.parent / "data" / "analysis"


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


@pytest.fixture(scope="module")
def network_tables(tmp_path_factory: pytest.TempPathFactory) -> Callable[[str], dict]:
    """The analysis params' GTFS fields for a kind of day: the default network's
    tables, cut to the Munich districts on that kind of day's anchor date, as
    the tool cuts them. Skipped where no network with tables is installed."""
    from goatlib.analysis.pt_time import DEFAULT_NETWORK_ANCHORS
    from goatlib.bundles.importers.pt_network.store import tables_dir
    from goatlib.config.settings import settings
    from goatlib.tools.pt_network import cut_network_tables

    tables = tables_dir(settings.routing.pt_network_base_path)
    if not (tables / "info.json").is_file():
        pytest.skip(f"No PT network tables installed: {tables}")
    work = tmp_path_factory.mktemp("network_tables")
    area = work / "munich_districts.parquet"
    districts = (
        Path(__file__).parent.parent.parent / "data/analysis/munich_districts.geojson"
    )
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        f"COPY (SELECT * FROM ST_Read('{districts}')) TO '{area}' (FORMAT PARQUET)"
    )
    cuts: dict[str, dict] = {}

    def fields(kind: str) -> dict:
        if kind not in cuts:
            day = DEFAULT_NETWORK_ANCHORS[kind].isoformat()
            paths = cut_network_tables(tables, area, day, work / kind)
            cuts[kind] = {
                "stops_path": paths["stops"],
                "stop_times_path": paths["stop_times"],
                "trips_path": paths["trips"],
                "routes_path": paths["routes"],
                "calendar_dates_path": paths["calendar_dates"],
                "service_date": day,
            }
        return cuts[kind]

    return fields


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
# Unit Tests - PTTimeWindow (from base)
# =============================================================================


class TestPTTimeWindowBase:
    """Tests for PTTimeWindow schema from base module."""

    def test_weekday_column_mapping(self):
        """Test weekday column name mapping."""
        assert (
            BasePTTimeWindow(
                weekday="weekday", from_time=0, to_time=3600
            ).weekday_column
            == "is_weekday"
        )
        assert (
            BasePTTimeWindow(
                weekday="saturday", from_time=0, to_time=3600
            ).weekday_column
            == "is_saturday"
        )
        assert (
            BasePTTimeWindow(weekday="sunday", from_time=0, to_time=3600).weekday_column
            == "is_sunday"
        )

    def test_time_string_conversion(self):
        """Test conversion of seconds to HH:MM:SS format."""
        tw = BasePTTimeWindow(weekday="weekday", from_time=25200, to_time=32400)
        assert tw.from_time_str == "07:00:00"
        assert tw.to_time_str == "09:00:00"

    def test_time_window_minutes(self):
        """Test calculation of time window in minutes."""
        tw = BasePTTimeWindow(weekday="weekday", from_time=25200, to_time=32400)
        assert tw.time_window_minutes == 120.0  # 2 hours

    def test_overflow_time(self):
        """Test handling of times > 24:00 (common in GTFS)."""
        tw = BasePTTimeWindow(
            weekday="weekday", from_time=86400, to_time=90000
        )  # 24:00 - 25:00
        assert tw.from_time_str == "24:00:00"
        assert tw.to_time_str == "25:00:00"


# =============================================================================
# Unit Tests - Transport Mode Mapping
# =============================================================================


class TestTransportModeMapping:
    """Tests for transport mode mapping."""

    def test_bus_types(self):
        """Test bus route types are mapped correctly."""
        bus_types = ["3", "700", "704", "715", "800"]
        for rt in bus_types:
            assert (
                TRANSPORT_MODE_MAPPING.get(rt) == "bus"
            ), f"Route type {rt} should be bus"

    def test_tram_types(self):
        """Test tram route types are mapped correctly."""
        tram_types = ["0", "900", "901"]
        for rt in tram_types:
            assert (
                TRANSPORT_MODE_MAPPING.get(rt) == "tram"
            ), f"Route type {rt} should be tram"

    def test_metro_types(self):
        """Test metro route types are mapped correctly."""
        metro_types = ["1", "400", "401", "402"]
        for rt in metro_types:
            assert (
                TRANSPORT_MODE_MAPPING.get(rt) == "metro"
            ), f"Route type {rt} should be metro"

    def test_rail_types(self):
        """Test rail route types are mapped correctly."""
        rail_types = ["2", "100", "101", "109"]
        for rt in rail_types:
            assert (
                TRANSPORT_MODE_MAPPING.get(rt) == "rail"
            ), f"Route type {rt} should be rail"

    def test_other_types(self):
        """Test other route types are mapped correctly."""
        other_types = ["4", "6", "7", "1000", "1400"]
        for rt in other_types:
            assert (
                TRANSPORT_MODE_MAPPING.get(rt) == "other"
            ), f"Route type {rt} should be other"


# =============================================================================
# Unit Tests - TripCountStationParams
# =============================================================================


class TestTripCountStationParams:
    """Tests for TripCountStationParams schema."""

    def test_params_creation(self, test_data_dir: Path):
        """Test creating params with valid values."""
        params = TripCountStationParams(
            reference_area_path=str(test_data_dir / "munich_districts.geojson"),
            stops_path="stops.parquet",
            stop_times_path="stop_times.parquet",
            trips_path="trips.parquet",
            routes_path="routes.parquet",
            calendar_dates_path="calendar_dates.parquet",
            service_date="2026-11-24",
            time_window=PTTimeWindow(
                weekday="weekday",
                from_time=25200,
                to_time=32400,
            ),
            output_path="/tmp/test_output.parquet",
        )
        assert params.time_window.weekday == "weekday"
        assert params.time_window.from_time == 25200

    def test_params_with_path_objects(self, test_data_dir: Path):
        """Test creating params with Path objects."""
        params = TripCountStationParams(
            reference_area_path=test_data_dir / "munich_districts.geojson",
            stops_path="stops.parquet",
            stop_times_path="stop_times.parquet",
            trips_path="trips.parquet",
            routes_path="routes.parquet",
            calendar_dates_path="calendar_dates.parquet",
            service_date="2026-11-24",
            time_window=PTTimeWindow(
                weekday="weekday",
                from_time=25200,
                to_time=32400,
            ),
            output_path=Path("/tmp/test_output.parquet"),
        )
        assert params.reference_area_path is not None


# =============================================================================
# Integration Tests - TripCountStationTool
# =============================================================================


class TestTripCountStationTool:
    """Integration tests for TripCountStationTool."""

    def test_tool_initialization(self):
        """Test that the tool initializes correctly."""
        tool = TripCountStationTool()
        assert tool.con is not None
        tool.cleanup()

    def test_trip_count_weekday(
        self,
        munich_districts_path: Path,
        network_tables: Callable[[str], dict],
        time_window_weekday: PTTimeWindow,
        result_dir: Path,
    ):
        """Test trip count calculation for weekday morning."""
        output_path = result_dir / "unit_trip_count_weekday.parquet"

        params = TripCountStationParams(
            reference_area_path=str(munich_districts_path),
            **network_tables("weekday"),
            time_window=time_window_weekday,
            output_path=str(output_path),
        )

        tool = TripCountStationTool()
        result = tool.run(params)

        # Verify results
        assert output_path.exists(), "Output file should exist"
        assert result["total_stations"] > 0, "Should have found stations"
        assert result["stations_with_service"] > 0, "Should have stations with service"
        assert result["total_trips"] > 0, "Should have counted trips"

        # Verify output structure
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM '{output_path}'").fetchdf()

        # Check required columns
        expected_columns = [
            "stop_id",
            "stop_name",
            "parent_station",
            "bus",
            "tram",
            "metro",
            "rail",
            "other",
            "total",
            "frequency",
            "geom",
        ]
        for col in expected_columns:
            assert col in df.columns, f"Column '{col}' should be present"

        # Verify data types and values
        assert df["total"].min() > 0, "All stations should have at least one trip"
        assert df["frequency"].notna().all(), "Frequency should be calculated for all"
        assert (df["frequency"] > 0).all(), "Frequency should be positive"

        # Verify geometries are POINT
        geom_check = con.execute(f"""
            SELECT DISTINCT ST_GeometryType(geom) as geom_type
            FROM '{output_path}'
        """).fetchall()
        assert geom_check[0][0] == "POINT", "Geometries should be POINT"

        # Verify mode counts sum to total
        mode_sum = df[["bus", "tram", "metro", "rail", "other"]].sum(axis=1)
        assert (mode_sum == df["total"]).all(), "Mode counts should sum to total"

        con.close()

        print("\n=== Trip Count Weekday Results ===")
        print(f"Total stations in area: {result['total_stations']}")
        print(f"Stations with service: {result['stations_with_service']}")
        print(f"Total trips counted: {result['total_trips']}")
        print(f"Average frequency (minutes): {result['average_frequency_minutes']}")

        check_tool_style(
            TripCountToolRunner,
            tool_params(TripCountToolParams, reference_area_layer_id=U),
            output_path,
            expect=Expectation(field="total"),
        )

    def test_trip_count_saturday(
        self,
        munich_districts_path: Path,
        network_tables: Callable[[str], dict],
        time_window_saturday: PTTimeWindow,
        result_dir: Path,
    ):
        """Test trip count calculation for Saturday morning."""
        output_path = result_dir / "unit_trip_count_saturday.parquet"

        params = TripCountStationParams(
            reference_area_path=str(munich_districts_path),
            **network_tables("saturday"),
            time_window=time_window_saturday,
            output_path=str(output_path),
        )

        tool = TripCountStationTool()
        result = tool.run(params)

        assert output_path.exists()
        assert result["total_stations"] > 0

        # Saturday should generally have fewer services than weekday
        print("\n=== Trip Count Saturday Results ===")
        print(f"Total stations in area: {result['total_stations']}")
        print(f"Stations with service: {result['stations_with_service']}")
        print(f"Total trips counted: {result['total_trips']}")
        print(f"Average frequency (minutes): {result['average_frequency_minutes']}")

    def test_frequency_calculation(
        self,
        munich_districts_path: Path,
        network_tables: Callable[[str], dict],
        result_dir: Path,
    ):
        """Test that frequency is correctly calculated."""
        output_path = result_dir / "unit_trip_count_frequency.parquet"

        # Use a 60-minute window for easy frequency verification
        time_window = PTTimeWindow(
            weekday="weekday",
            from_time=25200,  # 7:00
            to_time=28800,  # 8:00 (1 hour)
        )

        params = TripCountStationParams(
            reference_area_path=str(munich_districts_path),
            **network_tables("weekday"),
            time_window=time_window,
            output_path=str(output_path),
        )

        tool = TripCountStationTool()
        tool.run(params)

        # Verify frequency calculation: frequency = time_window / total
        con = duckdb.connect()
        df = con.execute(f"SELECT total, frequency FROM '{output_path}'").fetchdf()

        # For 60-minute window: frequency = 60 / total
        expected_frequency = 60.0 / df["total"]
        actual_frequency = df["frequency"]

        # Allow for small rounding differences
        assert (
            (expected_frequency - actual_frequency).abs() < 0.01
        ).all(), "Frequency should be time_window_minutes / total"

        con.close()


# =============================================================================
# Edge Case Tests
# =============================================================================


class TestTripCountEdgeCases:
    """Edge case tests for TripCountStationTool."""

    def test_evening_time_window(
        self,
        munich_districts_path: Path,
        network_tables: Callable[[str], dict],
        result_dir: Path,
    ):
        """Test with evening time window when services are less frequent."""
        output_path = result_dir / "unit_trip_count_evening.parquet"

        time_window = PTTimeWindow(
            weekday="weekday",
            from_time=72000,  # 20:00
            to_time=79200,  # 22:00
        )

        params = TripCountStationParams(
            reference_area_path=str(munich_districts_path),
            **network_tables("weekday"),
            time_window=time_window,
            output_path=str(output_path),
        )

        tool = TripCountStationTool()
        result = tool.run(params)

        assert output_path.exists()
        # Evening should have higher average frequency (less frequent service)
        print("\n=== Trip Count Evening Results ===")
        print(f"Stations with service: {result['stations_with_service']}")
        print(f"Average frequency (minutes): {result['average_frequency_minutes']}")

    def test_sunday_service(
        self,
        munich_districts_path: Path,
        network_tables: Callable[[str], dict],
        result_dir: Path,
    ):
        """Test Sunday service levels."""
        output_path = result_dir / "unit_trip_count_sunday.parquet"

        time_window = PTTimeWindow(
            weekday="sunday",
            from_time=25200,  # 7:00
            to_time=32400,  # 9:00
        )

        params = TripCountStationParams(
            reference_area_path=str(munich_districts_path),
            **network_tables("sunday"),
            time_window=time_window,
            output_path=str(output_path),
        )

        tool = TripCountStationTool()
        result = tool.run(params)

        assert output_path.exists()
        print("\n=== Trip Count Sunday Results ===")
        print(f"Stations with service: {result['stations_with_service']}")
        print(f"Total trips: {result['total_trips']}")
