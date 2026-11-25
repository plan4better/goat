"""Where a project layer is used besides the map: dashboard widgets,
workflows, print layouts and custom basemaps, read from what core stores and
said in one sentence."""

import copy
from typing import Any

from assistant.maps.uses import INCOMPLETE, Uses, layer_uses
from evals.map_fixture import MAP_BUILDER_CONFIG, MAP_REPORT_LAYOUT, MAP_WORKFLOW


def _workflow(name: str, link: int) -> dict[str, Any]:
    found = copy.deepcopy(MAP_WORKFLOW)
    found["name"] = name
    found["config"]["nodes"][0]["data"]["projectLayerId"] = link
    return found


def _layout(name: str, config: dict[str, Any]) -> dict[str, Any]:
    return {"id": name, "name": name, "config": config}


def _basemap(name: str, targets: list[str], kind: str = "vector") -> dict[str, Any]:
    return {
        "id": name,
        "name": name,
        "type": kind,
        "layer_config": {
            f"layer-{n}": {"visible": True, "relation": "below", "target": target}
            for n, target in enumerate(targets)
        },
    }


def test_uses_are_found_in_dashboard_workflows_layouts_and_custom_basemaps() -> None:
    uses = layer_uses(
        39,
        builder_config=MAP_BUILDER_CONFIG,
        workflows=[MAP_WORKFLOW],
        layouts=[MAP_REPORT_LAYOUT],
        custom_basemaps=[],
    )
    assert uses == Uses(
        dashboard_widgets=1,
        workflows=("Boundary check",),
        layouts=("Overview",),
        basemaps=(),
    )
    assert uses.sentence() == (
        'It is used in the dashboard (1 widget), the workflow "Boundary check" '
        'and the print layout "Overview".'
    )

    # A widget that names the layer twice counts once; one that names it in
    # a list of layers counts; a search setting outside the widgets does not.
    builder = copy.deepcopy(MAP_BUILDER_CONFIG)
    widgets = builder["interface"][0]["widgets"]
    widgets[0]["config"]["options"]["legend_hidden_layers"] = [39]
    widgets.append(
        {
            "id": "widget-layers",
            "type": "widget",
            "config": {"type": "layers", "options": {"downloadable_layers": [31, 39]}},
        }
    )
    widgets.append({"id": "widget-other", "type": "widget", "config": {"x": 39}})
    builder["settings"] = {"search": {"layers": [{"layer_project_id": 39}]}}
    many = layer_uses(
        39,
        builder_config=builder,
        workflows=[_workflow(f"Check {n}", 39) for n in range(5)]
        + [_workflow("Other", 31)],
        layouts=[
            MAP_REPORT_LAYOUT,
            _layout(
                "Atlas",
                {
                    "atlas": {
                        "enabled": True,
                        "coverage": {"type": "feature", "layer_project_id": 39},
                    }
                },
            ),
            # Not locked: the map draws the project's layers as they are.
            _layout(
                "Unlocked",
                {
                    "elements": [
                        {
                            "type": "map",
                            "config": {"lock_layers": False, "locked_layer_ids": [39]},
                        }
                    ]
                },
            ),
            # A switched-off atlas does not iterate over the layer.
            _layout(
                "Off",
                {
                    "atlas": {
                        "enabled": False,
                        "coverage": {"type": "feature", "layer_project_id": 39},
                    }
                },
            ),
        ],
        custom_basemaps=[
            _basemap("Streets", ["39", "all"]),
            _basemap("Everything", ["all"]),
            _basemap("Number", ["390"]),
        ],
    )
    assert many.dashboard_widgets == 2
    assert many.workflows == tuple(f"Check {n}" for n in range(5))
    assert many.layouts == ("Overview", "Atlas")
    assert many.basemaps == ("Streets",)
    assert many.sentence() == (
        'It is used in the dashboard (2 widgets), the workflows "Check 0", '
        '"Check 1", "Check 2" and 2 more, the print layouts "Overview" and '
        '"Atlas" and the custom basemap "Streets".'
    )


def test_a_layer_used_nowhere_has_an_empty_sentence() -> None:
    uses = layer_uses(
        32,
        builder_config=MAP_BUILDER_CONFIG,
        workflows=[MAP_WORKFLOW],
        layouts=[MAP_REPORT_LAYOUT],
        custom_basemaps=None,
    )
    assert uses == Uses(dashboard_widgets=0, workflows=(), layouts=(), basemaps=())
    assert uses.sentence() == ""
    # Nothing stored reads as nothing used.
    empty = layer_uses(
        39, builder_config=None, workflows=[], layouts=[], custom_basemaps=None
    )
    assert empty.sentence() == ""


def test_a_list_that_could_not_be_read_is_said_so() -> None:
    uses = layer_uses(
        39,
        builder_config=MAP_BUILDER_CONFIG,
        workflows=None,
        layouts=[MAP_REPORT_LAYOUT],
        custom_basemaps=[],
    )
    assert not uses.complete and uses.workflows == ()
    assert uses.sentence() == (
        'It is used in the dashboard (1 widget) and the print layout "Overview". '
        + INCOMPLETE
    )
    assert INCOMPLETE == "Where it is used could not be read in full."
    nothing = layer_uses(
        32, builder_config=None, workflows=None, layouts=None, custom_basemaps=None
    )
    assert nothing.sentence() == INCOMPLETE


def test_odd_stored_values_are_read_as_nothing() -> None:
    uses = layer_uses(
        39,
        builder_config={
            "interface": [{"widgets": ["text", {"config": {"layer_project_id": True}}]}]
        },
        workflows=[{"name": "Broken", "config": {"nodes": [None, {"data": "x"}]}}, "x"],
        layouts=[{"name": "Broken", "config": {"elements": "x", "atlas": None}}],
        custom_basemaps=[{"name": "Broken", "layer_config": None}, "x"],
    )
    assert uses.sentence() == ""
