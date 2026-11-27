"""Tool results with the default style the tool's own code gives them: the
snapshots the style lab draws (`apps/web/lib/style/__tests__/lab/tool-styles.lab.test.tsx`).

Each case makes a tool's result, asks the tool's runner for its default style
(`get_layer_style`, or the style the run passes for a second layer) and
computes it as a toolbox run does (`computed_style` with the runner's fit
flag), checks it with the style contract (`goatlib.tools.style_contract`) and
keeps the result's styled fields with its geometry moved to 0, 0. Where a case
comes from (`source`):

- `analysis`: the tool's analysis on the test data its unit tests use;
- `after_engine`: the tool's own code after the routing engine or the
  timetable step, on a made-up table standing for that step's output (the
  engine is not in the unit environment);
- `synthetic`: a made-up table with the columns the runner's
  `predict_output_schema` names;
- `pattern`: made-up values that show one behaviour of a tool's default.

`test_tool_style_cases.py` rebuilds every case and compares it with the
committed snapshot in `fixtures/tool_styles/`; `GOAT_WRITE_FIXTURES=1`
rewrites them.
"""

import copy
import json
import math
import tempfile
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import AsyncMock, MagicMock, patch

import duckdb
import numpy as np
from fixtures.tool_style import U, tool_params
from goatlib.analysis.statistics.columns import quote_identifier
from goatlib.io.config import parquet_copy_options
from goatlib.models.io import DatasetMetadata
from goatlib.style.compute import stable
from goatlib.style.data_check import referenced_fields
from goatlib.style.models.classify import NUMERIC_METHODS
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import ToolInputBase
from goatlib.tools.style_contract import result_geometry, style_contract
from goatlib.utils.column_types import column_types, type_class

FIXTURES = Path(__file__).parent / "fixtures" / "tool_styles"
#: The time and fingerprint every snapshot's computed values carry.
AT = "2026-01-01T00:00:00Z"
DATA = "snapshot-v1"
#: The most features a snapshot of lines or polygons keeps (a hexagon cell
#: takes about a quarter of a kilobyte), of points (a point takes far less),
#: and its largest size in bytes.
MAX_FEATURES = 300
MAX_POINTS = 600
MAX_BYTES = 100 * 1024
#: The lab's map in CSS pixels, its tiles' width, and the share of the map a
#: result fills.
MAP_WIDTH, MAP_HEIGHT, TILE = 640, 480, 512
FILL = 0.85
EARTH = 6378137.0
#: The field types of the lab (`LabCase.fields`) by the column's kind.
LAB_TYPES = {
    "integer": "integer",
    "number": "number",
    "string": "string",
    "boolean": "boolean",
    "date": "date",
    "datetime": "datetime",
}


@dataclass(frozen=True)
class Context:
    """Where a build finds the test data and writes its files."""

    data: Path
    work: Path
    #: The walking travel time matrices, for the cases that read them.
    walking_matrices: Path | None = None


@dataclass
class Result:
    """A tool's result, with the runner and parameters its style comes from;
    `document` is the style the run passes for a second layer."""

    runner: BaseToolRunner
    params: Any
    path: Path
    document: dict[str, Any] | None = None


@dataclass(frozen=True)
class Case:
    id: str
    #: The tool's name in the registry, and its result layer.
    tool: str
    layer: str
    #: A sentence for the gallery: what the result is, and what its look says.
    title: str
    shape: str
    source: str
    #: The test data files the result is made from.
    inputs: tuple[str, ...]
    #: Whether the lab compares it with a picture.
    picture: bool
    make: Callable[[Context, Path], Result]
    #: The design rules of the contract the case breaks on purpose.
    allow: tuple[str, ...] = field(default=())
    #: Whether the case reads the walking travel time matrices.
    matrices: bool = False
    #: Whether the case's made-up table stands for the tool's result, whose
    #: columns the runner's `predict_output_schema` names.
    predicted: bool = False


# --- building a snapshot ------------------------------------------------------------------------


def _connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("SET threads = 1; INSTALL spatial; LOAD spatial;")
    return con


def _pinned(node: Any) -> Any:
    """`node` with every `computed.at` set to `AT`."""
    if isinstance(node, dict):
        out = {k: _pinned(v) for k, v in node.items()}
        computed = out.get("computed")
        if isinstance(computed, dict) and "at" in computed:
            out["computed"] = {**computed, "at": AT}
        return out
    if isinstance(node, list):
        return [_pinned(x) for x in node]
    return node


def _mercator(lon: float, lat: float) -> tuple[float, float]:
    lat = max(min(lat, 85.0), -85.0)
    return (
        EARTH * math.radians(lon),
        EARTH * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)),
    )


def _degrees(x: float, y: float) -> tuple[float, float]:
    return (
        math.degrees(x / EARTH),
        math.degrees(2 * math.atan(math.exp(y / EARTH)) - math.pi / 2),
    )


def _map_coordinates(
    node: Any, f: Callable[[float, float], tuple[float, float]]
) -> Any:
    if isinstance(node[0], (int, float)):
        return list(f(node[0], node[1]))
    return [_map_coordinates(child, f) for child in node]


def _points(node: Any) -> Iterator[tuple[float, float]]:
    if isinstance(node[0], (int, float)):
        yield node[0], node[1]
        return
    for child in node:
        yield from _points(child)


def _extent(rows: list[dict[str, Any]]) -> tuple[float, float, float, float]:
    xs, ys = [], []
    for row in rows:
        for x, y in _points(row["geometry"]["coordinates"]):
            xs.append(x)
            ys.append(y)
    return min(xs), min(ys), max(xs), max(ys)


def _value(value: Any) -> Any:
    if isinstance(value, Decimal):
        value = float(value)
    if isinstance(value, float):
        return stable(value) if math.isfinite(value) else None
    if isinstance(value, (int, str, bool)) or value is None:
        return value
    return str(value)


def _sort_key(row: dict[str, Any], fields: list[str]) -> tuple[Any, ...]:
    values = [row["properties"].get(f) for f in fields]
    return (
        row["cx"],
        row["cy"],
        *[(v is None, "" if v is None else str(v)) for v in values],
        json.dumps(row["geometry"]),
    )


def _class_key(styled: dict[str, Any]) -> Callable[[dict[str, Any]], Any]:
    """The legend entry a feature's properties fall in, by the style's first
    classification: the class's place, `other` or `no_data`; None for all
    without a classification."""
    classify = [c for c in styled.get("classify") or [] if isinstance(c, dict)]
    if not classify:
        return lambda properties: None
    c = classify[0]
    field_name, classes = c.get("field"), c.get("classes") or []
    if c.get("method") in NUMERIC_METHODS:
        breaks = [
            k["from"] for k in classes[1:] if isinstance(k.get("from"), (int, float))
        ]

        def numeric(properties: dict[str, Any]) -> Any:
            value = properties.get(field_name)
            return "no_data" if value is None else sum(value >= b for b in breaks)

        return numeric
    places = {str(v): i for i, k in enumerate(classes) for v in k.get("values") or []}

    def category(properties: dict[str, Any]) -> Any:
        value = properties.get(field_name)
        return "no_data" if value is None else places.get(str(value), "other")

    return category


def feature_limit(geometry: str | None) -> int:
    """The most features a snapshot of `geometry` keeps."""
    return MAX_POINTS if geometry == "point" else MAX_FEATURES


def _window(
    rows: list[dict[str, Any]],
    class_of: Callable[[dict[str, Any]], Any],
    limit: int,
) -> list[dict[str, Any]]:
    """At most `limit` of `rows`: those whose place lies in a square
    window. The window's side shrinks from the result's extent by halves of a
    doubling (a factor of the square root of 2 each step) and its centre is
    tried on a grid over the extent, nearest the middle first; the first side
    at which a window of few enough features holds a feature of every legend
    entry wins, and of its windows the one with the most features. Where no
    window holds every entry, the one holding the most entries, from sides
    down to the one at which no window holds a quarter of the most features.
    Where no window holds from 1 to `limit` features, the `limit` nearest the
    middle of the extent."""
    if len(rows) <= limit:
        return rows
    xs = np.array([r["cx"] for r in rows])
    ys = np.array([r["cy"] for r in rows])
    keys = [class_of(r["properties"]) for r in rows]
    entries = len(set(keys))
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max(), ys.max()
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    grid = [
        (x0 + (x1 - x0) * i / 20, y0 + (y1 - y0) * j / 20)
        for i in range(21)
        for j in range(21)
    ]
    grid.sort(key=lambda c: (math.hypot(c[0] - mx, c[1] - my), c))
    best: tuple[int, int] | None = None
    chosen = None
    half = max(x1 - x0, y1 - y0) / 2
    for _ in range(40):
        largest = 0
        for cx, cy in grid:
            inside = (np.abs(xs - cx) <= half) & (np.abs(ys - cy) <= half)
            count = int(inside.sum())
            largest = max(largest, count)
            if not 0 < count <= limit:
                continue
            held = len({keys[i] for i in np.flatnonzero(inside)})
            if best is None or (held, count) > best:
                best, chosen = (held, count), inside
        if best is not None and (best[0] == entries or largest < limit / 4):
            break
        half /= math.sqrt(2)
    if chosen is None:
        # Every window holds none or more than the limit: features crowd on a
        # spot, so the ones nearest the middle are kept.
        order = np.argsort(np.hypot(xs - mx, ys - my), kind="stable")
        chosen = np.zeros(len(rows), dtype=bool)
        chosen[order[:limit]] = True
    return [r for r, keep in zip(rows, chosen) if keep]


