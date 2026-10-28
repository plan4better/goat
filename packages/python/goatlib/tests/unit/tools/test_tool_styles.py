"""Tools give their result layers GOAT Style documents (spec 17), with the values
the server computes already filled from the result data (spec 12)."""

import json
import re
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import MagicMock

import duckdb
import pytest
from goatlib.models.io import DatasetMetadata
from goatlib.style.context import DataContext
from goatlib.style.validate import validate
from goatlib.tools import style as tool_style
from goatlib.tools import temp_writer
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import ToolInputBase

pytestmark = pytest.mark.unit

SRC = Path(__file__).parents[3] / "src" / "goatlib"
USER = "11111111-1111-1111-1111-111111111111"


def errors(doc: dict[str, Any], geometry: str | None) -> list[Any]:
    ctx = DataContext(kind="vector", geometry=geometry)
    return [i for i in validate(doc, ctx) if i.level == "error"]


@pytest.fixture
def con() -> Iterator[duckdb.DuckDBPyConnection]:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    yield con
    con.close()


def cells(con: duckdb.DuckDBPyConnection, tmp_path: Path) -> Path:
    """Twenty squares whose `total_accessibility` runs from 1 to 20."""
    path = tmp_path / "out.parquet"
    con.execute(
        f"""COPY (
            SELECT i::DOUBLE AS total_accessibility, i AS cost_step,
                   ST_Buffer(ST_Point(i, 0), 0.4) AS geometry
            FROM range(1, 21) t(i)
        ) TO '{path}' (FORMAT PARQUET)"""
    )
    return path


class TestBuilders:
    @pytest.mark.parametrize(
        ("doc", "geometry"),
        [
            (tool_style.classified("total", "colorbrewer:BuPu", "point"), "point"),
            (tool_style.classified("v", tool_style.EMRLD, "polygon"), "polygon"),
            (
                tool_style.categories(
                    "cost_step", [5, 10, 15], "colorbrewer:YlGn", "line"
                ),
                "line",
            ),
            (tool_style.oev_gueteklassen_style(), "polygon"),
            (tool_style.oev_gueteklassen_stations_style(), "point"),
            (tool_style.starting_points_style(), "point"),
            (tool_style.bundle_role_style("street_network", "edges", "line"), "line"),
            (tool_style.bundle_role_style("street_network", "nodes", "point"), "point"),
            (
                tool_style.bundle_role_style("pt_network_gtfs", "stops", "point"),
                "point",
            ),
            (
                tool_style.bundle_role_style("pt_network_gtfs", "shape_lines", "line"),
                "line",
            ),
            (
                tool_style.bundle_role_style("street_network", "unknown", "polygon"),
                "polygon",
            ),
        ],
    )
    def test_every_builder_writes_a_valid_document(
        self, doc: dict[str, Any], geometry: str
    ) -> None:
        assert doc["version"] == 1
        assert errors(doc, geometry) == []

    def test_categories_keep_the_value_types_and_take_palette_colors_in_order(
        self,
    ) -> None:
        doc = tool_style.categories(
            "buffer_distance", [100, 200, 500], "colorbrewer:OrRd", "polygon"
        )
        [c] = doc["classify"]
        assert (c["field"], c["method"], c.get("count")) == (
            "buffer_distance",
            "categories",
            None,
        )
        assert [k["values"] for k in c["classes"]] == [[100], [200], [500]]
        colors = [k["fill"]["color"] for k in c["classes"]]
        assert colors[0] != colors[-1] and len(set(colors)) == 3

    def test_a_classified_style_asks_for_computed_classes(self) -> None:
        doc = tool_style.classified("total", "colorbrewer:BuPu", "point", count=5)
        [c] = doc["classify"]
        assert (c["field"], c["method"], c["count"], c["palette"]) == (
            "total",
            "quantile",
            5,
            "colorbrewer:BuPu",
        )
        assert "classes" not in c

    def test_bundle_roles_keep_their_look(self) -> None:
        edges = tool_style.bundle_role_style("street_network", "edges", "line")
        assert edges["symbol"]["line"] == {"color": "#717171", "width": 2}
        stops = tool_style.bundle_role_style("pt_network_gtfs", "stops", "point")
        assert stops["symbol"]["outline"] == {"color": "#ffffff", "width": 2}

    def test_a_role_without_an_entry_gets_the_default_style(self) -> None:
        doc = tool_style.bundle_role_style(
            "street_network", "unknown", "polygon", seed="abc"
        )
        assert "fill" in doc["symbol"]


