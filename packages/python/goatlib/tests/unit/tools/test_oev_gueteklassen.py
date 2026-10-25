"""Unit tests for ÖV-Güteklassen tool parameter schema."""

from pathlib import Path

import duckdb
import pytest
from goatlib.analysis.accessibility.oev_gueteklasse import OevGueteklasseTool
from goatlib.analysis.schemas.catchment_area import Weekday
from goatlib.tools.oev_gueteklassen import (
    CatchmentType,
    OevGueteklassenToolParams,
    OevGueteklassenToolRunner,
)

SQUARE = "ST_GeomFromText('POLYGON((11 48, 11.01 48, 11.01 48.01, 11 48.01, 11 48))')"


class TestOevGueteklassenToolParams:
    """Test OevGueteklassenToolParams validation and defaults."""

    BASE_PARAMS = {
        "user_id": "00000000-0000-0000-0000-000000000001",
        "reference_area_layer_id": "00000000-0000-0000-0000-000000000002",
    }

    def test_defaults(self):
        """Default weekday, time window and catchment type should be applied."""
        params = OevGueteklassenToolParams(**self.BASE_PARAMS)

        assert params.weekday == Weekday.weekday
        assert params.from_time == 25200
        assert params.to_time == 32400
        assert params.catchment_type == CatchmentType.buffer
        assert params.station_config is None

    def test_rejects_invalid_catchment_type(self):
        """Only buffer catchment type is currently supported."""
        with pytest.raises(ValueError):
            OevGueteklassenToolParams(
                **self.BASE_PARAMS,
                catchment_type="network",
            )

    def test_accepts_custom_station_config(self):
        """Custom station config should be parsed and expanded for route mappings."""
        params = OevGueteklassenToolParams(
            **self.BASE_PARAMS,
            station_config={
                "groups": {"2": "A", "3": "C"},
                "time_frequency": [10, 20],
                "categories": [
                    {"A": 1, "C": 2},
                    {"A": 2, "C": 3},
                ],
                "classification": {
                    "1": {300: "1"},
                    "2": {300: "2"},
                    "3": {300: "3"},
                },
            },
        )

        assert params.station_config is not None
        assert params.station_config.groups["700"] == "C"
        assert params.station_config.groups["100"] == "A"


def test_the_prediction_holds_the_columns_the_run_writes(tmp_path: Path) -> None:
    """Each class's pieces are written with the class number and its letter;
    the schema prediction names the same columns."""
    tool = OevGueteklasseTool()
    try:
        tool.con.execute(f"""
            CREATE TABLE oev_gueteklassen_final AS
            SELECT 1 AS pt_class, 'A' AS pt_class_label, {SQUARE} AS geom
        """)
        tool.con.execute("CREATE TABLE stations_in_area AS SELECT 's1' AS stop_id")
        tool.con.execute(
            "CREATE TABLE station_categories AS SELECT 1 AS station_category"
        )
        out = tmp_path / "classes.parquet"
        tool._export_results(str(out), None)
    finally:
        tool.cleanup()
    con = duckdb.connect()
    try:
        rel = con.execute(f"SELECT * FROM read_parquet('{out}')")
        written = [d[0] for d in rel.description]
    finally:
        con.close()
    predicted = OevGueteklassenToolRunner.predict_output_schema({}, {})
    # The parquet writer adds a bbox column; it is no layer column.
    assert set(predicted) == set(written) - {"bbox"}
    assert predicted["pt_class"] == "INTEGER"
    assert predicted["pt_class_label"] == "VARCHAR"
