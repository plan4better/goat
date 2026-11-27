"""The value of a class that holds one (`computed.single`, the specification's
7.2 and 12), written for classes fitted to the data (`fit`)."""

import copy
import math
from typing import Any

import pytest
from goatlib.style.compute import class_decimals, needed_stats
from goatlib.style.data import compute_into, fitted_breaks
from goatlib.style.edit import settle_fit
from goatlib.tools.style import value_decimals

from .test_fit_classes import computed, fit_doc, table


def singles(doc: dict[str, Any]) -> dict[str, float] | None:
    return doc["classify"][0]["computed"].get("single")


def ids(doc: dict[str, Any]) -> list[str]:
    return [k["id"] for k in doc["classify"][0]["classes"]]


def test_one_value_is_one_single_class() -> None:
    out, _ = computed(table([5.0] * 3 + [None]), fit_doc())
    assert singles(out) == {ids(out)[0]: 5.0}


def test_few_values_are_one_single_class_each() -> None:
    con = table([1.0] * 10 + [2.0] * 3 + [3.0])
    out, _ = computed(con, fit_doc())
    assert singles(out) == dict(zip(ids(out), [1.0, 2.0, 3.0]))
    assert fitted_breaks(con, "t", "v", 7).singles == (1.0, 2.0, 3.0)


def test_an_own_zero_class_is_single_and_the_classes_beside_it_are_not() -> None:
    out, _ = computed(table([0.0] * 91 + [float(i) for i in range(1, 92)]), fit_doc())
    assert singles(out) == {ids(out)[0]: 0.0}


def test_a_dominant_maximum_is_single() -> None:
    values = [0.97] * 92 + [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
    out, _ = computed(table(values), fit_doc())
    assert singles(out)[ids(out)[-1]] == 0.97
    assert ids(out)[0] not in singles(out)


def test_a_class_of_two_close_values_is_not_single() -> None:
    con = table([float(i) for i in range(1, 15)] + [7.5])
    b = fitted_breaks(con, "t", "v", 7)
    assert all(s is None for s in b.singles) and len(b.singles) == len(b.breaks) + 1
    out, _ = computed(con, fit_doc())
    assert singles(out) is None


def test_the_centre_s_zero_class_is_single() -> None:
    values = [float(-i) for i in range(1, 31)] + [0.0] * 31
    values += [float(i) for i in range(1, 63)]
    out, _ = computed(table(values), fit_doc(palette="colorbrewer:RdBu"))
    assert singles(out) == {ids(out)[3]: 0.0}


def test_without_fit_no_single_is_written() -> None:
    doc = fit_doc()
    del doc["classify"][0]["fit"]
    out, _ = computed(table([1.0] * 10 + [2.0] * 3 + [3.0]), doc)
    assert "single" not in out["classify"][0]["computed"]
    assert needed_stats(doc) == [
        ("breaks", "v", "quantile", "7"),
        ("presence", "v"),
    ]


MANUAL = {
    "version": "1.0.0",
    "kind": "vector",
    "symbol": {"fill": {"color": "#cccccc"}},
    "classify": [
        {
            "id": "v",
            "field": "v",
            "method": "manual",
            "fit": True,
            "classes": [
                {"id": "c1", "to": 1, "fill": {"color": "#eeeeee"}},
                {"id": "c2", "from": 1, "to": 5, "fill": {"color": "#999999"}},
                {"id": "c3", "from": 5, "fill": {"color": "#333333"}},
            ],
        }
    ],
}


def test_manual_classes_with_fit_record_their_single_values() -> None:
    con = table([0.0, 0.0, 1.0, 2.0, 5.0])
    out, _ = computed(con, MANUAL)
    assert singles(out) == {"c1": 0.0, "c3": 5.0}
    # The data changes: the first class holds two values and reads its range again.
    con.execute("INSERT INTO t VALUES (0.5)")
    again, _ = computed(con, out, fingerprint="g")
    assert singles(again) == {"c3": 5.0}


def test_manual_classes_without_fit_record_none() -> None:
    doc = copy.deepcopy(MANUAL)
    del doc["classify"][0]["fit"]
    out, _ = computed(table([0.0, 0.0, 1.0, 2.0, 5.0]), doc)
    assert "single" not in out["classify"][0]["computed"]
    assert needed_stats(doc) == [("range", "v"), ("presence", "v")]


def test_a_frozen_class_of_one_value_keeps_its_single_value() -> None:
    con = table([4.25] * 5)
    out, _ = computed(con, fit_doc())
    edited = copy.deepcopy(out)
    edited["classify"][0]["classes"][0]["fill"]["color"] = "#ff0000"
    frozen = settle_fit(out, edited)
    assert frozen["classify"][0]["method"] == "manual"
    again, _ = compute_into(con, "t", frozen, geometry="polygon", fingerprint="g")
    assert singles(again) == {ids(out)[0]: 4.25}


def test_a_class_edit_on_a_tool_default_keeps_its_single_value() -> None:
    con = table([0.0] * 91 + [float(i) for i in range(1, 92)])
    out, _ = computed(con, fit_doc())
    first = ids(out)[0]
    edited = copy.deepcopy(out)
    edited["classify"][0]["classes"][0]["fill"]["color"] = "#ff0000"
    frozen = settle_fit(out, edited)
    assert frozen["classify"][0]["method"] == "manual"
    assert singles(frozen) == {first: 0.0}
    again, _ = compute_into(
        con, "t", frozen, geometry="polygon", fingerprint="after-the-edit"
    )
    assert singles(again) == {first: 0.0}


def test_a_single_value_near_0_does_not_read_0() -> None:
    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {"fill": {"color": "#cccccc"}},
        "classify": [
            {
                "field": "v",
                "method": "quantile",
                "count": 7,
                "fit": True,
                "classes": [
                    {"id": "c1", "to": 0.5},
                    {"id": "c2", "from": 0.5, "to": 1},
                    {"id": "c3", "from": 1},
                ],
                "computed": {
                    "at": "t",
                    "data": "f",
                    "domain": [0.0003, 3],
                    "single": {"c1": 0.0003},
                },
            }
        ],
    }
    assert class_decimals(doc["classify"][0]) == 4


