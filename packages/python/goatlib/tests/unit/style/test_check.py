import pytest

from .conftest import check, load_examples

POINT = {"version": "1.0.0", "kind": "vector"}


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


def test_position_on_point_outline() -> None:
    doc = {
        **POINT,
        "symbol": {"marker": {"color": "#000000"}, "outline": {"position": "inside"}},
    }
    assert [i.code for i in check(doc, "point")] == ["position_on_point_outline"]
    polygon = {**POINT, "symbol": {"outline": {"position": "inside"}}}
    assert [i.code for i in check(polygon, "polygon")] == []


def test_label_placement_must_fit_the_geometry() -> None:
    def placed(placement: str, geometry: str) -> list[tuple[str, str]]:
        doc = {**POINT, "symbol": {"label": {"text": "{name}", "placement": placement}}}
        return [(i.code, i.path) for i in check(doc, geometry)]

    for placement in ("auto", "center", "right", "below_left"):
        assert placed(placement, "point") == []
    # A line's label at its center point and an area's label take the sides around the marker too.
    for placement in ("line", "center", "auto", "right", "above_left"):
        assert placed(placement, "line") == []
    for placement in ("inside", "auto", "above", "below_right"):
        assert placed(placement, "polygon") == []
    wrong = [("placement_not_for_geometry", "/symbol/label/placement")]
    assert placed("inside", "line") == wrong
    assert placed("line", "point") == wrong
    assert placed("inside", "point") == wrong
    assert placed("line", "polygon") == wrong
    # The middle of an area is `inside`, one value for one place.
    assert placed("center", "polygon") == wrong


def test_every_weight_is_fine_upright_and_italic() -> None:
    """Labels draw in Noto Sans Light, Regular, Medium and Bold, each upright and italic (spec 3.4)."""
    when = {"op": "isNull", "args": [{"property": "name"}]}

    def fonts(label: dict, rules: list | None = None) -> list[tuple[str, str, str]]:
        doc = {**POINT, "symbol": {"label": {"text": "{name}", **label}}}
        if rules:
            doc["rules"] = rules
        return [(i.code, i.level, i.path) for i in check(doc, "point")]

    for weight in ("light", "regular", "medium", "bold"):
        for style in ("normal", "italic"):
            assert fonts({"font": {"weight": weight, "style": style}}) == [], (
                weight,
                style,
            )
    by_zoom = {
        "zoom": [[10, "light"], [14, "medium"], [18, "bold"]],
        "interpolate": "step",
    }
    assert fonts({"font": {"weight": by_zoom, "style": "italic"}}) == []
    # A rule's bold on an italic layer, and a bold italic line.
    italic = {"font": {"style": "italic"}}
    assert (
        fonts(
            italic, [{"id": "r1", "when": when, "label": {"font": {"weight": "bold"}}}]
        )
        == []
    )
    assert (
        fonts({"lines": [{}, {"font": {"weight": "medium", "style": "italic"}}]}) == []
    )
    # A weight the fonts do not have is not a weight.
    from goatlib.style.parse import parse_for_write

    doc = {
        **POINT,
        "symbol": {"label": {"text": "{name}", "font": {"weight": "semibold"}}},
    }
    assert [(i.code, i.path) for i in parse_for_write(doc)[1]] == [
        ("invalid_value", "/symbol/label/font/weight")
    ]


def test_a_class_label_placement_must_fit_the_geometry_too() -> None:
    doc = {
        **POINT,
        "symbol": {"line": {"color": "#000000"}},
        "rules": [
            {
                "when": {"op": "isNull", "args": [{"property": "name"}]},
                "label": {"text": "{name}", "placement": "inside"},
            }
        ],
    }
    assert [(i.code, i.path) for i in check(doc, "line")] == [
        ("placement_not_for_geometry", "/rules/0/label/placement")
    ]


def test_parts_must_fit_the_geometry() -> None:
    doc = {
        **POINT,
        "symbol": {"fill": {"color": "#000000"}, "line": {"color": "#000000"}},
    }
    assert [(i.code, i.path) for i in check(doc, "polygon")] == [
        ("part_not_for_geometry", "/symbol/line")
    ]


@pytest.mark.parametrize("geometry", ["polygon", "line"])
def test_polygons_and_lines_take_a_marker(geometry: str) -> None:
    """Spec 3.3: a marker at each polygon's label point or each line's middle."""
    marker = {
        "shape": "circle",
        "icon": "goat:park",
        "size": {"field": "n", "range": [4, 20]},
    }
    assert check({**POINT, "symbol": {"marker": marker}}, geometry) == []
    by_class = {
        **POINT,
        "classify": [
            {
                "field": "use",
                "method": "categories",
                "classes": [{"values": ["school"], "marker": {"icon": "goat:school"}}],
            }
        ],
        "rules": [
            {"when": {"op": "=", "args": [{"property": "n"}, 1]}, "marker": False}
        ],
    }
    assert check(by_class, geometry) == []
    sized = {
        **POINT,
        "classify": [
            {"field": "n", "method": "quantile", "count": 3, "target": "marker.size"}
        ],
    }
    assert check(sized, geometry) == []


