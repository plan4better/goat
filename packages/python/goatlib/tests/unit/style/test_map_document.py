from goatlib.style.parse import parse_map_document

from .conftest import codes_of


def test_map_document_example_parses(spec_examples: list) -> None:
    doc = next(e["doc"] for e in spec_examples if e["target"] == "map")
    assert codes_of(parse_map_document(doc)) == []


def test_layer_entries_need_an_id_and_groups_children() -> None:
    doc = {
        "version": 1,
        "layers": [
            {"type": "layer", "visible": True},
            {"type": "group", "name": "G", "children": [{"type": "folder"}]},
        ],
    }
    assert codes_of(parse_map_document(doc)) == ["invalid_value", "missing_required"]


def test_view_takes_mode_and_projection() -> None:
    doc = {
        "version": 1,
        "view": {"pitch": 55, "bearing": 340.5, "mode": "3d", "projection": "globe"},
    }
    assert codes_of(parse_map_document(doc)) == []


def test_view_refuses_unknown_mode_and_steep_pitch() -> None:
    doc = {"version": 1, "view": {"mode": "4d", "pitch": 86}}
    assert codes_of(parse_map_document(doc)) == ["invalid_value", "invalid_value"]