def _features(
    con: duckdb.DuckDBPyConnection,
    relation: str,
    fields: list[str],
    class_of: Callable[[dict[str, Any]], Any],
    limit: int,
) -> tuple[list[dict[str, Any]], int, float]:
    """The result's features in Web Mercator with `fields`, sorted by their
    place and values; at most `limit` of them (`_window`); moved so
    their extent's centre lies at 0, 0 and turned back into degrees. With the
    number of features and the zoom that fits the ones kept."""
    geometry = next(
        n for n, t in column_types(con, relation).items() if type_class(t) == "geometry"
    )
    select = ", ".join([*(quote_identifier(f) for f in fields), "ST_AsGeoJSON(g)"])
    rows = []
    for *values, geojson in con.execute(
        f"SELECT {select} FROM (SELECT *, {quote_identifier(geometry)} AS g "
        f"FROM {relation}) WHERE g IS NOT NULL"
    ).fetchall():
        shape = json.loads(geojson)
        shape["coordinates"] = _map_coordinates(shape["coordinates"], _mercator)
        # The mean of its vertices stands for a feature's place (a line from a
        # point to itself has no centroid).
        xs, ys = zip(*_points(shape["coordinates"]))
        rows.append(
            {
                "properties": {f: _value(v) for f, v in zip(fields, values)},
                "geometry": shape,
                "cx": sum(xs) / len(xs),
                "cy": sum(ys) / len(ys),
            }
        )
    total = len(rows)
    kept = _window(rows, class_of, limit)
    kept.sort(key=lambda r: _sort_key(r, fields))
    x0, y0, x1, y1 = _extent(kept)
    dx, dy = (x0 + x1) / 2, (y0 + y1) / 2

    def moved(x: float, y: float) -> tuple[float, float]:
        lon, lat = _degrees(x - dx, y - dy)
        return round(lon, 6), round(lat, 6)

    features = [
        {
            "type": "Feature",
            "id": i + 1,
            "properties": r["properties"],
            "geometry": {
                "type": r["geometry"]["type"],
                "coordinates": _map_coordinates(r["geometry"]["coordinates"], moved),
            },
        }
        for i, r in enumerate(kept)
    ]
    return features, total, _zoom(x1 - x0, y1 - y0)


def _zoom(width: float, height: float) -> float:
    """The zoom, in quarter steps, at which an extent of `width` by `height`
    meters fills the lab's map."""
    if width <= 0 and height <= 0:
        return 14.0
    scale = min(
        MAP_WIDTH * FILL / width if width > 0 else math.inf,
        MAP_HEIGHT * FILL / height if height > 0 else math.inf,
    )
    zoom = math.log2(scale * 2 * math.pi * EARTH / TILE)
    return min(math.floor(zoom * 4) / 4, 18.0)


def build(case: Case, context: Context) -> dict[str, Any]:
    """The snapshot of `case`: its result, the default style the tool's run
    stores for it, and what the contract notes. Raises when the style breaks a
    hard rule of the contract, or a design rule the case does not allow."""
    work = Path(tempfile.mkdtemp(prefix=f"{case.id}-", dir=context.work))
    # The tools' own scratch files go into the build's folder.
    with patch.object(tempfile, "tempdir", str(work)):
        result = case.make(context, work)
    con = _connect()
    try:
        runner = result.runner
        runner._duckdb_con = con
        relation = f"read_parquet('{result.path}')"
        geometry = result_geometry(con, relation)
        document = result.document
        if document is None:
            document = runner.get_layer_style(
                result.params,
                DatasetMetadata(path=str(result.path), source_type="vector"),
                geometry,
                relation,
            )
        styled = runner.computed_style(
            copy.deepcopy(document) if document is not None else None,
            relation=relation,
            geometry=geometry,
            fingerprint=DATA,
            seed=case.id,
            fit=runner.fits_result_style,
            safety_net=False,
        )
        styled = _pinned(styled)
        problems = style_contract(styled, con, relation, geometry)
        broken = [p for p in problems if p.level == "error" or p.rule not in case.allow]
        if broken:
            lines = "\n".join(f"- {p.rule} ({p.level}): {p.message}" for p in broken)
            raise AssertionError(
                f"The style of case {case.id} breaks the contract:\n{lines}"
            )
        types = column_types(con, relation)
        fields = sorted(referenced_fields(styled))
        features, total, zoom = _features(
            con, relation, fields, _class_key(styled), feature_limit(geometry)
        )
    finally:
        runner._duckdb_con = None
        con.close()
    return {
        "id": case.id,
        "tool": case.tool,
        "layer": case.layer,
        "title": case.title,
        "shape": case.shape,
        "source": case.source,
        "inputs": list(case.inputs),
        "picture": case.picture,
        "geometry": geometry,
        "fields": {f: LAB_TYPES.get(type_class(types[f]), "string") for f in fields},
        "zoom": zoom,
        "rows": {"total": total, "kept": len(features)},
        "contract": sorted({p.rule for p in problems}),
        "style": styled,
        "features": {"type": "FeatureCollection", "features": features},
    }


def dump(snapshot: dict[str, Any]) -> str:
    """The snapshot as committed: its keys indented, one feature per line."""
    head = {k: v for k, v in snapshot.items() if k != "features"}
    text = json.dumps(head, indent=1, ensure_ascii=False)
    lines = ",\n".join(
        json.dumps(f, ensure_ascii=False, separators=(",", ":"))
        for f in snapshot["features"]["features"]
    )
    return (
        text[:-2]
        + ',\n "features": {"type": "FeatureCollection", "features": [\n'
        + lines
        + "\n]}\n}\n"
    )


# --- helpers for the cases ----------------------------------------------------------------------


def _vector(context: Context, name: str) -> str:
    return str(context.data / "vector" / name)


def _analysis(context: Context, name: str) -> str:
    return str(context.data / "analysis" / name)


def _write(path: Path, query: str) -> Path:
    """A made-up table written as a tool's step writes its result."""
    con = _connect()
    try:
        con.execute(f"COPY ({query}) TO '{path}' {parquet_copy_options()}")
    finally:
        con.close()
    return path


def _single(tool: Any) -> Any:
    """`tool` with its connection on one thread, so its sums come out in one
    order."""
    tool.con.execute("SET threads = 1")
    return tool


def _run(tool: Any, params: Any) -> Path:
    try:
        results = _single(tool).run(params)
    finally:
        tool.cleanup()
    return Path(results[0][0])


# --- geoprocessing ------------------------------------------------------------------------------


def _buffer(context: Context, work: Path) -> Result:
    from goatlib.analysis.geoprocessing.buffer import BufferTool
    from goatlib.analysis.schemas.geoprocessing import BufferParams, DistanceType
    from goatlib.tools.buffer import BufferToolParams, BufferToolRunner

    # The overlay points of the buffer tests lie degrees apart, where rings of
    # a few hundred meters draw too small to see: the zip code points do not.
    params = BufferParams(
        input_path=_vector(context, "zipcode_point.parquet"),
        output_path=str(work / "out.parquet"),
        distance_type=DistanceType.constant,
        distances=[500.0, 1000.0, 1500.0],
        units="meters",
        polygon_union=False,
    )
    path = _run(BufferTool(), params)
    return Result(
        BufferToolRunner(),
        tool_params(BufferToolParams, params, input_layer_id=U),
        path,
    )


