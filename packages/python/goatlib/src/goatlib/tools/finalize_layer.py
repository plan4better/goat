"""Finalize Layer Tool - Persists temporary workflow results to permanent storage.

This tool is called when a user clicks "Save" on a workflow result.
It takes a temp layer (stored in /data/temporary/) and:
1. Ingests the data into DuckLake
2. Creates a layer record in PostgreSQL
3. Generates PMTiles for fast serving
4. Cleans up the temp files

**Overwrite on re-run**: if ``overwrite_previous`` is set and ``export_node_id``
is provided, ``goatlib.tools.workflow_export_target`` finds the project entry
that shows this export node's previous result. The workflow's own result is
replaced in place, whoever runs it, preserving the layer_id, project entries,
and any user-customized style/tags. A layer shared with a project copy or
template (inherited from it, or still shown by it) gets a new layer behind the
same entry instead, so copies and their source never change each other's
results; the new layer keeps the description, tags and column settings of the
one it replaces. Identity is tracked entirely backend-side so workflows can run
without the browser (long runs, remote triggers).

Every run is authorized first: the runner must be able to write the project,
and the workflow must belong to it.

This runs as a Windmill job like other tools.
"""

import json
import logging
import shutil
import uuid
from pathlib import Path
from typing import Any, Literal

import asyncpg
from pydantic import BaseModel, Field

from goatlib.tools.authz import authorize_workflow_export
from goatlib.tools.base import BaseToolRunner, _get_or_create_event_loop
from goatlib.tools.layer_replace import LayerReplaceMixin
from goatlib.tools.schemas import ToolInputBase
from goatlib.tools.workflow_dataset_nodes import retarget_dataset_nodes
from goatlib.tools.workflow_export_target import (
    ExportTarget,
    claim_link,
    export_lock,
    resolve_export_target,
    restamp_layer,
)
from goatlib.utils.layer import (
    layer_schema_name,
    table_path_parts,
)

logger = logging.getLogger(__name__)


# Temp data root
TEMP_DATA_ROOT = Path("/app/data/temporary")


class FinalizeLayerParams(ToolInputBase):
    """Parameters for the finalize layer tool."""

    workflow_id: str = Field(..., description="Workflow UUID")
    node_id: str = Field(..., description="Node ID within the workflow")
    project_id: str = Field(..., description="Project UUID to add the layer to")
    layer_name: str | None = Field(
        default=None,
        description="Optional name override for the layer",
    )
    delete_temp: bool = Field(
        default=False,
        description="Whether to delete temp files after finalization. "
        "Default False to keep files available for frontend preview. "
        "Cleanup happens at the start of the next workflow execution.",
    )
    properties: dict[str, Any] | None = Field(
        default=None,
        description="Layer style properties from the source tool. "
        "If None, properties are read from metadata.json or defaults are used.",
    )
    overwrite_previous: bool = Field(
        default=False,
        description="If True, replace the result a previous run of this "
        "export node left in the project, whoever ran it: in place when this "
        "workflow produced it, or with a new layer behind the same project "
        "entry when the layer is shared with a project copy or template. "
        "Creates a new layer when the project shows no previous result.",
    )
    export_node_id: str | None = Field(
        default=None,
        description="Workflow export node ID. Used to look up and stamp the "
        "resulting layer so subsequent runs with overwrite_previous=True "
        "can find it.",
    )


class FinalizeLayerOutput(BaseModel):
    """Output from the finalize layer tool.

    Note: This doesn't extend ToolOutputBase because this tool doesn't create
    a layer in the normal way - it moves an existing temp layer to permanent storage.
    """

    layer_id: str = Field(..., description="Permanent layer UUID (new or updated)")
    layer_name: str = Field(..., description="Layer name")
    project_id: str = Field(..., description="Project the layer was added to")
    layer_project_id: int = Field(..., description="Layer-project association ID")
    feature_count: int = Field(default=0, description="Number of features")
    geometry_type: str | None = Field(default=None, description="Geometry type")
    overwritten: bool = Field(
        default=False,
        description="True if an existing layer was replaced in place",
    )


