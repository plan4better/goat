import pytest

from .conftest import check, load_examples

POINT = {"version": 1, "kind": "vector"}


def test_label_with_liquid_placeholder_is_template_syntax_with_a_fix() -> None:
    doc = {**POINT, "symbol": {"label": {"text": "{{ name }}"}}}
    [i] = check(doc, "point")
    assert (i.code, i.path, i.fix.op, i.fix.value) == (
        "template_syntax",
        "/symbol/label/text",
        "set",
        "{name}",
    )


def test_per_layer_key_set_twice() -> None:
    doc = {
        **POINT,
        "symbol": {"marker": {"allow_overlap": True}},
        "rules": [
            {
                "id": "r1",
                "when": {"op": "isNull", "args": [{"property": "name"}]},
                "marker": {"allow_overlap": False},
            }
        ],
    }
    assert [(i.code, i.path) for i in check(doc, "point")] == [
        ("override_not_per_feature", "/rules/r1/marker/allow_overlap")
    ]


def test_classes_take_shapes_and_pins_but_the_icon_alone_is_the_layers() -> None:
    def classes(base: str, shape: str) -> dict:
        return {
            **POINT,
            "symbol": {"marker": {"shape": base, "icon": "goat:park"}},
            "classify": [
                {
                    "id": "k",
                    "field": "kind",
                    "method": "categories",
                    "classes": [
                        {"id": "a", "values": ["a"], "marker": {"shape": shape}},
                        {"id": "b", "values": ["b"], "marker": {"shape": "circle"}},
                    ],
                }
            ],
        }

    assert check(classes("circle", "pin"), "point") == []
    assert [(i.code, i.path) for i in check(classes("circle", "icon"), "point")] == [
        ("override_not_per_feature", "/classify/k/classes/a/marker/shape")
    ]
    # The icon alone draws in a layer of its own: its classes take no shape.
    assert [(i.code, i.path) for i in check(classes("icon", "pin"), "point")] == [
        ("override_not_per_feature", "/classify/k/classes/a/marker/shape"),
        ("override_not_per_feature", "/classify/k/classes/b/marker/shape"),
    ]


def test_a_per_layer_key_set_once_in_a_rule_is_fine() -> None:
    doc = {
        **POINT,
        "symbol": {
            "line": {"color": "#2166ac"},
            "arrows": {"placement": "center", "size": 12},
        },
        "rules": [
            {
                "when": {"op": "=", "args": [{"property": "oneway"}, True]},
                "arrows": {"spacing": 120},
            }
        ],
    }
    assert check(doc, "line") == []


def test_dash_on_point_outline() -> None:
    doc = {
        **POINT,
        "symbol": {"marker": {"color": "#000000"}, "outline": {"dash": "dashed"}},
    }
    assert [i.code for i in check(doc, "point")] == ["dash_on_point_outline"]


def test_parts_must_fit_the_geometry() -> None:
    doc = {
        **POINT,
        "symbol": {"fill": {"color": "#000000"}, "line": {"color": "#000000"}},
    }
    assert [(i.code, i.path) for i in check(doc, "polygon")] == [
        ("part_not_for_geometry", "/symbol/line")
    ]


def test_part_zooms_in_overrides_are_whole_numbers() -> None:
    doc = {
        **POINT,
        "rules": [
            {
                "id": "r1",
                "when": {"op": "isNull", "args": [{"property": "n"}]},
                "label": {"min_zoom": 11.5},
            }
        ],
    }
    assert [(i.code, i.path) for i in check(doc, "point")] == [
        ("zoom_not_whole", "/rules/r1/label/min_zoom")
    ]


def test_layer_zoom_range() -> None:
    assert [
        i.code for i in check({**POINT, "min_zoom": 14, "max_zoom": 10}, "point")
    ] == ["zoom_range_invalid"]


def test_point_renders_on_lines() -> None:
    assert [
        i.code for i in check({**POINT, "render": {"type": "heatmap"}}, "line")
    ] == ["render_not_for_geometry"]


