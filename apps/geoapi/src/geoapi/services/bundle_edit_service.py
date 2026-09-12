"""Writes an edge batch and its derived nodes, keyed on the `id` column.

Not ``feature_write_service``: that addresses rows by rowid, and a batch that
deletes rows shifts the rowids of rows it has not touched yet. The editor's
feature ids (``rowid + 1``, as the tiles hand them out) are resolved to the
layer's own ``id`` values once, up front, and every write after that keys on
``id``.

Candidate geometry is handed out in EPSG:3857 metres so ``goatlib.bundles.topology``
can measure a tolerance in metres. Writes go back as 4326: a split is applied as a
fraction along the stored line, and a node minted on that line comes from
``ST_LineInterpolatePoint``, so the node sits exactly on the geometry rather than
near it.
"""

import json
import logging
import math
import uuid
from typing import Any, Iterable, Sequence

from goatlib.bundles.topology import EdgeCandidate, NodeCandidate
from shapely import wkt

from geoapi.services.computed_columns import parse_computed_columns

# One definition of the rowid convention (a public feature id is rowid + 1,
# because MapLibre treats MVT feature id 0 as "unset"), and one of the
# GeoParquet bbox struct every write path keeps in step with the geometry.
from geoapi.services.feature_write_service import _feature_id_to_rowid, bbox_struct_sql

logger = logging.getLogger(__name__)

TO_3857 = "ST_Transform({geom}, 'EPSG:4326', 'EPSG:3857', always_xy := true)"
TO_4326 = "ST_Transform({geom}, 'EPSG:3857', 'EPSG:4326', always_xy := true)"


def _projected(expr: str) -> str:
    """A point or sub-line a fraction along a stored 4326 geometry, measured the
    way the fraction was: in projected metres.

    The fraction comes from ``goatlib.bundles.topology``, which works in
    EPSG:3857. Applying it to the 4326 line directly puts the point somewhere
    else, because Mercator stretches north-south by a factor that varies with
    latitude — 0.43 m along a 4.4 km street at Munich, more further north and on
    longer edges. So the line is projected, cut, and the result brought back.
    """
    return TO_4326.format(geom=expr.format(geom=TO_3857.format(geom='"geometry"')))


def mint_id() -> str:
    """An id for a node or edge the editor created.

    Prefixed so edited geometry stays distinguishable from imported GERS ids.
    The artifact renumbers with row_number(), so the value only has to be
    unique within the layer.
    """
    return f"edit:{uuid.uuid4()}"


def resolve_feature_ids(
    con: Any, table: str, feature_ids: Sequence[str]
) -> dict[str, str]:
    """Map the editor's feature ids onto the layer's own ``id`` values.

    Feature ids come from the rendered tiles and are ``rowid + 1``; everything
    downstream keys on the layer's ``id`` column instead, because a delete
    renumbers the rowids of the rows that survive it.

    Only ids that resolve are returned. A caller must treat a missing one as an
    error rather than writing to whatever the raw value happens to match.
    """
    numeric = [fid for fid in feature_ids if str(fid).isdigit()]
    if not numeric:
        return {}
    rowids = [_feature_id_to_rowid(fid) for fid in numeric]
    placeholders = ", ".join(["?"] * len(rowids))
    rows = con.execute(
        f'SELECT rowid, "id" FROM {table} WHERE rowid IN ({placeholders})',
        rowids,
    ).fetchall()
    by_rowid = {int(r[0]): r[1] for r in rows}
    resolved: dict[str, str] = {}
    for fid, rowid in zip(numeric, rowids):
        if rowid in by_rowid:
            resolved[str(fid)] = by_rowid[rowid]
    return resolved


