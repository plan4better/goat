"""Classes fitted to the data (`fit`, the specification's section 5.2) and their
centre at 0 on a diverging palette."""

import random
from typing import Any

import duckdb
import pytest
from goatlib.analysis.schemas.statistics import ClassBreakMethod
from goatlib.analysis.statistics import calculate_class_breaks
from goatlib.style.colors import sample_colors
from goatlib.style.compute import (
    Breaks,
    apply_computed,
    breaks_for_classes,
    needed_stats,
    same_ignoring_stamps,
)
from goatlib.style.context import DataContext
from goatlib.style.data import centred, compute_into, compute_stats, fitted_breaks
from goatlib.style.validate import validate

RDBU = sample_colors("colorbrewer:RdBu", 7)


def table(values: list[Any], name: str = "t") -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(f"CREATE TABLE {name} (v DOUBLE)")
    if values:
        con.executemany(f"INSERT INTO {name} VALUES (?)", [[v] for v in values])
    return con


def held(con: duckdb.DuckDBPyConnection, b: Breaks, relation: str = "t") -> list[int]:
    """The features of each class: from (inclusive) to (exclusive), the first
    from the data's minimum, the last to its maximum."""
    edges = [None, *b.breaks, None]
    out = []
    for lo, hi in zip(edges, edges[1:]):
        out.append(
            con.execute(
                f"SELECT count(*) FROM {relation} WHERE v IS NOT NULL AND isfinite(v) "
                "AND (? IS NULL OR v >= ?) AND (? IS NULL OR v < ?)",
                [lo, lo, hi, hi],
            ).fetchone()[0]
        )
    return out


def fit_doc(
    count: int = 7, palette: Any = "colorbrewer:Blues", **more: Any
) -> dict[str, Any]:
    return {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {"fill": {"color": "#cccccc"}},
        "classify": [
            {
                "id": "v",
                "field": "v",
                "method": "quantile",
                "count": count,
                "fit": True,
                "palette": palette,
                **more,
            }
        ],
    }


def computed(
    con: duckdb.DuckDBPyConnection, doc: dict[str, Any], fingerprint: str = "f"
) -> tuple[dict[str, Any], list]:
    out, notes = compute_into(
        con, "t", doc, geometry="polygon", fingerprint=fingerprint
    )
    errors = [
        i
        for i in validate(out, DataContext(kind="vector", geometry="polygon"))
        if i.level == "error"
    ]
    assert errors == []
    return out, notes


def colors(doc: dict[str, Any]) -> list[str]:
    return [k["fill"]["color"] for k in doc["classify"][0]["classes"]]


# The stat keys: only `fit` on quantile classes asks for fitted breaks.


def test_the_key_of_fitted_classes_has_a_fifth_part() -> None:
    assert needed_stats(fit_doc())[0] == ("breaks", "v", "quantile", "7", "fit")


def test_a_diverging_catalogue_palette_adds_the_centre() -> None:
    key = needed_stats(fit_doc(palette="colorbrewer:RdBu"))[0]
    assert key == ("breaks", "v", "quantile", "7", "fit", "centre")


@pytest.mark.parametrize("palette", ["colorbrewer:Blues", ["#ff0000", "#0000ff"]])
def test_other_palettes_have_no_centre(palette: Any) -> None:
    assert needed_stats(fit_doc(palette=palette))[0] == (
        "breaks",
        "v",
        "quantile",
        "7",
        "fit",
    )


@pytest.mark.parametrize(
    "change",
    [
        {"fit": False},
        {"method": "equal_interval"},
        {"method": "natural_breaks"},
    ],
)
def test_without_fit_or_on_another_method_the_key_is_as_today(change: dict) -> None:
    doc = fit_doc(palette="colorbrewer:RdBu")
    doc["classify"][0].update(change)
    method = doc["classify"][0]["method"]
    assert needed_stats(doc)[0] == ("breaks", "v", method, "7")


def test_without_the_key_classes_compute_as_the_four_part_path() -> None:
    values = [0.0] * 50 + [float(i) for i in range(1, 51)]
    con = table(values)
    doc = fit_doc()
    del doc["classify"][0]["fit"]
    out, notes = compute_into(con, "t", doc, geometry="polygon", fingerprint="f")
    raw = calculate_class_breaks(con, "t", "v", ClassBreakMethod.quantile, 6)
    today = breaks_for_classes(raw.breaks, raw.min, raw.max, 7)
    expected, expected_notes = apply_computed(
        doc,
        {
            ("breaks", "v", "quantile", "7"): today,
            ("presence", "v"): compute_stats(con, "t", [("presence", "v")])[
                ("presence", "v")
            ],
        },
        geometry="polygon",
        fingerprint="f",
        at="t",
    )
    assert same_ignoring_stamps(out, expected)
    assert [n.code for n in notes] == [n.code for n in expected_notes]
    assert today.merged and notes[0].code == "classes_merged"


