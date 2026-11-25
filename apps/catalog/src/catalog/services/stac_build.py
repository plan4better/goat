"""Assemble STAC documents from mirror rows, and adjust them for serving.

The mirror stores columns, not rendered JSON (see ``catalog.store``), so an
Item becomes an Item here: ``item_from_row``/``collection_from_row`` place the
structural members, drop the internal query-support columns, and turn
everything else into ``properties.*`` -- which is what lets a column the
harvester adds tomorrow be served without a code change.

``record_to_item``/``record_to_collection`` then apply the three serve-time
edits the API owes a client: assets backed by GOAT's own storage are removed
(design S14), the static tree's relative navigational links are rewritten into
absolute API URLs, and an ``alternate`` "Open in GOAT" link is appended.
"""

import json
import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Literal
from urllib.parse import quote
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError

logger = logging.getLogger(__name__)

STAC_VERSION = "1.0.0"

_CATALOG_ID = "goat-catalog"
_CATALOG_DESCRIPTION = (
    "Curated, ready-to-use datasets from official open-data providers and "
    "other trusted sources, served as a STAC API."
)
_PARQUET_MEDIA_TYPE = "application/x-parquet"


class StacItem(BaseModel):
    """A STAC Item -- a GeoJSON Feature with stac_version, bbox, assets, links.

    Non-stripping guard (``extra="allow"``): catches structural drift while
    letting ``properties``/``assets``/``goat:*`` members through.
    """

    model_config = ConfigDict(extra="allow")

    type: Literal["Feature"]
    stac_version: str = STAC_VERSION
    id: str
    geometry: dict[str, Any] | None = None
    bbox: list[float] | None = None
    properties: dict[str, Any]
    links: list[dict[str, Any]] = Field(default_factory=list)
    assets: dict[str, dict[str, Any]] = Field(default_factory=dict)
    collection: str | None = None
    stac_extensions: list[str] = Field(default_factory=list)


class StacCollection(BaseModel):
    """A STAC Collection -- dataset-level metadata (extent, license, links)."""

    model_config = ConfigDict(extra="allow")

    type: Literal["Collection"] = "Collection"
    stac_version: str = STAC_VERSION
    id: str
    title: str | None = None
    description: str | None = None
    license: str = "other"
    extent: dict[str, Any] = Field(default_factory=dict)
    links: list[dict[str, Any]] = Field(default_factory=list)
    stac_extensions: list[str] = Field(default_factory=list)


# The envelopes below exist to describe the responses in the OpenAPI document.
# The handlers keep returning plain dicts -- the models are attached as the
# documented schema, not as a serialization step, so a response is never
# reshaped on its way out (stac-fastapi does the same, declaring the model in
# `responses={200: ...}` and only validating through it when the operator opts
# in with `enable_response_models`).


class StacItemCollection(BaseModel):
    """An ItemCollection: a GeoJSON FeatureCollection of STAC Items."""

    model_config = ConfigDict(extra="allow")

    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[StacItem] = Field(default_factory=list)
    links: list[dict[str, Any]] = Field(default_factory=list)
    numberMatched: int | None = None  # noqa: N815 -- the wire name (OGC)
    numberReturned: int | None = None  # noqa: N815 -- the wire name (OGC)


class StacCollections(BaseModel):
    """The Collection Search / ``/collections`` listing."""

    model_config = ConfigDict(extra="allow")

    collections: list[StacCollection] = Field(default_factory=list)
    links: list[dict[str, Any]] = Field(default_factory=list)
    numberMatched: int | None = None  # noqa: N815 -- the wire name (OGC)
    numberReturned: int | None = None  # noqa: N815 -- the wire name (OGC)
    #: Matches touching the map view (``bbox_boost``), which the order puts
    #: first; only when the list is grouped by it.
    numberInArea: int | None = None  # noqa: N815 -- the wire name