def _bbox_prefilter(
    columns: Sequence[str], bbox_4326: tuple[float, float, float, float]
) -> str:
    """Row-group pruning on the layer's scalar bbox columns, when it has them.

    The axis columns are plain doubles DuckDB keeps zone maps for, so this
    prunes row groups before a single geometry is read — ``ST_Intersects``
    alone cannot.
    """
    if not {"xmin", "ymin", "xmax", "ymax"} <= set(columns):
        return ""
    xmin, ymin, xmax, ymax = bbox_4326
    return (
        f'AND "xmax" >= {xmin} AND "xmin" <= {xmax} '
        f'AND "ymax" >= {ymin} AND "ymin" <= {ymax}'
    )


def fetch_candidates(
    con: Any,
    edges_table: str,
    nodes_table: str,
    bbox_4326: tuple[float, float, float, float],
    exclude_edge_ids: Iterable[str],
    edge_columns: Sequence[str] = (),
    node_columns: Sequence[str] = (),
) -> tuple[list[NodeCandidate], list[EdgeCandidate]]:
    """Nodes and edges near the edit, in projected metres.

    Restricted to the edit's own bounding box grown by the tolerance: snapping
    only ever looks at what the user drew next to, and a city-wide network is
    far too large to load whole. The filter runs against the STORED geometry
    (with the box in 4326) so only the matching handful of rows is ever
    reprojected — transforming the table first would rewrite every geometry in
    the network per save.
    """
    xmin, ymin, xmax, ymax = bbox_4326
    box = f"ST_MakeEnvelope({xmin}, {ymin}, {xmax}, {ymax})"
    node_rows = con.execute(
        f"""
        SELECT "id", ST_X(g), ST_Y(g) FROM (
            SELECT "id", {TO_3857.format(geom="geometry")} AS g
            FROM {nodes_table}
            WHERE ST_Intersects(geometry, {box})
              {_bbox_prefilter(node_columns, bbox_4326)}
        )
        """
    ).fetchall()
    nodes = [
        NodeCandidate(node_id=r[0], x=float(r[1]), y=float(r[2])) for r in node_rows
    ]

    excluded = set(exclude_edge_ids)
    edge_rows = con.execute(
        f"""
        SELECT "id", source_node, target_node, ST_AsText(g) FROM (
            SELECT "id", source_node, target_node,
                   {TO_3857.format(geom="geometry")} AS g
            FROM {edges_table}
            WHERE ST_Intersects(geometry, {box})
              {_bbox_prefilter(edge_columns, bbox_4326)}
        )
        """
    ).fetchall()
    edges = [
        EdgeCandidate(
            edge_id=r[0],
            source_node=r[1],
            target_node=r[2],
            geometry=wkt.loads(r[3]),
        )
        for r in edge_rows
        if r[0] not in excluded
    ]
    return nodes, edges


def node_position(con: Any, nodes_table: str, node_id: str) -> tuple[float, float]:
    """A node's stored 4326 coordinate.

    Read back rather than recomputed: a drawn vertex is moved onto the node it
    resolved to, and the node table is what the graph joins on, so the vertex
    has to match the row exactly and not a second derivation of it.
    """
    row = con.execute(
        f'SELECT ST_X(geometry), ST_Y(geometry) FROM {nodes_table} WHERE "id" = ?',
        [node_id],
    ).fetchone()
    if row is None:
        raise ValueError(f"Node {node_id} is not in the nodes layer.")
    return float(row[0]), float(row[1])


def node_references(
    con: Any,
    edges_table: str,
    node_ids: Iterable[str],
    exclude_edge_ids: Iterable[str] = (),
) -> dict[str, set[str]]:
    """Which edges reference each node — the graph's degree, before the batch.

    Distinct from ``fetch_candidates``, which answers a different question and
    so needs different exclusions. Snapping must not target a row the batch is
    rewriting, or an edge would snap to its own former self. Degree must count
    those rows, because an edge being moved still holds its node until it is
    rewritten; only a row being deleted stops counting.
    """
    ids = list(dict.fromkeys(node_ids))
    if not ids:
        return {}
    placeholders = ", ".join(["?"] * len(ids))
    params: list[Any] = ids + ids
    excluded = ""
    dropped = list(dict.fromkeys(exclude_edge_ids))
    if dropped:
        excluded = f'AND "id" NOT IN ({", ".join(["?"] * len(dropped))})'
        params += dropped
    rows = con.execute(
        f"""
        SELECT "id", source_node, target_node FROM {edges_table}
        WHERE (source_node IN ({placeholders}) OR target_node IN ({placeholders}))
          {excluded}
        """,
        params,
    ).fetchall()
    wanted = set(ids)
    references: dict[str, set[str]] = {node_id: set() for node_id in ids}
    for edge_id, source, target in rows:
        for node_id in (source, target):
            if node_id in wanted:
                references[node_id].add(edge_id)
    return references