def test_a_single_value_that_is_its_own_bound_asks_only_for_its_own_digits() -> None:
    # The bound is the value rounded down to 12 digits, the single value the
    # nearest 12-digit number: one number, read to its first 3 digits (84.6),
    # not to the 10 decimals that would tell its two stored forms apart.
    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {"fill": {"color": "#cccccc"}},
        "classify": [
            {
                "field": "v",
                "method": "quantile",
                "count": 7,
                "fit": True,
                "classes": [
                    {"id": "c1", "to": 84.5647078963},
                    {"id": "c2", "from": 84.5647078963},
                ],
                "computed": {
                    "at": "t",
                    "data": "f",
                    "domain": [78.7734526649, 91.6420824502],
                    "single": {"c1": 78.7734526649, "c2": 84.5647078964},
                },
            }
        ],
    }
    assert class_decimals(doc["classify"][0]) == 1


def test_a_mean_column_reads_its_single_values_not_their_last_digits() -> None:
    # Means of seven: every value ends in .142857..., which the nearest
    # 12-digit number rounds up and a break rounds down. The dominant value's
    # class holds it alone: one number, read to its first 3 digits (85.1), not
    # to the 10 decimals that would tell its two stored forms apart.
    values = [k + 1 / 7 for k in range(70, 100)] + [85 + 1 / 7] * 30
    out, _ = computed(table(values), fit_doc())
    c = out["classify"][0]
    single = c["computed"]["single"]
    starts = {k["id"]: k.get("from") for k in c["classes"]}
    assert any(starts[i] is not None and starts[i] != v for i, v in single.items())
    assert c["computed"]["decimals"] == 1


def test_half_minutes_held_alone_read_as_they_are() -> None:
    counts = [(3, 2), (6, 4), (9, 32), (10.5, 21), (12, 54), (13.5, 43), (15, 38)]
    counts += [(16.5, 22), (18, 25), (19.5, 15), (21, 16), (22.5, 3), (24, 8)]
    out, _ = computed(table([float(v) for v, n in counts for _ in range(n)]), fit_doc())
    single = out["classify"][0]["computed"]["single"]
    assert 10.5 in single.values() and 13.5 in single.values()
    assert out["classify"][0]["computed"]["decimals"] == 1


