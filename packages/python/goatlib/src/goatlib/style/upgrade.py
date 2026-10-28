"""Upgrading older GOAT Style documents to the current version (the specification's section 14).

Version 0 is today's format (documents without `version`); its upgrade is the
converter of section 17. Later steps (`1 -> 2`) are added here when they exist.
"""

import copy
import json
import re
from collections.abc import Iterator
from dataclasses import replace
from typing import Any

from goatlib.style import limits
from goatlib.style.catalog import palettes
from goatlib.style.context import DataContext
from goatlib.style.convert_v0 import LossyNote, UpgradeResult, convert_v0
from goatlib.style.parse import CURRENT_VERSION
from goatlib.style.pointer import item_key, to_pointer

#: Settings whose bounds became MapLibre's after documents with values outside
#: them were stored, by where they sit: in a `render` of a type, in a part.
_RENDER_BOUNDED = {
    "terrain": {
        "direction": "terrain.direction",
        "exaggeration": "terrain.exaggeration",
    },
    "heatmap": {"radius": "heatmap.radius", "weight": "heatmap.weight"},
}
_PART_BOUNDED = {"arrows": {"spacing": "arrows.spacing"}}

#: A place in a document: the list indexes to reach it, and its JSON pointer segments.
_Place = tuple[list[str | int], list[str]]


def upgrade(
    doc: dict[str, Any], ctx: DataContext, *, strict: bool = False
) -> UpgradeResult:
    """`doc` at the current version, its values inside the bounds goatlib takes
    from MapLibre; a current document inside them is returned as it is.

    `strict=True` is for a document being written: one at the current version is
    returned as it is, so the validator reports a value outside the bounds as an
    error. An older document is converted and brought inside either way.
    """
    if not isinstance(doc, dict) or "version" not in doc:
        return bring_inside(convert_v0(doc if isinstance(doc, dict) else {}, ctx))
    version = doc.get("version")
    if version == CURRENT_VERSION:
        current = UpgradeResult(
            document=doc, map_state={}, lossy=(), version_from=CURRENT_VERSION
        )
        return current if strict else bring_inside(current)
    return UpgradeResult(
        document=doc,
        map_state={},
        lossy=(),
        version_from=version if isinstance(version, int) else -1,
    )


def palette_id_for_v0(color_range: dict[str, Any]) -> str | list[str]:
    """Today's color range as a catalogue id when it names one, otherwise its colors inline."""
    name = color_range.get("name") if isinstance(color_range.get("name"), str) else ""
    category = str(color_range.get("category") or "")
    catalogue = palettes()
    brewer = re.match(r"^colorbrewer\s+([A-Za-z]+)(-\d+)?$", name, re.IGNORECASE)
    if brewer or category.lower() == "colorbrewer":
        scheme = brewer.group(1) if brewer else name
        for pid in catalogue:
            if pid.lower() == f"colorbrewer:{scheme.lower()}":
                return pid
    if name:
        slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        if f"uber:{slug}" in catalogue:
            return f"uber:{slug}"
    colors = (
        color_range.get("colors") if isinstance(color_range.get("colors"), list) else []
    )
    return [c.lower() for c in colors if isinstance(c, str)]


def _parts(doc: dict[str, Any]) -> Iterator[tuple[_Place, dict[str, Any]]]:
    """The parts of a document by their place: the symbol's, each rule's and each class's."""
    symbol = doc.get("symbol")
    if isinstance(symbol, dict):
        yield (["symbol"], ["symbol"]), symbol
    owners: list[tuple[_Place, Any]] = []
    rules = doc.get("rules")
    if isinstance(rules, list):
        owners += [
            ((["rules", i], ["rules", item_key(r, i)]), r) for i, r in enumerate(rules)
        ]
    classify = doc.get("classify")
    if isinstance(classify, list):
        for i, c in enumerate(classify):
            classes = c.get("classes") if isinstance(c, dict) else None
            if isinstance(classes, list):
                path: list[str | int] = ["classify", i, "classes"]
                segments = ["classify", item_key(c, i), "classes"]
                owners += [
                    ((path + [j], segments + [item_key(k, j)]), k)
                    for j, k in enumerate(classes)
                ]
    for place, owner in owners:
        if isinstance(owner, dict):
            yield place, owner


def _bounded(doc: dict[str, Any]) -> Iterator[tuple[_Place, str, Any]]:
    """Every value of a setting `bring_inside` reads: its place, its setting, the value."""
    render = doc.get("render")
    if isinstance(render, dict):
        for name, key in _RENDER_BOUNDED.get(str(render.get("type")), {}).items():
            if name in render:
                yield (["render", name], ["render", name]), key, render[name]
    for (path, segments), part_owner in _parts(doc):
        for part, settings in _PART_BOUNDED.items():
            values = part_owner.get(part)
            if not isinstance(values, dict):
                continue
            for name, key in settings.items():
                if name in values:
                    place = (path + [part, name], segments + [part, name])
                    yield place, key, values[name]


def _number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _inside(key: str, value: Any) -> Any:
    """A fixed value or zoom stops inside the setting's bounds; any other form as it is."""
    if _number(value):
        return limits.inside(key, value)
    if isinstance(value, dict) and isinstance(value.get("zoom"), list):
        stops = [
            [s[0], limits.inside(key, s[1])]
            if isinstance(s, list) and len(s) == 2 and _number(s[1])
            else s
            for s in value["zoom"]
        ]
        return {**value, "zoom": stops}
    return value


def bring_inside(result: UpgradeResult) -> UpgradeResult:
    """The upgraded document with values a stored document may hold outside the
    bounds goatlib takes from MapLibre brought inside them (`limits.inside`), each
    one noted. The document is copied only when a value changes."""
    doc = result.document
    changed = [
        (place, key, value, new)
        for place, key, value in _bounded(doc)
        if (new := _inside(key, value)) != value
    ]
    if not changed:
        return result
    doc = copy.deepcopy(doc)
    notes = []
    for (path, segments), key, value, new in changed:
        node: Any = doc
        for step in path[:-1]:
            node = node[step]
        node[path[-1]] = new
        notes.append(
            LossyNote(
                to_pointer(segments),
                f"{_json(value)} is outside what {key} takes; it is {_json(new)}.",
            )
        )
    return replace(result, document=doc, lossy=result.lossy + tuple(notes))


def _json(v: Any) -> str:
    return json.dumps(v, separators=(", ", ": "))
