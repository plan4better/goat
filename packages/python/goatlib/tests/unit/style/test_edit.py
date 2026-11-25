import copy
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
from goatlib.style.edit import ID_LISTS, Edit, Edited, EditError, apply_edits
from goatlib.style.ids import assign_ids
from goatlib.style.issues import Fix
from goatlib.style.ops import apply_fix
from goatlib.style.pointer import find_index
from pydantic import ValidationError

from .conftest import load_examples

SPEC = Path(__file__).parents[3] / "docs" / "style-spec.md"
CLASSES_COMPUTED = "The server computes the classes of this classification. Write its method and count."

DOC: dict[str, Any] = {
    "version": "1.0.0",
    "kind": "vector",
    "symbol": {"fill": {"color": "#cccccc"}},
    "classify": [
        {
            "id": "density",
            "field": "density",
            "method": "quantile",
            "count": 3,
            "palette": "colorbrewer:OrRd",
            "classes": [
                {"id": "c1", "to": 10, "fill": {"color": "#fee8c8"}},
                {"id": "c2", "from": 10, "to": 20, "fill": {"color": "#fdbb84"}},
                {"id": "c3", "from": 20, "fill": {"color": "#e34a33"}},
            ],
            "computed": {"at": "2026-10-23T10:00:00Z", "data": "sample-v1"},
        },
        {
            "id": "land_use",
            "field": "land_use",
            "method": "categories",
            "count": 2,
            "classes": [
                {"id": "c4", "values": ["park"], "fill": {"color": "#1b9e77"}},
                {"id": "c5", "values": ["water"], "fill": {"color": "#7570b3"}},
            ],
        },
    ],
    "rules": [
        {
            "id": "r1",
            "min_zoom": 12.4,
            "when": {"op": "isNull", "args": [{"property": "name"}]},
            "fill": {"color": "#999999"},
        },
        {
            "id": "r2",
            "when": {"op": ">", "args": [{"property": "population"}, 5000]},
            "outline": {"width": 2},
        },
    ],
}


def edits(*raw: dict[str, Any]) -> list[Edit]:
    return [Edit.model_validate(r) for r in raw]


def run(doc: dict[str, Any], *raw: dict[str, Any]) -> Edited:
    return apply_edits(doc, edits(*raw))


def refused(doc: dict[str, Any], *raw: dict[str, Any]) -> EditError:
    with pytest.raises(EditError) as info:
        run(doc, *raw)
    return info.value


def ids_of(items: list[dict[str, Any]]) -> list[str]:
    return [i["id"] for i in items]


def assert_ids_complete_and_unique(doc: dict[str, Any]) -> None:
    assert assign_ids(doc) == doc
    found: list[str] = []
    stack: list[Any] = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if isinstance(node.get("id"), str):
                found.append(node["id"])
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    assert [i for i, n in Counter(found).items() if n > 1] == []


# set


def test_set_creates_missing_parts() -> None:
    doc = {"version": "1.0.0", "kind": "vector"}
    out = run(doc, {"op": "set", "path": "/symbol/fill/color", "value": "#ff0000"})
    assert out.document == {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {"fill": {"color": "#ff0000"}},
    }
    assert out.added == {}
    assert doc == {"version": "1.0.0", "kind": "vector"}


def test_set_replaces_a_value_and_null_is_a_value() -> None:
    out = run(
        DOC,
        {
            "op": "set",
            "path": "/classify/density/palette",
            "value": "colorbrewer:Blues",
        },
        {"op": "set", "path": "/symbol/fill/opacity", "value": None},
    )
    assert out.document["classify"][0]["palette"] == "colorbrewer:Blues"
    assert out.document["symbol"]["fill"] == {"color": "#cccccc", "opacity": None}


def test_set_does_not_invent_a_list_item() -> None:
    error = refused(
        DOC, {"op": "set", "path": "/classify/nope/palette", "value": "goat:x"}
    )
    assert error.index == 0
    assert "density" in error.reason and "land_use" in error.reason
    assert str(error) == f"Operation 1: {error.reason}"


def test_set_of_a_missing_id_list_item_says_to_use_add() -> None:
    error = refused(DOC, {"op": "set", "path": "/rules/r9", "value": {"min_zoom": 3}})
    assert "r1" in error.reason and "r2" in error.reason
    assert "add" in error.reason