# The algorithm.


def test_no_values_give_no_breaks() -> None:
    con = table([None, None])
    assert fitted_breaks(con, "t", "v", 7) == Breaks((), None, None, False)


def test_one_value_gives_one_class() -> None:
    con = table([5.0] * 4 + [None])
    assert fitted_breaks(con, "t", "v", 7) == Breaks((), 5.0, 5.0, False)


def test_few_values_get_one_class_each() -> None:
    con = table([1.0] * 10 + [2.0] * 3 + [3.0])
    b = fitted_breaks(con, "t", "v", 7)
    # The maximum takes no class of its own: 2 and 3 share the last class.
    assert b == Breaks((2.0,), 1.0, 3.0, False)
    assert held(con, b) == [10, 4]


def test_nan_and_infinity_are_no_values() -> None:
    con = table([1.0, 2.0, 3.0, float("nan"), float("inf"), float("-inf"), None])
    assert fitted_breaks(con, "t", "v", 7) == Breaks((2.0,), 1.0, 3.0, False)


def test_a_dominant_zero_gets_its_own_class() -> None:
    con = table([0.0] * 91 + [float(i) for i in range(1, 92)])
    b = fitted_breaks(con, "t", "v", 7)
    assert b.breaks == (1.0, 16.0, 31.0, 46.0, 61.0, 76.0)
    assert held(con, b) == [91, 15, 15, 15, 15, 15, 16]


def plain(con: duckdb.DuckDBPyConnection, n: int) -> Breaks:
    """Plain quantile classes, as a classification without `fit` gets them."""
    key = ("breaks", "v", "quantile", str(n))
    return compute_stats(con, "t", [key])[key]


def top_alone(con: duckdb.DuckDBPyConnection, b: Breaks, relation: str = "t") -> bool:
    """Whether the last of classes `b` holds only the maximum: plain quantile
    can isolate it with a break just below it; a fitted classification never
    does."""
    if not b.breaks:
        return False
    return con.execute(
        f"SELECT count(DISTINCT v) = 1 FROM {relation} "
        "WHERE v IS NOT NULL AND isfinite(v) AND v >= ?",
        [b.breaks[-1]],
    ).fetchone()[0]


def merged_top(
    con: duckdb.DuckDBPyConnection, b: Breaks, relation: str = "t"
) -> list[int]:
    """The features of each class of `b` (`held`), a last class that holds only
    the maximum merged into the nearest class below it that holds features."""
    counts = held(con, b, relation)
    if not top_alone(con, b, relation):
        return counts
    *rest, last = counts
    below = max((i for i, c in enumerate(rest) if c), default=None)
    if below is None:
        return [*rest, last]
    rest[below] += last
    return rest


def test_a_quantile_break_on_the_minimum_gives_it_a_class() -> None:
    # Of 100 rows, 21 hold 0: the first fifth's break falls on the minimum.
    con = table([0.0] * 21 + [float(i) for i in range(1, 80)])
    b = fitted_breaks(con, "t", "v", 5)
    assert b.breaks[0] == 1.0 and held(con, b)[0] == 21
    assert plain(con, 5).merged


def test_a_value_no_break_falls_on_gets_no_class_of_its_own() -> None:
    # 19 zeros: the first break falls between 1 and 2.
    con = table([0.0] * 19 + [float(i) for i in range(1, 82)])
    b = fitted_breaks(con, "t", "v", 5)
    assert 1.0 not in b.breaks and held(con, b)[0] == 20
    assert held(con, b) == held(con, plain(con, 5))


def test_two_breaks_on_one_value_give_it_a_class() -> None:
    con = table(
        [float(i) for i in range(1, 21)]
        + [50.0] * 40
        + [float(i) for i in range(51, 91)]
    )
    b = fitted_breaks(con, "t", "v", 7)
    assert 50.0 in b.breaks and 51.0 in b.breaks
    assert 40 in held(con, b)
    assert len(b.breaks) + 1 <= 7 and min(held(con, b)) >= 1


