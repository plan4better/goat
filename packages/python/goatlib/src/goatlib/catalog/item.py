"""What a catalog item says about the layer it becomes: its type, its geometry,
its style and where its files are in the catalog bucket. Pure, so the catalog
service and geoapi read items the way promotion does without promotion's
database drivers."""

import posixpath
from typing import Any

from goatlib.style.migrate import context_for, stored_document

#: The data asset of a raster item: a (cloud-optimized) GeoTIFF.
RASTER_SUFFIXES = (".tif", ".tiff")


#: Bundle types that are only a grouping: their layers are added one by one.
PLAIN_BUNDLE_TYPES = frozenset({"", "generic"})

#: Kinds a layer declares for itself; anything else is what its dataset is.
OWN_KINDS = frozenset({"feature", "table", "raster", "wms", "wmts"})


def _is_service(item: dict[str, Any], rel: str) -> bool:
    """Whether the item is a live map service of this kind, promoted as a link and never copied.

    Declared so, or a bundle member (which inherits ``bundle``, or its plan's
    type such as ``xplan``) whose own link of that ``rel`` says so. A layer with
    geometry is vector data even when it also offers a map view. Same rule as
    the web's ``catalogKindOf``.
    """
    declared = (item.get("goat:layerType") or "").lower()
    if declared == rel:
        return True
    return (
        declared not in OWN_KINDS
        and not item.get("goat:geometryType")
        and any(
            isinstance(link, dict) and link.get("rel") == rel and link.get("href")
            for link in item.get("links") or []
        )
    )


def is_wms(item: dict[str, Any]) -> bool:
    return _is_service(item, "wms")


def is_wmts(item: dict[str, Any]) -> bool:
    return _is_service(item, "wmts")


def layer_type(item: dict[str, Any]) -> tuple[str, str | None]:
    """(layer type, geometry type) for the layer row.

    ``goat:geometryType`` absent means an attribute table (contract §3.1),
    unless the data is a GeoTIFF: a bundle's members declare ``bundle``, not
    their own kind, so a raster among them is known by its data asset.
    """
    geom = item.get("goat:geometryType")
    declared = (item.get("goat:layerType") or "").lower()
    if geom:
        return "feature", str(geom).lower()
    if declared in ("table", "feature", "raster"):
        return declared, None
    if is_wms(item) or is_wmts(item):
        return "raster", None
    if str(item.get("parquet_url") or "").lower().endswith(RASTER_SUFFIXES):
        return "raster", None
    return "table", None


def item_style(document: Any, item: dict[str, Any]) -> dict[str, Any] | None:
    """A published style asset as a GOAT Style document for the item's layer: an
    asset without `version` is a version 0 style, converted for the layer's kind
    and geometry, and one that does not validate gives the default style. None
    for a table, or for what is not a style object."""
    ltype, geometry = layer_type(item)
    if ltype == "table" or not isinstance(document, dict):
        return None
    return stored_document(
        document, context_for(ltype, geometry, None), seed=str(item.get("id"))
    )


def bucket_key_for(parquet_url: str, suffixes: tuple[str, ...] = (".parquet",)) -> str:
    """The catalog-bucket key for an item's data asset.

    The published href is relative to the item's place in the bucket's JSON
    tree (``../../../data/<uuid>.parquet`` — contract C8), so only its
    basename is meaningful here; the data prefix is fixed by the bucket
    layout (contract §1). The asset must be of the layer's format: a parquet
    for a vector or table item, a GeoTIFF (`RASTER_SUFFIXES`) for a raster.
    """
    name = posixpath.basename(parquet_url or "")
    if not name.lower().endswith(suffixes):
        raise ValueError(f"Not a {'/'.join(suffixes)} data asset: {parquet_url!r}")
    return f"data/{name}"


def published_tiles_keys(item: dict[str, Any]) -> tuple[str, str | None] | None:
    """Bucket keys of the tiles goat-data built for this item (``assets.tiles``)
    and of its polygon label points (``assets.tiles_anchor``), or None."""
    assets = item.get("assets") or {}
    tiles = (assets.get("tiles") or {}).get("href")
    if not tiles:
        return None
    anchor = (assets.get("tiles_anchor") or {}).get("href")
    try:
        return (
            bucket_key_for(tiles, (".pmtiles",)),
            bucket_key_for(anchor, (".pmtiles",)) if anchor else None,
        )
    except ValueError:
        return None
