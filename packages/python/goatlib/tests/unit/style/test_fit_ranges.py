"""Classes fitted to the data (`fit`) read as ranges: the compute records no
value per class, and the decimals of their labels (`computed.decimals`, the
specification's 5.2 and 12) show the class bounds and the domain as they are."""

import copy
import dataclasses
import decimal
import math
from typing import Any

import duckdb
import pytest
from goatlib.style.compute import (
    Breaks,
    class_decimals,
    decimals_for,
    needed_stats,
    value_decimals,
)
from goatlib.style.context import DataContext
from goatlib.style.data import compute_into, fitted_breaks
from goatlib.style.edit import settle_fit
from goatlib.style.upgrade import upgrade
from goatlib.style.validate import validate
from goatlib.tools.style import with_decimals

from .test_fit_classes import computed, fit_doc, table

CTX = DataContext(kind="vector", geometry="polygon")

#: Values whose fitted classes need two decimals to read apart.
HUNDREDTHS = [i / 100 for i in range(1, 51)]


def decimals(doc: dict[str, Any]) -> int | None:
    return doc["classify"][0]["computed"].get("decimals")


@pytest.mark.parametrize(
    ("values", "palette"),
    [
        ([5.0] * 3 + [None], "colorbrewer:Blues"),
        ([1.0] * 10 + [2.0] * 3 + [3.0], "colorbrewer:Blues"),
        ([0.0] * 91 + [float(i) for i in range(1, 92)], "colorbrewer:Blues"),
        ([0.97] * 92 + [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], "colorbrewer:Blues"),
        (
            [float(-i) for i in range(1, 31)]
            + [0.0] * 31
            + [float(i) for i in range(1, 63)],
            "colorbrewer:RdBu",
        ),
    ],
)
def test_no_class_records_a_value_of_its_own(values: list[Any], palette: str) -> None:
    out, _ = computed(table(values), fit_doc(palette=palette))
    assert "single" not in out["classify"][0]["computed"]


def test_fitted_breaks_know_no_value_per_class() -> None:
    assert "singles" not in {f.name for f in dataclasses.fields(Breaks)}


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


def test_manual_classes_with_fit_ask_only_for_the_range() -> None:
    assert needed_stats(MANUAL) == [("range", "v"), ("presence", "v")]
    out, _ = computed(table([0.0, 0.0, 1.0, 2.0, 5.0]), MANUAL)
    assert "single" not in out["classify"][0]["computed"]


def test_a_class_edit_keeps_ranges() -> None:
    con = table([0.0] * 91 + [float(i) for i in range(1, 92)])
    out, _ = computed(con, fit_doc())
    edited = copy.deepcopy(out)
    edited["classify"][0]["classes"][0]["fill"]["color"] = "#ff0000"
    frozen = settle_fit(out, edited)
    assert frozen["classify"][0]["method"] == "manual"
    again, _ = compute_into(con, "t", frozen, geometry="polygon", fingerprint="g")
    assert "single" not in again["classify"][0]["computed"]


# The decimals: the class bounds and the domain as they are.


def classes_over(
    domain: list[float], breaks: list[float], **more: Any
) -> dict[str, Any]:
    """A computed classification over `domain` with classes cut at `breaks`."""
    starts = [None, *breaks]
    return {
        "id": "v",
        "field": "v",
        "method": "quantile",
        "fit": True,
        "classes": [
            {"id": f"c{n}", **({} if s is None else {"from": s})}
            for n, s in enumerate(starts, 1)
        ],
        "computed": {"domain": domain},
        **more,
    }


