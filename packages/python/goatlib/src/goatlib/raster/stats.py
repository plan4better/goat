"""A raster style's computed values (the style specification's sections 9.4 and
12) and what validation knows of a raster file.

Values come from an overview sample (`RasterSource.sample`); classes use the same
class-break statistics as vector styles (`goatlib.style.data.compute_stats`)
over the sample loaded into an in-memory DuckDB table, so a raster's quantiles
are computed like a field's. Used by processes' style check, and by geoapi for
the class breaks its raster info gives every band (`precomputed_breaks`): both
classify the same values (`classified_sample`), so the breaks a style panel
shows are the classes a saved style gets.
"""

import math
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Final

import numpy as np

from goatlib.raster.formula import FormulaError, parse_formula, single_band
from goatlib.raster.source import RasterSource
from goatlib.style.compute import (
    Breaks,
    StatKey,
    StatResults,
    apply_computed,
    breaks_for_classes,
    needed_stats,
    stable,
)
from goatlib.style.context import (
    ALL_CAPABILITIES,
    BandInfo,
    DataContext,
    raster_fields,
)
from goatlib.style.issues import Issue

if TYPE_CHECKING:
    import duckdb

#: The class methods whose breaks geoapi's raster info gives every band, for
#: each class count of `BREAK_COUNTS` (3 to 13); equal intervals follow from the
#: band's minimum and maximum.
BREAK_METHODS: Final = ("quantile", "natural_breaks", "std_dev", "geometric_interval")
BREAK_COUNTS: Final = range(3, 14)
#: A band or formula is classified over at most this many of its values,
#: drawn with a fixed seed (`classified_sample`).
PRECOMPUTE_SAMPLE: Final = 100_000
_NO_BREAKS = Breaks((), None, None, False)


def classified_sample(values: np.ndarray) -> np.ndarray:
    """The values a band or formula is classified over, by the style check and
    for geoapi's precomputed breaks alike, so both give the same breaks: its
    finite values, at most `PRECOMPUTE_SAMPLE` of them drawn with a fixed seed,
    the same on every pod."""
    values = values[np.isfinite(values)]
    if values.size <= PRECOMPUTE_SAMPLE:
        return values
    return np.random.default_rng(0).choice(values, PRECOMPUTE_SAMPLE, replace=False)


def whole_number_values(info: Any) -> bool:
    """Whether a file's bands hold whole numbers as they are read: an integer
    data type, neither scaled nor offset. Their computed class breaks are whole
    numbers too (spec 9.4), so classes read "28 to 84"."""
    dtype = str(getattr(info, "dtype", ""))
    return dtype.startswith(("int", "uint")) and not getattr(info, "scaled", False)


def _whole(x: float) -> float:
    """A break between whole numbers: rounded half up, from the twelve digits
    every break is written with (`stable`), as the browser rounds it."""
    return float(math.floor(stable(x) + 0.5))


def _whole_breaks(b: Breaks) -> Breaks:
    """`b` with whole-number breaks: breaks that round together, or onto the
    data's ends, are kept once, which counts as merged (fewer classes)."""
    if not b.breaks or b.min is None:
        return b
    kept = breaks_for_classes(
        [_whole(x) for x in b.breaks], b.min, b.max, len(b.breaks) + 1
    )
    return Breaks(kept.breaks, kept.min, kept.max, b.merged or kept.merged)


def _table(values: np.ndarray) -> "duckdb.DuckDBPyConnection":
    """An in-memory DuckDB table `raster_values` of `values` (column `value`),
    on one thread: DuckDB sums in parallel, so a pod with more cores could
    otherwise give other last digits."""
    import duckdb

    con = duckdb.connect(config={"threads": 1})
    con.register("raster_values", {"value": values.astype("float64")})
    return con


def breaks_of(
    values: np.ndarray, method: str, count: int, whole: bool = False
) -> Breaks:
    """Class breaks of `values` by a numeric method, as vector classes get them;
    whole numbers for a band of whole numbers (`whole`)."""
    from goatlib.style.data import compute_stats

    if values.size == 0:
        return _NO_BREAKS
    key = ("breaks", "value", method, str(count))
    con = _table(values)
    try:
        result = compute_stats(con, "raster_values", [key]).get(key)
    finally:
        con.close()
    if not isinstance(result, Breaks):
        return _NO_BREAKS
    return _whole_breaks(result) if whole else result