class StacCatalog(BaseModel):
    """The landing page: a Catalog carrying ``conformsTo`` and links."""

    model_config = ConfigDict(extra="allow")

    type: Literal["Catalog"] = "Catalog"
    stac_version: str = STAC_VERSION
    id: str
    title: str | None = None
    description: str | None = None
    conformsTo: list[str] = Field(default_factory=list)  # noqa: N815 -- wire name
    links: list[dict[str, Any]] = Field(default_factory=list)


class Conformance(BaseModel):
    """The ``/conformance`` declaration."""

    conformsTo: list[str]  # noqa: N815 -- the wire name (OGC)


class Queryables(BaseModel):
    """The ``/queryables`` JSON Schema document."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    schema_: str = Field(alias="$schema")
    id: str = Field(alias="$id")
    type: str = "object"
    title: str | None = None
    properties: dict[str, dict[str, Any]] = Field(default_factory=dict)
    additionalProperties: bool = False  # noqa: N815 -- JSON Schema keyword


def _flatten_positions(coords: Any) -> list[list[float]]:
    """Yield [x, y(, z)] positions from any nested GeoJSON coordinate array."""
    if not isinstance(coords, (list, tuple)) or not coords:
        return []
    if all(isinstance(c, (int, float)) for c in coords):
        return [list(coords)]
    out: list[list[float]] = []
    for c in coords:
        out.extend(_flatten_positions(c))
    return out


def _geojson_bbox(geometry: dict[str, Any] | None) -> list[float] | None:
    """[minx, miny, maxx, maxy] from a GeoJSON geometry's coordinates, or None."""
    if not geometry or not geometry.get("coordinates"):
        return None
    xs: list[float] = []
    ys: list[float] = []
    for pos in _flatten_positions(geometry["coordinates"]):
        if len(pos) >= 2:
            xs.append(pos[0])
            ys.append(pos[1])
    if not xs or not ys:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


#: Link relations that address resources *inside* this API. Their stored hrefs
#: are relative to the static S3 tree (``collection.json``, ``../catalog.json``,
#: ``items/x.json``) and are therefore rewritten to absolute API URLs. Every
#: other rel -- ``via`` (source dataset / harvested-from), ``license``, ... --
#: points somewhere outside this API and is passed through untouched.
_NAVIGATIONAL_RELS = frozenset({"self", "root", "parent", "collection", "items"})


#: Schemes a client can actually dereference from a served document.
_PUBLIC_URL_SCHEMES = ("http://", "https://")


def _is_private_href(href: object) -> bool:
    """True for hrefs GOAT must not publish (design S14).

    The harvested documents point at GOAT's own object storage for the
    converted GeoParquet and the rendered thumbnail. Those are the product,
    not the catalog: the API exposes metadata and the *provider's* download
    URLs, never our own copies.

    The test is "is this an absolute http(s) URL", **not** "does this start
    with ``s3://``". The harvester switched those hrefs from ``s3://…`` to
    tree-relative paths (``../../../data/x.parquet``), which a scheme-specific
    check waved straight through -- so the private GeoParquet became advertised
    the moment the upstream spelling changed. A relative href is also
    unresolvable once served from this API (it was relative to the item's
    position in the static JSON tree, not to our URL space), so anything that
    is not an absolute http(s) URL is both private *and* useless to a client.
    """
    if not isinstance(href, str):
        return True
    return not href.lower().startswith(_PUBLIC_URL_SCHEMES)


def _is_unservable_link(href: object) -> bool:
    """True for a *link* href this API must not pass through as-is.

    Deliberately weaker than :func:`_is_private_href`. That one governs assets
    and rejects anything that is not an absolute http(s) URL. Links cannot use
    the same rule: the static tree's navigational links are relative by
    construction (``items/<id>.json``, ``../../../catalog.json``) and are
    *rewritten* into absolute API URLs rather than dropped, so rejecting every
    relative href here would delete a bundle's ``rel=item`` members.

    What must never survive is a link into GOAT's own object storage, so this
    rejects absolute non-http(s) schemes and leaves relativity to the caller,
    which drops relative links only after navigational rewriting has had its
    chance at them.
    """
    if not isinstance(href, str):
        return True
    scheme, sep, _ = href.partition("://")
    return bool(sep) and scheme.lower() not in ("http", "https")


