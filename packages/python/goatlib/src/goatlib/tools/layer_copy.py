"""LayerCopy - give a project its own editable copy of a layer it shows.

Used by templates: a template dataset in "copy" mode is linked into the
project made from the template like a shipped one (the author's layer,
read-only for the user), and core then starts this job. It writes a new
layer owned by the user who ran it, in the project's folder:

* a new DuckLake table with every column of the source, and its rows, or
  none (``copy_content=False``, an empty layer to enter data into). Copied
  table to table, so the geometry column stays GEOMETRY even with no rows;
  a geometry that arrives as WKB BLOB (an empty catalog file, see
  ``project_import``) is turned back into GEOMETRY;
* a ``customer.layer`` row carrying the source's name, description, tags,
  geometry type, style (``properties``), column settings (``field_config``)
  and thumbnail, with a ``template_copy`` stamp naming the source. The
  source's catalog and workflow-output stamps are not carried: the copy is
  user data, not a catalog dataset or some workflow's result.

Then, in one transaction, the project entries named in ``layer_project_ids``
that still show the source are pointed at the copy (the entry keeps its id,
name, style, filters, popups and charts, so dashboards, layouts and legends
that name the entry follow along) and stamped ``template_copy``, and the
workflow dataset nodes reading those entries get the copy's id
(``retarget_dataset_nodes``). An entry pointed elsewhere in the meantime is
left alone.

Entries core started a copy for carry a ``template_copy`` stamp with
``status: pending``; the run sets it to ``done`` when it points them at the
copy, or to ``failed`` (with the error) when it fails, so the project can show
a copy that never arrived and offer to start it again. Dataset nodes that name
the source by ``layerId`` alone are retargeted too
(``retarget_unlinked_dataset_nodes``), as long as no other entry of the
project still shows the source.

Safe to run twice: runs for the same project and source wait for each other
(advisory lock), and an entry already stamped as showing a copy of this
source is not copied again; a second entry of the same source is pointed at
the existing copy. A failure before the transaction commits leaves every
entry on the source and removes the table it wrote.

v1 copies the source as it is when the job runs. A copy frozen when the
template was saved would be a layer of the template's own, passed here as
``source_layer_id``; nothing in this job would change.

Access: processes checks that the caller may read ``source_layer_id`` and
write ``project_id`` before the job runs; this job only checks that the
entries belong to that project.
"""

import json
import logging
import uuid
from pathlib import Path
from typing import Any, Self

import asyncpg
from pydantic import BaseModel, Field

from goatlib.io.bbox_columns import stray_bbox_columns
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import (
    BaseToolRunner,
    _catalog_layer_parquet,
    _get_or_create_event_loop,
    drops_unrecorded_tables,
)
from goatlib.tools.schemas import ToolInputBase
from goatlib.tools.workflow_dataset_nodes import (
    retarget_dataset_nodes,
    retarget_unlinked_dataset_nodes,
)
from goatlib.utils.layer import layer_schema_name

logger = logging.getLogger(__name__)

# The stamp on a copy and on the entries showing it.
COPY_STAMP = "template_copy"
# Source stamps a copy must not inherit: what they say is true of the source
# only (a catalog dataset's provenance and materialization state, the
# workflow run that produced it).
NOT_INHERITED = ("catalog_item", "catalog_materialize", "workflow_export")
# What an entry froze of a catalog source when it was added: the web reads a
# layer with these as a read-only catalog dataset. The entry's own
# `workflow_export` stamp stays: it names the workflow whose result the entry
# shows, and a re-run there overwrites the user's copy like any result.
CATALOG_LINK_KEYS = ("catalog_item", "catalog_materialize")
COPYABLE_TYPES = ("feature", "table")


class LayerCopyParams(ToolInputBase):
    """Parameters for copying a layer into a project as the user's own."""

    source_layer_id: str = Field(..., description="Layer to copy")
    project_id: str = Field(..., description="Project whose entries show the source")
    layer_project_ids: list[int] = Field(
        ...,
        min_length=1,
        description="Entries of the project to point at the copy",
    )
    copy_content: bool = Field(
        True, description="Copy the rows; False writes an empty layer"
    )
    template_id: str | None = Field(
        None, description="Template the copy is made for (recorded only)"
    )
    layer_name: str | None = Field(
        None,
        description="The entry's name, for the job list only (Copy: <name>)",
    )


