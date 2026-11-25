"""What a missing `scene` key means, and whether a layer style draws heights.

A map document's `scene` keys are optional: a missing one takes the auto table's
value for the basemap's tone (`light` or `dark`). Three things the table does
not decide: a missing `fog` section draws no fog (the table's fog values are
where a set fog starts), the web derives the horizon and fog colours from the
basemap's ground where it knows it, and a missing `light` stands with the
camera. The tables travel to the web in the JSON Schema (`x-scene-auto`,
`x-scene-defaults`).
"""

from typing import Any, Literal

from goatlib.style import limits
from goatlib.style.check import record_places
from goatlib.style.convert_v0 import LossyNote

#: The glow in full: it shows only around the zoomed-out globe, which hands over to the flat map by zoom 9.
_GLOW_AUTO = 1
#: The halo's colour around the globe, the same on every basemap.
_GLOW_COLOR_AUTO = "#6EA5F5"

#: Automatic scene values by the basemap's tone, keyed `section.key`.
SCENE_AUTO: dict[Literal["light", "dark"], dict[str, Any]] = {
    "light": {
        "sky.color": "#79B8EC",
        "sky.horizon_color": "#DFEEFA",
        "sky.horizon_blend": 0.6,
        "fog.color": "#E9F1F7",
        "fog.horizon_blend": 0.5,
        "fog.ground_blend": 0.6,
        "light.intensity": 0.45,
        "light.color": "#FFFFFF",
        "glow.strength": _GLOW_AUTO,
        "glow.color": _GLOW_COLOR_AUTO,
    },
    "dark": {
        "sky.color": "#1D4877",
        "sky.horizon_color": "#3B6A99",
        "sky.horizon_blend": 0.7,
        "fog.color": "#1B2633",
        "fog.horizon_blend": 0.5,
        "fog.ground_blend": 0.6,
        "light.intensity": 0.35,
        "light.color": "#FFFFFF",
        "glow.strength": _GLOW_AUTO,
        "glow.color": _GLOW_COLOR_AUTO,
    },
}

#: What other missing scene keys mean; a storey counts this many metres.
SCENE_DEFAULTS: dict[str, Any] = {
    "terrain.exaggeration": 1,
    "buildings.opacity": 0.6,
    "storey_height": 3,
}


def buildings_on(scene: Any) -> bool | None:
    """Whether the scene switches buildings on (`true`) or off (`false`), from
    `buildings: true | false` or `buildings: { "on" }`; None: automatic."""
    buildings = scene.get("buildings") if isinstance(scene, dict) else None
    if isinstance(buildings, dict):
        buildings = buildings.get("on")
    return buildings if isinstance(buildings, bool) else None


#: Light keys of the Sun position mode, which is gone until MapLibre casts shadows.
_SUN_KEYS = ("mode", "month", "day", "time")


def upgrade_scene(scene: Any) -> tuple[Any, tuple[LossyNote, ...]]:
    """A stored scene as it reads today, each change noted: a light with Sun
    position keys (`mode`, `month`, `day`, `time`) loses them and keeps the
    rest, and a light below the horizon (an altitude Sun position allowed) is
    brought onto it. Any other scene is returned as it is; a write takes the
    scene as it is, so the validator refuses both there."""
    light = scene.get("light") if isinstance(scene, dict) else None
    if not isinstance(light, dict):
        return scene, ()
    kept = {k: v for k, v in light.items() if k not in _SUN_KEYS}
    notes: list[LossyNote] = []
    if len(kept) < len(light):
        notes.append(
            LossyNote(
                "/scene/light",
                "Sun position is no longer offered; the light keeps its other settings.",
            )
        )
    altitude = kept.get("altitude")
    if isinstance(altitude, (int, float)) and not isinstance(altitude, bool):
        inside = limits.inside("scene.light.altitude", altitude)
        if inside != altitude:
            kept["altitude"] = inside
            notes.append(
                LossyNote(
                    "/scene/light/altitude",
                    f"{altitude} is below the horizon; the light stands on it ({inside}).",
                )
            )
    if not notes:
        return scene, ()
    return {**scene, "light": kept}, tuple(notes)


def extrudes(style: Any) -> bool:
    """Whether a layer style draws heights: an `extrude` part that is on in the
    symbol, a class or a rule, or an H3 render with `extrude`."""
    if not isinstance(style, dict) or style.get("kind") != "vector":
        return False
    render = style.get("render")
    if isinstance(render, dict) and render.get("type") == "h3":
        return isinstance(render.get("extrude"), dict)
    return any(
        isinstance(record.get("extrude"), dict) for _, record, _ in record_places(style)
    )
