"""The map document's `scene` block: models, checks, the auto tables, the read upgrade."""

from goatlib.style.context import MapContext
from goatlib.style.models.map_document import MapDocument
from goatlib.style.validate import validate_map

from .conftest import codes


def scene_codes(scene: dict) -> list[str]:
    return codes(MapDocument, {"version": 1, "scene": scene})


def test_full_scene_parses() -> None:
    assert (
        scene_codes(
            {
                "terrain": {"exaggeration": 1.5},
                "buildings": True,
                "sky": {
                    "color": "#79B8EC",
                    "horizon_color": "#DFEEFA",
                    "horizon_blend": 0.6,
                },
                "fog": {"color": "#E9F1F7", "horizon_blend": 0.7, "ground_blend": 0.4},
                "glow": {
                    "strength": {"zoom": [[0, 1], [5, 0.8], [7, 0]]},
                    "color": {"zoom": [[2, "#6EA5F5"], [8, "#F5C16E"]]},
                },
                "light": {
                    "direction": 225,
                    "altitude": 30,
                    "intensity": 0.4,
                    "color": {"zoom": [[10, "#FFE0C2"], [16, "#FFFFFF"]]},
                },
            }
        )
        == []
    )


def test_terrain_off_and_empty_scene() -> None:
    assert scene_codes({"terrain": False}) == []
    assert scene_codes({}) == []


def test_exaggeration_is_fixed_and_bounded() -> None:
    assert scene_codes({"terrain": {"exaggeration": 4}}) != []
    assert scene_codes({"terrain": {"exaggeration": {"zoom": [[5, 1], [10, 2]]}}}) != []


def test_buildings_take_a_boolean_or_on_and_a_fixed_opacity() -> None:
    from goatlib.style import limits
    from goatlib.style.scene import SCENE_DEFAULTS, buildings_on

    for buildings in (
        True,
        False,
        {},
        {"on": False},
        {"opacity": 0},
        {"on": True, "opacity": 1},
    ):
        assert scene_codes({"buildings": buildings}) == [], buildings
    assert scene_codes({"buildings": {"opacity": 1.2}}) != []
    assert scene_codes({"buildings": {"opacity": -0.1}}) != []
    assert scene_codes({"buildings": {"opacity": {"zoom": [[14, 1], [16, 0.5]]}}}) != []
    assert "unknown_key" in scene_codes({"buildings": {"height": 2}})
    assert SCENE_DEFAULTS["buildings.opacity"] == 0.6
    setting = limits.effective("scene.buildings.opacity")
    assert (setting["min"], setting["max"], setting["zoom"]) == (0, 1, None)
    assert limits.SETTINGS["scene.buildings.opacity"]["maplibre"] == [
        "paint_fill-extrusion.fill-extrusion-opacity"
    ]
    assert buildings_on({"buildings": True}) is True
    assert buildings_on({"buildings": {"on": False, "opacity": 0.4}}) is False
    assert buildings_on({"buildings": {"opacity": 0.4}}) is None
    assert buildings_on({}) is None
    assert buildings_on(None) is None


def test_light_direction_bounds() -> None:
    assert scene_codes({"light": {"direction": 360}}) != []
    assert scene_codes({"light": {"direction": 359.5, "altitude": 0}}) == []
    assert scene_codes({"light": {"altitude": 90}}) == []
    assert scene_codes({"light": {"altitude": -1}}) != []
    assert scene_codes({"light": {"altitude": 91}}) != []


def test_sun_position_keys_are_gone_on_write() -> None:
    for key, value in (("mode", "sun"), ("month", 6), ("day", 21), ("time", "18:00")):
        assert scene_codes({"light": {key: value}}) == ["unknown_key"], key


def test_a_stored_sun_light_reads_without_its_sun_keys() -> None:
    from goatlib.style.scene import upgrade_scene

    stored = {
        "terrain": False,
        "light": {
            "mode": "sun",
            "month": 6,
            "day": 21,
            "time": "20:30",
            "intensity": 0.5,
        },
    }
    scene, notes = upgrade_scene(stored)
    assert scene == {"terrain": False, "light": {"intensity": 0.5}}
    assert [n.key for n in notes] == ["/scene/light"]
    assert stored["light"]["mode"] == "sun"  # the stored scene is not changed
    assert scene_codes(scene) == []
    direction = {"light": {"mode": "direction", "direction": 200, "month": 3}}
    assert upgrade_scene(direction)[0] == {"light": {"direction": 200}}
    current = {"light": {"direction": 200, "altitude": 40}}
    assert upgrade_scene(current) == (current, ())
    assert upgrade_scene(None) == (None, ())


def test_a_stored_light_below_the_horizon_reads_on_it() -> None:
    from goatlib.style.scene import upgrade_scene

    scene, notes = upgrade_scene({"light": {"direction": 200, "altitude": -10}})
    assert scene == {"light": {"direction": 200, "altitude": 0}}
    assert [n.key for n in notes] == ["/scene/light/altitude"]
    both, notes = upgrade_scene({"light": {"mode": "sun", "altitude": -5}})
    assert both == {"light": {"altitude": 0}}
    assert len(notes) == 2