def _overlay(kind: str) -> Callable[[Context, Path], Result]:
    """A plain geoprocessing tool on the overlay polygons and boundary, as its
    unit test runs it."""

    def make(context: Context, work: Path) -> Result:
        from goatlib.analysis.schemas import geoprocessing as schemas
        from goatlib.tools import centroid, clip, difference, intersection, union

        polygons = _vector(context, "overlay_polygons.parquet")
        boundary = _vector(context, "overlay_boundary.parquet")
        out = str(work / "out.parquet")
        if kind == "clip":
            from goatlib.analysis.geoprocessing.clip import ClipTool

            params = schemas.ClipParams(
                input_path=polygons, overlay_path=boundary, output_path=out
            )
            tool, module, ids = ClipTool(), clip, {"overlay_layer_id": U}
            runner, params_class = module.ClipToolRunner, module.ClipToolParams
        elif kind == "centroid":
            from goatlib.analysis.geoprocessing.centroid import CentroidTool

            params = schemas.CentroidParams(input_path=polygons, output_path=out)
            tool, ids = CentroidTool(), {}
            runner, params_class = (
                centroid.CentroidToolRunner,
                centroid.CentroidToolParams,
            )
        elif kind == "intersection":
            from goatlib.analysis.geoprocessing.intersection import IntersectionTool

            params = schemas.IntersectionParams(
                input_path=polygons, overlay_path=boundary, output_path=out
            )
            tool, ids = IntersectionTool(), {"overlay_layer_id": U}
            runner = intersection.IntersectionToolRunner
            params_class = intersection.IntersectionToolParams
        elif kind == "union":
            from goatlib.analysis.geoprocessing.union import UnionTool

            params = schemas.UnionParams(input_path=polygons, output_path=out)
            tool, ids = UnionTool(), {}
            runner, params_class = union.UnionToolRunner, union.UnionToolParams
        else:
            from goatlib.analysis.geoprocessing.difference import DifferenceTool

            params = schemas.DifferenceParams(
                input_path=polygons, overlay_path=boundary, output_path=out
            )
            tool, ids = DifferenceTool(), {"overlay_layer_id": U}
            runner = difference.DifferenceToolRunner
            params_class = difference.DifferenceToolParams
        path = _run(tool, params)
        return Result(
            runner(), tool_params(params_class, params, input_layer_id=U, **ids), path
        )

    return make


def _dissolve(context: Context, work: Path) -> Result:
    from goatlib.analysis.geoprocessing.dissolve import DissolveTool
    from goatlib.analysis.schemas.base import FieldStatistic
    from goatlib.analysis.schemas.geoprocessing import DissolveParams
    from goatlib.tools.dissolve import DissolveToolParams, DissolveToolRunner

    statistics = [{"operation": "sum", "field": "value_a"}]
    path = _run(
        DissolveTool(),
        DissolveParams(
            input_path=_vector(context, "overlay_polygons.parquet"),
            dissolve_fields=["type_a"],
            field_statistics=[FieldStatistic(**s) for s in statistics],
            output_path=str(work / "out.parquet"),
        ),
    )
    return Result(
        DissolveToolRunner(),
        tool_params(
            DissolveToolParams,
            input_layer_id=U,
            dissolve_fields=["type_a"],
            calculate_statistics=True,
            field_statistics=statistics,
        ),
        path,
    )


def _dissolve_groups(context: Context, work: Path) -> Result:
    from goatlib.analysis.geoprocessing.dissolve import DissolveTool
    from goatlib.analysis.schemas.geoprocessing import DissolveParams
    from goatlib.tools.dissolve import DissolveToolParams, DissolveToolRunner

    path = _run(
        DissolveTool(),
        DissolveParams(
            input_path=_vector(context, "overlay_polygons.parquet"),
            dissolve_fields=["type_a"],
            output_path=str(work / "out.parquet"),
        ),
    )
    return Result(
        DissolveToolRunner(),
        tool_params(DissolveToolParams, input_layer_id=U, dissolve_fields=["type_a"]),
        path,
    )


def _join(context: Context, work: Path) -> Result:
    from goatlib.analysis.data_management.join import JoinTool
    from goatlib.tools.join import JoinToolParams, JoinToolRunner

    params = tool_params(
        JoinToolParams,
        target_layer_id=U,
        join_layer_id=U,
        use_spatial_relationship=True,
        use_attribute_relationship=False,
        spatial_relationship="intersects",
        join_type="left",
        join_operation="one_to_one",
        calculate_statistics=True,
        column_statistics={"operation": "count", "result_name": "matched_points"},
    )
    path = _run(
        JoinTool(),
        JoinToolRunner.analysis_params(
            params,
            Path(_vector(context, "overlay_polygons.parquet")),
            Path(_vector(context, "overlay_points.parquet")),
            work / "out.parquet",
        ),
    )
    return Result(JoinToolRunner(), params, path)


def _merge(context: Context, work: Path) -> Result:
    from goatlib.analysis.data_management.merge import MergeTool
    from goatlib.analysis.schemas.data_management import MergeInputLayer, MergeParams
    from goatlib.tools.merge import MergeToolParams, MergeToolRunner

    params = MergeParams(
        input_paths=[
            MergeInputLayer(input_path=_vector(context, f"merge_points_{i}.parquet"))
            for i in (1, 2)
        ],
        output_path=str(work / "out.parquet"),
    )
    path = _run(MergeTool(), params)
    return Result(
        MergeToolRunner(),
        tool_params(MergeToolParams, input_layer_ids=[U, U]),
        path,
    )


def _od(layer: str) -> Callable[[Context, Path], Result]:
    def make(context: Context, work: Path) -> Result:
        from goatlib.analysis.geoanalysis import OriginDestinationTool
        from goatlib.analysis.schemas.geoprocessing import OriginDestinationParams
        from goatlib.tools.origin_destination import (
            OriginDestinationToolParams,
            OriginDestinationToolRunner,
        )

        params = OriginDestinationParams(
            geometry_path=_vector(context, "zipcode_point.parquet"),
            matrix_path=_vector(context, "origin_destination_matrix.parquet"),
            unique_id_column="zipcode",
            origin_column="origin",
            destination_column="destination",
            weight_column="weight",
            output_path_lines=str(work / "lines.parquet"),
            output_path_points=str(work / "points.parquet"),
        )
        tool = _single(OriginDestinationTool())
        try:
            tool.run(params)
        finally:
            tool.cleanup()
        runner = OriginDestinationToolRunner()
        tool_p = tool_params(
            OriginDestinationToolParams, params, geometry_layer_id=U, matrix_layer_id=U
        )
        if layer == "lines":
            return Result(runner, tool_p, work / "lines.parquet")
        return Result(
            runner, tool_p, work / "points.parquet", runner.points_style(tool_p)
        )

    return make


def _aggregate_points(context: Context, work: Path) -> Result:
    from goatlib.analysis.geoanalysis.aggregate_points import AggregatePointsTool
    from goatlib.analysis.schemas.aggregate import (
        AggregatePointsParams,
        AggregationAreaType,
    )
    from goatlib.analysis.schemas.base import FieldStatistic, StatisticOperation
    from goatlib.tools.aggregate_points import (
        AggregatePointsToolParams,
        AggregatePointsToolRunner,
    )

    params = AggregatePointsParams(
        source_path=_vector(context, "points_with_category.parquet"),
        area_type=AggregationAreaType.polygon,
        area_layer_path=_vector(context, "zipcode_polygon.parquet"),
        column_statistics=[FieldStatistic(operation=StatisticOperation.count)],
        output_path=str(work / "out.parquet"),
    )
    path = _run(AggregatePointsTool(), params)
    return Result(
        AggregatePointsToolRunner(),
        tool_params(
            AggregatePointsToolParams, params, source_layer_id=U, area_layer_id=U
        ),
        path,
    )


def _mean_onto_zip_codes(
    source: str, rest: str, field: str
) -> Callable[[Context, Path], Result]:
    """The mean of `field` of the points of the test file `source` that the
    SQL `rest` (a WHERE, ORDER BY or LIMIT, as a source filter keeps them)
    leaves, onto the ten zip code areas."""

    def make(context: Context, work: Path) -> Result:
        from goatlib.analysis.geoanalysis.aggregate_points import AggregatePointsTool
        from goatlib.analysis.schemas.aggregate import (
            AggregatePointsParams,
            AggregationAreaType,
        )
        from goatlib.analysis.schemas.base import FieldStatistic, StatisticOperation
        from goatlib.tools.aggregate_points import (
            AggregatePointsToolParams,
            AggregatePointsToolRunner,
        )

        points = _write(
            work / "points.parquet",
            f"SELECT * FROM '{_vector(context, source)}' {rest}",
        )
        params = AggregatePointsParams(
            source_path=str(points),
            area_type=AggregationAreaType.polygon,
            area_layer_path=_vector(context, "zipcode_polygon.parquet"),
            column_statistics=[
                FieldStatistic(operation=StatisticOperation.mean, field=field)
            ],
            output_path=str(work / "out.parquet"),
        )
        path = _run(AggregatePointsTool(), params)
        return Result(
            AggregatePointsToolRunner(),
            tool_params(
                AggregatePointsToolParams, params, source_layer_id=U, area_layer_id=U
            ),
            path,
        )

    return make


