"""A stored layer filter as rows and back (`goatlib.filter.rows`).

`fixtures/filter_rows.json` is shared with the web's tests: each case is a
`query` as the filter panel saves it (`writeFilter` and the save that adds
`metadata`), the layer's `fields`, and what the panel's reader shows of it: the
`match`, each row's `kind` ("row" or "custom") and whether it is `enabled`, and
the `area` ("none", "inside", "outside" or "off"). A case with `written` is not
in the panel's form; `written` is what the panel saves after reading it.
"""

import copy
import json
import subprocess
import sys
from dataclasses import replace
from typing import Any

import pytest
from goatlib.filter.rows import Row, Rows, read_rows, write_rows

from .conftest import FIXTURES

CASES: list[dict[str, Any]] = json.loads((FIXTURES / "filter_rows.json").read_text())
CONVERSIONS: list[dict[str, Any]] = json.loads(
    (FIXTURES / "filter_conversions.json").read_text()
)

FIELDS = {"name": "string", "pop": "integer", "built": "date"}
AREA = {
    "op": "s_intersects",
    "args": [
        {"property": "geom"},
        {
            "type": "Polygon",
            "coordinates": [[[11, 48], [12, 48], [12, 49], [11, 49], [11, 48]]],
        },
    ],
}
AREA_NOTES = {"pieces": [{"kind": "shape", "n": 1}], "sum": "30ad70ed"}
#: A whole number no float holds.
HUGE = 10**400
HUGE_AREA = {
    "op": "s_intersects",
    "args": [
        {"property": "geom"},
        {"type": "Polygon", "coordinates": [[[0, 0], [HUGE, 0], [1, 1], [0, 0]]]},
    ],
}


def _eq(field: str, value: Any) -> dict[str, Any]:
    return {"op": "=", "args": [{"property": field}, value]}


def _case(name: str) -> dict[str, Any]:
    return next(c for c in CASES if c["name"] == name)


def _area_state(rows: Rows) -> str:
    if rows.area is None:
        return "none"
    if isinstance(rows.area_notes, dict) and "off" in rows.area_notes:
        return "off"
    return "outside" if rows.area.get("op") == "not" else "inside"


# the shared cases -----------------------------------------------------------------------------


def test_the_fixture_holds_every_kind_of_case() -> None:
    assert len(CASES) >= 14
    assert sum("written" in c for c in CASES) == 2
    assert {c["area"] for c in CASES} == {"none", "inside", "outside", "off"}


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_read_rows_matches_the_case(case: dict[str, Any]) -> None:
    rows = read_rows(case["query"], case["fields"])
    assert rows.match == case["match"]
    assert [
        {"kind": "row" if r.panel is not None else "custom", "enabled": r.enabled}
        for r in rows.rows
    ] == case["rows"]
    assert _area_state(rows) == case["area"]
    assert rows.metadata == (case["query"] or {}).get("metadata")


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_write_rows_gives_back_the_stored_query(case: dict[str, Any]) -> None:
    query = case["query"]
    before = copy.deepcopy(query)
    written = write_rows(read_rows(query, case["fields"]))
    assert written == case.get("written", query)
    assert query == before


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_writing_the_written_query_again_changes_nothing(case: dict[str, Any]) -> None:
    written = write_rows(read_rows(case["query"], case["fields"]))
    assert write_rows(read_rows(written, case["fields"])) == written


def test_rows_and_notes_are_passed_through_as_the_same_objects() -> None:
    query = _case("area_and_off_row")["query"]
    rows = read_rows(query, _case("area_and_off_row")["fields"])
    assert rows.area is query["cql"]["args"][0]
    assert rows.area_notes is query["ui"]["area"]
    assert rows.rows[0].cql is query["ui"]["off"][0]["cql"]
    assert rows.rows[1].cql is query["cql"]["args"][1]
    written = write_rows(rows)
    assert written is not None
    assert written["cql"]["args"][0] is rows.area
    assert written["ui"]["area"] is rows.area_notes
    assert written["ui"]["off"][0]["cql"] is rows.rows[0].cql


