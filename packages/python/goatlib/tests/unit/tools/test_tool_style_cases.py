"""The tool results the style lab draws (`tool_style_cases.py`): current,
repeatable, within the style contract, small, and one for every analysis
tool.

Rewrite the snapshots after changing a tool's style, its result or the cases:

    GOAT_WRITE_FIXTURES=1 uv run pytest tests/unit/tools/test_tool_style_cases.py

then `pnpm --filter @p4b/web lab:update` for the pictures of the cases that changed.

Every case is built twice, once per test session: the first worker of a
parallel run that asks builds them into the session's shared temporary folder
under a file lock, the others read what it wrote.
"""

import fcntl
import json
import os
import tempfile
import traceback
from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.style.data_check import referenced_fields
from goatlib.tools.aggregate_points import AggregatePointsToolRunner
from goatlib.tools.registry import TOOL_REGISTRY
from goatlib.utils.column_types import column_types, type_class

from .tool_style_cases import (
    CASES,
    FIXTURES,
    MAX_BYTES,
    MAX_FEATURES,
    Case,
    Context,
    _window,
    build,
    dump,
    feature_limit,
)

#: Analysis tools without a case, and why. Custom SQL runs in workflows
#: (the toolbox hides it).
WITHOUT_CASE = {
    "custom_sql": "no style of its own; its result is checked in the chain tests",
}

BY_ID = {case.id: case for case in CASES}
EACH = pytest.mark.parametrize("case_id", list(BY_ID))


def _build_all(request: pytest.FixtureRequest, data: Path, work: Path) -> dict:
    """Every case built twice, as committed text, or the error that stopped
    it. The walking matrices are asked for only by the cases that read them,
    so a failed download fails those alone."""
    matrices: Path | None = None
    missing: str | None = None
    out: dict[str, dict[str, str]] = {}
    for case in CASES:
        if case.matrices and matrices is None and missing is None:
            try:
                matrices = request.getfixturevalue("walking_matrix_dir")
            except Exception:
                missing = traceback.format_exc()
        if case.matrices and missing is not None:
            out[case.id] = {"error": f"The walking matrices are missing:\n{missing}"}
            continue
        context = Context(data=data, work=work, walking_matrices=matrices)
        try:
            out[case.id] = {
                "first": dump(build(case, context)),
                "second": dump(build(case, context)),
            }
        except Exception:
            out[case.id] = {"error": traceback.format_exc()}
    return out


