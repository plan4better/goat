"""Promoting catalog items into shared layers and bundles, for the catalog add and the catalog update."""

import json
import uuid as uuid_module
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID

import asyncpg
from core.core.config import settings
from core.services.materialize_heal import copy_on_disk, decide_heal
from fastapi import HTTPException, status
from goatlib.catalog import promote as catalog
from goatlib.config.postgres import asyncpg_connect_args
from goatlib.models.bundle import BundleTypeName
from goatlib.utils.credentials import postgres_uri
from starlette.concurrency import run_in_threadpool


def catalog_mirror() -> Path:
    """The catalog mirror's items file; 503 where this deployment has none."""
    mirror = Path(settings.CATALOG_DATA_DIR) / "mirror_items.parquet"
    if not mirror.exists():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Catalog mirror is not available on this deployment",
        )
    return mirror


async def catalog_connection() -> asyncpg.Connection:
    """Promote writes with goatlib (shared with the workers), so it speaks plain
    asyncpg; a promote is rare, so one short-lived connection is fine."""
    dsn = postgres_uri(
        settings.POSTGRES_USER,
        settings.POSTGRES_PASSWORD,
        settings.POSTGRES_SERVER,
        settings.POSTGRES_PORT,
        settings.POSTGRES_DB,
    )
    return await asyncpg.connect(
        dsn, **asyncpg_connect_args("goat-core", settings.POSTGRES_TRANSACTION_POOLER)
    )


@dataclass
class PromotedItems:
    layer_ids: dict[str, UUID] = field(default_factory=dict)
    """Every promoted item's shared layer, by item id."""
    link_layer_ids: list[UUID] = field(default_factory=list)
    """Loose layers that need a new project entry (a healed one reuses its own)."""
    reused_link_ids: list[int] = field(default_factory=list)
    to_materialize: list[dict[str, Any]] = field(default_factory=list)
    bundles: dict[UUID, str] = field(default_factory=dict)
    """Each typed dataset's shared bundle: bundle id to dataset."""
    healed_bundles: set[str] = field(default_factory=set)


def refuse_unaddable(
    items: dict[str, dict[str, Any]],
    typed: dict[str, tuple[str, str]],
    *,
    roles_required: bool = False,
    action: str = "added",
) -> None:
    """400 before anything is promoted, so a batch goes in whole or not at all: a
    bundle type that cannot be shared, a role listed twice (or, for an update, a
    member without one), a map service whose link cannot be drawn."""
    for dataset, (kind, title) in typed.items():
        # Only a plan is shared whole: a network's artifacts are built per owner.
        if kind != BundleTypeName.xplan.value:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"'{title}' is a {kind} dataset, which cannot be {action} yet.",
            )
        roles = [
            item.get("goat:role")
            for item in items.values()
            if item.get("collection") == dataset
        ]
        if roles_required and not all(roles):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"'{title}' has a layer without a role, so it cannot be {action}.",
            )
        named = [role for role in roles if role]
        if len(named) != len(set(named)):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"'{title}' lists a layer role twice, so it cannot be {action}.",
            )
    for item in items.values():
        try:
            catalog.service_layer(item)
        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


def bundle_versions_of(
    items: dict[str, dict[str, Any]], typed: dict[str, tuple[str, str]]
) -> dict[str, str]:
    """Each typed dataset's version, from its members' `(item id, version)`."""
    return {
        dataset: catalog.bundle_version(
            [
                (item_id, item.get("version"))
                for item_id, item in items.items()
                if item.get("collection") == dataset
            ]
        )
        for dataset in typed
    }