def _finite(value: float, what: str) -> float:
    """A coordinate or fraction that can be written.

    These reach SQL as bare literals, and `nan`/`inf` are valid DuckDB doubles
    there — so an unusable number is stored rather than refused, and only
    surfaces much later as a routing failure that names neither the layer nor
    the row.
    """
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{what} is not a finite number ({value}).")
    return number


def _node_insert_sql(nodes_table: str, columns: Sequence[str], geom_expr: str) -> str:
    """INSERT for a node, writing only the columns the layer actually has.

    ``bbox`` is a struct whose xmin/ymin/xmax/ymax are subfields, not columns of
    their own — writing them as columns fails on the real layers.
    """
    target = ['"id"']
    select = ["?"]
    target.append('"geometry"')
    select.append("g")
    if "bbox" in columns:
        target.append('"bbox"')
        select.append(bbox_struct_sql("g"))
    for axis, fn in (
        ("xmin", "ST_XMin"),
        ("ymin", "ST_YMin"),
        ("xmax", "ST_XMax"),
        ("ymax", "ST_YMax"),
    ):
        if axis in columns:
            target.append(f'"{axis}"')
            select.append(f"{fn}(g)")
    return (
        f"INSERT INTO {nodes_table} ({', '.join(target)}) "
        f"SELECT {', '.join(select)} FROM ({geom_expr})"
    )


def insert_node(
    con: Any,
    nodes_table: str,
    columns: Sequence[str],
    node_id: str,
    x_3857: float,
    y_3857: float,
) -> None:
    """Add a node at a projected coordinate, stored back as 4326."""
    x = _finite(x_3857, "Node x coordinate")
    y = _finite(y_3857, "Node y coordinate")
    geom_expr = (
        f"SELECT ST_Transform(ST_Point({x}, {y}), 'EPSG:3857', "
        "'EPSG:4326', always_xy := true) AS g"
    )
    con.execute(_node_insert_sql(nodes_table, columns, geom_expr), [node_id])


def insert_node_on_edge(
    con: Any,
    nodes_table: str,
    columns: Sequence[str],
    edges_table: str,
    node_id: str,
    edge_id: str,
    fraction: float,
) -> None:
    """Add a node at a fraction along an edge, exactly on its geometry."""
    point = _projected(
        f"ST_LineInterpolatePoint({{geom}}, {_finite(fraction, 'Split fraction')})"
    )
    geom_expr = f'SELECT {point} AS g FROM {edges_table} WHERE "id" = ?'
    con.execute(_node_insert_sql(nodes_table, columns, geom_expr), [node_id, edge_id])


