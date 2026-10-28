"""What a catalog item says about the layer it becomes: its type, its geometry
and its style. Pure, so the catalog service reads items the way promotion does
without promotion's database drivers."""

from typing import Any

from goatlib.style.migrate import context_for, stored_document


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
