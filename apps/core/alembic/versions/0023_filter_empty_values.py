"""Saved layer filters in the filter panel's form for negations and empty tests.

The filter panel writes every negation (is not, excludes, does not contain the
text, is not between, is not on) with the empty value as an alternative, so it
keeps the features without a value, and on a text field "is empty" and "is not
empty" also take the empty text. Filters saved before hold other shapes for the
same rows (`!=`, `isNull` alone, `not` around `like`, ...), which filter without
the empty value, and the panel rewrites them on the next save of any row of the
filter. This revision converts them once with goatlib's shared function
(`goatlib.filter.convert.convert_query`), so a saved filter means the same before
and after its next save: maps with such a filter show the features without a
value from now on.

Converted: every project layer's `query` (its CQL and the switched-off rows of
its notes) and the published snapshots (each layer's `query` and the layer
entries of the map document). The field types come from the DuckLake catalog in
the same database; for a layer whose table the catalog does not list, only the
negations are converted (they do not depend on the type). Workflow step filters
have a format of their own and stay.

A second run changes nothing. The originals are kept in `style_migration_undo`
(`0022_layer_styles_data`'s table, rows of their own), which `downgrade` puts back
where a filter is still as this revision wrote it, before 0022's downgrade drops
the table.

Revision ID: 0023_filter_empty_values
Revises: 0022_layer_styles_data
"""

import collections
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from alembic import op
from core.core.config import settings
from sqlalchemy.dialects.postgresql import JSONB

_ALEMBIC_DIR = str(Path(__file__).resolve().parents[1])
if _ALEMBIC_DIR not in sys.path:
    sys.path.append(_ALEMBIC_DIR)

import helpers as h  # noqa: E402

revision = "0023_filter_empty_values"
down_revision = "0022_layer_styles_data"
branch_labels = None
depends_on = None

S = settings.SCHEMA
#: Rows per statement.
BATCH = 2000
UNDO = "style_migration_undo"
#: The undo table's `table_name` of each place this revision converts.
LINKS = "filter:layer_project"
SNAPSHOTS = "filter:project_public"

#: DuckLake's own type names, as `ducklake_column.column_type` holds them.
_INTEGER = re.compile(r"u?int(8|16|32|64|128)|u?hugeint")
_NUMBER = re.compile(r"float(32|64)?|double|real|decimal(\(.*\))?")
#: The panel reads a DATE column as a timestamp field too (geoapi's queryables
#: give both the `date-time` format).
_TEMPORAL = {
    "date",
    "timestamp",
    "timestamptz",
    "timestamp_s",
    "timestamp_ms",
    "timestamp_ns",
}
#: Columns the panel lists no field for (`fieldsOf` in the web, geoapi's hidden
#: fields): their type is unknown to it.
_HIDDEN = {"id", "layer_id", "geom", "geometry", "bbox"}
_HIDDEN_PATTERN = re.compile(r"h3_\d+|\$.*")

log = logging.getLogger("alembic.runtime.migration")


def _rows(sql: str, **params: Any) -> list[Any]:
    return list(op.get_bind().execute(sa.text(sql.format(S=S)), params).mappings())


def _exec(sql: str, **params: Any) -> Any:
    return op.get_bind().execute(sa.text(sql.format(S=S)), params)


def _batches(items: list[Any]) -> list[list[Any]]:
    return [items[i : i + BATCH] for i in range(0, len(items), BATCH)]


def field_type(name: str, column_type: str) -> str | None:
    """The filter's type of a DuckLake column as the panel sees it, or None for a
    column it lists no field for or of a type it does not know as one of them
    (lists, structs, JSON, geometry, times, binary, ...). Only `varchar` is text:
    an empty-text test on any other column is no test the column can answer."""
    if name in _HIDDEN or _HIDDEN_PATTERN.fullmatch(name):
        return None
    t = column_type.strip().lower()
    if _INTEGER.fullmatch(t):
        return "integer"
    if _NUMBER.fullmatch(t):
        return "number"
    if t == "boolean":
        return "boolean"
    if t in _TEMPORAL:
        return "datetime"
    if t == "varchar":
        return "string"
    return None


def _table_name(layer_id: str) -> str:
    return "t_" + layer_id.replace("-", "")


def _field_types(layer_ids: set[str]) -> dict[str, dict[str, str]]:
    """The field types of each layer the DuckLake catalog lists, by layer id."""
    lake = settings.DUCKLAKE_CATALOG_SCHEMA
    if not layer_ids or not (
        h.table_exists("ducklake_table", lake)
        and h.column_exists("ducklake_column", "parent_column", lake)
    ):
        return {}
    by_table = {_table_name(i): i for i in layer_ids}
    types: dict[str, dict[str, str]] = {}
    for r in (
        op.get_bind()
        .execute(
            sa.text(
                f'SELECT t.table_name, c.column_name, c.column_type FROM "{lake}".ducklake_table t '
                f'JOIN "{lake}".ducklake_column c ON c.table_id = t.table_id '
                "WHERE t.end_snapshot IS NULL AND c.end_snapshot IS NULL "
                "AND c.parent_column IS NULL AND t.table_name = ANY(:names)"
            ),
            {"names": sorted(by_table)},
        )
        .mappings()
    ):
        fields = types.setdefault(by_table[r["table_name"]], {})
        kind = field_type(r["column_name"], r["column_type"] or "")
        if kind:
            fields[r["column_name"]] = kind
    return types


