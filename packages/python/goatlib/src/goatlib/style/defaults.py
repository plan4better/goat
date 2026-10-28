"""Default documents for new layers (imports, tools, catalog promotion)."""

import hashlib
from typing import Any

from goatlib.style.catalog import palette_colors
from goatlib.style.context import DataContext

#: The reference defaults (spec section 18): what an absent key means. Documents
#: stay as their author wrote them, so only renderers apply these; they are
#: published in the JSON Schema as `x-defaults`. Defaults that depend on the
#: document (the pattern color is the fill color, arrows take the line color, the
#: icon on a hollow marker takes the marker color, the label placement follows the
#: geometry) are the compiler's.
REFERENCE_DEFAULTS: dict[str, Any] = {
    "opacity": 1,
    "min_zoom": 0,
    "max_zoom": 24,
    "fill.color": "#2bb381",
    "fill.opacity": 1,
    "fill.pattern": "none",
    "fill.pattern_spacing": 10,
    "fill.pattern_width": 2,
    "outline.color": "#ffffff",
    "outline.width": 1,
    "outline.opacity": 1,
    "outline.dash": "solid",
    "line.color": "#2166ac",
    "line.width": 2,
    "line.opacity": 1,
    "line.dash": "solid",
    "line.cap": "butt",
    "line.join": "round",
    "line.offset": 0,
    "line.blur": 0,
    "casing.color": "#ffffff",
    "casing.width": 1,
    "casing.opacity": 1,
    "arrows.placement": "repeat",
    "arrows.direction": "forward",
    "arrows.spacing": 100,
    "arrows.size": 10,
    "marker.shape": "circle",
    "marker.color": "#2bb381",
    "marker.fill": True,
    "marker.size": 8,
    "marker.opacity": 1,
    "marker.icon_color": "#ffffff",
    "marker.rotation": 0,
    "marker.anchor": "center",
    "marker.offset": [0, 0],
    "marker.allow_overlap": False,
    "label.size": 12,
    "label.color": "#3a3541",
    "label.halo.color": "#ffffff",
    "label.halo.width": 1.5,
    "label.font.weight": "regular",
    "label.offset": [0, 0],
    "label.max_width": 120,
    "label.allow_overlap": False,
    "format.decimals": "auto",
    "format.thousands_separator": True,
    "format.abbreviate": False,
    "format.always_show_sign": False,
    "zoom.interpolate": "linear",
    "zoom.base": 1.6,
    "heatmap.radius": 26,
    "heatmap.intensity": 1,
    "heatmap.opacity": 1,
    "heatmap.weight": 1,
    "heatmap.palette": "d3:magma",
    "cluster.radius": 50,
    "cluster.cluster_until_zoom": 14,
    "cluster.min_points": 2,
    "h3.resolution": "auto",
    "h3.value": {"op": "count"},
    "h3.palette": "colorbrewer:OrRd",
    "h3.opacity": 0.85,
    "h3.outline.color": "#ffffff",
    "h3.outline.width": 1,
    "raster.opacity": 1,
    "raster.resampling": "linear",
    "raster.brightness": 0,
    "raster.contrast": 0,
    "raster.saturation": 0,
    "raster.hue": 0,
    "continuous.palette": "goat:elevation",
    "continuous.interpolate": "linear",
    "continuous.outside": "clamp",
    "terrain.method": "standard",
    "terrain.direction": 315,
    "terrain.altitude": 45,
    "terrain.exaggeration": 0.5,
    "terrain.shadow_color": "#000000",
    "terrain.highlight_color": "#ffffff",
    "terrain.accent_color": "#000000",
    "popup.enabled": True,
    "popup.trigger": "click",
    "popup.mode": "simple",
    "popup.layout": "popup",
    "popup.anchor": "top_right",
    "popup.header": "standard",
    "popup.highlight_active_feature": True,
}

#: Today's look for new layers: a color from the Spectral palette, picked by the
#: layer id instead of at random, so the same layer always gets the same color.
DEFAULT_PALETTE = "colorbrewer:Spectral"


def _color(seed: str | None) -> str:
    colors = palette_colors(DEFAULT_PALETTE) or ["#2bb381"]
    if seed is None:
        return colors[0]
    return colors[hashlib.sha256(seed.encode()).digest()[0] % len(colors)]


def default_style(ctx: DataContext, *, seed: str | None = None) -> dict[str, Any]:
    """A minimal valid document for a dataset; `seed` (the layer id) picks the color."""
    if ctx.kind == "raster":
        # Files and map services start slightly see-through, as they always did.
        return {
            "version": 1,
            "kind": "raster",
            "opacity": 0.8,
            "render": {"type": "image"},
        }
    color = _color(seed)
    if ctx.geometry == "point":
        symbol: dict[str, Any] = {
            "marker": {"shape": "circle", "color": color, "size": 10}
        }
    elif ctx.geometry == "line":
        symbol = {"line": {"color": color, "width": 2}}
    else:
        symbol = {"fill": {"color": color, "opacity": 0.8}, "outline": False}
    return {"version": 1, "kind": "vector", "symbol": symbol}
