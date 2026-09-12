"""A tiny Munich network in official Overture transportation schema.

Built in code rather than committed as binary so the schema is readable and the
nesting is the thing under test: `connectors` as list<struct{connector_id, at}>,
scoped properties as list<struct{..., between: list<double>}>, geometry as WKB.

Field *structure* matches the official schema; optional fields a real extract
would carry are omitted, which is indistinguishable from them being null.

The network deliberately covers every case the splitter has to handle:

  tal          interior connectors at 0.35/0.70 and a speed change at 0.50
               with no connector behind it            -> 4 pieces, 1 synthetic
  rindermarkt  no scoping, connectors at both ends    -> 1 piece,  0 synthetic
  frauenstrasse road_surface changing at 0.50         -> 2 pieces, 1 synthetic
  sendlinger   pedestrian, no maxspeed, no scoping    -> 1 piece,  0 synthetic
  isarradweg   is_bridge flagged on [0.20, 0.40]      -> 3 pieces, 2 synthetic
"""

from pathlib import Path
from typing import Any, Dict, List, Tuple

import pyarrow as pa
import pyarrow.parquet as pq
from goatlib.bundles.importers.street_network.overture import linear_ref
from shapely.geometry import LineString, Point

Coord = Tuple[float, float]

# --- schema ---------------------------------------------------------------

_BETWEEN = pa.list_(pa.float64())

_SEGMENT_SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        ("geometry", pa.binary()),
        ("theme", pa.string()),
        ("type", pa.string()),
        ("version", pa.int32()),
        ("subtype", pa.string()),
        ("class", pa.string()),
        ("subclass", pa.string()),
        ("subclass_rules", pa.null()),
        (
            "names",
            pa.struct(
                [
                    ("primary", pa.string()),
                    (
                        "rules",
                        pa.list_(
                            pa.struct([("value", pa.string()), ("between", _BETWEEN)])
                        ),
                    ),
                ]
            ),
        ),
        (
            "connectors",
            pa.list_(pa.struct([("connector_id", pa.string()), ("at", pa.float64())])),
        ),
        (
            "road_surface",
            pa.list_(pa.struct([("value", pa.string()), ("between", _BETWEEN)])),
        ),
        (
            "road_flags",
            pa.list_(
                pa.struct([("values", pa.list_(pa.string())), ("between", _BETWEEN)])
            ),
        ),
        (
            "speed_limits",
            pa.list_(
                pa.struct(
                    [
                        (
                            "max_speed",
                            pa.struct([("value", pa.int32()), ("unit", pa.string())]),
                        ),
                        ("between", _BETWEEN),
                    ]
                )
            ),
        ),
        (
            "access_restrictions",
            pa.list_(
                pa.struct(
                    [
                        ("access_type", pa.string()),
                        # Non-geometric scoping: two rules can cover the same
                        # range and differ only by heading/mode/time.
                        (
                            "when",
                            pa.struct(
                                [
                                    ("heading", pa.string()),
                                    ("mode", pa.list_(pa.string())),
                                    ("during", pa.string()),
                                ]
                            ),
                        ),
                        ("between", _BETWEEN),
                    ]
                )
            ),
        ),
        (
            "level_rules",
            pa.list_(pa.struct([("value", pa.int32()), ("between", _BETWEEN)])),
        ),
        (
            "prohibited_transitions",
            pa.list_(
                pa.struct(
                    [
                        (
                            "sequence",
                            pa.list_(
                                pa.struct(
                                    [
                                        ("connector_id", pa.string()),
                                        ("overture_id", pa.string()),
                                    ]
                                )
                            ),
                        ),
                        ("final_heading", pa.string()),
                        ("when", pa.struct([("heading", pa.string())])),
                    ]
                )
            ),
        ),
    ]
)

_CONNECTOR_SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        ("geometry", pa.binary()),
        ("theme", pa.string()),
        ("type", pa.string()),
        ("version", pa.int32()),
    ]
)