def test_set_does_not_create_an_id_list_on_the_way() -> None:
    doc = {"version": "1.0.0", "kind": "vector"}
    error = refused(
        doc, {"op": "set", "path": "/classify/density/palette", "value": "x"}
    )
    assert "/classify" in error.reason and "add" in error.reason


def test_set_does_not_index_past_the_end_of_another_list() -> None:
    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {"fill": {"color": {"zoom": [[5, "#000000"], [10, "#ffffff"]]}}},
    }
    error = refused(
        doc,
        {"op": "set", "path": "/symbol/fill/color/zoom/2", "value": [12, "#ff0000"]},
    )
    assert "0 to 1" in error.reason
    out = run(
        doc,
        {"op": "set", "path": "/symbol/fill/color/zoom/1", "value": [12, "#ff0000"]},
    )
    assert out.document["symbol"]["fill"]["color"]["zoom"][1] == [12, "#ff0000"]


def test_set_does_not_reach_through_a_value() -> None:
    doc = {"version": "1.0.0", "kind": "vector", "popup": False}
    error = refused(doc, {"op": "set", "path": "/popup/title", "value": "Name"})
    assert "/popup" in error.reason and "false" in error.reason


def test_set_of_an_item_by_id_keeps_the_id_of_the_path() -> None:
    out = run(
        DOC,
        {"op": "set", "path": "/rules/r2", "value": {"id": "other", "min_zoom": 3}},
        {"op": "set", "path": "/rules/r1", "value": {"min_zoom": 4}},
    )
    assert out.document["rules"] == [
        {"id": "r1", "min_zoom": 4},
        {"id": "r2", "min_zoom": 3},
    ]


def test_set_of_a_whole_id_list_completes_the_ids() -> None:
    out = run(
        DOC,
        {
            "op": "set",
            "path": "/rules",
            "value": [{"id": "r1", "min_zoom": 5}, {"max_zoom": 9}],
        },
    )
    assert out.document["rules"] == [
        {"id": "r1", "min_zoom": 5},
        {"max_zoom": 9, "id": "r2"},
    ]


def test_set_refuses_an_id_the_document_uses_elsewhere() -> None:
    error = refused(
        DOC,
        {"op": "set", "path": "/rules", "value": [{"id": "density", "min_zoom": 5}]},
    )
    assert "'density'" in error.reason


# add


def test_add_appends_gives_an_id_and_answers_it() -> None:
    item = {"field": "density", "method": "quantile", "count": 5, "palette": "goat:x"}
    doc = {"version": "1.0.0", "kind": "vector", "classify": []}
    out = run(doc, {"op": "add", "path": "/classify", "item": item})
    assert out.added == {0: "density"}
    assert out.document["classify"] == [{"id": "density", **item}]
    assert doc["classify"] == []


def test_add_creates_the_list_and_names_the_rest_as_assign_ids_does() -> None:
    doc = {"version": "1.0.0", "kind": "vector"}
    out = run(
        doc,
        {"op": "add", "path": "/rules", "item": {"min_zoom": 3}},
        {"op": "add", "path": "/popup/blocks", "item": {"type": "title"}},
        {
            "op": "add",
            "path": "/classify",
            "item": {"field": "type", "method": "categories", "classes": [{}, {}]},
        },
        {"op": "add", "path": "/classify", "item": {"field": "type"}},
    )
    assert out.added == {0: "r1", 1: "b1", 2: "type", 3: "k1"}
    assert ids_of(out.document["classify"][0]["classes"]) == ["c1", "c2"]
    assert out.document["popup"] == {"blocks": [{"type": "title", "id": "b1"}]}


def test_add_after_places_the_item() -> None:
    out = run(
        DOC,
        {"op": "add", "path": "/rules", "item": {"min_zoom": 1}, "after": "r1"},
        {
            "op": "add",
            "path": "/classify/land_use/classes",
            "item": {"values": ["forest"]},
            "after": "c4",
        },
    )
    assert ids_of(out.document["rules"]) == ["r1", "r3", "r2"]
    assert ids_of(out.document["classify"][1]["classes"]) == ["c4", "c6", "c5"]
    assert out.added == {0: "r3", 1: "c6"}


def test_add_after_an_unknown_id_names_the_ids_of_the_list() -> None:
    error = refused(
        DOC, {"op": "add", "path": "/rules", "item": {"min_zoom": 1}, "after": "r7"}
    )
    assert "'r7'" in error.reason and "r1, r2" in error.reason