def test_ties_that_lose_no_class_keep_the_quantile_classes() -> None:
    # 3 and 5 hold 40 rows each, but no break falls on the same value twice
    # nor on an end: the classes are plain quantile's.
    others = [1.0, 2.0, 4.0, *[float(i) for i in range(6, 23)]]
    con = table([5.0] * 40 + [3.0] * 40 + others)
    b = fitted_breaks(con, "t", "v", 3)
    assert b.breaks == (3.0, 5.0)
    assert held(con, b) == held(con, plain(con, 3)) == [2, 41, 57]


def test_whole_minutes_with_ties_keep_the_quantile_classes() -> None:
    counts = [(3, 1), (4, 2), (5, 4), (6, 1), (7, 4), (8, 6)]
    counts += [(9, 1), (10, 5), (11, 1), (12, 5), (13, 5)]
    con = table([float(v) for v, n in counts for _ in range(n)])
    b = fitted_breaks(con, "t", "v", 7)
    today = plain(con, 7)
    assert not today.merged
    # Plain quantile's last class holds 13 alone; fitted, 13 joins 12.
    assert top_alone(con, today)
    assert held(con, b) == merged_top(con, today) == [3, 5, 4, 7, 6, 10]
    assert all(x == int(x) for x in b.breaks)


def test_a_second_round_finds_the_value_the_first_one_moved_onto() -> None:
    # The first round's break falls on 10, the minimum; over the rest the
    # first break then falls on 20, the rest's minimum.
    con = table([10.0] * 20 + [20.0] * 20 + [float(i) for i in range(21, 81)])
    b = fitted_breaks(con, "t", "v", 7)
    assert b.breaks[:2] == (20.0, 21.0)
    counts = held(con, b)
    assert counts[:2] == [20, 20] and len(counts) <= 7 and min(counts) >= 1


def test_a_dominant_maximum_shares_the_last_class() -> None:
    values = [0.97] * 92 + [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
    con = table(values)
    b = fitted_breaks(con, "t", "v", 7)
    assert b.breaks == (0.2, 0.3, 0.4, 0.5, 0.6, 0.7) and b.max == 0.97
    counts = held(con, b)
    assert counts == [1, 1, 1, 1, 1, 1, 94]


def test_many_distinct_values_take_quantile_breaks_moved_onto_values() -> None:
    con = table([float(i) for i in range(1, 101)])
    b = fitted_breaks(con, "t", "v", 7)
    assert len(b.breaks) == 6
    assert all(x == int(x) for x in b.breaks)
    assert sum(held(con, b)) == 100 and min(held(con, b)) >= 14


def test_long_decimals_stay_in_their_class() -> None:
    con = table([i / 3 for i in range(1, 60)])
    b = fitted_breaks(con, "t", "v", 7)
    assert len(b.breaks) == 6 and min(held(con, b)) >= 1
    one = table([1 / 3, 2 / 3, 1.0, 4 / 3])
    assert held(one, fitted_breaks(one, "t", "v", 7)) == [1, 1, 2]


def test_breaks_on_long_decimals_stay_on_their_value() -> None:
    # Thirds, as means of whole minutes: quantile breaks on 11/3, 19/3, 9, 35/3
    # and 43/3 stay on these values (a 12-digit number rounded up would move
    # the value's features to the class below), the last moves up to 52/3.
    con = table([i / 3 for i in range(3, 61) for _ in range(i % 4 + 1)])
    b = fitted_breaks(con, "t", "v", 7)
    today = plain(con, 7)
    assert [round(x, 9) for x in b.breaks] == [
        round(x, 9) for x in (11 / 3, 19 / 3, 9, 35 / 3, 43 / 3, 52 / 3)
    ]
    assert [round(x, 9) for x in today.breaks[:5]] == [
        round(x, 9) for x in b.breaks[:5]
    ]
    assert min(held(con, b)) >= 1


def test_values_alike_to_12_digits_are_one_value() -> None:
    con = table([1.0, 1 + 1e-14, 1 + 2e-14, 2.0])
    b = fitted_breaks(con, "t", "v", 7)
    # Two values: one class from 1 to 2.
    assert b.breaks == () and held(con, b) == [4]


def test_the_same_data_gives_the_same_breaks() -> None:
    values = [float(i % 13) for i in range(300)] + [0.0] * 100
    first = fitted_breaks(table(values), "t", "v", 7)
    random.Random(4).shuffle(values)
    assert fitted_breaks(table(values), "t", "v", 7) == first
    assert first.merged is False


def test_rows_in_any_order_give_the_same_breaks_beyond_12_digits() -> None:
    # Thirteen-digit values: breaks alike to 12 digits stand for several values
    # at the same distance, and the one picked must not depend on row order.
    counts = [(7, 8), (9, 26), (16, 1), (20, 27), (21, 6), (22, 4), (23, 2)]
    counts += [(25, 4), (29, 1), (35, 30), (36, 4), (37, 31), (41, 18), (43, 41)]
    counts += [(46, 2), (47, 2), (48, 47), (49, 24)]
    values = [1_000_000_000_000.0 + v for v, n in counts for _ in range(n)]
    found = set()
    for seed in range(40):
        rows = list(values)
        random.Random(seed).shuffle(rows)
        found.add(fitted_breaks(table(rows), "t", "v", 6, centre=True))
    assert len(found) == 1, found


def test_whole_numbers_of_an_integer_field() -> None:
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE t AS SELECT (CASE WHEN i < 40 THEN 0 ELSE i END)::INTEGER AS v "
        "FROM range(100) r(i)"
    )
    b = fitted_breaks(con, "t", "v", 7)
    assert b.breaks[0] == 40.0 and held(con, b)[0] == 40 and len(b.breaks) <= 6


