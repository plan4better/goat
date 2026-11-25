"""The table of color keys (`data/color_keys.json`, the specification's 18.10).

Every key of the format that holds a color, a list of colors or a palette is in
the table, with the rule `"auto"` follows there or none; the walk below finds
them in the generated JSON Schema, so a new color key fails here until the table
names it. A rule the table marks accepted is one the models take, and every other
key refuses `"auto"`.

The schema shows a color by a hex pattern or by the shape of a palette. A color
held in a plain string (a palette's validator checks its hex, the schema does
not) shows nothing, so every plain or untyped string of the schema is exempted
below, by a text name or one by one: a new one fails here until it is exempted or
made a color.
"""

import copy
import re
from pathlib import Path
from typing import Annotated, Any

import pytest
from goatlib.style.colors import AUTO_RULES, COLOR_KEYS
from goatlib.style.context import DataContext, MapContext
from goatlib.style.models.base import StyleModel
from goatlib.style.models.values import Color, PaletteRef
from goatlib.style.schema import json_schema
from goatlib.style.validate import validate, validate_map
from pydantic import Field, TypeAdapter

SPEC = Path(__file__).parents[3] / "docs" / "style-spec.md"

_STRING = {"type": "string"}
_STRINGS = {"items": {"type": "string"}, "type": "array"}
#: The value forms of a property: their colors are the property's (zoom stops), or
#: the generic keys of every color by attribute (`by_attribute.*`).
_ATTRIBUTE_FORMS = ("ByAttributeColor", "RawColorField", "RawField")
#: Records that set parts: their part keys are named by part and key alone.
_RECORDS = (
    "symbol.",
    "classify[].classes[].",
    "classify[].other.",
    "classify[].no_data.",
    "rules[].",
)


#: Properties named like a color, a list of colors or a palette.
_COLOR_NAME = re.compile(r"(^|_)colou?rs?$|palette|ramp")
#: Names of plain strings that are text wherever they occur, never a color: ids,
#: names, titles, labels, texts, templates, field names, units, number affixes,
#: locales, expressions and their arguments, and a computation's timestamp, data
#: version and target.
TEXT_NAMES = frozenset(
    {
        "args",
        "at",
        "caption",
        "data",
        "expression",
        "field",
        "html",
        "id",
        "label",
        "locale",
        "max_label",
        "min_label",
        "name",
        "prefix",
        "property",
        "suffix",
        "target",
        "text",
        "title",
        "unit",
        "url",
        "url_template",
    }
)
#: Plain or untyped strings (`<definition>.<property>`) whose name could be a color
#: and which hold none. `Generated.values` are the values the server wrote into a
#: classification's classes (colors among them), bookkeeping read back by the server;
#: `RawField.no_data` and `RawColorField.no_data` are the values of a field read as
#: it is, which the compiler does not draw (a color's refuses "auto" and "fill").
NOT_COLORS = frozenset(
    {
        "BadgeBlock.labels",
        "ClassRecord.values",
        "Generated.values",
        "ImageRender.service_style",
        "LayerTime.value",
        "MapLayer.position",
        "MapLayer.style",
        "RawColorField.no_data",
        "RawField.no_data",
    }
)


def _holds_color(node: dict[str, Any]) -> bool:
    """A hex pattern, however it is written, or the shape of a palette."""
    pattern = node.get("pattern")
    any_of = node.get("anyOf", [])
    hex_pattern = isinstance(pattern, str) and "#" in pattern
    hex_pattern = hex_pattern and re.search(r"0-9a-f|a-f0-9|xdigit|\\d", pattern, re.I)
    return bool(hex_pattern) or (_STRING in any_of and _STRINGS in any_of)


def _shows_nothing(node: Any) -> bool:
    """Whether a property holds strings the schema says nothing about (no pattern,
    no choices) or anything at all (no type), alone, in a list or a map."""
    if not isinstance(node, dict) or _holds_color(node):
        return False
    shapes = ("type", "$ref", "anyOf", "oneOf", "allOf", "enum", "const")
    if not any(k in node for k in shapes):
        return True
    if node.get("type") == "string" and not any(
        k in node for k in ("pattern", "enum", "const")
    ):
        return True
    subs = [
        *node.get("anyOf", []),
        *node.get("oneOf", []),
        *node.get("prefixItems", []),
    ]
    subs += [node.get("items"), node.get("additionalProperties")]
    return any(_shows_nothing(sub) for sub in subs)