def _breaks_by(
    values: np.ndarray, pairs: list[tuple[str, int]], whole: bool = False
) -> dict[tuple[str, int], tuple[float, ...]]:
    """The inner breaks `breaks_of` gives `values` for each method of
    `BREAK_METHODS` and class count, with one call of the shared classifier per
    method for all its counts (`calculate_class_breaks_by_count`)."""
    from goatlib.analysis.schemas.statistics import ClassBreakMethod
    from goatlib.analysis.statistics import class_breaks

    # The shared classifier's method for each of `BREAK_METHODS`.
    classifiers = {
        "quantile": ClassBreakMethod.quantile,
        "natural_breaks": ClassBreakMethod.natural_breaks,
        "std_dev": ClassBreakMethod.standard_deviation,
        "geometric_interval": ClassBreakMethod.geometric_interval,
    }
    if values.size == 0:
        return {pair: () for pair in pairs}
    counts: dict[str, list[int]] = {}
    for method, count in pairs:
        counts.setdefault(method, []).append(count)
    out: dict[tuple[str, int], tuple[float, ...]] = {}
    con = _table(values)
    try:
        for method, asked in counts.items():
            found = class_breaks.calculate_class_breaks_by_count(
                con,
                "raster_values",
                "value",
                classifiers[method],
                [count - 1 for count in asked],
            )
            for count in asked:
                r = found[count - 1]
                kept = breaks_for_classes(r.breaks, r.min, r.max, count)
                out[(method, count)] = (_whole_breaks(kept) if whole else kept).breaks
    finally:
        con.close()
    return out


def precomputed_breaks(
    values: np.ndarray, whole: bool = False
) -> dict[str, dict[str, list[float]]]:
    """A band's inner class breaks for every method of `BREAK_METHODS` and class
    count of `BREAK_COUNTS` (`{"quantile": {"3": [...], ...}, ...}`), so a style
    panel switches methods without asking: the breaks `breaks_of` gives over
    `classified_sample` of the whole band, as the style check computes them
    whatever the style's `render.domain`. A count's list can be shorter than
    count - 1, or empty: equal breaks merge, and standard deviation leaves out
    breaks outside the data. Geometric intervals need every value above 0: a
    band with a value at or below 0 has none (`{}`). A band of whole numbers
    (`whole`, `whole_number_values`) gets whole-number breaks. Empty for a band
    without values or with one value only."""
    values = classified_sample(values)
    # After the draw: a band of one value but a few cells can draw only that one.
    if values.size == 0 or values.min() == values.max():
        return {}
    methods = [
        m for m in BREAK_METHODS if m != "geometric_interval" or values.min() > 0
    ]
    pairs = [(method, count) for method in methods for count in BREAK_COUNTS]
    found = _breaks_by(values, pairs, whole)
    return {
        method: (
            {str(count): list(found[(method, count)]) for count in BREAK_COUNTS}
            if method in methods
            else {}
        )
        for method in BREAK_METHODS
    }


def compute_raster_stats(source: RasterSource, keys: list[StatKey]) -> StatResults:
    """The statistics `keys` name (`compute.needed_stats` of a raster style).
    Classes are computed over the whole band's `classified_sample`, as geoapi's
    precomputed breaks, whatever the style's `render.domain` (the panel offers
    those breaks, and saving must not move them); only equal intervals use the
    domain, which they split, and without one read the values' ends. A band of a
    file of whole numbers (`whole_number_values`; a formula only where it is one
    band alone, `single_band`) gets whole-number breaks, every method's. A
    formula that does not parse for this file, or names a band that holds no
    values (an alpha band), is left out: validation reports it."""
    info = source.info()
    whole_file = whole_number_values(info)
    samples: dict[str, np.ndarray] = {}
    out: dict[StatKey, Any] = {}
    for key in dict.fromkeys(keys):
        expression = key[1]
        if expression not in samples:
            try:
                formula = parse_formula(expression, info.count)
            except FormulaError:
                continue
            if not set(formula.bands) <= set(info.value_bands):
                continue
            samples[expression] = source.sample(formula)
        values = samples[expression]
        if key[0] == "range":
            out[key] = (
                (float(values.min()), float(values.max()))
                if values.size
                else (None, None)
            )
        elif key[0] == "breaks":
            method, classes = key[2], int(key[3])
            whole = whole_file and single_band(expression) is not None
            if method == "equal_interval":
                if len(key) == 6:
                    d0, d1 = float(key[4]), float(key[5])
                    raw = [d0 + i * (d1 - d0) / classes for i in range(1, classes)]
                    if whole:
                        raw = [_whole(x) for x in raw]
                    out[key] = breaks_for_classes(raw, d0, d1, classes)
                else:
                    out[key] = breaks_of(values, method, classes, whole)
                continue
            out[key] = breaks_of(classified_sample(values), method, classes, whole)
    return out


def compute_raster_into(
    source: RasterSource, document: dict[str, Any], *, fingerprint: str
) -> tuple[dict[str, Any], list[Issue]]:
    """A copy of a raster style with its computed values written in, and the notes."""
    keys = needed_stats(document)
    return apply_computed(
        document,
        compute_raster_stats(source, keys) if keys else {},
        geometry=None,
        fingerprint=fingerprint,
        at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


def raster_context(
    source: RasterSource, capabilities: frozenset[str] = ALL_CAPABILITIES
) -> DataContext:
    """The file as validation sees it: its bands with their ranges, data type,
    no-data value, whether it has a color table, and the fields its popup reads."""
    info = source.info()
    bands = tuple(
        BandInfo(index=b.index, min=b.min or 0.0, max=b.max or 0.0)
        for b in source.statistics()
    )
    return DataContext(
        kind="raster",
        source="file",
        fields=raster_fields(info.value_bands),
        bands=bands,
        no_data=info.nodata,
        data_type=info.dtype,
        color_table=bool(info.color_table),
        capabilities=capabilities,
    )
