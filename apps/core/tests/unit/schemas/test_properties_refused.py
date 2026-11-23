"""Writes of layers, project layers and layer groups refuse the key `properties`:
styles and map state are saved through their own routes."""

from typing import Any
from uuid import uuid4

import pytest
from core.schemas.layer import (
    IFeatureStandardUpdate,
    IFeatureStreetNetworkUpdate,
    IFeatureToolUpdate,
    IRasterCreate,
    IRasterUpdate,
)
from core.schemas.project import (
    IFeatureStandardProjectUpdate,
    IFeatureStreetNetworkProjectUpdate,
    IFeatureToolProjectUpdate,
    ILayerProjectGroupCreate,
    ILayerProjectGroupRead,
    ILayerProjectGroupUpdate,
    IRasterProjectUpdate,
    LayerTreeItem,
    LayerTreeUpdate,
)
from core.schemas.properties_refused import PROPERTIES_REFUSED, PropertiesRefused
from fastapi import status
from pydantic import BaseModel

#: Every write model of a layer, a project layer or a layer group that refuses
#: `properties`, with a body it accepts.
WRITES: list[tuple[type[BaseModel], dict[str, Any]]] = [
    (IFeatureStandardProjectUpdate, {"name": "x"}),
    (IFeatureStreetNetworkProjectUpdate, {"name": "x"}),
    (IFeatureToolProjectUpdate, {"name": "x"}),
    (IRasterProjectUpdate, {"name": "x"}),
    (LayerTreeItem, {"id": 1, "type": "layer", "order": 0}),
    (ILayerProjectGroupCreate, {"name": "g"}),
    (ILayerProjectGroupUpdate, {"name": "g"}),
    (IFeatureStandardUpdate, {"name": "x"}),
    (IFeatureToolUpdate, {"name": "x"}),
    (IFeatureStreetNetworkUpdate, {"name": "x"}),
    (IRasterUpdate, {"name": "x"}),
    (
        IRasterCreate,
        {
            "type": "raster",
            "name": "x",
            "url": "https://example.org/x.tif",
            "data_type": "cog",
        },
    ),
]

IDS = [model.__name__ for model, _ in WRITES]


@pytest.mark.parametrize(("model", "body"), WRITES, ids=IDS)
def test_a_write_without_properties_is_accepted(
    model: type[BaseModel], body: dict[str, Any]
) -> None:
    model.model_validate(body)


@pytest.mark.parametrize(("model", "body"), WRITES, ids=IDS)
@pytest.mark.parametrize(
    "value", [{"visibility": False}, None, {}], ids=["style", "null", "empty"]
)
def test_a_write_with_properties_is_refused_with_the_sentence(
    model: type[BaseModel], body: dict[str, Any], value: Any
) -> None:
    with pytest.raises(PropertiesRefused) as refused:
        model.model_validate({**body, "properties": value})
    assert refused.value.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    assert refused.value.detail == PROPERTIES_REFUSED
    assert str(refused.value) == PROPERTIES_REFUSED


@pytest.mark.parametrize(("model", "body"), WRITES, ids=IDS)
def test_a_write_with_another_unknown_key_is_still_accepted(
    model: type[BaseModel], body: dict[str, Any]
) -> None:
    model.model_validate({**body, "colour": "red"})


def test_a_tree_put_with_properties_on_one_item_is_refused() -> None:
    with pytest.raises(PropertiesRefused):
        LayerTreeUpdate.model_validate(
            {
                "items": [
                    {"id": 1, "type": "group", "order": 0},
                    {
                        "id": 2,
                        "type": "layer",
                        "order": 1,
                        "properties": {"visibility": False},
                    },
                ]
            }
        )


def test_a_group_read_built_from_a_row_with_properties_still_loads() -> None:
    """A group row keeps its `properties` column; reading it is no write."""
    read = ILayerProjectGroupRead(
        id=1,
        project_id=uuid4(),
        order=0,
        name="g",
        properties={"visibility": False},
    )
    assert read.name == "g"
    assert "properties" not in read.model_dump()
