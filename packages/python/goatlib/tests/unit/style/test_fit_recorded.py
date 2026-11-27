"""Classes fitted to the data (`fit`) over seeded random columns, against
recorded results: the breaks and the places in the palette of every case stay
exactly as recorded, to the last digit, and the compute records the decimals
their bounds need.

Rewrite the recorded results only when the fitted classes are meant to change:

    GOAT_WRITE_FIXTURES=1 uv run pytest tests/unit/style/test_fit_recorded.py
"""

import functools
import json
import math
import os
import random
from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.style import data
from goatlib.style.compute import decimals_for, value_decimals
from goatlib.style.data import compute_into, fitted_breaks

FIXTURE = Path(__file__).parent / "fixtures" / "fit_recorded_cases.json"
CASES = 400

_TYPES = ["DOUBLE"] * 6 + ["INTEGER", "BIGINT", "REAL", "DECIMAL(12,3)"]
_SIZES = [1, 2, 3, 4, 6, 9, 15, 30, 61, 120, 241, 500]
_COUNTS = [1, 2, 3, 4, 5, 5, 6, 7, 7, 7, 8, 9, 9, 10, 12, 16, 25, 40]


def _values(r: random.Random, shape: str, n: int, count: int) -> list[float]:
    if shape == "uniform":
        lo, hi = r.choice([(0, 1000), (-50, 300), (-1000, -1), (0, 1)])
        return [r.uniform(lo, hi) for _ in range(n)]
    if shape == "integers":
        top = r.choice([3, 10, 40])
        return [float(r.randint(-r.choice([0, 0, 2]), top)) for _ in range(n)]
    if shape == "zeros":
        share = r.random()
        return [0.0 if r.random() < share else r.expovariate(0.2) for _ in range(n)]
    if shape == "dominant":
        top = r.choice([12.5, 100.0, 3.0])
        return [top if r.random() < 0.7 else r.uniform(0, top) for _ in range(n)]
    if shape == "constant":
        return [r.choice([0.0, 0.087, -3.0, 12.5])] * n
    if shape == "tiny":
        return [r.random() * 1e-5 for _ in range(n)]
    if shape == "huge":
        return [r.uniform(1e8, 1e12) for _ in range(n)]
    if shape == "signed":
        below = r.choice([0.01, 0.04, 0.06, 0.3, 0.5])
        return [
            -r.expovariate(0.5) if r.random() < below else r.expovariate(0.1)
            for _ in range(n)
        ]
    if shape == "ties":
        pool = [0.0, 0.1, 0.3, 1 / 3, 7.77, 42.0]
        return [r.choice(pool) for _ in range(n)]
    if shape == "spikes":
        # More values than half the count that most rows share, among values
        # that differ: their own classes can be more than the count allows,
        # and the least frequent give theirs back.
        heavy = [float(v) for v in r.sample(range(-5, 40), count // 2 + 1)]
        share = r.uniform(0.8, 0.98)
        return [
            r.choice(heavy) if r.random() < share else r.uniform(-5, 30)
            for _ in range(n)
        ]
    return [r.lognormvariate(0, 2) for _ in range(n)]


_SHAPES = [
    "uniform",
    "integers",
    "zeros",
    "dominant",
    "constant",
    "tiny",
    "huge",
    "signed",
    "ties",
    "lognormal",
    "spikes",
]


def column(seed: int) -> tuple[str, list[Any], int, bool]:
    """The column type, the values (None and non-finite values among them),
    the count and whether the palette is diverging, of case `seed`."""
    r = random.Random(seed)
    shape = "spikes" if seed % 4 == 3 else r.choice(_SHAPES)
    spikes = shape == "spikes"
    count = r.choice([4, 5, 6, 7, 9] if spikes else _COUNTS)
    n = 3000 if seed % 40 == 0 else r.choice([30, 60, 120, 400] if spikes else _SIZES)
    values: list[Any] = _values(r, shape, n, count)
    if r.random() < 0.3:
        values += [None] * r.randint(1, 5)
    if r.random() < 0.15:
        values += [math.nan, math.inf, -math.inf][: r.randint(1, 3)]
    if r.random() < 0.3:
        values = [-0.0 if v == 0 and r.random() < 0.5 else v for v in values]
    r.shuffle(values)
    return r.choice(_TYPES), values, count, r.random() < 0.4


def table(seed: int) -> tuple[duckdb.DuckDBPyConnection, int, bool]:
    sql_type, values, count, centre = column(seed)
    con = duckdb.connect()
    try:
        con.execute(f"CREATE TABLE t (v {sql_type})")
        con.execute(f"INSERT INTO t SELECT unnest(?::DOUBLE[])::{sql_type}", [values])
    except duckdb.Error:
        # Non-finite or too large values for the type: the values as doubles.
        con.execute("CREATE OR REPLACE TABLE t (v DOUBLE)")
        con.execute("INSERT INTO t SELECT unnest(?::DOUBLE[])", [values])
    return con, count, centre


def fit_doc(count: int, centre: bool) -> dict[str, Any]:
    palette = "colorbrewer:RdBu" if centre else "colorbrewer:Blues"
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
            }
        ],
    }


