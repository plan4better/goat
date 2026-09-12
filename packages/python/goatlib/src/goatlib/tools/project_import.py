"""Project import tool — imports a self-contained ZIP archive into GOAT.

Downloads a ZIP from S3, validates the manifest and checksums, writes layer
data to DuckLake, uploads assets to S3, and inserts all PostgreSQL records in
a single transaction.

Usage (Windmill entry point):
    result = main(ProjectImportParams(...))
    # result = {"project_id": "...", "project_name": "...", ...}
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import tempfile
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Self
from uuid import uuid4

import asyncpg
from pydantic import BaseModel, Field

from goatlib.tools.base import SimpleToolRunner
from goatlib.tools.project_schemas import (
    EXTERNAL_DATA_TYPES,
    FORMAT_VERSION,
    ExportAssetManifest,
    ExportLayerGroupTree,
    ExportLayerIndex,
    ExportLayerProjectLinks,
    ExportManifest,
    ExportProjectMetadata,
    ExportReportLayout,
    ExportWorkflow,
)
from goatlib.tools.schemas import ToolInputBase
from goatlib.utils.layer import layer_schema_name, layer_table_path

logger = logging.getLogger(__name__)

_GROUP_ICON_KEY_RE = re.compile(r"^group_icon_(\d+)$")


class ProjectImportParams(ToolInputBase):
    """Parameters for project import tool."""

    s3_key: str = Field(..., description="S3 key of the uploaded ZIP archive")
    target_folder_id: str = Field(
        ..., description="Folder ID where the imported project will be placed"
    )
    project_name: str | None = Field(
        None, description="Optional name override for the imported project"
    )


class ProjectImportOutput(BaseModel):
    """Output of project import."""

    project_id: str
    project_name: str
    layer_count: int = 0
    workflow_count: int = 0
    report_count: int = 0
    wm_labels: list[str] = Field(default_factory=list)


@dataclass
class ImportCleanupTracker:
    """Tracks resources created during import for rollback on failure."""

    ducklake_tables: list[str] = field(default_factory=list)
    s3_keys: list[str] = field(default_factory=list)


class ProjectImportRunner(SimpleToolRunner):
    """Runner for project import."""

    def _verify_checksums(
        self: Self, manifest: ExportManifest, archive_dir: Path
    ) -> None:
        """Verify SHA-256 checksums for all files listed in the manifest."""
        for rel_path, expected_checksum in manifest.checksums.items():
            file_path = archive_dir / rel_path
            if not file_path.exists():
                logger.warning("Checksum file missing (skipping): %s", rel_path)
                continue
            h = hashlib.sha256()
            with open(file_path, "rb") as f:
                for chunk in iter(lambda: f.read(8192), b""):
                    h.update(chunk)
            actual = f"sha256:{h.hexdigest()}"
            if actual != expected_checksum:
                raise ValueError(
                    f"Checksum mismatch for {rel_path}: expected {expected_checksum}, got {actual}"
                )
        logger.info("All checksums verified (%d files)", len(manifest.checksums))

    def _validate_manifest(self: Self, manifest_data: dict[str, Any]) -> ExportManifest:
        """Parse and validate the manifest, checking format_version major."""
        manifest = ExportManifest.model_validate(manifest_data)
        expected_major = FORMAT_VERSION.split(".")[0]
        actual_major = manifest.format_version.split(".")[0]
        if actual_major != expected_major:
            raise ValueError(
                f"Incompatible format version: expected {FORMAT_VERSION}, got {manifest.format_version}"
            )
        return manifest

    def _generate_id_mapping(self: Self, archive_dir: Path) -> dict[str, str]:
        """Generate old->new UUID mapping for layers, groups, workflows, reports."""
        id_map: dict[str, str] = {}

        # Layers
        layers_index_path = archive_dir / "layers" / "index.json"
        if layers_index_path.exists():
            with open(layers_index_path) as f:
                index = ExportLayerIndex.model_validate(json.load(f))
            for layer in index.layers:
                id_map[layer.id] = str(uuid4())

        # Layer groups
        groups_path = archive_dir / "layer_groups.json"
        if groups_path.exists():
            with open(groups_path) as f:
                tree = ExportLayerGroupTree.model_validate(json.load(f))
            for group in tree.groups:
                id_map[str(group.id)] = str(uuid4())

        # Workflows
        workflows_dir = archive_dir / "workflows"
        if workflows_dir.exists():
            for wf_path in sorted(workflows_dir.glob("*.json")):
                with open(wf_path) as f:
                    wf = ExportWorkflow.model_validate(json.load(f))
                id_map[wf.id] = str(uuid4())

        # Reports
        reports_dir = archive_dir / "reports"
        if reports_dir.exists():
            for rpt_path in sorted(reports_dir.glob("*.json")):
                with open(rpt_path) as f:
                    rpt = ExportReportLayout.model_validate(json.load(f))
                id_map[rpt.id] = str(uuid4())

        # Assets
        assets_index_path = archive_dir / "assets" / "index.json"
        if assets_index_path.exists():
            with open(assets_index_path) as f:
                asset_manifest = ExportAssetManifest.model_validate(json.load(f))
            for asset in asset_manifest.assets:
                id_map[asset.id] = str(uuid4())

        logger.info("Generated %d ID mappings", len(id_map))
        return id_map

    def _load_layer_project_links(
        self: Self,
        archive_dir: Path,
        layer_index: ExportLayerIndex,
    ) -> list[dict[str, Any]]:
        """Load layer_project links from the archive.

        Format 1.1: a single `layer_project_links.json` at the archive root
        holds all links as a list (multiple links may share `layer_id`),
        validated against [ExportLayerProjectLinks].

        Format 1.0 fallback: one `layers/{layer_id}/project_link.json` per
        layer — at most one link per layer, since the path embeds the layer id.
        If both files exist, the 1.1 file wins (legacy files are ignored).
        """
        links_path = archive_dir / "layer_project_links.json"
        if links_path.exists():
            with open(links_path) as f:
                payload = json.load(f)
            validated = ExportLayerProjectLinks.model_validate(payload)
            return [lk.model_dump() for lk in validated.links]

        # Format 1.0 fallback. layer_id isn't recorded inside the file because
        # the directory path embeds it — attach it here so the downstream
        # insert loop has a uniform schema.
        legacy_links: list[dict[str, Any]] = []
        for layer_meta in layer_index.layers:
            link_path = archive_dir / "layers" / layer_meta.id / "project_link.json"
            if not link_path.exists():
                continue
            with open(link_path) as f:
                link_data = json.load(f)
            link_data["layer_id"] = layer_meta.id
            legacy_links.append(link_data)
        return legacy_links

    def _remap_workflow_config(
        self: Self, config: dict[str, Any], id_map: dict[str, str]
    ) -> dict[str, Any]:
        """Remap layer IDs in workflow config nodes, clear export state fields."""
        config_copy = json.loads(json.dumps(config))
        nodes = config_copy.get("nodes", [])
        for node in nodes:
            node_data = node.get("data", {})
            node_type = node_data.get("type", "")

            # Remap layerId in dataset nodes
            if node_type == "dataset" or "layerId" in node_data:
                old_layer_id = node_data.get("layerId")
                if old_layer_id and old_layer_id in id_map:
                    node_data["layerId"] = id_map[old_layer_id]

            # Clear export state fields
            for state_field in ("exportedLayerId", "jobId", "status"):
                if state_field in node_data:
                    node_data[state_field] = None

        return config_copy

    def _remap_layer_other_properties(
        self: Self,
        other_properties: dict[str, Any] | None,
        id_map: dict[str, str],
    ) -> dict[str, Any] | None:
        """Remap the workflow_export stamp's workflow_id via id_map.

        Layers persisted by a 'Save as Dataset' node carry an
        ``other_properties.workflow_export`` stamp that finalize_layer's
        overwrite-on-rerun lookup matches against. The workflow row itself
        gets a new UUID on import, so without remapping the stamp the
        first post-import run misses and creates a duplicate layer
        instead of replacing the imported one.
        """
        if not other_properties:
            return other_properties
        stamp = other_properties.get("workflow_export")
        if not isinstance(stamp, dict):
            return other_properties
        old_wf_id = stamp.get("workflow_id")
        if not old_wf_id or old_wf_id not in id_map:
            return other_properties
        remapped = json.loads(json.dumps(other_properties))
        remapped["workflow_export"]["workflow_id"] = id_map[old_wf_id]
        return remapped

    def _remap_report_config(
        self: Self, config: dict[str, Any], id_map: dict[str, str]
    ) -> dict[str, Any]:
        """Replace old UUIDs with new UUIDs in report config JSON.

        Only replaces values that look like UUIDs (36-char with hyphens)
        to avoid corrupting the JSON with short key replacements.
        """
        config_str = json.dumps(config)
        for old_id, new_id in id_map.items():
            # Only replace UUID-shaped keys (skip integer group IDs)
            if len(old_id) >= 32 and "-" in old_id:
                config_str = config_str.replace(old_id, new_id)
        return json.loads(config_str)

    def _remap_builder_config(
        self: Self,
        config: dict[str, Any],
        lp_id_map: dict[int, int],
        group_id_map: dict[int, int] | None = None,
    ) -> dict[str, Any]:
        """Remap layer_project_id and group_id references in builder_config.

        Widget configs reference layer_project link IDs (integers) and
        layer_project_group IDs (integers) which both change on import.
        For layer_project IDs, walks the serialized JSON and rewrites
        `"layer_project_id": <int>` plus integers in arrays. For group IDs,
        walks the deserialized tree and rewrites widget config keys of the
        form `group_icon_<id>` and `group_info` object keys.
        """
        config_str = json.dumps(config)
        # Replace integer IDs carefully — match "layer_project_id": 66 patterns
        # and also array references like [66, 67, 68]
        for old_id, new_id in sorted(lp_id_map.items(), key=lambda x: -len(str(x[0]))):
            # Replace in "layer_project_id": 66 (with and without space)
            config_str = config_str.replace(
                f'"layer_project_id": {old_id}', f'"layer_project_id": {new_id}'
            )
            config_str = config_str.replace(
                f'"layer_project_id":{old_id}', f'"layer_project_id":{new_id}'
            )
        # Also remap downloadable_layers arrays and target_layers
        for old_id, new_id in sorted(lp_id_map.items(), key=lambda x: -len(str(x[0]))):
            # In arrays like [66, 67, 68] — careful with boundaries
            config_str = re.sub(
                rf"(?<=[[\s,]){old_id}(?=[,\]\s])",
                str(new_id),
                config_str,
            )
        remapped = json.loads(config_str)
        if group_id_map:
            remapped = self._remap_group_ids_in_config(remapped, group_id_map)
        return remapped  # type: ignore[no-any-return]

    def _remap_basemap_layer_config(
        self: Self,
        custom_basemaps: list[dict[str, Any]],
        lp_id_map: dict[int, int],
    ) -> list[dict[str, Any]]:
        """Rewrite custom_basemaps layer_config targets to new link IDs.

        A vector basemap's `layer_config` entries carry a `target` that is
        either "all" or a layer_project link ID (as a string). Link IDs are
        regenerated on import, so a non-"all" target is remapped via lp_id_map;
        an unmapped target falls back to "all". Mirrors the project-copy path
        (`crud_project_copy._remap_basemap_layer_config`).
        """
        remapped: list[dict[str, Any]] = []
        for basemap in custom_basemaps:
            config = basemap.get("layer_config")
            if not config:
                remapped.append(basemap)
                continue
            new_config: dict[str, Any] = {}
            for layer_key, setting in config.items():
                target = setting.get("target", "all")
                if target != "all":
                    try:
                        old_id = int(target)
                    except (TypeError, ValueError):
                        old_id = None
                    new_id = lp_id_map.get(old_id) if old_id is not None else None
                    target = str(new_id) if new_id is not None else "all"
                new_config[layer_key] = {**setting, "target": target}
            remapped.append({**basemap, "layer_config": new_config})
        return remapped

    def _remap_group_ids_in_config(
        self: Self,
        node: Any,
        group_id_map: dict[int, int],
    ) -> Any:
        """Recursively rewrite `group_icon_<id>` keys and `group_info` keys.

        Layer-widget configs encode group IDs into dynamic keys (one per
        group), which a pure value-based remap cannot touch. Keys with no
        mapping are preserved so stale entries (e.g. for groups deleted
        before export) don't get silently dropped — the frontend ignores
        them, same as before the remap.
        """
        if isinstance(node, dict):
            new_dict: dict[str, Any] = {}
            for key, value in node.items():
                if key == "group_info" and isinstance(value, dict):
                    new_dict[key] = {
                        self._remap_group_info_key(k, group_id_map): v
                        for k, v in value.items()
                    }
                    continue
                match = _GROUP_ICON_KEY_RE.match(key) if isinstance(key, str) else None
                if match:
                    old_gid = int(match.group(1))
                    new_gid = group_id_map.get(old_gid)
                    new_key = f"group_icon_{new_gid}" if new_gid is not None else key
                    new_dict[new_key] = self._remap_group_ids_in_config(
                        value, group_id_map
                    )
                else:
                    new_dict[key] = self._remap_group_ids_in_config(value, group_id_map)
            return new_dict
        if isinstance(node, list):
            return [
                self._remap_group_ids_in_config(item, group_id_map) for item in node
            ]
        return node

    @staticmethod
    def _remap_group_info_key(key: str, group_id_map: dict[int, int]) -> str:
        """Map a single group_info key (string-encoded int) to its new ID."""
        try:
            old_gid = int(key)
        except (TypeError, ValueError):
            return key
        new_gid = group_id_map.get(old_gid)
        return str(new_gid) if new_gid is not None else key

    def _import_ducklake_layer(
        self: Self,
        parquet_path: Path,
        new_user_id: str,
        new_layer_id: str,
        tracker: ImportCleanupTracker,
    ) -> None:
        """Create a DuckLake table from a parquet file (excluding bbox column)."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")

        schema = layer_schema_name()
        table_path = layer_table_path(new_layer_id)

        # Ensure schema exists
        self.duckdb_con.execute(f"CREATE SCHEMA IF NOT EXISTS lake.{schema}")

        # Read parquet columns, exclude bbox, sanitize names
        columns_result = self.duckdb_con.execute(
            f"DESCRIBE SELECT * FROM '{parquet_path}'"
        ).fetchall()
        safe_col_re = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_ ]*$")
        columns = []
        for col in columns_result:
            name = col[0]
            if name == "bbox":
                continue
            if not safe_col_re.match(name):
                logger.warning("Skipping unsafe column name: %r", name)
                continue
            columns.append(name)
        col_list = ", ".join(f'"{c}"' for c in columns)

        # Create table from parquet
        self.duckdb_con.execute(
            f"CREATE TABLE {table_path} AS SELECT {col_list} FROM '{parquet_path}'"
        )

        tracker.ducklake_tables.append(table_path)
        logger.info("Created DuckLake table: %s", table_path)

    def _upload_s3_asset(
        self: Self,
        local_path: Path,
        s3_key: str,
        content_type: str,
        tracker: ImportCleanupTracker,
    ) -> None:
        """Upload a file to S3."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")

        with open(local_path, "rb") as f:
            self.s3_client.put_object(
                Bucket=self.settings.s3_bucket_name,
                Key=s3_key,
                Body=f,
                ContentType=content_type,
            )
        tracker.s3_keys.append(s3_key)
        logger.info("Uploaded S3 asset: %s", s3_key)

    async def _insert_pg_records(  # noqa: C901
        self: Self,
        archive_dir: Path,
        id_map: dict[str, str],
        new_project_id: str,
        new_user_id: str,
        target_folder_id: str,
        project_name_override: str | None = None,
    ) -> None:
        """Insert all PostgreSQL records in a single transaction."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")

        schema = self.settings.customer_schema

        # Load project metadata
        project_path = archive_dir / "project.json"
        with open(project_path) as f:
            project_data = ExportProjectMetadata.model_validate(json.load(f))

        # Apply project name override if provided
        if project_name_override:
            project_data.name = project_name_override

        # Load layer index
        layers_index_path = archive_dir / "layers" / "index.json"
        layer_index = ExportLayerIndex(layers=[])
        if layers_index_path.exists():
            with open(layers_index_path) as f:
                layer_index = ExportLayerIndex.model_validate(json.load(f))

        # Load layer groups
        groups_path = archive_dir / "layer_groups.json"
        group_tree = ExportLayerGroupTree(groups=[])
        if groups_path.exists():
            with open(groups_path) as f:
                group_tree = ExportLayerGroupTree.model_validate(json.load(f))

        # Load workflows
        workflows: list[ExportWorkflow] = []
        workflows_dir = archive_dir / "workflows"
        if workflows_dir.exists():
            for wf_path in sorted(workflows_dir.glob("*.json")):
                with open(wf_path) as f:
                    workflows.append(ExportWorkflow.model_validate(json.load(f)))

        # Load reports
        reports: list[ExportReportLayout] = []
        reports_dir = archive_dir / "reports"
        if reports_dir.exists():
            for rpt_path in sorted(reports_dir.glob("*.json")):
                with open(rpt_path) as f:
                    reports.append(ExportReportLayout.model_validate(json.load(f)))

        conn = await asyncpg.connect(
            host=self.settings.postgres_server,
            port=self.settings.postgres_port,
            user=self.settings.postgres_user,
            password=self.settings.postgres_password,
            database=self.settings.postgres_db,
        )

        try:
            # Set up JSON/JSONB codecs
            await conn.set_type_codec(
                "jsonb",
                encoder=json.dumps,
                decoder=json.loads,
                schema="pg_catalog",
            )
            await conn.set_type_codec(
                "json",
                encoder=json.dumps,
                decoder=json.loads,
                schema="pg_catalog",
            )

            async with conn.transaction():
                # The imported project and every layer it references land in
                # `target_folder_id` — they belong to that folder's space
                # (every folder/layer/project/bundle row carries the
                # `space_id` of the space that owns it). Without this, both
                # rows would be created with `space_id` NULL — unreachable
                # through any space-scoped listing or grant.
                target_space_id = await conn.fetchval(
                    f"SELECT space_id FROM {schema}.folder WHERE id = $1",
                    uuid.UUID(target_folder_id),
                )

                # 1. Insert project (builder_config deferred until layer_project IDs are known)
                await conn.execute(
                    f"""
                    INSERT INTO {schema}.project
                        (id, user_id, folder_id, space_id, name, description, basemap,
                         custom_basemaps, max_extent, tags,
                         created_at, updated_at)
                    VALUES
                        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
                    """,
                    uuid.UUID(new_project_id),
                    uuid.UUID(new_user_id),
                    uuid.UUID(target_folder_id),
                    target_space_id,
                    project_data.name,
                    project_data.description,
                    project_data.basemap,
                    project_data.custom_basemaps or [],
                    project_data.max_extent,
                    project_data.tags,
                )

                # 2. Insert user_project
                await conn.execute(
                    f"""
                    INSERT INTO {schema}.user_project
                        (user_id, project_id, initial_view_state,
                         created_at, updated_at)
                    VALUES
                        ($1, $2, $3, NOW(), NOW())
                    """,
                    uuid.UUID(new_user_id),
                    uuid.UUID(new_project_id),
                    project_data.initial_view_state,
                )

                # 3. Insert layer_project_groups (topological order: parents first)
                # Sort groups so parents come before children
                sorted_groups = []
                remaining = list(group_tree.groups)
                inserted_old_ids: set[str] = set()
                max_iterations = len(remaining) + 1
                iteration = 0
                while remaining and iteration < max_iterations:
                    iteration += 1
                    next_remaining = []
                    for g in remaining:
                        if g.parent_id is None or str(g.parent_id) in inserted_old_ids:
                            sorted_groups.append(g)
                            inserted_old_ids.add(str(g.id))
                        else:
                            next_remaining.append(g)
                    remaining = next_remaining

                # Map old group id (str) -> new serial id (returned by RETURNING id)
                group_new_serial: dict[str, int] = {}
                # Same mapping, but keyed by the old integer id — used for
                # remapping group references inside builder_config (which
                # are stored as ints in widget keys like `group_icon_42`).
                group_old_int_to_new: dict[int, int] = {}

                for group in sorted_groups:
                    old_gid = str(group.id)
                    new_group_id = id_map.get(old_gid)
                    parent_serial = (
                        group_new_serial.get(str(group.parent_id))
                        if group.parent_id
                        else None
                    )
                    new_serial = await conn.fetchval(
                        f"""
                        INSERT INTO {schema}.layer_project_group
                            (name, "order", properties, project_id, parent_id,
                             created_at, updated_at)
                        VALUES
                            ($1, $2, $3, $4, $5, NOW(), NOW())
                        RETURNING id
                        """,
                        group.name,
                        group.order,
                        group.properties,
                        uuid.UUID(new_project_id),
                        parent_serial,
                    )
                    if new_serial is not None:
                        group_new_serial[old_gid] = new_serial
                        try:
                            group_old_int_to_new[int(old_gid)] = new_serial
                        except ValueError:
                            # Non-numeric source group id (shouldn't happen
                            # for PG serial ids, but stay defensive).
                            pass
                    # Also store in id_map for reference (old group id -> new serial str)
                    if new_group_id:
                        group_new_serial[new_group_id] = group_new_serial.get(
                            old_gid, 0
                        )

                # 4a. Insert one layer row per unique dataset. Skipped layers
                # (e.g. street_network) are not entered in old_to_new_layer_id,
                # so 4b's `target_layer_id is None` branch drops their links.
                old_to_new_layer_id: dict[str, str] = {}
                for layer_meta in layer_index.layers:
                    if layer_meta.feature_layer_type == "street_network":
                        logger.info(
                            "Skipping system layer in PG insert: %s (%s)",
                            layer_meta.name,
                            layer_meta.id,
                        )
                        continue
                    old_layer_id = layer_meta.id
                    new_layer_id = id_map.get(old_layer_id, str(uuid4()))
                    old_to_new_layer_id[old_layer_id] = new_layer_id

                    remapped_other_properties = self._remap_layer_other_properties(
                        layer_meta.other_properties, id_map
                    )

                    await conn.execute(
                        f"""
                        INSERT INTO {schema}.layer
                            (id, user_id, folder_id, space_id, name, description, type,
                             feature_layer_type, feature_layer_geometry_type,
                             data_type, url, properties, other_properties,
                             size, field_config,
                             created_at, updated_at)
                        VALUES
                            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                             $11, $12, $13, $14, $15,
                             NOW(), NOW())
                        """,
                        uuid.UUID(new_layer_id),
                        uuid.UUID(new_user_id),
                        uuid.UUID(target_folder_id),
                        target_space_id,
                        layer_meta.name,
                        layer_meta.description,
                        layer_meta.type,
                        layer_meta.feature_layer_type,
                        layer_meta.feature_layer_geometry_type,
                        layer_meta.data_type,
                        layer_meta.url,
                        layer_meta.properties,
                        remapped_other_properties,
                        layer_meta.size,
                        layer_meta.field_config,
                    )

                # 4b. Insert one layer_project row per exported link.
                # Format 1.1: links in archive_dir/layer_project_links.json.
                # Format 1.0 fallback: layers/{layer_id}/project_link.json.
                layer_project_id_map: dict[int, int] = {}  # old link ID -> new link ID
                links_to_insert = self._load_layer_project_links(
                    archive_dir, layer_index
                )
                for link_data in links_to_insert:
                    link_layer_id = link_data["layer_id"]
                    target_layer_id = old_to_new_layer_id.get(link_layer_id)
                    if target_layer_id is None:
                        # Link references a layer that was skipped (e.g. system layer).
                        continue

                    old_group_id = link_data.get(
                        "layer_project_group_id"
                    ) or link_data.get("group_id")
                    group_serial = (
                        group_new_serial.get(str(old_group_id))
                        if old_group_id
                        else None
                    )
                    new_link_id = await conn.fetchval(
                        f"""
                        INSERT INTO {schema}.layer_project
                            (layer_id, project_id, name, "order", properties,
                             other_properties, query, charts, layer_project_group_id,
                             created_at, updated_at)
                        VALUES
                            ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
                        RETURNING id
                        """,
                        uuid.UUID(target_layer_id),
                        uuid.UUID(new_project_id),
                        link_data.get("name"),
                        link_data.get("order", 0),
                        link_data.get("properties"),
                        link_data.get("other_properties"),
                        link_data.get("query"),
                        link_data.get("charts"),
                        group_serial,
                    )
                    # Track old layer_project_id -> new for builder_config remapping
                    old_link_id = link_data.get("id")
                    if old_link_id is not None and new_link_id is not None:
                        layer_project_id_map[int(old_link_id)] = int(new_link_id)

                # 4c. Update builder_config with remapped layer_project IDs
                # and remapped group IDs (the latter affects widget keys like
                # `group_icon_<id>` and `group_info` dictionaries).
                needs_remap = bool(layer_project_id_map) or bool(group_old_int_to_new)
                if project_data.builder_config and needs_remap:
                    remapped_config = self._remap_builder_config(
                        project_data.builder_config,
                        layer_project_id_map,
                        group_old_int_to_new,
                    )
                    await conn.execute(
                        f"UPDATE {schema}.project SET builder_config = $1 WHERE id = $2",
                        remapped_config,
                        uuid.UUID(new_project_id),
                    )

                # 4d. Remap custom_basemaps layer_config targets. A vector
                # basemap's per-layer settings can target a layer_project link
                # ID, which is regenerated on import — rewrite it the same way
                # builder_config references are rewritten. The basemaps were
                # already inserted (step 1) so a solid/raster library survives
                # even when there are no links to remap.
                if project_data.custom_basemaps and layer_project_id_map:
                    remapped_basemaps = self._remap_basemap_layer_config(
                        project_data.custom_basemaps, layer_project_id_map
                    )
                    await conn.execute(
                        f"UPDATE {schema}.project SET custom_basemaps = $1 WHERE id = $2",
                        remapped_basemaps,
                        uuid.UUID(new_project_id),
                    )

                # 5. Insert workflows
                for wf in workflows:
                    new_wf_id = id_map.get(wf.id, str(uuid4()))
                    remapped_config = self._remap_workflow_config(wf.config, id_map)
                    await conn.execute(
                        f"""
                        INSERT INTO {schema}.workflow
                            (id, project_id, name, description, is_default,
                             config, created_at, updated_at)
                        VALUES
                            ($1, $2, $3, $4, $5, $6, NOW(), NOW())
                        """,
                        uuid.UUID(new_wf_id),
                        uuid.UUID(new_project_id),
                        wf.name,
                        wf.description,
                        wf.is_default,
                        remapped_config,
                    )

                # 6. Insert reports
                for rpt in reports:
                    new_rpt_id = id_map.get(rpt.id, str(uuid4()))
                    remapped_config = self._remap_report_config(rpt.config, id_map)
                    await conn.execute(
                        f"""
                        INSERT INTO {schema}.report_layout
                            (id, project_id, name, description, is_default,
                             is_predefined, config, created_at, updated_at)
                        VALUES
                            ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
                        """,
                        uuid.UUID(new_rpt_id),
                        uuid.UUID(new_project_id),
                        rpt.name,
                        rpt.description,
                        rpt.is_default,
                        rpt.is_predefined,
                        remapped_config,
                    )

        finally:
            await conn.close()

        logger.info("Inserted all PostgreSQL records for project %s", new_project_id)

    def _cleanup_on_failure(self: Self, tracker: ImportCleanupTracker) -> None:
        """Drop DuckLake tables and delete S3 objects created during failed import."""
        if self.settings is None:
            return

        for table_path in tracker.ducklake_tables:
            try:
                self.duckdb_con.execute(f"DROP TABLE IF EXISTS {table_path}")
                logger.info("Cleaned up DuckLake table: %s", table_path)
            except Exception as e:
                logger.warning("Failed to drop table %s: %s", table_path, e)

        for s3_key in tracker.s3_keys:
            try:
                self.s3_client.delete_object(
                    Bucket=self.settings.s3_bucket_name,
                    Key=s3_key,
                )
                logger.info("Deleted S3 object: %s", s3_key)
            except Exception as e:
                logger.warning("Failed to delete S3 object %s: %s", s3_key, e)

    def run(self: Self, params: ProjectImportParams) -> dict:
        """Execute the project import."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized. Call init_from_env() first.")

        wm_labels: list[str] = []
        if params.triggered_by_email:
            wm_labels.append(params.triggered_by_email)

        tracker = ImportCleanupTracker()
        new_project_id = str(uuid4())
        new_user_id = params.user_id

        try:
            with tempfile.TemporaryDirectory() as tmp:
                tmp_dir = Path(tmp)
                zip_path = tmp_dir / "import.zip"

                # 1. Download ZIP from S3
                logger.info("Downloading ZIP from S3: %s", params.s3_key)
                self.download_uploaded_object(params.s3_key, zip_path)

                # 2. Extract ZIP (with security checks)
                archive_dir = tmp_dir / "archive"
                archive_dir.mkdir()
                with zipfile.ZipFile(zip_path, "r") as zf:
                    # Check for path traversal (Zip Slip) and size limits
                    max_uncompressed = 1 * 1024 * 1024 * 1024  # 1 GB
                    max_files = 10_000
                    total_size = 0
                    if len(zf.infolist()) > max_files:
                        raise ValueError(
                            f"ZIP contains too many files ({len(zf.infolist())}), max {max_files}"
                        )
                    for member in zf.infolist():
                        # Reject symlinks
                        if (member.external_attr >> 16) & 0o170000 == 0o120000:
                            raise ValueError(
                                f"Symlink in ZIP not allowed: {member.filename}"
                            )
                        # Reject unsafe paths
                        member_path = (archive_dir / member.filename).resolve()
                        if not member_path.is_relative_to(archive_dir.resolve()):
                            raise ValueError(f"Unsafe path in ZIP: {member.filename}")
                        total_size += member.file_size
                        if total_size > max_uncompressed:
                            raise ValueError(
                                f"ZIP uncompressed size exceeds limit ({max_uncompressed // (1024**2)} MB)"
                            )
                    zf.extractall(archive_dir)

                    # Verify actual extracted size (file_size in ZIP header can be spoofed)
                    actual_size = sum(
                        f.stat().st_size for f in archive_dir.rglob("*") if f.is_file()
                    )
                    if actual_size > max_uncompressed:
                        raise ValueError(
                            f"Extracted size ({actual_size // (1024**2)} MB) exceeds "
                            f"limit ({max_uncompressed // (1024**2)} MB)"
                        )

                # 3. Validate manifest
                manifest_path = archive_dir / "manifest.json"
                if not manifest_path.exists():
                    raise ValueError("Archive is missing manifest.json")
                with open(manifest_path) as f:
                    manifest_data = json.load(f)
                manifest = self._validate_manifest(manifest_data)
                logger.info(
                    "Manifest validated: project=%s, format=%s",
                    manifest.project_name,
                    manifest.format_version,
                )

                # 4. Verify checksums (skip manifest itself)
                checksums_to_verify = {
                    k: v for k, v in manifest.checksums.items() if k != "manifest.json"
                }
                manifest_for_verify = ExportManifest(
                    **{**manifest.model_dump(), "checksums": checksums_to_verify}
                )
                self._verify_checksums(manifest_for_verify, archive_dir)

                # 5. Generate ID mapping
                id_map = self._generate_id_mapping(archive_dir)

                # 6. Import DuckLake layers
                layers_index_path = archive_dir / "layers" / "index.json"
                layer_index_layers = []
                if layers_index_path.exists():
                    with open(layers_index_path) as f:
                        layer_index = json.load(f)
                    layer_index_layers = layer_index.get("layers", [])

                uuid_re = re.compile(
                    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
                    re.IGNORECASE,
                )
                # DuckLake caches catalog metadata on the connection; on large
                # catalogs each CREATE TABLE adds tens of MB that is only freed on
                # close. Recycle the connection every few layers to keep peak RSS
                # bounded — otherwise importing into a big catalog OOMs the worker.
                imported_layer_count = 0
                recycle_every = 5
                for layer_meta in layer_index_layers:
                    old_layer_id = layer_meta["id"]
                    if not uuid_re.match(old_layer_id):
                        raise ValueError(f"Invalid layer ID in archive: {old_layer_id}")

                    # Skip system layers (e.g. street_network)
                    if layer_meta.get("feature_layer_type") == "street_network":
                        logger.info(
                            "Skipping system layer: %s (%s)",
                            layer_meta.get("name"),
                            old_layer_id,
                        )
                        continue

                    new_layer_id = id_map.get(old_layer_id, str(uuid4()))
                    is_external = layer_meta.get(
                        "data_type"
                    ) in EXTERNAL_DATA_TYPES or layer_meta.get("is_external", False)

                    if not is_external:
                        parquet_path = (
                            archive_dir / "layers" / old_layer_id / "data.parquet"
                        )
                        if parquet_path.exists():
                            self._import_ducklake_layer(
                                parquet_path=parquet_path,
                                new_user_id=new_user_id,
                                new_layer_id=new_layer_id,
                                tracker=tracker,
                            )
                            imported_layer_count += 1
                            if imported_layer_count % recycle_every == 0:
                                self.recycle_duckdb_connection()
                        else:
                            logger.warning(
                                "No data.parquet for internal layer %s, skipping DuckLake import",
                                old_layer_id,
                            )

                # 7. Upload S3 assets
                assets_index_path = archive_dir / "assets" / "index.json"
                if assets_index_path.exists():
                    with open(assets_index_path) as f:
                        asset_manifest = ExportAssetManifest.model_validate(
                            json.load(f)
                        )
                    for asset in asset_manifest.assets:
                        local_asset_path = (archive_dir / asset.archive_path).resolve()
                        if not local_asset_path.is_relative_to(archive_dir.resolve()):
                            logger.warning(
                                "Skipping unsafe asset path: %s", asset.archive_path
                            )
                            continue
                        if local_asset_path.exists():
                            new_asset_id = id_map.get(asset.id, asset.id)
                            suffix = Path(asset.file_name).suffix
                            s3_key = f"assets/{new_user_id}/{new_asset_id}{suffix}"
                            self._upload_s3_asset(
                                local_path=local_asset_path,
                                s3_key=s3_key,
                                content_type=asset.mime_type,
                                tracker=tracker,
                            )

                # 8. Upload thumbnail if present
                thumbnail_path = archive_dir / "assets" / "thumbnail.png"
                if thumbnail_path.exists():
                    thumbnail_s3_key = f"thumbnails/{new_project_id}/thumbnail.png"
                    self._upload_s3_asset(
                        local_path=thumbnail_path,
                        s3_key=thumbnail_s3_key,
                        content_type="image/png",
                        tracker=tracker,
                    )

                # 9. Insert all PostgreSQL records
                asyncio.run(
                    self._insert_pg_records(
                        archive_dir=archive_dir,
                        id_map=id_map,
                        new_project_id=new_project_id,
                        new_user_id=new_user_id,
                        target_folder_id=params.target_folder_id,
                        project_name_override=params.project_name,
                    )
                )

                output = ProjectImportOutput(
                    project_id=new_project_id,
                    project_name=manifest.project_name,
                    layer_count=manifest.layer_count,
                    workflow_count=manifest.workflow_count,
                    report_count=manifest.report_count,
                    wm_labels=wm_labels,
                )
                logger.info(
                    "Import complete: project_id=%s, name=%s",
                    new_project_id,
                    manifest.project_name,
                )
                return output.model_dump()

        except Exception:
            logger.exception("Import failed, rolling back")
            self._cleanup_on_failure(tracker)
            raise


def main(params: ProjectImportParams) -> dict:
    """Windmill entry point for project import."""
    runner = ProjectImportRunner()
    runner.init_from_env()
    try:
        return runner.run(params)
    finally:
        runner.cleanup()
