"""The value of a class that holds one (`computed.single`, the specification's
7.2 and 12), written for classes fitted to the data (`fit`)."""

import copy
from typing import Any

from goatlib.style.compute import needed_stats
from goatlib.style.data import compute_into, fitted_breaks
from goatlib.style.edit import settle_fit
from goatlib.tools.style import with_decimals

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
    assert with_decimals(doc)["classify"][0]["format"] == {"decimals": 4}


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
    assert with_decimals(doc)["classify"][0]["format"] == {"decimals": 1}


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
    assert with_decimals(out)["classify"][0]["format"] == {"decimals": 1}


def test_half_minutes_held_alone_read_as_they_are() -> None:
    counts = [(3, 2), (6, 4), (9, 32), (10.5, 21), (12, 54), (13.5, 43), (15, 38)]
    counts += [(16.5, 22), (18, 25), (19.5, 15), (21, 16), (22.5, 3), (24, 8)]
    out, _ = computed(table([float(v) for v, n in counts for _ in range(n)]), fit_doc())
    single = out["classify"][0]["computed"]["single"]
    assert 10.5 in single.values() and 13.5 in single.values()
    assert with_decimals(out)["classify"][0]["format"] == {"decimals": 1}


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


def test_a_single_value_reads_its_first_3_digits_up_to_2_decimals() -> None:
    def decimals(values: dict[str, float], bound: float) -> int:
        doc = with_decimals(_with_singles(values, bound))
        return doc["classify"][0]["format"]["decimals"]

    assert decimals({"c2": 84.5647078964}, 84.5647078963) == 1
    assert decimals({"c2": 1234.5}, 1234.5) == 0
    assert decimals({"c2": 30.0}, 30.0) == 0
    assert decimals({"c2": 2.125}, 2.125) == 2
