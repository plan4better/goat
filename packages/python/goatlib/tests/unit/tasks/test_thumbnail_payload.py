"""What the thumbnail job sends the thumbnail page (spec 10): every drawn layer
with its active style, top first, and a content hash that follows the look."""

import uuid
from datetime import datetime, timezone
from typing import Any

import pytest
from goatlib.tasks.generate_thumbnails import (
    ItemToProcess,
    layer_payload,
    project_layer_payload,
)

pytestmark = pytest.mark.unit

RED = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#aa0000"}}}
BLUE = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#0000aa"}}}


def link(id: int, order: int, **extra: Any) -> dict[str, Any]:
    return {
        "layer_project_id": id,
        "layer_id": str(uuid.UUID(int=id)),
        "group_id": None,
        "order": order,
        "visible": True,
        "name": f"L{id}",
        "type": "feature",
        "feature_layer_geometry_type": "polygon",
        "url": None,
        "data_type": None,
        "other_properties": None,
        "extent": None,
        "folder_id": None,
        "style": None,
        "default_style": None,
        **extra,
    }


def test_the_payload_carries_active_styles_visibility_and_tree_order() -> None:
    groups = [
        {
            "id": 5,
            "name": "G",
            "parent_id": None,
            "order": 0,
            "visible": False,
            "expanded": True,
        }
    ]
    layers = project_layer_payload(
        groups,
        [
            link(1, 2, style=RED),
            link(2, 1, default_style=BLUE),
            link(3, 3, group_id=5, style=RED),
            link(4, 4, visible=False, style=RED),
            link(5, 0, type="table"),
            link(
                6,
                5,
                type="raster",
                data_type="wms",
                feature_layer_geometry_type=None,
                other_properties={"tile_size": 256, "layers": ["a"], "legend": "x"},
            ),
        ],
    )
    assert [layer["id"] for layer in layers] == [2, 1, 6]
    assert [layer["style"] for layer in layers[:2]] == [BLUE, RED]
    assert all(layer["visible"] for layer in layers)
    assert layers[2]["other_properties"] == {"tile_size": 256, "layers": ["a"]}
    assert layers[2]["style"]["kind"] == "raster"
    assert "properties" not in layers[0]


def test_a_stored_time_slider_value_travels_with_the_layer() -> None:
    """The thumbnail page has no slider: it draws the step the project stored, and
    every time where none is stored."""
    timed = {**RED, "time": {"field": "year", "step": 1}}
    stored = layer_payload(link(1, 0, style=timed, time_value=2016))
    assert stored["entry"] == {"time": {"value": 2016}}
    unset = layer_payload(link(2, 0, style=timed, time_value=None))
    assert "entry" not in unset


def test_a_dataset_without_a_default_row_gets_the_default_style() -> None:
    layer = layer_payload(link(9, 0) | {"layer_project_id": None})
    assert layer["style"]["symbol"]["fill"] and layer["visible"] is True


def item(style: dict[str, Any]) -> ItemToProcess:
    return ItemToProcess(
        type="project",
        id=uuid.UUID(int=1),
        updated_at=datetime.now(timezone.utc),
        old_thumbnail_url=None,
        layers=[layer_payload(link(1, 0, style=style))],
    )


def test_a_stamps_only_recompute_keeps_the_hash() -> None:
    classified = {
        **RED,
        "classify": [
            {
                "field": "v",
                "method": "quantile",
                "count": 2,
                "classes": [{"to": 1}, {"from": 1}],
            }
        ],
    }
    stamped = {
        **classified,
        "classify": [
            {
                **classified["classify"][0],
                "computed": {
                    "at": "2026-10-25T00:00:00Z",
                    "data": "ducklake:2",
                    "scope": "dataset",
                },
            }
        ],
    }
    restamped = {
        **stamped,
        "classify": [
            {
                **stamped["classify"][0],
                "computed": {
                    "at": "2026-10-26T00:00:00Z",
                    "data": "ducklake:3",
                    "scope": "dataset",
                },
            }
        ],
    }
    assert (
        item(stamped).compute_content_hash() == item(restamped).compute_content_hash()
    )


def test_a_style_edit_changes_the_hash() -> None:
    assert item(RED).compute_content_hash() != item(BLUE).compute_content_hash()
