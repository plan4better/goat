"""Write router for feature CRUD and column management.

All endpoints require authentication and verify layer ownership.
After writes, tile cache and metadata cache are invalidated.
"""

import asyncio
import logging
import threading
from typing import Annotated, Any, cast
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Path
from goatlib.computed_columns import (
    COMPUTED_KIND_REGISTRY,
    is_computed_kind,
    validate_display_config,
)
from goatlib.utils.column_types import type_class
from goatlib.utils.field_config import coerce_allowed_values
from goatlib.utils.generated_fields import (
    GENERATED_STORAGE_TYPES,
    GeneratedField,
    generated_entry_settings,
    is_generated_kind,
)
from pydantic import ValidationError

from geoapi.catalog_events import notify_catalog_changed, refresh_local_pins
from geoapi.dependencies import LayerInfo, LayerInfoDep
from geoapi.deps.auth import get_user_id
from geoapi.models import (
    BulkDeleteRequest,
    BulkDeleteResponse,
    BulkFeatureCreate,
    BulkWriteResponse,
    ColumnCreate,
    ColumnResponse,
    ColumnUpdate,
    DeleteResponse,
    FeatureCreate,
    FeatureReplace,
    FeatureUpdate,
    FeatureWriteResponse,
)
from geoapi.routers.tiles import bump_layer_version
from geoapi.services.computed_columns import (
    fetch_field_config,
    write_field_config,
)
from geoapi.services.feature_write_service import feature_write_service
from geoapi.services.layer_service import LayerMetadata, _metadata_cache, layer_service
from geoapi.services.layer_write_lock import (
    forget_serial_counter,
    layer_write_lock,
    locked_layer_write,
    rename_serial_counter,
)
from geoapi.services.tile_service import tile_service
from geoapi.tile_cache import invalidate_layer_cache

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Features Write"])

# Type alias for required user ID dependency
UserIdDep = Annotated[UUID, Depends(get_user_id)]


async def layer_is_bundle_member(layer_id: str) -> bool:
    """Whether a layer belongs to a bundle."""
    pool = layer_service._pool
    if not pool:
        return False
    row = await pool.fetchrow(
        "SELECT 1 FROM customer.bundle_layer WHERE layer_id = $1::uuid", layer_id
    )
    return row is not None


async def get_write_authorized_metadata(
    layer_info: LayerInfo, user_id: UUID
) -> LayerMetadata:
    """Get layer metadata and verify the user may write to the layer.

    The layer's owner always may. A non-owner may when the layer's owner has
    put it in a project they both edit — see
    ``LayerService.user_can_edit_layer``.

    This is the ONE write-access rule for layer data: the per-feature routes
    add the bundle-member refusal on top (``_get_authorized_metadata``), and
    the bundle batch endpoint builds on this rule directly, so the two cannot
    drift.

    Args:
        layer_info: Layer info from URL
        user_id: Authenticated user ID

    Returns:
        LayerMetadata

    Raises:
        HTTPException: If layer not found or user not authorized
    """
    if not layer_info.writable:
        # A catalog layer is a shared read-only snapshot; no grant can make
        # it writable, so refuse before consulting any.
        raise HTTPException(
            status_code=403,
            detail="Catalog layers are read-only",
        )

    metadata = await layer_service.get_layer_metadata(layer_info)
    if not metadata:
        raise HTTPException(status_code=404, detail="Collection not found")

    # A layer with no owner has no grant chain to derive access from.
    if not metadata.user_id:
        raise HTTPException(
            status_code=403,
            detail="You do not have permission to modify this layer",
        )

    user_id_hex = str(user_id).replace("-", "")
    if metadata.user_id == user_id_hex:
        return metadata

    if not await layer_service.user_can_edit_layer(layer_info.layer_id, user_id):
        raise HTTPException(
            status_code=403,
            detail="You do not have permission to modify this layer",
        )

    return metadata


async def _get_authorized_metadata(
    layer_info: LayerInfo, user_id: UUID
) -> LayerMetadata:
    """Write authorization for the per-feature endpoints: the shared rule plus
    the bundle-member refusal."""
    # A bundle member's edits drive the bundle's derived artifacts, so they go
    # through the bundle's batch endpoint or not at all — a write landing here
    # would leave the routing graph disagreeing with the layer.
    if await layer_is_bundle_member(layer_info.layer_id):
        raise HTTPException(
            status_code=403,
            detail=(
                "This layer is part of a bundle. Edit it through the bundle so its "
                "routing data stays in step."
            ),
        )
    return await get_write_authorized_metadata(layer_info, user_id)


#: Marks a column the user added themselves, as opposed to one the import
#: created. Written by the add-column endpoint; its absence is what protects
#: everything a bundle brought with it — including bundles imported before this
#: existed, which carry no marks and are therefore wholly protected.
USER_ADDED = "user_added"


async def refuse_if_protected(layer_info: LayerInfo, column: str, action: str) -> None:
    """Refuse dropping or renaming a column the bundle owns.

    A bundle's member layers are its contract with the tools that read them —
    a feed's `stop_lat`, an edge's `source_node` — and renaming one removes it
    as surely as dropping it does. Columns the user added carry a mark and are
    theirs to remove; everything else the bundle brought is not.

    Asked per column rather than by listing what is protected, so the answer
    never depends on a column list being current: an unmarked column is
    protected whether or not anything else knows it exists. A layer in no
    bundle protects nothing.
    """
    if not await layer_is_bundle_member(layer_info.layer_id):
        return
    config = await _load_field_config(layer_info)
    if (config.get(column) or {}).get(USER_ADDED):
        return
    raise HTTPException(
        status_code=403,
        detail=(
            f"'{column}' is part of this bundle's data, so it cannot be "
            f"{action}. Columns you add yourself can be."
        ),
    )


