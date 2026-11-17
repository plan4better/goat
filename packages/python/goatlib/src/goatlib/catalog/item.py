"""What a catalog item says about the layer it becomes: its type, its geometry
and its style. Pure, so the catalog service reads items the way promotion does
without promotion's database drivers."""

from typing import Any

from goatlib.style.migrate import context_for, stored_document

#: The data asset of a raster item: a (cloud-optimized) GeoTIFF.
RASTER_SUFFIXES = (".tif", ".tiff")


def _is_service(item: dict[str, Any], rel: str) -> bool:
    """Whether the item is a live map service of this kind, promoted as a link and never copied.

    Declared so, or a bundle member (which inherits ``bundle``) whose own link of
    that ``rel`` says so. A layer with geometry is vector data even when it also
    offers a map view. Same rule as the web's ``catalogKindOf``.
    """
    declared = (item.get("goat:layerType") or "").lower()
    if declared == rel:
        return True
    return (
        declared in ("", "bundle")
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
