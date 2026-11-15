"""What the data holds beside a classification's classes (section 12): features
without a value (`computed.no_data`) and, for categories, values no class lists
(`computed.other`). The legend lists "No data" and "Other" from these."""

from typing import Any

import duckdb
import pytest
from goatlib.style.compute import computed_missing, facts_missing
from goatlib.style.data import compute_into, describe
from goatlib.style.data_check import referenced_fields
from goatlib.style.validate import validate


@pytest.fixture
def con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("""
        CREATE TABLE legend_synthetic AS
        SELECT
            CASE WHEN i % 4 = 0 THEN NULL ELSE i * 1.0 END AS gappy,
            i * 1.0 AS complete,
            chr(65 + (i % 6)::INTEGER) AS kind,
            (i % 2 = 0) AS flag,
            (2015 + i % 3)::INTEGER AS year
        FROM range(60) r(i)
    """)
    return con


def computed(con: duckdb.DuckDBPyConnection, c: dict[str, Any]) -> dict[str, Any]:
    doc = {"version": 1, "kind": "vector", "classify": [c]}
    out, _ = compute_into(
        con, "legend_synthetic", doc, geometry="point", fingerprint="f"
    )
    # What the server wrote is a valid style over this data.
    ctx = describe(
        con, "legend_synthetic", geometry="point", fields_used=referenced_fields(out)
    )
    assert [i.code for i in validate(out, ctx) if i.level == "error"] == []
    return out["classify"][0]["computed"]


def test_numeric_classes_say_whether_features_lack_a_value(con) -> None:
    gappy = computed(con, {"field": "gappy", "method": "quantile", "count": 3})
    assert gappy["no_data"] is True
    complete = computed(con, {"field": "complete", "method": "quantile", "count": 3})
    assert complete["no_data"] is False
    # Values outside the classes are a matter of categories.
    assert "other" not in gappy and "other" not in complete


def test_manual_classes_say_it_too(con) -> None:
    classes = [{"to": 30}, {"from": 30}]
    c = {"field": "gappy", "method": "manual", "classes": classes}
    assert computed(con, c)["no_data"] is True
    assert computed(con, {**c, "field": "complete"})["no_data"] is False


def test_the_most_frequent_categories_say_whether_values_are_left_out(con) -> None:
    some = computed(con, {"field": "kind", "method": "categories", "count": 3})
    assert (some["no_data"], some["other"]) == (False, True)
    every = computed(con, {"field": "kind", "method": "categories", "count": 6})
    assert (every["no_data"], every["other"]) == (False, False)


def test_an_authors_categories_are_held_against_the_data(con) -> None:
    def listed(field: str, *values: Any) -> dict[str, Any]:
        classes = [{"values": [v]} for v in values]
        return computed(
            con, {"field": field, "method": "categories", "classes": classes}
        )

    assert listed("kind", "A", "B")["other"] is True
    assert listed("kind", "A", "B", "C", "D", "E", "F")["other"] is False
    assert listed("flag", True, False)["other"] is False
    assert listed("flag", True)["other"] is True
    assert listed("year", 2015, 2016, 2017)["other"] is False
    assert listed("year", 2015)["other"] is True
    assert listed("kind", "A")["no_data"] is False


def test_a_field_the_data_lacks_is_stamped_without_the_facts(con) -> None:
    doc = {
        "version": 1,
        "kind": "vector",
        "classify": [
            {"field": "missing", "method": "categories", "classes": [{"values": ["A"]}]}
        ],
    }
    # An author's categories need no class computed; only the facts are open.
    assert facts_missing(doc) and not computed_missing(doc)
    out, _ = compute_into(
        con, "legend_synthetic", doc, geometry="point", fingerprint="f"
    )
    stamp = out["classify"][0]["computed"]
    # The server looked and could not tell: `no_data` is there, without an answer.
    assert stamp["no_data"] is None and "other" not in stamp
    # So it is not asked again every time its panel opens.
    assert not facts_missing(out)


def test_a_style_computed_before_the_facts_existed_lacks_them_without_being_stale(
    con,
) -> None:
    doc = {
        "version": 1,
        "kind": "vector",
        "classify": [
            {
                "field": "kind",
                "method": "categories",
                "classes": [{"values": ["A"]}],
                "computed": {
                    "at": "2026-01-01T00:00:00Z",
                    "data": "f",
                    "scope": "dataset",
                },
            }
        ],
    }
    # Reading it computes nothing (a project load asks for no data); the facts
    # come with its next computation, or when its panel opens.
    assert facts_missing(doc) and not computed_missing(doc)
    out, _ = compute_into(
        con, "legend_synthetic", doc, geometry="point", fingerprint="f"
    )
    assert out["classify"][0]["computed"]["other"] is True
    assert not facts_missing(out)


def test_the_facts_are_part_of_a_valid_style(con) -> None:
    from goatlib.style.context import DataContext

    doc = {
        "version": 1,
        "kind": "vector",
        "classify": [
            {
                "field": "kind",
                "method": "categories",
                "classes": [{"values": ["A"]}],
                "computed": {
                    "at": "2026-01-01T00:00:00Z",
                    "data": "f",
                    "scope": "dataset",
                    "no_data": True,
                    "other": False,
                },
            }
        ],
    }
    found = validate(doc, DataContext(kind="vector", geometry="point"))
    assert [i for i in found if i.level == "error"] == []
