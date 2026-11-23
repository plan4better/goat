"""`convert_query` over the shared conversion cases, and what they mean in DuckDB.

`fixtures/filter_conversions.json` is shared with the web's tests
(`apps/web/lib/filter/__tests__/conversions.test.ts`): each case has a `name`, the
layer's `fields`, the `stored` query, the `converted` query (the rows the panel
would change, written by the panel's own writer; everything else as stored), the
rows `changed` (JSON pointer into the query and the operator the panel reads;
`/ui/any` with `any` for the "match any" note beside an area, which the panel
drops when it saves such a row), the query the panel `written` on its next save
of `stored`, and a `note`.
"""

import copy
import json
import subprocess
import sys
from typing import Any

import duckdb
import pytest
from goatlib.filter.convert import NEGATIONS, convert_cql, convert_query
from goatlib.filter.issues import CODES
from goatlib.filter.normalize import normalize
from goatlib.filter.validate import validate
from goatlib.storage.cql_evaluator import cql2_to_duckdb_sql
from pygeofilter.parsers.cql2_json import parse

from .conftest import FIXTURES, context

CASES: list[dict[str, Any]] = json.loads(
    (FIXTURES / "filter_conversions.json").read_text()
)
IDS = [c["name"] for c in CASES]


def same(a: Any, b: Any) -> bool:
    """Equal as JSON: 5 is not 5.0 or true."""
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def changes(converted: Any) -> list[dict[str, str]]:
    return [{"path": p, "op": op} for p, op in converted.changes]


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_case(case: dict[str, Any]) -> None:
    stored = copy.deepcopy(case["stored"])
    result = convert_query(stored, case["fields"])
    assert same(result.value, case["converted"])
    assert changes(result) == case["changed"]
    assert same(stored, case["stored"]), "the input is not changed"
    if not case["changed"]:
        assert result.value is stored


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_a_second_run_changes_nothing(case: dict[str, Any]) -> None:
    converted = case["converted"]
    result = convert_query(converted, case["fields"])
    assert result.changes == []
    assert result.value is converted


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_without_field_types_only_negations_change(case: dict[str, Any]) -> None:
    unknown = convert_query(case["stored"], None)
    assert same(unknown.value, convert_query(case["stored"], {}).value)
    # `any`: the "match any" note beside an area, dropped with a converted row.
    assert {op for _, op in unknown.changes} <= NEGATIONS | {"any"}


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_converted_rows_pass_the_checker(case: dict[str, Any]) -> None:
    """The conversion adds no issue: a converted filter saves like any other."""
    ctx = context(case["fields"])
    cql = case["converted"].get("cql")
    if not isinstance(cql, dict) or not cql:
        return
    before = {i.code for i in validate(case["stored"]["cql"], ctx)}
    after = {i.code for i in validate(cql, ctx)}
    assert after <= before
    if case["changed"] and case["changed"][0]["op"] in NEGATIONS:
        # The checker's warning about a negation that drops the empty value goes.
        assert "negation_drops_empty" not in after
    for entry in case["converted"].get("ui", {}).get("off", []):
        off = [i.code for i in validate(entry["cql"], ctx)]
        assert not [code for code in off if CODES[code] == "error"], off


def test_a_bare_cql_query_is_converted_too() -> None:
    """A query saved long ago as the CQL itself, which the services still read."""
    cql = {"op": "and", "args": [{"op": "!=", "args": [{"property": "name"}, "A"]}]}
    result = convert_query(cql, {"name": "string"})
    assert result.value == {
        "op": "and",
        "args": [
            {
                "op": "or",
                "args": [
                    {"op": "<>", "args": [{"property": "name"}, "A"]},
                    {"op": "isNull", "args": [{"property": "name"}]},
                ],
            }
        ],
    }
    assert result.changes == [("/args/0", "is_not")]
    assert convert_cql(cql, {"name": "string"}).value == result.value


@pytest.mark.parametrize("query", [None, [], "x", {}, {"cql": None}, {"ui": {}}])
def test_no_filter_stays(query: Any) -> None:
    result = convert_query(query, {})
    assert result.value is query
    assert result.changes == []


def test_numbers_typed_as_text_are_read_as_javascript_reads_them() -> None:
    def converted(value: str) -> Any:
        cql = {"op": "and", "args": [{"op": "!=", "args": [{"property": "n"}, value]}]}
        written = convert_query({"cql": cql}, {"n": "integer"}).value["cql"]
        return written["args"][0]["args"][0]["args"][1]

    assert converted("5") == 5 and isinstance(converted("5"), int)
    assert converted(" 5.0 ") == 5
    assert converted("0x1F") == 31
    assert converted("1e3") == 1000
    assert converted("1.5") == 1.5
    # No number to JavaScript: kept as text, for the checker to name.
    for text in ("1_000", "٣", "Infinity", "-0x5", "5 6"):
        assert converted(text) == text