#: Asset roles this API does not serve, whatever their href.
#:
#: ``collection-mirror`` is the stac-geoparquet convention for "all of this
#: collection's Items as one parquet file", and it earns its place in a
#: *static* tree: without a search endpoint, a client's only alternative is one
#: GET per item. This API has Item Search, so it is redundant here -- and as
#: published it is also wrong: every Collection carries the identical asset
#: pointing at the catalog-wide ``items.parquet``, so a reader asking about a
#: one-item dataset would be handed all 10,793 (harvester contract C10).
#:
#: Excluded by role rather than left to the href filter, which drops it today
#: only because the published href happens to be relative. Resolving hrefs
#: (contract C8) would otherwise silently publish it.
_PRIVATE_ASSET_ROLES = frozenset({"collection-mirror"})


#: The shape of the documents this API builds from the mirror. Part of every
#: ETag (see ``CatalogStore._content_digest``): raise it whenever a change here
#: serves different documents from the same mirror files, or browsers keep the
#: old answer through 304s.
#: 2: an item says whether it has published tiles (`goat:tiles`), and a
#: facet's repeated values all filter (before, only the last one did).
DOCUMENT_VERSION = 2


#: Assets this API serves itself, and the ``/assets`` kind each is served as.
#:
#: The harvester publishes these hrefs relative to the static JSON tree
#: (``../../../thumbs/<id>.svg``), which is correct there and meaningless to a
#: client that received the item from this API -- so :func:`_public_assets` drops
#: them as unservable. Rewriting them to this API's own route publishes the two
#: that a client needs *without* opening the bucket, and without waiting for the
#: harvester to publish absolute hrefs: the tree-relative form is exactly what
#: the route resolves a key from.
#:
#: The GeoParquet is deliberately not here. It keeps being dropped, which is how
#: "the harmonised data is not downloadable" stays true by construction rather
#: than by a permission that could be relaxed. The tiles goat-data published
#: for a layer (`tiles`, a `.pmtiles`) are dropped the same way: they hold the
#: layer's features, and geoapi reads them for a preview under its own read
#: rule. The item only says that it has them (`_has_published_tiles`).
_SERVED_ASSETS = {"thumbnail": "thumbnail", "style": "style"}


def _has_published_tiles(assets: object) -> bool:
    tiles = assets.get("tiles") if isinstance(assets, dict) else None
    href = tiles.get("href") if isinstance(tiles, dict) else None
    return str(href or "").lower().endswith(".pmtiles")


def _public_assets(
    assets: dict[str, Any] | None,
    *,
    item_id: str | None = None,
    assets_base: str | None = None,
) -> dict[str, Any]:
    """The document's assets minus the ones this API does not publish.

    ``assets_base`` is this API's own ``/assets`` base URL; without it (an
    offline rebuild, a test) the served set is only what the publisher made
    absolute itself.
    """
    served: dict[str, Any] = {}
    for key, asset in (assets or {}).items():
        if not isinstance(asset, dict):
            continue
        if _PRIVATE_ASSET_ROLES.intersection(asset.get("roles") or ()):
            continue
        kind = _SERVED_ASSETS.get(key)
        if kind and assets_base and item_id:
            served[key] = {
                **asset,
                "href": f"{assets_base}/{quote(item_id, safe='')}/{kind}",
            }
            continue
        if not _is_private_href(asset.get("href")):
            served[key] = asset
    return served