# The centre at 0.


def test_signed_values_split_at_zero_with_a_neutral_zero_class() -> None:
    values = (
        [float(-i) for i in range(1, 31)]
        + [0.0] * 40
        + [float(i) for i in range(1, 31)]
    )
    con = table(values)
    b = fitted_breaks(con, "t", "v", 7, centre=True)
    # Three negative classes, the zeros' own class from 0 to the next value, two above.
    assert b.breaks[2:4] == (0.0, 1.0)
    assert b.positions == (0, 1, 2, 3, 4, 5)
    assert held(con, b)[3] == 40
    out, _ = computed(con, fit_doc(palette="colorbrewer:RdBu"))
    assert colors(out) == [RDBU[0], RDBU[1], RDBU[2], RDBU[3], RDBU[4], RDBU[5]]


def test_signed_values_without_zero_skip_the_neutral_color() -> None:
    values = [float(-i) for i in range(1, 11)] + [float(i) for i in range(1, 51)]
    con = table(values)
    out, _ = computed(con, fit_doc(palette="colorbrewer:RdBu"))
    c = out["classify"][0]
    froms = [k.get("from") for k in c["classes"]]
    assert 0.0 in froms
    assert colors(out) == [RDBU[0], RDBU[1], RDBU[2], RDBU[4], RDBU[5], RDBU[6]]
    assert c["computed"]["generated"]["values"] == {
        k["id"]: k["fill"]["color"] for k in c["classes"]
    }


def test_a_first_class_holding_only_zeros_takes_the_middle_color() -> None:
    # The break above 0 falls between 0 and 1 and moves up onto 1: the class
    # from 0 holds the zeros alone without 0 being a value of its own.
    values = [float(-i) for i in range(1, 31)] + [0.0] * 31
    values += [float(i) for i in range(1, 63)]
    con = table(values)
    b = fitted_breaks(con, "t", "v", 7, centre=True)
    assert b.breaks[2:4] == (0.0, 1.0) and held(con, b)[3] == 31
    assert b.positions == (0, 1, 2, 3, 4, 5)
    out, _ = computed(con, fit_doc(palette="colorbrewer:RdBu"))
    assert colors(out)[3] == RDBU[3]


def test_few_negative_values_take_the_colors_next_to_the_middle() -> None:
    # Three rows below 0 of 53: a real share (`CENTRE_SHARE`), one value.
    values = [-1.0] * 3 + [float(i) for i in range(1, 51)]
    con = table(values)
    out, _ = computed(con, fit_doc(palette="colorbrewer:RdBu"))
    assert colors(out)[0] == RDBU[2]
    assert colors(out)[1:] == [RDBU[4], RDBU[5], RDBU[6]]


def test_the_centre_honours_reverse() -> None:
    values = [float(-i) for i in range(1, 11)] + [float(i) for i in range(1, 51)]
    con = table(values)
    out, _ = computed(con, fit_doc(palette="colorbrewer:RdBu", reverse=True))
    flipped = list(reversed(RDBU))
    assert colors(out) == [flipped[i] for i in (0, 1, 2, 4, 5, 6)]