def _invalidate_caches(layer_id: str) -> None:
    """Invalidate tile cache and metadata cache for a layer.

    Both caches are Redis-backed (cross-pod by definition), so a single
    pod's invalidation is immediately visible to every other pod's next
    read.
    """
    # Invalidate tile cache (Redis)
    invalidate_layer_cache(layer_id)

    # Invalidate layer-metadata cache (Redis when available, in-process
    # fallback otherwise — both keys popped here)
    layer_id_clean = layer_id.replace("-", "")
    _metadata_cache.pop(layer_id_clean, None)
    _metadata_cache.pop(layer_id, None)

    # Bump in-memory version so dynamic tile ETags change. This is a
    # per-pod hint used only for ETag freshness; PMTiles existence (the
    # real source of truth) lives on the shared volume.
    bump_layer_version(layer_id)

    # DuckLake reads are snapshot-pinned; bump local pins and nudge other pods
    notify_catalog_changed()

    logger.debug("Caches invalidated for layer %s", layer_id)


async def _load_field_config(layer_info: LayerInfo) -> dict[str, Any]:
    """Fetch the layer's field_config JSONB from PG.

    Returns an empty dict if no PG pool is initialised (dev/test path).
    Genuine connection errors propagate so the caller fails the request
    rather than silently writing NULL into computed columns.
    """
    pool = layer_service._pool
    if not pool:
        return {}
    async with pool.acquire() as conn:
        return await fetch_field_config(
            cast("asyncpg.Connection[asyncpg.Record]", conn),
            UUID(layer_info.layer_id),
        )


def _duckdb_type_to_kind(duckdb_type: str) -> str:
    """Map a formula's inferred DuckDB result type to a public field kind."""
    cls = type_class(duckdb_type)
    if cls in ("date", "datetime"):
        return "datetime"
    if cls in ("integer", "number"):
        return "number"
    return "boolean" if cls == "boolean" else "string"


async def _validate_and_infer_formula(
    layer_info: LayerInfo,
    metadata: "LayerMetadata",
    formula: str,
    exclude_column: str | None = None,
) -> tuple[list[str], str, str]:
    """Validate a formula expression and infer its result type.

    Returns (referenced_columns, duckdb_type, output_kind). Raises 400 on any
    validation failure — this is the only gate between user input and SQL
    spliced into UPDATE statements, so nothing invalid may pass.

    ``exclude_column`` removes the formula column itself from the allowed
    column set when editing, so a formula cannot reference itself.
    """
    from goatlib.utils.expressions import ExpressionEvaluator, ExpressionValidator
    from goatlib.utils.expressions.evaluator import AGGREGATE_FUNCTIONS

    from geoapi.ducklake_pool import ducklake_pool

    column_names = [c for c in metadata.column_names if c != exclude_column]
    validator = ExpressionValidator(
        column_names=column_names,
        geometry_column=metadata.geometry_column,
        column_types=metadata.column_types,
    )
    result = validator.validate(formula)
    if not result.valid:
        messages = "; ".join(e.message for e in result.errors) or "invalid expression"
        raise HTTPException(status_code=400, detail=f"Invalid formula: {messages}")

    # Aggregates without OVER() collapse rows — meaningless as a per-row value
    # and invalid SQL inside UPDATE ... SET.
    uses_aggregate = any(
        fn.lower() in AGGREGATE_FUNCTIONS for fn in result.used_functions
    )
    if uses_aggregate and "over" not in formula.lower():
        raise HTTPException(
            status_code=400,
            detail="Invalid formula: aggregate functions require an OVER() clause",
        )

    def _infer() -> str | None:
        with ducklake_pool.connection() as con:
            evaluator = ExpressionEvaluator(
                con=con,
                table_name=layer_info.full_table_name,
                column_names=column_names,
                geometry_column=metadata.geometry_column or "geometry",
            )
            return evaluator.infer_type(formula)

    duckdb_type = await asyncio.to_thread(_infer)
    if not duckdb_type:
        raise HTTPException(
            status_code=400,
            detail="Could not determine the formula's result type",
        )
    lowered = duckdb_type.lower()
    if any(x in lowered for x in ("geometry", "struct", "list", "map", "[]")):
        raise HTTPException(
            status_code=400,
            detail=f"Formula result type '{duckdb_type}' is not supported",
        )
    return (
        sorted(result.referenced_columns),
        duckdb_type,
        _duckdb_type_to_kind(duckdb_type),
    )