#: Mirror columns that exist to answer queries, not to be served. They are
#: dropped during assembly rather than filtered at the SQL level so a caller can
#: keep using ``SELECT *`` and still get a clean document.
_INTERNAL_COLUMNS = frozenset(
    {
        "search_text",
        # The row's temporal extent as a comparable interval, derived so the
        # `datetime` filter can test overlap. Not served: a row states its own
        # time the STAC way -- `datetime` (+ `start_datetime`/`end_datetime`, or
        # a Collection's `extent.temporal`) -- and publishing a second spelling
        # of it would be two answers to one question.
        "datetime_start",
        "datetime_end",
        "language_code",
        "category",
        "parquet_url",
        "bbox_xmin",
        "bbox_ymin",
        "bbox_xmax",
        "bbox_ymax",
        "goat:row_collection",
    }
)

#: Mirror columns served under a different name than they are stored under.
#:
#: Both are values a *card* needs, which is why they are served rather than
#: kept internal like the other derived columns:
#:
#: * ``member_count`` -- how many layers share this item's bundle. The one
#:   number a dataset card must carry (a card standing for 74 layers is
#:   meaningless without it).
#: * ``publisher`` -- denormalised from the Collection's ``providers[0].name``.
#:   Items never carry ``providers``, so without this a result list showing
#:   "Stadt Wien" would need one extra request *per card* to fetch the parent
#:   Collection. It is also a facet (``publisher_count``), so a client could
#:   filter by a value it could not display.
#:
#: Namespaced on the way out because both are GOAT concepts rather than STAC
#: ones, and ``goat:member_count`` matches what ``/stac/resolve`` publishes.
#: Contrast ``license``, which is denormalised the same way but keeps its
#: plain name -- a STAC Item legitimately has a ``license`` property.
_PUBLISHED_PROPERTY_NAMES = {
    "member_count": "goat:member_count",
    "publisher": "goat:publisher",
}

#: STAC Item members that live at the top level; everything else on a mirror
#: row is a ``properties.*`` member.
_ITEM_STRUCTURAL = frozenset(
    {
        "id",
        "type",
        "stac_version",
        "stac_extensions",
        "collection",
        "bbox",
        "geometry",
        "assets",
        "links",
    }
)


def _clean(value: Any) -> Any:
    """Drop null members that a parquet STRUCT padded in.

    A published ``table:columns`` entry is ``{"name": "OGC_FID"}``, but as a
    STRUCT every row carries every member of the unified type, so it reads back
    as ``{"name": "OGC_FID", "description": null, "type": null}``. Serving those
    nulls is what the old stored-document path did (a real item carried 30 of
    them in ``table:columns`` alone); rebuilding lets us drop them.
    """
    if isinstance(value, dict):
        cleaned = {k: _clean(v) for k, v in value.items() if v is not None}
        return cleaned
    if isinstance(value, list):
        return [_clean(v) for v in value]
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(value, date):
        return value.isoformat()
    # DuckDB hands back native Python objects for several column types that
    # have no JSON equivalent -- a published `externalIds.value` typed as UUID
    # arrives as `UUID(...)`, and a DECIMAL as `Decimal(...)`. Serialising the
    # response would raise on either, so they are narrowed here rather than at
    # every call site.
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return value