class FinalizeLayerRunner(LayerReplaceMixin, BaseToolRunner[FinalizeLayerParams]):
    """Tool runner for finalizing temporary layers."""

    tool_class: Literal["finalize_layer"] = "finalize_layer"
    output_geometry_type: str | None = None
    default_output_name: str = "Finalized Layer"

    def get_temp_base_path(self, user_id: str, workflow_id: str, node_id: str) -> Path:
        """Get the base path for a temp layer with prefixes."""
        user_id_clean = user_id.replace("-", "")
        workflow_id_clean = workflow_id.replace("-", "") if workflow_id else workflow_id
        # Use prefixed paths: user_{uuid}/w_{uuid}/n_{uuid}/
        return (
            TEMP_DATA_ROOT
            / f"user_{user_id_clean}"
            / f"w_{workflow_id_clean}"
            / f"n_{node_id}"
        )

    def _resolve_temp_parquet(
        self, user_id: str, workflow_id: str, node_id: str
    ) -> tuple[Path, Path, dict]:
        """Locate the temp parquet + metadata for this node.

        Returns (base_path, parquet_path, metadata_dict).
        """
        base_path = self.get_temp_base_path(user_id, workflow_id, node_id)
        metadata_path = base_path / "metadata.json"

        parquet_files = list(base_path.glob("t_*.parquet"))
        if not parquet_files:
            raise FileNotFoundError(
                f"Temp layer not found: workflow={workflow_id}, node={node_id}"
            )
        parquet_path = max(parquet_files, key=lambda p: p.stat().st_mtime)

        metadata: dict = {}
        if metadata_path.exists():
            try:
                metadata = json.loads(metadata_path.read_text())
            except Exception as e:
                logger.warning(f"Failed to read temp metadata: {e}")

        return base_path, parquet_path, metadata

    async def _authorize(self, params: FinalizeLayerParams) -> None:
        """Refuse unless the runner may write the project and the workflow is
        that project's (see ``authorize_workflow_export``)."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        from goatlib.tools.db import ToolDatabaseService

        pool = await self.get_postgres_pool()
        try:
            await authorize_workflow_export(
                ToolDatabaseService(pool, schema=self.settings.customer_schema),
                user_id=str(params.user_id),
                project_id=params.project_id,
                workflow_id=params.workflow_id,
            )
        finally:
            await pool.close()

    async def _resolve_target(self, params: FinalizeLayerParams) -> ExportTarget | None:
        """Where this export node's result goes. Read on its own connection:
        the lock's transaction lasts the whole export, and reads inside it
        would hold their table locks that long."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        assert params.user_id is not None and params.export_node_id is not None
        pool = await self.get_postgres_pool()
        try:
            target: ExportTarget | None = await resolve_export_target(
                pool,
                self.settings.customer_schema,
                user_id=params.user_id,
                project_id=params.project_id,
                workflow_id=params.workflow_id,
                export_node_id=params.export_node_id,
            )
            return target
        finally:
            await pool.close()

    async def _connect(self) -> asyncpg.Connection:
        """A dedicated connection for the export lock held across the write.
        Its transaction takes nothing but the advisory lock."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        return await asyncpg.connect(
            host=self.settings.postgres_server,
            port=self.settings.postgres_port,
            user=self.settings.postgres_user,
            password=self.settings.postgres_password,
            database=self.settings.postgres_db,
        )

    async def _claim(
        self, params: FinalizeLayerParams, *, link_id: int, layer_id: str
    ) -> None:
        """Point the project entry at the layer and stamp it as this export
        node's result."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        assert params.export_node_id is not None
        pool = await self.get_postgres_pool()
        try:
            await claim_link(
                pool,
                self.settings.customer_schema,
                project_id=params.project_id,
                link_id=link_id,
                layer_id=layer_id,
                workflow_id=params.workflow_id,
                export_node_id=params.export_node_id,
            )
        finally:
            await pool.close()

    async def _restamp(self, params: FinalizeLayerParams, layer_id: str) -> None:
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        assert params.export_node_id is not None
        pool = await self.get_postgres_pool()
        try:
            await restamp_layer(
                pool,
                self.settings.customer_schema,
                layer_id=layer_id,
                workflow_id=params.workflow_id,
                export_node_id=params.export_node_id,
            )
        finally:
            await pool.close()

    def _overwrite_in_place(
        self,
        params: FinalizeLayerParams,
        parquet_path: Path,
        target: ExportTarget,
    ) -> str:
        """Replace the target layer's data, keeping its id, style, tags and
        project entries.

        No ownership check: the target is this workflow's result (or one it
        took over), and the runner was authorized to write the project — a
        workflow's result belongs to the workflow, not to whoever ran it last.
        """
        assert params.user_id is not None
        user_id = params.user_id
        layer_id: str = target.layer_id
        loop = _get_or_create_event_loop()

        layer_info = loop.run_until_complete(
            self._get_layer_full_info(layer_id, user_id, require_owner=False)
        )

        table_info = self._replace_ducklake_table(
            layer_id=layer_id,
            owner_id=user_id,
            parquet_path=parquet_path,
        )

        self._delete_old_pmtiles(user_id=user_id, layer_id=layer_id)

        existing_table = self.resolve_layer_table_path(layer_id)
        snapshot_id = self._get_ducklake_snapshot_id(*table_path_parts(existing_table))

        self._regenerate_pmtiles(
            user_id=user_id,
            layer_id=layer_id,
            table_info=table_info,
            snapshot_id=snapshot_id,
        )

        loop.run_until_complete(
            self._update_layer_metadata(
                layer_id=layer_id,
                feature_count=table_info.get("feature_count", 0),
                extent_wkt=table_info.get("extent_wkt"),
                size=table_info.get("size", 0),
                geometry_type=table_info.get("geometry_type"),
            )
        )
        if target.mode == "adopt":
            loop.run_until_complete(self._restamp(params, layer_id))

        loop.run_until_complete(
            self._sync_name_and_get_link(
                layer_id=layer_id,
                project_id=params.project_id,
                new_name=params.layer_name,
            )
        )

        name = params.layer_name or layer_info["name"]
        link_id = target.link_id
        if link_id is None:
            link_id = loop.run_until_complete(
                self._get_or_create_project_link(
                    layer_id=layer_id,
                    project_id=params.project_id,
                    name=name,
                )
            )
        loop.run_until_complete(self._claim(params, link_id=link_id, layer_id=layer_id))

        from goatlib.tools.db import normalize_geometry_type

        self._output_info = FinalizeLayerOutput(
            layer_id=layer_id,
            layer_name=name,
            project_id=params.project_id,
            layer_project_id=link_id,
            feature_count=table_info.get("feature_count", 0),
            geometry_type=normalize_geometry_type(table_info.get("geometry_type")),
            overwritten=True,
        )
        return layer_id

    async def _sync_name_and_get_link(
        self,
        layer_id: str,
        project_id: str,
        new_name: str | None,
    ) -> None:
        """Sync the layer name to the new name (if provided) on both the
        customer.layer record and the layer_project link for this project.
        """
        if not new_name:
            return
        if self.settings is None:
            raise RuntimeError("Settings not initialized")

        import uuid as uuid_module

        schema = self.settings.customer_schema
        pool = await self.get_postgres_pool()
        try:
            await pool.execute(
                f"""
                UPDATE {schema}.layer
                SET name = $2, updated_at = NOW()
                WHERE id = $1
                """,
                uuid_module.UUID(layer_id),
                new_name,
            )
            await pool.execute(
                f"""
                UPDATE {schema}.layer_project
                SET name = $3, updated_at = NOW()
                WHERE layer_id = $1 AND project_id = $2
                """,
                uuid_module.UUID(layer_id),
                uuid_module.UUID(project_id),
                new_name,
            )
        finally:
            await pool.close()

    async def _get_or_create_project_link(
        self,
        layer_id: str,
        project_id: str,
        name: str,
    ) -> int:
        """Return the layer_project link id, creating one if it doesn't exist.

        If the user previously removed the layer from this project, the
        overwrite re-attaches it. Project ownership is NOT checked here — in
        the future workflows will be runnable by users other than the project
        owner, and this helper must stay compatible with that.
        """
        if self.settings is None:
            raise RuntimeError("Settings not initialized")

        import uuid as uuid_module

        schema = self.settings.customer_schema
        pool = await self.get_postgres_pool()
        try:
            row = await pool.fetchrow(
                f"""
                SELECT id FROM {schema}.layer_project
                WHERE layer_id = $1 AND project_id = $2
                """,
                uuid_module.UUID(layer_id),
                uuid_module.UUID(project_id),
            )
            if row:
                return int(row["id"])

            inserted = await pool.fetchrow(
                f"""
                INSERT INTO {schema}.layer_project (
                    layer_id, project_id, name, "order",
                    created_at, updated_at
                )
                VALUES ($1, $2, $3, 0, NOW(), NOW())
                RETURNING id
                """,
                uuid_module.UUID(layer_id),
                uuid_module.UUID(project_id),
                name,
            )
            if inserted is None:
                raise RuntimeError(
                    f"Failed to link layer {layer_id} to project {project_id}"
                )
            link_id = int(inserted["id"])

            await pool.execute(
                f"""
                UPDATE {schema}.project
                SET layer_order = array_prepend($1, COALESCE(layer_order, ARRAY[]::int[])),
                    updated_at = NOW()
                WHERE id = $2
                """,
                link_id,
                uuid_module.UUID(project_id),
            )
            return link_id
        finally:
            await pool.close()

    def process(self, params: FinalizeLayerParams) -> str:
        """Finalize a temporary layer to permanent storage.

        Returns the layer_id that ended up receiving the data (either a newly
        created UUID or the existing layer that was replaced in place).
        """
        if params.user_id is None:
            raise ValueError("user_id is required for finalize_layer")

        base_path, parquet_path, metadata = self._resolve_temp_parquet(
            params.user_id, params.workflow_id, params.node_id
        )

        loop = _get_or_create_event_loop()
        loop.run_until_complete(self._authorize(params))

        if params.overwrite_previous and params.export_node_id:
            layer_id = self._export_with_overwrite(params, parquet_path, metadata)
        else:
            layer_id = self._create_new_layer(
                params=params,
                parquet_path=parquet_path,
                metadata=metadata,
            )

        if params.delete_temp:
            self._delete_temp(base_path)

        return layer_id

    def _export_with_overwrite(
        self,
        params: FinalizeLayerParams,
        parquet_path: Path,
        metadata: dict,
    ) -> str:
        """Resolve the export node's target and write it, holding the export
        lock so a concurrent run of the same node waits instead of racing."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        assert params.user_id is not None and params.export_node_id is not None

        loop = _get_or_create_event_loop()
        conn = loop.run_until_complete(self._connect())
        try:
            lock = export_lock(
                conn,
                workflow_id=params.workflow_id,
                export_node_id=params.export_node_id,
            )
            loop.run_until_complete(lock.__aenter__())
            try:
                target = loop.run_until_complete(self._resolve_target(params))
                logger.info(
                    "Export node %s of workflow %s writes to %s",
                    params.export_node_id,
                    params.workflow_id,
                    target or "a new layer",
                )
                if target is None:
                    layer_id = self._create_new_layer(params, parquet_path, metadata)
                elif target.mode == "copy_on_write":
                    layer_id = self._create_new_layer(
                        params,
                        parquet_path,
                        metadata,
                        claim_link_id=target.link_id,
                    )
                else:
                    layer_id = self._overwrite_in_place(params, parquet_path, target)
            except BaseException as exc:
                loop.run_until_complete(
                    lock.__aexit__(type(exc), exc, exc.__traceback__)
                )
                raise
            loop.run_until_complete(lock.__aexit__(None, None, None))
            return layer_id
        finally:
            loop.run_until_complete(conn.close())

    def _delete_temp(self, base_path: Path) -> None:
        try:
            shutil.rmtree(base_path)
            logger.info(f"Deleted temp files: {base_path}")
        except Exception as e:
            logger.warning(f"Failed to delete temp files: {e}")

    def _create_new_layer(
        self,
        params: FinalizeLayerParams,
        parquet_path: Path,
        metadata: dict,
        claim_link_id: int | None = None,
    ) -> str:
        """Create a brand-new layer record.

        With ``claim_link_id`` the layer replaces the one behind that project
        entry (copy-on-write for an output the workflow inherited): the entry
        keeps its id and settings and the old layer is left to whoever else
        uses it. Otherwise the layer is added to the project.
        """
        user_id = params.user_id  # type: ignore[assignment]
        assert user_id is not None  # guarded by caller

        layer_name = params.layer_name or metadata.get("layer_name", "Workflow Result")
        new_layer_id = str(uuid.uuid4())

        con = self.duckdb_con
        table_name = self.get_layer_table_path(new_layer_id)
        schema = layer_schema_name()

        con.execute(f"CREATE SCHEMA IF NOT EXISTS lake.{schema}")

        cols = con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{parquet_path}')"
        ).fetchall()
        geom_col = None
        for col_name, col_type, *_ in cols:
            if "GEOMETRY" in col_type.upper():
                geom_col = col_name
                break

        if geom_col:
            con.execute(f"""
                CREATE TABLE {table_name} AS
                SELECT * FROM read_parquet('{parquet_path}')
                ORDER BY ST_Hilbert({geom_col})
            """)
        else:
            con.execute(f"""
                CREATE TABLE {table_name} AS
                SELECT * FROM read_parquet('{parquet_path}')
            """)

        logger.info(f"Ingested temp layer to DuckLake: {table_name}")

        count_result = con.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
        feature_count = count_result[0] if count_result else 0

        geometry_type = metadata.get("geometry_type")
        bbox = metadata.get("bbox")
        extent_wkt = None
        if bbox and len(bbox) == 4:
            extent_wkt = (
                f"POLYGON(({bbox[0]} {bbox[1]}, {bbox[2]} {bbox[1]}, "
                f"{bbox[2]} {bbox[3]}, {bbox[0]} {bbox[3]}, "
                f"{bbox[0]} {bbox[1]}))"
            )

        snapshot_id = self._get_ducklake_snapshot_id(
            schema, f"t_{new_layer_id.replace('-', '')}"
        )

        if (
            geometry_type
            and self.settings is not None
            and self.settings.pmtiles_enabled
        ):
            try:
                from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator

                generator = PMTilesGenerator(
                    tiles_data_dir=self.settings.tiles_data_dir,
                    config=PMTilesConfig(
                        enabled=True,
                        max_zoom=self.settings.pmtiles_max_zoom,
                    ),
                )
                generator.generate_from_table(
                    duckdb_con=con,
                    table_name=table_name,
                    layer_id=new_layer_id,
                    geometry_column=geom_col or "geometry",
                    snapshot_id=snapshot_id,
                )
                logger.info(f"Generated PMTiles for finalized layer: {new_layer_id}")
            except Exception as e:
                logger.warning(f"PMTiles generation failed (non-fatal): {e}")

        assert self.settings is not None
        schema = self.settings.customer_schema
        # The workflow + export node that produced the data; the project entry
        # showing it carries the same stamp (see workflow_export_target).
        stamp: dict[str, Any] | None = None
        if params.export_node_id:
            stamp = {
                "workflow_export": {
                    "workflow_id": params.workflow_id,
                    "export_node_id": params.export_node_id,
                }
            }

        async def create_layer_record(db_service: Any) -> dict[str, Any] | None:
            folder_id = await db_service.get_project_folder_id(params.project_id)
            if not folder_id:
                raise ValueError(
                    f"Could not find folder for project {params.project_id}"
                )
            is_feature = bool(geometry_type)
            properties: dict[str, Any] | None = await db_service.create_layer(
                layer_id=new_layer_id,
                user_id=user_id,
                folder_id=folder_id,
                name=layer_name,
                layer_type="feature" if is_feature else "table",
                feature_layer_type="tool" if is_feature else None,
                geometry_type=geometry_type,
                extent_wkt=extent_wkt,
                feature_count=feature_count,
                size=parquet_path.stat().st_size,
                properties=params.properties or metadata.get("properties"),
                other_properties=stamp,
                tool_type=metadata.get("process_id"),
                job_id=None,
            )
            return properties

        async def create_db_records() -> int:
            from goatlib.tools.db import ToolDatabaseService

            pool = await self.get_postgres_pool()
            try:
                if claim_link_id is None:
                    db_service = ToolDatabaseService(pool, schema=schema)
                    layer_properties = await create_layer_record(db_service)
                    link_id: int = await db_service.add_to_project(
                        layer_id=new_layer_id,
                        project_id=params.project_id,
                        name=layer_name,
                        properties=layer_properties,
                        other_properties=stamp,
                    )
                    return link_id
                # Copy-on-write: the new layer, the entry pointing at it and
                # the dataset nodes reading that entry commit together, so a
                # failure cannot leave a layer that no project shows.
                assert params.export_node_id is not None
                async with pool.acquire() as conn, conn.transaction():
                    await create_layer_record(ToolDatabaseService(conn, schema=schema))
                    await claim_link(
                        conn,
                        schema,
                        project_id=params.project_id,
                        link_id=claim_link_id,
                        layer_id=new_layer_id,
                        workflow_id=params.workflow_id,
                        export_node_id=params.export_node_id,
                    )
                    await retarget_dataset_nodes(
                        conn,
                        schema,
                        project_id=params.project_id,
                        link_id=claim_link_id,
                        layer_id=new_layer_id,
                    )
                return claim_link_id
            finally:
                await pool.close()

        loop = _get_or_create_event_loop()
        layer_project_id = loop.run_until_complete(create_db_records())
        if claim_link_id is not None:
            loop.run_until_complete(
                self._sync_name_and_get_link(
                    layer_id=new_layer_id,
                    project_id=params.project_id,
                    new_name=layer_name,
                )
            )

        logger.info(
            f"Created layer record: {new_layer_id}, layer_project_id={layer_project_id}"
        )

        self._output_info = FinalizeLayerOutput(
            layer_id=new_layer_id,
            layer_name=layer_name,
            project_id=params.project_id,
            layer_project_id=layer_project_id,
            feature_count=feature_count,
            geometry_type=geometry_type,
            overwritten=False,
        )

        return new_layer_id

    def run(self, params: FinalizeLayerParams) -> FinalizeLayerOutput:
        """Run the finalize layer tool.

        Override the base run() since this tool doesn't produce a layer output
        in the normal way - it moves an existing temp layer to permanent storage.
        """
        self.process(params)
        return self._output_info


def main(
    user_id: str,
    workflow_id: str,
    node_id: str,
    project_id: str,
    folder_id: str,
    layer_name: str | None = None,
    export_node_id: str | None = None,
    properties: dict[str, Any] | None = None,
    overwrite_previous: bool = False,
) -> dict:
    """Windmill entry point for finalize layer.

    ``export_node_id`` is the workflow export node ID. It is used both for
    status tracking in workflow_runner and, combined with ``workflow_id``, as
    the identity key for the overwrite-on-rerun lookup.
    """
    params = FinalizeLayerParams(
        user_id=user_id,
        workflow_id=workflow_id,
        node_id=node_id,
        project_id=project_id,
        folder_id=folder_id,
        layer_name=layer_name,
        properties=properties,
        overwrite_previous=overwrite_previous,
        export_node_id=export_node_id,
    )

    runner = FinalizeLayerRunner()
    runner.init_from_env()
    result = runner.run(params)
    return result.model_dump()