def test_markers_on_polygons_and_lines_still_draw_no_clusters() -> None:
    doc = {**POINT, "symbol": {"marker": {"size": 10}}, "render": {"type": "cluster"}}
    assert [i.code for i in check(doc, "polygon")] == ["render_not_for_geometry"]


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
    "position_on_point_outline",
    "placement_not_for_geometry",
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


POLY = {"version": "1.0.0", "kind": "vector", "geometry": "polygon"}


def test_extrude_value_forms() -> None:
    from goatlib.style.models.layer import VectorStyle

    from .conftest import codes

    for height in (
        12,
        {"zoom": [[14, 0], [16, 12]]},
        {"field": "height"},
        {"field": "height", "range": [0, 100]},
    ):
        assert (
            check({**POLY, "symbol": {"extrude": {"height": height}}}, "polygon") == []
        )
    assert codes(VectorStyle, {**POLY, "symbol": {"extrude": {"height": -1}}}) != []


def test_extrude_only_on_polygons() -> None:
    doc = {**POLY, "geometry": "line", "symbol": {"extrude": {"height": 3}}}
    assert [i.code for i in check(doc, "line")] == ["part_not_for_geometry"]


def test_classes_and_rules_set_heights() -> None:
    doc = {
        **POLY,
        "symbol": {"extrude": {"height": {"field": "levels"}, "unit": "storeys"}},
        "classify": [
            {
                "field": "use",
                "method": "categories",
                "classes": [
                    {"values": ["green"], "extrude": False},
                    {"values": ["tower"], "extrude": {"height": 120}},
                ],
            }
        ],
    }
    assert check(doc, "polygon") == []


def test_extrude_unit_is_per_layer() -> None:
    doc = {
        **POLY,
        "symbol": {"extrude": {"unit": "m"}},
        "rules": [
            {
                "when": {"op": "isNull", "args": [{"property": "a"}]},
                "extrude": {"unit": "storeys"},
            }
        ],
    }
    assert [i.code for i in check(doc, "polygon")] == ["override_not_per_feature"]


def test_base_above_height() -> None:
    doc = {**POLY, "symbol": {"extrude": {"height": 10, "base": 12}}}
    assert [(i.code, i.path) for i in check(doc, "polygon")] == [
        ("base_above_height", "/symbol/extrude/base")
    ]
    by_field = {**POLY, "symbol": {"extrude": {"height": {"field": "h"}, "base": 12}}}
    assert check(by_field, "polygon") == []


def test_extrude_drops_pattern() -> None:
    doc = {
        **POLY,
        "symbol": {"fill": {"pattern": "hatch_45"}, "extrude": {"height": 10}},
    }
    assert [(i.code, i.level, i.path) for i in check(doc, "polygon")] == [
        ("extrude_drops_pattern", "warning", "/symbol/fill/pattern")
    ]
    flat = {**POLY, "symbol": {"fill": {"pattern": "hatch_45"}, "extrude": False}}
    assert check(flat, "polygon") == []


def test_extrude_opacity_per_layer() -> None:
    base = {
        **POLY,
        "symbol": {
            "fill": {"opacity": {"zoom": [[10, 1], [16, 0.6]]}},
            "extrude": {"height": 10},
        },
    }
    assert check(base, "polygon") == []
    by_attr = {
        **POLY,
        "symbol": {
            "fill": {"opacity": {"field": "x", "range": [0.2, 1]}},
            "extrude": {"height": 10},
        },
    }
    assert [(i.code, i.path) for i in check(by_attr, "polygon")] == [
        ("override_not_per_feature", "/symbol/fill/opacity")
    ]
    in_class = {
        **POLY,
        "symbol": {"extrude": {"height": 10}},
        "classify": [
            {
                "field": "use",
                "method": "categories",
                "classes": [{"values": ["a"], "fill": {"opacity": 0.5}}],
            }
        ],
    }
    assert [(i.code, i.path) for i in check(in_class, "polygon")] == [
        ("override_not_per_feature", "/classify/0/classes/0/fill/opacity")
    ]
    in_rule = {
        **POLY,
        "symbol": {"extrude": {"height": 10}},
        "rules": [
            {
                "when": {"op": "isNull", "args": [{"property": "a"}]},
                "fill": {"opacity": 0.5},
            }
        ],
    }
    assert [i.code for i in check(in_rule, "polygon")] == ["override_not_per_feature"]
    flat = {**by_attr, "symbol": {**by_attr["symbol"], "extrude": False}}
    assert check(flat, "polygon") == []