def test_add_takes_a_free_id_and_refuses_a_taken_one() -> None:
    out = run(DOC, {"op": "add", "path": "/rules", "item": {"id": "quiet"}})
    assert out.added == {0: "quiet"}
    assert out.document["rules"][-1] == {"id": "quiet"}
    error = refused(DOC, {"op": "add", "path": "/rules", "item": {"id": "c4"}})
    assert "'c4'" in error.reason and "taken" in error.reason
    error = refused(DOC, {"op": "add", "path": "/rules", "item": {"id": "Quiet One"}})
    assert "'Quiet One'" in error.reason


def test_add_checks_the_ids_of_nested_items_the_same_way() -> None:
    item = {
        "field": "type",
        "method": "categories",
        "classes": [{"id": "c1", "values": ["a"]}, {"values": ["b"]}],
    }
    error = refused(DOC, {"op": "add", "path": "/classify", "item": item})
    assert "'c1'" in error.reason and "taken" in error.reason
    item["classes"][0]["id"] = "school"
    out = run(DOC, {"op": "add", "path": "/classify", "item": item})
    assert ids_of(out.document["classify"][2]["classes"]) == ["school", "c6"]
    item["classes"][1]["id"] = "school"
    error = refused(DOC, {"op": "add", "path": "/classify", "item": item})
    assert "'school'" in error.reason


def test_add_takes_only_the_path_of_an_id_list() -> None:
    error = refused(DOC, {"op": "add", "path": "/symbol", "item": {"a": 1}})
    for path in ID_LISTS:
        assert path in error.reason


def test_a_later_operation_can_name_an_item_added_earlier() -> None:
    out = run(
        DOC,
        {
            "op": "add",
            "path": "/classify",
            "item": {"field": "type", "method": "categories"},
        },
        {"op": "add", "path": "/classify/type/classes", "item": {"values": ["a"]}},
        {
            "op": "set",
            "path": "/classify/type/classes/c6/fill/color",
            "value": "#000000",
        },
        {"op": "move", "path": "/classify/type", "after": None},
    )
    assert out.added == {0: "type", 1: "c6"}
    assert out.document["classify"][0] == {
        "field": "type",
        "method": "categories",
        "id": "type",
        "classes": [{"values": ["a"], "id": "c6", "fill": {"color": "#000000"}}],
    }


# move and remove


def test_move_first_and_after() -> None:
    doc = copy.deepcopy(DOC)
    doc["rules"].append({"id": "r3"})
    assert ids_of(run(doc, {"op": "move", "path": "/rules/r3"}).document["rules"]) == [
        "r3",
        "r1",
        "r2",
    ]
    out = run(doc, {"op": "move", "path": "/rules/r1", "after": "r2"})
    assert ids_of(out.document["rules"]) == ["r2", "r1", "r3"]
    out = run(
        doc, {"op": "move", "path": "/classify/density/classes/c1", "after": "c3"}
    )
    assert ids_of(out.document["classify"][0]["classes"]) == ["c2", "c3", "c1"]


def test_move_refuses_what_is_not_an_item_of_an_id_list() -> None:
    error = refused(DOC, {"op": "move", "path": "/symbol/fill", "after": None})
    assert "/rules/r1" in error.reason
    error = refused(DOC, {"op": "move", "path": "/rules/r1", "after": "r1"})
    assert "itself" in error.reason
    error = refused(DOC, {"op": "move", "path": "/rules/r1", "after": "c1"})
    assert "r1, r2" in error.reason


def test_remove_of_a_list_item_by_id() -> None:
    out = run(
        DOC,
        {"op": "remove", "path": "/classify/land_use/classes/c4"},
        {"op": "remove", "path": "/rules/r1"},
        {"op": "remove", "path": "/symbol/fill/color"},
    )
    assert ids_of(out.document["classify"][1]["classes"]) == ["c5"]
    assert ids_of(out.document["rules"]) == ["r2"]
    assert out.document["symbol"] == {"fill": {}}


def test_remove_of_a_missing_path_names_what_exists() -> None:
    error = refused(DOC, {"op": "remove", "path": "/symbol/outline"})
    assert "'outline'" in error.reason and "fill" in error.reason
    error = refused(DOC, {"op": "remove", "path": "/rules/r9"})
    assert "r1, r2" in error.reason


# all or none, refusals