def _aggregate_polygon(context: Context, work: Path) -> Result:
    from goatlib.analysis.geoanalysis.aggregate_polygon import AggregatePolygonTool
    from goatlib.analysis.schemas.aggregate import (
        AggregatePolygonParams,
        AggregationAreaType,
    )
    from goatlib.analysis.schemas.base import FieldStatistic, StatisticOperation
    from goatlib.tools.aggregate_polygon import (
        AggregatePolygonToolParams,
        AggregatePolygonToolRunner,
    )

    params = AggregatePolygonParams(
        source_path=_analysis(context, "aggregate/green_areas.parquet"),
        area_type=AggregationAreaType.polygon,
        area_layer_path=_analysis(context, "aggregate/zipcode_polygon.parquet"),
        column_statistics=[
            FieldStatistic(operation=StatisticOperation.sum, field="value")
        ],
        output_path=str(work / "out.parquet"),
    )
    path = _run(AggregatePolygonTool(), params)
    return Result(
        AggregatePolygonToolRunner(),
        tool_params(
            AggregatePolygonToolParams, params, source_layer_id=U, area_layer_id=U
        ),
        path,
    )


@contextmanager
def _geocoder() -> Iterator[None]:
    """The geocoding service, mocked: each address found at its own place of
    a small made-up grid."""
    from goatlib.analysis.geoanalysis import geocoding

    def answer(
        url: str, params: dict | None = None, headers: dict | None = None
    ) -> Any:
        number = int(str((params or {}).get("address", "0")).split()[-1])
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [0.01 * (number % 4), 0.01 * (number // 4)],
                    },
                    "properties": {"confidence": 1.0, "match_type": "exact"},
                }
            ],
        }
        return response

    client = AsyncMock()
    client.get = AsyncMock(side_effect=answer)
    client_class = MagicMock()
    client_class.return_value.__aenter__ = AsyncMock(return_value=client)
    client_class.return_value.__aexit__ = AsyncMock(return_value=None)
    with patch.object(geocoding.httpx, "AsyncClient", client_class):
        yield


def _geocoding(context: Context, work: Path) -> Result:
    from goatlib.analysis.geoanalysis import GeocodingTool
    from goatlib.analysis.schemas.geocoding import (
        FieldSourceType,
        GeocodingInputMode,
        GeocodingParams,
    )
    from goatlib.tools.geocoding import GeocodingToolParams, GeocodingToolRunner

    addresses = _write(
        work / "addresses.parquet",
        "SELECT i AS id, 'Street ' || i AS street FROM range(1, 9) r(i)",
    )
    params = GeocodingParams(
        input_path=str(addresses),
        input_mode=GeocodingInputMode.structured,
        address_field="street",
        locality_source_type=FieldSourceType.constant,
        locality_constant="Town",
        country_source_type=FieldSourceType.constant,
        country_constant="Country",
        output_path=str(work / "out.parquet"),
        geocoder_url="https://geocoder.invalid",
        geocoder_authorization="Basic placeholder",
    )
    with _geocoder():
        path = _run(GeocodingTool(), params)
    return Result(
        GeocodingToolRunner(),
        tool_params(GeocodingToolParams, params, input_layer_id=U),
        path,
    )


def _clustering(layer: str) -> Callable[[Context, Path], Result]:
    def make(context: Context, work: Path) -> Result:
        from goatlib.analysis.geoanalysis.spatial_clustering import ClusteringZones
        from goatlib.analysis.schemas.clustering import ClusteringParams, ClusterType
        from goatlib.tools.spatial_clustering import (
            ClusteringZonesToolParams,
            ZonesClusteringToolRunner,
        )

        params = ClusteringParams(
            input_path=_analysis(context, "kita_part_munich.gpkg"),
            output_path=str(work / "points.parquet"),
            output_summary_path=str(work / "summary.parquet"),
            nb_cluster=10,
            cluster_type=ClusterType.kmean,
        )
        tool = _single(ClusteringZones())
        try:
            # The clustering draws random numbers in SQL and in numpy.
            tool.con.execute("SELECT setseed(0.42)")
            np.random.seed(42)
            (points, _), (summary, _) = tool._run_implementation(params)
        finally:
            tool.cleanup()
        runner = ZonesClusteringToolRunner()
        tool_p = tool_params(ClusteringZonesToolParams, params, input_layer_id=U)
        if layer == "points":
            return Result(runner, tool_p, Path(points))
        return Result(runner, tool_p, Path(summary), runner._get_summary_style(tool_p))

    return make


# --- accessibility on the walking matrices ------------------------------------------------------

_MATRIX_COLUMNS = {"cost": "traveltime", "orig_id": "orig_id", "dest_id": "dest_id"}


def _gravity_legacy(context: Context, work: Path) -> Result:
    from goatlib.analysis.accessibility.gravity import HeatmapGravityTool
    from goatlib.analysis.schemas.heatmap import (
        HeatmapGravityParams,
        OpportunityGravity,
    )
    from goatlib.tools.heatmap_gravity import (
        HeatmapGravityToolParams,
        HeatmapGravityToolRunner,
    )

    params = HeatmapGravityParams(
        routing_mode="walking",
        od_matrix_path=str(context.walking_matrices),
        od_column_map=_MATRIX_COLUMNS,
        output_path=str(work / "out.parquet"),
        impedance="linear",
        opportunities=[
            OpportunityGravity(
                input_path=_analysis(context, "de_weihnachsmaerkte_25.gpkg"),
                name="markets",
                potential_constant=1.0,
                sensitivity=300000.0,
                max_cost=30,
            ),
        ],
    )
    path = _run(HeatmapGravityTool(), params)
    return Result(
        HeatmapGravityToolRunner(), tool_params(HeatmapGravityToolParams, params), path
    )


def _closest_average_legacy(context: Context, work: Path) -> Result:
    from goatlib.analysis.accessibility.closest_average import (
        HeatmapClosestAverageTool,
    )
    from goatlib.analysis.schemas.heatmap import (
        HeatmapClosestAverageParams,
        OpportunityClosestAverage,
    )
    from goatlib.tools.heatmap_closest_average import (
        HeatmapClosestAverageToolParams,
        HeatmapClosestAverageToolRunner,
    )

    params = HeatmapClosestAverageParams(
        routing_mode="walking",
        od_matrix_path=str(context.walking_matrices),
        od_column_map=_MATRIX_COLUMNS,
        output_path=str(work / "out.parquet"),
        opportunities=[
            OpportunityClosestAverage(
                input_path=_analysis(context, "de_weihnachsmaerkte_25.gpkg"),
                name="markets",
                max_cost=20,
                n_destinations=3,
            ),
        ],
    )
    path = _run(HeatmapClosestAverageTool(), params)
    return Result(
        HeatmapClosestAverageToolRunner(),
        tool_params(HeatmapClosestAverageToolParams, params),
        path,
    )


def _connectivity_legacy(context: Context, work: Path) -> Result:
    from goatlib.analysis.accessibility.connectivity import HeatmapConnectivityTool
    from goatlib.analysis.schemas.heatmap import HeatmapConnectivityParams
    from goatlib.tools.heatmap_connectivity import (
        HeatmapConnectivityToolParams,
        HeatmapConnectivityToolRunner,
    )

    params = HeatmapConnectivityParams(
        routing_mode="walking",
        od_matrix_path=str(context.walking_matrices),
        od_column_map=_MATRIX_COLUMNS,
        output_path=str(work / "out.parquet"),
        max_cost=20,
        reference_area_path=_analysis(context, "munich_districts.geojson"),
    )
    path = _run(HeatmapConnectivityTool(), params)
    return Result(
        HeatmapConnectivityToolRunner(),
        tool_params(HeatmapConnectivityToolParams, params, reference_area_layer_id=U),
        path,
    )


def _two_sfca_legacy(context: Context, work: Path) -> Result:
    from goatlib.analysis.accessibility.two_step_catchment_area import (
        Heatmap2SFCATool,
    )
    from goatlib.analysis.schemas.heatmap import (
        Heatmap2SFCAParams,
        Opportunity2SFCA,
        TwoSFCAType,
    )
    from goatlib.tools.heatmap_2sfca import (
        Heatmap2SFCAToolParams,
        Heatmap2SFCAToolRunner,
    )

    params = Heatmap2SFCAParams(
        routing_mode="walking",
        od_matrix_path=str(context.walking_matrices),
        output_path=str(work / "out.parquet"),
        two_sfca_type=TwoSFCAType.twosfca,
        opportunities=[
            Opportunity2SFCA(
                name="childcare",
                input_path=_analysis(context, "kita_part_munich.gpkg"),
                capacity="capacity_int",
                max_cost=30,
            )
        ],
        demand_path=_analysis(context, "census_part_munich.parquet"),
        demand_field="einwohner",
    )
    path = _run(Heatmap2SFCATool(), params)
    return Result(
        Heatmap2SFCAToolRunner(),
        tool_params(Heatmap2SFCAToolParams, params, demand_layer_id=U),
        path,
    )