def item_from_row(row: dict[str, Any]) -> dict[str, Any]:
    """Assemble a STAC Item from one mirror row.

    The mirror stores the published columns rather than rendered JSON, so this
    is where an Item becomes an Item. Rendering it at sync time instead cost
    69% of the file and 3.2 GB of the build's peak memory, to cache a
    transformation the service performs on every response anyway.

    Two STAC rules shape the output and pull in opposite directions:

    * ``geometry`` is REQUIRED and may be ``null`` -- for a geometry-less item
      the member must be *present* and null, not absent.
    * ``bbox`` is required only when ``geometry`` is non-null -- for that same
      item the member must be *absent*, not ``[null, null, null, null]``.

    Everything that is not a structural member becomes a property, so a column
    the harvester adds tomorrow is served without a code change here.
    """
    geometry = row.get("geometry")
    if isinstance(geometry, str):
        geometry = json.loads(geometry)

    document: dict[str, Any] = {
        "type": "Feature",
        "stac_version": row.get("stac_version") or STAC_VERSION,
        "id": str(row.get("id")),
        "geometry": _clean(geometry),
    }

    bbox = row.get("bbox")
    if isinstance(bbox, dict):
        bbox = [bbox.get("xmin"), bbox.get("ymin"), bbox.get("xmax"), bbox.get("ymax")]
    if bbox is None and geometry is not None:
        bbox = _geojson_bbox(geometry)
    if bbox is not None and all(v is not None for v in bbox):
        document["bbox"] = list(bbox)

    for name in ("stac_extensions", "collection", "assets", "links"):
        value = row.get(name)
        if value is not None:
            document[name] = _clean(value)

    properties = {
        _PUBLISHED_PROPERTY_NAMES.get(name, name): _clean(value)
        for name, value in row.items()
        if name not in _ITEM_STRUCTURAL
        and name not in _INTERNAL_COLUMNS
        and value is not None
    }
    # `datetime` is the one property that must be *present* even when unknown:
    # the Item spec makes it a required member of `properties` whose value may
    # be null. Dropping it with the other nulls made every undated item fail
    # validation on a missing required member -- 52% of the catalog when that was
    # measured, and the reason the null is written rather than omitted.
    #
    # Null is not the whole answer -- the schema allows a null `datetime` only
    # alongside `start_datetime` + `end_datetime`. Where the harvester publishes
    # those (contract C11), they pass through as columns and are served here as
    # properties, and this null is then the correct, spec-compliant statement
    # that the row covers a range rather than an instant. Where it publishes
    # neither, the null states the gap where an absent member hid it and points
    # a validator at the field that is actually missing upstream.
    properties.setdefault("datetime", None)
    document["properties"] = properties
    return document


#: Additionally internal on a Collection. The mirror derives `datetime` from
#: the temporal extent so Collection Search can filter on it, but a STAC
#: Collection has no top-level `datetime` member -- `extent` is its temporal
#: statement -- so it must not be serialised.
#: `thumbnail_item` names the layer whose thumbnail stands for the dataset. It is
#: not served as a property -- `collection_from_row` turns it into the
#: `assets.thumbnail` href a card reads.
_COLLECTION_INTERNAL = _INTERNAL_COLUMNS | {"datetime", "thumbnail_item"}


def collection_from_row(
    row: dict[str, Any], *, assets_base: str | None = None
) -> dict[str, Any]:
    """Assemble a STAC Collection from one mirror row.

    A Collection has no ``properties``: every field is top level, so this is a
    flat clean-up of the row rather than the two-tier split an Item needs.
    """
    geometry = row.get("geometry")
    document: dict[str, Any] = {
        "type": "Collection",
        "stac_version": row.get("stac_version") or STAC_VERSION,
        "id": str(row.get("id")),
    }
    for name, value in row.items():
        if (
            name in {"id", "type", "stac_version", "geometry"}
            or name in _COLLECTION_INTERNAL
        ):
            continue
        if value is not None:
            document[_PUBLISHED_PROPERTY_NAMES.get(name, name)] = _clean(value)
    # The mirror derives `geometry` from `extent` for spatial filtering; the
    # served Collection keeps `extent` as its spatial statement, so the derived
    # geometry is internal and never serialised.
    _ = geometry
    _state_temporal_extent(document, row)
    _state_thumbnail(document, row, assets_base)
    return document


def _state_thumbnail(
    document: dict[str, Any], row: dict[str, Any], assets_base: str | None
) -> None:
    """Give the dataset the thumbnail of the layer that has one.

    A Collection publishes no thumbnail (only `collection-mirror`, which this API
    never serves), so a dataset card would have nothing to show while 1,021 of
    its layers do. The href points at the *layer* that owns the object, because
    that is where the asset route resolves a key from -- the dataset is borrowing
    a picture, not claiming an object of its own.

    No `type`: the collection row does not know the layer's, and guessing one
    would be a claim about bytes this row has never seen. A client reads the type
    off the response, which is where it is authoritative.
    """
    item_id = row.get("thumbnail_item")
    if not item_id or not assets_base:
        return
    assets = document.get("assets")
    if not isinstance(assets, dict):
        assets = {}
        document["assets"] = assets
    assets["thumbnail"] = {
        "href": f"{assets_base}/{quote(str(item_id), safe='')}/thumbnail",
        "roles": ["thumbnail"],
    }