@pytest.fixture(scope="session")
def built(
    request: pytest.FixtureRequest,
    tmp_path_factory: pytest.TempPathFactory,
    data_root: Path,
) -> dict[str, dict[str, str]]:
    root = tmp_path_factory.getbasetemp()
    if os.environ.get("PYTEST_XDIST_WORKER"):
        root = root.parent
    store = root / "tool_style_cases.json"
    with open(root / "tool_style_cases.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not store.exists():
            work = Path(tempfile.mkdtemp(prefix="tool_styles-", dir=root))
            built = _build_all(request, data_root, work)
            store.write_text(json.dumps(built))
    return json.loads(store.read_text())


def _snapshot(built: dict[str, dict[str, str]], case_id: str, which: str) -> str:
    outcome = built[case_id]
    if "error" in outcome:
        pytest.fail(f"Case {case_id} could not be built:\n{outcome['error']}")
    return outcome[which]


def _differences(old: str, new: str) -> str:
    """The keys of two snapshots that differ, and the first feature that does."""
    a, b = json.loads(old), json.loads(new)
    keys = [k for k in sorted({*a, *b}) if a.get(k) != b.get(k)]
    lines = [f"keys that differ: {', '.join(keys)}"]
    if "style" in keys:
        style = [
            k
            for k in sorted({*a["style"], *b["style"]})
            if a["style"].get(k) != b["style"].get(k)
        ]
        lines.append(f"style keys that differ: {', '.join(style)}")
    if "features" in keys:
        fa, fb = a["features"]["features"], b["features"]["features"]
        first = next(
            (i for i, (x, y) in enumerate(zip(fa, fb)) if x != y), min(len(fa), len(fb))
        )
        lines.append(
            f"features: {len(fa)} and {len(fb)}, the first to differ is #{first}"
        )
    return "\n".join(lines)


@EACH
def test_the_snapshot_is_current(
    built: dict[str, dict[str, str]], case_id: str
) -> None:
    text = _snapshot(built, case_id, "first")
    path = FIXTURES / f"{case_id}.json"
    if os.environ.get("GOAT_WRITE_FIXTURES"):
        FIXTURES.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    assert (
        path.exists()
    ), f"{case_id}: no snapshot; rewrite them (GOAT_WRITE_FIXTURES=1)"
    committed = path.read_text()
    # Failed by hand: pytest's own diff of two long texts takes seconds and
    # says less than the keys that differ.
    if committed != text:
        pytest.fail(
            f"{case_id}: the snapshot is stale; rewrite it (GOAT_WRITE_FIXTURES=1)\n"
            + _differences(committed, text)
        )


def test_the_folder_holds_one_snapshot_per_case() -> None:
    if os.environ.get("GOAT_WRITE_FIXTURES"):
        for old in FIXTURES.glob("*.json"):
            if old.stem not in BY_ID:
                old.unlink()
    assert sorted(p.stem for p in FIXTURES.glob("*.json")) == sorted(BY_ID)


@EACH
def test_a_second_build_is_the_same(
    built: dict[str, dict[str, str]], case_id: str
) -> None:
    first = _snapshot(built, case_id, "first")
    second = _snapshot(built, case_id, "second")
    if first != second:
        pytest.fail(f"{case_id}: two builds differ\n" + _differences(first, second))


@EACH
def test_every_allowed_design_note_still_occurs(
    built: dict[str, dict[str, str]], case_id: str
) -> None:
    # A case may break a design rule of the contract only where it names that
    # rule; an allowance no longer needed is taken out.
    snapshot = json.loads(_snapshot(built, case_id, "first"))
    assert set(snapshot["contract"]) == set(BY_ID[case_id].allow)


@EACH
def test_the_snapshot_is_small_and_holds_only_the_styled_fields(
    built: dict[str, dict[str, str]], case_id: str
) -> None:
    text = _snapshot(built, case_id, "first")
    snapshot = json.loads(text)
    assert len(text.encode()) <= MAX_BYTES
    fields = referenced_fields(snapshot["style"])
    assert set(snapshot["fields"]) == fields
    features = snapshot["features"]["features"]
    assert len(features) == snapshot["rows"]["kept"]
    assert snapshot["rows"]["kept"] <= feature_limit(snapshot["geometry"])
    assert snapshot["rows"]["kept"] <= snapshot["rows"]["total"]
    assert all(set(f["properties"]) <= fields for f in features)


@EACH
def test_the_result_lies_around_0_0(
    built: dict[str, dict[str, str]], case_id: str
) -> None:
    snapshot = json.loads(_snapshot(built, case_id, "first"))
    xs, ys = [], []
    for feature in snapshot["features"]["features"]:
        for x, y in _coordinates(feature["geometry"]["coordinates"]):
            xs.append(x)
            ys.append(y)
    assert abs(min(xs) + max(xs)) < 1e-3 and abs(min(ys) + max(ys)) < 1e-3


def _coordinates(node: Any) -> list[tuple[float, float]]:
    if isinstance(node[0], (int, float)):
        return [(node[0], node[1])]
    return [xy for child in node for xy in _coordinates(child)]


@pytest.mark.parametrize("case_id", [case.id for case in CASES if case.predicted])
def test_a_made_up_result_has_the_columns_the_tool_predicts(
    data_root: Path, tmp_path: Path, case_id: str
) -> None:
    case = BY_ID[case_id]
    result = case.make(Context(data=data_root, work=tmp_path), tmp_path)
    con = duckdb.connect()
    try:
        con.execute("LOAD spatial")
        written = column_types(con, f"read_parquet('{result.path}')")
    finally:
        con.close()
    predicted = result.runner.predict_output_schema({}, result.params.model_dump())

    def kinds(columns: dict[str, str]) -> dict[str, str]:
        # The geometry by its kind: the file's type carries its reference system.
        return {
            name: "GEOMETRY" if type_class(t) == "geometry" else t
            for name, t in columns.items()
        }

    assert kinds(written) == kinds(predicted)


def test_a_changed_tool_style_fails_the_check(
    data_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    own = AggregatePointsToolRunner.get_layer_style

    def other_palette(self: Any, *args: Any) -> Any:
        style = own(self, *args)
        style["classify"][0]["palette"] = "colorbrewer:Blues"
        return style

    monkeypatch.setattr(AggregatePointsToolRunner, "get_layer_style", other_palette)
    snapshot = build(BY_ID["aggregate-points"], Context(data=data_root, work=tmp_path))
    assert snapshot["style"]["classify"][0]["palette"] == "colorbrewer:Blues"
    assert (FIXTURES / "aggregate-points.json").read_text() != dump(snapshot)


def test_every_case_names_a_tool_of_the_registry() -> None:
    names = {tool.name for tool in TOOL_REGISTRY}
    assert {case.id: case.tool for case in CASES if case.tool not in names} == {}


def test_every_analysis_tool_has_a_case() -> None:
    # Every analysis tool, also one the toolbox hides; the data tools
    # (category `data`) write no result of their own to style.
    offered = {tool.name for tool in TOOL_REGISTRY if tool.category != "data"}
    with_case = {case.tool for case in CASES}
    assert offered - with_case - set(WITHOUT_CASE) == set()
    # An exemption names a tool of the registry that has no case.
    assert set(WITHOUT_CASE) <= {tool.name for tool in TOOL_REGISTRY} - with_case


def test_case_ids_and_cases_agree() -> None:
    assert len(BY_ID) == len(CASES)
    assert all(isinstance(case, Case) for case in CASES)


def _rows(places: list[tuple[float, float]]) -> list[dict[str, Any]]:
    return [{"cx": x, "cy": y, "properties": {}} for x, y in places]


def test_a_window_over_more_features_on_one_spot_than_the_limit_keeps_the_limit() -> (
    None
):
    rows = _rows([(5.0, 5.0)] * (MAX_FEATURES + 20))
    assert len(_window(rows, lambda properties: None, MAX_FEATURES)) == MAX_FEATURES


def test_crowds_larger_than_the_limit_keep_the_features_nearest_the_middle() -> None:
    # No window holds from 1 to the limit of features: the middle lies at 15.
    crowds = [(x, 0.0) for x in (0.0, 10.0, 30.0) for _ in range(MAX_FEATURES + 20)]
    kept = _window(_rows(crowds), lambda properties: None, MAX_FEATURES)
    assert len(kept) == MAX_FEATURES
    assert {r["cx"] for r in kept} == {10.0}


def test_points_keep_more_features_than_lines_and_polygons() -> None:
    assert feature_limit("point") > feature_limit("polygon") == MAX_FEATURES
    assert feature_limit("line") == MAX_FEATURES
    spread = _rows([(float(i), float(i % 7)) for i in range(MAX_FEATURES + 20)])
    assert len(_window(spread, lambda p: None, feature_limit("point"))) == len(spread)