def test_all_or_none() -> None:
    before = copy.deepcopy(DOC)
    with pytest.raises(EditError) as info:
        run(
            DOC,
            {"op": "set", "path": "/opacity", "value": 0.5},
            {"op": "remove", "path": "/rules/nope"},
        )
    assert info.value.index == 1
    assert str(info.value).startswith("Operation 2: ")
    assert DOC == before


def test_computed_values_are_refused_with_the_way_to_do_it() -> None:
    bounds = refused(
        DOC, {"op": "set", "path": "/classify/density/classes/c2/to", "value": 12}
    )
    assert bounds.reason == CLASSES_COMPUTED
    assert (
        refused(DOC, {"op": "remove", "path": "/classify/density/classes/c1/to"}).reason
        == CLASSES_COMPUTED
    )
    assert (
        refused(
            DOC,
            {"op": "set", "path": "/classify/land_use/classes/c4/values", "value": []},
        ).reason
        == CLASSES_COMPUTED
    )
    for raw in (
        {"op": "set", "path": "/classify/land_use/classes/c4/values/0", "value": "x"},
        {"op": "remove", "path": "/classify/land_use/classes/c4/values/0"},
    ):
        assert refused(DOC, raw).reason == CLASSES_COMPUTED
    under = refused(
        DOC, {"op": "set", "path": "/classify/density/computed/at", "value": "x"}
    )
    assert "computed" in under.reason
    assert (
        refused(DOC, {"op": "remove", "path": "/classify/density/computed"}).reason
        == under.reason
    )
    raster = {
        "version": "1.0.0",
        "kind": "raster",
        "render": {
            "type": "continuous",
            "classify": {
                "method": "quantile",
                "count": 2,
                "classes": [{"id": "c1", "to": 3}, {"id": "c2", "from": 3}],
            },
        },
    }
    assert (
        refused(
            raster, {"op": "round", "path": "/render/classify/classes/c1/to"}
        ).reason
        == CLASSES_COMPUTED
    )


def test_a_value_that_carries_computed_is_refused_like_a_path_under_it() -> None:
    under = refused(DOC, {"op": "remove", "path": "/classify/density/computed"}).reason
    whole = copy.deepcopy(DOC["classify"])
    assert (
        refused(DOC, {"op": "set", "path": "/classify", "value": whole}).reason == under
    )
    item = {"field": "type", "method": "categories", "computed": {"at": "x"}}
    assert (
        refused(DOC, {"op": "add", "path": "/classify", "item": item}).reason == under
    )


def test_bounds_written_with_a_whole_classification_are_left_to_the_server() -> None:
    item = {
        "field": "population",
        "method": "quantile",
        "count": 2,
        "classes": [{"to": 100}, {"from": 100}],
    }
    out = run(DOC, {"op": "add", "path": "/classify", "item": item})
    assert out.document["classify"][2]["classes"] == [
        {"to": 100, "id": "c6"},
        {"from": 100, "id": "c7"},
    ]


def test_bounds_can_be_moved_once_the_method_is_manual() -> None:
    out = run(
        DOC,
        {"op": "set", "path": "/classify/density/method", "value": "manual"},
        {"op": "set", "path": "/classify/density/classes/c2/to", "value": 12},
    )
    assert out.document["classify"][0]["classes"][1]["to"] == 12


def test_a_classification_on_a_field_named_computed_is_no_computed_value() -> None:
    doc = {"version": "1.0.0", "kind": "vector", "classify": []}
    out = run(
        doc,
        {
            "op": "add",
            "path": "/classify",
            "item": {"field": "computed", "method": "categories"},
        },
        {"op": "set", "path": "/classify/computed/title", "value": "Computed"},
    )
    assert out.document["classify"][0]["title"] == "Computed"


def test_version_and_kind_are_refused() -> None:
    reasons = {
        refused(DOC, {"op": "set", "path": "/version", "value": "2.0.0"}).reason,
        refused(DOC, {"op": "set", "path": "/kind", "value": "raster"}).reason,
        refused(DOC, {"op": "remove", "path": "/version"}).reason,
        refused(DOC, {"op": "remove", "path": "/kind"}).reason,
    }
    assert len(reasons) == 1
    assert "/version" in reasons.pop()


def test_an_items_id_is_not_edited() -> None:
    assert (
        "id" in refused(DOC, {"op": "set", "path": "/rules/r1/id", "value": "x"}).reason
    )
    assert "id" in refused(DOC, {"op": "remove", "path": "/rules/r1/id"}).reason