def half(side: str, n: int, zero: bool = False, reverse: bool = False) -> list[str]:
    """The colors of `n` classes on one side of a diverging palette (RdBu), the
    middle color first or last for a class that holds 0 alone."""
    m = n - zero
    spread = sample_colors("colorbrewer:RdBu", 2 * m + 1, reverse=reverse)
    if side == "above":
        return spread[m : m + 1] * zero + spread[m + 1 :]
    return spread[:m] + spread[m : m + 1] * zero


@pytest.mark.parametrize(
    ("values", "side"),
    [
        ([float(i) for i in range(1, 51)], "above"),
        ([float(-i) for i in range(1, 51)], "below"),
        # One row of 1,001 below 0: no real share, the side with the data's bulk.
        ([-0.5] + [float(i) for i in range(1, 1001)], "above"),
        ([0.5] + [float(-i) for i in range(1, 1001)], "below"),
    ],
)
def test_data_without_a_real_share_on_both_sides_takes_one_half_of_the_palette(
    values: list[float], side: str
) -> None:
    con = table(values)
    b = fitted_breaks(con, "t", "v", 7, centre=True)
    plain = fitted_breaks(con, "t", "v", 7)
    # The classes are those of any fitted classification: as many as quantile.
    assert (b.breaks, b.min, b.max) == (plain.breaks, plain.min, plain.max)
    assert len(b.breaks) + 1 == 7
    out, _ = computed(con, fit_doc(palette="colorbrewer:RdBu"))
    assert colors(out) == half(side, 7)
    out, _ = computed(con, fit_doc(palette="colorbrewer:RdBu", reverse=True))
    assert colors(out) == half(side, 7, reverse=True)


def test_zeros_alone_on_one_side_take_the_middle_color() -> None:
    con = table([0.0] * 50 + [float(i) for i in range(1, 51)])
    out, _ = computed(con, fit_doc(palette="colorbrewer:RdBu"))
    n = len(out["classify"][0]["classes"])
    assert colors(out) == half("above", n, zero=True)


def test_only_zeros_take_the_middle_color() -> None:
    out, _ = computed(table([0.0] * 5), fit_doc(palette="colorbrewer:RdBu"))
    assert colors(out) == [sample_colors("colorbrewer:RdBu", 1)[0]]


@pytest.mark.parametrize(("below", "centred"), [(5, True), (4, False)])
def test_the_centre_needs_a_real_share_on_both_sides(below: int, centred: bool) -> None:
    # Of 100 rows with a value other than 0, 5 below 0 is a real share, 4 not.
    values = [-1.0] * below + [float(i) for i in range(1, 101 - below)] + [0.0] * 30
    b = fitted_breaks(table(values), "t", "v", 7, centre=True)
    assert (0.0 in b.breaks and b.min == -1.0 and b.positions[0] < 3) is centred


def test_a_centred_classification_without_fit_is_as_today() -> None:
    doc = fit_doc(palette="colorbrewer:RdBu")
    del doc["classify"][0]["fit"]
    con = table([-0.5] + [float(i) for i in range(1, 1001)])
    out, _ = computed(con, doc)
    assert colors(out) == sample_colors("colorbrewer:RdBu", 7)


# Computing a document.


def test_a_fitted_classification_keeps_its_count_and_has_no_note() -> None:
    con = table([1.0] * 10 + [2.0] * 3 + [3.0])
    out, notes = computed(con, fit_doc())
    c = out["classify"][0]
    assert c["count"] == 7 and c["fit"] is True
    assert len(c["classes"]) == 2
    assert notes == []


def test_classes_grow_back_when_the_data_gains_values() -> None:
    con = table([1.0, 2.0, 3.0])
    first, _ = computed(con, fit_doc())
    assert len(first["classify"][0]["classes"]) == 2
    con.execute("DELETE FROM t")
    con.executemany("INSERT INTO t VALUES (?)", [[float(i)] for i in range(100)])
    second, _ = computed(con, first, fingerprint="g")
    assert len(second["classify"][0]["classes"]) == 7
    assert second["classify"][0]["count"] == 7


def test_the_same_data_is_settled_and_not_asked_again() -> None:
    con = table([1.0, 2.0, 3.0])
    first, _ = computed(con, fit_doc())
    again, _ = computed(con, first)
    assert same_ignoring_stamps(first, again)


# Random tables with ties: never an empty class, never more than asked.


