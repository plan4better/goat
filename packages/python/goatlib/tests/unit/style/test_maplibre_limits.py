"""The models take their MapLibre limits from data/maplibre_limits.json.

The JSON Schema generated from the models is compared with the table: every
setting's bounds and value forms, and every bound in the schema is either a
table setting's or one of GOAT's own that never reaches MapLibre. The web's
drift test (apps/web/lib/style/__tests__/maplibre-limits.test.ts) compares the
table with MapLibre's style spec.
"""

from fnmatch import fnmatchcase
from typing import Any

import pytest
from goatlib.style import limits
from goatlib.style.models.classify import TARGET_PATHS
from goatlib.style.models.parts import PARTS, PER_LAYER_KEYS
from goatlib.style.schema import json_schema

#: Bounds of the models that never reach MapLibre: GOAT's own, so not in the table.
GOAT_ONLY = {
    "Classification.count",
    "ColorClassification.count",
    "DividerBlock.thickness",
    "FieldListBlock.collapse_after",
    "ImageBlock.height",
    "Popup.max_height",
    "Popup.width",
    "Zoom*.base",
}

DEFS = json_schema()["$defs"]


def _bounded(node: Any, path: str, out: dict[str, tuple[Any, Any]]) -> None:
    """Every number with a bound under `node`, by `Def.property` (`.i` for a tuple item), refs not followed."""
    if isinstance(node, list):
        for item in node:
            _bounded(item, path, out)
        return
    if not isinstance(node, dict):
        return
    # pydantic writes a bound after a BeforeValidator as `ge` and `le` (class and rule zooms)
    low = [node[k] for k in ("minimum", "exclusiveMinimum", "ge") if k in node]
    high = [node[k] for k in ("maximum", "exclusiveMaximum", "le") if k in node]
    if (low or high) and node.get("type") in ("number", "integer"):
        out[path] = (low[0] if low else None, high[0] if high else None)
    for key, value in node.items():
        if key == "prefixItems":
            for i, item in enumerate(value):
                _bounded(item, f"{path}.{i}", out)
        elif key != "$ref":
            _bounded(value, path, out)


def bounded_places() -> dict[str, tuple[Any, Any]]:
    out: dict[str, tuple[Any, Any]] = {}
    for name, schema in DEFS.items():
        for prop, node in (schema.get("properties") or {}).items():
            _bounded(node, f"{name}.{prop}", out)
    return out


PLACES = bounded_places()
PROPERTIES = {
    f"{name}.{prop}"
    for name, schema in DEFS.items()
    for prop in (schema.get("properties") or {})
}


def _refs(node: Any) -> set[str]:
    if isinstance(node, list):
        return set().union(*(_refs(n) for n in node)) if node else set()
    if not isinstance(node, dict):
        return set()
    found = {node["$ref"].removeprefix("#/$defs/")} if "$ref" in node else set()
    return found.union(*(_refs(v) for v in node.values()))


def forms_of(path: str) -> tuple[str | None, bool]:
    """The zoom form and whether attribute mappings are allowed, from the property's schema."""
    name, prop = path.split(".")
    refs = _refs(DEFS[name]["properties"][prop])
    zoom = (
        "step"
        if any(r.startswith("ZoomStep") for r in refs)
        else "blend"
        if any(r.startswith("Zoom") for r in refs)
        else None
    )
    return zoom, bool(refs & {"ByAttributeColor", "ByAttributeNumber"})


def matches(pattern: str) -> list[str]:
    return sorted(p for p in PROPERTIES | set(PLACES) if fnmatchcase(p, pattern))


@pytest.mark.parametrize("key", sorted(limits.SETTINGS))
def test_the_models_take_the_tables_limits(key: str) -> None:
    effective = limits.effective(key)
    patterns = limits.SETTINGS[key].get("models", [])
    assert patterns, f"{key}: the table names no model field"
    for pattern in patterns:
        paths = matches(pattern)
        assert paths, f"{key}: no model field matches {pattern}"
        for path in paths:
            assert PLACES.get(path, (None, None)) == (
                effective["min"],
                effective["max"],
            ), f"{key}: {path} has bounds {PLACES.get(path)}"
            if path in PROPERTIES:
                assert forms_of(path) == (
                    effective["zoom"],
                    effective["attribute"],
                ), f"{key}: {path} takes other value forms"


def test_every_part_key_is_in_the_table() -> None:
    assert sorted((TARGET_PATHS | PER_LAYER_KEYS) - set(limits.SETTINGS)) == []


def test_per_layer_keys_are_the_tables() -> None:
    parts = {
        key
        for key in limits.SETTINGS
        if key.split(".")[0] in PARTS and not limits.effective(key)["per_feature"]
    }
    assert PER_LAYER_KEYS == parts


def test_every_bound_in_the_models_is_the_tables_or_goats_own() -> None:
    patterns = [p for s in limits.SETTINGS.values() for p in s.get("models", [])]
    stray = [
        path
        for path in PLACES
        if not any(fnmatchcase(path, p) for p in patterns)
        and not any(fnmatchcase(path, p) for p in GOAT_ONLY)
        # a zoom stop's value is the property's fixed value, bounded as that is
        and not fnmatchcase(path, "Zoom*.zoom.1")
    ]
    assert stray == [], "bounds neither in the table nor GOAT's own"


def test_settings_that_share_a_type_must_agree() -> None:
    assert limits.bounds("fill.opacity", "line.opacity") == {"ge": 0, "le": 1}
    with pytest.raises(ValueError, match="terrain.direction"):
        limits.bounds("fill.opacity", "terrain.direction")
    assert limits.forms("line.cap", attribute=None) == {
        "zoom": "step",
        "attribute": None,
    }
    with pytest.raises(ValueError, match="fill.pattern"):
        limits.forms("fill.pattern", "fill.color", attribute="color")
