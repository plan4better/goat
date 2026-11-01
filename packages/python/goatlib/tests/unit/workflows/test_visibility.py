"""The Python evaluator of `visible_when` / `hidden_when` agrees with the editor's.

Every case in `visibility_cases.json` runs here and in the web test
`apps/web/lib/utils/__tests__/ogc-visibility-cases.test.ts`, so a case that
passes on one side and fails on the other shows up as a failure.
"""

import json
from importlib.resources import files
from typing import Any

import pytest
from goatlib.workflows.visibility import is_shown, matches

pytestmark = pytest.mark.unit

CASES: list[dict[str, Any]] = json.loads(
    (files("goatlib.workflows") / "visibility_cases.json").read_text(encoding="utf-8")
)
OPERATORS = ("$eq", "$ne", "$in", "$nin", "$exists", "$gt", "$gte", "$lt", "$lte")


@pytest.mark.parametrize("case", CASES, ids=[case["note"] for case in CASES])
def test_case(case: dict[str, Any]) -> None:
    if "x_ui" in case:
        assert is_shown(case["x_ui"], case["values"]) is case["expected"]
    else:
        assert matches(case["condition"], case["values"]) is case["expected"]


def test_the_case_file_covers_every_operator_and_the_x_ui_rules() -> None:
    assert len(CASES) >= 25
    assert len({case["note"] for case in CASES}) == len(CASES)
    assert all(("condition" in case) != ("x_ui" in case) for case in CASES)
    text = json.dumps([case.get("condition") for case in CASES])
    for operator in (*OPERATORS, "$and", "$or"):
        assert f'"{operator}"' in text, operator
    assert any("." in key for case in CASES for key in case.get("condition") or {})
    x_ui_keys = {key for case in CASES for key in case.get("x_ui") or {}}
    assert {"hidden", "visible_when", "hidden_when"} <= x_ui_keys


def test_a_real_catchment_setting_is_shown_only_for_layer_points() -> None:
    # catchment_area_v2's reference field: only separated shapes from a layer.
    x_ui = {
        "section": "starting",
        "widget": "field-selector",
        "visible_when": {
            "$and": [
                {"shape_style": "separated"},
                {"starting_points.layer_id": {"$ne": None}},
            ]
        },
    }
    from_layer = {"shape_style": "separated", "starting_points": {"layer_id": "l1"}}
    on_map = {"shape_style": "separated", "starting_points": {"latitude": [48.1]}}
    combined = {"shape_style": "combined", "starting_points": {"layer_id": "l1"}}
    assert is_shown(x_ui, from_layer) is True
    assert is_shown(x_ui, on_map) is False
    assert is_shown(x_ui, combined) is False