def split_edge(
    con: Any,
    edges_table: str,
    columns: Sequence[str],
    edge_id: str,
    fraction: float,
    left_id: str,
    right_id: str,
    new_node_id: str,
    field_config: dict[str, Any] | None = None,
) -> None:
    """Replace an edge with two halves meeting at a new node.

    Both halves inherit every attribute of the original except what its geometry
    derived — those are recomputed in the insert itself, or each half would
    claim the whole original's length.
    """
    derived = _derived(columns, '"geometry"', field_config)
    for new_id, start, end, source, target in (
        (left_id, 0.0, fraction, None, new_node_id),
        (right_id, fraction, 1.0, new_node_id, None),
    ):
        replacements = [
            '? AS "id"',
            "coalesce(?, source_node) AS source_node",
            "coalesce(?, target_node) AS target_node",
        ]
        replacements += [f'{sql} AS "{name}"' for name, sql in derived]
        # The half replaces the geometry first, so everything above reads it
        # rather than the original's.
        cut = _projected(
            f"ST_LineSubstring({{geom}}, {_finite(start, 'Split start')}, "
            f"{_finite(end, 'Split end')})"
        )
        half = (
            f'SELECT * REPLACE ({cut} AS "geometry") '
            f'FROM {edges_table} WHERE "id" = ?'
        )
        con.execute(
            f"INSERT INTO {edges_table} BY NAME "
            f"SELECT * REPLACE ({', '.join(replacements)}) FROM ({half})",
            [new_id, source, target, edge_id],
        )
    con.execute(f'DELETE FROM {edges_table} WHERE "id" = ?', [edge_id])


# The new geometry, named so that computed and bbox expressions can read it
# without the GeoJSON being passed as a parameter once per expression.
_NEW_GEOM = '"new_geom"'
_NEW_GEOM_SOURCE = 'SELECT ST_MakeValid(ST_GeomFromGeoJSON(?)) AS "new_geom"'


def insert_edge(
    con: Any,
    edges_table: str,
    column_names: Sequence[str],
    edge_id: str,
    geometry: dict[str, Any],
    properties: dict[str, Any],
    source_node: str,
    target_node: str,
    field_config: dict[str, Any] | None = None,
) -> None:
    """Add an edge with its resolved endpoints."""
    derived = _derived(column_names, _NEW_GEOM, field_config)
    reserved = {"id", "geometry", "source_node", "target_node"} | {
        name for name, _ in derived
    }

    columns = ['"id"', '"geometry"', '"source_node"', '"target_node"']
    selects = ["?", _NEW_GEOM, "?", "?"]
    values: list[Any] = [edge_id, source_node, target_node]
    for key, value in properties.items():
        if key in reserved or key not in column_names:
            continue
        columns.append(f'"{key}"')
        selects.append("?")
        values.append(value)
    for name, sql in derived:
        columns.append(f'"{name}"')
        selects.append(sql)

    con.execute(
        f"INSERT INTO {edges_table} ({', '.join(columns)}) "
        f"SELECT {', '.join(selects)} FROM ({_NEW_GEOM_SOURCE})",
        values + [json.dumps(geometry)],
    )


def update_edge(
    con: Any,
    edges_table: str,
    column_names: Sequence[str],
    edge_id: str,
    geometry: dict[str, Any],
    properties: dict[str, Any],
    source_node: str,
    target_node: str,
    field_config: dict[str, Any] | None = None,
) -> None:
    """Replace an edge's geometry, endpoints and attributes."""
    src = f"src.{_NEW_GEOM}"
    derived = _derived(column_names, src, field_config)
    reserved = {"id", "geometry", "source_node", "target_node"} | {
        name for name, _ in derived
    }

    # Numbered rather than positional: DuckDB binds an UPDATE ... FROM by
    # walking the FROM clause before the SET list, so "?" would put the
    # geometry where the first assignment's value belongs.
    values: list[Any] = [json.dumps(geometry), source_node, target_node]
    assignments = [f'"geometry" = {src}', '"source_node" = $2', '"target_node" = $3']
    for key, value in properties.items():
        if key in reserved or key not in column_names:
            continue
        values.append(value)
        assignments.append(f'"{key}" = ${len(values)}')
    assignments += [f'"{name}" = {sql}' for name, sql in derived]
    values.append(edge_id)

    con.execute(
        f"UPDATE {edges_table} SET {', '.join(assignments)} "
        f"FROM (SELECT ST_MakeValid(ST_GeomFromGeoJSON($1)) AS \"new_geom\") AS src "
        f'WHERE {edges_table}."id" = ${len(values)}',
        values,
    )
    changed = con.execute(
        f'SELECT count(*) FROM {edges_table} WHERE "id" = ?', [edge_id]
    ).fetchone()
    if not changed or changed[0] == 0:
        raise ValueError(
            f"Edge {edge_id} is no longer in the layer, so the edit could not be "
            "applied. Reload before saving."
        )


