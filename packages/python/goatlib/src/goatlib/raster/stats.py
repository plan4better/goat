"""A raster style's computed values (the style specification's sections 9.4 and
12) and what validation knows of a raster file.

Values come from an overview sample (`RasterSource.sample`); classes use the same
class-break statistics as vector styles (`goatlib.style.data.compute_stats`)
over the sample loaded into an in-memory DuckDB table, so a raster's quantiles
are computed like a field's. Used by processes' style check.
"""

from datetime import UTC, datetime
from typing import Any

import numpy as np

from goatlib.raster.formula import FormulaError, parse_formula
from goatlib.raster.source import RasterSource
from goatlib.style.compute import (
    Breaks,
    StatKey,
    StatResults,
    apply_computed,
    breaks_for_classes,
    needed_stats,
)
from goatlib.style.context import ALL_CAPABILITIES, BandInfo, DataContext
from goatlib.style.issues import Issue


def breaks_of(values: np.ndarray, method: str, count: int) -> Breaks:
    """Class breaks of `values` by a numeric method, as vector classes get them."""
    import duckdb

    from goatlib.style.data import compute_stats

    if values.size == 0:
        return Breaks((), None, None, False)
    con = duckdb.connect()
    try:
        con.register("raster_values", {"value": values.astype("float64")})
        key = ("breaks", "value", method, str(count))
        result = compute_stats(con, "raster_values", [key]).get(key)
    finally:
        con.close()
    return result if isinstance(result, Breaks) else Breaks((), None, None, False)


def compute_raster_stats(source: RasterSource, keys: list[StatKey]) -> StatResults:
    """The statistics `keys` name (`compute.needed_stats` of a raster style).
    A formula that does not parse for this file is left out: validation reports
    it."""
    count = source.info().count
    samples: dict[str, np.ndarray] = {}
    out: dict[StatKey, Any] = {}
    for key in dict.fromkeys(keys):
        expression = key[1]
        if expression not in samples:
            try:
                samples[expression] = source.sample(parse_formula(expression, count))
            except FormulaError:
                continue
        values = samples[expression]
        if key[0] == "range":
            out[key] = (
                (float(values.min()), float(values.max()))
                if values.size
                else (None, None)
            )
        elif key[0] == "breaks":
            method, classes = key[2], int(key[3])
            if len(key) == 6:
                d0, d1 = float(key[4]), float(key[5])
                if method == "equal_interval":
                    raw = [d0 + i * (d1 - d0) / classes for i in range(1, classes)]
                    out[key] = breaks_for_classes(raw, d0, d1, classes)
                    continue
                values = values[(values >= d0) & (values <= d1)]
            out[key] = breaks_of(values, method, classes)
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
    no-data value and whether it has a color table."""
    info = source.info()
    bands = tuple(
        BandInfo(index=b.index, min=b.min or 0.0, max=b.max or 0.0)
        for b in source.statistics()
    )
    return DataContext(
        kind="raster",
        source="file",
        bands=bands,
        no_data=info.nodata,
        data_type=info.dtype,
        color_table=bool(info.color_table),
        capabilities=capabilities,
    )
