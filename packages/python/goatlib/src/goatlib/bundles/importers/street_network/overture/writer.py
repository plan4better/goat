"""Write flattened records as typed GeoParquet member layers.

The schema is declared rather than inferred. Handing the runner GeoJSON instead
would let column types follow the data: a network with no ``level_rules`` yields
an all-null column, which infers as VARCHAR, while a network that has them yields
INTEGER — so two imports of the same bundle type would disagree on their layer
schema, and anything reading the layer (the routing artifact, CQL2 filters) would
have to cope with both.

Geometry goes through DuckDB so the output carries GeoParquet metadata — the
runner's ingest detects the geometry column by DuckDB type, and a plain WKB blob
would not be recognised. Writing via ``write_optimized_parquet`` also picks up the
bbox struct, Hilbert ordering and Parquet V2 that every other layer gets.
"""

import logging
import os
from typing import Any, Dict, Iterable, List, Sequence

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from shapely.geometry import LineString, Point

from goatlib.computed_columns import COMPUTED_KIND_REGISTRY
from goatlib.io.parquet import write_optimized_parquet

logger = logging.getLogger(__name__)

#: Rows per staged batch. Matches the reader's batching: big enough that the
#: per-batch overhead disappears, small enough that a batch is never the thing
#: that runs a worker out of memory.
WRITE_BATCH_ROWS = 10_000

#: Ceiling for DuckDB's sort when writing a layer. Spilling to disk is slower
#: than sorting in RAM and much better than being OOM-killed, which is what an
#: unbounded sort of a city-sized layer risks on a shared worker.
SORT_MEMORY_LIMIT = "1GB"

# WKB on the way in; DuckDB turns it into a real geometry column on write.
_GEOMETRY = ("geometry", pa.binary())

EDGE_SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        ("name", pa.string()),
        ("class", pa.string()),
        ("subclass", pa.string()),
        # float64, not float32: the value is written by the `length` computed
        # kind's own SQL, which is DOUBLE, and `SELECT * REPLACE (<expr> AS
        # length_m)` takes the expression's type — so a narrower declaration
        # here would simply be false about the file. Widening the declaration
        # rather than narrowing the expression, because DOUBLE is also what the
        # routing artifact reads the column as and what a later recompute
        # produces: one width the whole way through, and no rounding step that
        # would make the length a user sees differ from the length the engine
        # routes on.
        ("length_m", pa.float64()),
        ("surface", pa.string()),
        ("speed_limit_kph_forward", pa.int32()),
        ("speed_limit_kph_backward", pa.int32()),
        ("source_node", pa.string()),
        ("target_node", pa.string()),
        ("other", pa.string()),
        ("original_id", pa.string()),
        _GEOMETRY,
    ]
)

NODE_SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        _GEOMETRY,
    ]
)


#: Edge columns filled from the geometry at write time rather than carried on the
#: flattened record. The routing artifact reads `length_m` from the layer instead
#: of deriving its own, so a layer written without it cannot be built from.
EDGE_COMPUTED = {"length_m": COMPUTED_KIND_REGISTRY["length"]}


def write_edges(records: Iterable[Dict[str, Any]], path: str) -> str:
    """Write edge records, converting ``coordinates`` to LineString geometry.

    ``length_m`` is filled here rather than left to the import: the routing
    artifact reads the column instead of deriving its own, so a layer written
    without it cannot be built from. The expression is the computed kind's own,
    so the value is identical to what a later recompute produces.
    """
    return _write(
        records,
        path,
        EDGE_SCHEMA,
        "coordinates",
        _line_wkb,
        computed=EDGE_COMPUTED,
    )


def write_nodes(records: Iterable[Dict[str, Any]], path: str) -> str:
    """Write node records, converting ``coordinate`` to Point geometry."""
    return _write(records, path, NODE_SCHEMA, "coordinate", _point_wkb)


def _write(
    records: Iterable[Dict[str, Any]],
    path: str,
    schema: pa.Schema,
    geometry_key: str,
    to_wkb: Any,
    computed: Dict[str, Any] | None = None,
) -> str:
    # Staged to parquet a batch at a time rather than built as one table: the
    # optimised write sorts on a Hilbert curve, which needs every row, and doing
    # that in Python meant the whole layer resident twice (the list, then the
    # Arrow table). DuckDB sorts the staged file instead and spills to disk if it
    # has to, so the memory here is one batch whatever the city's size.
    staging = f"{path}.staging"
    written = 0
    con = duckdb.connect()
    try:
        with pq.ParquetWriter(staging, schema) as writer:
            batch: List[Dict[str, Any]] = []
            for record in records:
                geometry = record.get(geometry_key)
                if geometry is None:
                    continue
                row = {
                    name: record.get(name)
                    for name in schema.names
                    if name != "geometry"
                }
                row["geometry"] = to_wkb(geometry)
                batch.append(row)
                if len(batch) >= WRITE_BATCH_ROWS:
                    writer.write_table(pa.Table.from_pylist(batch, schema=schema))
                    written += len(batch)
                    batch = []
            if batch:
                writer.write_table(pa.Table.from_pylist(batch, schema=schema))
                written += len(batch)

        con.execute("INSTALL spatial; LOAD spatial")
        # The optimised write sorts the whole layer on a Hilbert curve. Left to
        # itself DuckDB sizes that sort against the machine's RAM, which on a
        # worker sharing its memory with everything else is how an import gets
        # killed. Bounded and pointed at the workdir instead: it spills there and
        # takes longer rather than taking the process down.
        con.execute(f"SET memory_limit='{SORT_MEMORY_LIMIT}'")
        con.execute(f"SET temp_directory='{os.path.dirname(os.path.abspath(path))}'")
        con.execute(
            f"CREATE OR REPLACE VIEW records AS SELECT * FROM read_parquet('{staging}')"
        )
        # Same optimiser every other layer goes through — bbox struct for
        # row-group pruning, Hilbert ordering, Parquet V2 — so a bundle's layers
        # aren't second-class for tile and feature queries. REPLACE keeps the
        # declared column order and types; only geometry changes type.
        # Geometry first, then anything computed from it — a computed
        # expression needs a real geometry, not the WKB the records carry.
        # REPLACE in both layers so the schema's declared column order and
        # types survive; only the values change.
        geom_query = (
            "SELECT * REPLACE (ST_GeomFromWKB(geometry) AS geometry) FROM records"
        )
        if computed:
            fills = ", ".join(
                f"{kind.compute_sql()} AS {column}" for column, kind in computed.items()
            )
            query = f"SELECT * REPLACE ({fills}) FROM ({geom_query})"
        else:
            query = geom_query
        write_optimized_parquet(
            con,
            query,
            path,
            geometry_column="geometry",
        )
    finally:
        con.close()
        if os.path.exists(staging):
            os.remove(staging)
    logger.debug("Wrote %d row(s) to %s", written, path)
    return path


def _line_wkb(coordinates: Sequence[Any]) -> bytes:
    return bytes(LineString([tuple(c) for c in coordinates]).wkb)


def _point_wkb(coordinate: Sequence[float]) -> bytes:
    return bytes(Point(tuple(coordinate)).wkb)