async def _settle_schema_caches(layer_id: str) -> None:
    """Make column DDL immediately visible to schema reads.

    ``_invalidate_caches`` pops the layer-metadata cache but bumps the
    snapshot pins on a background thread — a queryables request racing that
    refresh re-caches the pre-DDL column set for the full TTL (it survives
    page reloads, and the *next* DDL then surfaces the *previous* change).
    Refresh this pod's pins synchronously so the next read resolves the new
    schema, re-pop the cache in case a racing read already poisoned it, and
    pop once more after the poll window so an entry cached by another pod
    (whose pins refresh asynchronously) clears as well.
    """
    from geoapi.config import settings

    await asyncio.to_thread(refresh_local_pins)

    layer_id_clean = layer_id.replace("-", "")

    def _pop() -> None:
        _metadata_cache.pop(layer_id_clean, None)
        _metadata_cache.pop(layer_id, None)

    _pop()
    timer = threading.Timer(settings.DUCKLAKE_SNAPSHOT_REFRESH_SECONDS + 1.0, _pop)
    timer.daemon = True
    timer.start()


async def _invalidate_caches_and_pmtiles(layer_info: LayerInfo) -> None:
    """Invalidate all caches and delete PMTiles for a layer.

    Used after schema changes (add/rename/delete column) which don't
    increment the DuckLake snapshot, so stale PMTiles would keep being served.
    Deleting the PMTiles forces fallback to dynamic tile generation.
    Also updates the layer's updated_at timestamp in core PostgreSQL.
    """
    _invalidate_caches(layer_info.layer_id)

    # Delete PMTiles file + anchor file so tiles fall back to dynamic generation
    pmtiles_path = tile_service._get_pmtiles_path(layer_info)
    anchor_path = pmtiles_path.with_name(
        pmtiles_path.stem + "_anchor" + pmtiles_path.suffix
    )
    for path in (pmtiles_path, anchor_path):
        if path.exists():
            path.unlink()
            logger.info("Deleted %s for layer %s", path.name, layer_info.layer_id)

    # Invalidate PMTiles path and existence caches
    tile_service.invalidate_pmtiles_path_cache(layer_info.layer_id)
    tile_service.invalidate_pmtiles_cache(layer_info.schema_name, layer_info.table_name)

    # Update updated_at in core PostgreSQL so clients know the layer changed.
    # Both layer and layer_project must be updated because the frontend reads
    # updated_at from the project layers endpoint (which joins layer_project).
    try:
        pool = layer_service._pool
        if pool:
            layer_uuid = layer_info.layer_id
            # Normalize to UUID format if needed
            if "-" not in layer_uuid and len(layer_uuid) == 32:
                layer_uuid = f"{layer_uuid[:8]}-{layer_uuid[8:12]}-{layer_uuid[12:16]}-{layer_uuid[16:20]}-{layer_uuid[20:]}"
            await pool.execute(
                "UPDATE customer.layer SET updated_at = NOW() WHERE id = $1::uuid",
                layer_uuid,
            )
            await pool.execute(
                "UPDATE customer.layer_project SET updated_at = NOW() WHERE layer_id = $1::uuid",
                layer_uuid,
            )
            logger.debug("Updated updated_at for layer %s", layer_info.layer_id)
    except Exception as e:
        logger.warning("Failed to update layer updated_at: %s", e)


# --- Feature CRUD Endpoints ---


