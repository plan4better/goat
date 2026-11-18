"""The value forms the style panel writes for a height (spec 3.6) and for values by zoom
holding values by attribute (4.4): goatlib takes each one, and the server computes
the domains of the attribute forms among them."""

from typing import Any

import pytest
from goatlib.style.compute import needed_stats
from goatlib.style.validate import validate

V = {"version": 1, "kind": "vector"}

DENSITY = {"field": "density", "range": [0, 300]}

#: Every form of the Height and Base height rows.
HEIGHT_FORMS: list[Any] = [
    20,
    {"zoom": [[12, 0], [16, 40]]},
    DENSITY,
    {**DENSITY, "scale": "sqrt"},
    {"field": "population"},
    {"zoom": [[12, DENSITY], [16, {**DENSITY, "range": [0, 600]}]]},
]


def _errors(doc: dict[str, Any], ctx: Any) -> list[tuple[str, str]]:
    return [(i.code, i.path) for i in validate(doc, ctx) if i.level == "error"]


@pytest.mark.parametrize("key", ["height", "base"])
@pytest.mark.parametrize("form", HEIGHT_FORMS, ids=str)
def test_height_and_base_take_every_form_the_panel_writes(
    key: str, form: Any, contexts: dict
) -> None:
    extrude = {"height": 400, key: form} if key == "base" else {key: form}
    doc = {**V, "symbol": {"fill": {}, "extrude": extrude}}
    assert _errors(doc, contexts["districts"]) == []


@pytest.mark.parametrize("target", ["extrude.height", "extrude.base"])
def test_a_classification_sets_the_height_or_the_base(
    target: str, contexts: dict
) -> None:
    doc = {
        **V,
        "symbol": {"fill": {}, "extrude": {"height": 60}},
        "classify": [
            {
                "field": "density",
                "method": "quantile",
                "count": 3,
                "target": target,
                "range": [0, 50],
            }
        ],
    }
    assert _errors(doc, contexts["districts"]) == []


def test_the_server_computes_the_domain_of_a_height_by_attribute() -> None:
    doc = {
        **V,
        "symbol": {
            "extrude": {
                "height": DENSITY,
                "base": {"field": "area_km2", "range": [0, 5], "scale": "sqrt"},
            }
        },
    }
    assert needed_stats(doc) == [("range", "density"), ("range", "area_km2", "sqrt")]


SIZE_STOPS = {
    "zoom": [
        [11, {"field": "pupils", "range": [3, 10], "scale": "sqrt"}],
        [16, {"field": "pupils", "range": [6, 20], "scale": "sqrt"}],
    ]
}


def test_values_by_attribute_inside_zoom_stops_validate(contexts: dict) -> None:
    doc = {**V, "symbol": {"marker": {"color": "#1a6b4d", "size": SIZE_STOPS}}}
    assert _errors(doc, contexts["schools"]) == []
    color = {
        "zoom": [
            [11, {"field": "pupils", "palette": "d3:viridis"}],
            [16, {"field": "pupils", "palette": "d3:magma"}],
        ]
    }
    doc = {**V, "symbol": {"marker": {"color": color}}}
    assert _errors(doc, contexts["schools"]) == []


def test_the_server_computes_the_domains_inside_zoom_stops() -> None:
    doc = {**V, "symbol": {"marker": {"size": SIZE_STOPS}}}
    assert needed_stats(doc) == [("range", "pupils", "sqrt")]