class LayerCopyOutput(BaseModel):
    """What a copy run did. ``copied`` says whether this run wrote a new
    copy: it is False when an earlier run had already copied the source for
    these entries, or none of them still shows it, and ``layer_id`` is then
    that earlier copy, if any. ``layer_project_ids`` are the entries this
    run pointed at the copy (all of the requested ones when it found
    nothing to do)."""

    layer_id: str | None
    source_layer_id: str
    project_id: str
    layer_project_ids: list[int]
    copied: bool
    feature_count: int = 0
    geometry_type: str | None = None
    wm_labels: list[str] = []


class CopyPlan(BaseModel):
    """The state of the entries a run is asked to point at a copy."""

    pending: list[int]
    """Entries that still show the source."""
    existing_copy_id: str | None
    """A live copy of the source an entry already shows, from an earlier run."""
    source: dict[str, Any]
    folder_id: str
    space_id: str | None


class _NothingLeftError(Exception):
    """Every entry stopped showing the source while the copy was written."""


def copy_select_list(columns: list[tuple[Any, ...]], *, drop: set[str]) -> str:
    """The SELECT list that copies ``DESCRIBE`` rows ``columns``.

    Stray bounding-box copies (``goatlib.io.bbox_columns``) and the names in
    ``drop`` stay behind. A ``geometry`` column read as BLOB is WKB that lost
    its GeoParquet metadata (DuckDB writes none for an empty table), so it is
    turned back into GEOMETRY, as ``project_import`` does.
    """
    skipped = set(stray_bbox_columns(columns)) | drop
    parts: list[str] = []
    for col in columns:
        name = str(col[0])
        if name in skipped:
            continue
        quoted = '"' + name.replace('"', '""') + '"'
        if name == "geometry" and str(col[1]).upper() == "BLOB":
            parts.append(f"ST_GeomFromWKB({quoted}) AS {quoted}")
        else:
            parts.append(quoted)
    if not parts:
        raise ValueError("The source layer has no columns to copy")
    return ", ".join(parts)


def copy_other_properties(
    source_other_properties: Any, stamp: dict[str, Any]
) -> dict[str, Any]:
    """The copy's ``other_properties``: the source's, minus what is true of
    the source only, plus the ``template_copy`` stamp."""
    props = source_other_properties
    if isinstance(props, str):
        props = json.loads(props)
    copied = {
        key: value
        for key, value in (props if isinstance(props, dict) else {}).items()
        if key not in NOT_INHERITED and key != COPY_STAMP
    }
    copied[COPY_STAMP] = stamp
    return copied


async def load_copy_plan(
    conn: Any,
    schema: str,
    *,
    project_id: str,
    source_layer_id: str,
    link_ids: list[int],
) -> CopyPlan:
    """Read what a run has to do. Raises ``ValueError`` for a request that
    can never succeed: an entry that is not in the project, a project or
    source that is gone, or a source with no table to copy."""
    rows = await conn.fetch(
        f"""
        SELECT lp.id, lp.layer_id::text AS layer_id,
               lp.other_properties -> '{COPY_STAMP}' ->> 'source_layer_id'
                   AS copied_from,
               l.deleted_at IS NULL AS layer_live
        FROM {schema}.layer_project lp
        JOIN {schema}.layer l ON l.id = lp.layer_id
        WHERE lp.project_id = $1 AND lp.id = ANY($2::int[])
        """,
        uuid.UUID(project_id),
        link_ids,
    )
    found = {row["id"] for row in rows}
    missing = sorted(set(link_ids) - found)
    if missing:
        raise ValueError(f"Project entries {missing} are not in project {project_id}")

    source = await conn.fetchrow(
        f"""
        SELECT id::text AS id, type, data_type, deleted_at,
               feature_layer_geometry_type, size, other_properties
        FROM {schema}.layer WHERE id = $1
        """,
        uuid.UUID(source_layer_id),
    )
    if source is None or source["deleted_at"] is not None:
        raise ValueError(f"Layer {source_layer_id} does not exist")
    if source["type"] not in COPYABLE_TYPES or source["data_type"] is not None:
        raise ValueError(f"Layer {source_layer_id} has no table to copy")

    project = await conn.fetchrow(
        f"""
        SELECT p.folder_id::text AS folder_id,
               COALESCE(f.space_id, p.space_id)::text AS space_id
        FROM {schema}.project p
        LEFT JOIN {schema}.folder f ON f.id = p.folder_id
        WHERE p.id = $1 AND p.deleted_at IS NULL
        """,
        uuid.UUID(project_id),
    )
    if project is None or project["folder_id"] is None:
        raise ValueError(f"Project {project_id} does not exist")

    pending = sorted(row["id"] for row in rows if row["layer_id"] == source_layer_id)
    existing = next(
        (
            row["layer_id"]
            for row in sorted(rows, key=lambda r: r["id"])
            if row["layer_id"] != source_layer_id
            and row["copied_from"] == source_layer_id
            and row["layer_live"]
        ),
        None,
    )
    return CopyPlan(
        pending=pending,
        existing_copy_id=existing,
        source=dict(source),
        folder_id=project["folder_id"],
        space_id=project["space_id"],
    )