@pytest.mark.parametrize(
    ("domain", "breaks", "expected"),
    [
        # Whole minutes stay whole ("3 to 5 min").
        ([3.0, 13.0], [5.0, 7.0, 8.0, 10.0, 12.0], 0),
        # A boundary on a half minute: one decimal ("3.0 to 10.5 min").
        ([3.0, 24.0], [10.5, 12.0, 13.5, 15.0, 16.5, 19.5], 1),
        # Means, the narrowest step 0.57: one decimal ("78.8 to 79.9").
        (
            [78.7734526649, 91.6420824502],
            [79.8546732726, 83.9343790455, 84.5647078963, 89.2323510858, 91.075089349],
            1,
        ),
        # Large sums: the narrowest step lies far above 10 ("17,573 to 25,147").
        (
            [17572.5978169, 1216529.57673],
            [25146.7696361, 34505.8910978, 84201.7333884, 258419.082046],
            0,
        ),
        # Tiny values in steps of 0.00002: five decimals ("0.00005 to 0.00007").
        ([5e-05, 0.000206], [7.4e-05, 9.4e-05, 0.000118, 0.000142, 0.000162], 5),
        # A share from 0 to 1 in steps of 0.2 ("0.0 to 0.2").
        ([0.0, 1.0], [0.2, 0.4, 0.6, 0.8], 1),
        # A negative range, the narrowest step 0.15 ("-1.00 to -0.75").
        ([-1.0, -0.1], [-0.75, -0.5, -0.25], 2),
        # Values crossing 0 with the centre: the step from -1.25 to 0 decides.
        ([-3.5, 12.0], [-1.25, 0.0, 2.0, 6.0], 1),
        # One huge step and one small one: the small one decides.
        ([3.0, 90000.125], [10.25, 10.75, 5000.0], 1),
        # Rounding moves no bound by more than a quarter of the narrowest
        # step: steps of exactly 0.2 take one decimal, of 0.00002 five.
        ([0.05, 1.05], [0.25, 0.45, 0.65, 0.85], 1),
        ([1.3e-05, 9.3e-05], [3.3e-05, 5.3e-05, 7.3e-05], 5),
        # Thirds stored to 12 digits read as the exact fractions would.
        ([0.0333333333333, 0.633333333333], [0.233333333333, 0.433333333333], 1),
        # A step of 0.25 takes one decimal, a step of 0.15 two.
        ([1.0, 2.0], [1.25, 1.5, 1.75], 1),
        ([1.0, 1.6], [1.15, 1.3, 1.45], 2),
        # Never more than the format takes.
        ([1e-05, 2e-05], [1.5e-05, 1.50000000001e-05], 10),
        # One class over one value keeps its own rule.
        ([0.087, 0.087], [], 3),
    ],
)
def test_fitted_decimals_show_the_bounds_as_they_are(
    domain: list[float], breaks: list[float], expected: int
) -> None:
    # The fewest decimals at which the bounds read apart, raised until
    # rounding moves no bound by more than a quarter of the narrowest step,
    # never more than the values have.
    assert class_decimals(classes_over(domain, breaks)) == expected


def test_the_decimals_do_not_follow_the_callers_decimal_precision() -> None:
    # Steps of 0.15 above 100 take two decimals, also where the caller's
    # decimal context holds only three digits.
    c = classes_over([100.0, 101.0], [100.15, 100.5])
    assert class_decimals(c) == 2
    context = decimal.getcontext()
    precision = context.prec
    context.prec = 3
    try:
        assert class_decimals(c) == 2
    finally:
        context.prec = precision


@pytest.mark.parametrize(
    "more", [{"fit": False}, {"method": "equal_interval"}, {"method": "natural_breaks"}]
)
def test_without_recorded_decimals_the_bounds_read_apart_alone(
    more: dict[str, Any],
) -> None:
    # Without `fit`, or with it on a method it does not act on, the decimals
    # are the fewest at which the bounds read apart ("3 to 11").
    breaks = [10.5, 12.0, 13.5, 15.0, 16.5, 19.5]
    c = classes_over([3.0, 24.0], breaks, **more)
    assert class_decimals(c) == decimals_for(breaks, [3.0, 24.0]) == 0


def test_the_decimals_show_a_bound_on_a_half() -> None:
    # Three values, 2.5 and 4 in the last class: "1.0 to 2.5", "2.5 to 4.0".
    out, _ = computed(table([1.0] * 10 + [2.5] * 10 + [4.0] * 10), fit_doc())
    assert [k.get("from") for k in out["classify"][0]["classes"]] == [None, 2.5]
    assert decimals(out) == 1


def test_a_mean_column_reads_its_bounds() -> None:
    # Means of seven end in .142857... and lie whole numbers apart: rounding
    # moves no bound by more than a quarter of the step of 1 at one decimal,
    # the dominant value's class as any other.
    values = [k + 1 / 7 for k in range(70, 100)] + [85 + 1 / 7] * 30
    out, _ = computed(table(values), fit_doc())
    assert decimals(out) == 1


@pytest.mark.parametrize(
    ("value", "fitted", "plain"),
    [
        (0.087, 3, 2),
        (99.7892905504, 1, 2),
        (5.0, 0, 0),
        (4.25, 2, 2),
        (0.004, 3, 3),
        (1234.5, 0, 1),
    ],
)
def test_one_class_over_one_value_reads_it(
    value: float, fitted: int, plain: int
) -> None:
    # With fit its first three significant digits, never more decimals than
    # it has; without fit up to two decimals, more where fewer would read 0.
    con = table([value] * 6)
    out, _ = computed(con, fit_doc())
    assert len(out["classify"][0]["classes"]) == 1
    assert decimals(out) == fitted
    doc = fit_doc()
    del doc["classify"][0]["fit"]
    plain_out, _ = computed(con, doc)
    written = with_decimals(plain_out)["classify"][0]
    assert written["format"] == {"decimals": plain}


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


