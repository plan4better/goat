import pytest
from goatlib.style.context import DataContext
from goatlib.style.defaults import default_style
from goatlib.style.validate import validate


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


def test_the_seed_picks_the_color() -> None:
    ctx = DataContext(kind="vector", geometry="polygon")
    colors = {
        default_style(ctx, seed=f"layer-{n}")["symbol"]["fill"]["color"]
        for n in range(40)
    }
    assert len(colors) > 3


def test_new_layers_never_get_the_pale_spectral_colors() -> None:
    # The light yellows and greens of Spectral are hard to see on a light basemap.
    pale = {"#fee08b", "#ffffbf", "#e6f598", "#abdda4"}
    ctx = DataContext(kind="vector", geometry="polygon")
    colors = {
        default_style(ctx, seed=f"layer-{i}")["symbol"]["fill"]["color"].lower()
        for i in range(400)
    }
    assert colors == {
        "#9e0142",
        "#d53e4f",
        "#f46d43",
        "#fdae61",
        "#66c2a5",
        "#3288bd",
        "#5e4fa2",
    }
    assert not colors & pale


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