async def insert_copy_layer(
    conn: Any,
    schema: str,
    *,
    source_layer_id: str,
    layer_id: str,
    user_id: str,
    folder_id: str,
    space_id: str | None,
    other_properties: dict[str, Any],
    copy_content: bool,
    extent_wkt: str | None,
    size: int,
    job_id: str | None,
) -> None:
    """Write the copy's ``customer.layer`` row from the source's own row:
    owned by ``user_id`` in the project's folder and space, everything that
    describes the data taken over, never the source's sharing (``public``,
    ``restricted``, grants) or catalog identity. The source's default style
    comes along; entries pointed at the copy keep their own styles."""
    status = await conn.execute(
        f"""
        INSERT INTO {schema}.layer (
            id, user_id, folder_id, space_id, name, description, type,
            feature_layer_type, feature_layer_geometry_type, extent,
            other_properties, field_config, tags, thumbnail_url,
            size, tool_type, job_id, created_at, updated_at
        )
        SELECT $1, $2, $3, $4, src.name, src.description, src.type,
               src.feature_layer_type, src.feature_layer_geometry_type,
               CASE
                   WHEN $6::text IS NOT NULL
                       THEN ST_Multi(ST_GeomFromText($6::text, 4326))
                   WHEN $7 THEN src.extent
               END,
               $8::jsonb,
               COALESCE(src.field_config, '{{}}'::jsonb), src.tags,
               src.thumbnail_url, $9, src.tool_type, $10, NOW(), NOW()
        FROM {schema}.layer src
        WHERE src.id = $5
        """,
        uuid.UUID(layer_id),
        uuid.UUID(user_id),
        uuid.UUID(folder_id),
        uuid.UUID(space_id) if space_id else None,
        uuid.UUID(source_layer_id),
        extent_wkt,
        copy_content,
        json.dumps(other_properties),
        size,
        uuid.UUID(job_id) if job_id else None,
    )
    if status != "INSERT 0 1":
        raise ValueError(f"Layer {source_layer_id} disappeared during the copy")
    await conn.execute(
        f"""
        INSERT INTO {schema}.layer_style (layer_id, name, document)
        SELECT $1, name, document FROM {schema}.layer_style WHERE layer_id = $2
        """,
        uuid.UUID(layer_id),
        uuid.UUID(source_layer_id),
    )


async def point_links_at_copy(
    conn: Any,
    schema: str,
    *,
    project_id: str,
    link_ids: list[int],
    source_layer_id: str,
    layer_id: str,
    stamp: dict[str, Any],
) -> list[int]:
    """Point the entries that still show the source at the copy, stamp them,
    and retarget the dataset nodes reading them. Returns the entries
    changed. Run it inside the caller's transaction.

    An entry of a catalog source drops the catalog keys it froze when it was
    added (``CATALOG_LINK_KEYS``), or the copy would read as a read-only
    catalog dataset.

    The entries become ``shareable``: the copy is the user's own layer, so the
    project's other members may read it through them. An entry added for a
    user without ``share`` on the source was not, and would keep hiding the
    copy from everyone the project is shared with."""
    rows = await conn.fetch(
        f"""
        UPDATE {schema}.layer_project
        SET layer_id = $3,
            shareable = TRUE,
            other_properties = ((
                CASE WHEN jsonb_typeof(other_properties) = 'object'
                     THEN other_properties ELSE '{{}}'::jsonb END
            ) - $6::text[]) || jsonb_build_object('{COPY_STAMP}', $4::jsonb),
            updated_at = NOW()
        WHERE project_id = $1 AND id = ANY($2::int[]) AND layer_id = $5
        RETURNING id
        """,
        uuid.UUID(project_id),
        link_ids,
        uuid.UUID(layer_id),
        json.dumps(stamp),
        uuid.UUID(source_layer_id),
        list(CATALOG_LINK_KEYS),
    )
    changed = sorted(row["id"] for row in rows)
    for link_id in changed:
        await retarget_dataset_nodes(
            conn, schema, project_id=project_id, link_id=link_id, layer_id=layer_id
        )
    if changed:
        # Nodes that name the source by `layerId` alone (no entry recorded).
        await retarget_unlinked_dataset_nodes(
            conn,
            schema,
            project_id=project_id,
            source_layer_id=source_layer_id,
            layer_id=layer_id,
            link_id=changed[0],
        )
    return changed


