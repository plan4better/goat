"""The data fingerprint of styles (the specification's section 12).

A style's computed values record the data they were computed from in
`computed.data`: a DuckLake layer `ducklake:<data_snapshot>`, a promoted catalog
layer `catalog:<catalog_version>`, a raster file `url:<hash of its address>`. `layer.data_snapshot` is the last DuckLake
snapshot that changed the layer's data; it is kept by one Postgres statement
(`advance_data_snapshots_sql`) that core runs when a map loads and the maintenance
task runs before it expires snapshots, so no change expires unseen.
"""

import hashlib
from typing import Any

from goatlib.style.compute import computed_missing

#: Change kinds in `ducklake_snapshot_changes.changes_made` that change a table's
#: data or columns. Compaction (`merge_adjacent`) rewrites files, not data.
CHANGE_KINDS = (
    "inserted_into_table",
    "deleted_from_table",
    "inlined_insert",
    "inlined_delete",
    "altered_table",
)


def changed_table_ids(changes_made: str) -> set[int]:
    """The table ids a snapshot's `changes_made` text names with a data change."""
    found: set[int] = set()
    for item in (changes_made or "").split(","):
        kind, _, table = item.strip().partition(":")
        if kind in CHANGE_KINDS and table.isdigit():
            found.add(int(table))
    return found


def advance_data_snapshots_sql(schema: str, ducklake_schema: str = "ducklake") -> str:
    """One Postgres statement that moves every changed layer's `data_snapshot`.

    It reads the change log after the cursor, maps each changed table
    (`t_<uuid without hyphens>`) to its layer and raises `data_snapshot` to the
    newest snapshot that changed it; when the cursor is older than the oldest kept
    snapshot (changes expired unseen), every layer is raised to that snapshot.
    The cursor moves to the newest snapshot read (a missing cursor row reads as 0
    and is written). Running it again changes nothing.
    It returns the number of layers it moved.

    With nothing new it writes nothing. Callers that run it often (every map
    load) ask `data_snapshots_pending_sql` first, which reads three index
    entries, and run this only when it answers true: this statement joins the
    new log rows to `ducklake_table`, which DuckLake does not index.
    """
    kinds = ", ".join(f"'{k}'" for k in CHANGE_KINDS)
    return f"""
WITH state AS (
    SELECT cur.snapshot_id AS cur,
           newest.snapshot_id AS newest,
           cur.snapshot_id < oldest.snapshot_id - 1 AS expired,
           oldest.snapshot_id AS oldest,
           cur.missing
    FROM (
        SELECT coalesce(max(snapshot_id), 0) AS snapshot_id, count(*) = 0 AS missing
        FROM {schema}.data_snapshot_cursor WHERE id = 1
    ) cur,
    (SELECT coalesce(max(snapshot_id), 0) AS snapshot_id
       FROM {ducklake_schema}.ducklake_snapshot_changes) newest,
    (SELECT coalesce(min(snapshot_id), 0) AS snapshot_id
       FROM {ducklake_schema}.ducklake_snapshot) oldest
),
changed_tables AS (
    SELECT CASE WHEN split_part(item, ':', 2) ~ '^[0-9]+$'
                THEN split_part(item, ':', 2)::bigint END AS table_id,
           max(c.snapshot_id) AS snapshot_id
    FROM {ducklake_schema}.ducklake_snapshot_changes c
    CROSS JOIN LATERAL regexp_split_to_table(coalesce(c.changes_made, ''), ',') AS item
    WHERE c.snapshot_id > (SELECT cur FROM state)
      AND split_part(item, ':', 1) IN ({kinds})
    GROUP BY 1
),
per_layer AS (
    -- The name is checked on the joined rows only: a filter on the scan would
    -- match every table name of the catalog.
    SELECT CASE WHEN t.table_name ~ '^t_[0-9a-f]{{32}}$'
                THEN substr(t.table_name, 3)::uuid END AS layer_id,
           max(ch.snapshot_id) AS snapshot_id
    FROM changed_tables ch
    JOIN {ducklake_schema}.ducklake_table t ON t.table_id = ch.table_id
    GROUP BY 1
),
moved_changed AS (
    UPDATE {schema}.layer l SET data_snapshot = p.snapshot_id
    FROM per_layer p
    WHERE NOT (SELECT expired FROM state)
      AND l.id = p.layer_id
      AND p.snapshot_id > coalesce(l.data_snapshot, 0)
    RETURNING l.id
),
moved_expired AS (
    UPDATE {schema}.layer l
    SET data_snapshot = GREATEST(
        (SELECT oldest FROM state),
        coalesce((SELECT p.snapshot_id FROM per_layer p WHERE p.layer_id = l.id), 0)
    )
    WHERE (SELECT expired FROM state)
      AND GREATEST(
          (SELECT oldest FROM state),
          coalesce((SELECT p.snapshot_id FROM per_layer p WHERE p.layer_id = l.id), 0)
      ) > coalesce(l.data_snapshot, 0)
    RETURNING l.id
),
cursor_moved AS (
    INSERT INTO {schema}.data_snapshot_cursor (id, snapshot_id)
    SELECT 1, newest FROM state WHERE newest > cur OR missing
    ON CONFLICT (id) DO UPDATE
    SET snapshot_id = GREATEST({schema}.data_snapshot_cursor.snapshot_id, EXCLUDED.snapshot_id)
    RETURNING snapshot_id
)
SELECT (SELECT count(*) FROM moved_changed) + (SELECT count(*) FROM moved_expired)
""".strip()


