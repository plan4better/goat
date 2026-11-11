"""The map document's `scene`: terrain, basemap buildings, sky, fog, globe glow and light.

Every key is optional; a missing one is automatic (the auto table in
`goatlib.style.scene`). Values are fixed or by zoom, never by attribute: they
hold for the whole map. Bounds and value forms come from the limits table.
"""

from typing import Annotated

from pydantic import Field

from goatlib.style import limits
from goatlib.style.models.base import StyleModel
from goatlib.style.models.parts import switchable
from goatlib.style.models.values import Color, value_type

_COLORS = (
    "scene.sky.color",
    "scene.sky.horizon_color",
    "scene.fog.color",
    "scene.glow.color",
    "scene.light.color",
)
_UNITS = (
    "scene.sky.horizon_blend",
    "scene.fog.horizon_blend",
    "scene.fog.ground_blend",
    "scene.glow.strength",
    "scene.light.intensity",
)

SceneColorValue = value_type(
    "SceneColor", Color, **limits.forms(*_COLORS, attribute=None)
)
SceneUnitValue = value_type(
    "SceneUnit",
    Annotated[float, Field(**limits.bounds(*_UNITS))],
    **limits.forms(*_UNITS, attribute=None),
)


class SceneTerrain(StyleModel):
    exaggeration: (
        Annotated[float, Field(**limits.bounds("scene.terrain.exaggeration"))] | None
    ) = None


#: `false` switches terrain off.
SceneTerrainPart = switchable(SceneTerrain)


class SceneBuildings(StyleModel):
    """3D buildings: `on` (missing: automatic) and how opaque they are."""

    on: bool | None = None
    opacity: (
        Annotated[float, Field(**limits.bounds("scene.buildings.opacity"))] | None
    ) = None


class SceneSky(StyleModel):
    color: SceneColorValue | None = None
    horizon_color: SceneColorValue | None = None
    horizon_blend: SceneUnitValue | None = None


class SceneFog(StyleModel):
    color: SceneColorValue | None = None
    horizon_blend: SceneUnitValue | None = None
    ground_blend: SceneUnitValue | None = None


class SceneGlow(StyleModel):
    """The glow around the globe: how strong it is, and the colour of GOAT's halo."""

    strength: SceneUnitValue | None = None
    color: SceneColorValue | None = None


class SceneLight(StyleModel):
    """Where the light comes from: a compass direction and an altitude above the
    horizon, with its intensity and colour."""

    direction: (
        Annotated[float, Field(**limits.bounds("scene.light.direction"))] | None
    ) = None
    altitude: (
        Annotated[float, Field(**limits.bounds("scene.light.altitude"))] | None
    ) = None
    intensity: SceneUnitValue | None = None
    color: SceneColorValue | None = None


class Scene(StyleModel):
    terrain: SceneTerrainPart | None = None
    #: `true` and `false` switch buildings on and off, like `{ "on": ... }`.
    buildings: bool | SceneBuildings | None = None
    sky: SceneSky | None = None
    fog: SceneFog | None = None
    glow: SceneGlow | None = None
    light: SceneLight | None = None
