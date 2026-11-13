"""CQL2 tile filters as manby feature filters.

A filtered tile of a layer whose stored tiles manby built can be cut from
those tiles instead of being rendered by DuckDB. `translate` turns the tile
request's CQL2 filter (parsed as `build_cql_filter` parses it) and `bbox` into
a manby feature filter that keeps exactly the features DuckDB's WHERE clause
keeps (goatlib.storage.cql_evaluator), or returns None when it cannot, and the
DuckDB tile answers as before.

Three differences between the two shape the output:

- NULL. A null attribute is absent from the tiles. In SQL a test on NULL is
  neither true nor false, and NOT keeps it that way; manby's negated operators
  (`!=`, `!in`, `!ilike`, and `none`) are true for a missing attribute. So a
  negation is pushed down to the tests (`not (a and b)` is `not a or not b`)
  and each negated test is guarded with `has`; `none` is never used.
- Types. The tiles hold numbers and booleans as such, everything else as text,
  dates and timestamps in the text format of goatlib.io.pmtiles. A literal
  becomes what the column holds in the tiles, as DuckDB casts it to the
  column's type. Where DuckDB casts the column instead (a number compared with
  a text column), or the tile text does not sort or read like the value, the
  filter is left to DuckDB.
- Areas. `s_intersects` with a polygon is taken out of the filter as its area,
  which `PreparedFilter` cuts per tile into manby's `intersects`. Only an area
  every feature must intersect (in the top-level `and`) can be taken out.

`get_prepared_filter` keeps a translated filter prepared for the tiles of a
file version. manby tests a feature clipped to the tile and its buffer, so of
an area only the part near the tile matters: a tile the area misses gets no
tile, a tile it covers no area test, and a tile on its edge the area cut to
the tile, a few vertices instead of all of them for every tile.
"""

import hashlib
import json
import math
import re
import threading
from collections import OrderedDict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Literal

import shapely
from goatlib.storage.cql_evaluator import parse_cql2_filter
from goatlib.storage.query_builder import _normalize_geometry_property
from pygeofilter import ast, values
from shapely.geometry import shape


@dataclass(frozen=True)
class TranslatedFilter:
    """A tile filter for manby; at least one part is set.

    Attributes:
        attributes: manby filter expression without areas, or None
        area: GeoJSON Polygon or MultiPolygon every feature must intersect,
            or None
    """

    attributes: list | None
    area: dict | None


class Untranslatable(Exception):
    """A part of a filter manby cannot answer the way DuckDB does."""


# Property names cql_evaluator reads as the geometry column
_GEOMETRY_ALIASES = frozenset({"geom", "geometry", "the_geom", "wkb_geometry"})

