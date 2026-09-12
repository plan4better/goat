"""Database operations for Windmill tool outputs.

This module handles all PostgreSQL operations for tool results:
- Creating layer metadata in customer.layer
- Linking layers to projects in customer.layer_project
- Updating project layer_order

These operations are shared across all tools (buffer, clip, join, etc.)
to avoid code duplication in Windmill scripts.
"""

import json
import logging
import uuid as uuid_module
from enum import Enum
from typing import Any, Literal, Self

import asyncpg
from pydantic import BaseModel, Field, model_validator

from goatlib.models.bundle import (
    BundleArtifactBuildStatus,
    BundleStatus,
    BundleTypeName,
)
from goatlib.tools.style import get_default_style

logger = logging.getLogger(__name__)


def _decode_jsonb(value: Any) -> dict[str, Any] | None:
    """A JSONB column as a dict.

    asyncpg hands JSONB back as the raw text unless a codec is registered on
    the connection, and these pools register none — so a caller that treated
    the value as a dict would silently get a string. None and an empty value
    stay None, which is what "the column holds nothing" means everywhere it is
    read.
    """
    if not value:
        return None
    if isinstance(value, dict):
        return value
    try:
        decoded = json.loads(value)
    except (TypeError, ValueError):
        logger.warning("Could not decode JSONB value: %r", value)
        return None
    return decoded if isinstance(decoded, dict) else None


def normalize_geometry_type(geom_type: str | None) -> str | None:
    """Normalize DuckDB geometry type to GOAT schema enum value.

    DuckDB ST_GeometryType returns uppercase like 'POINT', 'LINESTRING', 'POLYGON'.
    GOAT schema expects lowercase: 'point', 'line', 'polygon'.

    Args:
        geom_type: Geometry type from DuckDB (e.g., 'POINT', 'MULTIPOLYGON')

    Returns:
        Normalized type ('point', 'line', 'polygon') or None
    """
    if not geom_type:
        return None

    geom_upper = geom_type.upper()

    if "POINT" in geom_upper:
        return "point"
    elif "LINE" in geom_upper or "STRING" in geom_upper:
        return "line"
    elif "POLYGON" in geom_upper:
        return "polygon"

    return None


class FeatureGeometryType(str, Enum):
    """Feature layer geometry types. Mirrors core.db.models.layer.FeatureGeometryType."""

    point = "point"
    line = "line"
    polygon = "polygon"


class LayerRecord(BaseModel):
    """Pydantic model mirroring customer.layer constraints.

    Validates data before INSERT to catch issues early instead of
    writing broken records to the database.
    """

    id: uuid_module.UUID
    user_id: uuid_module.UUID
    folder_id: uuid_module.UUID
    space_id: uuid_module.UUID
    name: str = Field(min_length=1)
    type: Literal["feature", "raster", "table"]
    feature_layer_type: Literal["standard", "tool", "street_network"] | None = None
    feature_layer_geometry_type: FeatureGeometryType | None = None
    extent_wkt: str | None = None
    size: int = 0
    properties: dict[str, Any] | None = None
    other_properties: dict[str, Any] | None = None
    thumbnail_url: str | None = None
    tool_type: str | None = None
    job_id: uuid_module.UUID | None = None

    @model_validator(mode="after")
    def feature_layer_requires_geometry(self: Self) -> Self:
        """Feature layers must have a geometry type."""
        if self.type == "feature" and self.feature_layer_geometry_type is None:
            raise ValueError(
                "Feature layers require feature_layer_geometry_type "
                "(point, line, or polygon)"
            )
        return self


class LayerProjectRecord(BaseModel):
    """Pydantic model mirroring customer.layer_project constraints."""

    layer_id: uuid_module.UUID
    project_id: uuid_module.UUID
    name: str = Field(min_length=1, max_length=255)
    order: int = 0
    properties: dict[str, Any] | None = None
    other_properties: dict[str, Any] | None = None


