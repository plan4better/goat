import json

import pytest
from goatlib.style.context import DataContext
from goatlib.style.defaults import default_style
from goatlib.style.validate import validate

from .conftest import FIXTURES


@pytest.mark.parametrize(
    "name",
    [
        "districts",
        "schools",
        "routes",
        "elevation",
        "satellite",
        "landcover",
        "wms",
        "tiles",
    ],
)
def test_defaults_validate_and_are_stable(name: str, contexts: dict) -> None:
    doc = default_style(contexts[name], seed="layer-1")
    assert [i for i in validate(doc, contexts[name]) if i.level == "error"] == []
    assert default_style(contexts[name], seed="layer-1") == doc


#: carto:Bold, the palette new layers take their color from, in its order.
BOLD = [
    "#7f3c8d",
    "#11a579",
    "#3969ac",
    "#f2b701",
    "#e73f74",
    "#80ba5a",
    "#e68310",
    "#008695",
    "#cf1c90",
    "#f97b72",
]


def test_the_seed_picks_one_of_the_ten_bold_colors_and_all_ten_are_reachable() -> None:
    ctx = DataContext(kind="vector", geometry="polygon")
    colors = {
        default_style(ctx, seed=f"layer-{i}")["symbol"]["fill"]["color"]
        for i in range(400)
    }
    assert colors == set(BOLD)
    assert default_style(ctx)["symbol"]["fill"]["color"] == BOLD[0]


def test_the_same_seed_gives_the_same_color_on_every_geometry() -> None:
    def color(geometry: str, seed: str) -> str:
        symbol = default_style(
            DataContext(kind="vector", geometry=geometry), seed=seed
        )["symbol"]
        part = symbol.get("fill") or symbol.get("line") or symbol["marker"]
        return part["color"]

    for seed in ("a", "layer-7", "0f9c2d6e-0000-4000-8000-000000000001"):
        assert color("polygon", seed) == color("polygon", seed)
        assert color("polygon", seed) == color("line", seed) == color("point", seed)


def test_a_new_polygon_has_a_thin_outline_in_a_darker_shade_of_its_fill() -> None:
    doc = default_style(DataContext(kind="vector", geometry="polygon"), seed="layer-1")
    assert doc["symbol"] == {
        "fill": {"color": doc["symbol"]["fill"]["color"], "opacity": 0.8},
        "outline": {"color": "auto", "width": 1},
    }


def test_new_points_and_lines_keep_their_shape() -> None:
    point = default_style(DataContext(kind="vector", geometry="point"), seed="s")
    line = default_style(DataContext(kind="vector", geometry="line"), seed="s")
    color = point["symbol"]["marker"]["color"]
    assert point["symbol"] == {
        "marker": {"shape": "circle", "color": color, "size": 10}
    }
    assert line["symbol"] == {"line": {"color": color, "width": 2}}


def test_the_web_mirror_reads_the_same_documents() -> None:
    # fixtures/default_styles.json holds goatlib's default documents; the web's
    # `defaultStyle` must equal them but for the color (lib/style/__tests__/defaults.test.ts).
    rows = json.loads((FIXTURES / "default_styles.json").read_text())
    assert rows == [
        {
            "geometry": geometry,
            "seed": "layer-1",
            "style": default_style(
                DataContext(kind="vector", geometry=geometry), seed="layer-1"
            ),
        }
        for geometry in ("point", "line", "polygon")
    ]


STARTING_VALUES = json.loads((FIXTURES / "starting_values.json").read_text())


@pytest.mark.parametrize(
    "row", STARTING_VALUES, ids=[r["name"] for r in STARTING_VALUES]
)
def test_what_the_panel_writes_when_a_part_is_switched_on_is_valid(row: dict) -> None:
    # fixtures/starting_values.json holds the documents the web panel writes when
    # a label, an icon, clustering, an outline or a casing is switched on (the web's test:
    # styleEditor/__tests__/starting-values.test.tsx), and both candidates for a
    # point label's halo.
    ctx = DataContext(kind="vector", geometry=row["geometry"], fields={})
    assert [i for i in validate(row["style"], ctx) if i.level == "error"] == []


def test_an_absent_key_keeps_its_color() -> None:
    from goatlib.style.defaults import REFERENCE_DEFAULTS

    # The starting values are written into a document; a document without them
    # draws these reference colors.
    assert REFERENCE_DEFAULTS["label.color"] == "#3a3541"
    assert REFERENCE_DEFAULTS["label.halo.color"] == "#ffffff"
    assert REFERENCE_DEFAULTS["marker.icon_color"] == "#ffffff"
    assert REFERENCE_DEFAULTS["outline.color"] == "#ffffff"


@pytest.mark.parametrize("source", ["xyz", "cog"])
def test_raster_default_is_a_plain_image_at_full_opacity(source: str) -> None:
    # No opacity key: rasters draw at the schema's opacity 1, so the colors on the map match the legend.
    assert default_style(DataContext(kind="raster", source=source)) == {
        "version": "1.0.0",
        "kind": "raster",
        "render": {"type": "image"},
    }


