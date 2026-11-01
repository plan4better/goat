"""Overlay tools on a layer that has a geometry and no attribute columns.

A dissolve without group fields writes exactly that, and a workflow passes it
straight on (dissolve, then intersect with districts). The overlay tools build
their select list from each side's attribute columns, so either side may
contribute none, and so may an explicit field list once the geometry is taken
out of it.
"""

from pathlib import Path

import duckdb
import pytest
from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.geoprocessing.buffer import BufferTool
from goatlib.analysis.geoprocessing.centroid import CentroidTool
from goatlib.analysis.geoprocessing.clip import ClipTool
from goatlib.analysis.geoprocessing.difference import DifferenceTool
from goatlib.analysis.geoprocessing.dissolve import DissolveTool
from goatlib.analysis.geoprocessing.intersection import IntersectionTool
from goatlib.analysis.geoprocessing.union import UnionTool
from goatlib.analysis.schemas.geoprocessing import (
    BufferParams,
    CentroidParams,
    ClipParams,
    DifferenceParams,
    DissolveParams,
    IntersectionParams,
    UnionParams,
)
from goatlib.io.bbox_columns import is_bbox_struct

DATA = Path(__file__).parent.parent.parent / "data" / "vector"
POLYGONS = str(DATA / "overlay_polygons.parquet")
BOUNDARY = str(DATA / "overlay_boundary.parquet")


@pytest.fixture
def dissolved(tmp_path: Path) -> str:
    """The polygons dissolved into one geometry: no attribute columns."""
    tool = DissolveTool()
    try:
        path, _ = tool.run(
            DissolveParams(
                input_path=POLYGONS, output_path=str(tmp_path / "dissolved.parquet")
            )
        )[0]
    finally:
        tool.cleanup()
    assert _columns(str(path)) == ["geometry"]
    return str(path)


def _columns(path: str) -> list[str]:
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        rows = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()
    finally:
        con.close()
    return [name for name, data_type, *_ in rows if not is_bbox_struct(str(data_type))]


def _rows(path: str) -> int:
    con = duckdb.connect()
    try:
        return con.execute(f"SELECT count(*) FROM read_parquet('{path}')").fetchone()[0]
    finally:
        con.close()


def _intersect(tmp_path: Path, **params: object) -> str:
    tool = IntersectionTool()
    try:
        path, _ = tool.run(
            IntersectionParams(output_path=str(tmp_path / "out.parquet"), **params)
        )[0]
    finally:
        tool.cleanup()
    return str(path)


def _union(tmp_path: Path, **params: object) -> str:
    tool = UnionTool()
    try:
        path, _ = tool.run(
            UnionParams(output_path=str(tmp_path / "out.parquet"), **params)
        )[0]
    finally:
        tool.cleanup()
    return str(path)


# --- intersection -----------------------------------------------------------


def test_intersect_a_geometry_only_input(tmp_path: Path, dissolved: str) -> None:
    """The workflow case: dissolve, then intersect with districts, keeping two
    of their fields under a prefix."""
    out = _intersect(
        tmp_path,
        input_path=dissolved,
        overlay_path=BOUNDARY,
        overlay_fields=["boundary_id", "boundary_name"],
        overlay_fields_prefix="bezirk_",
    )
    assert _columns(out) == ["bezirk_boundary_id", "bezirk_boundary_name", "geometry"]
    assert _rows(out) > 0


def test_intersect_with_a_geometry_only_overlay(tmp_path: Path, dissolved: str) -> None:
    out = _intersect(tmp_path, input_path=BOUNDARY, overlay_path=dissolved)
    assert _columns(out) == [
        "boundary_id",
        "boundary_name",
        "boundary_type",
        "description",
        "geometry",
    ]
    assert _rows(out) > 0


def test_intersect_two_geometry_only_layers(tmp_path: Path, dissolved: str) -> None:
    out = _intersect(tmp_path, input_path=dissolved, overlay_path=dissolved)
    assert _columns(out) == ["geometry"]
    assert _rows(out) > 0


