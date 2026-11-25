"""The map project of the evals: its layers, groups, filters and the
dashboard, workflow and print layout that use one of its layers.

Generated, seeded tables with shapes chosen on purpose: a long right tail
(Districts' density), a few categories holding most features (Points of
interest), values around zero (Polling stations), missing values
(Buildings). ``map_backends`` keeps the state the stand-ins change.
"""

import json
import random
from typing import Any

from evals.backends import FixtureLayer, _at

MAP_PROJECT_ID = "00000000-0000-0000-0000-0000000005e9"
#: The same project for a user who may only view it: core refuses every write.
MAP_VIEW_PROJECT_ID = "00000000-0000-0000-0000-0000000005ea"
MAP_PROJECT_NAME = "Stadtplan Beispiel"
MAP_WORKFLOW_ID = "0b6f0000-0000-0000-0000-0000000000e3"
MAP_REPORT_LAYOUT_ID = "1a700000-0000-0000-0000-000000000001"

#: Points of interest: the five most frequent categories hold 630 of 900
#: features, the other 35 the rest, fewer each.
_TOP_CATEGORIES = (
    ("restaurant", 200),
    ("cafe", 150),
    ("shop", 120),
    ("bus_stop", 90),
    ("pharmacy", 70),
)
_OTHER_CATEGORIES = (
    "bakery", "bank", "bar", "bicycle_parking", "bookshop", "car_park",
    "charging_station", "cinema", "clinic", "community_centre", "dentist",
    "doctor", "fire_station", "fountain", "hairdresser", "hospital", "hotel",
    "kindergarten", "library", "market", "museum", "playground", "police",
    "post_office", "pub", "school", "sports_centre", "swimming_pool", "taxi",
    "theatre", "toilets", "town_hall", "university", "viewpoint", "zoo",
)  # fmt: skip
_OTHER_COUNTS = (
    22, 21, 19, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 8, 7, 7, 6, 6, 5, 5,
    4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 1, 1,
)  # fmt: skip
#: Land use: residential most, water and mixed least.
_LAND_USES = (
    ("residential", 90),
    ("farmland", 45),
    ("forest", 45),
    ("park", 30),
    ("commercial", 30),
    ("industrial", 24),
    ("water", 18),
    ("mixed", 18),
)
_LINE_CLASSES = ("metro", "city", "express", "regional", "night")
_SURFACES = ("asphalt", "paving_stones", "concrete", "gravel", "unpaved")
_STATION_LINES = ("S1", "S2", "S3", "S5", "U1", "U2", "U3", "U4")


def _layer_id(layer_project_id: int) -> str:
    return f"e3000000-0000-0000-0000-0000000000{layer_project_id}"


def _feature_layer(
    layer_project_id: int,
    name: str,
    geometry: str,
    fields: dict[str, str],
    features: list[dict[str, Any]],
) -> FixtureLayer:
    return FixtureLayer(
        layer_project_id,
        _layer_id(layer_project_id),
        name,
        geometry,
        fields,
        tuple(features),
    )