@router.post(
    "/collections/{collectionId}/items",
    summary="Create feature(s)",
    response_model=FeatureWriteResponse | BulkWriteResponse,
    status_code=201,
)
async def create_features(
    layer_info: LayerInfoDep,
    user_id: UserIdDep,
    body: FeatureCreate | BulkFeatureCreate,
) -> FeatureWriteResponse | BulkWriteResponse:
    """Create one or more features in a collection.

    Accepts a single GeoJSON Feature or a FeatureCollection for bulk creation.

    Generated columns (serial, uuid) are filled by the server; a value the
    request sends for one is ignored. The write holds the layer's advisory
    lock, reads the column definitions under it, and advances each serial
    column's high-water mark, so no number is handed out twice — across pods,
    after the feature holding the highest one is deleted, and while a column
    is being turned into a serial.
    """
    metadata = await _get_authorized_metadata(layer_info, user_id)

    try:
        if isinstance(body, BulkFeatureCreate):
            # Bulk creation
            features_data = [
                {"geometry": f.geometry, "properties": f.properties}
                for f in body.features
            ]
            async with locked_layer_write(layer_info.layer_id) as write:
                ids = feature_write_service.create_features_bulk(
                    layer_info=layer_info,
                    features=features_data,
                    column_names=metadata.column_names,
                    geometry_column=metadata.geometry_column,
                    field_config=write.field_config,
                    serial_counters=write.counters,
                )
            await _invalidate_caches_and_pmtiles(layer_info)
            return BulkWriteResponse(ids=ids, count=len(ids))
        else:
            # Single creation
            async with locked_layer_write(layer_info.layer_id) as write:
                feature_id = feature_write_service.create_feature(
                    layer_info=layer_info,
                    geometry=body.geometry,
                    properties=body.properties,
                    column_names=metadata.column_names,
                    geometry_column=metadata.geometry_column,
                    field_config=write.field_config,
                    serial_counters=write.counters,
                )
            await _invalidate_caches_and_pmtiles(layer_info)
            return FeatureWriteResponse(id=feature_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Create feature error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create feature: {e}")


@router.patch(
    "/collections/{collectionId}/items/{itemId}",
    summary="Update feature properties",
    response_model=FeatureWriteResponse,
)
async def update_feature(
    layer_info: LayerInfoDep,
    user_id: UserIdDep,
    body: FeatureUpdate,
    itemId: str = Path(..., description="Feature ID"),
) -> FeatureWriteResponse:
    """Update properties of a feature (partial update).

    Under the layer's lock, like a create, so a column being turned into a
    serial cannot be given a duplicate value behind the conversion's back.
    """
    metadata = await _get_authorized_metadata(layer_info, user_id)

    try:
        async with locked_layer_write(layer_info.layer_id) as write:
            found = feature_write_service.update_feature_properties(
                layer_info=layer_info,
                feature_id=itemId,
                properties=body.properties,
                column_names=metadata.column_names,
                field_config=write.field_config,
            )
        if not found:
            raise HTTPException(status_code=404, detail="Feature not found")
        await _invalidate_caches_and_pmtiles(layer_info)
        return FeatureWriteResponse(id=itemId, message="updated")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Update feature error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update feature: {e}")


@router.put(
    "/collections/{collectionId}/items/{itemId}",
    summary="Replace feature",
    response_model=FeatureWriteResponse,
)
async def replace_feature(
    layer_info: LayerInfoDep,
    user_id: UserIdDep,
    body: FeatureReplace,
    itemId: str = Path(..., description="Feature ID"),
) -> FeatureWriteResponse:
    """Replace a feature entirely (geometry + properties). Under the layer's
    lock, for the same reason as an update."""
    metadata = await _get_authorized_metadata(layer_info, user_id)

    try:
        async with locked_layer_write(layer_info.layer_id) as write:
            found = feature_write_service.replace_feature(
                layer_info=layer_info,
                feature_id=itemId,
                geometry=body.geometry,
                properties=body.properties,
                column_names=metadata.column_names,
                geometry_column=metadata.geometry_column,
                field_config=write.field_config,
            )
        if not found:
            raise HTTPException(status_code=404, detail="Feature not found")
        await _invalidate_caches_and_pmtiles(layer_info)
        return FeatureWriteResponse(id=itemId, message="replaced")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Replace feature error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to replace feature: {e}")


@router.delete(
    "/collections/{collectionId}/items/{itemId}",
    summary="Delete feature",
    response_model=DeleteResponse,
)
async def delete_feature(
    layer_info: LayerInfoDep,
    user_id: UserIdDep,
    itemId: str = Path(..., description="Feature ID"),
) -> DeleteResponse:
    """Delete a single feature by rowid."""
    await _get_authorized_metadata(layer_info, user_id)

    try:
        found = feature_write_service.delete_feature(
            layer_info=layer_info,
            feature_id=itemId,
        )
        if not found:
            raise HTTPException(status_code=404, detail="Feature not found")
        await _invalidate_caches_and_pmtiles(layer_info)
        return DeleteResponse(id=itemId)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Delete feature error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete feature: {e}")


@router.post(
    "/collections/{collectionId}/items/delete",
    summary="Bulk delete features",
    response_model=BulkDeleteResponse,
)
async def bulk_delete_features(
    layer_info: LayerInfoDep,
    user_id: UserIdDep,
    body: BulkDeleteRequest,
) -> BulkDeleteResponse:
    """Delete multiple features by rowid."""
    await _get_authorized_metadata(layer_info, user_id)

    try:
        count = feature_write_service.delete_features_bulk(
            layer_info=layer_info,
            feature_ids=body.ids,
        )
        await _invalidate_caches_and_pmtiles(layer_info)
        return BulkDeleteResponse(count=count)
    except Exception as e:
        logger.error("Bulk delete error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete features: {e}")


# --- Column Management Endpoints ---


def _resolve_kind_to_sql(
    kind: str | None,
    legacy_type: str | None,
    geometry_type: str | None,
) -> tuple[str, str | None, list[str], bool]:
    """Resolve (duckdb_type, compute_sql_or_None, depends_on, is_computed).

    For computed `kind`s, validates the geometry type and returns the
    spheroid SQL fragment. For plain `kind`s ("string"/"number"), returns
    the obvious DuckDB type with no compute SQL. If `kind` is None, falls
    back to the legacy `type` string (no display_config / not computed).
    """
    if kind is not None:
        if is_computed_kind(kind):
            spec = COMPUTED_KIND_REGISTRY[kind]
            geom = (geometry_type or "").lower()
            if geom not in spec.allowed_geom_types:
                raise ValueError(
                    f"Kind '{kind}' is not allowed on geometry type '{geom or None}'"
                )
            return spec.duckdb_type, spec.compute_sql(), list(spec.depends_on), True
        if kind == "number":
            return "DOUBLE", None, [], False
        if kind == "string":
            return "VARCHAR", None, [], False
        if kind == "datetime":
            return "TIMESTAMP WITH TIME ZONE", None, [], False
        if kind == "boolean":
            return "BOOLEAN", None, [], False
        if is_generated_kind(kind):
            # Filled by the writer on every create and backfilled once by
            # add_column — no compute SQL, and not "computed": nothing
            # recomputes it when the row changes.
            return GENERATED_STORAGE_TYPES[kind], None, [], False
        if kind == "formula":
            # Formula columns carry a per-column expression and are resolved
            # in the add_column/update_column formula flow, never here.
            raise ValueError("kind='formula' requires the formula flow")
        raise ValueError(f"Unknown kind: {kind!r}")
    if legacy_type is not None:
        # Reuse the existing _resolve_duckdb_type via the service path.
        # It raises on unknown types.
        from geoapi.services.feature_write_service import _resolve_duckdb_type

        return _resolve_duckdb_type(legacy_type), None, [], False
    raise ValueError("Either 'kind' or 'type' must be supplied")


@router.post(
    "/collections/{collectionId}/columns",
    summary="Add column",
    response_model=ColumnResponse,
    status_code=201,
)
async def add_column(
    layer_info: LayerInfoDep,
    user_id: UserIdDep,
    body: ColumnCreate,
) -> ColumnResponse:
    """Add a new column to a collection.

    Accepts either ``kind`` (preferred — string/number/area/perimeter/length
    plus optional ``display_config``) or the legacy ``type`` string. For
    computed kinds, the column is auto-backfilled from existing geometry
    via ``ST_*_Spheroid`` and the field metadata is persisted under
    ``customer.layer.field_config``.

    Allowed on a bundle member, unlike the per-feature routes: a new column is
    additive, so nothing a bundle already reads changes. It is marked as the
    user's, which is what later lets it be dropped again while the bundle's own
    columns cannot be.
    """
    metadata = await get_write_authorized_metadata(layer_info, user_id)

    try:
        output_kind: str | None = None
        if body.kind == "formula":
            if not body.formula or not body.formula.strip():
                raise HTTPException(
                    status_code=400,
                    detail="kind='formula' requires a formula expression",
                )
            depends_on, duckdb_type, output_kind = await _validate_and_infer_formula(
                layer_info, metadata, body.formula
            )
            compute_sql = f"({body.formula})"
            computed = True
            # Formula display config follows the *result* kind (a numeric
            # formula gets number formatting options, etc.)
            cfg_kind: str | None = output_kind
        else:
            duckdb_type, compute_sql, depends_on, computed = _resolve_kind_to_sql(
                body.kind, body.type, metadata.geometry_type
            )
            cfg_kind = body.kind

        # Validate display_config for the kind (only when kind is supplied)
        if cfg_kind is not None:
            try:
                validated_cfg = validate_display_config(
                    cfg_kind, body.display_config
                ).model_dump()
            except (ValueError, ValidationError) as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
        else:
            validated_cfg = body.display_config or {}

        # Coerced before the DDL, with everything else that can be refused: the
        # ALTER TABLE below is not part of the field_config transaction, so a
        # 400 raised after it would leave a real DuckDB column with no entry
        # describing it and the client's corrected retry would fail with
        # "column already exists".
        coerced_allowed_values: list[Any] | None = None
        if body.allowed_values and body.kind is not None:
            if is_generated_kind(body.kind):
                raise ValueError(
                    "A field that is filled automatically cannot have allowed values."
                )
            coerced_allowed_values = coerce_allowed_values(
                cfg_kind, body.allowed_values
            )
        generated_settings: dict[str, Any] | None = None
        if is_generated_kind(body.kind):
            if body.default_value is not None:
                raise ValueError(
                    "A field that is filled automatically cannot have a default value."
                )
            generated_settings = generated_entry_settings(str(body.kind), body.start)
        elif body.start is not None:
            raise ValueError("Only a serial field has a start value.")

        feature_write_service.add_column_with_sql(
            layer_info=layer_info,
            name=body.name,
            duckdb_type=duckdb_type,
            compute_sql=compute_sql,
            default_value=body.default_value,
        )

        # Persist field_config entry.
        #
        # The provenance mark is recorded only for a bundle member, which is
        # the only place it is read: on an ordinary layer every column is the
        # user's to drop, so storing it there would be a fact nothing asks.
        #
        # Safe to decide once, here, because a layer cannot join a bundle
        # later: the only two writers of `bundle_layer` create the layer as
        # they add it (an import, and a filtered copy — which carries the
        # source layer's marks across with its field_config).
        #
        # Written for a legacy `type` too, where there is no kind to record:
        # the entry carries the mark, and a column created without one could
        # not be deleted again by the person who created it.
        pool = layer_service._pool
        if pool:
            entry: dict[str, Any] = {}
            if await layer_is_bundle_member(layer_info.layer_id):
                entry[USER_ADDED] = True
            if body.kind is not None:
                entry.update(
                    {
                        "kind": body.kind,
                        "is_computed": computed,
                        "depends_on": depends_on,
                        "display_config": validated_cfg,
                    }
                )
            if body.kind == "formula":
                entry["formula"] = body.formula
                entry["output_kind"] = output_kind
            if generated_settings is not None:
                entry.update(generated_settings)
            if coerced_allowed_values is not None:
                entry["allowed_values"] = coerced_allowed_values
                entry["allow_other"] = body.allow_other
            if body.default_value is not None:
                # Two stores, one authority. The ALTER TABLE above set a DuckDB
                # column DEFAULT, which backfilled existing rows and would also
                # cover an INSERT that omitted the column — but nothing relies
                # on that: `apply_defaults` fills the column explicitly before
                # every write, and only this entry is read to do so, or to show
                # the user what they are about to get. So `field_config` is the
                # default of record; the DDL default is a leftover of creating
                # the column and is deliberately not kept in step by
                # `update_column`, which is why that endpoint touches only this.
                entry["default_value"] = body.default_value
            # Nothing to record: a legacy `type` column on an ordinary layer
            # has neither a kind to describe nor a mark to carry, and an empty
            # entry would say less than no entry while looking like a fact.
            if entry:
                async with pool.acquire() as conn:
                    conn = cast("asyncpg.Connection[asyncpg.Record]", conn)
                    current = await fetch_field_config(conn, UUID(layer_info.layer_id))
                    current[body.name] = entry
                    await write_field_config(conn, layer_info.layer_id, current)

        if generated_settings is not None:
            # Filled after the entry is written, so every create from here on
            # assigns values itself, and under the layer's lock, so the
            # numbering cannot interleave with one. A feature created while
            # the column had no entry yet is repaired by the next create
            # (``GeneratedValues`` fills blanks first).
            #
            # A new column starts over: whatever mark a dropped column of the
            # same name left behind is forgotten first, and the last number
            # the backfill hands out becomes the new column's mark.
            field = GeneratedField(
                name=body.name,
                kind=str(body.kind),
                start=generated_settings.get("start", 1),
            )
            async with layer_write_lock(
                layer_info.layer_id,
                {body.name: {"kind": body.kind}},
                reset=[body.name],
            ) as counters:
                feature_write_service.backfill_generated_column(
                    layer_info, field, counters
                )

        await _invalidate_caches_and_pmtiles(layer_info)
        await _settle_schema_caches(layer_info.layer_id)
        return ColumnResponse(name=body.name, type=body.kind or body.type or "")
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Add column error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to add column: {e}")


@router.patch(
    "/collections/{collectionId}/columns/{columnName}",
    summary="Update column (rename and/or display config)",
    response_model=ColumnResponse,
)
async def update_column(
    layer_info: LayerInfoDep,
    user_id: UserIdDep,
    body: ColumnUpdate,
    columnName: str = Path(..., description="Current column name"),
) -> ColumnResponse:
    """Rename a column and/or update its display config or formula.

    A bundle member's column may be reformatted or given a vocabulary — those
    describe the column without changing what it is called. Renaming one the
    bundle brought is refused: every tool that reads the layer looks the column
    up by name.

    ``kind`` changes what a column is, on its own: a number column becomes a
    serial (``_convert_column_kind``) or a serial goes back to a number.
    """
    metadata = await get_write_authorized_metadata(layer_info, user_id)
    if body.kind is not None or body.start is not None:
        return await _convert_column_kind(layer_info, metadata, body, columnName)
    if body.new_name:
        await refuse_if_protected(layer_info, columnName, "renamed")

    try:
        if (
            not body.new_name
            and body.display_config is None
            and body.formula is None
            and body.allowed_values is None
            and body.allow_other is None
            and body.default_value is None
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    "No update specified (provide new_name, display_config, "
                    "formula, allowed_values and/or default_value)"
                ),
            )

        # Formula edit: validate, re-infer the result type, and recompute the
        # whole column. A type change replaces the column (drop + add).
        formula_update: dict[str, Any] | None = None
        if body.formula is not None:
            pool = layer_service._pool
            current_entry: dict[str, Any] = {}
            if pool:
                async with pool.acquire() as conn:
                    conn = cast("asyncpg.Connection[asyncpg.Record]", conn)
                    config = await fetch_field_config(conn, UUID(layer_info.layer_id))
                    current_entry = dict(config.get(columnName, {}))
            if current_entry.get("kind") != "formula":
                raise HTTPException(
                    status_code=400,
                    detail=f"Column '{columnName}' is not a formula column",
                )
            depends_on, duckdb_type, output_kind = await _validate_and_infer_formula(
                layer_info, metadata, body.formula, exclude_column=columnName
            )
            compute_sql = f"({body.formula})"
            current_types = feature_write_service.get_column_types(layer_info)
            if current_types.get(columnName, "").upper() == duckdb_type.upper():
                feature_write_service.backfill_column(
                    layer_info, columnName, compute_sql
                )
            else:
                # Result type changed: replace the column. Note the column
                # moves to the end of the physical column order.
                feature_write_service.delete_column(layer_info, columnName)
                feature_write_service.add_column_with_sql(
                    layer_info=layer_info,
                    name=columnName,
                    duckdb_type=duckdb_type,
                    compute_sql=compute_sql,
                )
            formula_update = {
                "formula": body.formula,
                "depends_on": depends_on,
                "output_kind": output_kind,
                "kind_changed": output_kind != current_entry.get("output_kind"),
            }

        # Apply DDL rename if requested
        if body.new_name:
            # Formula expressions reference columns by name as text; renaming
            # a referenced column would silently break them on the next write.
            config = await _load_field_config(layer_info)
            dependents = [
                name
                for name, entry in config.items()
                if name != columnName
                and entry.get("kind") == "formula"
                and columnName in (entry.get("depends_on") or [])
            ]
            if dependents:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Column '{columnName}' is used by formula column(s): "
                        f"{', '.join(sorted(dependents))}. Update those formulas first."
                    ),
                )
            feature_write_service.rename_column(
                layer_info=layer_info,
                old_name=columnName,
                new_name=body.new_name,
            )
            # A renamed serial column keeps counting from where it was; the
            # old name is free for a new column that starts over.
            if (config.get(columnName) or {}).get("kind") == "serial":
                await rename_serial_counter(
                    layer_info.layer_id, columnName, body.new_name
                )

        # Apply JSONB updates: rename key, update display_config
        pool = layer_service._pool
        if pool:
            async with pool.acquire() as conn:
                conn = cast("asyncpg.Connection[asyncpg.Record]", conn)
                current = await fetch_field_config(conn, UUID(layer_info.layer_id))
                key = columnName
                entry = dict(current.get(key, {}))

                if body.new_name and body.new_name != columnName:
                    current.pop(key, None)
                    key = body.new_name

                if formula_update is not None:
                    entry["formula"] = formula_update["formula"]
                    entry["depends_on"] = formula_update["depends_on"]
                    entry["output_kind"] = formula_update["output_kind"]
                    entry.setdefault("kind", "formula")
                    entry.setdefault("is_computed", True)
                    if formula_update["kind_changed"]:
                        # The old formatting options belong to the old result
                        # kind (e.g. number formatting on what is now a
                        # string) — reset to the new kind's defaults.
                        entry["display_config"] = validate_display_config(
                            formula_update["output_kind"], None
                        ).model_dump()

                def config_kind() -> str:
                    """The kind a display_config or a vocabulary is read against.

                    Prefers the JSONB entry, and infers from the actual DuckDB
                    column type when the column has no entry yet — the common
                    case, since an entry is only written when someone edits the
                    column's definition. Shared by both branches below: a
                    vocabulary coerced against ``None`` would store a number
                    column's values as strings, and the strict ``in`` in
                    ``validate_allowed_values`` would then refuse every value
                    the editor offers.
                    """
                    kind = entry.get("kind")
                    if not kind:
                        col_types = feature_write_service.get_column_types(layer_info)
                        # The rename above has already landed, so the column
                        # answers to its new name by now.
                        duckdb_type = col_types.get(body.new_name or columnName, "")
                        json_type = layer_service._duckdb_to_json_type(duckdb_type)
                        kind = (
                            "number" if json_type in ("number", "integer") else "string"
                        )
                        entry["kind"] = kind
                        entry.setdefault("is_computed", False)
                        entry.setdefault("depends_on", [])
                    # A formula's own config follows its *result* kind, not
                    # "formula" itself.
                    if kind == "formula":
                        return str(entry.get("output_kind", "string"))
                    return str(kind)

                if body.display_config is not None:
                    cfg_kind = config_kind()
                    try:
                        entry["display_config"] = validate_display_config(
                            cfg_kind, body.display_config
                        ).model_dump()
                    except (ValueError, ValidationError) as e:
                        raise HTTPException(status_code=400, detail=str(e)) from e

                if is_generated_kind(entry.get("kind")) and (
                    body.default_value is not None or body.allowed_values
                ):
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"'{columnName}' is filled automatically, so it "
                            "cannot have a default value or allowed values."
                        ),
                    )

                if body.default_value is not None:
                    # Only what future features get. Rewriting rows that already
                    # hold a value is not what changing a default means, and the
                    # column's DDL default is left alone for the same reason —
                    # `field_config` is the default of record (see add_column).
                    if body.default_value == "":
                        # An empty string removes the default rather than
                        # making the blank itself the default.
                        entry.pop("default_value", None)
                    else:
                        entry["default_value"] = body.default_value

                if body.allowed_values is not None:
                    # An empty list removes the vocabulary, leaving the column
                    # free text again. Values already stored outside the new
                    # list are left alone: the constraint governs what may be
                    # written from now on, and rewriting a column's data is not
                    # what editing its definition means.
                    if body.allowed_values:
                        # Against the column's own kind, which the server
                        # resolves (entry, else the DuckDB type) because the
                        # request does not carry it.
                        entry["allowed_values"] = coerce_allowed_values(
                            config_kind(), body.allowed_values
                        )
                        entry["allow_other"] = bool(body.allow_other)
                    else:
                        entry.pop("allowed_values", None)
                        entry.pop("allow_other", None)
                elif body.allow_other is not None and entry.get("allowed_values"):
                    entry["allow_other"] = body.allow_other

                if entry:
                    current[key] = entry
                await write_field_config(conn, layer_info.layer_id, current)

        # Only invalidate tile/metadata caches + PMTiles when the column's
        # name or data changed. A display_config-only edit doesn't touch any
        # data or schema in DuckLake, so existing tiles stay valid.
        if body.new_name or formula_update is not None:
            await _invalidate_caches_and_pmtiles(layer_info)
            await _settle_schema_caches(layer_info.layer_id)
        final_name = body.new_name or columnName
        msg = "renamed" if body.new_name else "updated"
        return ColumnResponse(name=final_name, type="", message=msg)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Update column error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update column: {e}")