def unlisted_strings(defs: dict[str, Any] | None = None) -> list[str]:
    """The schema's plain or untyped string properties that neither `TEXT_NAMES`
    nor `NOT_COLORS` exempts."""
    defs = json_schema()["$defs"] if defs is None else defs
    return sorted(
        f"{name}.{key}"
        for name, definition in defs.items()
        if name != "catalog"
        for key, sub in (definition.get("properties") or {}).items()
        if _shows_nothing(sub)
        and key not in TEXT_NAMES
        and f"{name}.{key}" not in NOT_COLORS
    )


def _branch(definition: dict[str, Any]) -> str | None:
    """The `type` a union branch is chosen by (`render`, popup blocks)."""
    prop = (definition.get("properties") or {}).get("type") or {}
    return prop.get("const") or (prop.get("enum") or [None])[0]


def schema_color_paths(
    defs: dict[str, Any] | None = None,
) -> tuple[set[str], set[str]]:
    """Every path of the schema that holds a color, a list or map of colors or a
    palette, from `LayerStyle` and `MapDocument`; and every property named like a
    color the walk did not find holding one."""
    defs = json_schema()["$defs"] if defs is None else defs
    found: set[str] = set()
    named: set[str] = set()

    def walk(node: Any, path: str, seen: frozenset[str]) -> None:
        if not isinstance(node, dict):
            return
        if _holds_color(node):
            found.add(path)
            return
        if "$ref" in node:
            name = node["$ref"].split("/")[-1]
            definition = defs[name]
            if name.startswith("Zoom"):
                walk(
                    definition["properties"]["zoom"]["items"]["prefixItems"][1],
                    path,
                    seen,
                )
                return
            if name in _ATTRIBUTE_FORMS:
                for key, sub in (definition.get("properties") or {}).items():
                    walk(sub, f"<attribute>.{key}", seen)
                return
            if name in seen:
                return
            branch = _branch(definition)
            if branch and path.split(".")[-1] in ("render", "blocks[]"):
                path = f"{path}({branch})"
            walk(definition, path, seen | {name})
            return
        for key in ("anyOf", "oneOf", "allOf"):
            for sub in node.get(key, []):
                walk(sub, path, seen)
        if "items" in node:
            walk(node["items"], f"{path}[]", seen)
        if isinstance(node.get("additionalProperties"), dict):
            walk(node["additionalProperties"], f"{path}{{}}", seen)
        for key, sub in (node.get("properties") or {}).items():
            child = f"{path}.{key}" if path else key
            if _COLOR_NAME.search(key):
                named.add(child)
            walk(sub, child, seen)

    walk({"$ref": "#/$defs/LayerStyle"}, "", frozenset())
    walk({"$ref": "#/$defs/MapDocument"}, "", frozenset())
    return found, named - {re.sub(r"(\[\]|\{\})$", "", p) for p in found}


def table_key(path: str) -> str:
    """A schema path as the table names it: part keys by part and key whatever
    record sets them, render keys under the render's type, popup keys under the
    block's type, lists and maps without brackets."""
    for record in _RECORDS:
        if path.startswith(record):
            path = path[len(record) :]
    path = re.sub(r"^render\((\w+)\)\.", r"\1.", path)
    path = re.sub(r"^popup\.blocks\[\]\((\w+)\)\.", r"popup.\1.", path)
    path = path.replace("<attribute>.", "by_attribute.")
    return path.replace("[]", "").replace("{}", "")


def test_every_color_key_of_the_schema_is_in_the_table_and_no_other() -> None:
    found, _ = schema_color_paths()
    keys = {table_key(p) for p in found}
    assert sorted(keys - set(COLOR_KEYS)) == [], "color keys the table does not name"
    assert sorted(set(COLOR_KEYS) - keys) == [], "table keys the schema does not have"
    assert len(COLOR_KEYS) == 46


