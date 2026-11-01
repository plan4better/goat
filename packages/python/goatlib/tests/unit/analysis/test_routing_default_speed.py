"""The speed a routed run uses when its params name none.

The form fills the speed field from `default_by_field` (walking 5, bicycle 15,
pedelec 23), so a run built anywhere else (a workflow drafted by the assistant,
a template, the API) arrives with `speed=None`. The engine reads 0.0 as "not
set": catchment refuses it, and the matrix divides by it, so every edge becomes
unreachable. These tests build the engine config with a stand-in for the C++
module and check the speed the engine would see, and that the form's default
and the tool's fallback are one value.
"""

from types import SimpleNamespace
from typing import Any

import pytest
from goatlib.analysis.accessibility.catchment_area_v2 import CatchmentAreaToolV2
from goatlib.analysis.accessibility.heatmap_v2 import HeatmapV2Tool
from goatlib.analysis.accessibility.huff_model_v2 import HuffmodelV2Tool
from goatlib.analysis.accessibility.travel_cost_matrix import TravelCostMatrixTool
from goatlib.analysis.schemas.catchment_area_v2 import (
    DEFAULT_SPEED_KMH,
    LEG_DEFAULT_SPEED_KMH,
    CatchmentAreaV2Params,
)
from goatlib.analysis.schemas.heatmap import HuffmodelV2Params
from goatlib.analysis.schemas.heatmap_v2 import HeatmapV2Params
from goatlib.analysis.schemas.travel_cost_matrix import TravelCostMatrixParams
from goatlib.tools.registry import TOOL_REGISTRY

FORM_SPEEDS = {"walking": 5, "bicycle": 15, "pedelec": 23}
FORM_LEG_SPEEDS = {"walk": 5, "bicycle": 15, "pedelec": 23}


class _Names:
    """Stands in for the engine's enums: every member is its own name."""

    def __getattr__(self, name: str) -> str:
        return name


def _routing() -> SimpleNamespace:
    names = _Names()
    return SimpleNamespace(
        RoutingMode=names,
        CostType=names,
        CatchmentType=names,
        OutputFormat=names,
        ShapeStyle=names,
        HeatmapType=names,
        GravityDecay=names,
        TwoSFCAType=names,
        Point3857=lambda x, y: (x, y),
        Opportunity=lambda *args: args,
        RequestConfig=SimpleNamespace,
        MatrixConfig=SimpleNamespace,
        HeatmapConfig=SimpleNamespace,
    )


def _catchment_config(monkeypatch: pytest.MonkeyPatch, **params: Any) -> Any:
    monkeypatch.setattr(
        CatchmentAreaToolV2, "_get_routing_module", staticmethod(_routing)
    )
    tool = CatchmentAreaToolV2()
    try:
        return tool._build_request_config(
            CatchmentAreaV2Params(
                latitude=48.137, longitude=11.576, output_path="out.parquet", **params
            )
        )
    finally:
        tool.cleanup()


def _matrix_config(monkeypatch: pytest.MonkeyPatch, **params: Any) -> Any:
    monkeypatch.setattr(
        TravelCostMatrixTool, "_get_routing_module", staticmethod(_routing)
    )
    tool = TravelCostMatrixTool()
    try:
        return tool._build_matrix_config(
            TravelCostMatrixParams(
                origin_latitude=[48.137],
                origin_longitude=[11.576],
                destination_latitude=[48.14],
                destination_longitude=[11.58],
                output_path="out.parquet",
                **params,
            )
        )
    finally:
        tool.cleanup()


def _heatmap_config(monkeypatch: pytest.MonkeyPatch, **params: Any) -> Any:
    monkeypatch.setattr(HeatmapV2Tool, "_get_routing_module", staticmethod(_routing))
    tool = HeatmapV2Tool()
    try:
        return tool._build_heatmap_cfg(
            HeatmapV2Params(
                output_path="out.parquet",
                opportunities=[{"input_path": "opps.parquet", "max_cost": 15}],
                **params,
            ),
            [],
            300000.0,
            "out.parquet",
        )
    finally:
        tool.cleanup()


def _huff_config(monkeypatch: pytest.MonkeyPatch, **params: Any) -> Any:
    """The matrix config Huff's street OD step hands the engine."""
    recorded: list[Any] = []
    routing = _routing()
    routing.compute_travel_cost_matrix = recorded.append
    monkeypatch.setattr(
        HuffmodelV2Tool, "_get_routing_module", staticmethod(lambda: routing)
    )
    tool = HuffmodelV2Tool()
    try:
        for table in ("demand", "opps"):
            tool.con.execute(
                f"CREATE TABLE {table} AS SELECT 1 AS orig_cell, 1 AS dest_cell, "
                "0.0 AS cx, 0.0 AS cy"
            )
        tool._compute_od_street(
            "opps",
            "demand",
            HuffmodelV2Params(
                reference_area_path="area.parquet",
                demand_path="demand.parquet",
                demand_field="d",
                opportunity_path="opps.parquet",
                attractivity="a",
                output_path="out.parquet",
                **params,
            ),
            "od.parquet",
            routing,
        )
    finally:
        tool.cleanup()
    [cfg] = recorded
    return cfg


