"""A promoted catalog item's default style (spec 10, 17): the style asset it
publishes as a GOAT Style document, else GOAT's default."""

import json
from typing import Any

import pytest
from goatlib.catalog.item import item_style
from goatlib.catalog.promote import catalog_default_style
from goatlib.style.context import DataContext
from goatlib.style.validate import validate

pytestmark = pytest.mark.unit

GREENS = ["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"]
V0 = {
    "color": [102, 194, 165],
    "filled": True,
    "opacity": 0.8,
    "color_field": {"name": "pop", "type": "number"},
    "color_scale": "quantile",
    "color_range": {"name": "Custom", "colors": GREENS},
    "color_scale_breaks": {"breaks": [10, 20, 30, 40], "min": 0, "max": 50},
}
V1 = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#00aa00"}}}


def item(asset: Any = None, geometry: str | None = "polygon", **extra: Any) -> dict:
    return {
        "id": "src:1",
        "version": "2024-05",
        "goat:geometryType": geometry,
        "assets": {"style": {"href": "../../../styles/a.json"}} if asset else {},
        **extra,
    }


def reader(document: Any) -> Any:
    return lambda key: json.dumps(document).encode()


def test_a_version_0_asset_becomes_a_document_for_the_items_geometry() -> None:
    doc = catalog_default_style(item(V0), seed="L", read_object=reader(V0))
    assert doc is not None and doc["version"] == 1 and "fill" in doc["symbol"]
    [c] = doc["classify"]
    # The publisher computed the classes from this version of the data.
    assert c["computed"]["data"] == "catalog:2024-05"
    ctx = DataContext(kind="vector", geometry="polygon")
    assert [i for i in validate(doc, ctx) if i.level == "error"] == []


def test_a_version_1_asset_is_kept() -> None:
    doc = catalog_default_style(item(V1), seed="L", read_object=reader(V1))
    assert doc == V1


def test_without_an_asset_the_default_and_for_a_table_nothing() -> None:
    doc = catalog_default_style(item(), seed="L", read_object=reader(V1))
    assert doc is not None and "fill" in doc["symbol"]
    table = item(V1, geometry=None, **{"goat:layerType": "table"})
    assert catalog_default_style(table, seed="L", read_object=reader(V1)) is None


def test_the_asset_route_and_promotion_upgrade_alike() -> None:
    upgraded = item_style(V0, item(V0, geometry="point"))
    assert upgraded is not None and "marker" in upgraded["symbol"]
    assert item_style([1, 2], item(V0)) is None


def test_an_asset_that_does_not_validate_gets_the_default() -> None:
    broken = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "nope"}}}
    doc = catalog_default_style(item(broken), seed="L", read_object=reader(broken))
    assert doc is not None and doc["symbol"]["fill"]["color"] != "nope"
    assert item_style(broken, item(broken)) == doc