def test_the_panel_reading_of_a_row() -> None:
    rows = read_rows(
        _case("several_rows_all")["query"], _case("several_rows_all")["fields"]
    )
    first = rows.rows[0].panel
    assert first is not None
    assert (first["field"], first["op"], first["value"]) == ("name", "is", "Berlin")
    assert rows.rows[2].panel is not None and rows.rows[2].panel["op"] == "is_not"
    custom = read_rows(_case("custom_row")["query"], _case("custom_row")["fields"])
    assert custom.rows[1].panel is None


def test_without_field_types_a_row_reads_from_its_value() -> None:
    rows = read_rows(_case("several_rows_all")["query"], None)
    assert rows.rows[0].panel is not None and rows.rows[0].panel["op"] == "is"
    assert write_rows(rows) == _case("several_rows_all")["query"]


def test_a_row_the_fields_do_not_offer_is_custom() -> None:
    # "contains the text" is no operator of a number field.
    node = {"op": "like", "args": [{"property": "pop"}, "%5%"]}
    rows = read_rows({"cql": {"op": "and", "args": [node]}}, {"pop": "number"})
    assert rows.rows[0].panel is None
    assert read_rows({"cql": {"op": "and", "args": [node]}}, None).rows[0].panel


# the shared conversions -----------------------------------------------------------------------

#: Converted queries the panel writes in another form, with what it writes.
NOT_THE_PANELS_FORM = {
    "beside_area_after": "the area comes first",
    "area_group_rows": "rows matching any beside an area note it",
    "area_lone_row_match_any": "notes holding nothing but the version are left out",
    "off_malformed": "a switched-off row at a position that is none is not read",
    "off_other_version": "notes of another version are not read",
    "empty_filter": "an empty filter is no filter",
}


@pytest.mark.parametrize("case", CONVERSIONS, ids=[c["name"] for c in CONVERSIONS])
def test_every_converted_query_of_the_shared_conversions_round_trips(
    case: dict[str, Any],
) -> None:
    converted = case["converted"]
    written = write_rows(read_rows(converted, case["fields"]))
    if case["name"] not in NOT_THE_PANELS_FORM:
        assert written == converted
        return
    assert written != converted
    # What the panel writes for it reads back as the same rows and is written again unchanged.
    assert write_rows(read_rows(written, case["fields"])) == written
    a = read_rows(converted, case["fields"])
    b = read_rows(written, case["fields"])
    assert (a.match, [r.cql for r in a.rows], a.area) == (
        b.match,
        [r.cql for r in b.rows],
        b.area,
    )


def test_the_conversions_the_panel_writes_otherwise_are_what_it_writes() -> None:
    by_name = {c["name"]: c for c in CONVERSIONS}

    def written(name: str) -> Any:
        c = by_name[name]
        return write_rows(read_rows(c["converted"], c["fields"]))

    lone = by_name["area_lone_row_match_any"]["converted"]
    assert written("area_lone_row_match_any") == {"cql": lone["cql"]}
    after = by_name["beside_area_after"]["converted"]["cql"]["args"]
    assert written("beside_area_after") == {
        "cql": {"op": "and", "args": [after[2], after[0], after[1]]}
    }
    group = by_name["area_group_rows"]["converted"]
    assert written("area_group_rows") == {
        "cql": group["cql"],
        "ui": {"v": 1, "any": True},
    }
    malformed = by_name["off_malformed"]["converted"]
    assert written("off_malformed") == {
        "cql": malformed["cql"],
        "ui": {"v": 1, "off": [malformed["ui"]["off"][1]]},
    }
    other = by_name["off_other_version"]["converted"]
    assert written("off_other_version") == {"cql": other["cql"]}
    assert written("empty_filter") is None


# reading what is not the panel's form ---------------------------------------------------------