def _huff_legacy(context: Context, work: Path) -> Result:
    from goatlib.analysis.accessibility.huff_model import HuffmodelTool
    from goatlib.analysis.schemas.heatmap import HuffmodelParams
    from goatlib.tools.huff_model import HuffModelToolParams, HuffModelToolRunner

    params = HuffmodelParams(
        routing_mode="walking",
        od_matrix_path=str(context.walking_matrices),
        output_path=str(work / "out.parquet"),
        reference_area_path=_analysis(context, "munich_districts.geojson"),
        attractiveness_param=5.0,
        demand_path=_analysis(context, "census_part_munich.parquet"),
        demand_field="einwohner",
        opportunity_path=_analysis(context, "kita_part_munich.gpkg"),
        attractivity="capacity_int",
        max_cost=30,
    )
    tool = _single(HuffmodelTool())
    try:
        results = tool.run(params)
    finally:
        tool.cleanup()
    return Result(
        HuffModelToolRunner(),
        tool_params(
            HuffModelToolParams,
            params,
            demand_layer_id=U,
            opportunity_layer_id=U,
            reference_area_layer_id=U,
        ),
        Path(results[0][1].path),
    )


# --- after the routing engine or the timetable step ---------------------------------------------

#: Walking at the engine's default speed, in meters per minute, and a detour
#: on top of the straight line: the made-up travel times of the stand-in.
_WALK_M_PER_MIN = 5000 / 60
_DETOUR = 1.25
#: The H3 resolution of walking heatmaps, and the made-up minutes from one
#: ring of cells to the next.
_WALK_RES = 10
_MIN_PER_RING = 3.0
#: The average area of an H3 cell at that resolution, in m².
_CELL_AREA = 15047.0


class _Names:
    """Stands in for the engine's enums: every member is its own name."""

    def __getattr__(self, name: str) -> str:
        return name


def _engine(**functions: Callable[..., None]) -> Any:
    """A stand-in for the routing engine's module: its configs and enums, and
    the given functions in place of its computations."""
    from types import SimpleNamespace

    names = _Names()
    return SimpleNamespace(
        RoutingMode=names,
        CostType=names,
        HeatmapType=names,
        GravityDecay=names,
        TwoSFCAType=names,
        Point3857=lambda x, y: (x, y),
        Opportunity=lambda *args: args,
        MatrixConfig=SimpleNamespace,
        HeatmapConfig=SimpleNamespace,
        **functions,
    )


def _travel_matrix(cfg: Any) -> None:
    """The engine's travel cost matrix, made up: straight-line walking times
    with a detour, for the pairs within the budget."""
    import pyarrow as pa

    origins = np.array(cfg.origins, dtype=float)
    destinations = np.array(cfg.destinations, dtype=float)
    minutes = (
        np.hypot(
            origins[:, None, 0] - destinations[None, :, 0],
            origins[:, None, 1] - destinations[None, :, 1],
        )
        * _DETOUR
        / _WALK_M_PER_MIN
    )
    i, j = np.nonzero(minutes <= cfg.max_cost)
    od = pa.table(
        {
            "origin": np.array(cfg.origin_ids, dtype=object)[i].astype(str),
            "destination": np.array(cfg.destination_ids, dtype=object)[j].astype(str),
            "travel_cost": np.round(minutes[i, j]).astype(np.int32),
        }
    )
    con = _connect()
    try:
        con.register("od", od)
        con.execute(f"COPY od TO '{cfg.output_path}' (FORMAT PARQUET)")
    finally:
        con.close()