def test_the_module_imports_only_the_standard_library() -> None:
    """core's data migration imports it, and core's image has no geospatial stack."""
    code = (
        "import sys, goatlib.filter.convert; "
        "heavy = {'duckdb', 'numpy', 'shapely', 'pyarrow', 'pygeofilter', 'pydantic'}; "
        "print(sorted(heavy & {m.split('.')[0] for m in sys.modules}))"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    )
    assert out.stdout.strip() == "[]"


# What the filters select -----------------------------------------------------------------------

COLUMNS = {
    "name": "VARCHAR",
    "kind": "VARCHAR",
    "pop": "INTEGER",
    "area": "DOUBLE",
    "open": "BOOLEAN",
    "built": "DATE",
    "seen": "TIMESTAMP",
    "missing": "INTEGER",
}
#: Rows with values the cases name, without a value, and with the empty text.
ROWS = [
    "1, 'Berlin', 'city', 5, 1.5, true, DATE '2024-05-01', TIMESTAMP '2024-05-01 10:30:00', 3, ST_Point(0.5, 0.5)",
    "2, 'Hamburg', 'town', 7, 4.0, false, DATE '2023-01-10', TIMESTAMP '2023-01-10 08:00:00', 4, ST_Point(5, 5)",
    "3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL",
    "4, '', '', 2, 2.0, NULL, DATE '2024-12-31', TIMESTAMP '2024-05-02 00:00:00', NULL, ST_Point(0.2, 0.2)",
    "5, 'Bergen', 'city', NULL, 0.5, true, NULL, NULL, 3, ST_Point(0.7, 0.7)",
    "6, NULL, 'town', 3, NULL, NULL, DATE '2024-03-01', TIMESTAMP '2024-03-01 12:00:00', NULL, ST_Point(0.4, 0.4)",
]


@pytest.fixture(scope="module")
def con() -> Any:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        "CREATE TABLE t (id INTEGER, "
        + ", ".join(f'"{n}" {t}' for n, t in COLUMNS.items())
        + ", geom GEOMETRY)"
    )
    for row in ROWS:
        con.execute(f"INSERT INTO t VALUES ({row})")
    yield con
    con.close()


def selected(con: Any, cql: Any) -> set[int]:
    if not isinstance(cql, dict) or not cql:
        return {r[0] for r in con.execute("SELECT id FROM t").fetchall()}
    sql, params = cql2_to_duckdb_sql(
        parse(json.dumps(normalize(cql))), [*COLUMNS, "geom"], "geom"
    )
    return {
        r[0] for r in con.execute(f"SELECT id FROM t WHERE {sql}", params).fetchall()
    }


#: The cases the services evaluate: a filter with an error is refused before.
RUNS = [
    c
    for c in CASES
    if not any(
        CODES[i.code] == "error"
        for i in validate(
            c["stored"].get("cql") or {"op": "and", "args": []}, context(c["fields"])
        )
    )
]


@pytest.mark.parametrize("case", RUNS, ids=[c["name"] for c in RUNS])
def test_converted_selects_what_the_panel_saves(case: dict[str, Any], con: Any) -> None:
    """The converted filter selects what the panel's next save of the stored one
    selects: old and new filters mean the same from the conversion on."""
    assert selected(con, case["converted"].get("cql")) == selected(
        con, case["written"].get("cql")
    )


@pytest.mark.parametrize(
    ("name", "field"),
    [
        ("is_not_text", "name"),
        ("is_not_integer", "pop"),
        ("excludes_text", "name"),
        ("does_not_contain_text", "name"),
        ("is_not_between_number", "area"),
        ("is_not_on_date_fallback", "built"),
        ("not_is_text", "name"),
        ("beside_area", "name"),
    ],
)
def test_negations_keep_the_rows_without_a_value(
    name: str, field: str, con: Any
) -> None:
    case = next(c for c in CASES if c["name"] == name)
    stored = selected(con, case["stored"]["cql"])
    converted = selected(con, case["converted"]["cql"])
    without = {
        r[0]
        for r in con.execute(f'SELECT id FROM t WHERE "{field}" IS NULL').fetchall()
    }
    assert stored < converted
    assert converted - stored <= without


def test_empty_tests_on_text_take_the_empty_text(con: Any) -> None:
    def rows(name: str, side: str) -> set[int]:
        case = next(c for c in CASES if c["name"] == name)
        return selected(con, case[side]["cql"])

    # "is empty": the empty text joins the rows without a value, and the other way round.
    assert rows("is_blank_text", "stored") == {3, 6}
    assert rows("is_blank_text", "converted") == {3, 4, 6}
    assert rows("is_empty_string", "stored") == {4}
    assert rows("is_empty_string", "converted") == {3, 4, 6}
    # "is not empty": the empty text no longer passes.
    assert rows("is_not_blank_text", "stored") == {1, 2, 4, 5}
    assert rows("is_not_blank_text", "converted") == {1, 2, 5}
    # `!=` against the empty text meant that already.
    assert rows("is_not_empty_string", "stored") == rows(
        "is_not_empty_string", "converted"
    )
