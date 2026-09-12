"""Promote a catalog item into a shared, read-only ``customer.layer``.

The catalog's source of truth is the STAC mirror on the shared volume
(``mirror_items.parquet``); nothing about a harvested dataset lives in
Postgres until someone uses it. The first add-to-project promotes the item:
one layer row with no owner, shared by every user and org that adds the same
item at the same version.

The row carries only what rendering needs — name, description, type,
geometry type, extent, style. Everything else the item says about itself
(license, publisher, keywords, ...) is stored verbatim in
``other_properties.catalog_item``: the mirror is rebuilt wholesale on every
sync, so a superseded version's metadata exists nowhere else afterwards.
The legacy flat metadata columns are left NULL — the catalog UI reads the
STAC service and the snapshot, not those columns.

Identity is ``(catalog_external_uid, catalog_version)`` under a partial
unique index — the idempotency and race mechanism. A concurrent promote of
the same item conflicts on the index; the loser reads the winner's row.

Data is NOT copied here. The layer row is created with materialize status
``pending`` and the caller enqueues the materialize job; the layer becomes
drawable when that finishes.
"""

from __future__ import annotations

import json
import logging
import os
import posixpath
import uuid as uuid_module
from collections.abc import Callable
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import asyncpg
import duckdb

logger = logging.getLogger(__name__)

_ITEM_COLUMNS = [
    "id",
    "title",
    "description",
    "license",
    "attribution",
    "category",
    "publisher",
    "keywords",
    "language_code",
    "version",
    "parquet_url",
    '"goat:layerType"',
    '"goat:geometryType"',
    '"processing:lineage"',
    "datetime_start",
    # The record's own dates: when the provider published the dataset and when
    # it last changed. `layer.updated_at` answers a different question — when
    # GOAT promoted or re-materialized its copy — so a reader asking "how old
    # is this data" needs these, not that.
    "created",
    "updated",
    "bbox_xmin",
    "bbox_ymin",
    "bbox_xmax",
    "bbox_ymax",
    "links",
    "assets",
]


class CatalogItemNotFoundError(ValueError):
    """The mirror has no item with this id."""


def _item_select_list(con: duckdb.DuckDBPyConnection, mirror_items_path: str) -> str:
    """``_ITEM_COLUMNS`` as a SELECT list, with NULL standing in for a column
    the file does not have.

    The mirror is rewritten by the sync task on its own schedule, so a service
    can run ahead of the file it reads for one cycle. A column added to the
    list must read as unknown until then, not turn every promote into a binder
    error.
    """
    present = {
        column[0]
        for column in con.execute(
            "SELECT * FROM read_parquet(?) LIMIT 0", [mirror_items_path]
        ).description
    }
    return ", ".join(
        col if col.strip('"') in present else f"NULL AS {col}" for col in _ITEM_COLUMNS
    )


def read_item(mirror_items_path: str | Path, item_id: str) -> dict[str, Any]:
    """One item row from the mirror, as a plain dict keyed by column name."""
    con = duckdb.connect()
    try:
        cols = _item_select_list(con, str(mirror_items_path))
        row = con.execute(
            f"SELECT {cols} FROM read_parquet(?) WHERE id = ?",
            [str(mirror_items_path), item_id],
        ).fetchone()
        if row is None:
            raise CatalogItemNotFoundError(f"Catalog item not found: {item_id}")
        names = [c.strip('"') for c in _ITEM_COLUMNS]
        return dict(zip(names, row))
    finally:
        con.close()