def test_every_record_takes_the_same_color_keys() -> None:
    found, _ = schema_color_paths()
    per_record = {
        record: {p[len(record) :] for p in found if p.startswith(record)}
        for record in _RECORDS
    }
    assert len({frozenset(keys) for keys in per_record.values()}) == 1, per_record
    assert len(per_record["symbol."]) == 11


def test_no_key_named_like_a_color_escapes_the_walk() -> None:
    """The walk finds colors by their type; a property named like a color, colors,
    a palette or a ramp that it does not see as one is a type it would miss."""
    _, missed = schema_color_paths()
    assert sorted(missed) == []


def test_every_string_the_schema_says_nothing_about_is_exempted() -> None:
    unlisted = unlisted_strings()
    assert unlisted == [], (
        f"{', '.join(unlisted)}: a string the schema cannot check. If it holds a color, "
        "type it Color (or PaletteRef) and add it to data/color_keys.json and spec 18.10 "
        "with its Auto rule; if it does not, exempt it in NOT_COLORS (or by name in "
        "TEXT_NAMES when the name is text everywhere)."
    )


def _flagged(defs: dict[str, Any]) -> set[str]:
    """What the enforcement tests report for a schema: color keys the table does not
    name, keys named like a color the walk misses, unlisted plain strings."""
    found, missed = schema_color_paths(defs)
    keys = {table_key(p) for p in found} - set(COLOR_KEYS)
    return keys | {table_key(p) for p in missed} | set(unlisted_strings(defs))


def _with(definition: str, key: str, annotation: Any) -> dict[str, Any]:
    """Today's schema with one property added to a definition, and the definitions
    of the models the added type uses."""
    defs = copy.deepcopy(json_schema()["$defs"])
    keys, added = TypeAdapter.json_schemas(
        [("added", "validation", TypeAdapter(annotation))],
        ref_template="#/$defs/{model}",
    )
    defs[definition]["properties"][key] = keys[("added", "validation")]
    for name, sub in added.get("$defs", {}).items():
        assert name not in defs, name
        defs[name] = sub
    return defs


class Glow(StyleModel):
    """A made-up nested part with a color, for the case below."""

    tint: Color | None = None


@pytest.mark.parametrize(
    ("definition", "key", "annotation", "named"),
    [
        # A list of colors checked by a validator, the way palettes are built.
        ("Fill", "colors", list[str] | None, "fill.colors"),
        # A color in a plain string under any name.
        ("Label", "shadow", str | None, "Label.shadow"),
        # A hex check written another way.
        (
            "Fill",
            "shade_of",
            Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")] | None,
            "fill.shade_of",
        ),
        ("Line", "glow_color", Color | None, "line.glow_color"),
        ("SceneFog", "tint", list[Color] | None, "scene.fog.tint"),
        ("CategoricalRender", "ramp", PaletteRef | None, "categorical.ramp"),
        ("ButtonBlock", "hover", dict[str, Color] | None, "popup.button.hover"),
        # A nested model holding a color.
        ("Line", "glow", Glow | None, "line.glow.tint"),
        # A hex check written with \d.
        (
            "Marker",
            "rim",
            Annotated[str, Field(pattern=r"^#[\da-fA-F]{6}$")] | None,
            "marker.rim",
        ),
    ],
)
def test_a_new_color_key_is_flagged_however_it_is_written(
    definition: str, key: str, annotation: Any, named: str
) -> None:
    assert _flagged(json_schema()["$defs"]) == set()
    assert named in _flagged(_with(definition, key, annotation))


def test_each_row_names_a_rule_or_none_and_says_whether_it_is_accepted() -> None:
    for key, row in COLOR_KEYS.items():
        assert row["auto"] is None or row["auto"] in AUTO_RULES, key
        if row["auto"] is None:
            assert set(row) == {"auto"}, key
        else:
            assert set(row) == {"auto", "follows", "accepted"}, key
            assert isinstance(row["accepted"], bool) and row["follows"], key


# the specification's table

_RULE_WORDS = {
    "shade": "shade",
    "label text": "label_text",
    "label halo": "label_halo",
    "on-color": "on_color",
    "not offered": None,
}