def fitted(seed: int) -> dict[str, Any]:
    con, count, centre = table(seed)
    b = fitted_breaks(con, "t", "v", count, centre=centre)
    return {
        "seed": seed,
        "breaks": list(b.breaks),
        "min": b.min,
        "max": b.max,
        "merged": b.merged,
        "positions": list(b.positions),
        "steps": b.steps,
    }


def computed_decimals(seed: int) -> int | None:
    """The decimals the compute records for the case's classes."""
    con, count, centre = table(seed)
    out, _ = compute_into(
        con, "t", fit_doc(count, centre), geometry="polygon", fingerprint="f"
    )
    return out["classify"][0].get("computed", {}).get("decimals")


@functools.cache
def _recorded() -> list[dict[str, Any]]:
    return json.loads(FIXTURE.read_text())


@pytest.mark.skipif(
    not os.environ.get("GOAT_WRITE_FIXTURES"), reason="writes the recorded results"
)
def test_write_the_recorded_results() -> None:
    cases = [fitted(seed) for seed in range(CASES)]
    FIXTURE.write_text("[\n" + ",\n".join(json.dumps(c) for c in cases) + "\n]\n")


@pytest.mark.parametrize("seed", range(CASES))
def test_the_fitted_classes_are_the_recorded_ones(seed: int) -> None:
    assert json.dumps(fitted(seed)) == json.dumps(_recorded()[seed])


def bound_decimals(case: dict[str, Any]) -> int | None:
    """The decimals the recorded classes' bounds and domain need; one class over
    one value those of the value."""
    low, high, breaks = case["min"], case["max"], case["breaks"]
    if low is None:
        return None
    if not breaks and low == high:
        return value_decimals(low)
    return decimals_for(breaks, [low, high])


@pytest.mark.parametrize("seed", range(CASES))
def test_the_compute_records_the_decimals_of_the_bounds(seed: int) -> None:
    assert computed_decimals(seed) == bound_decimals(_recorded()[seed])


@pytest.mark.parametrize("seed", range(0, CASES, 7))
def test_the_one_pass_quantiles_equal_separate_terms(seed: int) -> None:
    # `_quantiles` asks every fraction in one list; each must be the number a
    # separate PERCENTILE_CONT of the same literal gives (`calculate_class_breaks`).
    con, _, _ = table(seed)
    rows = "v IS NOT NULL AND isfinite(v)"
    for k in (1, 2, 3, 4, 5, 6, 8, 12, 16, 40):
        got = data._quantiles(con, "t", "v", "TRUE", [], [k])
        fractions = data._fractions(k)
        terms = ", ".join(
            f"PERCENTILE_CONT({p}) WITHIN GROUP (ORDER BY v)" for p in fractions
        )
        separate = con.execute(f"SELECT {terms} FROM t WHERE {rows}").fetchone()
        assert [got.at[p] for p in fractions] == list(separate), (seed, k)


