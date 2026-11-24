from typing import Literal, Union

from goatlib.style.models.base import StyleModel
from goatlib.style.models.values import ByAttributeColor
from goatlib.style.parse import parse
from goatlib.style.pointer import parse_pointer, to_pointer
from pydantic import Field, create_model


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


def test_a_key_a_model_refuses_says_why() -> None:
    from goatlib.style.parse import parse_for_write

    raster = {"version": "1.0.0", "kind": "raster"}
    popup = {"trigger": "click", "highlight_active_feature": True}
    _, issues = parse_for_write({**raster, "popup": popup})
    assert ("unknown_key", "/popup/highlight_active_feature") in [
        (i.code, i.path) for i in issues
    ]
    [message] = [i.message for i in issues if i.code == "unknown_key"]
    assert message == "A raster has no feature to highlight."
    ramp = {"type": "continuous", "domain": [0, 9]}
    _, issues = parse_for_write({**raster, "render": ramp, "brightness": 0.2})
    assert [(i.code, i.message) for i in issues] == [
        (
            "unknown_key",
            "brightness, contrast, saturation and hue apply to image renders only.",
        )
    ]
    color = {"field": "x", "palette": "d3:viridis", "revers": True}
    _, issues = parse(ByAttributeColor, color)
    assert [i.message for i in issues] == [
        '"revers" is not a key here. Keys here: field, palette, reverse, scale, '
        "domain, no_data, title, computed."
    ]


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


POINT = {"version": "1.0.0", "kind": "vector", "geometry": "point"}


def test_an_unknown_key_in_a_block_names_the_keys_of_the_blocks_type() -> None:
    from goatlib.style.parse import parse_for_write

    block = {"id": "b1", "type": "text", "text": "Opening hours"}
    _, issues = parse_for_write({**POINT, "popup": {"blocks": [block]}})
    assert [(i.code, i.path, i.message) for i in issues] == [
        (
            "unknown_key",
            "/popup/blocks/b1/text",
            '"text" is not a key here. Keys here: id, type, html.',
        )
    ]


def test_an_unknown_key_in_a_part_names_the_keys_of_the_part() -> None:
    from goatlib.style.parse import parse_for_write

    _, issues = parse_for_write({**POINT, "popup": {"title": "Station"}})
    assert [(i.code, i.path, i.message) for i in issues] == [
        (
            "unknown_key",
            "/popup/title",
            '"title" is not a key here. Keys here: enabled, trigger, mode, blocks, '
            "html, layout, anchor, width, max_height, header, "
            "highlight_active_feature.",
        )
    ]
    # A key the model refuses itself is not named; a key with an alias is
    # named as JSON writes it.
    raster = {"version": "1.0.0", "kind": "raster"}
    _, issues = parse_for_write({**raster, "popup": {"title": "Cell"}})
    [message] = [i.message for i in issues]
    assert "highlight_active_feature" not in message and "bands" in message
    _, issues = parse(Aliased, {"from": 1, "upto": 2})
    assert [i.message for i in issues] == ['"upto" is not a key here. Keys here: from.']


class Aliased(StyleModel):
    from_: int = Field(alias="from")


Wide = create_model(  # type: ignore[call-overload]
    "Wide", __base__=StyleModel, **{f"k{n}": (int | None, None) for n in range(25)}
)


def test_a_long_list_of_keys_is_cut() -> None:
    _, issues = parse(Wide, {"other": 1})
    [message] = [i.message for i in issues]
    keys = ", ".join(f"k{n}" for n in range(20))
    assert message == f'"other" is not a key here. Keys here: {keys} and 5 more.'


class Either(StyleModel):
    value: Union[Item, Literal[False]] | None = None


def test_an_error_inside_one_form_leaves_out_the_forms_the_value_is_not() -> None:
    _, issues = parse(Either, {"value": {"id": "a", "n": "x"}})
    assert [(i.code, i.path) for i in issues] == [("invalid_value", "/value/n")]
    _, issues = parse(Either, {"value": {"id": "a"}})
    assert [(i.code, i.path) for i in issues] == [("missing_required", "/value/n")]


def test_a_value_of_no_form_gets_one_line_naming_the_forms() -> None:
    from goatlib.style.parse import parse_for_write

    _, issues = parse_for_write({**POINT, "popup": 5})
    assert [(i.code, i.path, i.message) for i in issues] == [
        ("invalid_value", "/popup", "Input should be an object or false")
    ]
    _, issues = parse(Either, {"value": "yes"})
    assert [(i.code, i.path, i.message) for i in issues] == [
        ("invalid_value", "/value", "Input should be an object or false")
    ]


class Pair(StyleModel):
    value: Union[Item, Holder, Literal["auto"]]


def test_each_form_is_named_once() -> None:
    _, issues = parse(Pair, {"value": 5})
    assert [(i.code, i.path, i.message) for i in issues] == [
        ("invalid_value", "/value", "Input should be an object or 'auto'")
    ]
