"""Class breaks statistics calculation."""

import logging
import math
from collections.abc import Iterable, Sequence
from typing import Any

import duckdb
import numpy as np

from goatlib.analysis.schemas.statistics import ClassBreakMethod, ClassBreaksResult
from goatlib.analysis.statistics.columns import quote_identifier, require_column

logger = logging.getLogger(__name__)

#: Natural breaks read at most this many values (GOAT Style specification 5.8).
NATURAL_BREAKS_SAMPLE = 10_000


def calculate_class_breaks(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    attribute: str,
    method: ClassBreakMethod = ClassBreakMethod.quantile,
    num_breaks: int = 5,
    where_clause: str = "TRUE",
    params: list[Any] | None = None,
    strip_zeros: bool = False,
) -> ClassBreaksResult:
    """Calculate classification breaks for a numeric attribute.

    Args:
        con: DuckDB connection
        table_name: Fully qualified table name (e.g., "lake.my_table")
        attribute: Numeric column name to classify
        method: Classification method (quantile, equal_interval, standard_deviation,
            heads_and_tails, natural_breaks); the definitions are the GOAT Style
            specification's (section 5.8)
        num_breaks: Number of classification breaks to calculate
        where_clause: SQL WHERE clause condition (default: "TRUE" for all rows)
        params: Optional query parameters for prepared statement
        strip_zeros: If True, exclude zero values from classification

    Returns:
        ClassBreaksResult with break values and statistics

    Raises:
        ValueError: If `attribute` is not a column of the table.
    """
    return calculate_class_breaks_by_count(
        con,
        table_name,
        attribute,
        method,
        [num_breaks],
        where_clause=where_clause,
        params=params,
        strip_zeros=strip_zeros,
    )[num_breaks]


def calculate_class_breaks_by_count(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    attribute: str,
    method: ClassBreakMethod,
    num_breaks: Sequence[int],
    where_clause: str = "TRUE",
    params: list[Any] | None = None,
    strip_zeros: bool = False,
) -> dict[int, ClassBreaksResult]:
    """`calculate_class_breaks` for several numbers of breaks at once, each
    exactly as asking for it alone gives it: one statistics query, one quantile
    query over every fraction asked, one natural breaks sample and Fisher-Jenks
    run. Keyed by the number of breaks, in the order asked."""
    attribute = require_column(con, table_name, attribute, "attribute")
    attr_col = quote_identifier(attribute)
    asked = list(dict.fromkeys(num_breaks))

    # Build full where clause with null check and optional zero stripping.
    # Infinity and NaN can't be classified and would overflow AVG/STDDEV.
    full_where = f"({where_clause}) AND {attr_col} IS NOT NULL AND isfinite({attr_col})"
    if strip_zeros:
        full_where = f"{full_where} AND {attr_col} != 0"

    # Get basic statistics first
    stats_query = f"""
        SELECT
            MIN({attr_col}) AS min_val,
            MAX({attr_col}) AS max_val,
            AVG({attr_col}) AS mean_val,
            STDDEV({attr_col}) AS std_dev
        FROM {table_name}
        WHERE {full_where}
    """

    logger.debug("Class breaks stats query: %s", stats_query)

    if params:
        stats_result = con.execute(stats_query, params).fetchone()
    else:
        stats_result = con.execute(stats_query).fetchone()

    if not stats_result or stats_result[0] is None:
        return {
            n: ClassBreaksResult(
                attribute=attribute,
                method=method.value,
                breaks=[],
                min=None,
                max=None,
                mean=None,
                std_dev=None,
            )
            for n in asked
        }

    min_val, max_val, mean_val, std_dev = stats_result

    # Calculate breaks based on method; none for no breaks asked.
    counts = [n for n in asked if n > 0]
    found: dict[int, list[float]] = {}
    if not counts:
        pass
    elif method == ClassBreakMethod.quantile:
        found = _calculate_quantile_breaks_by_count(
            con, table_name, attr_col, full_where, params, counts
        )
    elif method == ClassBreakMethod.equal_interval:
        found = {
            n: _calculate_equal_interval_breaks(min_val, max_val, n) for n in counts
        }
    elif method == ClassBreakMethod.standard_deviation:
        found = {
            n: _calculate_std_dev_breaks(min_val, max_val, mean_val, std_dev, n)
            for n in counts
        }
    elif method == ClassBreakMethod.heads_and_tails:
        found = {
            n: _calculate_heads_tails_breaks(
                con, table_name, attr_col, full_where, params, n, mean_val
            )
            for n in counts
        }
    elif method == ClassBreakMethod.natural_breaks:
        found = _calculate_natural_breaks_by_count(
            con, table_name, attr_col, full_where, params, counts
        )

    return {
        n: ClassBreaksResult(
            attribute=attribute,
            method=method.value,
            breaks=found.get(n, []),
            min=float(min_val) if min_val is not None else None,
            max=float(max_val) if max_val is not None else None,
            mean=float(mean_val) if mean_val is not None else None,
            std_dev=float(std_dev) if std_dev is not None else None,
        )
        for n in asked
    }