@pytest.mark.parametrize(
    "query",
    [
        None,
        {},
        {"cql": None},
        {"cql": 3},
        {"cql": {"op": "and"}},
        {"cql": {"op": "and", "args": "x"}},
        {"cql": {"op": "and", "args": [None, 3, [], {"op": "not"}]}},
        {"cql": [1, 2]},
        {"cql": {"op": "and", "args": []}, "ui": "x"},
        {"cql": {}, "ui": {"v": 1, "off": "x", "relative": 3, "area": [], "any": 1}},
        {"cql": {}, "ui": {"v": True, "off": [{"at": True, "cql": _eq("name", "a")}]}},
        {"ui": {"v": 1, "off": [{"at": 0}, {"at": "1", "cql": 1}, 5]}},
        {"ui": {"v": 1, "area": {"off": {"op": "s_intersects", "args": []}}}},
        {"cql": {"op": "s_intersects", "args": [{"property": 3}, {"type": "Polygon"}]}},
        {"cql": {"op": "isNull", "args": {"property": "name"}}},
        "text",
        3,
        [1],
        {"ui": {"v": 1, "off": [{"at": HUGE, "cql": 1}]}},
        {
            "cql": {"op": "and", "args": [1]},
            "ui": {"v": 1, "relative": [{"at": 0, "days": HUGE}]},
        },
        {"cql": {"op": "and", "args": [HUGE_AREA]}},
        {"ui": {"v": 1, "area": {"pieces": [], "sum": "", "off": HUGE_AREA}}},
        {
            "cql": {
                "op": "and",
                "args": [{"op": "=", "args": [{"property": "pop"}, HUGE]}],
            }
        },
    ],
)
def test_reading_never_raises(query: Any) -> None:
    for fields in (None, FIELDS, {"name": "nothing we know"}):
        rows = read_rows(query, fields)
        written = write_rows(rows)
        assert write_rows(read_rows(written, fields)) == written


def test_reading_loses_no_condition() -> None:
    assert write_rows(read_rows({"cql": 3}, FIELDS)) == {
        "cql": {"op": "and", "args": [3]}
    }
    assert write_rows(read_rows({"cql": {"op": "and"}}, FIELDS)) == {
        "cql": {"op": "and", "args": [{"op": "and"}]}
    }
    assert read_rows(None, FIELDS) == Rows(match="all", rows=())
    assert write_rows(read_rows({}, FIELDS)) is None
    assert write_rows(read_rows({"cql": {}}, FIELDS)) is None


def test_a_query_saved_as_the_cql_itself_is_one_row() -> None:
    node = _eq("name", "a")
    rows = read_rows(node, FIELDS)
    assert [r.cql for r in rows.rows] == [node]
    assert write_rows(rows) == {"cql": {"op": "and", "args": [node]}}
    tree = {"op": "or", "args": [node, _eq("name", "b")]}
    assert write_rows(read_rows(tree, FIELDS)) == {"cql": tree}


def test_a_stale_switched_off_area_beside_an_active_one_is_left_out() -> None:
    notes = {**AREA_NOTES, "off": AREA}
    query = {
        "cql": {"op": "and", "args": [AREA, _eq("name", "a")]},
        "ui": {"v": 1, "area": notes},
    }
    rows = read_rows(query, FIELDS)
    assert rows.area is AREA
    assert write_rows(rows) == {
        "cql": query["cql"],
        "ui": {"v": 1, "area": AREA_NOTES},
    }


def test_an_area_without_notes_stays_without_notes() -> None:
    query = {"cql": {"op": "and", "args": [AREA, _eq("name", "a")]}}
    assert write_rows(read_rows(query, FIELDS)) == query