def test_a_path_is_a_pointer_into_the_document() -> None:
    assert "/" in refused(DOC, {"op": "set", "path": "opacity", "value": 1}).reason
    assert "/opacity" in refused(DOC, {"op": "set", "path": "", "value": {}}).reason
    assert "/opacity" in refused(DOC, {"op": "set", "path": "/", "value": 1}).reason


# retarget, use_field, round


def test_retarget_use_field_and_round_equal_apply_fix() -> None:
    cases = [
        Fix(op="retarget", path="/classify/land_use", target="outline.color"),
        Fix(op="use_field", path="/classify/density/field", field="population"),
        Fix(op="round", path="/rules/r1/min_zoom"),
    ]
    for fix in cases:
        edit = Edit(**fix.model_dump(exclude_none=True))
        assert apply_edits(DOC, [edit]).document == apply_fix(DOC, fix)


def test_round_and_retarget_name_what_is_missing() -> None:
    error = refused(DOC, {"op": "round", "path": "/rules/r2/max_zoom"})
    assert "'max_zoom'" in error.reason and "when" in error.reason
    error = refused(
        DOC, {"op": "retarget", "path": "/classify/k9", "target": "fill.color"}
    )
    assert "density, land_use" in error.reason
    error = refused(DOC, {"op": "round", "path": "/classify/density/palette"})
    assert "number" in error.reason
    error = refused(
        DOC, {"op": "retarget", "path": "/classify/density", "target": "fill"}
    )
    assert "part.key" in error.reason
    # use_field replaces a field reference: a key that is not there holds none.
    error = refused(
        DOC, {"op": "use_field", "path": "/symbol/fill/fieldx", "field": "name"}
    )
    assert "'fieldx'" in error.reason


# every result


def test_the_result_of_every_case_passes_assign_ids_unchanged() -> None:
    cases = [
        [{"op": "add", "path": "/rules", "item": {"min_zoom": 2}}],
        [
            {
                "op": "add",
                "path": "/classify",
                "item": {"field": "type", "classes": [{}, {}]},
            }
        ],
        [{"op": "add", "path": "/render/classify/classes", "item": {"to": 1}}],
        [
            {
                "op": "set",
                "path": "/classify",
                "value": [{"field": "x", "classes": [{}]}],
            }
        ],
        [{"op": "set", "path": "/rules/r1", "value": {"id": "r2"}}],
        [
            {
                "op": "set",
                "path": "/classify/density/classes",
                "value": [{}, {"id": "c9"}],
            }
        ],
        [{"op": "move", "path": "/rules/r2"}],
        [{"op": "remove", "path": "/classify/density"}],
        [{"op": "retarget", "path": "/classify/density", "target": "outline.color"}],
    ]
    for raw in cases:
        out = run(DOC, *raw)
        assert_ids_complete_and_unique(out.document)
    no_ids = {"version": "1.0.0", "kind": "vector", "rules": [{}, {"id": "r1"}]}
    out = run(no_ids, {"op": "add", "path": "/rules", "item": {}})
    assert ids_of(out.document["rules"]) == ["r2", "r1", "r3"]
    assert out.added == {0: "r3"}
    assert_ids_complete_and_unique(out.document)


# the model


def test_the_schema_of_edit_has_a_type_or_anyof_for_every_field_and_a_description() -> (
    None
):
    schema = Edit.model_json_schema()
    text = json.dumps(schema)
    assert "—" not in text and "–" not in text
    for name, prop in schema["properties"].items():
        assert "type" in prop or "anyOf" in prop or "enum" in prop, name
        assert len(prop.get("description", "")) > 20, name
    assert (
        "a list item with an id is named by its id, for example /classify/density/palette"
        in (schema["properties"]["path"]["description"])
    )
    assert {t["type"] for t in schema["properties"]["value"]["anyOf"]} == {
        "string",
        "number",
        "boolean",
        "object",
        "array",
        "null",
    }
    assert schema["additionalProperties"] is False
    for pattern in re.findall(r'"pattern": "((?:[^"\\]|\\.)*)"', text):
        assert all(int(n) <= 64 for n in re.findall(r"\{\d*,?(\d+)\}", pattern))


