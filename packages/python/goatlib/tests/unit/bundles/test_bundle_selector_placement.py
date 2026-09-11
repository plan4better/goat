"""Where the bundle selectors sit in the routing tools' advanced settings.

Both selectors belong to the public-transport settings block: they name the
network the journey is routed on, so they follow the transfer limit and come
before the access and egress legs, which are routed on that network. A
selector ordered into one of the leg groups reads as a setting of that leg.
"""

import pytest
from goatlib.tools.registry import TOOL_REGISTRY

ROUTING_TOOLS = (
    "catchment_area_v2",
    "heatmap_gravity",
    "heatmap_closest_average",
    "heatmap_connectivity",
    "heatmap_2sfca",
    "huff_model",
    "travel_cost_matrix",
)

BUNDLE_SELECTORS = ("pt_network_bundle_id", "street_network_bundle_id")


def _ui(tool_name: str) -> dict[str, dict]:
    definition = next(d for d in TOOL_REGISTRY if d.name == tool_name)
    properties = definition.get_params_class().model_json_schema()["properties"]
    return {name: prop["x-ui"] for name, prop in properties.items() if "x-ui" in prop}


def _order(ui: dict[str, dict], name: str) -> int:
    return ui[name]["field_order"]


@pytest.mark.parametrize("tool_name", ROUTING_TOOLS)
@pytest.mark.parametrize("selector", BUNDLE_SELECTORS)
def test_the_selector_follows_the_transfer_limit(tool_name: str, selector: str) -> None:
    ui = _ui(tool_name)
    assert ui[selector]["section"] == ui["pt_max_transfers"]["section"]
    assert _order(ui, selector) > _order(ui, "pt_max_transfers")


@pytest.mark.parametrize("tool_name", ROUTING_TOOLS)
@pytest.mark.parametrize("selector", BUNDLE_SELECTORS)
def test_the_selector_comes_before_the_legs(tool_name: str, selector: str) -> None:
    """The first field of the access-leg group opens it; anything ordered
    after that field renders under the group's heading."""
    ui = _ui(tool_name)
    legs = [
        _order(ui, name)
        for name, meta in ui.items()
        if meta.get("group_label") in ("groups.access_leg", "groups.egress_leg")
    ]
    assert legs, f"{tool_name} has no leg groups"
    assert _order(ui, selector) < min(legs)
