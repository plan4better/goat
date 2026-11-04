"""The generated Windmill script passes on only the arguments a job was given.

A setting a job leaves out must reach the parameter model as absent, so that
the model resolves its default from the job's other settings, as the form does
(`default_from`): a car catchment's budget is 30 min, a distance one's 500 m.
When the script's signature carries the model's static default instead (15),
every job without a budget routes 15 min, and a distance job fails the 50 m
floor. These tests run the generated script itself, the job's entry point.
"""

from types import ModuleType
from typing import Any

import pytest
from goatlib.tools.codegen import generate_windmill_script
from goatlib.tools.registry import TOOL_REGISTRY

U = "00000000-0000-0000-0000-000000000001"
IDS = {"user_id": U, "folder_id": U}
POINTS = {"latitude": [48.137], "longitude": [11.576]}
ORIGINS = {
    "origin_layer_id": U,
    "origin_id_column": "id",
    "destination_layer_id": U,
    "destination_id_column": "id",
}


def _definition(name: str) -> Any:
    return next(d for d in TOOL_REGISTRY if d.name == name)


def _job(monkeypatch: pytest.MonkeyPatch, tool: str, **args: Any) -> Any:
    """The parameter model a Windmill job of `tool` builds from `args`."""
    definition = _definition(tool)
    module = __import__(definition.module_path, fromlist=["main"])
    assert isinstance(module, ModuleType)
    monkeypatch.setattr(module, "main", lambda params: params)
    script = generate_windmill_script(
        definition.module_path, definition.get_params_class()
    )
    namespace: dict[str, Any] = {}
    exec(compile(script, f"<{tool} script>", "exec"), namespace)
    return namespace["main"](**args)


def test_an_optional_setting_is_absent_unless_given() -> None:
    definition = _definition("catchment_area_v2")
    script = generate_windmill_script(
        definition.module_path, definition.get_params_class()
    )
    assert "    max_cost: int | None = None," in script
    assert "    access_max_cost: int | None = None," in script
    assert "    steps: int | None = None," in script


@pytest.mark.parametrize(
    ("config", "budget"),
    [
        ({"routing_mode": "walking"}, 15),
        ({"routing_mode": "car"}, 30),
        ({"routing_mode": "walking", "cost_type": "distance"}, 500),
        ({"routing_mode": "car", "cost_type": "distance"}, 5000),
        ({"routing_mode": "pt"}, 30),
    ],
)
def test_a_catchment_job_takes_the_mode_default_budget(
    monkeypatch: pytest.MonkeyPatch, config: dict[str, Any], budget: int
) -> None:
    params = _job(
        monkeypatch, "catchment_area_v2", **IDS, starting_points=POINTS, **config
    )
    assert params.max_cost == budget


def test_a_catchment_job_keeps_the_budget_it_is_given(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    params = _job(
        monkeypatch,
        "catchment_area_v2",
        **IDS,
        starting_points=POINTS,
        routing_mode="car",
        max_cost=12,
    )
    assert params.max_cost == 12


def test_a_catchment_job_takes_the_leg_default_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    params = _job(
        monkeypatch,
        "catchment_area_v2",
        **IDS,
        starting_points=POINTS,
        routing_mode="pt",
        access_cost_type="distance",
    )
    assert (params.access_max_cost, params.egress_max_cost) == (500, 15)


@pytest.mark.parametrize(
    ("tool", "args"),
    [
        (
            "heatmap_connectivity",
            {"reference_area_layer_id": U},
        ),
        (
            "huff_model",
            {
                "reference_area_layer_id": U,
                "demand_layer_id": U,
                "demand_field": "d",
                "opportunity_layer_id": U,
                "attractivity": "a",
            },
        ),
    ],
)
def test_a_car_job_takes_the_car_default_budget(
    monkeypatch: pytest.MonkeyPatch, tool: str, args: dict[str, Any]
) -> None:
    params = _job(monkeypatch, tool, **IDS, routing_mode="car", **args)
    assert params.max_cost == 30


def test_a_matrix_job_takes_the_leg_default_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    params = _job(
        monkeypatch,
        "travel_cost_matrix",
        **IDS,
        **ORIGINS,
        routing_mode="pt",
        egress_cost_type="distance",
    )
    assert (params.access_max_cost, params.egress_max_cost) == (15, 500)
