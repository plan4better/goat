"""The limits GOAT Style takes from MapLibre (`data/maplibre_limits.json`).

GOAT Style is its own format; where a setting compiles to a MapLibre property,
MapLibre's bounds and value forms for it are copied into one table, by GOAT
setting, and the models read them from here. A setting's `goat` entry holds
goatlib's own values where it does not take MapLibre's. The web's drift test
(`apps/web/lib/style/__tests__/maplibre-limits.test.ts`) fails when the
installed MapLibre style spec no longer matches the table.
"""

import json
from importlib import resources
from typing import Any, Literal

Zoom = Literal["blend", "step"] | None

SETTINGS: dict[str, dict[str, Any]] = json.loads(
    resources.files("goatlib.style")
    .joinpath("data", "maplibre_limits.json")
    .read_text(encoding="utf-8")
)["settings"]


def effective(key: str) -> dict[str, Any]:
    """goatlib's values for a setting: `min`, `max`, `zoom` (the zoom form),
    `attribute` (attribute mappings allowed) and `per_feature` (classes and rules
    may set it); goatlib's own where the table gives them, MapLibre's otherwise.
    A choice (a name the compiler turns into the value) has no bounds."""
    setting = SETTINGS[key]
    spec, goat = setting["spec"], setting.get("goat", {})
    feature = spec.get("feature", False)
    choice = goat.get("choice", False)
    return {
        "min": None if choice else goat.get("min", spec["min"]),
        "max": None if choice else goat.get("max", spec["max"]),
        "zoom": goat.get("zoom", spec.get("zoom")),
        "attribute": goat.get("attribute", feature),
        "per_feature": goat.get("per_feature", feature),
    }


#: Settings that go round a circle: a value outside 0 to 360 is the same angle (360 is 0).
_ANGLES = frozenset({"terrain.direction"})


def inside(key: str, value: float) -> float:
    """`value` within goatlib's bounds for the setting: an angle taken round the
    circle first, then the nearest bound for a value outside them."""
    if key in _ANGLES:
        value = value % 360
    setting = effective(key)
    if setting["min"] is not None and value < setting["min"]:
        return setting["min"]
    if setting["max"] is not None and value > setting["max"]:
        return setting["max"]
    return value


def _shared(keys: tuple[str, ...], fields: tuple[str, ...]) -> dict[str, Any]:
    """The values of `fields` the settings share; settings that disagree cannot share a type."""
    values = {k: tuple(effective(k)[f] for f in fields) for k in keys}
    if len(set(values.values())) != 1:
        raise ValueError(
            "Settings that share a type must agree: "
            + ", ".join(f"{k} {v}" for k, v in values.items())
        )
    return dict(zip(fields, values[keys[0]]))


def bounds(*keys: str) -> dict[str, float]:
    """`Field` arguments (`ge`, `le`) for a number the settings share."""
    shared = _shared(keys, ("min", "max"))
    return {
        arg: shared[f]
        for arg, f in (("ge", "min"), ("le", "max"))
        if shared[f] is not None
    }


def forms(*keys: str, attribute: Literal["color", "number"] | None) -> dict[str, Any]:
    """`value_type` arguments for a value the settings share: their zoom form, and
    `attribute` (the kind of attribute mapping) where the settings allow mappings."""
    shared = _shared(keys, ("zoom", "attribute"))
    if shared["attribute"] and attribute is None:
        raise ValueError(
            f"{', '.join(keys)} allow attribute mappings: name their kind."
        )
    return {
        "zoom": shared["zoom"],
        "attribute": attribute if shared["attribute"] else None,
    }


def per_layer(keys: frozenset[str] | set[str]) -> frozenset[str]:
    """The settings among `keys` that classes and rules may not set per feature."""
    return frozenset(k for k in keys if not effective(k)["per_feature"])