#: Kinds a column's values are derived from, never typed — none of them can be
#: turned into a serial, which needs values of its own.
_DERIVED_KINDS = frozenset({"area", "perimeter", "length", "formula"})


async def _convert_column_kind(
    layer_info: LayerInfo,
    metadata: LayerMetadata,
    body: ColumnUpdate,
    column: str,
) -> ColumnResponse:
    """Turn a number column into a serial, or a serial back into a number.

    The real case: a hand-typed project number that workflows, filters and
    dashboards already reference by name. Converting keeps the name and every
    value; blank rows get numbers after the highest one; the high-water mark
    starts at the highest value, so new features continue after it and a gap
    (a deleted 18) is never filled. Refused — before anything changes — for a
    duplicate, a fraction, a non-number column, a derived or locked column,
    and any column of a bundle member, whose writes go through the bundle
    editor.

    Runs under ``locked_layer_write``, the lock every create and update takes
    before reading the column definitions, and stores the new definition on
    the lock's own connection before releasing it. So a concurrent write either
    finished before the checks looked at the column, or sees the serial.

    Back to ``number`` drops the mark; the values and the BIGINT storage stay.
    """
    others = [
        name
        for name, value in (
            ("new_name", body.new_name),
            ("display_config", body.display_config),
            ("formula", body.formula),
            ("allowed_values", body.allowed_values),
            ("allow_other", body.allow_other),
            ("default_value", body.default_value),
        )
        if value is not None
    ]
    if others:
        raise HTTPException(
            status_code=400,
            detail=(
                "Change a column's kind on its own, not together with "
                f"{', '.join(others)}."
            ),
        )
    if body.kind not in ("serial", "number"):
        raise HTTPException(
            status_code=400,
            detail=(
                "Only a number column can be turned into a serial number, and a "
                "serial number back into a number"
                + (f"; '{body.kind}' is not supported." if body.kind else ".")
            ),
        )
    if body.kind == "number" and body.start is not None:
        raise HTTPException(status_code=400, detail="Only a serial has a start value.")
    if await layer_is_bundle_member(layer_info.layer_id):
        raise HTTPException(
            status_code=403,
            detail=(
                "Columns of a layer that is part of a bundle cannot change their "
                "kind; the bundle's editor writes them."
            ),
        )
    if column not in metadata.column_names:
        raise HTTPException(status_code=404, detail=f"Column '{column}' not found")

    try:
        start = generated_entry_settings("serial", body.start)["start"]
        async with locked_layer_write(layer_info.layer_id, reset=[column]) as write:
            entry = dict(write.field_config.get(column) or {})
            kind = entry.get("kind")
            if body.kind == "serial":
                if kind == "serial":
                    raise HTTPException(
                        status_code=400, detail=f"'{column}' is already a serial."
                    )
                if kind in _DERIVED_KINDS or entry.get("is_computed"):
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"'{column}' is calculated by GOAT, so it cannot "
                            "become a serial number."
                        ),
                    )
                if entry.get("is_locked") or kind == "uuid":
                    raise HTTPException(
                        status_code=400,
                        detail=f"'{column}' cannot become a serial number.",
                    )
                result = feature_write_service.convert_to_serial(
                    layer_info,
                    GeneratedField(name=column, kind="serial", start=start),
                    write.counters,
                )
                # Merged into what the entry already says. Its display_config
                # stays as it was: a serial is shown as stored and ignores it,
                # and converting back to a number gets the formatting back. A
                # vocabulary or default would fight the numbering and goes.
                for stale in ("allowed_values", "allow_other", "default_value"):
                    entry.pop(stale, None)
                entry.update(
                    {
                        "kind": "serial",
                        "start": start,
                        "is_computed": False,
                        "depends_on": entry.get("depends_on") or [],
                        "display_config": entry.get("display_config") or {},
                    }
                )
                message = (
                    f"converted; {result['filled']} blank row(s) numbered"
                    if result["filled"]
                    else "converted"
                )
            else:
                if kind != "serial":
                    raise HTTPException(
                        status_code=400, detail=f"'{column}' is not a serial."
                    )
                # The mark was forgotten as the lock was taken (``reset``).
                entry.pop("start", None)
                entry["kind"] = "number"
                entry.setdefault("display_config", {})
                message = "converted"
            if write.conn is not None:
                current = await fetch_field_config(
                    write.conn, UUID(layer_info.layer_id)
                )
                current[column] = entry
                await write_field_config(write.conn, layer_info.layer_id, current)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Convert column error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to convert column: {e}")

    await _invalidate_caches_and_pmtiles(layer_info)
    await _settle_schema_caches(layer_info.layer_id)
    return ColumnResponse(name=column, type=str(body.kind), message=message)