# --- geometry -------------------------------------------------------------

# Tal runs west->east across the network; the other streets join it at computed
# positions so every shared connector sits on both geometries exactly.
TAL: List[Coord] = [
    (11.57550, 48.13740),
    (11.57650, 48.13735),
    (11.57780, 48.13722),
    (11.57920, 48.13710),
    (11.58050, 48.13700),
]

TAL_JOIN_A = 0.35  # Rindermarkt meets Tal here
TAL_JOIN_B = 0.70  # Frauenstraße meets Tal here


def _speed(value: int, between: Any = None) -> Dict[str, Any]:
    return {"max_speed": {"value": value, "unit": "km/h"}, "between": between}


def _surface(value: str, between: Any = None) -> Dict[str, Any]:
    return {"value": value, "between": between}


def build_records() -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Segment and connector records as plain dicts, geometry still shapely."""
    join_a = linear_ref.interpolate(TAL, TAL_JOIN_A)
    join_b = linear_ref.interpolate(TAL, TAL_JOIN_B)

    rindermarkt = [join_a, (11.57700, 48.13640), (11.57680, 48.13580)]
    frauenstrasse = [join_b, (11.57860, 48.13640), (11.57840, 48.13570)]
    sendlinger = [(11.57550, 48.13740), (11.57480, 48.13660), (11.57420, 48.13580)]
    isarradweg = [
        (11.57840, 48.13570),
        (11.57930, 48.13530),
        (11.58010, 48.13490),
        (11.58060, 48.13450),
    ]

    connectors = [
        ("c-marienplatz", (11.57550, 48.13740)),
        ("c-tal-rindermarkt", join_a),
        ("c-tal-frauenstrasse", join_b),
        ("c-isartor", (11.58050, 48.13700)),
        ("c-rindermarkt-south", (11.57680, 48.13580)),
        ("c-frauenstrasse-south", (11.57840, 48.13570)),
        ("c-sendlinger-south", (11.57420, 48.13580)),
        ("c-isarradweg-south", (11.58060, 48.13450)),
    ]

    segments = [
        _segment(
            "seg-tal",
            "residential",
            "Tal",
            TAL,
            connectors=[
                ("c-marienplatz", 0.0),
                ("c-tal-rindermarkt", TAL_JOIN_A),
                ("c-tal-frauenstrasse", TAL_JOIN_B),
                ("c-isartor", 1.0),
            ],
            # A speed change at 0.50 has no connector behind it, so the splitter
            # has to mint one.
            speed_limits=[_speed(30, [0.0, 0.5]), _speed(50, [0.5, 1.0])],
            road_surface=[_surface("paved")],
            # No left turn from Tal's east end onto Frauenstraße. References
            # other features, so it belongs only to the piece ending at Isartor.
            prohibited_transitions=[
                {
                    "sequence": [
                        {
                            "connector_id": "c-isartor",
                            "overture_id": "seg-zweibrueckenstrasse",
                        }
                    ],
                    "final_heading": "forward",
                    "when": {"heading": "forward"},
                }
            ],
        ),
        _segment(
            "seg-rindermarkt",
            "living_street",
            "Rindermarkt",
            rindermarkt,
            connectors=[
                ("c-tal-rindermarkt", 0.0),
                ("c-rindermarkt-south", 1.0),
            ],
            speed_limits=[_speed(20)],
            road_surface=[_surface("paved")],
        ),
        _segment(
            "seg-frauenstrasse",
            "tertiary",
            "Frauenstraße",
            frauenstrasse,
            connectors=[
                ("c-tal-frauenstrasse", 0.0),
                ("c-frauenstrasse-south", 1.0),
            ],
            speed_limits=[_speed(30)],
            road_surface=[
                _surface("paving_stones", [0.0, 0.5]),
                _surface("paved", [0.5, 1.0]),
            ],
            # Whole-range but non-geometrically scoped: closed backward except to
            # buses. Splitting cannot reduce these to one value, which is why the
            # arrays are not flattenable.
            access_restrictions=[
                {
                    "access_type": "denied",
                    "when": {"heading": "backward", "mode": None, "during": None},
                    "between": None,
                },
                {
                    "access_type": "allowed",
                    "when": {
                        "heading": "backward",
                        "mode": ["bus"],
                        "during": None,
                    },
                    "between": None,
                },
            ],
        ),
        _segment(
            "seg-sendlinger",
            "pedestrian",
            "Sendlinger Straße",
            sendlinger,
            connectors=[
                ("c-marienplatz", 0.0),
                ("c-sendlinger-south", 1.0),
            ],
            road_surface=[_surface("paving_stones")],
            subclass="sidewalk",
        ),
        _segment(
            "seg-isarradweg",
            "cycleway",
            "Isarradweg",
            isarradweg,
            connectors=[
                ("c-frauenstrasse-south", 0.0),
                ("c-isarradweg-south", 1.0),
            ],
            road_surface=[_surface("paved")],
            road_flags=[{"values": ["is_bridge"], "between": [0.2, 0.4]}],
        ),
    ]

    connector_records = [
        {
            "id": connector_id,
            "geometry": Point(coord),
            "theme": "transportation",
            "type": "connector",
            "version": 1,
        }
        for connector_id, coord in connectors
    ]
    return segments, connector_records


def _segment(
    overture_id: str,
    road_class: str,
    name: str,
    coords: List[Coord],
    *,
    connectors: List[Tuple[str, float]],
    speed_limits: Any = None,
    road_surface: Any = None,
    subclass: Any = None,
    road_flags: Any = None,
    access_restrictions: Any = None,
    level_rules: Any = None,
    prohibited_transitions: Any = None,
) -> Dict[str, Any]:
    return {
        "id": overture_id,
        "geometry": LineString(coords),
        "theme": "transportation",
        "type": "segment",
        "version": 1,
        "subtype": "road",
        "class": road_class,
        # Overture carries a road's subclass as a scalar and, where it changes
        # along the way, as `subclass_rules`. The flatten reads the rules first
        # and falls back to the scalar, so a fixture segment that states one
        # covers the scalar path.
        "subclass": subclass,
        "subclass_rules": None,
        "names": {"primary": name, "rules": None},
        "connectors": [{"connector_id": cid, "at": at} for cid, at in connectors],
        "road_surface": road_surface,
        "road_flags": road_flags,
        "speed_limits": speed_limits,
        "access_restrictions": access_restrictions,
        "level_rules": level_rules,
        "prohibited_transitions": prohibited_transitions,
    }


def write_geoparquet(out_dir: Path) -> Tuple[Path, Path]:
    """Write segments.geoparquet and connectors.geoparquet into ``out_dir``."""
    segments, connectors = build_records()
    out_dir.mkdir(parents=True, exist_ok=True)

    segments_path = out_dir / "segments.geoparquet"
    connectors_path = out_dir / "connectors.geoparquet"

    pq.write_table(
        pa.Table.from_pylist([_to_wkb(r) for r in segments], schema=_SEGMENT_SCHEMA),
        segments_path,
    )
    pq.write_table(
        pa.Table.from_pylist(
            [_to_wkb(r) for r in connectors], schema=_CONNECTOR_SCHEMA
        ),
        connectors_path,
    )
    return segments_path, connectors_path


def _to_wkb(record: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(record)
    out["geometry"] = out["geometry"].wkb
    return out


def build_split_input() -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Fixture records shaped the way the parquet reader leaves them.

    ``build_records`` hands back shapely geometry because that is what writing
    GeoParquet needs; the splitter wants decoded coordinates.
    """
    segments, connectors = build_records()
    for segment in segments:
        segment["coordinates"] = list(segment.pop("geometry").coords)
    for connector in connectors:
        point = connector.pop("geometry")
        connector["coordinate"] = (point.x, point.y)
    return segments, connectors