def _derived(
    columns: Sequence[str], geom_sql: str, field_config: dict[str, Any] | None
) -> list[tuple[str, str]]:
    """Every column derived from an edge's geometry, as (name, SQL).

    The layer's computed columns plus the bbox upkeep, in one place so the three
    write paths cannot drift. ``geom_sql`` is how the new geometry is spelled in
    the statement being built.

    Spliced into the write itself, never applied afterwards: updating a row that
    was inserted in the same transaction leaves DuckLake's transaction-local row
    id (around 1e18) on it for good, and the tile query hands ``rowid`` to
    ST_AsMVT as an int32 feature id — so every tile covering an edited edge
    would fail to render.
    """
    derived: list[tuple[str, str]] = []
    if field_config:
        derived += [
            (spec.name, spec.compute_sql)
            for spec in parse_computed_columns(field_config, geom_column="__geom__")
            if spec.name in columns
        ]
    if "bbox" in columns:
        derived.append(("bbox", bbox_struct_sql('"__geom__"')))
    derived += [
        (axis, f'{fn}("__geom__")')
        for axis, fn in (
            ("xmin", "ST_XMin"),
            ("ymin", "ST_YMin"),
            ("xmax", "ST_XMax"),
            ("ymax", "ST_YMax"),
        )
        if axis in columns
    ]
    return [(name, sql.replace('"__geom__"', geom_sql)) for name, sql in derived]


def delete_edges_by_id(con: Any, edges_table: str, edge_ids: Sequence[str]) -> None:
    """Remove edges by their own ids.

    Raises when an id is not there: a delete that quietly removes nothing looks
    identical to a successful one from the client's side.
    """
    if not edge_ids:
        return
    placeholders = ", ".join(["?"] * len(edge_ids))
    present = con.execute(
        f'SELECT count(*) FROM {edges_table} WHERE "id" IN ({placeholders})',
        list(edge_ids),
    ).fetchone()
    if not present or present[0] != len(set(edge_ids)):
        raise ValueError(
            "Some edges are no longer in the layer, so the deletion could not be "
            "applied. Reload before saving."
        )
    con.execute(
        f'DELETE FROM {edges_table} WHERE "id" IN ({placeholders})', list(edge_ids)
    )


def edge_endpoints(con: Any, edges_table: str, edge_ids: Sequence[str]) -> set[str]:
    """Node ids the given edges currently reference.

    The nodes a save might orphan: the endpoints of everything it removes or
    moves. Which of them actually end up orphaned is ``node_references``.
    """
    ids = list(edge_ids)
    if not ids:
        return set()
    placeholders = ", ".join(["?"] * len(ids))
    rows = con.execute(
        f"SELECT source_node, target_node FROM {edges_table} "
        f'WHERE "id" IN ({placeholders})',
        ids,
    ).fetchall()
    return {value for row in rows for value in row if value}


def delete_nodes_by_id(con: Any, nodes_table: str, node_ids: Iterable[str]) -> int:
    """Remove nodes by id. Returns how many were removed."""
    ids = list(node_ids)
    if not ids:
        return 0
    placeholders = ", ".join(["?"] * len(ids))
    con.execute(f'DELETE FROM {nodes_table} WHERE "id" IN ({placeholders})', ids)
    return len(ids)


def column_names(con: Any, table: str) -> list[str]:
    """Column names of a layer table.

    Read off an empty result rather than PRAGMA table_info, which does not take
    a catalog-qualified name like ``lake.schema.table``.
    """
    cursor = con.execute(f"SELECT * FROM {table} LIMIT 0")
    return [d[0] for d in cursor.description]