class ToolDatabaseService:
    """Handles all database operations for tool outputs.

    Usage:
        pool = await asyncpg.create_pool(...)
        db = ToolDatabaseService(pool)

        await db.create_layer(layer_id=..., user_id=..., ...)
        await db.add_to_project(layer_id=..., project_id=..., ...)
    """

    def __init__(self: Self, pool: asyncpg.Pool, schema: str = "customer") -> None:
        """Initialize database service.

        Args:
            pool: asyncpg connection pool
            schema: Database schema name (default: customer)
        """
        self.pool = pool
        self.schema = schema

    async def _resolve_folder_space_id(self: Self, folder_id: str) -> uuid_module.UUID:
        """Look up the space a folder belongs to.

        Raises if the folder does not exist or has no space, so a tool never
        writes a layer/bundle row that is unreachable to its owner.
        """
        row = await self.pool.fetchrow(
            f"SELECT space_id FROM {self.schema}.folder WHERE id = $1",
            uuid_module.UUID(folder_id),
        )
        if row is None:
            raise ValueError(f"Folder {folder_id} does not exist")
        if row["space_id"] is None:
            raise ValueError(
                f"Folder {folder_id} has no space_id; cannot create a reachable record"
            )
        return row["space_id"]

    async def user_can(
        self: Self,
        resource_type: Literal["layer", "project", "bundle", "folder", "template"],
        resource_id: str,
        user_id: str,
        action: Literal["read", "write", "share", "delete"],
    ) -> bool:
        """Whether ``user_id`` may do ``action`` to a resource.

        Delegates to ``customer.can``, the one authorization rule core and
        geoapi both go through, rather than re-spelling reachability in SQL
        here: a bundle is reachable through its space role, a grant on it, a
        grant on any ancestor folder, or — for a layer — its bundle's grant,
        and only the function knows all of that. A tool that resolves ids it
        was handed has to ask the same question the HTTP surface would, or the
        job becomes a way around it.

        Returns False for an id that does not exist, so a caller gets one
        refusal rather than having to tell "gone" from "not yours" — which is
        also what the endpoints do, so a tool cannot be used to probe for
        existence.
        """
        row = await self.pool.fetchrow(
            f"SELECT {self.schema}.can($1, $2::uuid, $3::uuid, $4) AS ok",
            resource_type,
            uuid_module.UUID(resource_id),
            uuid_module.UUID(user_id),
            action,
        )
        return bool(row and row["ok"])

    async def bundle_exists(self: Self, bundle_id: str) -> bool:
        """Whether the bundle row is still there.

        ``customer.can`` answers False for a row that is gone and for a row
        that is not yours, which is right for an endpoint — a caller should not
        be able to tell those apart — but not for a cleanup job that runs
        *after* the row is deleted. Separating the two is what lets such a job
        authorize itself: see ``authorize_artifact_cleanup``.
        """
        row = await self.pool.fetchrow(
            f"SELECT 1 AS ok FROM {self.schema}.bundle WHERE id = $1",
            uuid_module.UUID(bundle_id),
        )
        return row is not None

    async def get_project_folder_id(self: Self, project_id: str) -> str | None:
        """Get the folder_id for a project.

        Args:
            project_id: Project UUID

        Returns:
            folder_id or None if project not found
        """
        row = await self.pool.fetchrow(
            f"SELECT folder_id FROM {self.schema}.project WHERE id = $1",
            uuid_module.UUID(project_id),
        )
        if row:
            return str(row["folder_id"])
        return None

    async def create_layer(
        self: Self,
        layer_id: str,
        user_id: str,
        folder_id: str,
        name: str,
        layer_type: str = "feature",
        feature_layer_type: str | None = "tool",
        geometry_type: str | None = None,
        extent_wkt: str | None = None,
        feature_count: int = 0,
        size: int = 0,
        properties: dict[str, Any] | None = None,
        other_properties: dict[str, Any] | None = None,
        thumbnail_url: str
        | None = "https://assets.plan4better.de/img/goat_new_dataset_thumbnail.png",
        tool_type: str | None = None,
        job_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Create a layer record in customer.layer.

        Args:
            layer_id: UUID for the new layer
            user_id: Owner user UUID
            folder_id: Parent folder UUID
            name: Layer display name
            layer_type: "feature" or "table"
            feature_layer_type: "standard", "tool", "street_network", or None for tables
            geometry_type: "point", "line", "polygon", or None (will be normalized)
            extent_wkt: Spatial extent as WKT string
            feature_count: Number of features
            size: Size of the layer data in bytes
            properties: Layer properties (style, etc.)
            other_properties: Additional properties
            thumbnail_url: Layer thumbnail URL (defaults to standard thumbnail)
            tool_type: Tool type that created this layer (e.g., "catchment_area")
            job_id: Windmill job ID that created this layer

        Returns:
            The properties dict used (either provided or generated default)
        """
        # Normalize geometry type (POINT -> point, LINESTRING -> line, etc.)
        normalized_geom = normalize_geometry_type(geometry_type)

        # A layer is only reachable through its space (folder listings, trash,
        # transfer, authz all key off it), so resolve it from the folder up front.
        space_id = await self._resolve_folder_space_id(folder_id)

        # Validate all fields through the Pydantic model before touching the DB
        record = LayerRecord(
            id=uuid_module.UUID(layer_id),
            user_id=uuid_module.UUID(user_id),
            folder_id=uuid_module.UUID(folder_id),
            space_id=space_id,
            name=name,
            type=layer_type,
            feature_layer_type=feature_layer_type,
            feature_layer_geometry_type=normalized_geom,
            extent_wkt=extent_wkt,
            size=size,
            properties=properties,
            other_properties=other_properties,
            thumbnail_url=thumbnail_url,
            tool_type=tool_type,
            job_id=uuid_module.UUID(job_id) if job_id else None,
        )

        # Generate default style if no properties provided
        if properties is None and normalized_geom:
            properties = get_default_style(normalized_geom)

        # Convert dicts to JSON strings for JSONB columns
        properties_json = json.dumps(properties) if properties else None
        other_props_json = json.dumps(other_properties) if other_properties else None

        await self.pool.execute(
            f"""
            INSERT INTO {self.schema}.layer (
                id, user_id, folder_id, space_id, name, type, feature_layer_type,
                feature_layer_geometry_type, extent,
                size, properties, other_properties, thumbnail_url,
                tool_type, job_id, created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8,
                CASE WHEN $9::text IS NOT NULL
                    THEN ST_Multi(ST_GeomFromText($9::text, 4326))
                    ELSE NULL
                END,
                $10, $11::jsonb, $12::jsonb, $13, $14, $15,
                NOW(), NOW()
            )
            """,
            record.id,
            record.user_id,
            record.folder_id,
            record.space_id,
            record.name,
            record.type,
            record.feature_layer_type,
            record.feature_layer_geometry_type.value
            if record.feature_layer_geometry_type
            else None,
            record.extent_wkt,
            record.size,
            properties_json,
            other_props_json,
            record.thumbnail_url,
            record.tool_type,
            record.job_id,
        )
        logger.info(
            f"Created layer: {layer_id} ({name}) in folder {folder_id} "
            f"with {feature_count} features, size={size} bytes"
        )
        return properties

    async def get_bundle_name(self: Self, bundle_id: str) -> str | None:
        """Return the bundle's display name (customer.bundle.name)."""
        row = await self.pool.fetchrow(
            f"SELECT name FROM {self.schema}.bundle WHERE id = $1",
            uuid_module.UUID(bundle_id),
        )
        return row["name"] if row else None

    async def create_bundle(
        self: Self,
        bundle_id: str,
        user_id: str,
        folder_id: str,
        name: str,
        bundle_type: "BundleTypeName | str",
        status: "BundleStatus | str" = BundleStatus.processing,
        description: str | None = None,
        dataset_metadata: dict[str, Any] | None = None,
    ) -> None:
        """Create a bundle record in customer.bundle.

        ``status`` is explicit rather than left to the column default: a bundle
        that exists but has not been filled in is ``processing``, and a caller
        that forgot to say so would publish an empty one as ready.
        """
        space_id = await self._resolve_folder_space_id(folder_id)
        await self.pool.execute(
            f"""
            INSERT INTO {self.schema}.bundle (
                id, user_id, folder_id, space_id, name, description,
                bundle_type, status, dataset_metadata, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW())
            """,
            uuid_module.UUID(bundle_id),
            uuid_module.UUID(user_id),
            uuid_module.UUID(folder_id),
            space_id,
            name,
            description,
            getattr(bundle_type, "value", bundle_type),
            getattr(status, "value", status),
            json.dumps(dataset_metadata) if dataset_metadata else None,
        )
        logger.info(f"Created bundle {bundle_id} ({bundle_type})")

    async def delete_bundle(self: Self, bundle_id: str) -> None:
        """Remove a bundle row. Its artifact rows go with it (FK cascade).

        Used when an import fails: the layers it managed to write are removed
        first, so what is left is a bundle that holds nothing and can never be
        completed — there is no retry that could fill it in. The Windmill job
        carries the failure, so nothing is lost by removing the row.
        """
        await self.pool.execute(
            f"DELETE FROM {self.schema}.bundle WHERE id = $1",
            uuid_module.UUID(bundle_id),
        )
        logger.info(f"Deleted bundle {bundle_id}")

    async def update_bundle_status(
        self: Self,
        bundle_id: str,
        status: "BundleStatus | str",
    ) -> None:
        """Update a bundle's processing status."""
        status_value = getattr(status, "value", status)
        await self.pool.execute(
            f"""
            UPDATE {self.schema}.bundle
            SET status = $2, updated_at = NOW()
            WHERE id = $1
            """,
            uuid_module.UUID(bundle_id),
            status_value,
        )
        logger.info(f"Bundle {bundle_id} status -> {status_value}")

    async def update_bundle_metadata(
        self: Self,
        bundle_id: str,
        metadata: dict,
    ) -> None:
        """Write the provenance fields a source stated about itself.

        Merged into ``bundle.dataset_metadata``, so a field the source is
        silent about keeps whatever the owner authored — the same guarantee as
        before, now expressed by the JSONB concatenation rather than by
        assembling one assignment per column.

        Anything stored that is not an object is merged onto as if absent:
        concatenating onto a JSON scalar produces an array, which no longer
        validates as provenance and takes the bundle's read endpoint down with
        it.
        """
        allowed = (
            "lineage",
            "geographical_code",
            "distributor_name",
            "distributor_email",
            "distribution_url",
            "license",
            "attribution",
            "data_reference_year",
        )
        unknown = set(metadata) - set(allowed)
        if unknown:
            raise ValueError(
                f"Not bundle metadata fields: {', '.join(sorted(unknown))}"
            )
        if not metadata:
            return

        await self.pool.execute(
            f"""
            UPDATE {self.schema}.bundle
            SET dataset_metadata =
                    CASE
                        WHEN jsonb_typeof(dataset_metadata) = 'object'
                        THEN dataset_metadata
                        ELSE '{{}}'::jsonb
                    END || $2::jsonb,
                updated_at = NOW()
            WHERE id = $1
            """,
            uuid_module.UUID(bundle_id),
            json.dumps(metadata),
        )

    async def create_artifact(
        self: Self,
        bundle_id: str,
        kind: str,
        build_status: BundleArtifactBuildStatus = BundleArtifactBuildStatus.building,
        job_id: str | None = None,
        built_revision: int | None = None,
    ) -> str:
        """Create or reclaim the bundle_artifact row for (bundle_id, kind).

        Upserts against the (bundle_id, kind) unique constraint: a rebuild or a
        retried import takes over the existing row instead of dying on it.

        Only ``build_status`` is touched. ``revision`` and ``storage_path`` are
        left as they were, so a rebuild that fails or is superseded leaves the
        previous artifact still pointing at its own file and its own revision —
        which is what keeps a working graph usable for the whole build rather
        than taking it offline the moment a rebuild starts.

        ``built_revision`` is what makes that promise hold. The row is shared by
        every build of this (bundle, kind), so writing ``building`` on it while
        it already points at an artifact built from this revision or a newer one
        would report a perfectly good graph as under construction for the whole
        build — and a rebuild at the same revision is exactly what the Update
        button does. The guard is in the statement, not around it, so two
        workers cannot interleave a read and a write. Omit it and the status is
        written unconditionally, which is right only when no artifact can exist
        yet.

        Returns the row id."""
        kind_value = getattr(kind, "value", kind)
        status_value = build_status.value
        row = await self.pool.fetchrow(
            f"""
            INSERT INTO {self.schema}.bundle_artifact AS a (
                bundle_id, kind, build_status, job_id, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, NOW(), NOW())
            ON CONFLICT (bundle_id, kind) DO UPDATE SET
                build_status = CASE
                    WHEN $5::int IS NULL
                         OR a.revision IS NULL
                         OR a.revision < $5::int
                    THEN EXCLUDED.build_status
                    ELSE a.build_status
                END,
                job_id = EXCLUDED.job_id,
                updated_at = NOW()
            RETURNING id
            """,
            uuid_module.UUID(bundle_id),
            kind_value,
            status_value,
            uuid_module.UUID(job_id) if job_id else None,
            built_revision,
        )
        logger.info(
            f"Artifact {row['id']} ({kind_value}) for bundle {bundle_id}: "
            f"{status_value}"
        )
        return str(row["id"])

    async def set_artifact_build_status(
        self: Self,
        artifact_id: str,
        status: BundleArtifactBuildStatus,
        built_revision: int | None = None,
    ) -> None:
        """Record what an artifact's build attempt did.

        Only the outcome: where the file landed and which revision it came from
        are written by ``publish_artifact_if_current``, and only for the build
        that won. A failed or superseded attempt must not touch them, or it
        would take the previous good artifact with it.

        ``built_revision`` keeps the outcome from contradicting the row it is
        written on. The row is shared by every build of this (bundle, kind), so
        a build that lost a race would otherwise stamp ``failed`` over the
        status of the newer build that published on it — leaving
        ``artifact_state`` reporting ``failed`` for a graph that is current and
        valid, with nothing to re-queue a build that already happened. The
        comparison is in the WHERE clause rather than read first and written
        after, so two workers finishing together cannot interleave.
        """
        status_value = status.value
        await self.pool.execute(
            f"""
            UPDATE {self.schema}.bundle_artifact
            SET build_status = $2, updated_at = NOW()
            WHERE id = $1
              AND ($3::int IS NULL OR revision IS NULL OR revision < $3::int)
            """,
            uuid_module.UUID(artifact_id),
            status_value,
            built_revision,
        )
        logger.info(f"Artifact {artifact_id} build -> {status_value}")

    async def mark_bundle_artifacts_failed(
        self: Self, bundle_id: str, built_revision: int | None = None
    ) -> None:
        """Mark a bundle's artifact rows failed, except any newer than this build.

        For a build that dies before reaching any specific artifact row (the
        export or the builder itself raised): without this the rows stay
        'building' and consumers keep promising an update that is not running,
        instead of saying the update failed.

        ``built_revision`` is the same guard ``set_artifact_build_status``
        carries, and it matters more here because this writes every row of the
        bundle at once: a build that dies while a newer build has already
        published would otherwise mark that newer, valid artifact failed —
        leaving a current graph reported as broken with nothing to re-queue a
        build that already happened. Omit it and every row is marked, which is
        right only when no artifact can have been published yet.
        """
        await self.pool.execute(
            f"""
            UPDATE {self.schema}.bundle_artifact
            SET build_status = $2, updated_at = NOW()
            WHERE bundle_id = $1
              AND ($3::int IS NULL OR revision IS NULL OR revision < $3::int)
            """,
            uuid_module.UUID(bundle_id),
            BundleArtifactBuildStatus.failed.value,
            built_revision,
        )

    async def set_layer_field_config(
        self: Self, layer_id: str, field_config: "dict[str, Any]"
    ) -> None:
        """Replace a layer's field_config JSONB.

        The same blob geoapi's column endpoints maintain — written here so an
        importer can declare a computed column at creation time, which those
        endpoints cannot do (they only ever edit a layer that already exists).
        """
        await self.pool.execute(
            f"UPDATE {self.schema}.layer SET field_config = $2::jsonb WHERE id = $1",
            uuid_module.UUID(layer_id),
            json.dumps(field_config),
        )

    async def get_bundle_artifact(
        self: Self, bundle_id: str, kind: str
    ) -> "dict | None":
        """Stored path, status and provenance of a bundle's artifact of a kind.

        ``layers_revision`` comes back alongside the artifact's own ``revision``
        so a caller can tell whether the file still matches the layers. That
        comparison is the real answer; the stored status only records what the
        last build attempt did. Reading both means a layer write whose
        stale-marking never landed cannot leave a tool routing on a graph that
        no longer matches the data.

        ``dependencies_current`` is the same comparison across the dependency
        edge: each dependency's ``built_revision`` — the revision this bundle's
        artifacts were built from — against that bundle's current
        ``layers_revision``. An artifact derived from another bundle goes stale
        when that bundle is edited, and nothing in this bundle's own revision
        would say so. A dependency never built from reads as not current; one
        that has been unlinked has nothing to compare and so does not.
        """
        kind_value = getattr(kind, "value", kind)
        row = await self.pool.fetchrow(
            f"""
            SELECT a.storage_path, a.build_status, a.revision, b.layers_revision,
                   NOT EXISTS (
                       SELECT 1
                       FROM {self.schema}.bundle_dependency d
                       JOIN {self.schema}.bundle dep
                         ON dep.id = d.depends_on_bundle_id
                       WHERE d.bundle_id = a.bundle_id
                         AND d.built_revision IS DISTINCT FROM dep.layers_revision
                   ) AS dependencies_current
            FROM {self.schema}.bundle_artifact a
            JOIN {self.schema}.bundle b ON b.id = a.bundle_id
            WHERE a.bundle_id = $1 AND a.kind = $2
            LIMIT 1
            """,
            uuid_module.UUID(bundle_id),
            kind_value,
        )
        return dict(row) if row else None

    async def get_bundle(self: Self, bundle_id: str) -> "dict":
        """A bundle's type, owner, revision and stated metadata, for a job that
        was handed only an id.

        ``description`` and ``dataset_metadata`` are here because a copy of a
        bundle carries them over — what the source says about itself describes
        the copy just as well, and re-typing it is the user's choice, not
        something losing it should force. ``dataset_metadata`` is decoded, so a
        caller gets the same dict shape it would pass back to
        ``create_bundle``.
        """
        row = await self.pool.fetchrow(
            f"""
            SELECT bundle_type, user_id, layers_revision, description,
                   dataset_metadata
            FROM {self.schema}.bundle WHERE id = $1
            """,
            uuid_module.UUID(bundle_id),
        )
        if row is None:
            raise ValueError(f"Bundle {bundle_id} not found")
        bundle = dict(row)
        bundle["dataset_metadata"] = _decode_jsonb(bundle.get("dataset_metadata"))
        return bundle

    async def get_bundle_dependency(
        self: Self, bundle_id: str, kind: str
    ) -> "str | None":
        """The bundle this one depends on for ``kind``, or None if unlinked.

        A GTFS bundle's linkage is computed against the street network it names
        here, so the build has to resolve the link before it can start.
        """
        row = await self.pool.fetchrow(
            f"""
            SELECT depends_on_bundle_id
            FROM {self.schema}.bundle_dependency
            WHERE bundle_id = $1 AND dependency_kind = $2
            """,
            uuid_module.UUID(bundle_id),
            kind,
        )
        return str(row["depends_on_bundle_id"]) if row else None

    async def get_bundle_revision(self: Self, bundle_id: str) -> int:
        """Current layers_revision of a bundle."""
        row = await self.pool.fetchrow(
            f"SELECT layers_revision FROM {self.schema}.bundle WHERE id = $1",
            uuid_module.UUID(bundle_id),
        )
        if row is None:
            raise ValueError(f"Bundle {bundle_id} not found")
        return int(row["layers_revision"])

    async def bump_bundle_revision(self: Self, bundle_id: str) -> int:
        """Advance a bundle's layers_revision, returning the new value."""
        row = await self.pool.fetchrow(
            f"""
            UPDATE {self.schema}.bundle
            SET layers_revision = layers_revision + 1, updated_at = NOW()
            WHERE id = $1
            RETURNING layers_revision
            """,
            uuid_module.UUID(bundle_id),
        )
        if row is None:
            raise ValueError(f"Bundle {bundle_id} not found")
        return int(row["layers_revision"])

    async def publish_artifact_if_current(
        self: Self,
        artifact_id: str,
        bundle_id: str,
        built_revision: int,
        storage_path: str,
        size: int,
        properties: "dict[str, Any] | None" = None,
    ) -> "tuple[bool, str | None]":
        """Mark an artifact ready, unless the layers have moved on since.

        The revision comparison sits in the WHERE clause, so there is no window
        between checking and writing for a concurrent save to slip through.

        Returns (published, displaced_path): the path this build replaced, so
        the caller can remove a file nothing points at any more. Only the build
        that wins the comparison gets one, so two concurrent rebuilds cannot
        both decide to delete the same file.
        """
        row = await self.pool.fetchrow(
            f"""
            UPDATE {self.schema}.bundle_artifact a
            SET build_status = $6,
                storage_path = $3,
                size = $4,
                revision = $5,
                -- Replaced, not merged: these describe *this* build's
                -- output, so the previous build's facts are not partial
                -- truths to keep — they are about a file being displaced.
                properties = $7::jsonb,
                updated_at = NOW()
            FROM {self.schema}.bundle b,
                 -- The path being replaced, read through the same statement
                 -- that replaces it and under a row lock. The lock is what
                 -- makes the answer true when two builds of the same revision
                 -- publish at once: the second blocks here, then re-reads the
                 -- committed row and reports the *first* winner's fresh
                 -- archive as displaced. Reading it without the lock would
                 -- report the path from before either commit, and the first
                 -- winner's file would be left on the volume with nothing
                 -- pointing at it.
                 (
                     SELECT id, storage_path
                     FROM {self.schema}.bundle_artifact
                     WHERE id = $1
                     FOR UPDATE
                 ) prev
            WHERE a.id = $1 AND prev.id = a.id AND b.id = $2
              AND a.bundle_id = b.id
              AND b.layers_revision = $5
            RETURNING prev.storage_path AS displaced_path
            """,
            uuid_module.UUID(artifact_id),
            uuid_module.UUID(bundle_id),
            storage_path,
            size,
            built_revision,
            BundleArtifactBuildStatus.complete.value,
            json.dumps(properties) if properties else None,
        )
        if row is None:
            return False, None
        displaced = row["displaced_path"]
        return True, (displaced if displaced != storage_path else None)

    async def set_dependency_built_revision(
        self: Self, bundle_id: str, kind: str, built_revision: int
    ) -> None:
        """Record which revision of a dependency this bundle was built from.

        Called once the artifacts of a build have published, so the row says
        what the published files were actually derived from. Guarded on the
        dependency still being at that revision: if it moved on mid-build, the
        row keeps saying "not built from the current revision", which is true —
        the build read the older one.
        """
        await self.pool.execute(
            f"""
            UPDATE {self.schema}.bundle_dependency d
            SET built_revision = $3
            FROM {self.schema}.bundle dep
            WHERE d.bundle_id = $1 AND d.dependency_kind = $2
              AND dep.id = d.depends_on_bundle_id
              AND dep.layers_revision = $3
            """,
            uuid_module.UUID(bundle_id),
            kind,
            built_revision,
        )

    async def list_bundle_layers(self: Self, bundle_id: str) -> "list[dict]":
        """Role and layer id of each member layer of a bundle."""
        rows = await self.pool.fetch(
            f"""
            SELECT role, layer_id FROM {self.schema}.bundle_layer
            WHERE bundle_id = $1 ORDER BY id
            """,
            uuid_module.UUID(bundle_id),
        )
        return [dict(r) for r in rows]

    async def add_layer_to_bundle(
        self: Self,
        bundle_id: str,
        layer_id: str,
        role: str | None = None,
    ) -> None:
        """Link a layer to a bundle with its role
        (customer.bundle_layer)."""
        await self.pool.execute(
            f"""
            INSERT INTO {self.schema}.bundle_layer (
                bundle_id, layer_id, role
            ) VALUES ($1, $2, $3)
            """,
            uuid_module.UUID(bundle_id),
            uuid_module.UUID(layer_id),
            role,
        )
        logger.info(f"Linked layer {layer_id} to bundle {bundle_id} as role={role}")

    async def add_to_project(
        self: Self,
        layer_id: str,
        project_id: str,
        name: str,
        properties: dict[str, Any] | None = None,
        other_properties: dict[str, Any] | None = None,
        group_id: int | None = None,
        order: int | None = None,
    ) -> int:
        """Link a layer to a project.

        Creates a record in customer.layer_project and updates the
        project's layer_order to include the new layer at the top.

        Args:
            layer_id: Layer UUID to link
            project_id: Project UUID to link to
            name: Display name for the layer in this project
            properties: Layer properties for this project context
            other_properties: Additional properties
            group_id: Layer group to place the link in (e.g. a bundle-backed
                group); None leaves the layer at the project root
            order: Position in the project's single tree-wide order sequence.
                None keeps the default of 0 and puts the layer at the top of
                layer_order, which is what a tool's output layer wants; giving one
                places the layer at that position and at the bottom instead.

        Returns:
            layer_project_id: The ID of the created link record
        """
        # Validate through Pydantic model before touching the DB
        record = LayerProjectRecord(
            layer_id=uuid_module.UUID(layer_id),
            project_id=uuid_module.UUID(project_id),
            name=name,
            properties=properties,
            other_properties=other_properties,
        )

        properties_json = json.dumps(properties) if properties else None
        other_props_json = json.dumps(other_properties) if other_properties else None

        # Create the layer_project link ("order" is non-nullable)
        row = await self.pool.fetchrow(
            f"""
            INSERT INTO {self.schema}.layer_project (
                layer_id, project_id, name, "order", properties, other_properties,
                layer_project_group_id, created_at, updated_at
            )
            VALUES ($1, $2, $3, $7, $4::jsonb, $5::jsonb, $6, NOW(), NOW())
            RETURNING id
            """,
            record.layer_id,
            record.project_id,
            record.name,
            properties_json,
            other_props_json,
            group_id,
            order if order is not None else 0,
        )
        layer_project_id = row["id"]

        # An explicitly ordered layer belongs at the bottom (it is placing itself
        # below what is already there); otherwise the newest layer goes on top.
        placement = (
            "array_append(COALESCE(layer_order, ARRAY[]::int[]), $1)"
            if order is not None
            else "array_prepend($1, COALESCE(layer_order, ARRAY[]::int[]))"
        )
        await self.pool.execute(
            f"""
            UPDATE {self.schema}.project
            SET layer_order = {placement},
                updated_at = NOW()
            WHERE id = $2
            """,
            layer_project_id,
            uuid_module.UUID(project_id),
        )

        logger.info(
            f"Added layer {layer_id} to project {project_id} "
            f"(layer_project_id={layer_project_id})"
        )
        return layer_project_id

    async def create_bundle_project_group(
        self: Self, project_id: str, bundle_id: str, name: str, member_count: int = 0
    ) -> tuple[int, int]:
        """Create a bundle-backed layer group in a project (locked membership),
        at the top. Returns ``(id, order)`` — the caller needs the order to place
        the members directly beneath it.

        Anything added to a project goes on top, so the project is pushed down to
        make room first: by the group plus every member that will sit under it,
        which is why ``member_count`` is asked for. Groups and layers share one
        tree-wide "order" sequence — the layer panel writes it by flattening the
        whole tree — so both have to move, or the new rows land in among the old
        ones instead of above them.

        The same rule core applies when a bundle is added to a project by hand
        (``crud_layer_project_group.add_bundle``); an upload that arrived at the
        bottom while a manual add arrived at the top would be the panel
        contradicting itself."""
        room = 1 + max(member_count, 0)
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                for table in ("layer_project", "layer_project_group"):
                    await conn.execute(
                        f"UPDATE {self.schema}.{table} "
                        f'SET "order" = "order" + $2 WHERE project_id = $1',
                        uuid_module.UUID(project_id),
                        room,
                    )
                row = await conn.fetchrow(
                    f"""
                    INSERT INTO {self.schema}.layer_project_group (
                        project_id, bundle_id, name, "order", created_at, updated_at
                    )
                    VALUES ($1, $2, $3, 0, NOW(), NOW())
                    RETURNING id, "order"
                    """,
                    uuid_module.UUID(project_id),
                    uuid_module.UUID(bundle_id),
                    name,
                )
        logger.info(
            f"Created bundle group {row['id']} for bundle {bundle_id} "
            f"in project {project_id} at order {row['order']}"
        )
        return row["id"], row["order"]

    async def delete_layer_project_group(self: Self, group_id: int) -> None:
        """Delete a project layer group (cascades its layer_project links). Used
        to roll back a partially-created bundle group on failure."""
        await self.pool.execute(
            f"DELETE FROM {self.schema}.layer_project_group WHERE id = $1",
            int(group_id),
        )

    async def delete_layer(self: Self, layer_id: str) -> None:
        """Delete a layer record from customer.layer.

        Note: This only deletes the metadata. DuckLake data should be
        deleted separately via DuckLakeManager.

        Args:
            layer_id: UUID of the layer to delete
        """
        await self.pool.execute(
            f"DELETE FROM {self.schema}.layer WHERE id = $1",
            uuid_module.UUID(layer_id),
        )
        logger.info(f"Deleted layer: {layer_id}")

    async def get_layer_info(self: Self, layer_id: str) -> dict[str, Any] | None:
        """Get layer information from the database.

        Args:
            layer_id: Layer UUID

        Returns:
            Dict with layer info (id, name, user_id, etc.) or None if not found
        """
        row = await self.pool.fetchrow(
            f"""
            SELECT id, name, user_id, folder_id, type, feature_layer_type,
                   feature_layer_geometry_type, field_config
            FROM {self.schema}.layer
            WHERE id = $1
            """,
            uuid_module.UUID(layer_id),
        )
        if row:
            return {
                "id": str(row["id"]),
                "name": row["name"],
                # NULL for a catalog layer, which belongs to nobody here.
                "user_id": str(row["user_id"]) if row["user_id"] else None,
                "folder_id": str(row["folder_id"]) if row["folder_id"] else None,
                "type": row["type"],
                "feature_layer_type": row["feature_layer_type"],
                "geometry_type": row["feature_layer_geometry_type"],
                # The per-column metadata — computed columns, locked flags,
                # vocabularies, defaults. A copy of a layer is the same kind of
                # layer, so it has to carry these over; without the column here
                # the copy would silently come out with none of them.
                "field_config": _decode_jsonb(row["field_config"]),
            }
        return None

    async def get_project_layer_name_by_id(
        self: Self, layer_project_id: int
    ) -> str | None:
        """Layer name (customer.layer_project.name) by the project-layer PK."""
        row = await self.pool.fetchrow(
            f"SELECT name FROM {self.schema}.layer_project WHERE id = $1",
            int(layer_project_id),
        )
        return row["name"] if row and row["name"] else None