def test_an_item_sent_as_json_text_is_read_as_an_object() -> None:
    edit = Edit.model_validate(
        {"op": "add", "path": "/rules", "item": '{"min_zoom": 3}'}
    )
    assert edit.item == {"min_zoom": 3}
    edit = Edit.model_validate(
        {"op": "set", "path": "/symbol", "value": '{"fill": {}}'}
    )
    assert edit.value == {"fill": {}}
    for text in ("{name}", "5", "true", "[1, 2]", "#ff0000"):
        assert (
            Edit.model_validate({"op": "set", "path": "/x", "value": text}).value
            == text
        )
    whole = Edit.model_validate_json(
        json.dumps(json.dumps({"op": "remove", "path": "/x"}))
    )
    assert whole.op == "remove"


def test_each_operation_has_the_fields_it_needs_and_no_misleading_ones() -> None:
    assert Edit.model_validate({"op": "set", "path": "/x", "value": None}).value is None
    good = [
        {"op": "remove", "path": "/x", "value": None, "target": None, "item": None},
        {"op": "round", "path": "/x"},
        {"op": "retarget", "path": "/x", "target": "outline.color"},
        {"op": "use_field", "path": "/x", "field": "name"},
        {"op": "add", "path": "/rules", "item": {}},
        {"op": "move", "path": "/rules/r1"},
        {"op": "move", "path": "/rules/r1", "after": None},
    ]
    for raw in good:
        Edit.model_validate(raw)
    bad = [
        ({"op": "set", "path": "/x"}, ("set", "value")),
        ({"op": "retarget", "path": "/x"}, ("retarget", "target")),
        ({"op": "use_field", "path": "/x"}, ("use_field", "field")),
        ({"op": "add", "path": "/rules"}, ("add", "item")),
        ({"op": "remove", "path": "/x", "value": 3}, ("remove", "value")),
        ({"op": "set", "path": "/x", "value": 1, "after": "r1"}, ("set", "after")),
        ({"op": "move", "path": "/x", "item": {}}, ("move", "item")),
    ]
    for raw, words in bad:
        with pytest.raises(ValidationError) as info:
            Edit.model_validate(raw)
        assert all(w in str(info.value) for w in words), (raw, str(info.value))
    with pytest.raises(ValidationError):
        Edit.model_validate({"op": "remove", "path": "/x", "extra": 1})


@pytest.mark.parametrize(
    "path",
    [
        "/classify/density/classes/\u00b2/fill/color",
        "/classify/density/classes/99999999999/fill/color",
    ],
)
def test_an_odd_index_segment_is_an_edit_error(path: str) -> None:
    """A segment Python reads as digits that is no index of the list (a
    superscript digit, a very long number) names no item."""
    error = refused(DOC, {"op": "set", "path": path, "value": "#000000"})
    assert error.index == 0
    # Thousands of digits name no index either, and raise nothing.
    assert find_index([1, 2], "9" * 5000) is None
    assert find_index([1, 2], "\u00b2") is None


def test_a_path_is_bounded() -> None:
    with pytest.raises(ValidationError, match="at most 200 characters"):
        Edit.model_validate({"op": "set", "path": "/a" * 101, "value": 1})
    assert Edit.model_validate({"op": "set", "path": "/a" * 100, "value": 1})


def test_edit_error_counts_from_one_and_keeps_the_index() -> None:
    error = EditError(2, "Something is missing.")
    assert (error.index, error.reason) == (2, "Something is missing.")
    assert str(error) == "Operation 3: Something is missing."
    assert isinstance(error, ValueError)


# the specification


def test_the_spec_names_the_seven_operations_and_no_example_moved() -> None:
    lines = SPEC.read_text().split("\n")
    # The examples above section 20 keep their line numbers: that heading stays on
    # line 3898 and the paragraph on the AI in 13.1 keeps its three lines.
    assert lines.index("## 20. For AI authors") + 1 == 3898
    assert lines[3185].startswith("**The AI**")
    assert lines[3188] == "" and lines[3189].startswith("**Not used:**")
    assert all(len(line) <= 120 for line in lines[3185:3188])
    starts = [
        n + 1
        for n, line in enumerate(lines)
        if line.startswith("```") and re.match(r"<!-- (check|expect):", lines[n - 1])
    ]
    assert len(starts) == len(load_examples())
    assert max(starts) < 3898
    section = "\n".join(lines[3897 : lines.index("## 21. Changelog")])
    assert "**Edit operations.**" in section
    for op in ("set", "remove", "add", "move", "retarget", "use_field", "round"):
        assert f"| `{op}` |" in section, op
    assert "—" not in section and "–" not in section
