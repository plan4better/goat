from goatlib.style.models.base import StyleModel
from goatlib.style.models.values import ByAttributeColor
from goatlib.style.parse import parse
from goatlib.style.pointer import parse_pointer, to_pointer


class Item(StyleModel):
    id: str
    n: int


class Holder(StyleModel):
    items: list[Item]


def test_unknown_key_path_points_at_the_key() -> None:
    _, issues = parse(
        ByAttributeColor, {"field": "x", "palette": "d3:viridis", "revers": True}
    )
    assert [(i.code, i.path) for i in issues] == [("unknown_key", "/revers")]


def test_missing_required_key() -> None:
    _, issues = parse(ByAttributeColor, {"palette": "d3:viridis"})
    assert [(i.code, i.path) for i in issues] == [("missing_required", "/field")]


def test_list_items_with_ids_are_addressed_by_id() -> None:
    _, issues = parse(Holder, {"items": [{"id": "a", "n": 1}, {"id": "b", "n": "x"}]})
    assert [(i.code, i.path) for i in issues] == [("invalid_value", "/items/b/n")]


def test_items_without_ids_are_addressed_by_index() -> None:
    _, issues = parse(Holder, {"items": [{"n": 1}]})
    assert [(i.code, i.path) for i in issues] == [("missing_required", "/items/0/id")]


def test_pointer_escaping_round_trips() -> None:
    assert (
        to_pointer(["symbol", "a/b", "c~d", "Straße 1"]) == "/symbol/a~1b/c~0d/Straße 1"
    )
    assert parse_pointer("/symbol/a~1b/c~0d/Straße 1") == [
        "symbol",
        "a/b",
        "c~d",
        "Straße 1",
    ]
    assert to_pointer([]) == ""
