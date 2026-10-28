"""The map document from plain rows, and the layers it draws."""

from goatlib.style.map_rows import GroupRow, LayerRow, build_map_document, drawn_layers


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
