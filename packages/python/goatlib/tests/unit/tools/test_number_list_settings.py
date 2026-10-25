"""Every list of numbers a tool takes says what its values mean and is checked
for it. Such a list runs without an error whatever it holds: a catchment's
step_sizes [5, 5, 5] meant as three bands of five minutes drew all three rings
at five minutes. A new list fails here until it is classified below."""

import importlib
import types
import typing
from collections.abc import Iterator
from typing import Any

import pytest
from goatlib.tools.registry import TOOL_REGISTRY
from pydantic import BaseModel, ValidationError

U = "00000000-0000-0000-0000-000000000001"
POINTS = {"latitude": [48.137], "longitude": [11.576]}

#: (tool, setting) -> a config the tool must refuse, as a list of that kind
#: holds a value it must not: band edges that do not rise, a distance twice.
CHECKED: dict[tuple[str, str], dict[str, Any]] = {
    ("catchment_area_v2", "step_sizes"): {
        "user_id": U,
        "folder_id": U,
        "routing_mode": "walking",
        "starting_points": POINTS,
        "max_cost": 15,
        "steps": 3,
        "step_sizes": [5, 5, 5],
    },
    ("buffer", "distances"): {
        "user_id": U,
        "folder_id": U,
        "input_layer_id": U,
        "distances": [500, 500],
    },
}
#: Lists no workflow step sets by hand: ids and page numbers the app fills in,
#: the coordinates of points picked on the map, and a hidden configuration.
UNCHECKED = {
    ("print_report", "atlas_page_indices"),
    ("layer_copy", "layer_project_ids"),
    ("catchment_area_v2", "starting_points.latitude"),
    ("catchment_area_v2", "starting_points.longitude"),
    ("oev_gueteklassen", "station_config.time_frequency"),
}


def _number_list(annotation: Any) -> bool:
    origin = typing.get_origin(annotation)
    if origin is list:
        (item,) = typing.get_args(annotation) or (None,)
        numbers = set(typing.get_args(item))
        return item in (int, float) or (bool(numbers) and numbers <= {int, float})
    if origin in (typing.Union, types.UnionType):
        return any(_number_list(arg) for arg in typing.get_args(annotation))
    return False


def _models(annotation: Any) -> Iterator[type[BaseModel]]:
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        yield annotation
    for arg in typing.get_args(annotation):
        yield from _models(arg)


def _lists(model: type[BaseModel], seen: set[type[BaseModel]]) -> Iterator[str]:
    """The number lists of ``model`` and of the models its settings hold."""
    if model in seen:
        return
    seen.add(model)
    for name, field in model.model_fields.items():
        if _number_list(field.annotation):
            yield name
        for nested in _models(field.annotation):
            yield from (f"{name}.{inner}" for inner in _lists(nested, seen))


def _params(tool_name: str) -> type[BaseModel]:
    tool = next(tool for tool in TOOL_REGISTRY if tool.name == tool_name)
    model: type[BaseModel] = getattr(
        importlib.import_module(tool.module_path), tool.params_class_name
    )
    return model


FOUND = sorted(
    (tool.name, name)
    for tool in TOOL_REGISTRY
    for name in _lists(_params(tool.name), set())
)


def test_every_number_list_is_classified() -> None:
    unclassified = [
        found for found in FOUND if found not in CHECKED and found not in UNCHECKED
    ]
    assert unclassified == [], (
        "Say what these lists hold, check it in the tool, and add them to CHECKED "
        "(or to UNCHECKED when no workflow step sets them by hand)."
    )
    assert set(CHECKED) | UNCHECKED <= set(FOUND), "a classified list no longer exists"


@pytest.mark.parametrize(
    ("tool_name", "setting"), sorted(CHECKED), ids="{0[0]}.{0[1]}".format
)
def test_a_checked_list_refuses_what_it_must_not_hold(
    tool_name: str, setting: str
) -> None:
    with pytest.raises(ValidationError) as refused:
        _params(tool_name)(**CHECKED[(tool_name, setting)])
    assert setting in str(refused.value) or "distance" in str(refused.value)