async def mark_copy_failed(
    conn: Any,
    schema: str,
    *,
    project_id: str,
    link_ids: list[int],
    source_layer_id: str,
    error: str,
) -> None:
    """Record on the entries still waiting for this copy that it failed, so
    the project can say so and offer to start it again. Only entries that
    still show the source and carry a ``template_copy`` stamp naming it
    (written by core when it started the copy) are touched."""
    await conn.execute(
        f"""
        UPDATE {schema}.layer_project
        SET other_properties = jsonb_set(
                other_properties,
                '{{{COPY_STAMP}}}',
                (other_properties -> '{COPY_STAMP}')
                    || jsonb_build_object('status', 'failed', 'error', $4::text)
            ),
            updated_at = NOW()
        WHERE project_id = $1 AND id = ANY($2::int[]) AND layer_id = $3
          AND jsonb_typeof(other_properties -> '{COPY_STAMP}') = 'object'
          AND other_properties -> '{COPY_STAMP}' ->> 'source_layer_id' = $3::text
        """,
        uuid.UUID(project_id),
        link_ids,
        uuid.UUID(source_layer_id),
        error[:500],
    )


class LayerCopyRunner(BaseToolRunner[LayerCopyParams]):
    """Runner for ``layer_copy``: overrides ``run`` like ``finalize_layer``,
    since the copy replaces a layer behind existing project entries instead
    of adding a new one."""

    tool_class = "layer_copy"
    output_geometry_type: str | None = None
    default_output_name = "Copy"

    def process(
        self: Self, params: LayerCopyParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        raise NotImplementedError("layer_copy runs through run()")

    async def _connect(self: Self) -> asyncpg.Connection:
        """A dedicated connection: the run's lock and its writes share one
        transaction."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        return await asyncpg.connect(
            **self.settings.postgres_connect_args(),
        )

    def _copy_table(
        self: Self, source_layer_id: str, layer_id: str, copy_content: bool
    ) -> dict[str, Any]:
        """Write the copy's DuckLake table; returns ``_get_table_info``'s
        description of it."""
        con = self.duckdb_con
        source = self.resolve_layer_table_path(source_layer_id)
        target = self.get_layer_table_path(layer_id)
        con.execute(f"CREATE SCHEMA IF NOT EXISTS lake.{layer_schema_name()}")
        columns = con.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()
        # A catalog dataset is read through a view that adds `rowid`; a
        # table has its own.
        drop = {"rowid"} if _catalog_layer_parquet(source_layer_id) else set()
        select_list = copy_select_list(columns, drop=drop)
        limit = "" if copy_content else " LIMIT 0"
        con.execute(
            f"CREATE TABLE {target} AS SELECT {select_list} FROM {source}{limit}"
        )
        info = self._get_table_info(con, target)
        info["table_name"] = target
        logger.info(
            "Copied %s to %s (%s rows)", source, target, info.get("feature_count")
        )
        return info

    def _drop_table(self: Self, layer_id: str) -> None:
        """Drop the copy this run wrote, unless its layer row exists after
        all (a commit whose reply was lost). Never raises."""
        self._drop_new_tables([layer_id])

    async def _mark_failed(
        self: Self,
        conn: Any,
        schema: str,
        params: LayerCopyParams,
        link_ids: list[int],
        exc: Exception,
    ) -> None:
        """Best effort: the run already failed, so a failure here is only
        logged."""
        try:
            await mark_copy_failed(
                conn,
                schema,
                project_id=params.project_id,
                link_ids=link_ids,
                source_layer_id=params.source_layer_id,
                error=str(exc) or type(exc).__name__,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "Could not mark the copy of %s failed", params.source_layer_id
            )

    async def copy(self: Self, params: LayerCopyParams) -> LayerCopyOutput:
        """Copy the source and point the entries at it (see the module)."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        schema = self.settings.customer_schema
        wm_labels = [params.triggered_by_email] if params.triggered_by_email else []
        link_ids = sorted(set(params.layer_project_ids))
        output = LayerCopyOutput(
            layer_id=None,
            source_layer_id=params.source_layer_id,
            project_id=params.project_id,
            layer_project_ids=link_ids,
            copied=False,
            wm_labels=wm_labels,
        )
        stamp = {
            "source_layer_id": params.source_layer_id,
            "template_id": params.template_id,
            "copy_content": params.copy_content,
        }
        # The entries say the copy is done; the copy itself needs no status.
        link_stamp = {**stamp, "status": "done"}

        conn = await self._connect()
        written: str | None = None
        geometry_column = "geometry"
        try:
            try:
                async with conn.transaction():
                    await conn.execute(
                        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                        f"layer_copy:{params.project_id}:{params.source_layer_id}",
                    )
                    plan = await load_copy_plan(
                        conn,
                        schema,
                        project_id=params.project_id,
                        source_layer_id=params.source_layer_id,
                        link_ids=link_ids,
                    )
                    if not plan.pending:
                        output.layer_id = plan.existing_copy_id
                        return output
                    if plan.existing_copy_id is not None:
                        # An earlier run copied the source for another of
                        # these entries: this one shows that copy too.
                        copy_id = plan.existing_copy_id
                    else:
                        copy_id = str(uuid.uuid4())
                        # Set first: a table half-written still gets dropped.
                        written = copy_id
                        self._track_new_table(
                            copy_id, self.get_layer_table_path(copy_id)
                        )
                        info = self._copy_table(
                            params.source_layer_id, copy_id, params.copy_content
                        )
                        geometry_column = info.get("geometry_column") or "geometry"
                        output.feature_count = int(info.get("feature_count") or 0)
                        output.geometry_type = plan.source.get(
                            "feature_layer_geometry_type"
                        )
                        await insert_copy_layer(
                            conn,
                            schema,
                            source_layer_id=params.source_layer_id,
                            layer_id=copy_id,
                            user_id=params.user_id,
                            folder_id=plan.folder_id,
                            space_id=plan.space_id,
                            other_properties=copy_other_properties(
                                plan.source.get("other_properties"), stamp
                            ),
                            copy_content=params.copy_content,
                            extent_wkt=info.get("extent_wkt")
                            if params.copy_content
                            else None,
                            size=int(plan.source.get("size") or 0)
                            if params.copy_content
                            else 0,
                            job_id=self.get_job_id(),
                        )
                    changed = await point_links_at_copy(
                        conn,
                        schema,
                        project_id=params.project_id,
                        link_ids=plan.pending,
                        source_layer_id=params.source_layer_id,
                        layer_id=copy_id,
                        stamp=link_stamp,
                    )
                    if not changed:
                        raise _NothingLeftError
                    output.layer_id = copy_id
                    output.layer_project_ids = changed
                    output.copied = written is not None
            except _NothingLeftError:
                # Rolled back: nobody would see the copy.
                if written is not None:
                    self._drop_table(written)
                    written = None
                return output
            except Exception as exc:
                if written is not None:
                    self._drop_table(written)
                await self._mark_failed(conn, schema, params, link_ids, exc)
                raise
        finally:
            await conn.close()

        if written is not None and output.geometry_type and output.feature_count:
            # Non-fatal: geoapi serves the layer's tiles without them.
            self._generate_pmtiles(
                user_id=params.user_id,
                layer_id=written,
                table_name=self.get_layer_table_path(written),
                geometry_column=geometry_column,
            )
        return output

    @drops_unrecorded_tables
    def run(self: Self, params: LayerCopyParams) -> dict[str, Any]:
        output = _get_or_create_event_loop().run_until_complete(self.copy(params))
        return output.model_dump()


def main(params: LayerCopyParams) -> dict[str, Any]:
    """Windmill entry point for LayerCopy."""
    runner = LayerCopyRunner()
    runner.init_from_env()
    try:
        return runner.run(params)
    finally:
        runner.cleanup()