def _with_singles(values: dict[str, float], bound: float) -> dict[str, Any]:
    return {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {"fill": {"color": "#cccccc"}},
        "classify": [
            {
                "field": "v",
                "method": "quantile",
                "count": 7,
                "fit": True,
                "classes": [{"id": "c1", "to": bound}, {"id": "c2", "from": bound}],
                "computed": {
                    "at": "t",
                    "data": "f",
                    "domain": [1, 100000],
                    "single": values,
                },
            }
        ],
    }


def test_a_single_value_reads_its_first_3_significant_digits() -> None:
    def decimals(values: dict[str, float], bound: float) -> int:
        decimals = class_decimals(_with_singles(values, bound)["classify"][0])
        assert decimals is not None
        return decimals

    assert decimals({"c2": 84.5647078964}, 84.5647078963) == 1
    assert decimals({"c2": 1234.5}, 1234.5) == 0
    assert decimals({"c2": 30.0}, 30.0) == 0
    assert decimals({"c2": 2.125}, 2.125) == 2


@pytest.mark.parametrize(
    ("value", "decimals"),
    [
        (0.0, 0),
        (1.0, 0),
        (12.5, 1),
        (0.087, 3),
        (0.004, 3),
        (1234.5, 0),
        (99.789, 1),
        (78.8234567, 1),
        (25146.77, 0),
        (0.00318, 5),
        (-3.0, 0),
        (1e-9, 9),
        (30.0, 0),
        (0.12345, 3),
    ],
)
def test_the_decimals_of_a_value_shown_alone(value: float, decimals: int) -> None:
    assert value_decimals(value) == decimals


def test_a_constant_of_three_decimals_reads_all_three() -> None:
    out, _ = computed(table([0.087] * 6), fit_doc())
    assert out["classify"][0]["computed"]["decimals"] == 3


# Manual classes with closed ends: values outside them are in no class.


def test_closed_ends_of_manual_classes_leave_out_the_values_beyond_them() -> None:
    con = table([0.0] * 50 + [float(i) for i in range(1, 51)])
    doc = copy.deepcopy(MANUAL)
    doc["classify"][0]["classes"] = [
        {"id": "c1", "from": 0.5, "to": 1},
        {"id": "c2", "from": 1, "to": 2},
        {"id": "c3", "from": 2, "to": 49},
        {"id": "c4", "from": 49, "to": 49.5},
    ]
    out, _ = computed(con, doc)
    # The zeros lie below the first class, 50 above the last: in no class.
    assert singles(out) == {"c2": 1.0, "c4": 49.0}


def test_open_ends_of_manual_classes_hold_every_value_beyond_their_bounds() -> None:
    con = table([0.0] * 5 + [float(i) for i in range(1, 6)])
    doc = copy.deepcopy(MANUAL)
    doc["classify"][0]["classes"] = [
        {"id": "c1", "to": 1},
        {"id": "c2", "from": 1, "to": 5},
        {"id": "c3", "from": 5},
    ]
    out, _ = computed(con, doc)
    assert singles(out) == {"c1": 0.0, "c3": 5.0}


# Zero is never negative where `fit` computes values.


@pytest.mark.parametrize(
    "values",
    [
        [-0.0, 0.0, 0.0, 1.0, 2.0, 3.0],
        [0.0, 0.0, -0.0, 1.0, 2.0, 3.0],
        [-0.0] * 3 + [5.0],
    ],
)
def test_negative_zero_reads_as_zero(values: list[float]) -> None:
    out, _ = computed(table(values), fit_doc())
    c = out["classify"][0]["computed"]
    zeros = [c["domain"][0], *(v for v in c["single"].values() if v == 0)]
    assert zeros and all(math.copysign(1.0, v) == 1.0 for v in zeros), c
    b = fitted_breaks(table(values), "t", "v", 7)
    assert math.copysign(1.0, b.min) == 1.0
    assert all(math.copysign(1.0, s) == 1.0 for s in b.singles if s == 0)


# A field the data no longer has: what the server wrote stays, as without fit.


