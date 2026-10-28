"""GOAT Style data: today's styles become `layer_style` rows (spec 17).

Every stored style of today's format is converted with goatlib's shared function
(`goatlib.style.migrate.migrate_style`): dataset defaults, each project layer's
style (a named style "Default" with its revision 1 row, active), map state into
columns (`visible`, `legend_expanded`, group `visible` and `expanded`), workflow
and template `outputStyle`, layout and template `locked_layer_styles`, and the
published snapshots gain `map` and `styles` as publishing now writes them.

The data snapshot tracker runs first, so every converted classified style is
stamped with its layer's fingerprint and nothing is recomputed on the first map
load. A style that cannot be converted becomes the dataset's default style: a
release never fails on a style. Each step skips what it already did, so a second
run changes nothing. The `properties` columns are not touched (the previous
release still reads them); the configs rewritten in place are kept in
`style_migration_undo`, which `downgrade` restores.

Revision ID: 0013_layer_styles_data
Revises: 0012_layer_styles
"""

import collections
import json
import logging
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import sqlalchemy as sa
from alembic import op
from core.core.config import settings
from sqlalchemy.dialects.postgresql import JSONB

_ALEMBIC_DIR = str(Path(__file__).resolve().parents[1])
if _ALEMBIC_DIR not in sys.path:
    sys.path.append(_ALEMBIC_DIR)

import helpers as h  # noqa: E402

revision = "0013_layer_styles_data"
down_revision = "0012_layer_styles"
branch_labels = None
depends_on = None

S = settings.SCHEMA
#: Rows per insert statement: a few MB of JSON per statement at most.
BATCH = 2000
#: The undo table's row that says the one-time steps (groups, table links) ran.
MARKER = ("_migrated", "0013")
#: Tables whose `config` this revision rewrites in place.
CONFIG_TABLES = ("workflow", "template", "report_layout")

log = logging.getLogger("alembic.runtime.migration")


def _rows(sql: str, **params: Any) -> list[Any]:
    return list(op.get_bind().execute(sa.text(sql.format(S=S)), params).mappings())


def _exec(sql: str, **params: Any) -> None:
    op.get_bind().execute(sa.text(sql.format(S=S)), params)


def _flag(props: Any, *path: str) -> bool | None:
    """A boolean inside today's `properties`, or None when absent or not a boolean."""
    node = props
    for key in path:
        node = node.get(key) if isinstance(node, dict) else None
    return node if isinstance(node, bool) else None


