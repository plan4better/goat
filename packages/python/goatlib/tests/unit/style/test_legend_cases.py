"""The legend test cases the web reads (`legend_cases.py`): complete, valid, current.

Rewrite the fixture after changing the cases:

    GOAT_WRITE_FIXTURES=1 uv run pytest tests/unit/style/test_legend_cases.py
"""

import itertools
import json
import os

import duckdb
import pytest
from goatlib.style.data_check import referenced_fields

from .conftest import FIXTURES
from .legend_cases import (
    DIMENSIONS,
    FIELDS,
    GEOMETRY,
    all_pairs,
    compatible,
    issues,
    legend_cases,
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


def test_every_pair_of_values_is_in_a_case_or_cannot_occur() -> None:
    cases, impossible = all_pairs()
    held = {
        ((a, case[a]), (b, case[b]))
        for case in cases
        for a, b in itertools.combinations(sorted(DIMENSIONS), 2)
    }
    every = {
        ((a, x), (b, y))
        for a, b in itertools.combinations(sorted(DIMENSIONS), 2)
        for x in DIMENSIONS[a]
        for y in DIMENSIONS[b]
    }
    assert held | set(impossible) == every
    assert not held & set(impossible)


def test_every_value_is_in_a_case() -> None:
    cases, _ = all_pairs()
    for name, values in DIMENSIONS.items():
        assert {case[name] for case in cases} == set(values), name


def test_cases_hold_only_values_that_go_together() -> None:
    cases, _ = all_pairs()
    assert all(compatible(case) for case in cases)


def test_the_cases_are_stable_and_few() -> None:
    cases, _ = all_pairs()
    assert cases == all_pairs()[0]
    assert len(cases) <= 200


def test_every_style_is_valid(con, generated) -> None:
    wrong = {}
    for case in generated["cases"]:
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


def test_the_fixture_is_current(generated) -> None:
    text = json.dumps(generated, indent=1, ensure_ascii=False) + "\n"
    if os.environ.get("GOAT_WRITE_FIXTURES"):
        FIXTURE.write_text(text)
    assert FIXTURE.exists() and FIXTURE.read_text() == text