@router.delete(
    "/collections/{collectionId}/columns/{columnName}",
    summary="Delete column",
    response_model=ColumnResponse,
)
async def delete_column(
    layer_info: LayerInfoDep,
    user_id: UserIdDep,
    columnName: str = Path(..., description="Column name to delete"),
) -> ColumnResponse:
    """Delete a column from a collection."""
    await get_write_authorized_metadata(layer_info, user_id)
    await refuse_if_protected(layer_info, columnName, "deleted")

    try:
        # A formula referencing this column would break on every subsequent
        # write — require deleting (or editing) the formula first.
        config = await _load_field_config(layer_info)
        dependents = [
            name
            for name, entry in config.items()
            if name != columnName
            and entry.get("kind") == "formula"
            and columnName in (entry.get("depends_on") or [])
        ]
        if dependents:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Column '{columnName}' is used by formula column(s): "
                    f"{', '.join(sorted(dependents))}. Update or delete those first."
                ),
            )

        feature_write_service.delete_column(
            layer_info=layer_info,
            name=columnName,
        )
        # Its high-water mark goes with it, so a column added later under the
        # same name starts at its own start rather than after this one's last.
        await forget_serial_counter(layer_info.layer_id, columnName)

        # Remove the JSONB entry as well
        pool = layer_service._pool
        if pool:
            async with pool.acquire() as conn:
                conn = cast("asyncpg.Connection[asyncpg.Record]", conn)
                current = await fetch_field_config(conn, UUID(layer_info.layer_id))
                if columnName in current:
                    current.pop(columnName)
                    await write_field_config(conn, layer_info.layer_id, current)

        await _invalidate_caches_and_pmtiles(layer_info)
        await _settle_schema_caches(layer_info.layer_id)
        return ColumnResponse(name=columnName, type="", message="deleted")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Delete column error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete column: {e}")