def test_a_fitted_classification_whose_field_is_gone_keeps_what_it_computed() -> None:
    con = table([1.0] * 10 + [2.0] * 3 + [3.0])
    out, _ = computed(con, fit_doc())
    before = out["classify"][0]["computed"]
    assert before["single"]
    con.execute("ALTER TABLE t RENAME COLUMN v TO w")
    again, _ = compute_into(con, "t", out, geometry="polygon", fingerprint="g")
    after = again["classify"][0]["computed"]
    assert (after["single"], after["generated"], after["domain"]) == (
        before["single"],
        before["generated"],
        before["domain"],
    )


# The decimals the labels need (`computed.decimals`), recorded with `fit` on
# every compute.


def decimals(doc: dict[str, Any]) -> int | None:
    return doc["classify"][0]["computed"].get("decimals")


def test_the_decimals_follow_the_data() -> None:
    con = table([float(i) for i in range(1, 51)])
    out, _ = computed(con, fit_doc())
    assert decimals(out) == 0
    # Small values arrive: their class reads them to three significant digits.
    con.execute("INSERT INTO t SELECT 0.004 FROM range(10)")
    small, _ = computed(con, out, fingerprint="g")
    assert singles(small)[ids(small)[0]] == 0.004
    assert decimals(small) == 3
    # The values become whole numbers again: no decimals.
    con.execute("DELETE FROM t WHERE v < 1")
    whole, _ = computed(con, small, fingerprint="h")
    assert decimals(whole) == 0


def test_a_format_the_style_gives_stays_as_it_is() -> None:
    con = table([0.004] * 10 + [float(i) for i in range(1, 51)])
    out, _ = computed(con, fit_doc(format={"decimals": 1}))
    c = out["classify"][0]
    assert c["format"] == {"decimals": 1}
    assert c["computed"]["decimals"] == 3


def test_without_fit_no_decimals_are_recorded() -> None:
    con = table([0.004] * 10 + [float(i) for i in range(1, 51)])
    doc = fit_doc()
    del doc["classify"][0]["fit"]
    out, _ = computed(con, doc)
    assert "decimals" not in out["classify"][0]["computed"]
    manual = copy.deepcopy(MANUAL)
    del manual["classify"][0]["fit"]
    out, _ = computed(con, manual)
    assert "decimals" not in out["classify"][0]["computed"]


def test_fit_on_another_method_records_no_decimals() -> None:
    con = table([0.004] * 10 + [float(i) for i in range(1, 51)])
    out, _ = computed(con, fit_doc(method="equal_interval"))
    assert "decimals" not in out["classify"][0]["computed"]


def test_manual_classes_with_fit_record_their_decimals() -> None:
    con = table([0.0, 0.0, 1.0, 2.0, 5.0])
    out, _ = computed(con, MANUAL)
    assert decimals(out) == 0
    con.execute("INSERT INTO t VALUES (5.25)")
    again, _ = computed(con, out, fingerprint="g")
    # The last class holds 5 and 5.25: its range "5.0 to 5.3" reads to the
    # domain's end, one decimal apart.
    assert singles(again) == {"c1": 0.0}
    assert decimals(again) == 1


def test_a_class_edit_on_a_tool_default_keeps_its_decimals() -> None:
    con = table([0.004] * 10 + [float(i) for i in range(1, 51)])
    out, _ = computed(con, fit_doc())
    edited = copy.deepcopy(out)
    edited["classify"][0]["classes"][0]["fill"]["color"] = "#ff0000"
    frozen = settle_fit(out, edited)
    assert frozen["classify"][0]["method"] == "manual"
    assert decimals(frozen) == decimals(out) == 3
    again, _ = compute_into(con, "t", frozen, geometry="polygon", fingerprint="g")
    assert decimals(again) == 3


def test_a_compute_on_the_same_data_changes_nothing() -> None:
    con = table([0.004] * 10 + [float(i) for i in range(1, 51)])
    out, _ = computed(con, fit_doc())
    again, _ = compute_into(con, "t", out, geometry="polygon", fingerprint="f")
    assert again == out


def test_a_field_that_is_gone_keeps_the_decimals() -> None:
    con = table([0.004] * 10 + [float(i) for i in range(1, 51)])
    out, _ = computed(con, fit_doc())
    con.execute("ALTER TABLE t RENAME COLUMN v TO w")
    again, _ = compute_into(con, "t", out, geometry="polygon", fingerprint="g")
    assert decimals(again) == decimals(out) == 3
