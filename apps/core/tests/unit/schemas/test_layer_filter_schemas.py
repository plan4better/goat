"""The layer filter in `layer_project.query`: its schema and the check on save.

The schema runs on every read too, so it refuses only what the parser cannot
read: a filter saved over a limit, or with an operator the checker no longer
takes, still loads. A save that changes the filter is checked as a new filter
(`query_save_errors`); a save that leaves it as it was is not checked again.
No test here touches a database.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from core.schemas.common import (
    QUERY_UI_MAX_BYTES,
    CQLQuery,
    CQLQueryObject,
    query_save_errors,
)
from goatlib.filter.issues import CODES
from goatlib.filter.limits import MAX_CONDITIONS, MAX_POINTS
from pydantic import ValidationError

CASES = json.loads(
    (
        Path(__file__).resolve().parents[5]
        / "packages/python/goatlib/tests/unit/filter/fixtures/filter_cases.json"
    ).read_text()
)
ERROR_FREE = [
    c
    for c in CASES
    if isinstance(c["cql"], dict)
    and not any(CODES[code] == "error" for code in c["issues"])
]
LIMIT_CODES = {
    "too_many_conditions",
    "too_many_values",
    "too_deep",
    "too_many_shapes",
    "area_too_detailed",
    "area_crosses_itself",
    "too_long",
}
OVER_A_LIMIT = [c for c in CASES if set(c["issues"]) & LIMIT_CODES]
UI = {"v": 1, "off": [{"at": 1, "cql": {"op": "=", "args": [{"property": "a"}, 1]}}]}


def conditions(n: int) -> dict[str, Any]:
    return {
        "op": "and",
        "args": [{"op": "=", "args": [{"property": f"f{i}"}, i]} for i in range(n)],
    }


def area(points: int) -> dict[str, Any]:
    ring = [
        [13.0 + i * 1.234567e-6, 52.0 + (i % 2) * 1.234567e-6]
        for i in range(points - 1)
    ]
    ring.append(ring[0])
    return {
        "op": "and",
        "args": [
            {"op": "=", "args": [{"property": "kind"}, "school"]},
            {
                "op": "s_intersects",
                "args": [
                    {"property": "geom"},
                    {"type": "Polygon", "coordinates": [ring]},
                ],
            },
        ],
    }


@pytest.mark.parametrize("case", ERROR_FREE, ids=[c["name"] for c in ERROR_FREE])
def test_every_error_free_filter_is_taken_with_its_notes(case: dict[str, Any]) -> None:
    query = CQLQueryObject(cql=case["cql"], ui=UI)
    assert query.cql == case["cql"]
    assert query.ui == UI
    assert (
        CQLQuery(query={"cql": case["cql"], "ui": UI}).model_dump()["query"]["ui"] == UI
    )


@pytest.mark.parametrize("case", OVER_A_LIMIT, ids=[c["name"] for c in OVER_A_LIMIT])
def test_a_stored_filter_over_a_limit_still_reads(case: dict[str, Any]) -> None:
    assert CQLQueryObject(cql=case["cql"]).cql == case["cql"]


def test_a_large_stored_area_reads_through_the_project_read_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTH", "False")
    from uuid import uuid4

    from core.schemas.project import IFeatureStandardProjectRead

    cql = area(6 * MAX_POINTS)
    assert len(json.dumps(cql, separators=(",", ":"))) > 50_000
    fields = IFeatureStandardProjectRead.model_fields
    row = {
        "id": 1,
        "layer_id": uuid4(),
        "name": "Schools",
        "query": {"cql": cql, "ui": UI},
    }
    for name, field in fields.items():
        if field.is_required() and name not in row:
            row[name] = _sample(name)
    read = IFeatureStandardProjectRead(**row)
    assert read.query is not None
    assert read.query.cql == cql
    assert read.query.ui == UI
    assert read.model_dump(mode="json")["query"]["ui"] == UI


def _sample(name: str) -> Any:
    from uuid import uuid4

    samples: dict[str, Any] = {
        "user_id": uuid4(),
        "folder_id": uuid4(),
        "type": "feature",
        "feature_layer_type": "standard",
        "feature_layer_geometry_type": "polygon",
        "attribute_mapping": {},
        "size": 0,
        "properties": {},
    }
    return samples.get(name)


@pytest.mark.parametrize(
    "cql",
    [
        {"op": "and", "args": []},
        {"op": "=", "args": [{"property": "a"}]},
        # A relative day that is no whole number of days from 1.
        {"op": ">=", "args": [{"property": "a"}, {"op": "daysAgo", "args": [0]}]},
    ],
)
def test_a_malformed_filter_is_refused(cql: dict[str, Any]) -> None:
    with pytest.raises(ValidationError, match="Invalid CQL query:"):
        CQLQueryObject(cql=cql)


@pytest.mark.parametrize(
    "cql",
    [
        {"op": "a_contains", "args": [{"property": "a"}, [1]]},
        {
            "op": "=",
            "args": [{"function": {"name": "read_text", "arguments": ["x"]}}, 1],
        },
    ],
)
def test_what_the_checker_refuses_still_reads_and_is_refused_on_a_changed_save(
    cql: dict[str, Any],
) -> None:
    assert CQLQueryObject(cql=cql).cql == cql
    assert query_save_errors({"cql": cql}, {"cql": cql}) == []
    errors = query_save_errors(None, {"cql": cql})
    assert errors and errors[0].startswith("Invalid CQL query:")


def test_no_filter_is_no_filter() -> None:
    assert CQLQueryObject(cql=None).cql is None
    assert CQLQueryObject().ui is None


# --- the check on save -------------------------------------------------------------


def incoming(**query: Any) -> CQLQueryObject:
    return CQLQueryObject(**query)


def test_a_changed_filter_over_a_limit_is_refused() -> None:
    stored = {"cql": conditions(MAX_CONDITIONS)}
    errors = query_save_errors(stored, incoming(cql=conditions(MAX_CONDITIONS + 1)))
    assert len(errors) == 1
    assert errors[0].startswith("Invalid CQL query:")
    assert str(MAX_CONDITIONS) in errors[0]


def test_a_new_filter_over_a_limit_is_refused() -> None:
    assert query_save_errors(None, incoming(cql=conditions(MAX_CONDITIONS + 1)))
    assert query_save_errors({}, incoming(cql=area(MAX_POINTS + 1)))


def tangled_area() -> dict[str, Any]:
    """An area swept in rows and then in columns: every row crosses every column."""
    ring: list[list[float]] = []
    for i in range(1, 21):
        start, end = (0, 21) if i % 2 else (21, 0)
        ring += [[start, i], [end, i]]
    for i in range(1, 21):
        start, end = (0, 21) if i % 2 else (21, 0)
        ring += [[i, start], [i, end]]
    ring.append(ring[0])
    return {
        "op": "and",
        "args": [
            {
                "op": "s_intersects",
                "args": [
                    {"property": "geom"},
                    {"type": "Polygon", "coordinates": [ring]},
                ],
            }
        ],
    }


def test_an_area_that_crosses_itself_too_often_is_refused() -> None:
    errors = query_save_errors(None, incoming(cql=tangled_area()))
    assert errors == [
        "Invalid CQL query: The area's outline crosses or overlaps itself too "
        "often. Redraw it or pick a simpler one."
    ]


def test_an_unchanged_area_that_crosses_itself_saves() -> None:
    cql = tangled_area()
    assert CQLQueryObject(cql=cql).cql == cql
    assert query_save_errors({"cql": cql}, incoming(cql=cql, ui=UI)) == []


def test_an_unchanged_filter_over_a_limit_saves() -> None:
    cql = conditions(MAX_CONDITIONS + 1)
    assert query_save_errors({"cql": cql}, incoming(cql=cql, ui=UI)) == []
    big = area(MAX_POINTS + 400)
    assert query_save_errors({"cql": big, "ui": UI}, incoming(cql=big)) == []


def test_unchanged_is_decided_on_the_parsed_json() -> None:
    cql = conditions(MAX_CONDITIONS + 1)
    # Key order and a number written as 3.0 or 3 do not change a filter...
    reordered = {
        "args": [{"args": c["args"], "op": c["op"]} for c in cql["args"]],
        "op": "and",
    }
    reordered["args"][3]["args"] = [{"property": "f3"}, 3.0]
    assert json.dumps(reordered) != json.dumps(cql)
    assert query_save_errors({"cql": cql}, incoming(cql=reordered)) == []
    # ...but true is not 1.
    changed = json.loads(json.dumps(cql))
    changed["args"][1]["args"][1] = True
    assert query_save_errors({"cql": cql}, incoming(cql=changed))


def test_a_legacy_stored_query_without_the_cql_key() -> None:
    cql = conditions(MAX_CONDITIONS + 1)
    assert query_save_errors(cql, incoming(cql=cql)) == []


def test_a_save_without_a_filter_is_not_checked() -> None:
    stored = {"cql": conditions(MAX_CONDITIONS + 1)}
    assert query_save_errors(stored, None) == []
    assert query_save_errors(stored, incoming(cql=None)) == []
    assert query_save_errors(stored, incoming(ui=UI)) == []


def test_a_changed_filter_within_the_limits_saves() -> None:
    stored = {"cql": conditions(2)}
    assert query_save_errors(stored, incoming(cql=conditions(MAX_CONDITIONS))) == []


def test_the_notes_block_is_capped() -> None:
    def notes(size: int) -> dict[str, Any]:
        base = {"v": 1, "pad": ""}
        overhead = len(json.dumps(base, separators=(",", ":")))
        return {"v": 1, "pad": "x" * (size - overhead)}

    at_cap = notes(QUERY_UI_MAX_BYTES)
    assert len(json.dumps(at_cap, separators=(",", ":"))) == QUERY_UI_MAX_BYTES
    assert query_save_errors(None, incoming(ui=at_cap)) == []
    errors = query_save_errors(None, incoming(ui=notes(QUERY_UI_MAX_BYTES + 1)))
    assert len(errors) == 1 and "ui" in errors[0]


def test_a_switched_off_area_of_the_most_points_fits_the_notes() -> None:
    off = {"v": 1, "off": [{"at": 0, "cql": area(MAX_POINTS)["args"][1]}]}
    assert query_save_errors(None, incoming(cql=conditions(1), ui=off)) == []


def test_the_query_of_a_table_layer_comes_as_a_plain_dict() -> None:
    """The table layer's update model is optional field by field, which leaves
    its `query` an unchecked dict; the save check reads it all the same."""
    stored = {"cql": conditions(MAX_CONDITIONS + 1)}
    assert query_save_errors(stored, {"cql": conditions(MAX_CONDITIONS + 1)}) == []
    assert query_save_errors(stored, {"cql": conditions(MAX_CONDITIONS + 2)})
    assert query_save_errors(None, {"cql": {"op": "and", "args": []}})
    assert query_save_errors(None, {"ui": {"pad": "x" * QUERY_UI_MAX_BYTES}})
    assert query_save_errors(None, {"cql": conditions(2), "ui": UI}) == []