def test_switched_off_rows_are_put_back_at_their_positions() -> None:
    # Out of order, past the end, and two at one position: placed as the panel's reader places them
    # (sorted, each inserted at its position, so the later of two at one position comes first).
    a, b, c, d = (_eq("name", x) for x in "abcd")
    query = {
        "cql": {"op": "and", "args": [a]},
        "ui": {
            "v": 1,
            "off": [{"at": 9, "cql": d}, {"at": 0, "cql": b}, {"at": 0.0, "cql": c}],
        },
    }
    rows = read_rows(query, FIELDS)
    assert [(r.cql, r.enabled) for r in rows.rows] == [
        (c, False),
        (b, False),
        (a, True),
        (d, False),
    ]
    assert write_rows(rows) == {
        "cql": {"op": "and", "args": [a]},
        "ui": {
            "v": 1,
            "off": [{"at": 0, "cql": c}, {"at": 1, "cql": b}, {"at": 3, "cql": d}],
        },
    }


# relative date notes --------------------------------------------------------------------------

FROZEN = {"op": ">=", "args": [{"property": "built"}, {"date": "2026-01-01"}]}


def test_a_relative_date_note_is_kept_at_its_row() -> None:
    off = _eq("name", "a")
    query = {
        "cql": {"op": "and", "args": [_eq("pop", 1), FROZEN]},
        "ui": {
            "v": 1,
            "off": [{"at": 0, "cql": off}],
            "relative": [{"at": 2, "days": 30}],
        },
    }
    rows = read_rows(query, FIELDS)
    assert [r.relative_days for r in rows.rows] == [None, None, 30]
    assert rows.rows[2].cql is FROZEN
    assert write_rows(rows) == query


def test_a_relative_date_note_moves_with_its_row() -> None:
    query = {
        "cql": {"op": "and", "args": [_eq("pop", 1), FROZEN]},
        "ui": {"v": 1, "relative": [{"at": 1, "days": 30}]},
    }
    rows = read_rows(query, FIELDS)
    assert write_rows(replace(rows, rows=rows.rows[1:])) == {
        "cql": {"op": "and", "args": [FROZEN]},
        "ui": {"v": 1, "relative": [{"at": 0, "days": 30}]},
    }


def test_a_malformed_relative_note_is_not_read() -> None:
    query = {
        "cql": {"op": "and", "args": [FROZEN]},
        "ui": {"v": 1, "relative": [{"at": 0, "days": 0}, {"at": 0, "days": True}]},
    }
    rows = read_rows(query, FIELDS)
    assert rows.rows[0].relative_days is None
    assert write_rows(rows) == {"cql": query["cql"]}


# changed rows ---------------------------------------------------------------------------------


def test_removing_a_row_before_a_switched_off_row_moves_its_position() -> None:
    query = _case("off_row_last")["query"]
    rows = read_rows(query, _case("off_row_last")["fields"])
    written = write_rows(replace(rows, rows=rows.rows[1:]))
    assert written == {
        "cql": {"op": "and", "args": [query["cql"]["args"][1]]},
        "ui": {"v": 1, "off": [{"at": 1, "cql": query["ui"]["off"][0]["cql"]}]},
    }


def test_a_row_added_at_the_end_keeps_the_others_in_place() -> None:
    case = _case("area_off_with_rows_any")
    rows = read_rows(case["query"], case["fields"])
    added = _eq("name", "Hamburg")
    written = write_rows(replace(rows, rows=(*rows.rows, Row(cql=added))))
    query = case["query"]
    assert written == {
        "cql": {"op": "or", "args": [*query["cql"]["args"], added]},
        "ui": query["ui"],
    }


def test_removing_the_only_active_row_keeps_the_off_row_and_the_area() -> None:
    case = _case("area_and_off_row")
    query = case["query"]
    rows = read_rows(query, case["fields"])
    written = write_rows(replace(rows, rows=rows.rows[:1]))
    assert written == {
        "cql": {"op": "and", "args": [query["cql"]["args"][0]]},
        "ui": query["ui"],
    }


