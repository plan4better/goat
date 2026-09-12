"""Default style generation for tool output layers.

Mirrors the style logic from core.schemas.style to generate
consistent default layer properties.
"""

import random
from enum import Enum
from typing import Any

# Spectral color palette (from core.schemas.colors)
# Filtered to exclude light yellows/greens that are hard to see on maps
SPECTRAL_COLORS = [
    "#9e0142",  # dark magenta
    "#d53e4f",  # red
    "#f46d43",  # orange
    "#fdae61",  # light orange
    "#66c2a5",  # teal
    "#3288bd",  # blue
    "#5e4fa2",  # purple
]

# Sequential color ranges for heatmaps
SEQUENTIAL_COLOR_RANGES = {
    "Mint": {
        "name": "Mint",
        "type": "sequential",
        "category": "ColorBrewer",
        "colors": [
            "#e4f1e1",
            "#c0dfd1",
            "#93cfb5",
            "#63b598",
            "#3a9c7c",
            "#1a8060",
            "#006344",
        ],
    },
    "BluYl": {
        "name": "BluYl",
        "type": "sequential",
        "category": "ColorBrewer",
        "colors": [
            "#f7feae",
            "#b7e6a5",
            "#7ccba2",
            "#46aea0",
            "#089099",
            "#00718b",
            "#045275",
        ],
    },
    "Teal": {
        "name": "Teal",
        "type": "sequential",
        "category": "ColorBrewer",
        "colors": [
            "#d1eeea",
            "#a8dbd9",
            "#85c4c9",
            "#68abb8",
            "#4f90a6",
            "#3b738f",
            "#2a5674",
        ],
    },
    "Emrld": {
        "name": "Emrld",
        "type": "sequential",
        "category": "ColorBrewer",
        "colors": [
            "#d3f2a3",
            "#97e196",
            "#6cc08b",
            "#4c9b82",
            "#217a79",
            "#105965",
            "#074050",
        ],
    },
}


class ToolStyleType(str, Enum):
    """Tool types that have custom default styles."""

    heatmap_gravity = "heatmap_gravity"
    heatmap_closest_average = "heatmap_closest_average"
    heatmap_connectivity = "heatmap_connectivity"
    catchment_area = "catchment_area"
    isochrone = "isochrone"
    oev_gueteklasse = "oev_gueteklassen"


# Tool-specific style configurations
TOOL_STYLE_CONFIG: dict[str, dict[str, Any]] = {
    "heatmap_gravity": {
        "color_field": {"name": "accessibility", "type": "number"},
        "color_scale": "quantile",
        "color_range_type": "sequential",
    },
    "heatmap_closest_average": {
        "color_field": {"name": "total_accessibility", "type": "number"},
        "color_scale": "quantile",
        "color_range_type": "sequential",
    },
    "heatmap_connectivity": {
        "color_field": {"name": "accessibility", "type": "number"},
        "color_scale": "quantile",
        "color_range_type": "sequential",
    },
    "catchment_area": {
        "color_field": {"name": "travel_cost", "type": "number"},
        "color_scale": "ordinal",
        "color_range_type": "sequential",
    },
    "isochrone": {
        "color_field": {"name": "travel_cost", "type": "number"},
        "color_scale": "ordinal",
        "color_range_type": "sequential",
    },
}

DEFAULT_STYLE_SETTINGS = {
    "min_zoom": 1,
    "max_zoom": 22,
    "visibility": True,
}

DEFAULT_POINT_STYLE = {
    **DEFAULT_STYLE_SETTINGS,
    "filled": True,
    "fixed_radius": False,
    "radius_range": [0, 10],
    "radius_scale": "linear",
    "radius": 5,
    "opacity": 1,
    "stroked": False,
}

DEFAULT_LINE_STYLE = {
    **DEFAULT_STYLE_SETTINGS,
    "filled": True,
    "opacity": 1,
    "stroked": True,
    "stroke_width": 7,
    "stroke_width_range": [0, 10],
    "stroke_width_scale": "linear",
}

DEFAULT_POLYGON_STYLE = {
    **DEFAULT_STYLE_SETTINGS,
    "filled": True,
    "opacity": 0.8,
    "stroked": False,
    "stroke_width": 3,
    "stroke_width_range": [0, 10],
    "stroke_width_scale": "linear",
    "stroke_color": [217, 25, 85],
}