async def promote_catalog_items(
    conn: asyncpg.Connection,
    items: dict[str, dict[str, Any]],
    item_ids: list[str],
    *,
    mirror: Path,
    typed: dict[str, tuple[str, str]],
    bundle_versions: dict[str, str],
    project_id: UUID,
) -> PromotedItems:
    """Promote `item_ids` (in order), decide which copies to (re)materialize,
    and make each typed dataset's shared bundle."""
    out = PromotedItems()
    layers_dir = Path(settings.CATALOG_LAYERS_DIR)
    bundle_members: dict[str, list[tuple[UUID, str | None]]] = {}
    for catalog_id in item_ids:
        dataset = items[catalog_id].get("collection")
        version = bundle_versions.get(dataset)
        result = await catalog.promote(
            conn,
            catalog_id,
            mirror_items_path=mirror,
            schema=settings.SCHEMA,
            item=items[catalog_id],
            version=(
                f"{items[catalog_id].get('version') or ''}@{version}"
                if version
                else None
            ),
        )
        layer_id = uuid_module.UUID(result["layer_id"])
        out.layer_ids[catalog_id] = layer_id
        # Enqueue for a fresh layer — and re-enqueue for an existing one
        # whose data never arrived (`failed`, or `pending` with no job
        # behind it because the original enqueue failed) or is gone
        # (`ready`, but its file is not on disk). That makes re-adding the
        # dataset the recovery path: no retry affordance, selecting it
        # again heals it. The rules live in `services.materialize_heal` —
        # including how old a `pending` or `running` has to be before it
        # counts as lost.
        # A WMS/WMTS has nothing to copy, new or healed: a raster with no
        # file is what it is, not a lost copy.
        copies_data = result.get("materialize", True)
        should_enqueue = result["created"] and copies_data
        add_link = True
        if not should_enqueue and copies_data:
            row = await conn.fetchrow(
                f"""
                SELECT type, other_properties->'catalog_materialize' AS doc
                FROM "{settings.SCHEMA}".layer WHERE id = $1
                """,
                layer_id,
            )
            raw_doc = row["doc"] if row else None
            materialize_doc = (
                json.loads(raw_doc) if isinstance(raw_doc, str) else raw_doc
            )
            # Off the event loop: the data volume may be a network mount.
            copy_present = await run_in_threadpool(
                copy_on_disk, layers_dir, layer_id, row["type"] if row else None
            )
            decision = decide_heal(materialize_doc, copy_present=copy_present)
            should_enqueue = decision.should_enqueue
            if decision.reset_to_pending:
                # Back to pending so the tree shows "preparing" again.
                # Merged, not replaced: keep the prior error as a trail,
                # and stamp it like every other status so age is readable.
                await conn.execute(
                    f"""
                    UPDATE "{settings.SCHEMA}".layer
                    SET other_properties = jsonb_set(
                        other_properties,
                        '{{catalog_materialize}}',
                        COALESCE(other_properties->'catalog_materialize', '{{}}'::jsonb)
                            || jsonb_build_object(
                                'status', 'pending',
                                'updated_at', to_jsonb(now()),
                                'heal_reason', $2::text
                            )
                    )
                    WHERE id = $1
                    """,
                    layer_id,
                    decision.reason,
                )
            if should_enqueue and version is None:
                # A heal reuses the broken entry already in the project
                # rather than adding a "Copy from …" twin next to it.
                # (Re-adding a HEALTHY dataset still duplicates on
                # purpose — two entries of one dataset, two stylings.)
                existing_link_id = await conn.fetchval(
                    f"""
                    SELECT id FROM "{settings.SCHEMA}".layer_project
                    WHERE project_id = $1 AND layer_id = $2
                    ORDER BY id LIMIT 1
                    """,
                    project_id,
                    layer_id,
                )
                if existing_link_id is not None:
                    out.reused_link_ids.append(existing_link_id)
                    add_link = False
        if version:
            bundle_members.setdefault(dataset, []).append(
                (layer_id, items[catalog_id].get("goat:role"))
            )
            if should_enqueue and not result["created"]:
                out.healed_bundles.add(dataset)
        elif add_link:
            out.link_layer_ids.append(layer_id)
        if should_enqueue:
            out.to_materialize.append({"layer_id": result["layer_id"]})
    for dataset, members in bundle_members.items():
        kind, title = typed[dataset]
        bundle_id = await catalog.promote_bundle(
            conn,
            schema=settings.SCHEMA,
            dataset_id=dataset,
            bundle_type=kind,
            name=title,
            version=bundle_versions[dataset],
            members=members,
        )
        out.bundles[bundle_id] = dataset
    return out