_INTEGER_TYPES = frozenset(
    {
        "TINYINT",
        "SMALLINT",
        "INTEGER",
        "BIGINT",
        "UTINYINT",
        "USMALLINT",
        "UINTEGER",
        "UBIGINT",
    }
)
# Tiles hold these, DECIMAL and DOUBLE as doubles. For these and DECIMAL,
# DuckDB casts a text literal to the column's own type, rounding it ("0.1234"
# is 0.123 for a DECIMAL(18,3)), so only number literals translate.
_ROUNDING_TYPES = frozenset({"FLOAT", "HUGEINT", "UHUGEINT"})
_TIMESTAMP_TYPES = frozenset(
    {"TIMESTAMP", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_NS"}
)
_TIMESTAMPTZ_TYPES = frozenset({"TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ"})

# Kinds whose tile text is DuckDB's CAST(... AS VARCHAR), which GOAT's like
# matches: a double 5.0 reads "5.0" in DuckDB and "5" in manby.
_LIKE_KINDS = frozenset({"integer", "text", "uuid", "date"})
# Kinds whose tile values sort as DuckDB sorts the column
_ORDERED_KINDS = frozenset(
    {"integer", "double", "number", "text", "date", "timestamp", "timestamptz"}
)
_NUMBER_KINDS = frozenset({"integer", "double", "number"})

# manby compares numbers as doubles; below this a comparison stays exact
_MAX_EXACT = 2**53

# Text literals DuckDB casts to integer and double columns without rounding
_INTEGER_TEXT = re.compile(r"[+-]?\d+")
_DOUBLE_TEXT = re.compile(r"[+-]?(\d+(\.\d*)?|\.\d+)")
_TEMPORAL = re.compile(
    r"\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?"
)
_UUID = re.compile(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")

# The test that is true where a comparison is false (for a non-null value)
_COMPLEMENT = {"=": "<>", "<>": "=", "<": ">=", ">=": "<", ">": "<=", "<=": ">"}


def translate(
    cql_filter: dict | None,
    bbox: list[float] | None,
    columns: list[dict],
    tile_fields: set[str],
    geometry_column: str = "geometry",
) -> TranslatedFilter | None:
    """A tile request's filter as a manby filter on the stored tiles.

    Args:
        cql_filter: `{"filter": <text>, "lang": "cql2-json" | "cql2-text"}`
        bbox: [minx, miny, maxx, maxy], tested like an `s_intersects` area
        columns: The layer's columns, with `name` and DuckDB `type`
        tile_fields: Attribute names in the stored tiles
        geometry_column: Name of the geometry column

    Returns:
        The filter, or None when DuckDB has to answer it: something manby
        cannot express exactly, a property missing from the tiles, a filter
        that does not parse, or nothing to filter.
    """
    translator = _Translator(columns, tile_fields, geometry_column)
    try:
        attributes = None
        if cql_filter is not None:
            node = _parse(cql_filter, geometry_column)
            attributes = translator.condition(node, negate=False, top=True)
        if bbox is not None:
            translator.areas.append(_rectangle(bbox))
        area = translator.area()
    except Untranslatable:
        return None
    if attributes is None and area is None:
        return None
    return TranslatedFilter(attributes=attributes, area=area)


def _parse(cql_filter: dict, geometry_column: str) -> Any:
    """The pygeofilter AST, as `build_cql_filter` parses the filter."""
    try:
        return parse_cql2_filter(
            _normalize_geometry_property(cql_filter["filter"], geometry_column),
            cql_filter.get("lang", "cql2-json"),
        )
    except Exception as e:
        raise Untranslatable("filter does not parse") from e


def _rectangle(bbox: list[float]) -> dict:
    """The bbox as a polygon, with build_bbox_filter's ring."""
    if len(bbox) != 4:
        raise Untranslatable("bbox")
    minx, miny, maxx, maxy = bbox
    ring = [[minx, miny], [minx, maxy], [maxx, maxy], [maxx, miny], [minx, miny]]
    return {"type": "Polygon", "coordinates": [ring]}


class _Translator:
    def __init__(
        self, columns: list[dict], tile_fields: set[str], geometry_column: str
    ) -> None:
        # DuckDB matches identifiers case-insensitively
        self.columns = {c["name"].lower(): c for c in columns}
        self.tile_fields = tile_fields
        self.geometry_names = _GEOMETRY_ALIASES | {geometry_column.lower()}
        self.areas: list[dict] = []

    def condition(self, node: Any, negate: bool, top: bool = False) -> list | None:
        """manby expression true where `node` is true in SQL, or false with `negate`.

        `top` is set in the filter's top-level `and`, where an area is taken
        out (None is returned for it).
        """
        if isinstance(node, ast.Not):
            return self.condition(node.sub_node, not negate)
        if isinstance(node, (ast.And, ast.Or)):
            conjunction = isinstance(node, ast.And) != negate
            parts = [
                self.condition(sub, negate, top and conjunction)
                for sub in (node.lhs, node.rhs)
            ]
            return _all(parts) if conjunction else _any(parts)
        if isinstance(node, ast.Comparison):
            key, kind = self.field(node.lhs)
            op = _COMPLEMENT[node.op.value] if negate else node.op.value
            return _compare(op, key, kind, _literal(kind, node.rhs))
        if isinstance(node, ast.Between):
            key, kind = self.field(node.lhs)
            low, high = _literal(kind, node.low), _literal(kind, node.high)
            if node.not_ != negate:
                return _any(
                    [_compare("<", key, kind, low), _compare(">", key, kind, high)]
                )
            return _all(
                [_compare(">=", key, kind, low), _compare("<=", key, kind, high)]
            )
        if isinstance(node, ast.In):
            key, kind = self.field(node.lhs)
            if kind == "boolean" or not node.sub_nodes:
                raise Untranslatable("in")
            options = [_literal(kind, option) for option in node.sub_nodes]
            if node.not_ != negate:
                return ["all", ["has", key], ["!in", key, *options]]
            return ["in", key, *options]
        if isinstance(node, ast.Like):
            key, kind = self.field(node.lhs)
            if kind not in _LIKE_KINDS or not isinstance(node.pattern, str):
                raise Untranslatable("like")
            # GOAT's like ignores case (ILIKE) and has no escape character
            if node.not_ != negate:
                return ["all", ["has", key], ["!ilike", key, node.pattern]]
            return ["ilike", key, node.pattern]
        if isinstance(node, ast.IsNull):
            lhs = node.lhs
            if isinstance(lhs, list) and len(lhs) == 1:  # args given as a list
                lhs = lhs[0]
            key, _ = self.field(lhs)
            return ["has", key] if node.not_ != negate else ["!has", key]
        if isinstance(node, ast.GeometryIntersects) and top:
            self.areas.append(self.polygon(node))
            return None
        raise Untranslatable(type(node).__name__)

    def field(self, node: Any) -> tuple[str, str]:
        """The tile attribute (or `$id`) a property reads, and its kind."""
        if not isinstance(node, ast.Attribute):
            raise Untranslatable("not a property")
        name = node.name
        if name.lower() in self.geometry_names:
            raise Untranslatable("geometry outside s_intersects")
        # the feature id is rowid + 1, as cql_evaluator reads these two
        if name == "_rowid" or (name.lower() == "id" and "id" not in self.columns):
            return "$id", "integer"
        column = self.columns.get(name.lower())
        if column is None or column["name"] not in self.tile_fields:
            raise Untranslatable(f"{name} is not in the tiles")
        kind = _kind(column.get("type", ""))
        if kind is None:
            raise Untranslatable(f"{name} has type {column.get('type')}")
        return column["name"], kind

    def polygon(self, node: ast.GeometryIntersects) -> dict:
        """The polygon an `s_intersects` on the geometry column tests."""
        lhs, rhs = node.lhs, node.rhs
        if not (
            isinstance(lhs, ast.Attribute) and lhs.name.lower() in self.geometry_names
        ):
            raise Untranslatable("s_intersects without the geometry column")
        if not isinstance(rhs, values.Geometry) or rhs.geometry.get("type") not in (
            "Polygon",
            "MultiPolygon",
        ):
            raise Untranslatable("s_intersects without a polygon")
        return rhs.geometry

    def area(self) -> dict | None:
        """The one area every feature must intersect.

        Intersecting all of several areas is neither intersecting their union
        nor their intersection, unless one area lies inside all others: then
        intersecting it implies intersecting them.
        """
        if len(self.areas) <= 1:
            return self.areas[0] if self.areas else None
        try:
            shapes = [shape(area) for area in self.areas]
            for area, inner in zip(self.areas, shapes):
                if all(outer.covers(inner) for outer in shapes):
                    return area
        except Exception as e:  # malformed GeoJSON from the request
            raise Untranslatable("area") from e
        raise Untranslatable("areas without one inside the others")


def _kind(duckdb_type: str) -> str | None:
    """What a column of a DuckDB type holds in the tiles; None for the rest."""
    t = duckdb_type.strip().upper()
    if t in _INTEGER_TYPES:
        return "integer"
    if t == "DOUBLE":
        return "double"
    if t in _ROUNDING_TYPES or t.startswith("DECIMAL"):
        return "number"
    if t == "BOOLEAN":
        return "boolean"
    if t == "VARCHAR" or t.startswith("ENUM("):
        return "text"
    if t == "UUID":
        return "uuid"
    if t == "DATE":
        return "date"
    if t in _TIMESTAMP_TYPES:
        return "timestamp"
    if t in _TIMESTAMPTZ_TYPES:
        return "timestamptz"
    return None


def _literal(kind: str, value: Any) -> Any:
    """A literal as the tiles hold values of the kind, cast as DuckDB casts it."""
    if kind in _NUMBER_KINDS:
        if isinstance(value, str):
            # DuckDB casts text to the column's type: "1.5" is 2 for an integer
            if kind == "integer" and _INTEGER_TEXT.fullmatch(value):
                value = int(value)
            elif kind == "double" and _DOUBLE_TEXT.fullmatch(value):
                value = float(value)
            else:
                raise Untranslatable("text for a number column")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise Untranslatable("not a number")
        if not abs(value) < _MAX_EXACT:
            raise Untranslatable("number out of range")
        return value
    if kind == "boolean":
        if isinstance(value, str) and value.lower() in ("true", "false"):
            return value.lower() == "true"
        if not isinstance(value, bool):
            raise Untranslatable("not a boolean")
        return value
    if kind == "text":
        # a number would make DuckDB cast the column: "01234" = 1234
        if not isinstance(value, str):
            raise Untranslatable("not a string")
        return value
    if kind == "uuid":
        if not isinstance(value, str) or not _UUID.fullmatch(value):
            raise Untranslatable("not a UUID")
        return value.lower()
    return _temporal(kind, value)


def _temporal(kind: str, value: Any) -> str:
    """A date or time literal in the tiles' text for the kind.

    DuckDB casts a literal for a DATE column to its day and one without an
    offset for a TIMESTAMPTZ column to UTC (geoapi's time zone). The tiles
    hold milliseconds; the web sends whole seconds, and only those translate.
    """
    if isinstance(value, (date, datetime)):
        value = value.isoformat()  # what cql_evaluator hands DuckDB
    if not isinstance(value, str) or not _TEMPORAL.fullmatch(value):
        raise Untranslatable("not a date or time")
    try:
        moment = datetime.fromisoformat(value)
        if kind == "timestamptz" and moment.tzinfo is not None:
            moment = moment.astimezone(timezone.utc)
    except (ValueError, OverflowError) as e:
        raise Untranslatable("not a date or time") from e
    if kind == "date":
        if moment.tzinfo is not None:
            raise Untranslatable("offset on a date")
        return moment.date().isoformat()
    if moment.microsecond:
        raise Untranslatable("fraction of a second")
    if kind == "timestamp":
        if moment.tzinfo is not None:
            raise Untranslatable("offset on a timestamp without time zone")
        return moment.isoformat(timespec="seconds")
    return moment.replace(tzinfo=None).isoformat(timespec="seconds") + "Z"


def _compare(op: str, key: str, kind: str, value: Any) -> list:
    """manby expression for `key <op> value` being true in SQL."""
    if kind == "boolean":
        # manby's ["==", k, true] also matches false; ["!=", k, false] does not
        if op not in ("=", "<>"):
            raise Untranslatable("boolean order")
        if (op == "=") == value:
            return ["all", ["has", key], ["!=", key, False]]
        return ["==", key, False]
    if op == "=":
        return ["==", key, value]
    if op == "<>":
        return ["all", ["has", key], ["!=", key, value]]
    if kind not in _ORDERED_KINDS:
        raise Untranslatable(f"{kind} order")
    if kind == "timestamptz":
        # "...:00Z" sorts after "...:00.500Z", so a second's values without
        # a fraction sort last; "...:00." sorts before all of that second.
        second = value[:-1] + "."
        if op == "<":
            return ["<", key, second]
        if op == ">=":
            return [">=", key, second]
        if op == ">":
            return ["all", [">=", key, second], ["!=", key, value]]
        return ["any", ["<", key, second], ["==", key, value]]
    return [op, key, value]


def _all(parts: list[list | None]) -> list | None:
    """`all` of the parts, flattened; None parts are areas taken out."""
    flat: list = []
    for part in parts:
        if part is not None:
            flat.extend(part[1:] if part[0] == "all" else [part])
    if not flat:
        return None
    return flat[0] if len(flat) == 1 else ["all", *flat]


def _any(parts: list[list]) -> list:
    """`any` of the parts, flattened; equality tests on one key become `in`."""
    flat: list = []
    for part in parts:
        flat.extend(part[1:] if part[0] == "any" else [part])
    if len(flat) > 1 and all(p[0] in ("==", "in") for p in flat):
        if len({p[1] for p in flat}) == 1:
            return ["in", flat[0][1], *(v for p in flat for v in p[2:])]
    return flat[0] if len(flat) == 1 else ["any", *flat]


# manby overzoom's -b: the buffer around a tile, in 1/256 of the tile. manby
# tests a feature clipped to the tile and this buffer.
OVERZOOM_BUFFER = 5
# An area is cut to the tile and twice the buffer, so wherever manby tests a
# feature the cut area is the whole area.
_MARGIN = 2 * OVERZOOM_BUFFER / 256
_PREPARED_MAX = 128

_prepared: OrderedDict[tuple[str, str], "PreparedFilter"] = OrderedDict()
_prepared_lock = threading.Lock()


class PreparedFilter:
    """A translated filter with its area parsed and prepared once.

    Shared by the threads that answer tiles. A prepared shapely geometry is not
    safe to use from several threads at once, so the area's `intersects` and
    `contains` run under a lock. The cut runs outside it, on a copy of the area
    that is not prepared, so it never reads the geometry the tests prepare.

    Raises:
        shapely.errors.GEOSException: the area is not valid GeoJSON
    """

    def __init__(self, translated: TranslatedFilter) -> None:
        self.attributes = translated.attributes
        self.area: shapely.Geometry | None = None
        self._area_for_cut: shapely.Geometry | None = None
        if translated.area is not None:
            self.area = shapely.from_geojson(json.dumps(translated.area))
            # WKB holds the coordinates exactly
            self._area_for_cut = shapely.from_wkb(shapely.to_wkb(self.area))
            # GEOS fills a geometry's envelope on first use; filled here, the
            # threads that cut the shared copy only read it
            shapely.bounds(self._area_for_cut)
            shapely.prepare(self.area)
        self._attributes_json = (
            None if self.attributes is None else json.dumps(self.attributes)
        )
        self._lock = threading.Lock()

    def for_tile(
        self, z: int, x: int, y: int, folder: Path
    ) -> Path | None | Literal[False]:
        """The manby filter file for the tile z/x/y, written into `folder`.

        Returns:
            The file; None when no filter is left (the area covers the tile
            and there is no attribute test); False when no feature can pass
            (no area in the tile).
        """
        expression = self._attributes_json
        if self.area is not None:
            west, south, east, north = _lonlat_box(z, x, y)
            box = shapely.box(west, south, east, north)
            with self._lock:
                if not self.area.intersects(box):
                    return False
                covered = self.area.contains(box)
            if not covered:
                # outside the lock: the cut of a large area takes a while
                cut = shapely.clip_by_rect(self._area_for_cut, west, south, east, north)
                parts = [
                    part
                    for part in shapely.get_parts(cut)
                    if part.geom_type == "Polygon" and not part.is_empty
                ]
                if not parts:  # the area only touches the box
                    return False
                # One test per part: manby finds an area wholly inside a
                # polygon feature by one vertex of the area's first part, so
                # a feature holding a later part would be dropped. shapely's
                # GeoJSON text as it is: parsing it and writing it out again
                # would cost more than the cut.
                tests = [f'["intersects", {shapely.to_geojson(p)}]' for p in parts]
                test = tests[0] if len(tests) == 1 else f'["any", {", ".join(tests)}]'
                expression = (
                    test if expression is None else f'["all", {expression}, {test}]'
                )
        if expression is None:
            return None
        path = folder / "filter.json"
        path.write_text(f'{{"*": {expression}}}', encoding="utf-8")
        return path


def _lonlat_box(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """West, south, east and north of the tile z/x/y with the margin.

    Tile edges are meridians and parallels, straight in lon/lat as manby
    reads the area's edges.
    """
    n = 2.0**z

    def lon(i: float) -> float:
        return i / n * 360 - 180

    def lat(j: float) -> float:  # tile rows count down from the north
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * j / n))))

    return (
        lon(x - _MARGIN),
        lat(y + 1 + _MARGIN),
        lon(x + 1 + _MARGIN),
        lat(y - _MARGIN),
    )