def _state_temporal_extent(document: dict[str, Any], row: dict[str, Any]) -> None:
    """Serve ``extent.temporal`` as the envelope of the dataset's layers.

    STAC defines a Collection's temporal extent as exactly that envelope, and the
    mirror computes it (``datetime_start``/``datetime_end``, mirror v6) because the
    published extent is not it: `[start, null]` on 3,766 of 3,834 collections, with
    the start in the harvest year on 799 of them. Passing that through meant a
    dataset whose only layer is from 2001 advertised itself as "collected since
    2001, ongoing" -- to this API's own filter as well as to a client, since the
    filter compares the derived interval.

    So the served extent states the derived one, and the published value survives
    only where no layer carries a date (the fallback is in the converter). When the
    harvester starts publishing the envelope itself, this becomes a no-op that
    restates what it said -- which is how to tell it is doing the right thing
    rather than papering over the gap.
    """
    start, end = row.get("datetime_start"), row.get("datetime_end")
    if start is None and end is None:
        return
    extent = document.get("extent")
    if not isinstance(extent, dict):
        extent = {}
        document["extent"] = extent
    extent["temporal"] = {"interval": [[_clean(start), _clean(end)]]}


def record_to_item(
    rec: dict[str, Any],
    *,
    stac_base: str,
    collection_id: str | None = None,
    goat_ui_base_url: str | None = None,
    assets_base: str | None = None,
) -> dict[str, Any]:
    """Return the stored STAC Item, adjusted for serving over this API.

    The catalog stores native STAC Items (the harvester publishes them that
    way), so this is a pass-through with three edits rather than a
    transformation:

    * ``assets`` keep everything the publisher produced except entries backed
      by GOAT's own object storage (``s3://`` -- our GeoParquet and thumbnail).
      Those stay private (design S14); the provider's own download URLs are
      public and survive untouched.
    * Navigational links (``self``/``root``/``parent``/``collection``) are
      rewritten from the static tree's relative hrefs to absolute API URLs.
      All other links -- both ``via`` links, ``license``, ... -- pass through.
    * An ``alternate`` link to the GOAT UI is appended when a UI base URL is
      known, so a reader can get from the metadata to the usable dataset.

    ``collection_id`` may be omitted (e.g. cross-collection ``/search``); the
    document's own ``collection`` is used next, then the row's collection as
    stashed under ``goat:row_collection`` by ``search_items``/``resolve_id``
    (popped either way so it never reaches the response).

    A standalone item genuinely has no collection -- there is no synthetic
    "datasets" collection to invent. When none resolves, the Item omits the
    ``collection`` field and the ``parent``/``collection`` link rels, and its
    ``self`` link points at the collection-agnostic ``{stac_base}/items/{id}``
    route rather than a ``/collections/{cid}/...`` href that would 404.
    """
    # Shallow: every edit below replaces a top-level member (`assets` and
    # `links` are rebuilt, not mutated), so the caller's nested structures are
    # never touched and deep-copying every row of a page was pure cost.
    item = dict(rec)
    item_id = str(item.get("id"))
    row_collection = item.pop("goat:row_collection", None)

    resolved = collection_id or item.get("collection") or row_collection
    cid = str(resolved) if resolved else None

    if _has_published_tiles(item.get("assets")):
        item["properties"] = {**(item.get("properties") or {}), "goat:tiles": True}
    item["assets"] = _public_assets(
        item.get("assets"), item_id=item_id, assets_base=assets_base
    )

    if cid:
        item["collection"] = cid
        coll_href = f"{stac_base}/collections/{cid}"
        self_href = f"{coll_href}/items/{item_id}"
        nav: list[dict[str, Any]] = [
            {"rel": "self", "type": "application/geo+json", "href": self_href},
            {"rel": "root", "type": "application/json", "href": stac_base},
            {"rel": "parent", "type": "application/json", "href": coll_href},
            {"rel": "collection", "type": "application/json", "href": coll_href},
        ]
    else:
        item.pop("collection", None)
        nav = [
            {
                "rel": "self",
                "type": "application/geo+json",
                "href": f"{stac_base}/items/{item_id}",
            },
            {"rel": "root", "type": "application/json", "href": stac_base},
        ]

    # Non-navigational links pass through verbatim (both `via` links, the
    # `license` link, ...). A relative one is dropped: nothing rewrote it, so
    # it would resolve against this API's URL space rather than the static
    # tree it was written for.
    passthrough = [
        lk
        for lk in item.get("links") or []
        if isinstance(lk, dict)
        and lk.get("rel") not in _NAVIGATIONAL_RELS
        and not _is_unservable_link(lk.get("href"))
        and not _is_private_href(lk.get("href"))
    ]
    if goat_ui_base_url:
        passthrough.append(
            {
                "rel": "alternate",
                "type": "text/html",
                "title": "Open in GOAT",
                "href": f"{goat_ui_base_url.rstrip('/')}/catalog/{item_id}",
            }
        )
    item["links"] = [*nav, *passthrough]

    try:
        StacItem.model_validate(item)
    except ValidationError as exc:
        logger.warning("item %s failed STAC validation: %s", item_id, exc)
    return item