# Named color palettes for ordinal scales
ORDINAL_COLOR_PALETTES: dict[str, list[str]] = {
    # Yellow-Green (good for catchment areas - proximity feel)
    "YlGn": [
        "#FFFFCC",
        "#D9F0A3",
        "#ADDD8E",
        "#78C679",
        "#41AB5D",
        "#238443",
        "#006837",
        "#004529",
    ],
    # Orange-Red (good for buffers - distance/heat feel)
    "OrRd": [
        "#FEE5D9",
        "#FCBBA1",
        "#FC9272",
        "#FB6A4A",
        "#EF3B2C",
        "#CB181D",
        "#99000D",
        "#67000D",
    ],
    # Sunset (purple to yellow - good for time-based)
    "Sunset": [
        "#f3e79b",
        "#fac484",
        "#f8a07e",
        "#eb7f86",
        "#ce6693",
        "#a059a0",
        "#5c53a5",
    ],
    # Blue-Purple (good for density/intensity)
    "BuPu": [
        "#EDF8FB",
        "#BFD3E6",
        "#9EBCDA",
        "#8C96C6",
        "#8C6BB1",
        "#88419D",
        "#6E016B",
    ],
}


def hex_to_rgb(hex_color: str) -> list[int]:
    """Convert hex color to RGB list.

    Args:
        hex_color: Color in hex format (e.g., "#9e0142")

    Returns:
        RGB values as [r, g, b]
    """
    hex_color = hex_color.lstrip("#")
    return [int(hex_color[i : i + 2], 16) for i in (0, 2, 4)]


def rgb_to_hex(rgb: list[int]) -> str:
    """Convert RGB list to hex color.

    Args:
        rgb: RGB values as [r, g, b]

    Returns:
        Color in hex format (e.g., "#9e0142")
    """
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def interpolate_colors(colors: list[str], num_colors: int) -> list[str]:
    """Interpolate a color palette to produce exactly num_colors colors.

    If num_colors <= len(colors), returns a subset of the original colors.
    If num_colors > len(colors), interpolates to create additional colors.

    Args:
        colors: Base color palette in hex format
        num_colors: Number of colors needed

    Returns:
        List of hex colors with exactly num_colors entries
    """
    if num_colors <= 0:
        return []

    if num_colors == 1:
        return [colors[0]]

    if num_colors <= len(colors):
        # Select evenly spaced colors from the palette
        if num_colors == len(colors):
            return colors[:]
        indices = [
            int(i * (len(colors) - 1) / (num_colors - 1)) for i in range(num_colors)
        ]
        return [colors[i] for i in indices]

    # Need more colors than available - interpolate
    result = []
    rgb_colors = [hex_to_rgb(c) for c in colors]

    for i in range(num_colors):
        # Calculate position in the original color range
        pos = i * (len(colors) - 1) / (num_colors - 1)
        lower_idx = int(pos)
        upper_idx = min(lower_idx + 1, len(colors) - 1)
        frac = pos - lower_idx

        # Interpolate between adjacent colors
        r = int(rgb_colors[lower_idx][0] * (1 - frac) + rgb_colors[upper_idx][0] * frac)
        g = int(rgb_colors[lower_idx][1] * (1 - frac) + rgb_colors[upper_idx][1] * frac)
        b = int(rgb_colors[lower_idx][2] * (1 - frac) + rgb_colors[upper_idx][2] * frac)
        result.append(rgb_to_hex([r, g, b]))

    return result


def build_ordinal_color_map(
    values: list[int | float | str],
    palette: str | list[str] = "OrRd",
) -> tuple[list[str], list[list[Any]]]:
    """Build an ordinal color map for a list of discrete values.

    Creates a mapping from values to colors, interpolating the palette
    if there are more values than colors in the palette.

    Args:
        values: List of discrete values to map to colors
        palette: Either a palette name from ORDINAL_COLOR_PALETTES,
                 or a list of hex colors

    Returns:
        Tuple of (colors_list, color_map) where:
        - colors_list: List of hex colors used
        - color_map: List of [[str(value)], hex_color] pairs for ordinal scale
    """
    if isinstance(palette, str):
        base_colors = ORDINAL_COLOR_PALETTES.get(
            palette, ORDINAL_COLOR_PALETTES["OrRd"]
        )
    else:
        base_colors = palette

    # Interpolate colors to match number of values
    colors = interpolate_colors(base_colors, len(values))

    # Build color_map: [[str(value)], color] for ordinal scale
    color_map = [[[str(val)], colors[i]] for i, val in enumerate(values)]

    return colors, color_map


