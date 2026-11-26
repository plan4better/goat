"""The legend test cases the web reads (`legend_cases.py`): complete, valid, current.

Rewrite the fixture after changing the cases:

    GOAT_WRITE_FIXTURES=1 uv run pytest tests/unit/style/test_legend_cases.py
"""

import hashlib
import itertools
import json
import os

import duckdb
import pytest
from goatlib.style.colors import COLOR_KEYS, is_none, opaque
from goatlib.style.data_check import referenced_fields

from .conftest import FIXTURES
from .legend_cases import (
    COLOR_DIMENSIONS,
    COLOR_FIELDS,
    COLOR_RULES,
    DIMENSIONS,
    FIELDS,
    FOCUS,
    GEOMETRY,
    LIMITS,
    RULES,
    all_pairs,
    compatible,
    issues,
    legend_cases,
    place,
    synthetic,
)

FIXTURE = FIXTURES / "legend_cases.json"


@pytest.fixture(scope="module")
def con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    synthetic(con)
    return con


@pytest.fixture(scope="module")
def generated(con) -> dict:
    return legend_cases(con)


#: The two generated blocks: the legend's settings, and automatic colors, None and
#: transparency over the settings that decide which colors are drawn.
BLOCKS = pytest.mark.parametrize(
    "dimensions, rules, most",
    [(DIMENSIONS, RULES, 200), (COLOR_DIMENSIONS, COLOR_RULES, 120)],
    ids=["legend", "colors"],
)


@BLOCKS
def test_every_pair_of_values_is_in_a_case_or_cannot_occur(
    dimensions, rules, most
) -> None:
    cases, impossible = all_pairs(dimensions, rules)
    held = {
        ((a, case[a]), (b, case[b]))
        for case in cases
        for a, b in itertools.combinations(sorted(dimensions), 2)
    }
    every = {
        ((a, x), (b, y))
        for a, b in itertools.combinations(sorted(dimensions), 2)
        for x in dimensions[a]
        for y in dimensions[b]
    }
    assert held | set(impossible) == every
    assert not held & set(impossible)


@BLOCKS
def test_every_value_is_in_a_case(dimensions, rules, most) -> None:
    cases, _ = all_pairs(dimensions, rules)
    for name, values in dimensions.items():
        assert {case[name] for case in cases} == set(values), name


@BLOCKS
def test_cases_hold_only_values_that_go_together(dimensions, rules, most) -> None:
    cases, _ = all_pairs(dimensions, rules)
    assert all(compatible(case, rules) for case in cases)


@BLOCKS
def test_the_cases_are_stable_and_few(dimensions, rules, most) -> None:
    cases, _ = all_pairs(dimensions, rules)
    assert cases == all_pairs(dimensions, rules)[0]
    assert len(cases) <= most


def test_the_earlier_cases_are_unchanged(generated) -> None:
    # The legend's cases, pinned byte for byte by their hash: the colors' block leaves them as they are.
    text = json.dumps(generated["cases"], indent=1, ensure_ascii=False)
    assert len(generated["cases"]) == 116
    assert (
        hashlib.sha256(text.encode()).hexdigest()
        == "46f98c22682c458602b822520e9e2da94677356adb5b81e99bc1cd3b0af47640"
    )
    assert generated["fields"] == FIELDS


def test_every_key_that_takes_auto_is_a_dimension_of_the_colors() -> None:
    accepted = {k for k, v in COLOR_KEYS.items() if v["auto"] and v.get("accepted")}
    assert {
        d.removeprefix("auto:") for d in COLOR_DIMENSIONS if d.startswith("auto:")
    } == (accepted)
    for key in accepted:
        place(key)


def test_a_key_the_generator_cannot_place_is_refused() -> None:
    with pytest.raises(ValueError):
        place("scene.sky.color")


def test_the_colors_hold_tone_and_every_old_setting(generated) -> None:
    block = generated["colors"]
    assert block["fields"] == COLOR_FIELDS
    ids = [case["id"] for case in block["cases"]]
    assert len(set(ids)) == len(ids)
    for case in block["cases"]:
        assert case["tone"] == case["values"]["tone"] in ("light", "dark"), case["id"]
        assert set(DIMENSIONS) <= set(case["values"]), case["id"]
        assert set(COLOR_DIMENSIONS) <= set(case["values"]), case["id"]


def test_the_review_focus_cases_are_there(generated) -> None:
    cases = {case["id"]: case for case in generated["colors"]["cases"]}
    assert set(FOCUS) | set(LIMITS) <= set(cases)
    assert [case["id"] for case in generated["colors"]["cases"]][
        -len(FOCUS) - len(LIMITS) :
    ] == [
        *FOCUS,
        *LIMITS,
    ]
    # A class that sets its own fill to None in a classified layer, beside an Auto outline.
    style = cases["focus-class-none"]["style"]
    assert style["symbol"]["outline"]["color"] == "auto"
    fills = [k["fill"]["color"] for k in style["classify"][0]["classes"]]
    assert [is_none(c) for c in fills].count(True) == 1
    assert all(opaque(c) != "#000000" for c in fills)
    # A fill read from a field as hex text, with an Auto outline and an Auto label.
    style = cases["focus-data-color"]["style"]
    assert style["symbol"]["fill"]["color"] == {"field": "color_hex"}
    assert style["symbol"]["outline"]["color"] == "auto"
    assert style["symbol"]["label"]["color"] == "auto"
    assert style["symbol"]["label"]["halo"]["color"] == "auto"


def test_every_style_is_valid(con, generated) -> None:
    wrong = {}
    for case in [*generated["cases"], *generated["colors"]["cases"]]:
        found = issues(con, case["style"], case["geometry"])
        if case["values"]["data"] == "field_missing":
            # The one thing wrong with these: the field the data does not have.
            assert found and all(i.startswith("unknown_field ") for i in found), case[
                "id"
            ]
        elif found:
            wrong[case["id"]] = (case["values"], found)
    assert wrong == {}


def test_only_made_up_fields_are_used(generated) -> None:
    for case in generated["cases"]:
        assert referenced_fields(case["style"]) <= {*FIELDS, "missing_field"}, case[
            "id"
        ]
        assert case["geometry"] == GEOMETRY[case["values"]["geometry"]]
    for case in generated["colors"]["cases"]:
        assert referenced_fields(case["style"]) <= set(COLOR_FIELDS), case["id"]
        assert case["geometry"] == GEOMETRY[case["values"]["geometry"]]


def test_the_fixture_is_current(generated) -> None:
    text = json.dumps(generated, indent=1, ensure_ascii=False) + "\n"
    if os.environ.get("GOAT_WRITE_FIXTURES"):
        FIXTURE.write_text(text)
    assert FIXTURE.exists() and FIXTURE.read_text() == text