class _Counts:
    def __init__(self) -> None:
        self.read: collections.Counter[str] = collections.Counter()
        self.changed: collections.Counter[str] = collections.Counter()
        self.untyped: collections.Counter[str] = collections.Counter()
        self.rows: dict[str, collections.Counter[str]] = collections.defaultdict(
            collections.Counter
        )

    def add(self, place: str, changes: list[tuple[str, str]]) -> None:
        for _, row_op in changes:
            self.rows[place][row_op] += 1

    def report(self) -> None:
        for place in self.read:
            rows = ", ".join(f"{k} {n}" for k, n in self.rows[place].most_common())
            untyped = self.untyped[place]
            log.info(
                "Filter conversion %s: %d read, %d changed%s%s",
                place,
                self.read[place],
                self.changed[place],
                f", {untyped} without field types" if untyped else "",
                f"; rows: {rows}" if rows else "",
            )


def _links(counts: _Counts) -> None:
    from goatlib.filter.convert import convert_query

    rows = _rows(
        """
        SELECT id, layer_id::text AS layer_id, query, md5(query::text) AS digest
        FROM {S}.layer_project
        WHERE jsonb_typeof(query) = 'object' AND (query ? 'cql' OR query ? 'op')
        """
    )
    types = _field_types({r["layer_id"] for r in rows})
    items = []
    for r in rows:
        counts.read["project layers"] += 1
        fields = types.get(r["layer_id"])
        if fields is None:
            counts.untyped["project layers"] += 1
        converted = convert_query(r["query"], fields)
        if not converted.changes:
            continue
        counts.changed["project layers"] += 1
        counts.add("project layers", converted.changes)
        items.append({"id": r["id"], "digest": r["digest"], "after": converted.value})
    for batch in _batches(items):
        # The original is copied in the database, where the row is still as read.
        _exec(
            """
            WITH x AS (
                SELECT (e->>'id')::int AS id, e->>'digest' AS digest, e->'after' AS after
                FROM jsonb_array_elements(CAST(:rows AS jsonb)) e
            ),
            c AS (
                SELECT lp.id, lp.query AS before, x.after
                FROM {S}.layer_project lp JOIN x ON x.id = lp.id
                WHERE md5(lp.query::text) = x.digest
                FOR UPDATE OF lp
            ),
            u AS (
                INSERT INTO {S}.style_migration_undo (table_name, row_id, config)
                SELECT :t, c.id::text, jsonb_build_object('before', c.before, 'after', c.after)
                FROM c
                ON CONFLICT (table_name, row_id) DO UPDATE SET config = EXCLUDED.config
            )
            UPDATE {S}.layer_project lp SET query = c.after FROM c WHERE lp.id = c.id
            """,
            rows=json.dumps(batch),
            t=LINKS,
        )


def _layer_filter(query: Any) -> Any:
    """The CQL a map document's layer entry carries for `query` (`layer_filter`)."""
    if not isinstance(query, dict):
        return None
    cql = query.get("cql") if "cql" in query else query
    return cql if isinstance(cql, dict) and cql.get("op") else None


def _map_entries(items: Any, path: list[Any]) -> list[tuple[list[Any], dict[str, Any]]]:
    """The layer entries of a map document's tree, with their paths."""
    out: list[tuple[list[Any], dict[str, Any]]] = []
    if not isinstance(items, list):
        return out
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        if item.get("type") == "group":
            out += _map_entries(item.get("children"), [*path, i, "children"])
        elif "filter" in item:
            out.append(([*path, i], item))
    return out


def _snapshot_changes(
    config: dict[str, Any], types: dict[str, dict[str, str]], counts: _Counts
) -> list[dict[str, Any]]:
    """Converts a snapshot's filters in place; returns each change with its path."""
    from goatlib.filter.convert import convert_cql, convert_query

    changes: list[dict[str, Any]] = []
    layers = config.get("layers") if isinstance(config.get("layers"), list) else []
    layer_of: dict[Any, str] = {}
    converted_cql: dict[Any, tuple[Any, Any]] = {}
    for i, x in enumerate(layers):
        if not isinstance(x, dict) or not isinstance(x.get("query"), dict):
            continue
        layer_id = str(x.get("layer_id"))
        layer_of[x.get("id")] = layer_id
        counts.read["published layers"] += 1
        fields = types.get(layer_id)
        if fields is None:
            counts.untyped["published layers"] += 1
        converted = convert_query(x["query"], fields)
        converted_cql[x.get("id")] = (
            _layer_filter(x["query"]),
            _layer_filter(converted.value),
        )
        if converted.changes:
            counts.changed["published layers"] += 1
            counts.add("published layers", converted.changes)
            changes.append(
                {
                    "path": ["layers", i, "query"],
                    "before": x["query"],
                    "after": converted.value,
                }
            )
            x["query"] = converted.value
    document = config.get("map")
    for path, entry in _map_entries(
        document.get("layers") if isinstance(document, dict) else None,
        ["map", "layers"],
    ):
        before = entry["filter"]
        same, after = converted_cql.get(entry.get("id"), (None, None))
        if same is None or same != before:
            # An entry the snapshot's layers do not describe the same way.
            after = convert_cql(
                before, types.get(layer_of.get(entry.get("id"), ""))
            ).value
        if after is not None and after != before:
            changes.append(
                {"path": [*path, "filter"], "before": before, "after": after}
            )
            entry["filter"] = after
    return changes


