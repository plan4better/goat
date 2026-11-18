"""`arrows.icon` (spec 3.2): any icon along a line or at its ends, GOAT's arrow by default."""

from typing import Any

from goatlib.style.defaults import REFERENCE_DEFAULTS
from goatlib.style.models.parts import PER_LAYER_KEYS, Arrows
from goatlib.style.validate import validate

from .conftest import codes

V = {"version": 1, "kind": "vector"}


def _codes(doc: dict[str, Any], ctx: Any) -> set[str]:
    return {i.code for i in validate(doc, ctx)}


def test_arrows_take_the_icons_markers_take() -> None:
    for ref in ("goat:rail", "emoji:1f525", "asset:7f3a", "goat:arrow"):
        assert codes(Arrows, {"icon": ref}) == []
    assert codes(Arrows, {"icon": "https://x.org/a.svg"}) == ["invalid_value"]


def test_the_arrows_icon_is_one_value_for_the_layer() -> None:
    assert "arrows.icon" in PER_LAYER_KEYS
    by_zoom = {"zoom": [[10, "goat:rail"], [14, "goat:park"]], "interpolate": "step"}
    assert codes(Arrows, {"icon": by_zoom}) == ["value_form_not_allowed"]


def test_goat_arrow_is_the_default() -> None:
    assert REFERENCE_DEFAULTS["arrows.icon"] == "goat:arrow"


def test_the_arrows_icon_names_its_library(contexts: dict) -> None:
    def icon(ref: str) -> set[str]:
        doc = {**V, "symbol": {"line": {}, "arrows": {"icon": ref}}}
        return _codes(doc, contexts["routes"])

    assert icon("goat:rail") == set()
    assert icon("goat:arrow") == set()
    assert icon("emoji:1f525") == set()
    assert icon("asset:7f3a") == set()
    assert icon("goat:no-such-icon") == {"unknown_icon"}
    assert icon("maki:rail") == {"unknown_icon"}


def test_goat_arrow_is_for_arrows_only(contexts: dict) -> None:
    doc = {**V, "symbol": {"marker": {"shape": "icon", "icon": "goat:arrow"}}}
    assert _codes(doc, contexts["schools"]) == {"unknown_icon"}


def test_a_class_cannot_give_its_lines_another_icon(contexts: dict) -> None:
    doc = {
        **V,
        "symbol": {"line": {}, "arrows": {"icon": "goat:rail"}},
        "classify": [
            {
                "field": "status",
                "method": "categories",
                "classes": [{"values": ["planned"], "arrows": {"icon": "goat:park"}}],
            }
        ],
    }
    assert "override_not_per_feature" in _codes(doc, contexts["routes"])


def test_icons_turn_with_the_line_by_default() -> None:
    """`arrows.turn_with_line` (spec 3.2): the icon turns with the line, or stays upright."""
    assert REFERENCE_DEFAULTS["arrows.turn_with_line"] is True
    assert codes(Arrows, {"turn_with_line": False}) == []
    assert codes(Arrows, {"turn_with_line": "no"}) == ["invalid_value"]


def test_turning_with_the_line_is_one_value_for_the_layer(contexts: dict) -> None:
    assert "arrows.turn_with_line" in PER_LAYER_KEYS
    by_zoom = {"zoom": [[10, True], [14, False]], "interpolate": "step"}
    assert codes(Arrows, {"turn_with_line": by_zoom}) != []
    doc = {
        **V,
        "symbol": {"line": {}, "arrows": {"icon": "goat:park", "turn_with_line": False}},
        "classify": [
            {
                "field": "status",
                "method": "categories",
                "classes": [{"values": ["planned"], "arrows": {"turn_with_line": True}}],
            }
        ],
    }
    assert "override_not_per_feature" in _codes(doc, contexts["routes"])
    doc = {**V, "symbol": {"line": {}, "arrows": {"icon": "goat:park", "turn_with_line": False}}}
    assert _codes(doc, contexts["routes"]) == set()
