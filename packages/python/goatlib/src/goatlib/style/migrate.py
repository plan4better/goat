"""The migration of today's styles to GOAT Style (spec 17).

One function per stored style, shared by core's data migration and the dry run:
convert (`convert_v0`), give ids (merges and issue paths address items by id), and
stamp the computed values with the data they belong to, so a migrated style is
not recomputed on the first map load and keeps the classes people know. A style
that cannot be converted becomes the dataset's default style: the migration never
fails a release on a style. Pure and light: no geospatial imports (core's image).
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from goatlib.style.compute import stamp_computed
from goatlib.style.context import DataContext
from goatlib.style.convert_v0 import LossyNote, convert_v0
from goatlib.style.defaults import default_style
from goatlib.style.ids import assign_ids
from goatlib.style.upgrade import upgrade
from goatlib.style.validate import validate

__all__ = [
    "MigratedStyle",
    "context_for",
    "current",
    "guess_geometry",
    "migrate_style",
    "stamp_computed",
    "stored_document",
]

logger = logging.getLogger(__name__)

_POINT_KEYS = (
    "radius",
    "fixed_radius",
    "radius_field",
    "custom_marker",
    "marker",
    "cluster",
)
_LINE_KEYS = (
    "stroke_pattern",
    "stroke_dash_density",
    "stroke_cap",
    "stroke_join",
    "stroke_offset",
    "decoration_type",
)
_SERVICES = ("wms", "wmts", "xyz")


@dataclass(frozen=True)
class MigratedStyle:
    document: dict[str, Any]
    #: What left the style for the map document's columns (`visible`, `legend_expanded`).
    map_state: dict[str, Any]
    lossy: tuple[LossyNote, ...] = field(default=())
    fell_back: bool = False


def guess_geometry(properties: Any) -> str | None:
    """The geometry today's style keys point to, for styles stored without their layer."""
    if not isinstance(properties, dict):
        return None
    if any(k in properties for k in _POINT_KEYS):
        return "point"
    if any(k in properties for k in _LINE_KEYS):
        return "line"
    return "polygon" if properties else None


def context_for(
    layer_type: str | None, geometry: str | None, data_type: str | None
) -> DataContext:
    """What the converter and the checks know of a layer row: its kind, its
    geometry, and for rasters whether it is a map service."""
    if layer_type == "raster":
        source = data_type if data_type in _SERVICES else "file"
        return DataContext(kind="raster", source=source)  # type: ignore[arg-type]
    return DataContext(kind="vector", geometry=geometry)  # type: ignore[arg-type]


def current(doc: dict[str, Any], ctx: DataContext) -> dict[str, Any]:
    """`doc` at the current version, with ids: a style stored before GOAT Style
    (an older template's remembered style, a catalog asset) is converted for the
    layer `ctx` describes."""
    return assign_ids(upgrade(doc, ctx).document)


def stored_document(doc: Any, ctx: DataContext, *, seed: str) -> dict[str, Any]:
    """A style that did not come through the style API (a template's remembered
    style, a catalog asset, an archive) as it is stored: `current`, and replaced
    by `default_style(ctx, seed=seed)` when it cannot be read or does not
    validate, so nothing invalid reaches the map."""
    if not isinstance(doc, dict):
        return default_style(ctx, seed=seed)
    try:
        document = current(doc, ctx)
        if not any(i.level == "error" for i in validate(document, ctx, stored=True)):
            return document
        logger.warning("A stored style does not validate; using the default")
    except Exception:
        logger.exception("A stored style could not be read; using the default")
    return default_style(ctx, seed=seed)


def migrate_style(
    properties: Any,
    ctx: DataContext,
    *,
    fingerprint: str | None,
    at: str,
    asset_for_url: Callable[[str], str | None] | None = None,
    seed: str | None = None,
) -> MigratedStyle:
    """Today's `properties` as a GOAT Style document with ids, its map state apart,
    and its computed parts stamped with `fingerprint` (none for rasters or when
    `fingerprint` is None). Any failure, or a conversion that stopped early,
    gives `default_style(ctx, seed=seed)`."""
    try:
        result = convert_v0(
            properties if isinstance(properties, dict) else {},
            ctx,
            asset_for_url=asset_for_url,
        )
        if any(note.key == "*" for note in result.lossy):  # stopped early
            return MigratedStyle(
                default_style(ctx, seed=seed),
                dict(result.map_state),
                result.lossy,
                fell_back=True,
            )
        document = assign_ids(result.document)
        if fingerprint is not None and ctx.kind != "raster":
            document = stamp_computed(document, fingerprint, at)
        return MigratedStyle(document, dict(result.map_state), result.lossy)
    except Exception:  # never fail the release on a style: the default stands in
        return MigratedStyle(default_style(ctx, seed=seed), {}, (), fell_back=True)