class _Runner(BaseToolRunner[ToolInputBase]):
    tool_class = object
    output_geometry_type = None
    default_output_name = "Result"

    def __init__(self, con: duckdb.DuckDBPyConnection, style: Any = None) -> None:
        super().__init__()
        self._duckdb_con = con
        self.style = style
        self.settings = MagicMock(pmtiles_enabled=False, pmtiles_max_zoom=14)
        self.parquet: Path | None = None

    def process(
        self, params: ToolInputBase, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        assert self.parquet is not None
        return self.parquet, DatasetMetadata(
            path=str(self.parquet), source_type="vector"
        )

    def get_layer_style(
        self,
        params: ToolInputBase,
        metadata: DatasetMetadata,
        geometry: str | None,
        relation: str,
    ) -> dict[str, Any] | None:
        return self.style(geometry) if self.style else None


class TestComputedStyle:
    def test_classes_are_computed_from_the_result_and_stamped(
        self, con: duckdb.DuckDBPyConnection, tmp_path: Path
    ) -> None:
        runner = _Runner(con)
        intent = tool_style.classified(
            "total_accessibility", "colorbrewer:BuPu", "polygon", count=4
        )
        doc = runner.computed_style(
            intent,
            relation=f"read_parquet('{cells(con, tmp_path)}')",
            geometry="polygon",
            fingerprint="ducklake:7",
            seed="x",
        )
        [c] = doc["classify"]
        assert len(c["classes"]) == 4
        assert c["classes"][0]["to"] == c["classes"][1]["from"]
        assert all("color" in k["fill"] for k in c["classes"])
        assert c["computed"]["data"] == "ducklake:7"
        assert errors(doc, "polygon") == []

    def test_without_a_tool_style_the_default_for_the_geometry_is_used(
        self, con: duckdb.DuckDBPyConnection, tmp_path: Path
    ) -> None:
        runner = _Runner(con)
        doc = runner.computed_style(
            None,
            relation=f"read_parquet('{cells(con, tmp_path)}')",
            geometry="line",
            fingerprint="ducklake:1",
            seed="layer-1",
        )
        assert "line" in doc["symbol"]
        again = runner.computed_style(
            None, relation="x", geometry="line", fingerprint="f", seed="layer-1"
        )
        assert again == doc


class TestTempMode:
    def test_temp_mode_writes_the_document_into_metadata_json_and_no_rows(
        self,
        con: duckdb.DuckDBPyConnection,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        class Writer(temp_writer.TempLayerWriter):
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                super().__init__(*args, temp_data_root=tmp_path / "temp", **kwargs)

        monkeypatch.setattr(temp_writer, "TempLayerWriter", Writer)
        runner = _Runner(
            con,
            style=lambda geometry: tool_style.classified(
                "total_accessibility", tool_style.EMRLD, geometry
            ),
        )
        runner.parquet = cells(con, tmp_path)
        db = MagicMock()

        async def init() -> None:
            runner.db_service = db

        async def close() -> None:
            return None

        runner._init_db_service = init
        runner._close_db_service = close
        result = runner.run(
            ToolInputBase(user_id=USER, temp_mode=True, workflow_id="w1", node_id="n1")
        )
        assert "properties" not in result
        [c] = result["style"]["classify"]
        assert len(c["classes"]) == 7 and c["computed"]["data"] == "temp"
        [meta_path] = (tmp_path / "temp").rglob("metadata.json")
        meta = json.loads(meta_path.read_text())
        assert meta["style"] == result["style"]
        assert "properties" not in meta
        assert db.mock_calls == []


def test_no_version_0_style_is_left_in_the_tools() -> None:
    """Tools write GOAT Style documents only; the version 0 generators are gone."""
    pattern = re.compile(
        r"color_range|stroke_color|color_scale_breaks|get_layer_properties"
        r"|custom_properties|compute_quantile_breaks"
    )
    found = [
        f"{path.relative_to(SRC)}:{n}"
        for folder in ("tools", "bundles")
        for path in sorted((SRC / folder).rglob("*.py"))
        for n, line in enumerate(path.read_text().splitlines(), 1)
        if pattern.search(line)
    ]
    assert found == []


@pytest.mark.parametrize(
    ("module", "runner_name", "params_name", "extra"),
    [
        (
            "aggregate_points",
            "AggregatePointsToolRunner",
            "AggregatePointsToolParams",
            {"area_type": "h3_grid", "h3_resolution": 8},
        ),
        (
            "aggregate_polygon",
            "AggregatePolygonToolRunner",
            "AggregatePolygonToolParams",
            {"area_type": "polygon", "area_layer_id": "a"},
        ),
    ],
)
def test_an_aggregate_is_classified_by_the_column_it_writes(
    module: str, runner_name: str, params_name: str, extra: dict[str, Any]
) -> None:
    """A statistic given its own result name writes that column."""
    import importlib

    tool = importlib.import_module(f"goatlib.tools.{module}")
    params = getattr(tool, params_name)(
        user_id=USER,
        source_layer_id="s",
        column_statistics={"operation": "count", "result_name": "my_count"},
        **extra,
    )
    doc = getattr(tool, runner_name)().get_layer_style(
        params, MagicMock(), "polygon", "x"
    )
    assert doc["classify"][0]["field"] == "my_count"
