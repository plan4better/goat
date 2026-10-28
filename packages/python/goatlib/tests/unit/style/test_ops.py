import pytest
from goatlib.style.issues import Fix
from goatlib.style.ops import apply_fix

RULE = {
    "id": "r1",
    "visible": False,
    "min_zoom": 12.4,
    "when": {"op": "isNull", "args": [{"property": "name"}]},
}


def test_retarget_moves_the_key_the_class_records_set() -> None:
    doc = {
        "version": 1,
        "kind": "vector",
        "classify": [
            {
                "id": "a",
                "field": "type",
                "method": "categories",
                "target": "fill.color",
                "classes": [
                    {"id": "c1", "values": ["x"], "fill": {"color": "#000000"}}
                ],
                "other": {"fill": {"color": "#111111", "opacity": 0.5}},
            }
        ],
    }
    out = apply_fix(doc, Fix(op="retarget", path="/classify/a", target="outline.color"))
    c = out["classify"][0]
    assert c["target"] == "outline.color"
    assert c["classes"][0] == {
        "id": "c1",
        "values": ["x"],
        "outline": {"color": "#000000"},
    }
    assert c["other"] == {"fill": {"opacity": 0.5}, "outline": {"color": "#111111"}}
    assert doc["classify"][0]["target"] == "fill.color"


def test_round_set_remove_use_field() -> None:
    doc = {
        "version": 1,
        "kind": "vector",
        "rules": [RULE],
        "symbol": {"label": {"text": "{{ name }}"}},
        "classify": [{"id": "k", "field": "gone", "method": "categories"}],
    }
    assert (
        apply_fix(doc, Fix(op="round", path="/rules/r1/min_zoom"))["rules"][0][
            "min_zoom"
        ]
        == 12
    )
    assert (
        apply_fix(doc, Fix(op="set", path="/symbol/label/text", value="{name}"))[
            "symbol"
        ]["label"]["text"]
        == "{name}"
    )
    assert (
        "min_zoom"
        not in apply_fix(doc, Fix(op="remove", path="/rules/r1/min_zoom"))["rules"][0]
    )
    assert (
        apply_fix(doc, Fix(op="use_field", path="/classify/k/field", field="land_use"))[
            "classify"
        ][0]["field"]
        == "land_use"
    )


def test_a_path_that_does_not_exist_raises() -> None:
    with pytest.raises(ValueError):
        apply_fix({"version": 1, "kind": "vector"}, Fix(op="remove", path="/rules/r9"))


def test_round_goes_half_up_like_javascript() -> None:
    doc = {"version": 1, "kind": "vector", "rules": [{**RULE, "min_zoom": 12.5}]}
    assert (
        apply_fix(doc, Fix(op="round", path="/rules/r1/min_zoom"))["rules"][0][
            "min_zoom"
        ]
        == 13
    )
