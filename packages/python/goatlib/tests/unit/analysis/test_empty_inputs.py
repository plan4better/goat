"""Tools on an input without rows.

A workflow step gets one when the dataset filter before it keeps nothing or
the step before it found nothing (an area outside the data, an intersection
without overlap). The step returns its result without rows, with the same
columns as ever and the geometry column still a geometry, so the step after
it can do the same. The empty inputs here are written the way a step writes
its result (`write_optimized_parquet`).
"""

from collections.abc import Callable
from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.data_management.join import JoinTool
from goatlib.analysis.data_management.merge import MergeTool
from goatlib.analysis.geoanalysis.aggregate_points import AggregatePointsTool
from goatlib.analysis.geoanalysis.aggregate_polygon import AggregatePolygonTool
from goatlib.analysis.geoprocessing.buffer import BufferTool
from goatlib.analysis.geoprocessing.centroid import CentroidTool
from goatlib.analysis.geoprocessing.clip import ClipTool
from goatlib.analysis.geoprocessing.difference import DifferenceTool
from goatlib.analysis.geoprocessing.dissolve import DissolveTool
from goatlib.analysis.geoprocessing.intersection import IntersectionTool
from goatlib.analysis.geoprocessing.union import UnionTool
from goatlib.analysis.schemas.aggregate import (
    AggregatePointsParams,
    AggregatePolygonParams,
    AggregationAreaType,
)
from goatlib.analysis.schemas.base import FieldStatistic, StatisticOperation
from goatlib.analysis.schemas.data_management import (
    JoinParams,
    MergeInputLayer,
    MergeParams,
)
from goatlib.analysis.schemas.geoprocessing import (
    BufferParams,
    CentroidParams,
    ClipParams,
    DifferenceParams,
    DissolveParams,
    IntersectionParams,
    UnionParams,
)
from goatlib.io.parquet import write_optimized_parquet

DATA = Path(__file__).parent.parent.parent / "data" / "vector"
#: 8 points.
POINTS = str(DATA / "overlay_points.parquet")
#: 4 polygons inside `BOUNDARY`.
POLYGONS = str(DATA / "overlay_polygons.parquet")
#: 1 polygon.
BOUNDARY = str(DATA / "overlay_boundary.parquet")
#: 10 polygons.
ZIPCODES = str(DATA / "zipcode_polygon.parquet")

COUNT = [FieldStatistic(operation=StatisticOperation.count)]


def _empty(source: str, out: Path) -> str:
    """`source` without its rows, written as a step writes its result."""
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        geometry = next(
            str(r[0])
            for r in con.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{source}')"
            ).fetchall()
            if "GEOMETRY" in str(r[1])
        )
        write_optimized_parquet(
            con,
            f"SELECT * FROM read_parquet('{source}') WHERE false",
            out,
            geometry_column=geometry,
        )
    finally:
        con.close()
    return str(out)


def _result(path: str | Path) -> tuple[int, str]:
    """The result's row count and the type of its geometry column."""
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        rows = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()
        count = con.execute(f"SELECT count(*) FROM read_parquet('{path}')").fetchone()
    finally:
        con.close()
    geometry = [str(r[1]) for r in rows if str(r[0]) in ("geometry", "geom")]
    assert count is not None and len(geometry) == 1, rows
    return int(count[0]), geometry[0]


Case = Callable[[str, str, str], tuple[type[AnalysisTool], Any]]