def test_classification_can_target_height() -> None:
    from goatlib.style.models.classify import TARGET_KINDS

    assert TARGET_KINDS["extrude.height"] == "number"
    assert TARGET_KINDS["extrude.base"] == "number"


def test_classification_of_heights_has_a_default_range() -> None:
    from goatlib.style.colors import default_range
    from goatlib.style.defaults import REFERENCE_DEFAULTS

    assert default_range("extrude.height") == (0, 50)
    assert default_range("extrude.base") == (0, 10)
    assert REFERENCE_DEFAULTS["extrude.height"] == 10
    assert REFERENCE_DEFAULTS["extrude.base"] == 0
    assert REFERENCE_DEFAULTS["extrude.unit"] == "m"


def test_classes_do_not_switch_on_a_part_the_layer_has_off() -> None:
    """Spec 3: a part the layer switches off stays off in every record, so a fill
    switched off with its color by class still draws nothing."""
    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {"fill": False},
        "classify": [
            {
                "field": "land_use",
                "method": "categories",
                "classes": [{"values": ["a"], "fill": {"color": "#111111"}}],
            }
        ],
    }
    assert "nothing_drawn" in [i.code for i in check(doc, "polygon")]


RASTER = {"version": "1.0.0", "kind": "raster"}
H3_COLUMNS = {"type": "h3", "extrude": {"tallest": 500}}
CONTINUOUS = {"type": "continuous", "palette": "goat:elevation", "domain": [0, 500]}
CATEGORICAL = {
    "type": "categorical",
    "classes": [{"value": 1, "color": "#1b9e77"}],
}


@pytest.mark.parametrize(
    ("doc", "geometry", "reason"),
    [
        ({**POINT}, "point", "points"),
        ({**POINT, "render": {"type": "features"}}, "point", "points"),
        ({**POINT, "render": {"type": "heatmap"}}, "point", "heatmap"),
        ({**POINT, "render": {"type": "heatmap"}}, None, "heatmap"),
        ({**POINT, "render": {"type": "cluster"}}, "point", "cluster"),
        ({**POINT, "render": H3_COLUMNS}, "point", "columns"),
        ({**POINT, "render": H3_COLUMNS}, None, "columns"),
        ({**RASTER, "render": {"type": "hillshade"}}, None, "hillshade"),
        (
            {**RASTER, "render": {"type": "hillshade", "palette": "goat:elevation"}},
            None,
            "hillshade",
        ),
        ({**RASTER, "render": CONTINUOUS}, None, "color_scale"),
        ({**RASTER, "render": CATEGORICAL}, None, "color_scale"),
    ],
)
@pytest.mark.parametrize("blend", ["multiply", "luminosity", "plus-lighter"])
def test_a_blend_on_a_layer_that_draws_nothing_that_mixes(
    doc: dict, geometry: str | None, reason: str, blend: str
) -> None:
    [issue] = check({**doc, "blend": blend}, geometry)
    assert (issue.code, issue.level, issue.path, issue.params) == (
        "blend_not_drawn",
        "info",
        "/blend",
        {"reason": reason},
    )
    assert (issue.fix.op, issue.fix.path) == ("remove", "/blend")


@pytest.mark.parametrize(
    ("doc", "geometry"),
    [
        ({**POINT, "symbol": {"fill": {"color": "#fcbba1"}}}, "polygon"),
        (
            {**POINT, "symbol": {"extrude": {"height": 10}, "outline": {"width": 1}}},
            "polygon",
        ),
        ({**POINT, "symbol": {"line": {"color": "#2166ac"}}}, "line"),
        ({**POINT, "render": {"type": "h3"}}, "point"),
        ({**POINT, "render": {"type": "h3"}}, None),
        # Points drawn as features where the geometry is not known: nothing to say.
        ({**POINT}, None),
        ({**RASTER}, None),
        ({**RASTER, "render": {"type": "image"}}, None),
        ({**RASTER, "render": {"type": "image", "bands": [1, 2, 3]}}, None),
    ],
)
@pytest.mark.parametrize("blend", ["multiply", "luminosity", "plus-lighter"])
def test_a_blend_on_a_layer_that_mixes_is_not_reported(
    doc: dict, geometry: str | None, blend: str
) -> None:
    assert check({**doc, "blend": blend}, geometry) == []


@pytest.mark.parametrize(
    "doc",
    [
        {**POINT, "render": {"type": "heatmap"}},
        {**POINT, "render": H3_COLUMNS},
        {**RASTER, "render": {"type": "hillshade"}},
        {**RASTER, "render": CONTINUOUS},
    ],
)
def test_normal_or_no_blend_is_never_reported(doc: dict) -> None:
    assert check({**doc, "blend": "normal"}, "point") == []
    assert check(doc, "point") == []
