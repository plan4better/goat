"""Classes fitted to the data (`fit`) read as ranges: the compute records no
value per class, and the decimals of their labels (`computed.decimals`, the
specification's 5.2 and 12) come from the class bounds and the domain alone."""

import copy
import dataclasses
import math
from typing import Any

import pytest
from goatlib.style.compute import Breaks, needed_stats
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


# The decimals: from the class bounds and the domain alone.


def test_the_decimals_come_from_the_bounds_alone() -> None:
    # Three values, 2.5 and 4 in the last class: the bound 2.5 and the
    # domain's ends 1 and 4 read apart without decimals ("1 to 3", "3 to 4").
    out, _ = computed(table([1.0] * 10 + [2.5] * 10 + [4.0] * 10), fit_doc())
    assert [k.get("from") for k in out["classify"][0]["classes"]] == [None, 2.5]
    assert decimals(out) == 0


def test_a_mean_column_reads_its_bounds() -> None:
    # Means of seven end in .142857...: whole numbers apart, read without
    # decimals, the dominant value's class as any other.
    values = [k + 1 / 7 for k in range(70, 100)] + [85 + 1 / 7] * 30
    out, _ = computed(table(values), fit_doc())
    assert decimals(out) == 0


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
    # The last class "5.0 to 5.3" reads to the domain's end, one decimal apart.
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