def collection_to_stac(
    document: dict[str, Any], *, stac_base: str, goat_ui_base_url: str | None = None
) -> dict[str, Any]:
    """Return the stored STAC Collection, adjusted for serving over this API.

    Same three edits as :func:`record_to_item`: private (``s3://``) assets are
    dropped, navigational links are rewritten to absolute API URLs -- including
    one ``item`` link per member, so a bundle's members are reachable -- and
    everything else the publisher wrote (``extent``, ``summaries``,
    ``providers``, ``license``, ``keywords``, ``via`` links) passes through.
    """
    collection = dict(document)
    cid = str(collection.get("id"))
    coll_href = f"{stac_base}/collections/{cid}"

    collection["assets"] = _public_assets(collection.get("assets"))

    nav: list[dict[str, Any]] = [
        {"rel": "self", "type": "application/json", "href": coll_href},
        {"rel": "root", "type": "application/json", "href": stac_base},
        {"rel": "parent", "type": "application/json", "href": stac_base},
        {
            "rel": "items",
            "type": "application/geo+json",
            "href": f"{coll_href}/items",
        },
    ]

    passthrough: list[dict[str, Any]] = []
    for lk in collection.get("links") or []:
        if not isinstance(lk, dict) or _is_unservable_link(lk.get("href")):
            continue
        rel = lk.get("rel")
        if rel == "item":
            # Stored as `items/<item-id>.json`, relative to the collection's
            # directory in the static tree; the API addresses the same member
            # as a child of this collection.
            member_id = str(lk.get("href") or "").rsplit("/", 1)[-1]
            if member_id.endswith(".json"):
                member_id = member_id[: -len(".json")]
            if not member_id:
                continue
            nav.append(
                {
                    **lk,
                    "rel": "item",
                    "type": "application/geo+json",
                    "href": f"{coll_href}/items/{member_id}",
                }
            )
        elif rel not in _NAVIGATIONAL_RELS and not _is_private_href(lk.get("href")):
            passthrough.append(lk)

    if goat_ui_base_url:
        passthrough.append(
            {
                "rel": "alternate",
                "type": "text/html",
                "title": "Open in GOAT",
                "href": f"{goat_ui_base_url.rstrip('/')}/catalog/{cid}",
            }
        )
    collection["links"] = [*nav, *passthrough]

    try:
        StacCollection.model_validate(collection)
    except ValidationError as exc:
        logger.warning("collection %s failed STAC validation: %s", cid, exc)
    return collection