@pytest.mark.parametrize(
    "sql_type", ["DOUBLE", "REAL", "INTEGER", "BIGINT", "DECIMAL(12,3)"]
)
def test_one_quantile_over_literal_fractions_equals_separate_terms(
    sql_type: str,
) -> None:
    # At the raw level, before any rounding: one `quantile_cont` over the
    # fraction literals cast to DOUBLE gives the very numbers of separate
    # PERCENTILE_CONT terms of the same literals.
    r = random.Random(sql_type)
    values = [r.uniform(-1000, 1000) for _ in range(997)]
    con = duckdb.connect()
    con.execute(f"CREATE TABLE t (v {sql_type})")
    con.execute(f"INSERT INTO t SELECT unnest(?::DOUBLE[])::{sql_type}", [values])
    # 996 rows after the first: these fractions fall on whole positions, where
    # a fraction one bit off moves the result (a DOUBLE parameter list or a
    # list of DECIMAL literals differs here in the last digit).
    fractions = sorted(
        {i / k for k in (3, 4, 6, 12, 83, 166, 249) for i in range(1, k)}
    )
    listed = ", ".join(f"{p}::DOUBLE" for p in fractions)
    [one] = con.execute(f"SELECT quantile_cont(v, [{listed}]) FROM t").fetchone()
    terms = ", ".join(
        f"PERCENTILE_CONT({p}) WITHIN GROUP (ORDER BY v)" for p in fractions
    )
    separate = con.execute(f"SELECT {terms} FROM t").fetchone()
    assert list(one) == list(separate)


class _Counting:
    """A connection that keeps the text of every query it runs."""

    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self.con, self.queries = con, []

    def execute(self, query: str, *args: Any) -> Any:
        self.queries.append(query)
        return self.con.execute(query, *args)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.con, name)


def _queries(values: list[float], count: int) -> list[str]:
    con = duckdb.connect()
    con.execute("CREATE TABLE t (v DOUBLE)")
    con.execute("INSERT INTO t SELECT unnest(?::DOUBLE[])", [values])
    counting = _Counting(con)
    fitted_breaks(counting, "t", "v", count)  # type: ignore[arg-type]
    return counting.queries


def _quantile_passes(queries: list[str]) -> int:
    return sum(q.count("quantile_cont") + q.count("PERCENTILE_CONT") for q in queries)


def test_values_that_differ_take_one_quantile_pass() -> None:
    # The quantiles of the count asked for give that many classes: no other
    # count is asked. The values and the moved breaks take one query each.
    r = random.Random(1)
    values = [r.uniform(0, 1000) for _ in range(5000)]
    queries = _queries(values, 9)
    assert _quantile_passes(queries) == 1
    assert len(queries) <= 4


def test_a_value_with_a_class_of_its_own_adds_one_pass() -> None:
    r = random.Random(2)
    values = [0.0 if r.random() < 0.4 else r.uniform(0, 1000) for _ in range(5000)]
    queries = _queries(values, 7)
    assert _quantile_passes(queries) == 2
    assert len(queries) <= 5


def test_each_class_given_back_takes_one_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A recorded case whose own values take more classes than its count: the
    # least frequent gives its class back, and the rest is fitted again.
    con, count, centre = table(83)
    counting = _Counting(con)
    passes: list[int] = []
    results: list[Any] = []
    rest = data._fitted_rest

    def counted(*args: Any, **kwargs: Any) -> Any:
        before = _quantile_passes(counting.queries)
        results.append(rest(*args, **kwargs))
        passes.append(_quantile_passes(counting.queries) - before)
        return results[-1]

    monkeypatch.setattr(data, "_fitted_rest", counted)
    fitted_breaks(counting, "t", "v", count, centre=centre)  # type: ignore[arg-type]
    assert results.count(None) >= 1
    assert passes[0] <= 1 and passes[1:] == [1] * (len(passes) - 1)
    # The values, four rounds of own values (three with a nearest-value query),
    # the rest fitted twice and the own values' rows counted once.
    assert len(counting.queries) <= 14
