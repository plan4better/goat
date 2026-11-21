"""Class breaks as the GOAT Style specification defines them (section 5.8)."""

import itertools
import math
import random
import time
from collections.abc import Callable

import duckdb
import pytest
from goatlib.analysis.schemas.statistics import ClassBreakMethod
from goatlib.analysis.statistics.class_breaks import (
    calculate_class_breaks,
    calculate_class_breaks_by_count,
    jenks_breaks,
    jenks_breaks_by_classes,
)


@pytest.fixture
def con_with() -> Callable[[list[float]], duckdb.DuckDBPyConnection]:
    def make(values: list[float]) -> duckdb.DuckDBPyConnection:
        con = duckdb.connect()
        con.execute("CREATE TABLE t (v DOUBLE)")
        con.executemany("INSERT INTO t VALUES (?)", [[v] for v in values])
        return con

    return make


def breaks(
    con: duckdb.DuckDBPyConnection, method: ClassBreakMethod, num_breaks: int
) -> list[float]:
    return calculate_class_breaks(con, "t", "v", method, num_breaks).breaks


def test_natural_breaks_finds_the_obvious_groups(con_with) -> None:
    con = con_with([1, 2, 3, 10, 11, 12, 20, 21, 22])
    assert breaks(con, ClassBreakMethod.natural_breaks, 2) == [10, 20]


def test_jenks_on_ten_thousand_values_is_fast() -> None:
    values = [math.sin(i) * 1000 + i for i in range(10_000)]
    t = time.perf_counter()
    result = jenks_breaks(values, 7)
    assert time.perf_counter() - t < 0.5
    assert len(result) == 6 and result == sorted(result)


def _within_class_deviations(values: list[float], breaks: list[float]) -> float:
    edges = [-math.inf, *breaks, math.inf]
    total = 0.0
    for lo, hi in itertools.pairwise(edges):
        members = [v for v in values if lo <= v < hi]
        if members:
            mean = sum(members) / len(members)
            total += sum((v - mean) ** 2 for v in members)
    return total


@pytest.mark.parametrize("seed", range(20))
def test_jenks_matches_an_exhaustive_search(seed: int) -> None:
    rng = random.Random(seed)
    values = [
        rng.choice([rng.randint(0, 40), rng.gauss(100, 30)])
        for _ in range(rng.randint(8, 30))
    ]
    distinct = sorted(set(values))
    classes = rng.randint(2, min(5, len(distinct)))
    best = min(
        _within_class_deviations(values, list(cut))
        for cut in itertools.combinations(distinct[1:], classes - 1)
    )
    result = jenks_breaks(values, classes)
    assert len(result) == classes - 1
    assert _within_class_deviations(values, result) == pytest.approx(
        best, rel=1e-9, abs=1e-9
    )


def test_standard_deviation_even_and_odd_class_counts(con_with) -> None:
    con = con_with([-20, -10, 0, 10, 20])  # mean 0, sample sd 15.811
    assert breaks(con, ClassBreakMethod.standard_deviation, 3) == pytest.approx(
        [-15.811, 0, 15.811], abs=0.01
    )
    assert breaks(con, ClassBreakMethod.standard_deviation, 2) == pytest.approx(
        [-7.906, 7.906], abs=0.01
    )


def test_heads_and_tails_follows_the_40_percent_rule(con_with) -> None:
    skewed = con_with([1] * 80 + [10] * 15 + [100] * 5)
    assert breaks(skewed, ClassBreakMethod.heads_and_tails, 4) == pytest.approx(
        [7.3, 32.5, 100.0]
    )
    even = con_with([1] * 50 + [2] * 50)
    assert breaks(even, ClassBreakMethod.heads_and_tails, 4) == [1.5]


def test_natural_breaks_samples_by_feature_id_on_big_tables() -> None:
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE t AS SELECT (i % 1000)::DOUBLE AS v FROM range(1000000) r(i)"
    )
    first = breaks(con, ClassBreakMethod.natural_breaks, 4)
    assert len(first) == 4
    assert first == breaks(con, ClassBreakMethod.natural_breaks, 4)


def test_natural_breaks_on_a_parquet_view(tmp_path) -> None:
    con = duckdb.connect()
    con.execute(
        f"COPY (SELECT (i % 97)::DOUBLE AS v FROM range(30000) r(i)) TO '{tmp_path / 'v.parquet'}' (FORMAT parquet)"
    )
    con.execute(
        f"CREATE VIEW t AS SELECT * FROM read_parquet('{tmp_path / 'v.parquet'}')"
    )
    assert len(breaks(con, ClassBreakMethod.natural_breaks, 3)) == 3


def _samples() -> dict[str, list[float]]:
    import numpy as np

    rng = np.random.default_rng(4)
    return {
        "gamma": rng.gamma(2.0, 50.0, 3_000).tolist(),
        "lognormal": rng.lognormal(3, 1, 3_000).tolist(),
        "few values": rng.integers(0, 7, 3_000).astype(float).tolist(),
        "two values": [1.0] * 40 + [5.0] * 60,
        "over the natural breaks sample": rng.normal(0, 1, 25_000).tolist(),
    }


@pytest.mark.parametrize("name", list(_samples()))
def test_one_jenks_run_gives_every_class_count(name: str) -> None:
    values = _samples()[name][:5_000]
    asked = [0, 1, *range(2, 14)]
    together = jenks_breaks_by_classes(values, asked)
    assert together == {classes: jenks_breaks(values, classes) for classes in asked}


@pytest.mark.parametrize("method", list(ClassBreakMethod))
@pytest.mark.parametrize("name", list(_samples()))
def test_breaks_for_several_counts_are_each_counts_own(
    method: ClassBreakMethod, name: str
) -> None:
    """One query (and one Fisher-Jenks run) for several numbers of breaks gives
    each exactly what asking for it alone gives."""
    import numpy as np

    con = duckdb.connect(config={"threads": 1})
    con.register("t", {"v": np.array(_samples()[name])})
    asked = [0, *range(2, 12)]
    together = calculate_class_breaks_by_count(con, "t", "v", method, asked)
    assert list(together) == asked
    for n in asked:
        assert together[n] == calculate_class_breaks(con, "t", "v", method, n), n