#: name -> (tool, params from the empty points, the empty polygons and the
#: output path), rows expected.
CASES: dict[str, tuple[Case, int]] = {
    "buffer": (
        lambda pts, poly, out: (
            BufferTool,
            BufferParams(input_path=pts, distances=[100], output_path=out),
        ),
        0,
    ),
    "centroid": (
        lambda pts, poly, out: (
            CentroidTool,
            CentroidParams(input_path=poly, output_path=out),
        ),
        0,
    ),
    "clip an empty input": (
        lambda pts, poly, out: (
            ClipTool,
            ClipParams(input_path=poly, overlay_path=BOUNDARY, output_path=out),
        ),
        0,
    ),
    "clip to an empty overlay": (
        lambda pts, poly, out: (
            ClipTool,
            ClipParams(input_path=POLYGONS, overlay_path=poly, output_path=out),
        ),
        0,
    ),
    "erase from an empty input": (
        lambda pts, poly, out: (
            DifferenceTool,
            DifferenceParams(input_path=poly, overlay_path=BOUNDARY, output_path=out),
        ),
        0,
    ),
    "erase an empty overlay": (
        lambda pts, poly, out: (
            DifferenceTool,
            DifferenceParams(input_path=POLYGONS, overlay_path=poly, output_path=out),
        ),
        4,
    ),
    "dissolve": (
        lambda pts, poly, out: (
            DissolveTool,
            DissolveParams(input_path=poly, output_path=out),
        ),
        0,
    ),
    "intersect an empty input": (
        lambda pts, poly, out: (
            IntersectionTool,
            IntersectionParams(input_path=poly, overlay_path=BOUNDARY, output_path=out),
        ),
        0,
    ),
    "intersect with an empty overlay": (
        lambda pts, poly, out: (
            IntersectionTool,
            IntersectionParams(input_path=POLYGONS, overlay_path=poly, output_path=out),
        ),
        0,
    ),
    "union of an empty input": (
        lambda pts, poly, out: (
            UnionTool,
            UnionParams(input_path=poly, overlay_path=BOUNDARY, output_path=out),
        ),
        1,
    ),
    "union with an empty overlay": (
        lambda pts, poly, out: (
            UnionTool,
            UnionParams(input_path=POLYGONS, overlay_path=poly, output_path=out),
        ),
        4,
    ),
    "union of an empty input with itself": (
        lambda pts, poly, out: (
            UnionTool,
            UnionParams(input_path=poly, output_path=out),
        ),
        0,
    ),
    "merge an empty layer with a full one": (
        lambda pts, poly, out: (
            MergeTool,
            MergeParams(
                input_paths=[
                    MergeInputLayer(input_path=pts),
                    MergeInputLayer(input_path=POINTS),
                ],
                output_path=out,
            ),
        ),
        8,
    ),
    "merge two empty layers": (
        lambda pts, poly, out: (
            MergeTool,
            MergeParams(
                input_paths=[
                    MergeInputLayer(input_path=pts),
                    MergeInputLayer(input_path=pts),
                ],
                output_path=out,
            ),
        ),
        0,
    ),
    "join an empty target": (
        lambda pts, poly, out: (
            JoinTool,
            JoinParams(
                target_path=poly,
                join_path=POINTS,
                use_spatial_relationship=True,
                use_attribute_relationship=False,
                spatial_relationship="intersects",
                output_path=out,
            ),
        ),
        0,
    ),
    "count no points per area": (
        lambda pts, poly, out: (
            AggregatePointsTool,
            AggregatePointsParams(
                source_path=pts,
                area_type=AggregationAreaType.polygon,
                area_layer_path=ZIPCODES,
                column_statistics=COUNT,
                output_path=out,
            ),
        ),
        10,
    ),
    "count points in no areas": (
        lambda pts, poly, out: (
            AggregatePointsTool,
            AggregatePointsParams(
                source_path=POINTS,
                area_type=AggregationAreaType.polygon,
                area_layer_path=poly,
                column_statistics=COUNT,
                output_path=out,
            ),
        ),
        0,
    ),
    "count no points per hexagon": (
        lambda pts, poly, out: (
            AggregatePointsTool,
            AggregatePointsParams(
                source_path=pts,
                area_type=AggregationAreaType.h3_grid,
                h3_resolution=8,
                column_statistics=COUNT,
                output_path=out,
            ),
        ),
        0,
    ),
    "count no polygons per hexagon": (
        lambda pts, poly, out: (
            AggregatePolygonTool,
            AggregatePolygonParams(
                source_path=poly,
                area_type=AggregationAreaType.h3_grid,
                h3_resolution=8,
                column_statistics=COUNT,
                output_path=out,
            ),
        ),
        0,
    ),
}


@pytest.mark.parametrize("name", list(CASES))
def test_a_tool_on_an_empty_input_returns_a_typed_result(
    name: str, tmp_path: Path
) -> None:
    case, expected_rows = CASES[name]
    points = _empty(POINTS, tmp_path / "no_points.parquet")
    polygons = _empty(POLYGONS, tmp_path / "no_polygons.parquet")
    tool_class, params = case(points, polygons, str(tmp_path / "out.parquet"))
    tool = tool_class()
    try:
        [(path, _)] = tool.run(params)
    finally:
        tool.cleanup()
    rows, geometry = _result(path)
    assert rows == expected_rows
    assert geometry.startswith("GEOMETRY"), geometry


def test_a_layer_without_geometry_is_reported_by_its_role(tmp_path: Path) -> None:
    """The message names the input, not the file the step read it from."""
    table = tmp_path / "layer_x1y2z3.parquet"
    con = duckdb.connect()
    try:
        con.execute(f"COPY (SELECT 1 AS id) TO '{table}' (FORMAT PARQUET)")
    finally:
        con.close()
    tool = ClipTool()
    try:
        with pytest.raises(ValueError) as raised:
            tool.run(ClipParams(input_path=POLYGONS, overlay_path=str(table)))
    finally:
        tool.cleanup()
    message = str(raised.value)
    assert "overlay" in message
    assert "layer_x1y2z3" not in message
    assert str(tmp_path) not in message