def _snapshots(counts: _Counts) -> None:
    snapshots = _rows(
        "SELECT id, config, md5(config::text) AS digest FROM {S}.project_public "
        "WHERE jsonb_typeof(config) = 'object' "
        "AND (config::text LIKE '%\"cql\"%' OR config::text LIKE '%\"filter\"%')"
    )
    layer_ids = {
        str(x.get("layer_id"))
        for s in snapshots
        for x in (s["config"].get("layers") or [])
        if isinstance(x, dict) and x.get("layer_id")
    }
    types = _field_types(layer_ids)
    items = []
    for s in snapshots:
        counts.read["snapshots"] += 1
        config = s["config"]
        changes = _snapshot_changes(config, types, counts)
        if not changes:
            continue
        counts.changed["snapshots"] += 1
        items.append(
            {
                "id": str(s["id"]),
                "digest": s["digest"],
                "config": config,
                "changes": changes,
            }
        )
    for batch in _batches(items):
        _exec(
            """
            WITH x AS (
                SELECT (e->>'id')::uuid AS id, e->>'digest' AS digest, e->'config' AS config,
                       e->'changes' AS changes
                FROM jsonb_array_elements(CAST(:rows AS jsonb)) e
            ),
            c AS (
                SELECT p.id, x.config, x.changes FROM {S}.project_public p
                JOIN x ON x.id = p.id WHERE md5(p.config::text) = x.digest
                FOR UPDATE OF p
            ),
            u AS (
                INSERT INTO {S}.style_migration_undo (table_name, row_id, config)
                SELECT :t, c.id::text, jsonb_build_object('changes', c.changes) FROM c
                ON CONFLICT (table_name, row_id) DO UPDATE SET config = EXCLUDED.config
            )
            UPDATE {S}.project_public p SET config = c.config FROM c WHERE p.id = c.id
            """,
            rows=json.dumps(batch),
            t=SNAPSHOTS,
        )


def upgrade() -> None:
    if not h.table_exists(UNDO, S):
        op.create_table(
            UNDO,
            sa.Column("table_name", sa.Text(), primary_key=True, nullable=False),
            sa.Column("row_id", sa.Text(), primary_key=True, nullable=False),
            sa.Column("config", JSONB(), nullable=False),
            schema=S,
        )
    counts = _Counts()
    _links(counts)
    _snapshots(counts)
    counts.report()


def _put_back(config: Any, changes: list[dict[str, Any]]) -> bool:
    """Puts each original back where the snapshot still holds what this revision
    wrote; returns whether anything changed."""
    changed = False
    for change in changes:
        *parent_path, key = change["path"]
        node = config
        try:
            for step in parent_path:
                node = node[step]
            if node[key] == change["after"]:
                node[key] = change["before"]
                changed = True
        except (KeyError, IndexError, TypeError):
            continue
    return changed


def downgrade() -> None:
    if not h.table_exists(UNDO, S):
        return
    restored = _exec(
        """
        UPDATE {S}.layer_project lp SET query = u.config->'before'
        FROM {S}.style_migration_undo u
        WHERE u.table_name = :t AND lp.id::text = u.row_id AND lp.query = u.config->'after'
        """,
        t=LINKS,
    ).rowcount
    items = []
    for r in _rows(
        """
        SELECT p.id, p.config, u.config AS undo FROM {S}.project_public p
        JOIN {S}.style_migration_undo u ON u.table_name = :t AND u.row_id = p.id::text
        """,
        t=SNAPSHOTS,
    ):
        config = r["config"]
        if _put_back(config, r["undo"].get("changes") or []):
            items.append({"id": str(r["id"]), "config": config})
    for batch in _batches(items):
        _exec(
            """
            UPDATE {S}.project_public p SET config = e->'config'
            FROM jsonb_array_elements(CAST(:rows AS jsonb)) e
            WHERE p.id = (e->>'id')::uuid
            """,
            rows=json.dumps(batch),
        )
    _exec(
        "DELETE FROM {S}.style_migration_undo WHERE table_name = ANY(:t)",
        t=[LINKS, SNAPSHOTS],
    )
    log.info(
        "Filter conversion undone: %d project layers, %d snapshots",
        restored,
        len(items),
    )
