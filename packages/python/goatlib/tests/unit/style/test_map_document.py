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