def get_ordinal_polygon_style(
    color_field: str,
    values: list[int | float | str],
    palette: str | list[str] = "OrRd",
    opacity: float = 0.7,
) -> dict[str, Any]:
    """Generate a complete ordinal polygon style for discrete values.

    This is a convenience function that combines build_ordinal_color_map
    with DEFAULT_POLYGON_STYLE to create a ready-to-use style dict.

    Args:
        color_field: Name of the field containing the values
        values: List of discrete values to map to colors
        palette: Either a palette name (YlGn, OrRd, Sunset, BuPu) or list of hex colors
        opacity: Fill opacity (default 0.7)

    Returns:
        Complete style dict for ordinal polygon visualization
    """
    colors, color_map = build_ordinal_color_map(values, palette)

    return {
        **DEFAULT_POLYGON_STYLE,
        "color": hex_to_rgb(colors[len(colors) // 2]),  # Middle color as default
        "opacity": opacity,
        "color_field": {"name": color_field, "type": "number"},
        "color_range": {
            "name": "Custom",
            "type": "custom",
            "colors": colors,
            "category": "Custom",
            "color_map": color_map,
        },
        "color_scale": "ordinal",
    }


def get_ordinal_line_style(
    color_field: str,
    values: list[int | float | str],
    palette: str | list[str] = "OrRd",
    opacity: float = 1.0,
    stroke_width: int = 3,
) -> dict[str, Any]:
    """Generate a complete ordinal line style for discrete values.

    Similar to get_ordinal_polygon_style but uses stroke_color properties
    so that MapLibre line layers render the color map correctly.

    Args:
        color_field: Name of the field containing the values
        values: List of discrete values to map to colors
        palette: Either a palette name (YlGn, OrRd, Sunset, BuPu) or list of hex colors
        opacity: Line opacity (default 1.0)
        stroke_width: Line width in pixels (default 3)

    Returns:
        Complete style dict for ordinal line visualization
    """
    colors, color_map = build_ordinal_color_map(values, palette)

    return {
        **DEFAULT_LINE_STYLE,
        "stroke_color": hex_to_rgb(colors[len(colors) // 2]),  # Middle color as default
        "color": hex_to_rgb(colors[len(colors) // 2]),
        "opacity": opacity,
        "stroke_width": stroke_width,
        "stroke_color_field": {"name": color_field, "type": "number"},
        "stroke_color_range": {
            "name": "Custom",
            "type": "custom",
            "colors": colors,
            "category": "Custom",
            "color_map": color_map,
        },
        "stroke_color_scale": "ordinal",
    }


def get_default_style(geometry_type: str | None) -> dict[str, Any]:
    """Generate default layer style based on geometry type.

    Args:
        geometry_type: Normalized geometry type ("point", "line", "polygon")

    Returns:
        Style dict compatible with GOAT layer properties
    """
    # Pick a random color from Spectral palette
    color = hex_to_rgb(random.choice(SPECTRAL_COLORS))

    if geometry_type == "point":
        return {
            "color": color,
            **DEFAULT_POINT_STYLE,
        }
    elif geometry_type == "line":
        return {
            "color": color,
            "stroke_color": color,
            **DEFAULT_LINE_STYLE,
        }
    elif geometry_type == "polygon":
        return {
            "color": color,
            **DEFAULT_POLYGON_STYLE,
        }
    else:
        # Fallback for unknown/null geometry
        return {
            "color": color,
            **DEFAULT_STYLE_SETTINGS,
        }


#: A network's bulk: mid grey, so it reads as the backdrop it is and whatever is
#: analysed on top of it keeps the colour. `#717171` is the same neutral the PT
#: service palette uses for "no service", so the two greys in the app are one
#: grey.
BUNDLE_BACKDROP_GREY = "#717171"

#: The part of a network worth picking out of that bulk — the nodes an edge
#: snaps to and splits at, the shapes a stop belongs to. Findable against the
#: grey without being a colour an analysis result would want.
BUNDLE_ACCENT_RED = "#e53935"

#: A halo, so a point stays a point wherever it lands: a grey stop sitting on
#: the red line it serves, or on a basemap the same value as itself, is only
#: separable from what is behind it by an outline. The same white the editor's
#: snapping indicator rings its vertices with.
BUNDLE_POINT_HALO_WHITE = "#ffffff"

#: Per-role overrides merged onto the geometry's default style when a bundle's
#: member layers are created — keyed by (bundle type, spec role).
#:
#: A bundle's members are one dataset drawn together, so a random colour each
#: (which is what an ordinary upload gets, and reasonably: nothing is known
#: about it) makes a street network arrive as two unrelated layers in whatever
#: two colours came up. Thin and grey is also what a network being *routed on*
#: should look like: present, and not competing with the result drawn over it.
BUNDLE_ROLE_STYLES: dict[tuple[str, str], dict[str, Any]] = {
    # A street network is its edges, with the nodes picked out on top.
    ("street_network", "edges"): {
        "color": hex_to_rgb(BUNDLE_BACKDROP_GREY),
        "stroke_color": hex_to_rgb(BUNDLE_BACKDROP_GREY),
        "stroke_width": 2,
    },
    ("street_network", "nodes"): {
        "color": hex_to_rgb(BUNDLE_ACCENT_RED),
        "radius": 3,
    },
    # A PT network reads the other way round: the stops are the many, and the
    # shapes are the lines they sit along.
    ("pt_network_gtfs", "stops"): {
        "color": hex_to_rgb(BUNDLE_BACKDROP_GREY),
        "radius": 4,
        # `stroked` is what turns the outline on: the point default has it off,
        # and the renderer reads a width of 0 without it.
        "stroked": True,
        "stroke_color": hex_to_rgb(BUNDLE_POINT_HALO_WHITE),
        "stroke_width": 2,
    },
    ("pt_network_gtfs", "shapes"): {
        "color": hex_to_rgb(BUNDLE_ACCENT_RED),
        "stroke_color": hex_to_rgb(BUNDLE_ACCENT_RED),
        "stroke_width": 3,
    },
}


def get_bundle_style(
    bundle_type: str | None,
    role: str | None,
    geometry_type: str | None,
) -> dict[str, Any]:
    """The style a bundle member layer is created with.

    The geometry's default style with the role's overrides on top, so a role
    states only what it means to change and inherits the rest — a member with
    no entry is styled exactly as any other upload of that geometry.
    """
    base = get_default_style(geometry_type)
    # `getattr(x, "value", x)`: a caller may hold the enum member or the raw
    # string, and `str()` on a `(str, Enum)` gives "BundleTypeName.x".
    key = (
        str(getattr(bundle_type, "value", bundle_type)),
        str(getattr(role, "value", role)),
    )
    override = BUNDLE_ROLE_STYLES.get(key)
    return {**base, **override} if override else base


def get_tool_style(
    tool_type: str,
    geometry_type: str | None = "polygon",
    color_scale_breaks: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Generate style for a specific tool type with color scale support.

    Args:
        tool_type: The tool type (e.g., "heatmap_gravity", "catchment_area")
        geometry_type: Normalized geometry type ("point", "line", "polygon")
        color_scale_breaks: Optional pre-computed break values for quantile scales
            Format: {"min": 0, "max": 100, "mean": 50, "breaks": [20, 40, 60, 80]}

    Returns:
        Style dict with color field and scale configuration
    """
    # Get base style for geometry type
    base_style = get_default_style(geometry_type)

    # Check if we have a specific config for this tool
    tool_config = TOOL_STYLE_CONFIG.get(tool_type)
    if not tool_config:
        return base_style

    # Pick a random sequential color range
    color_range_key = random.choice(list(SEQUENTIAL_COLOR_RANGES.keys()))
    color_range = SEQUENTIAL_COLOR_RANGES[color_range_key]

    # Build the style with color field configuration
    style = {
        **base_style,
        "color_field": tool_config["color_field"],
        "color_range": color_range,
        "color_scale": tool_config["color_scale"],
    }

    # Add color scale breaks if provided
    if color_scale_breaks:
        style["color_scale_breaks"] = color_scale_breaks

    return style


def get_ordinal_style(
    color_field_name: str = "travel_cost",
    color_scale_breaks: dict[str, Any] | None = None,
    color_range_name: str | None = None,
) -> dict[str, Any]:
    """Generate ordinal color scale style for catchment areas.

    Uses ordinal scale where each discrete value maps to a color,
    suitable for isochrone/catchment area visualization.

    Args:
        color_field_name: Name of the field to use for coloring
        color_scale_breaks: Break values defining color boundaries
        color_range_name: Optional specific color range name

    Returns:
        Style dict configured for ordinal visualization
    """
    # Default color range for catchment areas (orange-red gradient)
    sunset_range = {
        "name": "Sunset",
        "type": "sequential",
        "category": "ColorBrewer",
        "colors": [
            "#f3e79b",  # Light yellow
            "#fac484",  # Light orange
            "#f8a07e",  # Orange
            "#eb7f86",  # Salmon
            "#ce6693",  # Pink
            "#a059a0",  # Purple
            "#5c53a5",  # Dark purple
        ],
    }

    # Use specified color range or sunset default
    if color_range_name and color_range_name in SEQUENTIAL_COLOR_RANGES:
        color_range = SEQUENTIAL_COLOR_RANGES[color_range_name]
    elif color_range_name == "Sunset":
        color_range = sunset_range
    else:
        color_range = sunset_range

    style = {
        **DEFAULT_POLYGON_STYLE,
        "color": hex_to_rgb(color_range["colors"][3]),  # Middle color as base
        "color_field": {"name": color_field_name, "type": "number"},
        "color_range": color_range,
        "color_scale": "ordinal",
    }

    if color_scale_breaks:
        style["color_scale_breaks"] = color_scale_breaks

    return style


def get_heatmap_style(
    color_field_name: str = "accessibility",
    color_scale_breaks: dict[str, Any] | None = None,
    color_range_name: str | None = None,
) -> dict[str, Any]:
    """Generate heatmap-specific style with quantile color scale.

    Args:
        color_field_name: Name of the field to use for coloring
        color_scale_breaks: Optional pre-computed break values
        color_range_name: Optional specific color range name (Mint, BluYl, Teal, Emrld)
                         If None, picks randomly

    Returns:
        Style dict configured for heatmap visualization
    """
    # Use specified color range or pick randomly
    if color_range_name and color_range_name in SEQUENTIAL_COLOR_RANGES:
        color_range = SEQUENTIAL_COLOR_RANGES[color_range_name]
    else:
        color_range_key = random.choice(list(SEQUENTIAL_COLOR_RANGES.keys()))
        color_range = SEQUENTIAL_COLOR_RANGES[color_range_key]

    style = {
        **DEFAULT_POLYGON_STYLE,
        "color": hex_to_rgb(color_range["colors"][3]),  # Middle color as base
        "color_field": {"name": color_field_name, "type": "number"},
        "color_range": color_range,
        "color_scale": "quantile",
        # For polygons, also set stroke color scale to match
        "stroke_color_range": color_range,
        "stroke_color_scale": "quantile",
    }

    if color_scale_breaks:
        style["color_scale_breaks"] = color_scale_breaks

    return style


# ÖV-Güteklassen style configuration
OEV_GUETEKLASSEN_BASE_COLOR_MAP = {
    "A": "#199741",  # Dark green - best quality
    "B": "#8BCC62",  # Light green
    "C": "#DCF09E",  # Yellow-green
    "D": "#FFDF9A",  # Yellow
    "E": "#F69053",  # Orange
    "F": "#E4696A",  # Red - worst quality
}
OEV_GUETEKLASSEN_DEFAULT_CLASS_COUNT = len(OEV_GUETEKLASSEN_BASE_COLOR_MAP)


def _int_to_alpha_label(value: int) -> str:
    """Convert a 1-based integer to an alphabetical label (A, ..., Z, AA, ...)."""
    result = ""
    remainder = value
    while remainder > 0:
        remainder -= 1
        result = chr(65 + (remainder % 26)) + result
        remainder //= 26
    return result


def _generate_oev_class_labels(class_count: int) -> list[str]:
    """Generate sequential alphabetical class labels for PT classes."""
    return [_int_to_alpha_label(i) for i in range(1, class_count + 1)]


def _build_oev_gueteklassen_color_map(class_labels: list[str]) -> dict[str, str]:
    """Build label->color mapping, preserving legacy A-F colors and extending beyond F."""
    color_map = OEV_GUETEKLASSEN_BASE_COLOR_MAP.copy()

    additional_labels = [
        label for label in class_labels if label not in OEV_GUETEKLASSEN_BASE_COLOR_MAP
    ]

    if additional_labels:
        additional_colors = interpolate_colors(
            [OEV_GUETEKLASSEN_BASE_COLOR_MAP["F"], "#9e0142"],
            len(additional_labels) + 1,
        )[1:]
        color_map.update(dict(zip(additional_labels, additional_colors, strict=True)))

    return {label: color_map[label] for label in class_labels}


def get_oev_gueteklassen_style(
    class_count: int = OEV_GUETEKLASSEN_DEFAULT_CLASS_COUNT,
) -> dict[str, Any]:
    """Generate style for ÖV-Güteklassen (PT quality classes) output.

    Uses ordinal color scale with alphabetical categories representing
    public transport accessibility quality from best (A) to worst (later labels).
    Keeps legacy A-F colors and extends with darker red shades for additional classes.

    Args:
        class_count: Number of quality classes to include in the ordinal style.

    Returns:
        Style dict configured for ÖV-Güteklassen visualization
    """
    normalized_class_count = max(1, class_count)
    class_labels = _generate_oev_class_labels(normalized_class_count)
    class_color_map = _build_oev_gueteklassen_color_map(class_labels)
    colors = list(class_color_map.values())
    color_map = [[[class_name], color] for class_name, color in class_color_map.items()]

    return {
        **DEFAULT_POLYGON_STYLE,
        "color": hex_to_rgb(colors[2]),  # Default to middle color
        "opacity": 0.8,
        "stroked": False,
        "color_field": {"name": "pt_class_label", "type": "string"},
        "color_range": {
            "name": "Custom",
            "type": "custom",
            "colors": colors,
            "category": "Custom",
            "color_map": color_map,
        },
        "color_scale": "ordinal",
    }


# Station category color map (1-7 categories, 999 = no service)
OEV_GUETEKLASSEN_STATION_COLOR_MAP = {
    "1": "#000000",  # Category I - black (best)
    "2": "#000000",  # Category II
    "3": "#000000",  # Category III
    "4": "#000000",  # Category IV
    "5": "#000000",  # Category V
    "6": "#000000",  # Category VI
    "7": "#000000",  # Category VII (worst with service)
    "999": "#717171",  # No service - gray
}


def get_oev_gueteklassen_stations_style() -> dict[str, Any]:
    """Generate style for ÖV-Güteklassen station points.

    Uses ordinal color scale with station categories 1-7 and 999 (no service).

    Returns:
        Style dict configured for station point visualization
    """
    colors = list(OEV_GUETEKLASSEN_STATION_COLOR_MAP.values())
    color_map = [
        [[cat], color] for cat, color in OEV_GUETEKLASSEN_STATION_COLOR_MAP.items()
    ]

    return {
        **DEFAULT_POINT_STYLE,
        "color": hex_to_rgb("#000000"),
        "radius": 3,
        "opacity": 1,
        "color_field": {"name": "station_category", "type": "number"},
        "color_range": {
            "name": "Custom",
            "type": "custom",
            "colors": colors,
            "category": "Custom",
            "color_map": color_map,
        },
        "color_scale": "ordinal",
        "marker_size": 10,
        "fixed_radius": False,
    }


# Trip Count style configuration
TRIP_COUNT_COLOR_RANGE = {
    "name": "BuPu",
    "type": "sequential",
    "category": "ColorBrewer",
    "colors": [
        "#e0ecf4",
        "#bfd3e6",
        "#9ebcda",
        "#8c96c6",
        "#8c6bb1",
        "#88419d",
        "#6e016b",
    ],
}


def get_trip_count_style(
    color_scale_breaks: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Generate style for Trip Count station points.

    Uses a quantile color scale based on total trip counts.

    Args:
        color_scale_breaks: Optional pre-computed break values for quantile scales

    Returns:
        Style dict configured for trip count point visualization
    """
    color_range = TRIP_COUNT_COLOR_RANGE

    style = {
        **DEFAULT_POINT_STYLE,
        "color": hex_to_rgb(color_range["colors"][3]),  # Middle color as base
        "color_field": {"name": "total", "type": "number"},
        "color_range": color_range,
        "color_scale": "quantile",
    }

    if color_scale_breaks:
        style["color_scale_breaks"] = color_scale_breaks

    return style


# Starting point marker configuration (same as GOAT core legacy)
STARTING_POINT_MARKER = {
    "url": "https://assets.plan4better.de/icons/maki/foundation-marker.svg",
    "name": "foundation-marker",
}


def get_starting_points_style() -> dict[str, Any]:
    """Generate style for starting points used in catchment area analysis.

    Uses a maki marker icon style matching the GOAT core legacy version.
    The marker is a standard map pin that stands out against catchment area polygons.

    Returns:
        Style dict configured for starting point visualization with marker icon
    """
    return {
        **DEFAULT_POINT_STYLE,
        "color": hex_to_rgb("#000000"),  # Black marker
        "marker": STARTING_POINT_MARKER,
        "custom_marker": True,
        "marker_size": 40,
        "marker_anchor": "bottom",
        "marker_allow_overlap": True,
        "marker_offset": [0, 0],
        "opacity": 1,
        "stroked": False,
        "fixed_radius": False,
    }
