"""Class breaks statistics calculation."""

import logging
import math
from collections.abc import Sequence
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
    attribute = require_column(con, table_name, attribute, "attribute")
    attr_col = quote_identifier(attribute)

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
        return ClassBreaksResult(
            attribute=attribute,
            method=method.value,
            breaks=[],
            min=None,
            max=None,
            mean=None,
            std_dev=None,
        )

    min_val, max_val, mean_val, std_dev = stats_result

    if num_breaks <= 0:
        return ClassBreaksResult(
            attribute=attribute,
            method=method.value,
            breaks=[],
            min=float(min_val) if min_val is not None else None,
            max=float(max_val) if max_val is not None else None,
            mean=float(mean_val) if mean_val is not None else None,
            std_dev=float(std_dev) if std_dev is not None else None,
        )

    # Calculate breaks based on method
    if method == ClassBreakMethod.quantile:
        breaks = _calculate_quantile_breaks(
            con, table_name, attr_col, full_where, params, num_breaks
        )
    elif method == ClassBreakMethod.equal_interval:
        breaks = _calculate_equal_interval_breaks(min_val, max_val, num_breaks)
    elif method == ClassBreakMethod.standard_deviation:
        breaks = _calculate_std_dev_breaks(
            min_val, max_val, mean_val, std_dev, num_breaks
        )
    elif method == ClassBreakMethod.heads_and_tails:
        breaks = _calculate_heads_tails_breaks(
            con, table_name, attr_col, full_where, params, num_breaks, mean_val
        )
    elif method == ClassBreakMethod.natural_breaks:
        breaks = _calculate_natural_breaks(
            con, table_name, attr_col, full_where, params, num_breaks
        )
    else:
        breaks = []

    return ClassBreaksResult(
        attribute=attribute,
        method=method.value,
        breaks=breaks,
        min=float(min_val) if min_val is not None else None,
        max=float(max_val) if max_val is not None else None,
        mean=float(mean_val) if mean_val is not None else None,
        std_dev=float(std_dev) if std_dev is not None else None,
    )


def _calculate_quantile_breaks(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    attr_col: str,
    where_clause: str,
    params: list[Any] | None,
    num_breaks: int,
) -> list[float]:
    """Calculate quantile breaks using PERCENTILE_CONT.

    Returns num_breaks internal break points that divide data into
    num_breaks + 1 equal-frequency bins. The min and max values are
    excluded from the breaks (they are returned separately in the result).

    For example, with num_breaks=4 (quintiles = 5 classes):
    percentiles = [0.2, 0.4, 0.6, 0.8]
    """
    # Generate internal percentile values that exclude 0.0 (min) and 1.0 (max)
    # e.g., for 4 breaks (5 classes): 0.2, 0.4, 0.6, 0.8
    percentiles = [i / (num_breaks + 1) for i in range(1, num_breaks + 1)]

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

    if result:
        return [float(v) for v in result if v is not None]
    return []


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


def _calculate_natural_breaks(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    attr_col: str,
    where_clause: str,
    params: list[Any] | None,
    num_breaks: int,
) -> list[float]:
    """Calculate natural breaks (Fisher-Jenks) on at most NATURAL_BREAKS_SAMPLE values.

    Larger tables are sampled by feature id (every n-th row id), so the same data
    gives the same breaks on every run. Where the relation has no row ids, a
    seeded reservoir sample stands in.
    """
    total = con.execute(
        f"SELECT COUNT(*) FROM {table_name} WHERE {where_clause}", params or []
    ).fetchone()
    rows = int(total[0]) if total else 0
    if rows == 0:
        return []
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
    return jenks_breaks(values, num_breaks + 1)


def jenks_breaks(values: Sequence[float], classes: int) -> list[float]:
    """Fisher-Jenks optimal breaks: the first value of classes 2..n.

    Minimizes the sum of squared deviations within classes by dynamic
    programming over the distinct values, weighted by how often each occurs.
    The best start of the last class never moves left as the end moves right,
    so each pass solves the middle end first and halves the range of starts
    for the ends on either side; one recursion level is one numpy step.
    """
    if classes < 2 or len(values) == 0:
        return []
    distinct, counts = np.unique(np.asarray(values, dtype=float), return_counts=True)
    m = len(distinct)
    if m <= classes:
        return [float(v) for v in distinct[1:]]
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
    back = np.zeros((classes, m), dtype=int)
    for k in range(1, classes):
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
    breaks: list[float] = []
    j = m - 1
    for k in range(classes - 1, 0, -1):
        start = int(back[k, j])
        breaks.append(float(distinct[start]))
        j = start - 1
    return sorted(breaks)