def test_counts_opacity_and_icons() -> None:
    many = {**POINT, "classify": [{"field": "a", "method": "quantile", "count": 9}]}
    assert [i.code for i in check(many, "point")] == ["too_many_classes"]
    faint = {**POINT, "opacity": 0.1}
    assert [i.code for i in check(faint, "point")] == ["low_opacity"]
    mixed = {
        **POINT,
        "symbol": {"marker": {"shape": "icon", "icon": "goat:park"}},
        "rules": [
            {
                "when": {"op": "isNull", "args": [{"property": "n"}]},
                "marker": {"icon": "asset:a1"},
            }
        ],
    }
    assert [i.code for i in check(mixed, "point")] == ["mixed_icon_kinds"]
    # Emoji keep their colors like uploads; on a shape every icon draws in one layer.
    emoji = {
        **mixed,
        "rules": [{**mixed["rules"][0], "marker": {"icon": "emoji:1f525"}}],
    }
    assert [i.code for i in check(emoji, "point")] == ["mixed_icon_kinds"]
    on_square = {
        **mixed,
        "symbol": {"marker": {"shape": "square", "icon": "goat:park"}},
    }
    assert check(on_square, "point") == []


def test_nothing_drawn() -> None:
    assert [i.code for i in check({**POINT, "symbol": {"marker": False}}, "point")] == [
        "nothing_drawn"
    ]


def test_qualitative_palette_on_numeric_classes() -> None:
    doc = {
        **POINT,
        "classify": [
            {
                "field": "a",
                "method": "quantile",
                "count": 4,
                "palette": "colorbrewer:Set2",
            }
        ],
    }
    assert [i.code for i in check(doc, "point")] == ["palette_kind_mismatch"]


DOC_CODES = {
    "part_not_for_geometry",
    "override_not_per_feature",
    "dash_on_point_outline",
    "template_syntax",
    "classify_target_conflict",
    "classify_partial_overlap",
}
EXAMPLES = [e for e in load_examples() if set(e["expect"]) & DOC_CODES]


@pytest.mark.parametrize("ex", EXAMPLES, ids=lambda e: f"line{e['line']}-{e['target']}")
def test_spec_examples_report_their_document_codes(ex: dict, contexts: dict) -> None:
    from goatlib.style.check import check_document
    from goatlib.style.parse import parse_for_write

    style, _ = parse_for_write(ex["doc"])
    got = {
        i.code
        for i in check_document(ex["doc"], style, contexts[ex["target"]].geometry)
    }
    assert set(ex["expect"]) & DOC_CODES <= got


def test_an_other_that_does_not_set_the_shared_key_is_partial_cover() -> None:
    doc = {
        **POINT,
        "classify": [
            {
                "field": "density",
                "method": "manual",
                "classes": [
                    {"to": 5, "fill": {"color": "#000000"}},
                    {"from": 5, "fill": {"color": "#111111"}},
                ],
            },
            {
                "field": "land_use",
                "method": "categories",
                "classes": [{"values": ["green"], "fill": {"color": "#222222"}}],
                "other": {"outline": {"color": "#333333"}},
            },
        ],
    }
    assert [i.code for i in check(doc, "polygon")] == ["classify_partial_overlap"]


def test_classes_colored_by_a_palette_still_set_their_target() -> None:
    doc = {
        **POINT,
        "classify": [
            {
                "field": "land_use",
                "method": "categories",
                "palette": "colorbrewer:Set2",
                "classes": [{"values": ["green"], "name": "Green"}],
            },
            {
                "field": "density",
                "method": "quantile",
                "count": 4,
                "palette": "colorbrewer:OrRd",
            },
        ],
    }
    assert [i.code for i in check(doc, "polygon")] == ["classify_target_conflict"]


def test_boolean_categories_can_cover_every_feature(contexts: dict) -> None:
    from goatlib.style.check import check_document
    from goatlib.style.parse import parse_for_write

    doc = {
        **POINT,
        "classify": [
            {
                "field": "status",
                "method": "categories",
                "classes": [{"values": ["planned"], "line": {"color": "#000000"}}],
            },
            {
                "field": "oneway",
                "method": "categories",
                "classes": [
                    {"values": ["true"], "line": {"color": "#111111"}},
                    {"values": ["false"], "line": {"color": "#222222"}},
                ],
            },
        ],
    }
    issues = check_document(
        doc, parse_for_write(doc)[0], "line", ctx=contexts["routes"]
    )
    assert [i.code for i in issues] == ["classify_target_conflict"]


def test_classes_and_rules_may_draw_hollow_markers() -> None:
    doc = {
        **POINT,
        "symbol": {"marker": {"shape": "pin"}, "outline": {"color": "fill"}},
        "classify": [
            {
                "id": "k",
                "field": "kind",
                "method": "categories",
                "classes": [{"id": "a", "values": ["a"], "marker": {"fill": False}}],
            }
        ],
        "rules": [
            {
                "id": "r",
                "when": {"op": "=", "args": [{"property": "kind"}, "b"]},
                "marker": {"fill": False},
            }
        ],
    }
    assert check(doc, "point") == []