@pytest.mark.parametrize(
    ("values", "breaks"),
    [
        # Three values: 2 and 3 share the last class ("1 to 2", "2 to 3").
        ([1.0, 2.0, 3.0], [2.0]),
        # Two values: one class from 1 to 2.
        ([1.0] * 5 + [2.0] * 5, []),
        # A dominant maximum shares the class of the value below it.
        (
            [0.97] * 92 + [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
            [0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
        ),
        # A maximum of 0 stays in the top class with the values below it.
        ([-3.0, -2.0, -1.0] + [0.0] * 20, [-2.0, -1.0]),
    ],
)
def test_the_maximum_shares_the_last_class(
    values: list[float], breaks: list[float]
) -> None:
    con = table(values)
    out, _ = computed(con, fit_doc())
    c = out["classify"][0]
    assert [k.get("from") for k in c["classes"][1:]] == breaks
    assert all(b < c["computed"]["domain"][1] for b in breaks)


def test_the_decimals_follow_the_data() -> None:
    con = table([float(i) for i in range(1, 51)])
    out, _ = computed(con, fit_doc())
    assert decimals(out) == 0
    # Hundredths arrive: their bounds read two decimals apart.
    con.execute("DELETE FROM t")
    con.executemany("INSERT INTO t VALUES (?)", [[v] for v in HUNDREDTHS])
    small, _ = computed(con, out, fingerprint="g")
    assert decimals(small) == 2
    # Whole numbers again: no decimals.
    con.execute("DELETE FROM t")
    con.execute("INSERT INTO t SELECT range FROM range(1, 51)")
    whole, _ = computed(con, small, fingerprint="h")
    assert decimals(whole) == 0


def test_a_format_the_style_gives_stays_as_it_is() -> None:
    out, _ = computed(table(HUNDREDTHS), fit_doc(format={"decimals": 1}))
    c = out["classify"][0]
    assert c["format"] == {"decimals": 1}
    assert c["computed"]["decimals"] == 2


def test_without_fit_no_decimals_are_recorded() -> None:
    con = table(HUNDREDTHS)
    doc = fit_doc()
    del doc["classify"][0]["fit"]
    out, _ = computed(con, doc)
    assert "decimals" not in out["classify"][0]["computed"]
    manual = copy.deepcopy(MANUAL)
    del manual["classify"][0]["fit"]
    out, _ = computed(con, manual)
    assert "decimals" not in out["classify"][0]["computed"]


def test_fit_on_another_method_records_no_decimals() -> None:
    out, _ = computed(table(HUNDREDTHS), fit_doc(method="equal_interval"))
    assert "decimals" not in out["classify"][0]["computed"]


def test_manual_classes_with_fit_record_their_decimals() -> None:
    con = table([0.0, 0.0, 1.0, 2.0, 5.0])
    out, _ = computed(con, MANUAL)
    assert decimals(out) == 0
    con.execute("INSERT INTO t VALUES (5.25)")
    again, _ = computed(con, out, fingerprint="g")
    # The last class "5.0 to 5.3": the step of 0.25 to the domain's end
    # takes one decimal.
    assert decimals(again) == 1


def test_a_class_edit_on_a_tool_default_keeps_its_decimals() -> None:
    con = table(HUNDREDTHS)
    out, _ = computed(con, fit_doc())
    edited = copy.deepcopy(out)
    edited["classify"][0]["classes"][0]["fill"]["color"] = "#ff0000"
    frozen = settle_fit(out, edited)
    assert frozen["classify"][0]["method"] == "manual"
    assert decimals(frozen) == decimals(out) == 2
    again, _ = compute_into(con, "t", frozen, geometry="polygon", fingerprint="g")
    assert decimals(again) == 2


# An edit that ends `fit` writes no decimals: the classes it asks for are new.


def _minutes_and_shares() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("CREATE TABLE t (v DOUBLE, w DOUBLE)")
    con.executemany(
        "INSERT INTO t VALUES (?, ?)",
        [[float(3 + i % 11), 0.003 + i * 0.0004] for i in range(41)],
    )
    return con


@pytest.mark.parametrize(
    ("key", "value", "values"),
    [
        # Whole minutes record 0 decimals; a share from 0.003 to 0.019 follows.
        ("field", "w", None),
        # Values from 0 to 3 in 3 classes, then 9 classes.
        ("count", 9, [i / 10 for i in range(31)]),
    ],
)
def test_an_edit_that_ends_fit_writes_no_decimals(
    key: str, value: Any, values: list[float] | None
) -> None:
    con = _minutes_and_shares() if values is None else table(values)
    out, _ = computed(con, fit_doc(count=7 if values is None else 3))
    assert decimals(out) == 0
    edited = copy.deepcopy(out)
    edited["classify"][0][key] = value
    settled = settle_fit(out, edited)
    c = settled["classify"][0]
    assert "fit" not in c and "format" not in c
    # The recompute writes no format and records no decimals.
    again, _ = compute_into(con, "t", settled, geometry="polygon", fingerprint="g")
    assert "format" not in again["classify"][0]
    assert "decimals" not in again["classify"][0]["computed"]


def test_an_edit_that_ends_fit_keeps_the_format_it_states() -> None:
    con = _minutes_and_shares()
    out, _ = computed(con, fit_doc(format={"suffix": " min"}))
    edited = copy.deepcopy(out)
    edited["classify"][0]["field"] = "w"
    c = settle_fit(out, edited)["classify"][0]
    assert "fit" not in c and c["format"] == {"suffix": " min"}


def test_a_compute_on_the_same_data_changes_nothing() -> None:
    con = table(HUNDREDTHS)
    out, _ = computed(con, fit_doc())
    again, _ = compute_into(con, "t", out, geometry="polygon", fingerprint="f")
    assert again == out


def test_a_field_that_is_gone_keeps_what_it_computed() -> None:
    con = table(HUNDREDTHS)
    out, _ = computed(con, fit_doc())
    before = out["classify"][0]["computed"]
    con.execute("ALTER TABLE t RENAME COLUMN v TO w")
    again, _ = compute_into(con, "t", out, geometry="polygon", fingerprint="g")
    after = again["classify"][0]["computed"]
    assert (after["generated"], after["domain"], after["decimals"]) == (
        before["generated"],
        before["domain"],
        2,
    )


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
    assert math.copysign(1.0, out["classify"][0]["computed"]["domain"][0]) == 1.0
    b = fitted_breaks(table(values), "t", "v", 7)
    assert math.copysign(1.0, b.min) == 1.0


# A stored document that still carries `computed.single`.


def _stored_with_single() -> tuple[Any, dict[str, Any], dict[str, Any]]:
    con = table([1.0] * 10 + [2.0] * 3 + [3.0])
    out, _ = computed(con, fit_doc())
    stored = copy.deepcopy(out)
    first = stored["classify"][0]["classes"][0]["id"]
    stored["classify"][0]["computed"]["single"] = {first: 1.0}
    return con, out, stored


def test_the_model_reports_single_as_an_unknown_key() -> None:
    _, _, stored = _stored_with_single()
    codes = {(i.code, i.path) for i in validate(stored, CTX) if i.level == "error"}
    assert codes == {("unknown_key", "/classify/v/computed/single")}


def test_a_stored_document_with_single_reads_without_it() -> None:
    _, out, stored = _stored_with_single()
    read = upgrade(stored, CTX).document
    assert read == out
    assert [i for i in validate(read, CTX) if i.level == "error"] == []
    # The stored document itself is not changed.
    assert "single" in stored["classify"][0]["computed"]


@pytest.mark.parametrize("fingerprint", ["f", "g"])
def test_a_recompute_of_a_stored_document_with_single_drops_it(
    fingerprint: str,
) -> None:
    con, _, stored = _stored_with_single()
    again, _ = compute_into(
        con, "t", stored, geometry="polygon", fingerprint=fingerprint
    )
    assert "single" not in again["classify"][0]["computed"]
    assert [i for i in validate(again, CTX) if i.level == "error"] == []


@pytest.mark.parametrize(
    ("value", "ok"), [(0, True), (10, True), (-1, False), (11, False), (101, False)]
)
def test_recorded_decimals_lie_from_0_to_the_most_a_format_takes(
    value: int, ok: bool
) -> None:
    con = table(HUNDREDTHS)
    out, _ = computed(con, fit_doc())
    out["classify"][0]["computed"]["decimals"] = value
    errors = [i.path for i in validate(out, CTX) if i.level == "error"]
    assert errors == ([] if ok else ["/classify/v/computed/decimals"])