def _build_map_layers() -> tuple[FixtureLayer, ...]:
    rng = random.Random(11)
    districts = []
    for n in range(1, 61):
        density = round(rng.lognormvariate(8, 0.6), 1)
        area = round(rng.uniform(0.8, 12), 2)
        districts.append(
            {
                "name": f"District {n}",
                "population": round(density * area),
                "area_km2": area,
                "density": density,
                "_at": _at(rng),
            }
        )
    categories = [name for name, count in _TOP_CATEGORIES for _ in range(count)]
    categories += [
        name
        for name, count in zip(_OTHER_CATEGORIES, _OTHER_COUNTS, strict=True)
        for _ in range(count)
    ]
    rng.shuffle(categories)
    places = [
        {
            "name": f"Place {n}",
            "category": category,
            "opening_year": rng.randint(1890, 2025),
            "_at": _at(rng),
        }
        for n, category in enumerate(categories, start=1)
    ]
    bus_lines = [
        {
            "name": f"Line {n}",
            "line_class": rng.choice(_LINE_CLASSES),
            "frequency_per_hour": rng.randint(1, 12),
            "_at": _at(rng),
        }
        for n in range(1, 46)
    ]
    uses = [name for name, count in _LAND_USES for _ in range(count)]
    rng.shuffle(uses)
    land_use = [
        {"use": use, "area_m2": round(rng.lognormvariate(9, 1.0), 1), "_at": _at(rng)}
        for use in uses
    ]
    polling = [
        {
            "name": f"Polling station {n}",
            "turnout_change": round(max(-15.0, min(15.0, rng.gauss(0, 5))), 1),
            "_at": _at(rng),
        }
        for n in range(1, 121)
    ]
    no_year = set(rng.sample(range(800), 280))
    named = set(rng.sample(range(800), 80))
    buildings = [
        {
            "floors": min(20, 1 + int(rng.expovariate(0.3))),
            "year_built": None if n in no_year else rng.randint(1870, 2024),
            "name": f"Building {n + 1}" if n in named else None,
            "_at": _at(rng),
        }
        for n in range(800)
    ]
    boundaries = [{"name": f"Old district {n}", "_at": _at(rng)} for n in range(1, 13)]
    stations = [
        {
            "name": f"Station {n}",
            "lines": ", ".join(sorted(rng.sample(_STATION_LINES, rng.randint(1, 3)))),
            "_at": _at(rng),
        }
        for n in range(1, 71)
    ]
    cycling = [
        {
            "surface": rng.choice(_SURFACES),
            "width_m": round(rng.uniform(1.0, 4.0), 1),
            "_at": _at(rng),
        }
        for _ in range(200)
    ]
    return (
        _feature_layer(
            31,
            "Districts",
            "polygon",
            {
                "name": "string",
                "population": "integer",
                "area_km2": "number",
                "density": "number",
            },
            districts,
        ),
        _feature_layer(
            32,
            "Points of interest",
            "point",
            {"name": "string", "category": "string", "opening_year": "integer"},
            places,
        ),
        _feature_layer(
            33,
            "Bus lines",
            "line",
            {"name": "string", "line_class": "string", "frequency_per_hour": "integer"},
            bus_lines,
        ),
        _feature_layer(
            34,
            "Land use",
            "polygon",
            {"use": "string", "area_m2": "number"},
            land_use,
        ),
        _feature_layer(
            35,
            "Polling stations",
            "point",
            {"name": "string", "turnout_change": "number"},
            polling,
        ),
        _feature_layer(
            36,
            "Buildings",
            "polygon",
            {"floors": "integer", "year_built": "integer", "name": "string"},
            buildings,
        ),
        FixtureLayer(37, _layer_id(37), "Elevation", "", {}, (), layer_type="raster"),
        FixtureLayer(
            38, _layer_id(38), "Aerial image", "", {}, (), layer_type="raster"
        ),
        _feature_layer(39, "Old boundaries", "polygon", {"name": "string"}, boundaries),
        _feature_layer(
            40, "Stations", "point", {"name": "string", "lines": "string"}, stations
        ),
        _feature_layer(
            41,
            "Cycling network",
            "line",
            {"surface": "string", "width_m": "number"},
            cycling,
        ),
    )


MAP_LAYERS = _build_map_layers()
#: The layer a finished workflow run saves in the map project: catchment
#: areas as the catchment tool writes them, one polygon per travel time step
#: and starting point. It is no layer of the project until a run saved it.
MAP_RESULT_LAYER = _feature_layer(
    42,
    "Catchment areas",
    "polygon",
    {"cost_step": "integer"},
    [
        {"cost_step": step, "_at": (12.4 + 0.01 * n, 51.35)}
        for n in range(4)
        for step in (5, 10, 15)
    ],
)
_ALL_LAYERS = (*MAP_LAYERS, MAP_RESULT_LAYER)
MAP_LAYERS_BY_ID = {layer.layer_id: layer for layer in _ALL_LAYERS}
_BY_LINK = {layer.layer_project_id: layer for layer in _ALL_LAYERS}


def map_layer(layer_project_id: int) -> FixtureLayer:
    """A layer of the map project by its layer_project_id, the one a run
    saves included."""
    return _BY_LINK[layer_project_id]


#: The rasters' bands as processes reads them from the files: what the
#: stand-in checks raster styles against (no pixel is read).
RASTER_BANDS: dict[int, tuple[str, tuple[tuple[float, float], ...]]] = {
    37: ("float32", ((98.0, 412.0),)),
    38: ("uint8", ((0.0, 255.0),) * 4),
}

# ---- groups and the tree -------------------------------------------------------

#: id -> the group row: name, parent, order among its siblings (0 on top),
#: shown, open in the layer tree.
MAP_GROUPS: dict[int, dict[str, Any]] = {
    1: {
        "name": "Base data",
        "parent_id": None,
        "order": 3,
        "visible": True,
        "expanded": True,
    },
    2: {
        "name": "Transport",
        "parent_id": None,
        "order": 2,
        "visible": True,
        "expanded": True,
    },
}
#: layer_project_id -> (group, order among its siblings, shown, position).
MAP_TREE: dict[int, tuple[int | None, int, bool, str]] = {
    32: (None, 0, True, "top"),
    35: (None, 1, True, "top"),
    37: (None, 4, True, "top"),
    38: (None, 5, False, "below_roads"),
    40: (2, 0, True, "top"),
    33: (2, 1, True, "top"),
    41: (2, 2, True, "top"),
    36: (1, 0, True, "top"),
    34: (1, 1, True, "top"),
    31: (1, 2, True, "top"),
    39: (1, 3, True, "top"),
}
#: The basemap the project starts on (one of the web's basemap ids).
MAP_BASEMAP = "light"
#: The eval user's stored view of the project (``user_project.initial_view_state``).
MAP_VIEW_STATE = {"latitude": 51.35, "longitude": 12.4, "zoom": 12}

