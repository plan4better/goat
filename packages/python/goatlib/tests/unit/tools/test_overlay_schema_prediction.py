"""The overlay tools' predicted output schemas match what a run writes.

processes checks a workflow's later steps' field settings against the
predicted columns, and the workflow editor lists them in its field pickers, so
a name the run writes differently warns about a field the step will have and
lets one through that it will not. Each case runs the tool runner's
``process`` on small fixtures, with the layer export answered by the fixture
files, and compares the written columns, in order and with their types, with
``predict_output_schema`` given the fixtures' schemas and the node
configuration. The ``bbox`` struct every GeoParquet write adds is storage
detail (see ``goatlib.io.bbox_columns``) and not compared.
"""

from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.io.bbox_columns import is_bbox_struct
from goatlib.tools.clip import ClipToolParams, ClipToolRunner
from goatlib.tools.difference import DifferenceToolParams, DifferenceToolRunner
from goatlib.tools.intersection import IntersectionToolParams, IntersectionToolRunner
from goatlib.tools.union import UnionToolParams, UnionToolRunner

INPUT = "00000000-0000-0000-0000-000000000003"
OVERLAY = "00000000-0000-0000-0000-000000000004"
IDS = {
    "user_id": "00000000-0000-0000-0000-000000000001",
    "folder_id": "00000000-0000-0000-0000-000000000002",
    "input_layer_id": INPUT,
}
TWO_LAYERS = {**IDS, "overlay_layer_id": OVERLAY}

# The names processes treats as a layer's geometry (`GEOMETRY_COLUMNS`).
GEOMETRY_NAMES = ("geometry", "geom")


@pytest.fixture
def layers(tmp_path: Path) -> dict[str, Path]:
    """Two input squares, both crossed by one overlay polygon. The input's
    geometry is not its last column and one of its fields is named like a
    prefixed overlay field; the overlay shares ``id`` and ``name`` with it
    and calls its geometry ``geom``."""
    input_path = tmp_path / "input.parquet"
    overlay_path = tmp_path / "overlay.parquet"
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    try:
        con.execute(f"""
            COPY (
                SELECT * FROM (VALUES
                    (1, ST_GeomFromText('POLYGON((0 0, 2 0, 2 2, 0 2, 0 0))'),
                     'a', 1.5::DECIMAL(4, 1), 'x'),
                    (2, ST_GeomFromText('POLYGON((3 0, 5 0, 5 2, 3 2, 3 0))'),
                     'b', 2.5::DECIMAL(4, 1), 'y')
                ) t(id, geometry, name, score, intersection_name)
            ) TO '{input_path}' (FORMAT PARQUET)
        """)
        con.execute(f"""
            COPY (
                SELECT * FROM (VALUES
                    (10, 'zone', 7::BIGINT,
                     ST_GeomFromText('POLYGON((1 1, 4 1, 4 3, 1 3, 1 1))'))
                ) t(id, name, pop, geom)
            ) TO '{overlay_path}' (FORMAT PARQUET)
        """)
    finally:
        con.close()
    return {INPUT: input_path, OVERLAY: overlay_path}


def _describe(path: Path) -> list[tuple[str, str]]:
    """A parquet file's columns and their types."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    try:
        rows = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()
    finally:
        con.close()
    return [(r[0], r[1]) for r in rows]


def _columns(path: Path) -> list[tuple[str, str]]:
    """A result's columns and their types, its bbox struct left out."""
    return [
        (name, dtype) for name, dtype in _describe(path) if not is_bbox_struct(dtype)
    ]


def _run(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    runner: Any,
    params: Any,
    layers: dict[str, Path],
) -> list[tuple[str, str]]:
    """The columns ``runner.process`` writes, reading each layer from its
    fixture file."""
    monkeypatch.setattr(
        runner,
        "export_layer_to_parquet",
        lambda layer_id, user_id, cql_filter=None: str(layers[layer_id]),
    )
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    result_path, _ = runner.process(params, out_dir)
    return _columns(Path(result_path))


def _schemas(layers: dict[str, Path], *ids: str) -> dict[str, dict[str, str]]:
    keys = {INPUT: "input_layer_id", OVERLAY: "overlay_layer_id"}
    return {keys[i]: dict(_describe(layers[i])) for i in ids}


def _names_only(schema: dict[str, str]) -> dict[str, str]:
    """A schema as processes knows it: the names, sorted, the geometry typed
    ``GEOMETRY`` and every other column ``VARCHAR``."""
    return {
        name: "GEOMETRY" if name in GEOMETRY_NAMES else "VARCHAR"
        for name in sorted(schema)
    }


INTERSECTION_CASES = [
    ("default prefix", {}),
    ("prefix set to None", {"overlay_fields_prefix": None}),
    ("empty prefix", {"overlay_fields_prefix": ""}),
    ("own prefix", {"overlay_fields_prefix": "o_"}),
    ("input fields in the list's order", {"input_fields": ["score", "id"]}),
    ("input fields naming the geometry", {"input_fields": ["geometry", "name"]}),
    ("overlay fields in the list's order", {"overlay_fields": ["pop", "name"]}),
    ("overlay fields naming only the geometry", {"overlay_fields": ["geom"]}),
    ("empty field lists take every field", {"input_fields": [], "overlay_fields": []}),
]


@pytest.mark.parametrize(
    "config", [c[1] for c in INTERSECTION_CASES], ids=[c[0] for c in INTERSECTION_CASES]
)
def test_intersection_prediction_matches_the_written_columns(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    layers: dict[str, Path],
    config: dict[str, Any],
) -> None:
    written = _run(
        monkeypatch,
        tmp_path,
        IntersectionToolRunner(),
        IntersectionToolParams(**TWO_LAYERS, **config),
        layers,
    )
    predicted = IntersectionToolRunner.predict_output_schema(
        _schemas(layers, INPUT, OVERLAY), config
    )

    assert list(predicted.items()) == written


