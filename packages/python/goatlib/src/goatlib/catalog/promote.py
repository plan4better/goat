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
drawable when that finishes. A WMS or WMTS item has no data to copy: it becomes
the same link layer Connect data makes, born ``ready``.
"""

from __future__ import annotations

import hashlib
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
from urllib.parse import quote
from uuid import UUID

import asyncpg
import duckdb

from goatlib.catalog.item import (
    PLAIN_BUNDLE_TYPES,
    is_wms,
    is_wmts,
    item_style,
    layer_type,
)
from goatlib.style.compute import stamp_computed
from goatlib.style.defaults import default_style
from goatlib.style.fingerprint import fingerprint
from goatlib.style.migrate import context_for
from goatlib.tools.style_rows import insert_dataset_default

logger = logging.getLogger(__name__)

_ITEM_COLUMNS = [
    "id",
    "collection",
    # A plan member's role (its XPlan class), stored in `bundle_layer.role`.
    '"goat:role"',
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


def typed_datasets(
    mirror_items_path: str | Path, dataset_ids: set[str]
) -> dict[str, tuple[str, str]]:
    """Which of `dataset_ids` are typed bundles (an XPlan plan): `{dataset: (type, title)}`."""
    collections = Path(mirror_items_path).with_name("mirror_collections.parquet")
    if not dataset_ids or not collections.exists():
        return {}
    con = duckdb.connect()
    try:
        columns = {
            row[0]
            for row in con.execute(
                "DESCRIBE SELECT * FROM read_parquet(?)", [str(collections)]
            ).fetchall()
        }
        if "goat:bundleType" not in columns:
            return {}
        title = "coalesce(title, id)" if "title" in columns else "id"
        rows = con.execute(
            f"""
            SELECT id, lower("goat:bundleType"), {title} FROM read_parquet(?)
            WHERE id IN ({", ".join("?" * len(dataset_ids))})
            """,
            [str(collections), *dataset_ids],
        ).fetchall()
    finally:
        con.close()
    return {
        dataset: (kind, str(title))
        for dataset, kind, title in rows
        if (kind or "") not in PLAIN_BUNDLE_TYPES
    }


def bundle_version(members: list[tuple[str, Any]]) -> str:
    """A typed bundle's version: a digest of its members' `(item id, version)`."""
    joined = "\n".join(
        f"{item_id}@{version or ''}" for item_id, version in sorted(members)
    )
    return hashlib.sha1(joined.encode()).hexdigest()[:16]


async def promote_bundle(
    conn: asyncpg.Connection,
    *,
    schema: str,
    dataset_id: str,
    bundle_type: str,
    name: str,
    version: str,
    members: list[tuple[UUID, str | None]],
) -> UUID:
    """The shared bundle of a typed catalog dataset (an XPlan plan), made on its
    first add and reused after; members are attached on every add, so one the
    catalog cleanup removed comes back."""
    async with conn.transaction():
        bundle_id = await conn.fetchval(
            f"""
            INSERT INTO "{schema}".bundle
                (name, bundle_type, status, catalog_external_uid, catalog_version, updated_at)
            VALUES ($1, $2, 'ready', $3, $4, now())
            ON CONFLICT (catalog_external_uid, catalog_version)
                WHERE catalog_external_uid IS NOT NULL
            DO NOTHING
            RETURNING id
            """,
            name,
            bundle_type,
            dataset_id,
            version,
        )
        if bundle_id is None:
            bundle_id = await conn.fetchval(
                f"""
                SELECT id FROM "{schema}".bundle
                WHERE catalog_external_uid = $1 AND catalog_version = $2
                """,
                dataset_id,
                version,
            )
        await conn.executemany(
            f"""
            INSERT INTO "{schema}".bundle_layer (bundle_id, layer_id, role)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
            """,
            [(bundle_id, layer_id, role) for layer_id, role in members],
        )
        return bundle_id


def wmts_layer(item: dict[str, Any]) -> dict[str, Any]:
    """The ``url`` and ``other_properties`` of a WMTS item's link layer.

    The tile address is the item's ``rel="xyz"`` link: goat-data reads the
    capabilities and picks the web-mercator grid, which the mirror's links
    could not otherwise carry. Same shape as Connect data's WMTS layer.
    """
    links = [link for link in item.get("links") or [] if isinstance(link, dict)]
    tiles = next(
        (
            link["href"]
            for link in links
            if link.get("rel") == "xyz" and link.get("href")
        ),
        None,
    )
    if not tiles:
        raise ValueError(f"WMTS item {item.get('id')} has no tile address (rel=xyz)")
    name = next(
        (link.get("title") for link in links if link.get("rel") == "wmts"), None
    )
    return {"url": tiles, "other_properties": {"layers": [name] if name else []}}


def service_layer(item: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """``(data_type, link layer)`` for a WMS or WMTS item, None for data to copy."""
    if is_wms(item):
        return "wms", wms_layer(item)
    if is_wmts(item):
        return "wmts", wmts_layer(item)
    return None


def wms_layer(item: dict[str, Any]) -> dict[str, Any]:
    """The ``url`` and ``other_properties`` of a WMS item's link layer.

    The same strings the web's Connect data writes (``generateWmsUrl`` and
    ``generateLayerGetLegendGraphicUrl``), so a catalog WMS and a connected one
    draw alike. Layers are the titles of the item's ``rel="wms"`` links on the
    first link's server.
    """
    links = [
        link
        for link in item.get("links") or []
        if isinstance(link, dict) and link.get("rel") == "wms" and link.get("href")
    ]
    if not links:
        raise ValueError(f"WMS item {item.get('id')} has no rel=wms link")
    href = links[0]["href"]
    # goat-data names several layers of one link in its title, comma-separated:
    # the mirror keeps no `wms:layers`.
    layers = [
        name.strip()
        for link in links
        if link["href"] == href and link.get("title")
        for name in link["title"].split(",")
        if name.strip()
    ]
    if not layers:
        raise ValueError(f"WMS item {item.get('id')} names no layer")
    # goat-data publishes the clean server address; its own parameters (a
    # `map=`) go in front of the request, as Connect data's `wmsTileTemplate`.
    path, _, query = href.partition("?")
    prefix = f"{path}?" + (f"{query}&" if query else "")
    # Encoded: a name with `&`, `#` or a space would cut the request short.
    names = [quote(layer, safe=":") for layer in layers]
    url = (
        f"{prefix}bbox={{bbox-epsg-3857}}&service=WMS&REQUEST=GetMap"
        f"&layers={','.join(names)}&FORMAT=image/png&TRANSPARENT=true"
        "&WIDTH=256&HEIGHT=256&SRS=EPSG:3857&CRS=EPSG:3857&VERSION=1.3.0"
        f"&STYLES={','.join('' for _ in layers)}&DPI=90&MAP_RESOLUTION=90"
        "&FORMAT_OPTIONS=dpi:90"
    )
    legend_urls = [
        f"{prefix}service=WMS&REQUEST=GetLegendGraphic&layer={name}"
        "&FORMAT=image/png&TRANSPARENT=true&VERSION=1.3.0&STYLE=default"
        "&SLD_VERSION=1.1.0"
        for name in names
    ]
    return {
        "url": url,
        "other_properties": {"layers": layers, "legend_urls": legend_urls},
    }


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

    Returned as published; :func:`catalog_default_style` makes it the layer's
    GOAT Style document.
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


def catalog_default_style(
    item: dict[str, Any],
    *,
    seed: str,
    read_object: Callable[[str], bytes] | None = None,
) -> dict[str, Any] | None:
    """The promoted layer's default style: the item's published style asset as a
    GOAT Style document, else GOAT's default. None for a table.

    The publisher computed the asset's classes from this version of the data, so
    they are stamped with it (`catalog:<version>`) and not recomputed on the
    first map load; classes the asset leaves to the server are computed then.
    """
    ltype, geom_type = layer_type(item)
    if ltype == "table":
        return None
    service = "wms" if is_wms(item) else "wmts" if is_wmts(item) else None
    if service:
        # The server draws it; no published style applies to a map service.
        return default_style(context_for(ltype, geom_type, service), seed=seed)
    document = item_style(published_style(item, read_object=read_object), item)
    if document is None:
        return default_style(context_for(ltype, geom_type, None), seed=seed)
    if ltype == "raster":
        return document
    return stamp_computed(
        document,
        fingerprint(data_snapshot=None, catalog_version=str(item.get("version") or "")),
        datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


async def promote(
    conn: asyncpg.Connection,
    item_id: str,
    *,
    mirror_items_path: str | Path,
    schema: str = "customer",
    item: dict[str, Any] | None = None,
    version: str | None = None,
) -> dict[str, Any]:
    """Return the shared ``customer.layer`` for a catalog item, creating it
    if this is the first use of this (item, version).

    ``version`` replaces the item's own as identity: each plan version gets its own members.

    ``item`` is the mirror row when the caller already has it (see
    :func:`read_items`); otherwise it is read here.

    The row has **no owner**: ``user_id`` and ``folder_id`` are NULL, because a
    catalog dataset belongs to the provider that published it, not to anyone
    here. That is also what keeps it out of every user's content listing and
    out of any organization's storage accounting.

    Race-safe via the partial unique index on
    ``(catalog_external_uid, catalog_version)``: the INSERT is
    ``ON CONFLICT DO NOTHING``, and when it inserts no row the winner's is
    read back. Returns ``{"layer_id", "created", "parquet_url", "materialize"}``;
    ``materialize`` is False for a WMS or WMTS link layer, which has nothing to copy.
    """
    if item is None:
        item = read_item(mirror_items_path, item_id)
    version = version or str(item.get("version") or "")
    # Stamped with the identity version, the one the layer row carries.
    stamped = {**item, "version": version}
    # Built before any write: an unusable link fails here, not halfway through.
    service = service_layer(item)
    data_type, wms = service if service else (None, None)

    # UPDATE, not SELECT: touching updated_at moves a reused layer out of the
    # catalog-GC grace window, so re-adding a long-unreferenced layer can't be
    # swept between here and the project-link creation.
    existing = await conn.fetchrow(
        f"""
        UPDATE {schema}.layer SET updated_at = NOW()
        WHERE catalog_external_uid = $1 AND catalog_version = $2
        RETURNING id, data_type,
            other_properties->'catalog_materialize'->>'status' AS status
        """,
        item_id,
        version,
    )
    if existing:
        if wms and (
            existing["data_type"] != data_type or existing["status"] != "ready"
        ):
            # Promoted before WMS was a link (as a table waiting for a copy that
            # cannot come), or failed by a copy job it never needed: made the
            # link layer it should have been.
            # One transaction: the row and its style change together.
            async with conn.transaction():
                await conn.execute(
                    f"""
                    UPDATE {schema}.layer SET
                        type = 'raster', feature_layer_type = NULL,
                        feature_layer_geometry_type = NULL,
                        url = $2, data_type = $4,
                        other_properties = other_properties || $3::jsonb
                    WHERE id = $1
                    """,
                    existing["id"],
                    wms["url"],
                    json.dumps(
                        {
                            **wms["other_properties"],
                            "catalog_materialize": {
                                "status": "ready",
                                "updated_at": datetime.now(timezone.utc).isoformat(),
                            },
                        }
                    ),
                    data_type,
                )
                # A table had no style row; the link layer gets its service default.
                style = catalog_default_style(stamped, seed=str(existing["id"]))
                if style is not None:
                    await insert_dataset_default(conn, schema, existing["id"], style)
        return {
            "layer_id": str(existing["id"]),
            "created": False,
            "parquet_url": item.get("parquet_url"),
            "materialize": wms is None,
        }

    ltype, geom_type = layer_type(item)
    new_id = uuid_module.uuid4()
    # The dataset's own rendering when it publishes one; GOAT's default is the
    # fallback, not the rule. The default row is written *here*, with the layer:
    # the project layer's first style is copied from it as the link is created.
    style = catalog_default_style(stamped, seed=str(new_id))
    name = (item.get("title") or "").strip() or item_id
    other_properties = {
        **(wms["other_properties"] if wms else {}),
        "catalog_materialize": {
            "status": "ready" if wms else "pending",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        "catalog_item": _jsonable(item),
    }

    has_bbox = all(
        item.get(k) is not None
        for k in ("bbox_xmin", "bbox_ymin", "bbox_xmax", "bbox_ymax")
    )

    async with conn.transaction():
        inserted = await conn.fetchrow(
            f"""
            INSERT INTO {schema}.layer (
                id, name, description, type,
                feature_layer_type, feature_layer_geometry_type, extent,
                other_properties,
                public_read, catalog_external_uid, catalog_version,
                url, data_type,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4,
                CASE WHEN $4 = 'feature' THEN 'standard' ELSE NULL END,
                $5,
                CASE WHEN $6 THEN
                    ST_Multi(ST_MakeEnvelope($7, $8, $9, $10, 4326))
                END,
                $11::jsonb,
                FALSE, $12, $13,
                $14, $15,
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
            json.dumps(other_properties),
            item_id,
            version,
            wms["url"] if wms else None,
            data_type,
        )
        if inserted is not None and style is not None:
            await insert_dataset_default(conn, schema, new_id, style)

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
            "materialize": wms is None,
        }

    return {
        "layer_id": str(new_id),
        "created": True,
        "parquet_url": item.get("parquet_url"),
        "materialize": wms is None,
    }