def test_the_map_document_carries_the_upgraded_scene() -> None:
    from goatlib.style.map_rows import build_map_document

    document = build_map_document(
        basemap=None,
        locale=None,
        view_state=None,
        bounds=None,
        groups=[],
        layers=[],
        scene={"light": {"mode": "sun", "month": 6, "day": 21, "time": "12:00"}},
    )
    assert document["scene"] == {"light": {}}


def test_scene_values_take_no_attribute_form() -> None:
    assert scene_codes({"sky": {"color": {"field": "x", "palette": "d3:viridis"}}}) == [
        "value_form_not_allowed"
    ]


def test_unknown_scene_key() -> None:
    assert scene_codes({"stars": True}) == ["unknown_key"]


def test_auto_tables_match_the_canvas() -> None:
    from goatlib.style.scene import SCENE_AUTO

    assert SCENE_AUTO["light"]["sky.color"] == "#79B8EC"
    # Where a set fog starts (no fog section draws none); the light stands with the camera.
    assert SCENE_AUTO["dark"]["fog.ground_blend"] == 0.6
    assert "light.direction" not in SCENE_AUTO["light"]
    # The glow shows only around the zoomed-out globe: full wherever it shows.
    assert (
        SCENE_AUTO["light"]["glow.strength"] == SCENE_AUTO["dark"]["glow.strength"] == 1
    )
    # The halo's colour around the globe is GOAT's own and the same on every basemap.
    assert (
        SCENE_AUTO["light"]["glow.color"]
        == SCENE_AUTO["dark"]["glow.color"]
        == "#6EA5F5"
    )
    assert set(SCENE_AUTO["light"]) == set(SCENE_AUTO["dark"])


def test_auto_values_are_valid_scene_values() -> None:
    from goatlib.style.scene import SCENE_AUTO

    for tone in ("light", "dark"):
        scene: dict = {}
        for key, value in SCENE_AUTO[tone].items():
            section, name = key.split(".")
            scene.setdefault(section, {})[name] = value
        assert scene_codes(scene) == []


def test_extrudes() -> None:
    from goatlib.style.scene import extrudes

    assert extrudes(
        {"version": 1, "kind": "vector", "symbol": {"extrude": {"height": 10}}}
    )
    assert not extrudes({"version": 1, "kind": "vector", "symbol": {"extrude": False}})
    assert extrudes(
        {
            "version": 1,
            "kind": "vector",
            "rules": [
                {"when": {"op": "isNull", "args": [{"property": "a"}]}, "extrude": {}}
            ],
        }
    )
    assert extrudes(
        {"version": 1, "kind": "vector", "render": {"type": "h3", "extrude": {}}}
    )
    assert not extrudes(
        {"version": 1, "kind": "vector", "render": {"type": "heatmap", "extrude": {}}}
    )
    assert not extrudes({"version": 1, "kind": "raster"})
    assert not extrudes(None)


CTX = MapContext(
    layers={1: frozenset(), 2: frozenset()},
    extruded=frozenset({2}),
    terrain_source=True,
    buildings_source=True,
)


def issues_of(scene: dict, ctx: MapContext = CTX) -> list[tuple[str, str, str]]:
    return [
        (i.code, i.level, i.path)
        for i in validate_map({"version": 1, "scene": scene}, ctx)
    ]


def test_fog_without_terrain() -> None:
    assert issues_of({"terrain": False, "fog": {"color": "#ffffff"}}) == [
        ("fog_without_terrain", "warning", "/scene/fog")
    ]
    assert issues_of({"fog": {"color": "#ffffff"}}) == []
    no_dem = MapContext(layers={}, terrain_source=False)
    assert issues_of({"fog": {"color": "#ffffff"}}, no_dem) == [
        ("fog_without_terrain", "warning", "/scene/fog")
    ]


def test_buildings_with_extruded_layer() -> None:
    assert issues_of({"buildings": True}) == [
        ("buildings_with_extruded_layer", "warning", "/scene/buildings")
    ]
    assert issues_of({"buildings": False}) == []
    assert issues_of({}) == []  # missing = automatic: off when a layer extrudes
    flat = MapContext(layers={1: frozenset()}, buildings_source=True)
    assert issues_of({"buildings": True}, flat) == []
    assert issues_of({"buildings": {"on": True, "opacity": 0.4}}) == [
        ("buildings_with_extruded_layer", "warning", "/scene/buildings")
    ]
    assert issues_of({"buildings": {"opacity": 0.4}}) == []


def test_sources_missing_only_when_known() -> None:
    unknown = MapContext(layers={})
    assert issues_of({"terrain": {"exaggeration": 2}, "buildings": True}, unknown) == []
    none = MapContext(layers={}, terrain_source=False, buildings_source=False)
    assert issues_of({"terrain": {"exaggeration": 2}, "buildings": True}, none) == [
        ("scene_source_missing", "warning", "/scene/buildings"),
        ("scene_source_missing", "warning", "/scene/terrain"),
    ]
    assert issues_of({"terrain": False, "buildings": False}, none) == []


def test_new_codes_have_levels() -> None:
    from goatlib.style.issues import CODES

    assert CODES["base_above_height"] == "error"
    assert CODES["extrude_drops_pattern"] == "warning"
