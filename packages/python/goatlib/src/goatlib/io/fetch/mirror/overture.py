"""Overture in the mirror: its types, filterable attributes and licences."""

#: Overture's own types, flattened to one choice each: the theme and type are
#: always picked together, so offering them separately would only allow
#: combinations that do not exist.
OVERTURE_TYPES: dict[str, tuple[str, str]] = {
    "places": ("places/place", "point"),
    "divisions": ("divisions/division_area", "polygon"),
    "buildings": ("buildings/building", "polygon"),
    "land_use": ("base/land_use", "polygon"),
    "land_use_lines": ("base/land_use", "line"),
    "land": ("base/land", "polygon"),
    "land_points": ("base/land", "point"),
    "land_lines": ("base/land", "line"),
    "water_areas": ("base/water", "polygon"),
    "waterways": ("base/water", "line"),
    "water_points": ("base/water", "point"),
    "infrastructure_points": ("base/infrastructure", "point"),
    "infrastructure_lines": ("base/infrastructure", "line"),
    "infrastructure_areas": ("base/infrastructure", "polygon"),
}


#: Places come from Meta, Microsoft and others under CDLA; every other theme
#: offered here is built on OSM and stays ODbL.
OVERTURE_LICENCES: dict[str, tuple[str, str]] = {
    "places": ("CDLA-Permissive-2.0", "© Overture Maps Foundation"),
}
OVERTURE_OSM_LICENCE = (
    "ODbL-1.0",
    "© OpenStreetMap contributors, Overture Maps Foundation",
)


#: The Overture themes whose types mix geometries (water has lakes and rivers).
MIXED_THEMES = frozenset({"base"})


#: The attributes worth filtering on, per Overture type, and where each lives.
#: Chosen rather than read off the schema: the useful ones are often nested
#: (a place's category, a brand's name), and the plain columns include free
#: text, ids and decimal scores no filter needs.
OVERTURE_FIELDS: dict[str, dict[str, str]] = {
    "places/place": {
        "category": '"taxonomy"."primary"',
        "basic_category": '"basic_category"',
        "brand": '"brand"."names"."primary"',
        "operating_status": '"operating_status"',
    },
    "buildings/building": {
        "class": '"class"',
        "subtype": '"subtype"',
        "roof_shape": '"roof_shape"',
        "roof_material": '"roof_material"',
        "facade_material": '"facade_material"',
        "is_underground": '"is_underground"',
    },
    "divisions/division_area": {
        "subtype": '"subtype"',
        "class": '"class"',
        "country": '"country"',
    },
    "base/land_use": {
        "subtype": '"subtype"',
        "class": '"class"',
        "surface": '"surface"',
    },
    "base/land": {
        "subtype": '"subtype"',
        "class": '"class"',
        "surface": '"surface"',
    },
    "base/water": {
        "subtype": '"subtype"',
        "class": '"class"',
        "is_intermittent": '"is_intermittent"',
        "is_salt": '"is_salt"',
    },
    "base/infrastructure": {
        "subtype": '"subtype"',
        "class": '"class"',
        "surface": '"surface"',
    },
}


def _joined(items: str) -> str:
    """A list's distinct non-empty values, in first-seen order, as one text.

    Not list_distinct, which does not keep order. NULL when nothing is left, so
    an empty list reads as missing rather than as an empty string.
    """
    return (
        f"NULLIF(array_to_string(list_filter({items}, (x, i) -> x IS NOT NULL "
        f"AND x <> '' AND list_position({items}, x) = i), '; '), '')"
    )


def overture_plain_columns(columns: dict[str, str], alias: str = "c") -> list[str]:
    """Overture's name and source attribution as plain columns, from the nested ones.

    The tile writer drops struct and list columns, so without these the map
    shows nothing for them. ``sources`` also carries each record's licence --
    buildings mix OpenStreetMap (ODbL, attribution required) with Microsoft,
    Google and others -- so the attribution has to be readable on the map too.
    Built only from what the file has: a type without them gets none.
    """
    out = []
    if "primary" in columns.get("names", ""):
        out.append(f'{alias}."names"."primary" AS name')
    sources = columns.get("sources", "")

    def field(name: str) -> str:
        return f"list_transform({alias}.sources, s -> s.{name})"

    if "dataset" in sources:
        out.append(f"{_joined(field('dataset'))} AS source")
    if "license" in sources:
        out.append(f"{_joined(field('license'))} AS source_license")
    if "record_id" in sources:
        out.append(
            f"NULLIF(array_to_string({field('record_id')}, '; '), '') AS source_id"
        )
    if "update_time" in sources:
        out.append(f"list_max({field('update_time')}) AS source_updated")
    return out