def spec_rows() -> dict[str, dict[str, Any]]:
    lines = SPEC.read_text().split("\n")
    start = lines.index("### 18.10 Color keys")
    rows: dict[str, dict[str, Any]] = {}
    for line in lines[start:]:
        if line.startswith("## "):
            break
        cells = [c.strip() for c in line.split("|")[1:-1]]
        if len(cells) != 4 or not re.fullmatch(r"`[^`]+`", cells[0]):
            continue
        key, rule, accepted, follows = cells[0].strip("`"), *cells[1:]
        row: dict[str, Any] = {"auto": _RULE_WORDS[rule]}
        if row["auto"] is not None:
            row["accepted"] = {"yes": True, "not yet": False}[accepted]
            row["follows"] = follows
        else:
            assert accepted == follows == "", key
        rows[key] = row
    return rows


def test_the_spec_table_is_the_table() -> None:
    rows = spec_rows()
    assert list(rows) == list(COLOR_KEYS)
    assert rows == COLOR_KEYS


# what the models take


def _set(doc: dict[str, Any], pointer: str, value: Any) -> dict[str, Any]:
    """`doc` with `value` at the JSON pointer, creating objects and one-item lists."""
    parts = pointer.strip("/").split("/")
    node: Any = doc
    for part, nxt in zip(parts, parts[1:]):
        if isinstance(node, list):
            node = node[int(part)]
            continue
        node = node.setdefault(part, [{}] if nxt.isdigit() else {})
    if isinstance(node, list):
        node[int(parts[-1])] = value
    else:
        node[parts[-1]] = value
    return doc


_PART_GEOMETRY = {
    "fill": "polygon",
    "outline": "polygon",
    "line": "line",
    "casing": "line",
    "arrows": "line",
    "marker": "point",
    "label": "point",
}
_RASTER_BASE = {
    "continuous": {"type": "continuous"},
    "categorical": {"type": "categorical", "classes": [{"value": 1}]},
    "hillshade": {"type": "hillshade"},
}


def place(key: str, value: Any) -> tuple[dict[str, Any], str, Any]:
    """A document with `value` at the color key `key`, the pointer to it and the
    context it is checked in."""
    vector = {"version": "1.0.0", "kind": "vector"}
    head, _, rest = key.partition(".")
    if head in _PART_GEOMETRY:
        ctx = DataContext(kind="vector", geometry=_PART_GEOMETRY[head])
        pointer = "/symbol/" + key.replace(".", "/").replace("lines/", "lines/0/")
        return _set(dict(vector), pointer, value), pointer, ctx
    if head == "cluster":
        doc = {**vector, "render": {"type": "cluster"}}
        pointer = "/render/" + rest.replace(".", "/").replace("lines/", "lines/0/")
        ctx = DataContext(kind="vector", geometry="point")
        return _set(doc, pointer, value), pointer, ctx
    if head == "by_attribute":
        form: dict[str, Any] = {"field": "x", "palette": ["#000000", "#ffffff"]}
        doc = {**vector, "symbol": {"outline": {"color": form}}}
        pointer = f"/symbol/outline/color/{rest}"
        ctx = DataContext(kind="vector", geometry="polygon")
        return _set(doc, pointer, value), pointer, ctx
    if head == "classify":
        doc = {**vector, "classify": [{"field": "x", "method": "categories"}]}
        ctx = DataContext(kind="vector", geometry="polygon")
        return _set(doc, "/classify/0/palette", value), "/classify/0/palette", ctx
    if head in ("heatmap", "h3"):
        render: dict[str, Any] = {"type": head}
        if rest.startswith("classify"):
            render["classify"] = {"method": "manual", "classes": [{"from": 0}]}
        pointer = "/render/" + rest.replace(".", "/").replace("classes/", "classes/0/")
        doc = {**vector, "render": render}
        ctx = DataContext(kind="vector", geometry="point")
        return _set(doc, pointer, value), pointer, ctx
    if head in _RASTER_BASE:
        render = {**_RASTER_BASE[head]}
        if rest.startswith("classify"):
            render["classify"] = {"method": "manual", "classes": [{"from": 0}]}
        if rest == "stops.color":
            render["stops"] = [{"value": 0, "color": "#000000"}]
        pointer = "/render/" + re.sub(
            r"(classes|stops)/", r"\g<1>/0/", rest.replace(".", "/")
        )
        doc = {"version": "1.0.0", "kind": "raster", "render": render}
        return _set(doc, pointer, value), pointer, DataContext(kind="raster")
    if head == "popup":
        block, _, prop = rest.partition(".")
        doc = {**vector, "popup": {"blocks": [{"type": block}]}}
        pointer = f"/popup/blocks/0/{prop}"
        if prop == "palette":
            value, pointer = {"a": value}, pointer
        ctx = DataContext(kind="vector", geometry="point")
        return _set(doc, pointer, value), pointer, ctx
    if head == "scene":
        pointer = "/" + key.replace(".", "/")
        return (
            _set({"version": "1.0.0"}, pointer, value),
            pointer,
            MapContext(layers={}),
        )
    raise AssertionError(f"no place for {key}")