def catalog_landing(
    stac_base: str,
    *,
    source_ids: list[str],
    service_desc: str,
    conforms_to: list[str],
    capability_links: list[dict[str, Any]],
) -> dict[str, Any]:
    """The STAC landing page -- a Catalog (container + conformsTo).

    ``source_ids`` become a browse filter, not children: a source is a
    Catalog in the static tree, while ``/collections`` lists datasets.

    ``conforms_to`` and ``capability_links`` are passed in rather than built
    here: which extensions this catalog can actually serve is
    ``catalog.services.capabilities``' answer, derived from the loaded file, so
    the page never links a ``queryables`` document for a catalog with nothing
    to filter on.

    Carries ``service-desc`` (the OpenAPI document) but deliberately no
    ``service-doc``: that rel points at a human-readable rendering of the API,
    and this service's consumer is the GOAT UI, not a person reading reference
    docs. stac-api-validator warns about its absence; the warning is accepted.
    """
    links: list[dict[str, Any]] = [
        {"rel": "root", "type": "application/json", "href": stac_base},
        {"rel": "self", "type": "application/json", "href": stac_base},
        {
            "rel": "conformance",
            "type": "application/json",
            "href": f"{stac_base}/conformance",
        },
        {
            # FastAPI's generated OpenAPI document is always served as plain
            # `application/json` (it does not negotiate on Accept), so the
            # declared link type must say so too -- the OGC-preferred
            # `application/vnd.oai.openapi+json;version=3.0` would promise a
            # Content-Type the response never actually sends.
            "rel": "service-desc",
            "type": "application/json",
            "href": service_desc,
        },
        {
            "rel": "data",
            "type": "application/json",
            "href": f"{stac_base}/collections",
        },
        {
            "rel": "search",
            "type": "application/geo+json",
            "method": "GET",
            "href": f"{stac_base}/search",
        },
        {
            "rel": "search",
            "type": "application/geo+json",
            "method": "POST",
            "href": f"{stac_base}/search",
        },
    ]
    links.extend(capability_links)
    for sid in source_ids:
        links.append(
            {
                "rel": "child",
                "type": "application/json",
                "title": sid,
                # Must dereference to the single Collection resource (not the
                # Collection Search *listing* endpoint filtered by `source`)
                # so a STAC client traversing `child` links (pystac, the
                # Core conformance class) can resolve each one as an actual
                # STAC object.
                "href": f"{stac_base}/collections/{sid}",
            }
        )
    return {
        "type": "Catalog",
        "stac_version": STAC_VERSION,
        "id": _CATALOG_ID,
        "title": "GOAT Catalog",
        "description": _CATALOG_DESCRIPTION,
        "conformsTo": conforms_to,
        "links": links,
    }


def item_collection(
    features: list[dict[str, Any]],
    *,
    stac_base: str,
    self_href: str,
    number_matched: int,
    first_href: str | None = None,
    next_href: str | None = None,
    prev_href: str | None = None,
) -> dict[str, Any]:
    """Wrap STAC Items in an ItemCollection (GeoJSON FeatureCollection + links)."""
    links: list[dict[str, Any]] = [
        {"rel": "root", "type": "application/json", "href": stac_base},
        {"rel": "self", "type": "application/geo+json", "href": self_href},
    ]
    if first_href:
        links.append(
            {"rel": "first", "type": "application/geo+json", "href": first_href}
        )
    if next_href:
        links.append({"rel": "next", "type": "application/geo+json", "href": next_href})
    if prev_href:
        links.append({"rel": "prev", "type": "application/geo+json", "href": prev_href})
    return {
        "type": "FeatureCollection",
        "features": features,
        "links": links,
        "numberMatched": number_matched,
        "numberReturned": len(features),
    }