PT = {
    "routing_mode": "pt",
    "transit_modes": ["bus"],
    "time_window": {"from_time": 25200, "to_time": 32400},
}


def test_the_shared_defaults_are_the_forms_speeds() -> None:
    assert dict(DEFAULT_SPEED_KMH) == FORM_SPEEDS
    assert dict(LEG_DEFAULT_SPEED_KMH) == FORM_LEG_SPEEDS


@pytest.mark.parametrize(("mode", "speed"), FORM_SPEEDS.items())
def test_catchment_routes_an_active_mode_at_its_default_speed(
    monkeypatch: pytest.MonkeyPatch, mode: str, speed: int
) -> None:
    cfg = _catchment_config(monkeypatch, routing_mode=mode, cost_type="time")
    assert cfg.speed_km_h == speed


@pytest.mark.parametrize(("mode", "speed"), FORM_SPEEDS.items())
def test_matrix_routes_an_active_mode_at_its_default_speed(
    monkeypatch: pytest.MonkeyPatch, mode: str, speed: int
) -> None:
    cfg = _matrix_config(monkeypatch, routing_mode=mode, cost_type="time")
    assert cfg.speed_km_h == speed


@pytest.mark.parametrize(("mode", "speed"), FORM_SPEEDS.items())
def test_heatmap_routes_an_active_mode_at_its_default_speed(
    monkeypatch: pytest.MonkeyPatch, mode: str, speed: int
) -> None:
    cfg = _heatmap_config(monkeypatch, routing_mode=mode, cost_type="time")
    assert cfg.speed_km_h == speed


@pytest.mark.parametrize(("mode", "speed"), FORM_SPEEDS.items())
def test_huff_routes_an_active_mode_at_its_default_speed(
    monkeypatch: pytest.MonkeyPatch, mode: str, speed: int
) -> None:
    cfg = _huff_config(monkeypatch, routing_mode=mode, cost_type="time")
    assert cfg.speed_km_h == speed


def test_a_given_speed_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    assert (
        _catchment_config(monkeypatch, routing_mode="bicycle", speed=12).speed_km_h
        == 12
    )
    assert (
        _matrix_config(monkeypatch, routing_mode="bicycle", speed=12).speed_km_h == 12
    )


@pytest.mark.parametrize(
    "build", [_catchment_config, _matrix_config, _heatmap_config, _huff_config]
)
def test_car_takes_no_speed(monkeypatch: pytest.MonkeyPatch, build: Any) -> None:
    """Car follows each edge's OSM maxspeed; 0.0 tells the engine so."""
    assert build(monkeypatch, routing_mode="car", max_cost=30).speed_km_h == 0.0


@pytest.mark.parametrize("build", [_catchment_config, _matrix_config])
@pytest.mark.parametrize(("mode", "speed"), FORM_LEG_SPEEDS.items())
def test_a_pt_leg_routes_at_its_modes_default_speed(
    monkeypatch: pytest.MonkeyPatch, build: Any, mode: str, speed: int
) -> None:
    cfg = build(monkeypatch, **PT, max_cost=30, access_mode=mode, egress_mode=mode)
    assert (cfg.access_speed_km_h, cfg.egress_speed_km_h) == (speed, speed)


def _speed_fields() -> list[tuple[str, str, dict[str, Any]]]:
    """Every registered tool's speed field that takes its default from a mode."""
    found = []
    for definition in TOOL_REGISTRY:
        properties = definition.get_params_class().model_json_schema()["properties"]
        for name, schema in properties.items():
            options = (schema.get("x-ui") or {}).get("widget_options") or {}
            by_field = options.get("default_by_field")
            if name.endswith("speed") and by_field:
                found.append((definition.name, name, by_field))
    return found


def test_every_routing_tool_offers_a_mode_default_speed() -> None:
    tools = {tool for tool, _, _ in _speed_fields()}
    assert tools >= {
        "catchment_area_v2",
        "heatmap_gravity",
        "heatmap_closest_average",
        "heatmap_connectivity",
        "heatmap_2sfca",
        "huff_model",
        "travel_cost_matrix",
    }


@pytest.mark.parametrize(
    ("tool", "name", "by_field"),
    _speed_fields(),
    ids=lambda value: value if isinstance(value, str) else "",
)
def test_the_form_offers_the_speed_the_tool_falls_back_to(
    tool: str, name: str, by_field: dict[str, Any]
) -> None:
    shared = (
        LEG_DEFAULT_SPEED_KMH
        if by_field["field"] != "routing_mode"
        else DEFAULT_SPEED_KMH
    )
    assert by_field["values"] == {str(mode): speed for mode, speed in shared.items()}