def read_items(
    mirror_items_path: str | Path, item_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """The rows for several items in ONE scan of the mirror, keyed by id.

    `promote` takes a row through its `item` argument so that adding a bundle
    of 74 members costs one DuckDB connection and one pass over a file sized
    for a million rows, not 74 of each.
    """
    if not item_ids:
        return {}
    con = duckdb.connect()
    try:
        cols = _item_select_list(con, str(mirror_items_path))
        placeholders = ", ".join("?" for _ in item_ids)
        rows = con.execute(
            f"SELECT {cols} FROM read_parquet(?) WHERE id IN ({placeholders})",
            [str(mirror_items_path), *item_ids],
        ).fetchall()
    finally:
        con.close()
    names = [c.strip('"') for c in _ITEM_COLUMNS]
    found = {row[0]: dict(zip(names, row)) for row in rows}
    missing = [i for i in item_ids if i not in found]
    if missing:
        raise CatalogItemNotFoundError(f"Catalog item not found: {missing[0]}")
    return found


def resolve_item_ids(
    mirror_items_path: str | Path, catalog_ids: list[str]
) -> list[str]:
    """The item ids named by `catalog_ids`, expanding any dataset id among them.

    A caller names what it picked, and what a user picks in the catalog is a
    *dataset* — a Collection. Promotion is per Item, and a Collection's id is
    not one of its items' ids (the harvester mints a separate uuid for each),
    so a dataset id has to be resolved to the layers inside it. A single-layer
    dataset resolves to its one item; a bundle to all of its members, which is
    what adding it means.

    Request order is preserved, and an id already covered by an earlier one is
    dropped: ticking a bundle and one of its layers is one request for that
    layer, not two entries in the project.
    """
    if not catalog_ids:
        return []

    con = duckdb.connect()
    try:
        placeholders = ", ".join("?" * len(catalog_ids))
        rows = con.execute(
            f"""
            SELECT id, collection FROM read_parquet(?)
            WHERE id IN ({placeholders}) OR collection IN ({placeholders})
            ORDER BY id
            """,
            [str(mirror_items_path), *catalog_ids, *catalog_ids],
        ).fetchall()
    finally:
        con.close()

    items = {row[0] for row in rows}
    members: dict[str, list[str]] = {}
    for item_id, collection_id in rows:
        if collection_id is not None:
            members.setdefault(collection_id, []).append(item_id)

    resolved: list[str] = []
    seen: set[str] = set()
    for catalog_id in catalog_ids:
        if catalog_id in items:
            expanded = [catalog_id]
        elif catalog_id in members:
            expanded = members[catalog_id]
        else:
            raise CatalogItemNotFoundError(f"Catalog item not found: {catalog_id}")
        for item_id in expanded:
            if item_id not in seen:
                seen.add(item_id)
                resolved.append(item_id)
    return resolved


def layer_type(item: dict[str, Any]) -> tuple[str, str | None]:
    """(layer type, geometry type) for the layer row.

    ``goat:geometryType`` absent means an attribute table (contract §3.1).
    """
    geom = item.get("goat:geometryType")
    declared = (item.get("goat:layerType") or "").lower()
    if geom:
        return "feature", str(geom).lower()
    if declared in ("table", "feature", "raster"):
        return declared, None
    return "table", None


def _jsonable(item: dict[str, Any]) -> dict[str, Any]:
    """The item with every value JSON-serialisable (timestamps to ISO)."""

    def conv(v: Any) -> Any:
        if hasattr(v, "isoformat"):
            return v.isoformat()
        if isinstance(v, Decimal):
            return float(v)
        if isinstance(v, list):
            return [conv(x) for x in v]
        if isinstance(v, dict):
            return {k: conv(x) for k, x in v.items()}
        return v

    return {k: conv(v) for k, v in item.items()}


def style_key_for(style_href: str) -> str:
    """The catalog-bucket key for an item's style asset.

    Same shape as :func:`goatlib.tools.catalog_materialize.bucket_key_for` and
    for the same reason: the published href walks out of the JSON tree
    (``../../../styles/<uuid>.json`` — contract C8), so only its basename is
    meaningful and the prefix is fixed by the bucket layout.
    """
    name = posixpath.basename(style_href or "")
    if not name.endswith(".json"):
        raise ValueError(f"Not a style asset: {style_href!r}")
    return f"styles/{name}"


def _read_catalog_object(key: str) -> bytes:
    """One object out of the catalog bucket.

    Its own credentials, like the materialize job's: the catalog bucket
    belongs to another team, and reading it is not the same grant as reading
    GOAT's own storage.
    """
    import boto3

    bucket = os.environ.get("CATALOG_S3_BUCKET", "")
    if not bucket:
        raise RuntimeError("CATALOG_S3_BUCKET is not configured")
    client = boto3.client(
        "s3",
        endpoint_url=os.environ.get("CATALOG_S3_ENDPOINT_URL") or None,
        aws_access_key_id=os.environ.get("CATALOG_S3_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("CATALOG_S3_SECRET_ACCESS_KEY"),
        region_name=os.environ.get("CATALOG_S3_REGION") or None,
    )
    body: bytes = client.get_object(Bucket=bucket, Key=key)["Body"].read()
    return body


def published_style(
    item: dict[str, Any],
    *,
    read_object: Callable[[str], bytes] | None = None,
) -> dict[str, Any] | None:
    """The dataset's own rendering, from the style asset it publishes.

    ``None`` whenever there is not one to use — the item publishes no style
    (every ``table`` does, plus 92 layers that publish nothing), the bucket is
    not configured for this deployment, the object is gone, or what came back
    is not a style object. Each of those falls back to GOAT's default rather
    than failing the add: a dataset that draws in the wrong colours is a far
    smaller thing than one that cannot be added at all.

    Stored verbatim. A raster item publishes a raster style and promotes to a
    raster layer, so the shapes match without dispatching here; validating the
    members would be a second copy of a schema that is the renderer's.
    """
    assets = item.get("assets")
    asset = assets.get("style") if isinstance(assets, dict) else None
    href = asset.get("href") if isinstance(asset, dict) else None
    if not href:
        return None

    reader = read_object or _read_catalog_object
    try:
        document = json.loads(reader(style_key_for(str(href))))
    except Exception as exc:
        logger.warning("Catalog style %s not applied: %s", href, exc)
        return None
    if not isinstance(document, dict):
        logger.warning("Catalog style %s is not a style object", href)
        return None
    return document


def _default_style(geometry_type: str | None) -> dict[str, Any]:
    from goatlib.tools.style import get_default_style

    return dict(get_default_style(geometry_type))


async def promote(
    conn: asyncpg.Connection,
    item_id: str,
    *,
    mirror_items_path: str | Path,
    schema: str = "customer",
    item: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the shared ``customer.layer`` for a catalog item, creating it
    if this is the first use of this (item, version).

    ``item`` is the mirror row when the caller already has it (see
    :func:`read_items`); otherwise it is read here.

    The row has **no owner**: ``user_id`` and ``folder_id`` are NULL, because a
    catalog dataset belongs to the provider that published it, not to anyone
    here. That is also what keeps it out of every user's content listing and
    out of any organization's storage accounting.

    Race-safe via the partial unique index on
    ``(catalog_external_uid, catalog_version)``: the INSERT is
    ``ON CONFLICT DO NOTHING``, and when it inserts no row the winner's is
    read back. Returns ``{"layer_id", "created", "parquet_url"}``.
    """
    if item is None:
        item = read_item(mirror_items_path, item_id)
    version = str(item.get("version") or "")

    # UPDATE, not SELECT: touching updated_at moves a reused layer out of the
    # catalog-GC grace window, so re-adding a long-unreferenced layer can't be
    # swept between here and the project-link creation.
    existing = await conn.fetchrow(
        f"""
        UPDATE {schema}.layer SET updated_at = NOW()
        WHERE catalog_external_uid = $1 AND catalog_version = $2
        RETURNING id
        """,
        item_id,
        version,
    )
    if existing:
        return {
            "layer_id": str(existing["id"]),
            "created": False,
            "parquet_url": item.get("parquet_url"),
        }

    ltype, geom_type = layer_type(item)
    # The dataset's own rendering when it publishes one; GOAT's default is the
    # fallback, not the rule. The style has to be on the row *here*: the
    # project link copies `properties` off the layer as it is created, which is
    # what makes styling per-project, so a style arriving later would never
    # reach the layer someone just added.
    style = published_style(item) or (_default_style(geom_type) if geom_type else {})
    if style:
        style.setdefault("visibility", True)
    name = (item.get("title") or "").strip() or item_id
    other_properties = {
        "catalog_materialize": {
            "status": "pending",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        "catalog_item": _jsonable(item),
    }

    has_bbox = all(
        item.get(k) is not None
        for k in ("bbox_xmin", "bbox_ymin", "bbox_xmax", "bbox_ymax")
    )

    new_id = uuid_module.uuid4()
    inserted = await conn.fetchrow(
        f"""
        INSERT INTO {schema}.layer (
            id, name, description, type,
            feature_layer_type, feature_layer_geometry_type, extent,
            properties, other_properties,
            in_catalog, catalog_external_uid, catalog_version,
            created_at, updated_at
        ) VALUES (
            $1, $2, $3, $4,
            CASE WHEN $4 = 'feature' THEN 'standard' ELSE NULL END,
            $5,
            CASE WHEN $6 THEN
                ST_Multi(ST_MakeEnvelope($7, $8, $9, $10, 4326))
            END,
            $11::jsonb, $12::jsonb,
            FALSE, $13, $14,
            NOW(), NOW()
        )
        ON CONFLICT (catalog_external_uid, catalog_version)
            WHERE catalog_external_uid IS NOT NULL
        DO NOTHING
        RETURNING id
        """,
        new_id,
        name,
        item.get("description"),
        ltype,
        geom_type,
        has_bbox,
        item.get("bbox_xmin"),
        item.get("bbox_ymin"),
        item.get("bbox_xmax"),
        item.get("bbox_ymax"),
        json.dumps(style),
        json.dumps(other_properties),
        item_id,
        version,
    )

    if inserted is None:
        # Same reasoning as the fast path: bump updated_at so a concurrent
        # promote that lost the race still leaves the winner outside the GC
        # grace window.
        winner = await conn.fetchrow(
            f"""
            UPDATE {schema}.layer SET updated_at = NOW()
            WHERE catalog_external_uid = $1 AND catalog_version = $2
            RETURNING id
            """,
            item_id,
            version,
        )
        if winner is None:
            raise RuntimeError(
                f"Promote of {item_id}@{version} conflicted but no winner row "
                f"is visible; retry"
            )
        return {
            "layer_id": str(winner["id"]),
            "created": False,
            "parquet_url": item.get("parquet_url"),
        }

    return {
        "layer_id": str(new_id),
        "created": True,
        "parquet_url": item.get("parquet_url"),
    }