def test_intersect_field_lists_left_empty_by_the_geometry(tmp_path: Path) -> None:
    """Field lists naming only the geometry and the bbox keep no attribute."""
    out = _intersect(
        tmp_path,
        input_path=POLYGONS,
        overlay_path=BOUNDARY,
        input_fields=["geometry", "bbox"],
        overlay_fields=["geometry"],
    )
    assert _columns(out) == ["geometry"]
    assert _rows(out) > 0


# --- union ------------------------------------------------------------------


def test_union_a_geometry_only_input(tmp_path: Path, dissolved: str) -> None:
    out = _union(
        tmp_path,
        input_path=dissolved,
        overlay_path=BOUNDARY,
        overlay_fields_prefix="b_",
    )
    assert _columns(out) == [
        "b_boundary_id",
        "b_boundary_name",
        "b_boundary_type",
        "b_description",
        "geometry",
    ]
    assert _rows(out) > 0


def test_union_with_a_geometry_only_overlay(tmp_path: Path, dissolved: str) -> None:
    out = _union(tmp_path, input_path=BOUNDARY, overlay_path=dissolved)
    assert _columns(out) == [
        "boundary_id",
        "boundary_name",
        "boundary_type",
        "description",
        "geometry",
    ]
    assert _rows(out) > 0


def test_union_two_geometry_only_layers(tmp_path: Path, dissolved: str) -> None:
    out = _union(tmp_path, input_path=dissolved, overlay_path=dissolved)
    assert _columns(out) == ["geometry"]
    assert _rows(out) > 0


def test_union_select_lists_hold_only_the_columns_there_are(tmp_path: Path) -> None:
    """Two tables with a geometry and nothing else, not even the bbox the
    import adds: the three parts of the union (overlap, input only, overlay
    only) still line up column for column."""
    tool = UnionTool()
    try:
        for name, wkt in (
            ("a", "POLYGON((0 0, 2 0, 2 2, 0 2, 0 0))"),
            ("b", "POLYGON((1 1, 3 1, 3 3, 1 3, 1 1))"),
        ):
            tool.con.execute(
                f"CREATE TABLE {name} AS SELECT ST_GeomFromText('{wkt}') AS geometry"
            )
        out = tmp_path / "out.parquet"
        tool._execute_two_layer_union(
            UnionParams(input_path="a", overlay_path="b"),
            "a",
            "b",
            None,
            None,
            "geometry",
            "geometry",
            None,
            None,
            out,
        )
    finally:
        tool.cleanup()
    assert _columns(str(out)) == ["geometry"]
    assert _rows(str(out)) == 3


# --- the other geoprocessing tools select `* EXCLUDE (...)`, which holds
# --- nothing for a geometry-only layer and needs no change


@pytest.mark.parametrize(
    ("tool", "params", "columns"),
    [
        (ClipTool, ClipParams, ["geometry"]),
        (DifferenceTool, DifferenceParams, ["geometry"]),
    ],
)
def test_overlay_tools_take_a_geometry_only_input(
    tmp_path: Path,
    dissolved: str,
    tool: type[AnalysisTool],
    params: type,
    columns: list[str],
) -> None:
    runner = tool()
    try:
        out, _ = runner.run(
            params(
                input_path=dissolved,
                overlay_path=BOUNDARY,
                output_path=str(tmp_path / "out.parquet"),
            )
        )[0]
    finally:
        runner.cleanup()
    assert _columns(str(out)) == columns


@pytest.mark.parametrize(
    ("tool", "params", "columns"),
    [
        (BufferTool, {"distances": [100]}, ["buffer_distance", "geometry"]),
        (CentroidTool, {}, ["geometry"]),
    ],
)
def test_single_layer_tools_take_a_geometry_only_input(
    tmp_path: Path,
    dissolved: str,
    tool: type[AnalysisTool],
    params: dict[str, object],
    columns: list[str],
) -> None:
    schema = BufferParams if tool is BufferTool else CentroidParams
    runner = tool()
    try:
        out, _ = runner.run(
            schema(
                input_path=dissolved,
                output_path=str(tmp_path / "out.parquet"),
                **params,
            )
        )[0]
    finally:
        runner.cleanup()
    assert _columns(str(out)) == columns
