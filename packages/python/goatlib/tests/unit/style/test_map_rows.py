"""The map document from plain rows, and the layers it draws."""

from goatlib.style.map_rows import (
    GroupRow,
    LayerRow,
    build_map_document,
    drawn_layers,
    map_view,
)


def layer(
    id: int, order: int, group: int | None = None, visible: bool = True
) -> LayerRow:
    return LayerRow(id, group, order, visible, "top", None, None, True, None)


def test_drawn_layers_are_top_first_and_skip_hidden_layers_and_groups() -> None:
    document = build_map_document(
        basemap=None,
        locale=None,
        view_state=None,
        bounds=None,
        groups=[
            GroupRow(10, "Open", None, 1, True, True),
            GroupRow(20, "Hidden", None, 2, False, True),
            GroupRow(30, "Inner", 10, 1, True, False),
        ],
        layers=[
            layer(1, 0),
            layer(2, 0, group=10),
            layer(3, 0, group=30),
            layer(4, 0, group=20),
            layer(5, 3, visible=False),
            layer(6, 4),
        ],
    )
    assert [entry["id"] for entry in drawn_layers(document)] == [1, 2, 3, 6]


def test_old_documents_unchanged() -> None:
    document = build_map_document(
        basemap="light",
        locale=None,
        view_state={
            "latitude": 48.1,
            "longitude": 11.5,
            "zoom": 12,
            "pitch": 0,
            "bearing": 0,
        },
        bounds=None,
        groups=[],
        layers=[],
    )
    assert "scene" not in document and "mode" not in document["view"]
    assert "projection" not in document["view"]


def test_map_view_copies_mode_projection_and_scene() -> None:
    state = {
        "latitude": 48.1,
        "longitude": 11.5,
        "zoom": 15.5,
        "pitch": 55.0,
        "bearing": 340.0,
        "mode": "3d",
        "projection": "globe",
    }
    assert map_view(state, None) == {
        "center": [11.5, 48.1],
        "zoom": 15.5,
        "pitch": 55.0,
        "bearing": 340.0,
        "mode": "3d",
        "projection": "globe",
    }
    scene = {"terrain": {"exaggeration": 1.5}, "buildings": False}
    document = build_map_document(
        basemap=None,
        locale=None,
        view_state=state,
        bounds=None,
        groups=[],
        layers=[],
        scene=scene,
    )
    assert document["scene"] == scene