# ---- the land use filter -------------------------------------------------------


def area_sum(polygons: list[Any]) -> str:
    """The web filter panel's sum of an area's polygons (``areaSum``): FNV-1a
    over their compact JSON text, which tells whether the notes still describe
    the saved geometry."""
    text = json.dumps(polygons, separators=(",", ":"))
    value = 0x811C9DC5
    for char in text:
        value = ((value ^ ord(char)) * 0x01000193) & 0xFFFFFFFF
    return f"{value:08x}"


_DRAWN = [[[12.28, 51.27], [12.47, 51.27], [12.47, 51.4], [12.28, 51.4], [12.28, 51.27]]]  # fmt: skip
#: Land use's stored filter, as the filter panel writes it: a drawn area
#: (first under ``and``), an ordinary row, a switched-off row (only in the
#: notes, at its position among the rows) and a row the panel shows as custom
#: (conditions on two fields, which no row says).
LAND_USE_QUERY: dict[str, Any] = {
    "cql": {
        "op": "and",
        "args": [
            {
                "op": "s_intersects",
                "args": [
                    {"property": "geom"},
                    {"type": "Polygon", "coordinates": _DRAWN},
                ],
            },
            {"op": ">", "args": [{"property": "area_m2"}, 5000]},
            {
                "op": "or",
                "args": [
                    {"op": "=", "args": [{"property": "use"}, "park"]},
                    {"op": "between", "args": [{"property": "area_m2"}, 20000, 50000]},
                ],
            },
        ],
    },
    "ui": {
        "v": 1,
        "off": [
            {"at": 1, "cql": {"op": "=", "args": [{"property": "use"}, "industrial"]}}
        ],
        "area": {
            "pieces": [
                {"kind": "shape", "n": 1, "shape": "polygon", "label": "Study area"}
            ],
            "sum": area_sum([_DRAWN]),
        },
    },
}

# ---- what uses Old boundaries --------------------------------------------------

MAP_BUILDER_CONFIG: dict[str, Any] = {
    "interface": [
        {
            "id": "panel-left",
            "type": "panel",
            "config": {"position": {"anchor": "left"}},
            "widgets": [
                {
                    "id": "widget-old-boundaries",
                    "type": "chart",
                    "config": {
                        "type": "categories_chart",
                        "setup": {"title": "Old boundaries", "layer_project_id": 39},
                        "options": {},
                    },
                }
            ],
        }
    ]
}
MAP_WORKFLOW: dict[str, Any] = {
    "id": MAP_WORKFLOW_ID,
    "project_id": MAP_PROJECT_ID,
    "name": "Boundary check",
    "description": None,
    "is_default": False,
    "revision": 1,
    "config": {
        "nodes": [
            {
                "id": "dataset-old-boundaries",
                "type": "dataset",
                "position": {"x": 0, "y": 0},
                "data": {
                    "type": "dataset",
                    "label": "Old boundaries",
                    "layerId": _layer_id(39),
                    "projectLayerId": 39,
                    "layerName": "Old boundaries",
                    "filterInitialized": True,
                },
            },
            {
                "id": "tool-buffer",
                "type": "tool",
                "position": {"x": 320, "y": 0},
                "data": {
                    "type": "tool",
                    "processId": "buffer",
                    "label": "Buffer",
                    "config": {"distances": [100]},
                },
            },
        ],
        "edges": [
            {
                "id": "edge-old-boundaries-buffer",
                "source": "dataset-old-boundaries",
                "sourceHandle": "output",
                "target": "tool-buffer",
                "targetHandle": "input_layer_id",
            }
        ],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "variables": [],
    },
}
MAP_REPORT_LAYOUT: dict[str, Any] = {
    "id": MAP_REPORT_LAYOUT_ID,
    "project_id": MAP_PROJECT_ID,
    "name": "Overview",
    "description": None,
    "is_default": True,
    "revision": 1,
    "config": {
        "page": {"size": "A4", "orientation": "landscape"},
        "layout": {},
        "elements": [
            {
                "id": "1a700000-0000-4000-8000-000000000011",
                "type": "map",
                "position": {
                    "x": 10,
                    "y": 10,
                    "width": 200,
                    "height": 150,
                    "z_index": 0,
                },
                "config": {"lock_layers": True, "locked_layer_ids": [31, 34, 39]},
                "style": {},
            },
            {
                "id": "1a700000-0000-4000-8000-000000000012",
                "type": "legend",
                "position": {
                    "x": 215,
                    "y": 10,
                    "width": 70,
                    "height": 150,
                    "z_index": 1,
                },
                "config": {},
                "style": {},
            },
        ],
        "atlas": {},
    },
}