def _random_values(rng: random.Random) -> list[Any]:
    pool = [
        round(rng.uniform(-50, 100), rng.choice([0, 1, 3]))
        for _ in range(rng.randint(1, 30))
    ]
    if rng.random() < 0.5:
        pool.append(0.0)
    weights = [rng.choice([1, 1, 1, 5, 40]) for _ in pool]
    rows = rng.randint(2, 200)
    values: list[Any] = rng.choices(pool, weights, k=rows)
    if rng.random() < 0.3:
        values += [None] * rng.randint(1, 5)
    return values


@pytest.mark.parametrize("seed", range(400))
def test_random_tied_tables(seed: int) -> None:
    rng = random.Random(seed)
    values = _random_values(rng)
    n = rng.randint(2, 9)
    centre = rng.random() < 0.3
    con = table(values)
    b = fitted_breaks(con, "t", "v", n, centre=centre)
    counts = held(con, b)
    assert len(counts) <= n, (b, counts)
    assert min(counts) >= 1, (b, counts)
    assert b.merged is False
    assert list(b.breaks) == sorted(set(b.breaks))
    # No break on the maximum: the last class holds it and, where the data has
    # more than one value, a smaller one too, unless it starts at the centre's
    # 0 (it then reads "0 to" the maximum).
    distinct = con.execute(
        "SELECT count(DISTINCT v) FROM t WHERE v IS NOT NULL AND isfinite(v)"
    ).fetchone()[0]
    assert b.max is None or all(x < b.max for x in b.breaks), b
    at_centre = bool(b.breaks) and b.breaks[-1] == 0 and bool(b.positions)
    assert distinct < 2 or at_centre or not top_alone(con, b), b
    if centre:
        below, above = con.execute(
            "SELECT count(*) FILTER (v < 0), count(*) FILTER (v > 0) FROM t "
            "WHERE isfinite(v)"
        ).fetchone()
        h = n // 2
        if centred(below, above) and h >= 1:
            # Each side fitted apart into at most half the count, and into no
            # fewer classes holding a feature than plain quantile classes of
            # that side's rows at half the count.
            zero = b.breaks.index(0.0)
            assert zero + 1 <= h, (b, below, above)
            assert len(b.breaks) - zero <= h, (b, below, above)
            assert len(counts) <= min(n, 2 * h), (b, counts)
            for name, where, own in (
                ("lo", "v < 0", counts[: zero + 1]),
                ("hi", "v >= 0", counts[zero + 1 :]),
            ):
                con.execute(f"CREATE TABLE {name} AS SELECT v FROM t WHERE {where}")
                key = ("breaks", "v", "quantile", str(h))
                side = compute_stats(con, name, [key])[key]
                # Below 0 the highest value may hold a class (it ends at 0).
                then = (
                    merged_top(con, side, name)
                    if name == "hi"
                    else held(con, side, name)
                )
                assert len(own) >= sum(1 for c in then if c), (b, name, own, then)
        else:
            today = plain(con, n)
            then = merged_top(con, today) if today.min is not None else []
            assert len(counts) >= sum(1 for c in then if c), (b, counts, then)
            # One half of the palette, the middle only for a class of 0 alone.
            if b.positions:
                steps = b.steps
                assert len(b.positions) == len(counts)
                assert all(0 <= p < steps for p in b.positions)
                middle = steps // 2
                sides = {p < middle for p in b.positions if p != middle}
                assert len(sides) <= 1, b
        if b.positions and 0.0 in b.breaks and centred(below, above):
            # A class from 0 that holds only zeros takes the middle color.
            h = n // 2
            i = b.breaks.index(0.0) + 1
            upper = b.breaks[i] if i < len(b.breaks) else None
            only = con.execute(
                "SELECT count(*) > 0 AND bool_and(v = 0) FROM t WHERE v >= 0 "
                "AND isfinite(v) AND (? IS NULL OR v < ?)",
                [upper, upper],
            ).fetchone()[0]
            assert (b.positions[i] == h) is bool(only), (b, i)
        return
    today = plain(con, n)
    then = merged_top(con, today) if today.min is not None else []
    # Never fewer classes holding a feature than plain quantile once a class of
    # the maximum alone is merged into the one below, and where plain quantile
    # loses no class and does not isolate the maximum, its classes with the
    # bounds on values.
    assert len(counts) >= sum(1 for c in then if c), (b, counts, today, then)
    if not today.merged and all(then) and not top_alone(con, today):
        assert counts == then, (b, counts, today, then)
