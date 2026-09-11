"""Read Overture transportation GeoParquet into plain records.

The splitter works on dicts with decoded coordinates rather than Arrow structs:
the networks are small, and nested-struct manipulation in Arrow is far harder to
read than the dict form. This module is the boundary where WKB becomes
coordinates and back.
"""

import logging
from typing import Any, Dict, Iterator, List, Tuple

import pyarrow.parquet as pq
from shapely import wkb
from shapely.geometry import LineString, Point

logger = logging.getLogger(__name__)

Coord = Tuple[float, float]

# Overture's geometry column name in the official distribution.
GEOMETRY_COLUMN = "geometry"

# Only road segments are routable; rail and water share the segment type.
ROUTABLE_SUBTYPES = frozenset({"road"})

#: Rows converted to dicts per batch. The file is read a batch at a time rather
#: than whole: `read_table` followed by `to_pylist` holds the Arrow table and
#: every row's Python objects at once, which on a city extract is gigabytes for
#: a file of tens of megabytes. Measured on Paris (359k segments, 63 MB): whole
#: 3.3 GB peak, batched at 10k 451 MB, at 50k 597 MB — small batches win on
#: memory and are no slower, and below this the per-batch overhead starts to
#: show. Every column is read: `flatten` puts whatever it does not promote to a
#: column into the `other` residual, so narrowing the projection would quietly
#: make that lossy.
BATCH_ROWS = 10_000


class OvertureReadError(Exception):
    """Raised when a file is not a usable Overture transportation extract."""


def iter_segments(path: str) -> Iterator[Dict[str, Any]]:
    """Yield segments a batch at a time, decoding geometry to ``coordinates``.

    A generator rather than a list because the consumer can take them one at a
    time: `split_network` treats each segment independently, so nothing needs
    the whole file resident, and holding it is what made a city import cost
    gigabytes.

    Non-road subtypes are dropped — they are part of the transportation theme
    but are not routable, and carrying them would put unusable rows in the layer.
    """
    reader = pq.ParquetFile(path)
    _require_columns(
        path, list(reader.schema_arrow.names), ("id", GEOMETRY_COLUMN, "connectors")
    )

    skipped_subtype = 0
    for batch in reader.iter_batches(batch_size=BATCH_ROWS):
        for record in batch.to_pylist():
            subtype = record.get("subtype")
            if subtype is not None and subtype not in ROUTABLE_SUBTYPES:
                skipped_subtype += 1
                continue
            geometry = _decode(record.pop(GEOMETRY_COLUMN, None))
            if not isinstance(geometry, LineString):
                raise OvertureReadError(
                    f"Segment {record.get('id')} geometry is "
                    f"{type(geometry).__name__}, expected LineString"
                )
            record["coordinates"] = [(x, y) for x, y in geometry.coords]
            yield record

    if skipped_subtype:
        logger.info("Skipped %d non-road segment(s)", skipped_subtype)


def read_segments(path: str) -> List[Dict[str, Any]]:
    """Every segment at once. Prefer `iter_segments` on anything city-sized —
    this is the same read with the whole file held in memory."""
    return list(iter_segments(path))


def iter_connectors(path: str) -> Iterator[Dict[str, Any]]:
    """Yield connectors a batch at a time, decoding geometry to ``coordinate``."""
    reader = pq.ParquetFile(path)
    _require_columns(path, list(reader.schema_arrow.names), ("id", GEOMETRY_COLUMN))

    for batch in reader.iter_batches(batch_size=BATCH_ROWS):
        for record in batch.to_pylist():
            geometry = _decode(record.pop(GEOMETRY_COLUMN, None))
            if not isinstance(geometry, Point):
                raise OvertureReadError(
                    f"Connector {record.get('id')} geometry is "
                    f"{type(geometry).__name__}, expected Point"
                )
            record["coordinate"] = (geometry.x, geometry.y)
            yield record


class ConnectorFile:
    """The connectors file, re-readable.

    The splitter needs them twice — once for the ids a piece may reference, once
    to emit the ones it did — and holding them between those two passes cost
    1.7 GB on a city extract (596k dicts). Re-reading tens of megabytes of
    parquet is the cheaper half of that trade, and it keeps the splitter's input
    the same shape as its segments: something you iterate, not something you
    hold.
    """

    def __init__(self: "ConnectorFile", path: str) -> None:
        self.path = path

    def __iter__(self: "ConnectorFile") -> Iterator[Dict[str, Any]]:
        return iter_connectors(self.path)


def read_connectors(path: str) -> List[Dict[str, Any]]:
    """Every connector at once. They are the node layer's rows, so the splitter
    keeps them anyway; this exists for callers that want them in one go."""
    return list(iter_connectors(path))


def _decode(value: Any) -> Any:
    if value is None:
        raise OvertureReadError("Record has no geometry")
    if isinstance(value, (bytes, bytearray, memoryview)):
        return wkb.loads(bytes(value))
    raise OvertureReadError(
        f"Geometry column holds {type(value).__name__}, expected WKB bytes"
    )


def _require_columns(path: str, present: List[str], required: Tuple[str, ...]) -> None:
    missing = [c for c in required if c not in present]
    if missing:
        raise OvertureReadError(
            f"{path} is missing required column(s): {', '.join(missing)}"
        )