def _heatmap_scores(cfg: Any) -> None:
    """The engine's heatmap, made up: each cell's travel time to an
    opportunity is the number of H3 rings between them times a fixed step,
    within the budget (eight rings without one) and at most twelve rings; the
    score per heatmap type from those times."""
    con = _connect()
    try:
        con.execute("INSTALL h3 FROM community; LOAD h3;")
        con.execute("CREATE TABLE opp (opp INTEGER, x DOUBLE, y DOUBLE, w DOUBLE)")
        con.executemany(
            "INSERT INTO opp VALUES (?, ?, ?, ?)",
            [
                (i, rep[0], rep[1], float(w))
                for i, (_, w, rep) in enumerate(cfg.opportunities)
            ],
        )
        budget = cfg.max_cost if math.isfinite(cfg.max_cost) else 8 * _MIN_PER_RING
        rings = min(12, int(budget // _MIN_PER_RING))
        con.execute(f"""
            CREATE TABLE opp_cell AS
            SELECT opp, w, h3_latlng_to_cell(
                (2 * atan(exp(y / {EARTH})) - pi() / 2) * 180 / pi(),
                x / {EARTH} * 180 / pi(), {_WALK_RES}) AS cell
            FROM opp;
            CREATE TABLE reach AS
            SELECT opp, w, c AS cell, h3_grid_distance(c, cell) * {_MIN_PER_RING} AS t
            FROM (SELECT opp, w, cell, unnest(h3_grid_disk(cell, {rings})) AS c FROM opp_cell)
            WHERE h3_grid_distance(c, cell) * {_MIN_PER_RING} <= {budget};
        """)
        kind = cfg.heatmap_type
        if kind == "Gravity":
            score = f"sum(w * (1 - t / {budget}))"
        elif kind == "ClosestAverage":
            score = f"avg(t) FILTER (WHERE rank <= {cfg.closest_k})"
        elif kind == "Connectivity":
            score = f"count(*) * {_CELL_AREA}::DOUBLE"
        else:
            # Supply per demand: each opportunity's weight shared by the
            # demand it reaches.
            con.execute(f"""
                CREATE TABLE demand AS SELECT cell::UBIGINT AS cell, demand
                FROM read_parquet('{cfg.demand_path}');
                CREATE TABLE share AS
                SELECT r.opp, any_value(r.w) / sum(d.demand) AS ratio
                FROM reach r JOIN demand d ON d.cell = r.cell GROUP BY r.opp;
            """)
            score = "sum(s.ratio)"
        source = (
            "reach r JOIN share s USING (opp)"
            if kind == "TwoSFCA"
            else "(SELECT *, row_number() OVER (PARTITION BY cell ORDER BY t, opp) AS rank "
            "FROM reach)"
        )
        con.execute(
            f"COPY (SELECT cell AS h3_index, {score} AS score FROM {source} "
            f"GROUP BY cell ORDER BY cell) TO '{cfg.output_path}' (FORMAT PARQUET)"
        )
    finally:
        con.close()


@contextmanager
def _routing(tool_class: type, engine: Any) -> Iterator[None]:
    with patch.object(tool_class, "_get_routing_module", staticmethod(lambda: engine)):
        yield


def _made_up_points(
    work: Path, name: str, rows: list[tuple[float, float, float]]
) -> str:
    """Points near 0, 0 (longitude and latitude in degrees) with a value."""
    values = ", ".join(f"({i}, {x}, {y}, {v})" for i, (x, y, v) in enumerate(rows))
    return str(
        _write(
            work / f"{name}.parquet",
            f"SELECT id, value, ST_Point(x, y) AS geometry "
            f"FROM (VALUES {values}) t(id, x, y, value)",
        )
    )


def _square(work: Path, half: float) -> str:
    return str(
        _write(
            work / "area.parquet",
            f"SELECT 1 AS id, ST_MakeEnvelope(-{half}, -{half}, {half}, {half}) AS geometry",
        )
    )


_OPPORTUNITIES = [
    (-0.004, 0.002, 30),
    (0.003, 0.004, 60),
    (0.001, -0.004, 20),
    (0.006, -0.001, 45),
]
_DEMAND = [
    (0.0015 * (i % 9) - 0.006, 0.0015 * (i // 9) - 0.006, 50 + (i * 37) % 400)
    for i in range(81)
]


def _heatmap_v2(kind: str) -> Callable[[Context, Path], Result]:
    def make(context: Context, work: Path) -> Result:
        from goatlib.analysis.accessibility.heatmap_v2 import HeatmapV2Tool
        from goatlib.analysis.schemas.heatmap_v2 import HeatmapV2Params
        from goatlib.tools import heatmap_v2

        runner = {
            "gravity": heatmap_v2.HeatmapGravityV2ToolRunner,
            "closest_average": heatmap_v2.HeatmapClosestAverageV2ToolRunner,
            "connectivity": heatmap_v2.HeatmapConnectivityV2ToolRunner,
            "two_sfca": heatmap_v2.Heatmap2SFCAV2ToolRunner,
        }[kind]
        opportunities = _made_up_points(work, "opportunities", _OPPORTUNITIES)
        more: dict[str, Any] = {}
        if kind == "connectivity":
            more = {"reference_area_path": _square(work, 0.003)}
        elif kind == "closest_average":
            # Cells of the area the engine does not reach have no value.
            more = {"reference_area_path": _square(work, 0.0075)}
        elif kind == "two_sfca":
            more = {
                "demand_path": _made_up_points(work, "demand", _DEMAND),
                "demand_field": "value",
            }
        if kind != "connectivity":
            more["opportunities"] = [
                {
                    "input_path": opportunities,
                    "name": "places",
                    "max_cost": 15,
                    "n_destinations": 2,
                    "potential_type": "field" if kind == "two_sfca" else "constant",
                    **({"potential_field": "value"} if kind == "two_sfca" else {}),
                }
            ]
        params = HeatmapV2Params(
            heatmap_type=kind,
            routing_mode="walking",
            max_cost=15,
            output_path=str(work / "out.parquet"),
            **more,
        )
        with _routing(HeatmapV2Tool, _engine(compute_heatmap=_heatmap_scores)):
            path = _run(HeatmapV2Tool(), params)
        # The runner's style reads the heatmap type, the cost type and the
        # run's language from the tool's parameters.
        return Result(
            runner(),
            tool_params(
                heatmap_v2.HeatmapV2WindmillParams,
                heatmap_type=params.heatmap_type,
                routing_mode="walking",
                cost_type=params.cost_type,
                max_cost=params.max_cost,
            ),
            path,
        )

    return make


def _huff_v2(context: Context, work: Path) -> Result:
    from goatlib.analysis.accessibility.huff_model_v2 import HuffmodelV2Tool
    from goatlib.analysis.schemas.heatmap import HuffmodelV2Params
    from goatlib.tools.huff_model_v2 import (
        HuffModelV2ToolParams,
        HuffModelV2ToolRunner,
    )

    params = HuffmodelV2Params(
        routing_mode="walking",
        reference_area_path=_analysis(context, "munich_districts.geojson"),
        demand_path=_analysis(context, "census_part_munich.parquet"),
        demand_field="einwohner",
        opportunity_path=_analysis(context, "kita_part_munich.gpkg"),
        attractivity="capacity_int",
        max_cost=30,
        output_path=str(work / "out.parquet"),
    )
    with _routing(HuffmodelV2Tool, _engine(compute_travel_cost_matrix=_travel_matrix)):
        path = _run(HuffmodelV2Tool(), params)
    return Result(
        HuffModelV2ToolRunner(),
        tool_params(
            HuffModelV2ToolParams,
            demand_layer_id=U,
            opportunity_layer_id=U,
            reference_area_layer_id=U,
            routing_mode="walking",
            demand_field=params.demand_field,
            attractivity=params.attractivity,
            max_cost=params.max_cost,
        ),
        path,
    )


def _travel_cost_matrix(context: Context, work: Path) -> Result:
    from goatlib.tools.travel_cost_matrix import (
        TravelCostMatrixToolRunner,
        TravelCostMatrixWindmillParams,
    )

    # Destinations on a grid; the matrix origin by origin, each row the
    # destinations in their order, as the engine writes it; a destination
    # beyond every origin's budget has no cost.
    destinations = _write(
        work / "destinations.parquet",
        "SELECT i AS id, ST_Point(0.002 * (i % 6), 0.002 * (i // 6)) AS geometry "
        "FROM range(36) r(i)",
    )
    matrix = _write(
        work / "matrix.parquet",
        """SELECT o::VARCHAR AS origin, d::VARCHAR AS destination,
                  CASE WHEN t <= 13 THEN t END AS travel_cost
           FROM (SELECT o, d, round(2 + 1.6 * (abs(d % 6 - o) + d // 6))::INTEGER AS t
                 FROM range(3) a(o), range(36) b(d))
           ORDER BY o, d""",
    )
    out = work / "out.parquet"
    runner = TravelCostMatrixToolRunner()
    runner._build_destination_points_parquet(matrix, destinations, out)
    params = tool_params(
        TravelCostMatrixWindmillParams,
        origin_layer_id=U,
        destination_layer_id=U,
        origin_id_column="id",
        destination_id_column="id",
        routing_mode="walking",
    )
    return Result(runner, params, out)


def _trip_count(context: Context, work: Path) -> Result:
    from goatlib.analysis.accessibility.trip_count import TripCountStationTool
    from goatlib.tools.trip_count import TripCountToolParams, TripCountToolRunner

    tool = _single(TripCountStationTool())
    out = work / "out.parquet"
    try:
        # The timetable step's counts, made up: whole trip counts skewed
        # towards a few busy stations, some without service.
        tool.con.execute("""
            CREATE TABLE station_mode_counts AS
            SELECT 's' || i AS stop_id, 'Stop ' || i AS stop_name,
                   NULL::VARCHAR AS parent_station,
                   t AS bus, 0 AS tram, 0 AS metro, 0 AS rail, 0 AS other, t AS total,
                   CASE WHEN t > 0 THEN 240.0 / t END AS frequency,
                   ST_Point(0.003 * (i % 8), 0.003 * (i // 8)) AS geom
            FROM (SELECT i, (150 * pow((i * 7 % 48) / 47.0, 3))::INTEGER AS t
                  FROM range(48) r(i));
            CREATE TABLE stations_in_area AS SELECT stop_id FROM station_mode_counts;
        """)
        tool._export_results(str(out))
    finally:
        tool.cleanup()
    return Result(
        TripCountToolRunner(),
        tool_params(TripCountToolParams, reference_area_layer_id=U),
        out,
    )


# --- synthetic: the runner's output columns -----------------------------------------------------


def _catchment(kind: str) -> Callable[[Context, Path], Result]:
    """Catchment bands of 3 to 15 minutes around a point: rings of polygons,
    a network of lines, or a grid of points."""

    def make(context: Context, work: Path) -> Result:
        from goatlib.tools.catchment_area_v2 import (
            CatchmentAreaV2ToolRunner,
            CatchmentAreaV2WindmillParams,
        )

        step = "(least(ceil(r / 0.003), 5) * 3)::INTEGER"
        if kind == "polygon":
            query = """
                SELECT s::INTEGER AS id, (s * 3)::INTEGER AS cost_step,
                       ST_Difference(ST_Buffer(ST_Point(0, 0), s * 0.003),
                                     ST_Buffer(ST_Point(0, 0), (s - 1) * 0.003)) AS geometry
                FROM range(1, 6) r(s)"""
        elif kind == "network":
            query = f"""
                SELECT row_number() OVER ()::INTEGER AS id, {step} AS cost_step, geometry
                FROM (
                    SELECT ST_MakeLine(ST_Point(a * cos(k), a * sin(k)),
                                       ST_Point((a + 0.0015) * cos(k), (a + 0.0015) * sin(k)))
                               AS geometry,
                           a + 0.00075 AS r
                    FROM (SELECT j * pi() / 8 AS k FROM range(16) q(j)),
                         (SELECT i * 0.0015 AS a FROM range(10) p(i))
                )"""
        else:
            query = f"""
                SELECT row_number() OVER ()::INTEGER AS id,
                       r / 0.003 * 3 AS cost, {step} AS cost_step,
                       ST_Point(x, y) AS geometry
                FROM (SELECT x, y, sqrt(x * x + y * y) AS r
                      FROM (SELECT (i - 10) * 0.0015 AS x, (j - 10) * 0.0015 AS y
                            FROM range(21) a(i), range(21) b(j)))
                WHERE r > 0 AND r <= 0.015"""
        path = _write(work / "out.parquet", query)
        grid = {"point_grid_layer_id": U} if kind == "point_grid" else {}
        params = tool_params(
            CatchmentAreaV2WindmillParams,
            routing_mode="walking",
            starting_points={"latitude": [0.0], "longitude": [0.0]},
            catchment_area_type=kind,
            cost_type="time",
            max_cost=15,
            **grid,
        )
        return Result(CatchmentAreaV2ToolRunner(), params, path)

    return make


def _oev(layer: str) -> Callable[[Context, Path], Result]:
    def make(context: Context, work: Path) -> Result:
        from goatlib.tools.oev_gueteklassen import (
            OevGueteklassenToolParams,
            OevGueteklassenToolRunner,
        )
        from goatlib.tools.style import oev_gueteklassen_stations_style

        params = tool_params(OevGueteklassenToolParams, reference_area_layer_id=U)
        runner = OevGueteklassenToolRunner()
        if layer == "classes":
            # Classes A (best) to F as rings around a station.
            path = _write(
                work / "out.parquet",
                """SELECT c::INTEGER AS pt_class, chr((64 + c)::INTEGER) AS pt_class_label,
                          ST_Difference(ST_Buffer(ST_Point(0, 0), c * 0.0025),
                                        ST_Buffer(ST_Point(0, 0), (c - 1) * 0.0025)) AS geometry
                   FROM range(1, 7) r(c)""",
            )
            return Result(runner, params, path)
        # Stations of categories 1 to 7, and 999 for a station without
        # service, on a grid.
        path = _write(
            work / "out.parquet",
            """SELECT 's' || i AS stop_id,
                      CASE WHEN i % 8 = 7 THEN 999 ELSE i % 8 + 1 END AS station_category,
                      ST_Point(0.003 * (i % 6), 0.003 * (i // 6)) AS geometry
               FROM range(24) r(i)""",
        )
        return Result(runner, params, path, oev_gueteklassen_stations_style())

    return make


# --- patterns: made-up values through a tool's own default -------------------------------------


def _cells(work: Path, values: str, count: int, columns: str = "value") -> Path:
    """Squares on a grid around 0, 0, row by row, with `values` per square `i`
    (a SQL expression) as the column(s) `columns`."""
    side = math.ceil(math.sqrt(count))
    return _write(
        work / "cells.parquet",
        f"""SELECT {values} AS {columns},
                   ST_MakeEnvelope(0.002 * (i % {side}), 0.002 * (i // {side}),
                                   0.002 * (i % {side}) + 0.0019,
                                   0.002 * (i // {side}) + 0.0019) AS geometry
            FROM range({count}) r(i)""",
    )


def _aggregate_pattern(
    tool: str, values: str, count: int
) -> Callable[[Context, Path], Result]:
    def make(context: Context, work: Path) -> Result:
        from goatlib.analysis.schemas.aggregate import AggregationAreaType
        from goatlib.tools.aggregate_points import (
            AggregatePointsToolParams,
            AggregatePointsToolRunner,
        )
        from goatlib.tools.aggregate_polygon import (
            AggregatePolygonToolParams,
            AggregatePolygonToolRunner,
        )

        statistic = {"operation": "sum", "field": "value"}
        if tool == "aggregate_points":
            runner, params_class, column = (
                AggregatePointsToolRunner,
                AggregatePointsToolParams,
                "value_sum",
            )
        else:
            runner, params_class, column = (
                AggregatePolygonToolRunner,
                AggregatePolygonToolParams,
                "sum_value",
            )
        params = tool_params(
            params_class,
            source_layer_id=U,
            area_layer_id=U,
            area_type=AggregationAreaType.polygon,
            column_statistics=[statistic],
        )
        return Result(runner(), params, _cells(work, values, count, column))

    return make


def _heatmap_pattern(
    tool: str, values: str, count: int
) -> Callable[[Context, Path], Result]:
    def make(context: Context, work: Path) -> Result:
        from goatlib.tools.heatmap_2sfca import Heatmap2SFCAToolRunner
        from goatlib.tools.heatmap_gravity import HeatmapGravityToolRunner

        runner = {
            "heatmap_2sfca_legacy": Heatmap2SFCAToolRunner,
            "heatmap_gravity_legacy": HeatmapGravityToolRunner,
        }[tool]
        # These runners' styles read only the run's language from their
        # parameters.
        return Result(
            runner(),
            tool_params(ToolInputBase),
            _cells(work, values, count, "total_accessibility"),
        )

    return make


def _clusters_pattern(context: Context, work: Path) -> Result:
    from goatlib.tools.spatial_clustering import (
        ClusteringZonesToolParams,
        ZonesClusteringToolRunner,
    )

    path = _write(
        work / "out.parquet",
        """SELECT i % 20 AS cluster_id,
                  ST_Point(0.003 * (i % 20 % 5) + 0.0004 * (i // 20 % 3),
                           0.003 * (i % 20 // 5) + 0.0004 * (i // 60)) AS geometry
           FROM range(180) r(i)""",
    )
    params = tool_params(ClusteringZonesToolParams, input_layer_id=U, nb_cluster=20)
    return Result(ZonesClusteringToolRunner(), params, path)


# --- the cases ----------------------------------------------------------------------------------

_POINTS = ("vector/overlay_points.parquet",)
_POLYGONS = ("vector/overlay_polygons.parquet", "vector/overlay_boundary.parquet")
_OD = ("vector/zipcode_point.parquet", "vector/origin_destination_matrix.parquet")
_MATRICES = "walking travel time matrices (downloaded by tests/conftest.py)"

CASES: list[Case] = [
    Case(
        "buffer",
        "buffer",
        "result",
        "Buffers of 500, 1,000 and 1,500 m around ten zip code points",
        "one band per distance, labels in m, the smallest ring on top",
        "analysis",
        ("vector/zipcode_point.parquet",),
        True,
        _buffer,
    ),
    Case(
        "clip",
        "clip",
        "result",
        "Polygons clipped by a boundary",
        "plain, the new layer's color",
        "analysis",
        _POLYGONS,
        True,
        _overlay("clip"),
    ),
    Case(
        "centroid",
        "centroid",
        "result",
        "Centroids of polygons",
        "plain",
        "analysis",
        _POLYGONS[:1],
        False,
        _overlay("centroid"),
    ),
    Case(
        "intersection",
        "intersection",
        "result",
        "Polygons intersected with a boundary",
        "plain",
        "analysis",
        _POLYGONS,
        False,
        _overlay("intersection"),
    ),
    Case(
        "union",
        "union",
        "result",
        "Polygons united with themselves",
        "plain",
        "analysis",
        _POLYGONS[:1],
        False,
        _overlay("union"),
    ),
    Case(
        "difference",
        "difference",
        "result",
        "Polygons minus a boundary",
        "plain",
        "analysis",
        _POLYGONS,
        False,
        _overlay("difference"),
    ),
    Case(
        "dissolve",
        "dissolve",
        "result",
        "Polygons dissolved by type, with the sum of a value",
        "the sum classified, one class per value where values are few",
        "analysis",
        _POLYGONS[:1],
        True,
        _dissolve,
    ),
    Case(
        "dissolve-groups",
        "dissolve",
        "result",
        "Polygons dissolved by type, without statistics",
        "one color per group",
        "analysis",
        _POLYGONS[:1],
        True,
        _dissolve_groups,
    ),
    Case(
        "join",
        "join",
        "result",
        "Points joined onto polygons, counting the points in each",
        "the count classified in orange",
        "analysis",
        (_POLYGONS[0], _POINTS[0]),
        True,
        _join,
    ),
    Case(
        "merge",
        "merge",
        "result",
        "Two point layers merged",
        "plain",
        "analysis",
        ("vector/merge_points_1.parquet", "vector/merge_points_2.parquet"),
        False,
        _merge,
    ),
    Case(
        "origin-destination-lines",
        "origin_destination",
        "lines",
        "Flows between ten zip code points",
        "line widths and colors by the flow's weight",
        "analysis",
        _OD,
        True,
        _od("lines"),
    ),
    Case(
        "origin-destination-points",
        "origin_destination",
        "points",
        "The zip code points of the flows, sized by the weight that arrives",
        "marker sizes and colors by weight",
        "analysis",
        _OD,
        True,
        _od("points"),
    ),
    Case(
        "aggregate-points",
        "aggregate_points",
        "result",
        "Points counted onto ten zip code areas",
        "the count classified in orange, title Count",
        "analysis",
        ("vector/points_with_category.parquet", "vector/zipcode_polygon.parquet"),
        True,
        _aggregate_points,
    ),
    Case(
        "aggregate-points-mean",
        "aggregate_points",
        "result",
        "The mean value of filtered points per zip code area; three areas hold none",
        "the mean classified in orange, areas without points grey as no data",
        "analysis",
        ("vector/points_with_category.parquet", "vector/zipcode_polygon.parquet"),
        True,
        # Three zip code areas hold none of these points.
        _mean_onto_zip_codes(
            "points_with_category.parquet",
            "WHERE category = 'third_category' AND value >= 75",
            "value",
        ),
    ),
    Case(
        "aggregate-points-mean-one-value",
        "aggregate_points",
        "result",
        "The mean value of one point per zip code area; nine areas hold none",
        "one orange class for the one value, areas without points grey as no data",
        "analysis",
        ("vector/points_with_category.parquet", "vector/zipcode_polygon.parquet"),
        True,
        _mean_onto_zip_codes(
            "points_with_category.parquet", "ORDER BY value DESC LIMIT 1", "value"
        ),
    ),
    Case(
        "aggregate-points-mean-no-value",
        "aggregate_points",
        "result",
        "The mean enrollment of schools per zip code area; no school lies in one",
        "every area grey as no data",
        "analysis",
        ("vector/schools.parquet", "vector/zipcode_polygon.parquet"),
        True,
        _mean_onto_zip_codes("schools.parquet", "", "enrollment"),
    ),
    Case(
        "aggregate-polygon",
        "aggregate_polygon",
        "result",
        "Green areas summed onto ten zip code areas",
        "the sum classified in orange",
        "analysis",
        (
            "analysis/aggregate/green_areas.parquet",
            "analysis/aggregate/zipcode_polygon.parquet",
        ),
        True,
        _aggregate_polygon,
    ),
    Case(
        "geocoding",
        "geocoding",
        "result",
        "Addresses geocoded by a mocked geocoding service",
        "fixed blue markers",
        "analysis",
        (),
        True,
        _geocoding,
    ),
    Case(
        "clustering-points",
        "spatial_clustering",
        "points",
        "Childcare points in ten zones (k-means, seeded)",
        "one color per zone",
        "analysis",
        ("analysis/kita_part_munich.gpkg",),
        True,
        _clustering("points"),
    ),
    Case(
        "clustering-summary",
        "spatial_clustering",
        "summary",
        "One multi-point per zone: the zone's points as one feature",
        "one color per zone, as the points",
        "analysis",
        ("analysis/kita_part_munich.gpkg",),
        True,
        _clustering("summary"),
    ),
    Case(
        "heatmap-gravity-legacy",
        "heatmap_gravity_legacy",
        "result",
        "Gravity accessibility of markets on the walking matrices",
        "accessibility in green, title and decimals",
        "analysis",
        ("analysis/de_weihnachsmaerkte_25.gpkg", _MATRICES),
        True,
        _gravity_legacy,
        matrices=True,
    ),
    Case(
        "heatmap-closest-average-legacy",
        "heatmap_closest_average_legacy",
        "result",
        "Average walking time to the three closest markets",
        "the ramp reversed, the nearest darkest, labels in min",
        "analysis",
        ("analysis/de_weihnachsmaerkte_25.gpkg", _MATRICES),
        True,
        _closest_average_legacy,
        matrices=True,
    ),
    Case(
        "heatmap-connectivity-legacy",
        "heatmap_connectivity_legacy",
        "result",
        "Area reached within 20 minutes' walk from each cell of the districts",
        "labels in m², grouped digits",
        "analysis",
        ("analysis/munich_districts.geojson", _MATRICES),
        True,
        _connectivity_legacy,
        matrices=True,
    ),
    Case(
        "heatmap-2sfca-legacy",
        "heatmap_2sfca_legacy",
        "result",
        "Childcare places per resident within 30 minutes' walk (2SFCA)",
        "small ratios with readable low classes",
        "analysis",
        (
            "analysis/kita_part_munich.gpkg",
            "analysis/census_part_munich.parquet",
            _MATRICES,
        ),
        True,
        _two_sfca_legacy,
        matrices=True,
    ),
    Case(
        "huff-legacy",
        "huff_model_legacy",
        "result",
        "Market shares of childcare facilities (Huff model)",
        "shares in %",
        "analysis",
        (
            "analysis/kita_part_munich.gpkg",
            "analysis/census_part_munich.parquet",
            "analysis/munich_districts.geojson",
            _MATRICES,
        ),
        True,
        _huff_legacy,
        matrices=True,
    ),
    Case(
        "heatmap-gravity",
        "heatmap_gravity",
        "result",
        "Gravity accessibility of four made-up places, after a made-up engine output",
        "accessibility in green, as the first runner",
        "after_engine",
        (),
        True,
        _heatmap_v2("gravity"),
    ),
    Case(
        "heatmap-closest-average",
        "heatmap_closest_average",
        "result",
        "Average walking time to the two closest places, over a reference area the engine "
        "does not reach everywhere",
        "the ramp reversed, labels in min, unreached cells grey as No data",
        "after_engine",
        (),
        True,
        _heatmap_v2("closest_average"),
    ),
    Case(
        "heatmap-connectivity",
        "heatmap_connectivity",
        "result",
        "Area reached from each cell of a made-up reference area",
        "labels in m²",
        "after_engine",
        (),
        True,
        _heatmap_v2("connectivity"),
    ),
    Case(
        "heatmap-2sfca",
        "heatmap_2sfca",
        "result",
        "Capacity of four made-up places per resident around them (2SFCA)",
        "small ratios with decimals",
        "after_engine",
        (),
        True,
        _heatmap_v2("two_sfca"),
    ),
    Case(
        "huff",
        "huff_model",
        "result",
        "Market shares of childcare facilities, on made-up walking times",
        "shares in %",
        "after_engine",
        (
            "analysis/kita_part_munich.gpkg",
            "analysis/census_part_munich.parquet",
            "analysis/munich_districts.geojson",
        ),
        True,
        _huff_v2,
    ),
    Case(
        "travel-cost-matrix-destinations",
        "travel_cost_matrix",
        "destinations",
        "Destination points with the average walking time from three origins",
        "the ramp reversed, the nearest darkest, labels in min, unreached grey",
        "after_engine",
        (),
        True,
        _travel_cost_matrix,
    ),
    Case(
        "trip-count",
        "trip_count",
        "result",
        "Stations with their whole trip counts, skewed towards a few busy ones",
        "trips classified in purple, whole-number labels",
        "after_engine",
        (),
        True,
        _trip_count,
    ),
    Case(
        "catchment-polygons",
        "catchment_area_v2",
        "result",
        "Five catchment bands of 3 to 15 minutes around a point",
        "one band per step, the nearest darkest, labels in min",
        "synthetic",
        (),
        True,
        _catchment("polygon"),
        predicted=True,
    ),
    Case(
        "oev-gueteklassen-classes",
        "oev_gueteklassen",
        "classes",
        "Public transport quality classes A to F as rings around a station",
        "one color per class, title only",
        "synthetic",
        (),
        True,
        _oev("classes"),
        predicted=True,
    ),
    Case(
        "oev-gueteklassen-stations",
        "oev_gueteklassen",
        "stations",
        "Stations of categories 1 to 7 and one without service",
        "black markers, grey without service",
        "synthetic",
        (),
        True,
        _oev("stations"),
    ),
    Case(
        "pattern-half-zeros",
        "aggregate_points",
        "result",
        "Half of the areas hold no point, the rest a long tail",
        "how zeros and a long tail share the classes",
        "pattern",
        (),
        True,
        _aggregate_pattern(
            "aggregate_points",
            "CASE WHEN i < 20 THEN 0 ELSE round(pow(1.25, i - 20))::INTEGER END",
            40,
        ),
    ),
    Case(
        "pattern-three-districts",
        "aggregate_polygon",
        "result",
        "Three districts, each with its own sum",
        "a quantile class per value, labelled as a range",
        "pattern",
        (),
        True,
        _aggregate_pattern("aggregate_polygon", "[120, 450, 980][i + 1]", 3),
    ),
    Case(
        "pattern-constant",
        "heatmap_2sfca_legacy",
        "result",
        "Every cell holds the same ratio",
        "one value drawn in one color",
        "pattern",
        (),
        True,
        _heatmap_pattern("heatmap_2sfca_legacy", "0.087", 30),
    ),
    Case(
        "pattern-dominant-maximum",
        "heatmap_gravity_legacy",
        "result",
        "Most cells hold the highest score, a few spread below it",
        "the top class and how the rest spread",
        "pattern",
        (),
        True,
        _heatmap_pattern(
            "heatmap_gravity_legacy", "CASE WHEN i < 30 THEN 12.5 ELSE i * 0.2 END", 48
        ),
    ),
    Case(
        "pattern-tiny-values",
        "heatmap_2sfca_legacy",
        "result",
        "Ratios around 0.0001",
        "labels that tell the classes apart",
        "pattern",
        (),
        True,
        _heatmap_pattern("heatmap_2sfca_legacy", "0.00005 + i * 0.000004", 40),
    ),
    Case(
        "pattern-signed",
        "aggregate_polygon",
        "result",
        "Sums below and above zero",
        "the sequential palette over negative and positive sums",
        "pattern",
        (),
        True,
        _aggregate_pattern("aggregate_polygon", "(i - 14) * 35", 36),
    ),
    Case(
        "pattern-catchment-point-grid",
        "catchment_area_v2",
        "result",
        "A catchment as a grid of points",
        "markers in the band colors",
        "pattern",
        (),
        True,
        _catchment("point_grid"),
        predicted=True,
    ),
    Case(
        "pattern-catchment-network",
        "catchment_area_v2",
        "result",
        "A catchment as a street network",
        "lines in the band colors",
        "pattern",
        (),
        True,
        _catchment("network"),
        predicted=True,
    ),
    Case(
        "pattern-twenty-clusters",
        "spatial_clustering",
        "points",
        "Twenty zones, more than the palette's colors",
        "how the colors repeat",
        "pattern",
        (),
        True,
        _clusters_pattern,
    ),
]