def filter_digest(translated: TranslatedFilter) -> str:
    """SHA-1 of the filter's canonical JSON, the same for the same filter."""
    text = json.dumps(
        {"attributes": translated.attributes, "area": translated.area},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha1(text.encode()).hexdigest()


def request_digest(
    layer_id: str, cql_filter: dict[str, Any] | None, bbox: list[float] | None
) -> str:
    """SHA-1 of a tile request's filter as sent, with the layer it filters.

    With the version of the layer's stored tiles it identifies the translated
    filter without parsing it again: `translate` reads the filter, the bbox
    and the layer's columns, and a column change deletes the layer's tiles,
    so new tiles come with a new version.
    """
    text, lang = "", None
    if cql_filter is not None:
        text, lang = cql_filter["filter"], cql_filter.get("lang", "cql2-json")
    head = json.dumps([layer_id.replace("-", ""), lang, bbox])
    return hashlib.sha1(f"{head}\n{text}".encode()).hexdigest()


def get_prepared_filter(
    version: str, translated: TranslatedFilter, key: str | None = None
) -> PreparedFilter:
    """The filter prepared for the tiles of the file version.

    Kept for the last 128 file versions and filters used; two threads asking
    for the same one at once get the same object.

    Args:
        version: Version of the stored tiles
        translated: The filter
        key: Identifies the filter in place of `filter_digest(translated)`,
            which serialises the whole area on every call. The caller
            guarantees that a key always comes with the same translated
            filter, so it covers everything `translate` reads: the filter,
            the bbox and the layer's columns.
    """
    cache_key = (version, filter_digest(translated) if key is None else key)
    with _prepared_lock:
        prepared = _prepared.get(cache_key)
        if prepared is not None:
            _prepared.move_to_end(cache_key)
            return prepared
    # outside the lock: preparing a large area takes a while
    prepared = PreparedFilter(translated)
    with _prepared_lock:
        prepared = _prepared.setdefault(cache_key, prepared)
        _prepared.move_to_end(cache_key)
        while len(_prepared) > _PREPARED_MAX:
            _prepared.popitem(last=False)
    return prepared
