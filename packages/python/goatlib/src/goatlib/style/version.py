"""Versions of GOAT Style (the specification's sections 14 and 21).

A document's `version` is three numbers, `major.minor.patch`, one version for
layer styles and the map document. goatlib writes the lowest version whose keys
cover what a document uses: `data/keys-1.0.0.json` lists the keys of 1.0.0 and
`SINCE` the version that added each later key, so a document that uses nothing
newer stays readable by older servers. The catalogue's palettes and library
icons are keys too (`catalog.palettes=<id>`, `catalog.icons=<id>`). The integer
1 of documents written before three numbers reads as 1.0.0.
"""

import json
import re
from collections.abc import Iterator
from functools import cache
from typing import Annotated, Any

from pydantic import BaseModel, Field

from goatlib.style.catalog import icon_libraries, palettes
from goatlib.style.models.base import StyleModel

#: The highest version this goatlib reads and writes.
SPEC_VERSION = "1.0.0"
#: The first version with three numbers; every key of `data/keys-1.0.0.json` is in it.
BASE_VERSION = "1.0.0"
#: The version that added a key after 1.0.0: "<Model>.<key>", or "<Model>.<key>=<value>"
#: for a value of an enum (the schema's names, `schema_keys`).
SINCE: dict[str, str] = {}
#: The GOAT release that first reads each version (the specification's section 21).
RELEASES: dict[str, str] = {"1.0.0": "the first release with GOAT Style"}

Version = tuple[int, int, int]
_NUMBER = r"(0|[1-9][0-9]*)"
SpecVersionStr = Annotated[str, Field(pattern=rf"^{_NUMBER}\.{_NUMBER}\.{_NUMBER}$")]

_SEMVER = re.compile(rf"{_NUMBER}\.{_NUMBER}\.{_NUMBER}")


def parse_version(raw: object) -> Version | None:
    """`"1.2.3"` as (1, 2, 3), the integer 1 as (1, 0, 0); anything else None."""
    if type(raw) is int and raw == 1:
        return (1, 0, 0)
    if isinstance(raw, str) and (m := _SEMVER.fullmatch(raw)):
        return (int(m[1]), int(m[2]), int(m[3]))
    return None


def format_version(v: Version) -> str:
    return ".".join(str(n) for n in v)


def known_version(text: str) -> Version:
    """A version this module names (`SPEC_VERSION`, `SINCE`), parsed."""
    v = parse_version(text)
    if v is None:
        raise ValueError(f"{text!r} is not a version")
    return v


def _text(value: Any) -> str:
    """A value as it appears in a key: text as it is, anything else as JSON."""
    return value if isinstance(value, str) else json.dumps(value)


def _walk(value: Any, models: list[BaseModel], leaves: list[Any]) -> None:
    """Puts the models under a key on `models` and its plain values (in lists,
    tuples and the values of mappings) on `leaves`."""
    if isinstance(value, BaseModel):
        models.append(value)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _walk(item, models, leaves)
    elif isinstance(value, dict):
        for item in value.values():
            _walk(item, models, leaves)
    elif value is not None:
        leaves.append(value)


@cache
def _catalogue() -> dict[str, frozenset[str]]:
    """The ids of the catalogue's palettes and library icons, by the schema's
    `catalog` key."""
    icons = (f"{lib}:{n}" for lib, names in icon_libraries().items() for n in names)
    return {"palettes": frozenset(palettes()), "icons": frozenset(icons)}


def used_keys(model: StyleModel) -> set[str]:
    """The keys a parsed document sets, by model: "<Model>.<key>" for each key,
    "<Model>.<key>=<value>" for each plain value under it, and
    "catalog.<palettes|icons>=<id>" for each catalogue palette or library icon it
    names. Keys left at their default are not set."""
    keys: set[str] = set()
    catalogue = _catalogue()
    models: list[BaseModel] = [model]
    while models:
        node = models.pop()
        fields = type(node).model_fields
        owner = type(node).__name__
        for name in node.model_fields_set:
            key = f"{owner}.{fields[name].alias or name}"
            keys.add(key)
            leaves: list[Any] = []
            _walk(getattr(node, name), models, leaves)
            for leaf in leaves:
                keys.add(f"{key}={_text(leaf)}")
                if isinstance(leaf, str):
                    keys.update(
                        f"catalog.{kind}={leaf}"
                        for kind, ids in catalogue.items()
                        if leaf in ids
                    )
    return keys


def required_version(model: StyleModel) -> str:
    """The lowest version whose keys cover every key set in the parsed document."""
    needed = [known_version(SINCE[k]) for k in used_keys(model) if k in SINCE]
    return format_version(max([known_version(BASE_VERSION), *needed]))


def stamped(doc: dict[str, Any], model: StyleModel) -> dict[str, Any]:
    """A copy of `doc` with the version it needs; `model` is `doc` parsed."""
    return {**doc, "version": required_version(model)}


def stamp(doc: dict[str, Any], *, map_document: bool = False) -> dict[str, Any]:
    """`doc` (a layer style, or the map document) as every writer stores it: a
    copy with the lowest version its keys need. A document goatlib cannot read
    comes back as it is, the same object with its own version."""
    from goatlib.style.parse import parse_for_write, parse_map_document

    model, _ = (parse_map_document if map_document else parse_for_write)(doc)
    return stamped(doc, model) if model is not None else doc


def _enum_values(node: Any) -> Iterator[Any]:
    if isinstance(node, dict):
        if "const" in node:
            yield node["const"]
        yield from node.get("enum", [])
        for k, v in node.items():
            if k not in ("const", "enum", "default", "examples"):
                yield from _enum_values(v)
    elif isinstance(node, list):
        for v in node:
            yield from _enum_values(v)


@cache
def _schema_keys() -> frozenset[str]:
    from goatlib.style.schema import json_schema

    keys: set[str] = set()
    for name, definition in json_schema()["$defs"].items():
        for prop, schema in definition.get("properties", {}).items():
            keys.add(f"{name}.{prop}")
            keys.update(f"{name}.{prop}={_text(v)}" for v in _enum_values(schema))
    return frozenset(keys)


def schema_keys() -> set[str]:
    """Every key of the schema, "<Model>.<key>", and every value of an enum,
    "<Model>.<key>=<value>": the catalogue's palettes and library icons are the
    enums of `catalog.palettes` and `catalog.icons`."""
    return set(_schema_keys())