def data_snapshots_pending_sql(schema: str, ducklake_schema: str = "ducklake") -> str:
    """One row, one boolean: whether `advance_data_snapshots_sql` has anything to
    do (new log rows, no cursor yet, or changes that expired unseen)."""
    return f"""
SELECT cur.missing
    OR newest.snapshot_id > cur.snapshot_id
    OR cur.snapshot_id < oldest.snapshot_id - 1
FROM (
    SELECT coalesce(max(snapshot_id), 0) AS snapshot_id, count(*) = 0 AS missing
    FROM {schema}.data_snapshot_cursor WHERE id = 1
) cur,
(SELECT coalesce(max(snapshot_id), 0) AS snapshot_id
   FROM {ducklake_schema}.ducklake_snapshot_changes) newest,
(SELECT coalesce(min(snapshot_id), 0) AS snapshot_id
   FROM {ducklake_schema}.ducklake_snapshot) oldest
""".strip()


def fingerprint(*, data_snapshot: int | None, catalog_version: str | None) -> str:
    """The data a layer's computed values are computed from (spec 12)."""
    if catalog_version:
        return f"catalog:{catalog_version}"
    return f"ducklake:{data_snapshot or 0}"


def layer_fingerprint(
    layer_type: str | None,
    data_type: str | None,
    *,
    data_snapshot: int | None = None,
    catalog_version: str | None = None,
    url: str | None = None,
) -> str | None:
    """The fingerprint of any layer row: a vector layer's (`fingerprint`), a
    raster file's catalog version or address (`url:<hash>`: core reads no file,
    so a file replaced under the same address is not noticed), none for a map
    service, which has nothing to compute."""
    if layer_type != "raster":
        return fingerprint(data_snapshot=data_snapshot, catalog_version=catalog_version)
    if data_type != "cog" or not url:
        return None
    if catalog_version:
        return f"catalog:{catalog_version}"
    return "url:" + hashlib.sha256(url.encode()).hexdigest()[:16]


def _computed_data(node: Any, found: list[Any]) -> list[Any]:
    """Every `computed.data` in the document."""
    if isinstance(node, dict):
        computed = node.get("computed")
        if isinstance(computed, dict):
            found.append(computed.get("data"))
        for key, value in node.items():
            if key != "computed":
                _computed_data(value, found)
    elif isinstance(node, list):
        for item in node:
            _computed_data(item, found)
    return found


def is_stale(document: dict[str, Any], fingerprint: str | None) -> bool:
    """Whether the style's computed values are not those of the data now: some
    were computed from other data, or some the style needs are missing. A layer
    without a fingerprint (a map service) is never stale."""
    if fingerprint is None or not isinstance(document, dict):
        return False
    if any(data != fingerprint for data in _computed_data(document, [])):
        return True
    return computed_missing(document)