def test_intersection_overlay_fields_carry_the_prefix_without_a_collision(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, layers: dict[str, Path]
) -> None:
    """The case behind this test: the workflow check warned about a later
    step's ``intersection_pop``, and let ``pop`` through to fail the run."""
    written = _run(
        monkeypatch,
        tmp_path,
        IntersectionToolRunner(),
        IntersectionToolParams(**TWO_LAYERS),
        layers,
    )
    predicted = IntersectionToolRunner.predict_output_schema(
        _schemas(layers, INPUT, OVERLAY), {}
    )

    assert "intersection_pop" in dict(written)
    assert "intersection_pop" in predicted
    assert "pop" not in predicted


def test_intersection_predicts_the_written_names_from_names_alone(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, layers: dict[str, Path]
) -> None:
    """processes knows only its steps' field names, and adds the tool's
    defaults to the node's configuration."""
    written = _run(
        monkeypatch,
        tmp_path,
        IntersectionToolRunner(),
        IntersectionToolParams(**TWO_LAYERS),
        layers,
    )
    schemas = _schemas(layers, INPUT, OVERLAY)
    predicted = IntersectionToolRunner.predict_output_schema(
        {key: _names_only(schema) for key, schema in schemas.items()},
        {
            "input_fields": None,
            "overlay_fields": None,
            "overlay_fields_prefix": "intersection_",
        },
    )

    assert set(predicted) == {name for name, _ in written}


def test_intersection_leaves_out_a_stray_bbox_struct(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, layers: dict[str, Path]
) -> None:
    """Data written by older versions carries a second bbox struct, which the
    result's writer drops."""
    stray = tmp_path / "input_with_stray_bbox.parquet"
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    try:
        con.execute(f"""
            COPY (
                SELECT *, {{
                    'xmin': ST_XMin(geometry), 'ymin': ST_YMin(geometry),
                    'xmax': ST_XMax(geometry), 'ymax': ST_YMax(geometry)
                }} AS bbox_1
                FROM read_parquet('{layers[INPUT]}')
            ) TO '{stray}' (FORMAT PARQUET)
        """)
    finally:
        con.close()
    layers = {**layers, INPUT: stray}
    written = _run(
        monkeypatch,
        tmp_path,
        IntersectionToolRunner(),
        IntersectionToolParams(**TWO_LAYERS),
        layers,
    )
    predicted = IntersectionToolRunner.predict_output_schema(
        _schemas(layers, INPUT, OVERLAY), {}
    )

    assert "bbox_1" in _schemas(layers, INPUT)["input_layer_id"]
    assert list(predicted.items()) == written


@pytest.mark.parametrize(
    "runner",
    [IntersectionToolRunner, UnionToolRunner, ClipToolRunner, DifferenceToolRunner],
    ids=["intersection", "union", "clip", "difference"],
)
def test_an_unknown_input_layer_predicts_nothing(runner: Any) -> None:
    """Without the input layer's columns the result's are unknown too, which
    the callers read from an empty prediction."""
    overlay = {"id": "INTEGER", "geom": "GEOMETRY"}

    assert runner.predict_output_schema({"overlay_layer_id": overlay}, {}) == {}
    assert (
        runner.predict_output_schema(
            {"input_layer_id": {}, "overlay_layer_id": overlay}, {}
        )
        == {}
    )


UNION_CASES = [
    ("no prefix by default", {}),
    ("prefix set to None", {"overlay_fields_prefix": None}),
    ("own prefix", {"overlay_fields_prefix": "o_"}),
]


@pytest.mark.parametrize(
    "config", [c[1] for c in UNION_CASES], ids=[c[0] for c in UNION_CASES]
)
def test_union_prediction_matches_the_written_columns(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    layers: dict[str, Path],
    config: dict[str, Any],
) -> None:
    """Names and order. The types are not compared: the run fills the fields
    of the side a part lacks with untyped NULLs, which widens narrow types
    (``DECIMAL(4,1)`` to ``DECIMAL(11,1)``, ``BOOLEAN`` to ``INTEGER``)."""
    written = _run(
        monkeypatch,
        tmp_path,
        UnionToolRunner(),
        UnionToolParams(**TWO_LAYERS, **config),
        layers,
    )
    predicted = UnionToolRunner.predict_output_schema(
        _schemas(layers, INPUT, OVERLAY), config
    )

    assert list(predicted) == [name for name, _ in written]


def test_union_without_an_overlay_predicts_the_written_columns(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, layers: dict[str, Path]
) -> None:
    """A union of the input with itself writes a feature id and the pieces'
    geometry, none of the input's fields."""
    written = _run(
        monkeypatch, tmp_path, UnionToolRunner(), UnionToolParams(**IDS), layers
    )
    predicted = UnionToolRunner.predict_output_schema(_schemas(layers, INPUT), {})

    assert list(predicted.items()) == written


@pytest.mark.parametrize(
    ("runner", "params"),
    [
        (ClipToolRunner, ClipToolParams),
        (DifferenceToolRunner, DifferenceToolParams),
    ],
    ids=["clip", "difference"],
)
def test_clip_and_difference_predictions_match_the_written_columns(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    layers: dict[str, Path],
    runner: Any,
    params: Any,
) -> None:
    """The input's fields keep their names and types; the geometry is
    written last."""
    written = _run(monkeypatch, tmp_path, runner(), params(**TWO_LAYERS), layers)
    predicted = runner.predict_output_schema(_schemas(layers, INPUT, OVERLAY), {})

    assert list(predicted.items()) == written