def _batches(items: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    return [items[i : i + BATCH] for i in range(0, len(items), BATCH)]


class _Converter:
    """migrate_style with the migration's shared inputs, and the numbers it logs."""

    def __init__(self) -> None:
        from goatlib.style.defaults import default_style
        from goatlib.style.fingerprint import fingerprint
        from goatlib.style.migrate import context_for, migrate_style

        self.default_style = default_style
        self.fingerprint = fingerprint
        self.context_for = context_for
        self.migrate_style = migrate_style
        self.at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.assets = {
            r["s3_key"]: str(r["id"])
            for r in _rows("SELECT id, s3_key FROM {S}.uploaded_asset")
        }
        self.rows: collections.Counter[str] = collections.Counter()
        self.fallbacks: collections.Counter[str] = collections.Counter()
        self.lossy: dict[str, collections.Counter[str]] = collections.defaultdict(
            collections.Counter
        )

    def layer_fingerprint(self, row: Any) -> str | None:
        if row["type"] == "raster":
            return None
        return self.fingerprint(
            data_snapshot=row["data_snapshot"], catalog_version=row["catalog_version"]
        )

    def convert(
        self,
        place: str,
        properties: Any,
        ctx: Any,
        *,
        fingerprint: str | None,
        seed: str | None,
    ) -> Any:
        m = self.migrate_style(
            properties,
            ctx,
            fingerprint=fingerprint,
            at=self.at,
            asset_for_url=self.assets.get,
            seed=seed,
        )
        self.rows[place] += 1
        if m.fell_back:
            self.fallbacks[place] += 1
        for note in m.lossy:
            self.lossy[place][note.key] += 1
        return m

    def report(self) -> None:
        for place, n in self.rows.items():
            lossy = ", ".join(f"{k} {c}" for k, c in self.lossy[place].most_common())
            log.info(
                "GOAT Style migration %s: %d styles, %d default fallbacks%s",
                place,
                n,
                self.fallbacks[place],
                f"; not kept: {lossy}" if lossy else "",
            )


def _dataset_defaults(conv: _Converter) -> None:
    rows = _rows(
        """
        SELECT l.id, l.type::text AS type, l.feature_layer_geometry_type::text AS geometry,
               l.data_type::text AS data_type, l.properties, l.data_snapshot, l.catalog_version
        FROM {S}.layer l
        WHERE l.type IN ('feature', 'raster')
          AND NOT EXISTS (SELECT 1 FROM {S}.layer_style s WHERE s.layer_id = l.id)
        """
    )
    items = []
    for r in rows:
        ctx = conv.context_for(r["type"], r["geometry"], r["data_type"])
        # No `properties` at all: a dataset the new release wrote (its rows went with
        # a downgrade). It gets the default style, as when it was created.
        document = (
            conv.default_style(ctx, seed=str(r["id"]))
            if r["properties"] is None
            else conv.convert(
                "dataset default",
                r["properties"],
                ctx,
                fingerprint=conv.layer_fingerprint(r),
                seed=str(r["id"]),
            ).document
        )
        items.append({"layer_id": str(r["id"]), "document": document})
    for batch in _batches(items):
        _exec(
            """
            INSERT INTO {S}.layer_style (layer_id, name, position, document, revision)
            SELECT (x->>'layer_id')::uuid, 'Default', 0, x->'document', 1
            FROM jsonb_array_elements(CAST(:rows AS jsonb)) x
            ON CONFLICT (layer_id) WHERE layer_id IS NOT NULL DO NOTHING
            """,
            rows=json.dumps(batch),
        )


def _project_layer_styles(conv: _Converter) -> None:
    rows = _rows(
        """
        SELECT lp.id, lp.layer_id, lp.properties, l.type::text AS type,
               l.feature_layer_geometry_type::text AS geometry, l.data_type::text AS data_type,
               l.data_snapshot, l.catalog_version
        FROM {S}.layer_project lp JOIN {S}.layer l ON l.id = lp.layer_id
        WHERE l.type IN ('feature', 'raster') AND lp.properties IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM {S}.layer_style s WHERE s.layer_project_id = lp.id)
        """
    )
    items = []
    for r in rows:
        m = conv.convert(
            "project layer",
            r["properties"],
            conv.context_for(r["type"], r["geometry"], r["data_type"]),
            fingerprint=conv.layer_fingerprint(r),
            seed=str(r["layer_id"]),
        )
        items.append(
            {
                "lp": r["id"],
                "document": m.document,
                "visible": m.map_state.get("visible"),
                "legend_expanded": m.map_state.get("legend_expanded"),
            }
        )
    for batch in _batches(items):
        # One statement: the style, its revision 1 row (a second tab's first save
        # merges against it) and the project layer's active style and map state.
        _exec(
            """
            WITH r AS (
                SELECT (x->>'lp')::int AS lp, x->'document' AS document,
                       CAST(x->>'visible' AS boolean) AS visible,
                       CAST(x->>'legend_expanded' AS boolean) AS legend_expanded
                FROM jsonb_array_elements(CAST(:rows AS jsonb)) x
            ),
            s AS (
                INSERT INTO {S}.layer_style (layer_project_id, name, position, document, revision)
                SELECT r.lp, 'Default', 0, r.document, 1 FROM r
                RETURNING id, layer_project_id, document
            ),
            v AS (
                INSERT INTO {S}.layer_style_revision (style_id, revision, document)
                SELECT id, 1, document FROM s
            )
            UPDATE {S}.layer_project lp
            SET active_style_id = s.id,
                visible = coalesce(r.visible, lp.visible),
                legend_expanded = coalesce(r.legend_expanded, lp.legend_expanded)
            FROM s JOIN r ON r.lp = s.layer_project_id
            WHERE lp.id = s.layer_project_id
            """,
            rows=json.dumps(batch),
        )


def _links_without_properties() -> None:
    """Project layers the new release wrote (no `properties`; their rows went with a
    downgrade) start again like any new project layer: a "Default" copied from the
    dataset default."""
    _exec(
        """
        WITH plan AS MATERIALIZED (
            SELECT gen_random_uuid() AS id, lp.id AS lp, d.document
            FROM {S}.layer_project lp JOIN {S}.layer_style d ON d.layer_id = lp.layer_id
            WHERE lp.properties IS NULL
              AND NOT EXISTS (SELECT 1 FROM {S}.layer_style s WHERE s.layer_project_id = lp.id)
        ),
        ins AS (
            INSERT INTO {S}.layer_style (id, layer_project_id, name, position, document, revision)
            SELECT id, lp, 'Default', 0, document, 1 FROM plan
            RETURNING id, document
        ),
        rev AS (
            INSERT INTO {S}.layer_style_revision (style_id, revision, document)
            SELECT id, 1, document FROM ins
        )
        UPDATE {S}.layer_project lp SET active_style_id = plan.id
        FROM plan WHERE lp.id = plan.lp
        """
    )


def _one_time_map_state() -> None:
    """Groups and table links: map state only, from `properties`, once."""
    _exec(
        """
        UPDATE {S}.layer_project_group
        SET visible = CASE WHEN jsonb_typeof(properties->'visibility') = 'boolean'
                           THEN (properties->>'visibility')::boolean ELSE visible END,
            expanded = CASE WHEN jsonb_typeof(properties->'expanded') = 'boolean'
                            THEN (properties->>'expanded')::boolean ELSE expanded END
        WHERE jsonb_typeof(properties) = 'object'
        """
    )
    _exec(
        """
        UPDATE {S}.layer_project lp
        SET visible = CASE WHEN jsonb_typeof(lp.properties->'visibility') = 'boolean'
                           THEN (lp.properties->>'visibility')::boolean ELSE lp.visible END,
            legend_expanded = CASE
                WHEN jsonb_typeof(lp.properties #> '{{legend,collapsed}}') = 'boolean'
                THEN NOT (lp.properties #>> '{{legend,collapsed}}')::boolean
                ELSE lp.legend_expanded END
        FROM {S}.layer l
        WHERE l.id = lp.layer_id AND l.type = 'table' AND jsonb_typeof(lp.properties) = 'object'
        """
    )


def _configs(conv: _Converter) -> None:
    """`outputStyle` (workflows, templates) and `locked_layer_styles` (layouts,
    templates) rewritten in place; the original config goes to the undo table."""
    exports = {
        (r["workflow_id"], r["node_id"]): (r["type"], r["geometry"], r["data_type"])
        for r in _rows(
            """
            SELECT l.other_properties->'workflow_export'->>'workflow_id' AS workflow_id,
                   l.other_properties->'workflow_export'->>'export_node_id' AS node_id,
                   l.type::text AS type, l.feature_layer_geometry_type::text AS geometry,
                   l.data_type::text AS data_type
            FROM {S}.layer l WHERE l.other_properties ? 'workflow_export'
            """
        )
    }
    links = {
        str(r["id"]): (r["type"], r["geometry"], r["data_type"])
        for r in _rows(
            """
            SELECT lp.id, l.type::text AS type, l.feature_layer_geometry_type::text AS geometry,
                   l.data_type::text AS data_type
            FROM {S}.layer_project lp JOIN {S}.layer l ON l.id = lp.layer_id
            """
        )
    }
    for table in CONFIG_TABLES:
        for row in _rows(
            f"SELECT id, config FROM {{S}}.{table} "
            "WHERE config::text LIKE '%outputStyle%' OR config::text LIKE '%locked_layer_styles%'"
        ):
            original = json.dumps(row["config"])
            config = json.loads(original)

            def export_layer(node_id: str | None, owner: str = str(row["id"])) -> Any:
                return exports.get((owner, node_id)) if table == "workflow" else None

            if not _rewrite(config, conv, table, export_layer, links):
                continue
            _exec(
                "INSERT INTO {S}.style_migration_undo (table_name, row_id, config) "
                "VALUES (:t, :r, CAST(:c AS jsonb)) ON CONFLICT DO NOTHING",
                t=table,
                r=str(row["id"]),
                c=original,
            )
            _exec(
                f"UPDATE {{S}}.{table} SET config = CAST(:c AS jsonb) WHERE id = :id",
                c=json.dumps(config),
                id=row["id"],
            )


def _rewrite(
    node: Any,
    conv: _Converter,
    place: str,
    export_layer: Callable[[str | None], Any],
    links: dict[str, Any],
    node_id: str | None = None,
) -> int:
    """Converts every version 0 `outputStyle` and `locked_layer_styles` value in
    `node` in place; returns how many. A value whose layer is unknown (an export
    not run yet, a link deleted since) stays version 0: guessing its geometry
    would freeze a wrong symbol, while finalize converts an `outputStyle` with the
    geometry of the layer it saves, and a locked style without its link draws
    nothing."""
    changed = 0
    if isinstance(node, list):
        for item in node:
            changed += _rewrite(item, conv, place, export_layer, links, node_id)
        return changed
    if not isinstance(node, dict):
        return 0
    if isinstance(node.get("id"), str):
        node_id = node["id"]
    for key, value in list(node.items()):
        if key == "outputStyle" and isinstance(value, dict) and "version" not in value:
            layer = export_layer(node_id)
            if layer is None:
                continue
            node[key] = conv.convert(
                f"{place} outputStyle",
                value,
                conv.context_for(*layer),
                fingerprint=None,
                seed=node_id,
            ).document
            changed += 1
        elif key == "locked_layer_styles" and isinstance(value, dict):
            for lp, style in list(value.items()):
                layer = links.get(lp)
                if isinstance(style, dict) and "version" not in style and layer:
                    value[lp] = conv.convert(
                        f"{place} locked style",
                        style,
                        conv.context_for(*layer),
                        fingerprint=None,
                        seed=lp,
                    ).document
                    changed += 1
        else:
            changed += _rewrite(value, conv, place, export_layer, links, node_id)
    return changed


def _published_snapshots(conv: _Converter) -> None:
    """Snapshots gain `map` and `styles` built from the snapshot itself (it holds
    what was published), with the live project layer's style id where the link
    still exists, so publishing's comparison reports no change."""
    from goatlib.style.map_rows import GroupRow, LayerRow, build_map_document

    active = {
        r["id"]: str(r["active_style_id"])
        for r in _rows(
            "SELECT id, active_style_id FROM {S}.layer_project WHERE active_style_id IS NOT NULL"
        )
    }
    snapshots = _rows(
        "SELECT id, config FROM {S}.project_public "
        "WHERE NOT (config ? 'map') AND jsonb_typeof(config->'layers') = 'array'"
    )
    layer_ids = {
        str(x.get("layer_id"))
        for s in snapshots
        for x in s["config"]["layers"]
        if isinstance(x, dict) and x.get("layer_id")
    }
    data = {
        str(r["id"]): r
        for r in _rows(
            "SELECT id, type::text AS type, data_snapshot, catalog_version FROM {S}.layer "
            "WHERE id = ANY(CAST(:ids AS uuid[]))",
            ids=sorted(layer_ids),
        )
    }
    for snapshot in snapshots:
        config = snapshot["config"]
        styles: dict[str, list[dict[str, Any]]] = {}
        layers: list[Any] = []
        for x in config["layers"]:
            if not isinstance(x, dict) or not isinstance(x.get("id"), int):
                continue
            lp, props = x["id"], x.get("properties")
            style_id = None
            visible = _flag(props, "visibility")
            collapsed = _flag(props, "legend", "collapsed")
            legend_expanded = None if collapsed is None else not collapsed
            if x.get("type") in ("feature", "raster"):
                layer = data.get(str(x.get("layer_id")))
                m = conv.convert(
                    "published map",
                    props,
                    conv.context_for(
                        x["type"],
                        x.get("feature_layer_geometry_type"),
                        x.get("data_type"),
                    ),
                    fingerprint=conv.layer_fingerprint(layer) if layer else None,
                    seed=str(x.get("layer_id")),
                )
                style_id = active.get(lp) or str(uuid4())
                visible = m.map_state.get("visible", visible)
                legend_expanded = m.map_state.get("legend_expanded", legend_expanded)
                styles[str(lp)] = [
                    {
                        "id": style_id,
                        "name": "Default",
                        "position": 0,
                        "revision": 1,
                        "document": m.document,
                        "issues": [],
                        "stale": False,
                    }
                ]
            layers.append(
                LayerRow(
                    id=lp,
                    group_id=x.get("layer_project_group_id"),
                    order=x.get("order") or 0,
                    visible=True if visible is None else visible,
                    position="top",
                    query=x.get("query"),
                    time_value=None,
                    legend_expanded=True
                    if legend_expanded is None
                    else legend_expanded,
                    style_id=style_id,
                )
            )
        groups = [
            GroupRow(
                id=g["id"],
                name=g.get("name") or "",
                parent_id=g.get("parent_id"),
                order=g.get("order") or 0,
                visible=_flag(g.get("properties"), "visibility") is not False,
                expanded=_flag(g.get("properties"), "expanded") is not False,
            )
            for g in config.get("layer_groups") or []
            if isinstance(g, dict) and isinstance(g.get("id"), int)
        ]
        project = (
            config.get("project") if isinstance(config.get("project"), dict) else {}
        )
        config["map"] = build_map_document(
            basemap=project.get("basemap"),
            locale=None,
            view_state=project.get("initial_view_state"),
            bounds=project.get("max_extent"),
            groups=groups,
            layers=layers,
        )
        config["styles"] = styles
        _exec(
            "UPDATE {S}.project_public SET config = CAST(:c AS jsonb) WHERE id = :id",
            c=json.dumps(config),
            id=snapshot["id"],
        )


def upgrade() -> None:
    from goatlib.style.fingerprint import advance_data_snapshots_sql

    h.add_column_if_missing(
        "layer_project_group",
        sa.Column(
            "expanded", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        S,
    )
    if not h.table_exists("style_migration_undo", S):
        op.create_table(
            "style_migration_undo",
            sa.Column("table_name", sa.Text(), primary_key=True, nullable=False),
            sa.Column("row_id", sa.Text(), primary_key=True, nullable=False),
            sa.Column("config", JSONB(), nullable=False),
            schema=S,
        )
    first_run = not _rows(
        "SELECT 1 FROM {S}.style_migration_undo WHERE table_name = :t AND row_id = :r",
        t=MARKER[0],
        r=MARKER[1],
    )
    lake = settings.DUCKLAKE_CATALOG_SCHEMA
    if _rows(
        "SELECT to_regclass(:n) IS NOT NULL AS ok",
        n=f"{lake}.ducklake_snapshot_changes",
    )[0]["ok"]:
        op.get_bind().execute(sa.text(advance_data_snapshots_sql(S, lake)))

    conv = _Converter()
    _dataset_defaults(conv)
    _project_layer_styles(conv)
    _links_without_properties()
    if first_run:
        _one_time_map_state()
    _configs(conv)
    _published_snapshots(conv)
    if first_run:
        _exec(
            "INSERT INTO {S}.style_migration_undo (table_name, row_id, config) "
            "VALUES (:t, :r, '{{}}'::jsonb) ON CONFLICT DO NOTHING",
            t=MARKER[0],
            r=MARKER[1],
        )
    conv.report()


def downgrade() -> None:
    if h.table_exists("style_migration_undo", S):
        for row in _rows(
            "SELECT table_name, row_id, config FROM {S}.style_migration_undo WHERE table_name = ANY(:t)",
            t=list(CONFIG_TABLES),
        ):
            _exec(
                f"UPDATE {{S}}.{row['table_name']} SET config = CAST(:c AS jsonb) WHERE id::text = :id",
                c=json.dumps(row["config"]),
                id=row["row_id"],
            )
        h.drop_table_if_present("style_migration_undo", S)
    if h.table_exists("layer_style", S):
        _exec("DELETE FROM {S}.layer_style")
    _exec(
        "UPDATE {S}.project_public SET config = config - 'map' - 'styles' WHERE config ? 'map'"
    )
    h.drop_column_if_present("layer_project_group", "expanded", S)