def _calculate_quantile_breaks_by_count(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    attr_col: str,
    where_clause: str,
    params: list[Any] | None,
    counts: Sequence[int],
) -> dict[int, list[float]]:
    """Calculate quantile breaks using PERCENTILE_CONT, for each number of
    breaks in `counts`, in one query over every fraction they need.

    Returns num_breaks internal break points that divide data into
    num_breaks + 1 equal-frequency bins. The min and max values are
    excluded from the breaks (they are returned separately in the result).

    For example, with num_breaks=4 (quintiles = 5 classes):
    percentiles = [0.2, 0.4, 0.6, 0.8]

    Each fraction is asked as its own PERCENTILE_CONT of a number literal:
    DuckDB reads the literal as a DECIMAL, and a list of fractions
    (`quantile_cont(x, [...])`) gives other last digits.
    """
    # Generate internal percentile values that exclude 0.0 (min) and 1.0 (max)
    # e.g., for 4 breaks (5 classes): 0.2, 0.4, 0.6, 0.8. Equal fractions of
    # two counts (1/3 and 2/6) are the same float, asked once.
    wanted = {n: [i / (n + 1) for i in range(1, n + 1)] for n in counts}
    percentiles = sorted({p for ps in wanted.values() for p in ps})

    # Build query with multiple PERCENTILE_CONT calls
    percentile_exprs = ", ".join(
        f"PERCENTILE_CONT({p}) WITHIN GROUP (ORDER BY {attr_col})" for p in percentiles
    )
    query = f"""
        SELECT {percentile_exprs}
        FROM {table_name}
        WHERE {where_clause}
    """

    if params:
        result = con.execute(query, params).fetchone()
    else:
        result = con.execute(query).fetchone()

    if not result:
        return {n: [] for n in counts}
    at = dict(zip(percentiles, result, strict=True))
    return {
        n: [float(at[p]) for p in ps if at[p] is not None] for n, ps in wanted.items()
    }


def _calculate_equal_interval_breaks(
    min_val: float, max_val: float, num_breaks: int
) -> list[float]:
    """Calculate equal interval breaks.

    Returns num_breaks internal break points that divide the range into
    num_breaks + 1 equal-width bins. The min and max values are excluded
    from the breaks (they are returned separately in the result).

    For example, with min=0, max=100, num_breaks=4:
    interval = 20, breaks = [20, 40, 60, 80]
    """
    if min_val == max_val:
        return [float(min_val)]

    interval = (max_val - min_val) / (num_breaks + 1)
    breaks = [min_val + interval * i for i in range(1, num_breaks + 1)]
    return [float(b) for b in breaks]


