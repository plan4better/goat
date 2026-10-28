import copy
import json

import pytest
from goatlib.style.issues import make_issue
from goatlib.style.merge import (
    PlaceChange,
    RemoveChange,
    SetChange,
    apply,
    changed_paths,
    diff,
    keep_current_where_errors,
    merge,
)

from .conftest import FIXTURES

CASES = json.loads((FIXTURES / "merge_cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_merge_cases(case: dict) -> None:
    merged, refused = merge(case["base"], case["incoming"], case["current"])
    assert merged == case["expected"]
    assert changed_paths(refused) == case["refused"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_diff_of_a_document_with_itself_is_empty(case: dict) -> None:
    assert diff(case["incoming"], case["incoming"]) == []


def test_removal_wins_is_reported_as_refused() -> None:
    case = next(c for c in CASES if c["name"] == "removal wins")
    _, refused = merge(case["base"], case["incoming"], case["current"])
    assert [r.path for r in refused] == [
        ("classify", "density", "classes", "c2", "fill", "color")
    ]


def test_change_kinds_and_paths() -> None:
    base = {
        "version": 1,
        "kind": "vector",
        "rules": [{"id": "r1", "visible": False}],
        "legend": {"show": True},
    }
    new = {
        "version": 1,
        "kind": "vector",
        "rules": [{"id": "r1", "visible": True}, {"id": "r2", "visible": False}],
    }
    changes = diff(base, new)
    assert SetChange(("rules", "r1", "visible"), True) in changes
    assert RemoveChange(("legend",)) in changes
    assert (
        PlaceChange(("rules",), "r2", ("r1",), {"id": "r2", "visible": False})
        in changes
    )
    assert sorted(changed_paths(changes)) == [
        "/legend",
        "/rules/r1/visible",
        "/rules/r2",
    ]
    assert apply(base, changes)[0] == new


def test_errors_keep_the_current_value_on_their_paths() -> None:
    current = {
        "version": 1,
        "kind": "vector",
        "symbol": {"fill": {"opacity": 0.5}},
        "classify": [{"id": "a", "field": "land_use", "method": "categories"}],
    }
    candidate = {
        "version": 1,
        "kind": "vector",
        "symbol": {"fill": {"opacity": 0.9}},
        "classify": [{"id": "a", "field": "gone", "method": "categories"}],
    }
    changes = diff(current, candidate)
    issues = [make_issue("unknown_field", "/classify/a/field", "m")]
    kept = keep_current_where_errors(current, candidate, issues, changes)
    assert kept["classify"][0]["field"] == "land_use"
    assert kept["symbol"]["fill"]["opacity"] == 0.9


def test_errors_already_in_current_do_not_block_edits_beneath_them() -> None:
    current = {
        "version": 1,
        "kind": "vector",
        "classify": [
            {
                "id": "a",
                "field": "f",
                "method": "manual",
                "classes": [{"id": "c1", "to": 5}, {"id": "c2", "from": 9}],
            }
        ],
    }
    candidate = copy.deepcopy(current)
    candidate["classify"][0]["classes"][0]["name"] = "Low"
    issue = make_issue("classes_invalid", "/classify/a", "m")
    kept = keep_current_where_errors(
        current, candidate, [issue], diff(current, candidate), current_issues=[issue]
    )
    assert kept["classify"][0]["classes"][0]["name"] == "Low"


def test_an_added_item_with_an_error_is_taken_back_whole() -> None:
    current = {"version": 1, "kind": "vector"}
    candidate = {
        "version": 1,
        "kind": "vector",
        "classify": [{"id": "a", "field": "gone", "method": "categories"}],
    }
    issues = [make_issue("unknown_field", "/classify/a/field", "m")]
    assert (
        keep_current_where_errors(current, candidate, issues, diff(current, candidate))
        == current
    )