def _is_palette(key: str) -> bool:
    return key.endswith("palette") and key != "popup.badge.palette"


def errors_at(key: str, value: Any) -> list[tuple[str, str]]:
    """The error issues at or under the color key holding `value`."""
    if _is_palette(key):
        value = [value, "#ffffff"]
    doc, pointer, ctx = place(key, value)
    issues = validate_map(doc, ctx) if key.startswith("scene.") else validate(doc, ctx)
    return [
        (i.code, i.path)
        for i in issues
        if i.level == "error" and (i.path + "/").startswith(pointer + "/")
    ]


@pytest.mark.parametrize("key", list(COLOR_KEYS))
def test_a_color_is_taken_everywhere(key: str) -> None:
    assert errors_at(key, "#3a3541") == []


@pytest.mark.parametrize("key", list(COLOR_KEYS))
def test_auto_is_taken_exactly_where_the_table_accepts_it(key: str) -> None:
    """`accepted` and the models agree: a key the table accepts takes `"auto"`,
    every other key refuses it."""
    errors = errors_at(key, "auto")
    if COLOR_KEYS[key].get("accepted"):
        assert errors == []
    else:
        assert errors and {code for code, _ in errors} == {"invalid_value"}, errors


#: H3's outline color is one fixed color for the layer: no zoom stops.
_FIXED_ONLY = ("h3.outline.color",)


@pytest.mark.parametrize(
    "key",
    [
        k
        for k, row in COLOR_KEYS.items()
        if row.get("accepted") and k not in _FIXED_ONLY
    ],
)
def test_an_accepted_auto_is_taken_in_zoom_stops(key: str) -> None:
    doc, pointer, ctx = place(key, {"zoom": [[5, "auto"], [12, "#3a3541"]]})
    assert [
        (i.code, i.path)
        for i in validate(doc, ctx)
        if i.level == "error" and i.path.startswith(pointer)
    ] == []


def test_a_palette_named_auto_is_an_unknown_palette() -> None:
    doc, pointer, ctx = place("classify.palette", "auto")
    assert ("unknown_palette", pointer) in [
        (i.code, i.path) for i in validate(doc, ctx)
    ]


def test_a_color_read_from_a_field_refuses_a_derived_word_as_its_no_data() -> None:
    """A raw color's `no_data` takes what it took before (it is not drawn), except the
    derived words `"auto"` and `"fill"`; a raw number's (a rotation) stays as it was."""
    ctx = DataContext(kind="vector", geometry="polygon")

    def errors(color: Any) -> list[str]:
        doc = {
            "version": "1.0.0",
            "kind": "vector",
            "symbol": {"fill": {"color": color}},
        }
        return [i.code for i in validate(doc, ctx) if i.level == "error"]

    for kept in ("#ffffff", "red", 5, "", None):
        assert errors({"field": "c", "no_data": kept}) == [], kept
    assert errors({"field": "c"}) == []
    for word in ("auto", "fill"):
        assert errors({"field": "c", "no_data": word}) == ["invalid_value"], word
        stops = {"zoom": [[5, {"field": "c", "no_data": word}], [9, "#000000"]]}
        assert errors(stops) == ["invalid_value"], word
    points = DataContext(kind="vector", geometry="point")
    rotation = {"version": "1.0.0", "kind": "vector"}
    rotation["symbol"] = {"marker": {"rotation": {"field": "r", "no_data": 90}}}
    assert [i.code for i in validate(rotation, points) if i.level == "error"] == []