def _calculate_std_dev_breaks(
    min_val: float,
    max_val: float,
    mean_val: float,
    std_dev: float | None,
    num_breaks: int,
) -> list[float]:
    """Calculate standard deviation breaks.

    Classes are one standard deviation wide around the mean. An even number of
    classes puts a break at the mean; an odd number centers the middle class on
    it (mean +- 0.5 sd). The outer classes are open, and breaks outside the data's
    range are left out.
    """
    if std_dev is None or std_dev == 0:
        return _calculate_equal_interval_breaks(min_val, max_val, num_breaks)

    classes = num_breaks + 1
    if classes % 2 == 0:
        offsets = [float(j) for j in range(-(classes // 2 - 1), classes // 2)]
    else:
        offsets = [j + 0.5 for j in range(-(classes - 1) // 2, (classes - 3) // 2 + 1)]
    breaks = [mean_val + j * std_dev for j in offsets]
    return [float(b) for b in breaks if min_val < b < max_val]


def _calculate_heads_tails_breaks(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    attr_col: str,
    where_clause: str,
    params: list[Any] | None,
    num_breaks: int,
    initial_mean: float,
) -> list[float]:
    """Calculate head/tail breaks.

    Break at the mean, then take the values above it (the head). While the head
    holds under 40% of the values of the part before it, break at its mean and
    repeat, up to `num_breaks` breaks.
    """
    total = con.execute(
        f"SELECT COUNT(*) FROM {table_name} WHERE {where_clause}", params or []
    ).fetchone()
    part_size = int(total[0]) if total else 0
    breaks: list[float] = []
    current_mean = initial_mean
    while len(breaks) < num_breaks:
        breaks.append(float(current_mean))
        query = f"""
            SELECT COUNT(*), AVG({attr_col})
            FROM {table_name}
            WHERE {where_clause} AND {attr_col} > ?
        """
        head = con.execute(query, (params or []) + [current_mean]).fetchone()
        head_size = int(head[0]) if head else 0
        if head_size == 0 or part_size == 0 or head_size / part_size >= 0.4:
            break
        part_size = head_size
        current_mean = head[1]
    return breaks


def _calculate_natural_breaks_by_count(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    attr_col: str,
    where_clause: str,
    params: list[Any] | None,
    counts: Sequence[int],
) -> dict[int, list[float]]:
    """Calculate natural breaks (Fisher-Jenks) on at most NATURAL_BREAKS_SAMPLE
    values, for each number of breaks in `counts` from one sample and one run.

    Larger tables are sampled by feature id (every n-th row id), so the same data
    gives the same breaks on every run. Where the relation has no row ids, a
    seeded reservoir sample stands in.
    """
    total = con.execute(
        f"SELECT COUNT(*) FROM {table_name} WHERE {where_clause}", params or []
    ).fetchone()
    rows = int(total[0]) if total else 0
    if rows == 0:
        return {n: [] for n in counts}
    select = f"SELECT {attr_col} FROM {table_name} WHERE {where_clause}"
    if rows <= NATURAL_BREAKS_SAMPLE:
        values = [r[0] for r in con.execute(select, params or []).fetchall()]
    else:
        stride = math.ceil(rows / NATURAL_BREAKS_SAMPLE)
        try:
            sampled = f"{select} AND rowid % {stride} = 0"
            values = [r[0] for r in con.execute(sampled, params or []).fetchall()]
        except duckdb.BinderException:
            sampled = f"{select} USING SAMPLE reservoir({NATURAL_BREAKS_SAMPLE} ROWS) REPEATABLE (42)"
            values = [r[0] for r in con.execute(sampled, params or []).fetchall()]
    by_classes = jenks_breaks_by_classes(values, [n + 1 for n in counts])
    return {n: by_classes[n + 1] for n in counts}


def jenks_breaks(values: Sequence[float], classes: int) -> list[float]:
    """Fisher-Jenks optimal breaks: the first value of classes 2..n
    (`jenks_breaks_by_classes`)."""
    return jenks_breaks_by_classes(values, [classes])[classes]


def jenks_breaks_by_classes(
    values: Sequence[float], classes: Iterable[int]
) -> dict[int, list[float]]:
    """Fisher-Jenks optimal breaks for each number of classes asked: the first
    value of classes 2..n.

    Minimizes the sum of squared deviations within classes by dynamic
    programming over the distinct values, weighted by how often each occurs.
    The best start of the last class never moves left as the end moves right,
    so each pass solves the middle end first and halves the range of starts
    for the ends on either side; one recursion level is one numpy step.
    Row k of the table (the best k + 1 classes for every end) does not depend
    on how many classes are asked, so one table up to the most classes gives
    every smaller number by tracing back from its own row, exactly as alone.
    """
    asked = list(dict.fromkeys(classes))
    out: dict[int, list[float]] = {c: [] for c in asked}
    if len(values) == 0:
        return out
    distinct, counts = np.unique(np.asarray(values, dtype=float), return_counts=True)
    m = len(distinct)
    for c in asked:
        if 2 <= c and m <= c:
            out[c] = [float(v) for v in distinct[1:]]
    traced = [c for c in asked if 2 <= c < m]
    if not traced:
        return out
    most = max(traced)
    weights = counts.astype(float)
    centered = distinct - np.average(distinct, weights=weights)
    cum_w = np.concatenate([[0.0], np.cumsum(weights)])
    cum_x = np.concatenate([[0.0], np.cumsum(weights * centered)])
    cum_xx = np.concatenate([[0.0], np.cumsum(weights * centered * centered)])

    def deviations(starts: np.ndarray, ends: np.ndarray) -> np.ndarray:
        """Squared deviations of distinct[start..end] (inclusive), pairwise."""
        n = cum_w[ends + 1] - cum_w[starts]
        total = cum_x[ends + 1] - cum_x[starts]
        return (cum_xx[ends + 1] - cum_xx[starts]) - total * total / n

    all_ends = np.arange(m)
    cost = deviations(np.zeros(m, dtype=int), all_ends)
    back = np.zeros((most, m), dtype=int)
    for k in range(1, most):
        new_cost = np.full(m, np.inf)
        # Open ranges of ends (lo..hi) whose last class starts within (first..last).
        lo, hi = np.array([k]), np.array([m - 1])
        first, last = np.array([k]), np.array([m - 1])
        while len(lo):
            mid = (lo + hi) // 2
            top = np.minimum(mid, last)
            sizes = top - first + 1
            offsets = np.concatenate([[0], np.cumsum(sizes)[:-1]])
            task = np.repeat(np.arange(len(mid)), sizes)
            starts = first[task] + np.arange(sizes.sum()) - offsets[task]
            candidates = cost[starts - 1] + deviations(starts, mid[task])
            best_cost = np.minimum.reduceat(candidates, offsets)
            at_best = np.flatnonzero(candidates == best_cost[task])
            leading = np.concatenate([[True], task[at_best][1:] != task[at_best][:-1]])
            best = starts[at_best[leading]]
            new_cost[mid] = best_cost
            back[k, mid] = best
            left, right = mid > lo, mid < hi
            lo = np.concatenate([lo[left], mid[right] + 1])
            hi = np.concatenate([mid[left] - 1, hi[right]])
            first = np.concatenate([first[left], best[right]])
            last = np.concatenate([best[left], last[right]])
        cost = new_cost
    for c in traced:
        breaks: list[float] = []
        j = m - 1
        for k in range(c - 1, 0, -1):
            start = int(back[k, j])
            breaks.append(float(distinct[start]))
            j = start - 1
        out[c] = sorted(breaks)
    return out