def test_removing_the_only_active_row_beside_a_switched_off_area_leaves_the_notes() -> (
    None
):
    case = _case("area_off")
    rows = read_rows(case["query"], case["fields"])
    written = write_rows(replace(rows, rows=(replace(rows.rows[0], enabled=False),)))
    assert written == {
        "ui": {
            "v": 1,
            "off": [{"at": 0, "cql": case["query"]["cql"]["args"][0]}],
            "area": case["query"]["ui"]["area"],
        }
    }


def test_switching_rows_on_and_off() -> None:
    case = _case("off_row_middle")
    rows = read_rows(case["query"], case["fields"])
    flipped = tuple(replace(r, enabled=not r.enabled) for r in rows.rows)
    a, b = case["query"]["cql"]["args"]
    off = case["query"]["ui"]["off"][0]["cql"]
    assert write_rows(replace(rows, rows=flipped)) == {
        "cql": {"op": "and", "args": [off]},
        "ui": {"v": 1, "off": [{"at": 0, "cql": a}, {"at": 2, "cql": b}]},
    }


def test_a_row_without_cql_is_left_out_and_moves_nothing() -> None:
    a, b = _eq("name", "a"), _eq("name", "b")
    rows = Rows(
        match="all", rows=(Row(cql=None), Row(cql=a), Row(cql=b, enabled=False))
    )
    assert write_rows(rows) == {
        "cql": {"op": "and", "args": [a]},
        "ui": {"v": 1, "off": [{"at": 1, "cql": b}]},
    }


def test_nothing_left_is_no_filter() -> None:
    case = _case("area_with_rows")
    rows = read_rows(case["query"], case["fields"])
    assert write_rows(replace(rows, rows=(), area=None, area_notes=None)) is None
    assert write_rows(Rows(match="any", rows=())) is None
    assert write_rows(Rows(match="all", rows=(), metadata={})) == {"metadata": {}}


def test_setting_match_any_beside_an_area_writes_one_group() -> None:
    case = _case("area_with_rows")
    rows = read_rows(case["query"], case["fields"])
    assert (
        write_rows(replace(rows, match="any")) == _case("area_with_rows_any")["query"]
    )


_OFF_NODE = {
    "op": "s_intersects",
    "args": [
        {"property": "geom"},
        {
            "type": "Polygon",
            "coordinates": [[[11, 48], [12, 48], [12, 49], [11, 49], [11, 48]]],
        },
    ],
}


@pytest.mark.parametrize(
    "notes",
    [
        # One malformed piece.
        {"pieces": [{"kind": "nonsense"}], "sum": "x", "off": _OFF_NODE},
        # No sum.
        {"pieces": [{"kind": "shape", "n": 1, "shape": "polygon"}], "off": _OFF_NODE},
        # Pieces that are no list.
        {"pieces": {"kind": "shape"}, "sum": "x", "off": _OFF_NODE},
    ],
)
def test_malformed_area_notes_hold_no_switched_off_area(notes: dict[str, Any]) -> None:
    """The panel drops notes it cannot read whole (`readAreaNotes`), so it
    shows no area, switched off or on."""
    rows = read_rows({"ui": {"v": 1, "area": notes}}, {})
    assert (rows.area, rows.area_notes) == (None, None)


def test_well_formed_notes_hold_their_switched_off_area() -> None:
    notes = {
        "pieces": [{"kind": "shape", "n": 1, "shape": "polygon"}],
        "sum": "x",
        "off": _OFF_NODE,
    }
    rows = read_rows({"ui": {"v": 1, "area": notes}}, {})
    assert rows.area == _OFF_NODE and rows.area_notes == notes


# imports --------------------------------------------------------------------------------------


def test_rows_imports_no_data_library() -> None:
    script = """
import importlib.abc
import sys

class Refuse(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in ("numpy", "shapely", "duckdb"):
            raise ImportError(f"refused: {name}")
        return None

sys.meta_path.insert(0, Refuse())
import goatlib.filter.rows
"""
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