def _value_validates(path: str, value: object) -> bool:
    """Whether `value` is valid where `path` points, in the smallest document holding it."""
    import pydantic
    from goatlib.style.models.layer import Legend, VectorStyle
    from goatlib.style.models.parts import PARTS, Font, Halo
    from goatlib.style.models.popup import Popup
    from goatlib.style.models.raster import RasterStyle
    from goatlib.style.models.render import ClusterRender, H3Render, HeatmapRender
    from goatlib.style.models.values import NumberFormat

    head, _, rest = path.partition(".")
    try:
        if not rest:
            VectorStyle.model_validate(
                {"version": "1.0.0", "kind": "vector", head: value}
            )
        elif head == "label" and rest.startswith(("halo.", "font.")):
            sub, key = rest.split(".")
            (Halo if sub == "halo" else Font).model_validate({key: value})
        elif head in PARTS:
            PARTS[head].model_validate({rest: value})
        elif head == "format":
            NumberFormat.model_validate({rest: value})
        elif head == "zoom":
            stops = {"zoom": [[1, 1], [2, 2]], rest: value}
            if rest == "base":
                stops["interpolate"] = "exponential"
            PARTS["line"].model_validate({"width": stops})
        elif head == "heatmap":
            HeatmapRender.model_validate({"type": "heatmap", rest: value})
        elif head == "cluster":
            ClusterRender.model_validate({"type": "cluster", rest: value})
        elif head == "h3":
            key, _, sub = rest.partition(".")
            H3Render.model_validate({"type": "h3", key: {sub: value} if sub else value})
        elif head == "raster":
            RasterStyle.model_validate(
                {
                    "version": "1.0.0",
                    "kind": "raster",
                    "render": {"type": "image"},
                    rest: value,
                }
            )
        elif head in ("continuous", "hillshade"):
            from goatlib.style.models.raster import ContinuousRender, HillshadeRender

            model = ContinuousRender if head == "continuous" else HillshadeRender
            model.model_validate({"type": head, rest: value})
        elif head == "popup":
            Popup.model_validate({rest: value})
        elif head == "legend":
            Legend.model_validate({rest: value})
        else:
            return False
    except pydantic.ValidationError:
        return False
    return True


def test_every_reference_default_is_a_valid_value_of_its_key() -> None:
    from goatlib.style.defaults import REFERENCE_DEFAULTS

    assert REFERENCE_DEFAULTS
    for path, value in REFERENCE_DEFAULTS.items():
        assert _value_validates(path, value), path


def test_the_schema_carries_the_defaults() -> None:
    from goatlib.style.defaults import REFERENCE_DEFAULTS
    from goatlib.style.schema import json_schema

    assert json_schema()["x-defaults"] == REFERENCE_DEFAULTS
    assert REFERENCE_DEFAULTS["fill.color"] == "#2bb381"
    assert REFERENCE_DEFAULTS["cluster.cluster_until_zoom"] == 14
    assert REFERENCE_DEFAULTS["marker.fill"] is True


def test_label_text_and_outline_position_defaults_draw_as_maplibre_does() -> None:
    from goatlib.style.defaults import REFERENCE_DEFAULTS

    assert REFERENCE_DEFAULTS["label.transform"] == "none"
    assert REFERENCE_DEFAULTS["label.letter_spacing"] == 0
    assert REFERENCE_DEFAULTS["label.line_height"] == 1.2
    assert REFERENCE_DEFAULTS["label.font.style"] == "normal"
    # MapLibre's own: a line label repeats every 250 px, 2 px stay free around each label.
    assert REFERENCE_DEFAULTS["label.spacing"] == 250
    assert REFERENCE_DEFAULTS["label.padding"] == 2
    assert REFERENCE_DEFAULTS["outline.position"] == "center"


def test_raster_render_defaults_follow_the_reference() -> None:
    from goatlib.style.defaults import REFERENCE_DEFAULTS

    assert REFERENCE_DEFAULTS["hillshade.direction"] == 315
    assert REFERENCE_DEFAULTS["hillshade.altitude"] == 45
    assert REFERENCE_DEFAULTS["hillshade.exaggeration"] == 0.5
    assert REFERENCE_DEFAULTS["hillshade.shadow_color"] == "#000000"
    assert REFERENCE_DEFAULTS["hillshade.highlight_color"] == "#ffffff"
    assert REFERENCE_DEFAULTS["continuous.palette"] == "goat:elevation"
    assert REFERENCE_DEFAULTS["continuous.outside"] == "clamp"


def test_image_render_popup_is_off_by_default() -> None:
    from goatlib.style import defaults

    # Spec 9.7: colour scales open a popup on click, images (and so map services) none.
    assert defaults.RASTER_POPUP_ON_BY_DEFAULT == (
        "continuous",
        "categorical",
        "hillshade",
    )
    # One rule: the list, which the web reads through the schema (`x-raster-popup-on`).
    assert not hasattr(defaults, "default_raster_popup")
