"""Every style goatlib writes by hand says the version its keys need (spec 14):
a hand-written "1.0.0" must never claim less once `SINCE` has entries."""

from typing import Any

import pytest
from goatlib.style.catalog import palettes
from goatlib.style.context import DataContext
from goatlib.style.convert_v0 import convert_v0
from goatlib.style.defaults import default_style
from goatlib.style.migrate import migrate_style
from goatlib.style.parse import parse_for_write
from goatlib.style.version import required_version
from goatlib.tools import style as tool_style

GEOMETRIES = ["point", "line", "polygon", None]
POLYGONS = DataContext(kind="vector", geometry="polygon")
POINTS = DataContext(kind="vector", geometry="point")
LINES = DataContext(kind="vector", geometry="line")
RASTER = DataContext(kind="raster")
#: Styles of today's format, as `convert_v0` converts them.
V0: list[tuple[str, dict[str, Any], DataContext]] = [
    ("points", {"color": [230, 85, 13], "radius": 6, "filled": True}, POINTS),
    (
        "labels",
        {"text_label": {"field": "name", "size": 14, "offset": [0, 1.5]}},
        POINTS,
    ),
    ("lines", {"stroke_color": [0, 0, 255], "stroke_width": 3}, LINES),
    (
        "classes",
        {
            "color": [102, 194, 165],
            "filled": True,
            "opacity": 0.8,
            "color_field": {"name": "pop", "type": "number"},
            "color_scale": "quantile",
            "color_range": {
                "name": "Custom",
                "colors": ["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"],
            },
            "color_scale_breaks": {"breaks": [10, 20, 30, 40], "min": 0, "max": 50},
        },
        POLYGONS,
    ),
    ("image", {"style": {"style_type": "image", "brightness_min": 0.2}}, RASTER),
    (
        "hillshade",
        {"style": {"style_type": "hillshade", "azimuth": 315, "altitude": 45}},
        RASTER,
    ),
    ("nothing", {}, POLYGONS),
]
PALETTES: list[Any] = [
    *palettes(),
    tool_style.EMRLD,
    tool_style.TEAL,
    tool_style.SUNSET,
]


def _written() -> list[tuple[str, dict[str, Any]]]:
    docs: list[tuple[str, dict[str, Any]]] = [
        ("default raster", default_style(DataContext(kind="raster"), seed="r"))
    ]
    for geometry in GEOMETRIES:
        ctx = DataContext(kind="vector", geometry=geometry)  # type: ignore[arg-type]
        docs.append((f"default {geometry}", default_style(ctx, seed="v")))
        docs.append((f"styled {geometry}", tool_style.styled(geometry, seed="v")))
    for i, palette in enumerate(PALETTES):
        for geometry in ("point", "line", "polygon"):
            docs.append(
                (
                    f"classified {i} {geometry}",
                    tool_style.classified("v", palette, geometry),
                )
            )
            docs.append(
                (
                    f"categories {i} {geometry}",
                    tool_style.categories("v", [1, 2, 3], palette, geometry),
                )
            )
    # The symbols tools lay over the builders.
    docs += [
        (
            "geocoding",
            tool_style.styled(
                "point",
                {
                    "marker": {"color": "#3b82f6", "size": 12},
                    "outline": {"color": "#ffffff", "width": 2},
                },
            ),
        ),
        (
            "origin destination",
            tool_style.classified(
                "weight",
                "colorbrewer:OrRd",
                "line",
                count=5,
                symbol={
                    "line": {
                        "opacity": 0.8,
                        "width": {"field": "weight", "range": [1, 10]},
                    }
                },
            ),
        ),
        (
            "clusters",
            tool_style.categories(
                "cluster_id",
                [0, 1],
                tool_style.SUNSET,
                "point",
                symbol={"marker": {"size": 16, "opacity": 0.6}},
            ),
        ),
        ("oev classes", tool_style.oev_gueteklassen_style()),
        ("oev stations", tool_style.oev_gueteklassen_stations_style()),
        ("starting points", tool_style.starting_points_style()),
    ]
    for name, properties, ctx in V0:
        docs.append((f"converted {name}", convert_v0(properties, ctx).document))
    for bundle, role in [*tool_style.BUNDLE_ROLE_SYMBOLS, ("street_network", "x")]:
        for geometry in ("point", "line", "polygon"):
            docs.append(
                (
                    f"bundle {bundle} {role} {geometry}",
                    tool_style.bundle_role_style(bundle, role, geometry, seed="b"),
                )
            )
    return docs


@pytest.mark.parametrize("doc", [pytest.param(d, id=n) for n, d in _written()])
def test_a_written_style_says_the_version_its_keys_need(doc: dict[str, Any]) -> None:
    model, issues = parse_for_write(doc)
    assert model is not None, issues
    assert doc["version"] == required_version(model)


def test_a_converted_style_says_the_version_its_keys_need(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`convert_v0` and `migrate_style` stamp what they convert: a key a later
    version added raises it, a style without it stays 1.0.0."""
    from goatlib.style import version

    monkeypatch.setattr(version, "SPEC_VERSION", "1.2.0")
    monkeypatch.setattr(version, "SINCE", {"VectorStyle.symbol": "1.2.0"})
    points = {"color": [230, 85, 13], "radius": 6, "filled": True}
    assert convert_v0(points, POINTS).document["version"] == "1.2.0"
    migrated = migrate_style(points, POINTS, fingerprint=None, at="", seed="L")
    assert not migrated.fell_back and migrated.document["version"] == "1.2.0"
    image = {"style": {"style_type": "image"}}
    assert convert_v0(image, RASTER).document["version"] == "1.0.0"
