import time
from dataclasses import replace

from goatlib.style.context import MapContext
from goatlib.style.validate import validate, validate_map

V = {"version": 1, "kind": "vector"}


def codes(doc: dict, ctx: object) -> set[str]:
    return {i.code for i in validate(doc, ctx)}


def test_cluster_over_the_limit(contexts: dict) -> None:
    ctx = replace(contexts["schools"], feature_count=100_001)
    assert "too_many_features_for_render" in codes(
        {**V, "render": {"type": "cluster"}}, ctx
    )
    assert "too_many_features_for_render" not in codes(
        {**V, "render": {"type": "cluster"}}, contexts["schools"]
    )


def test_h3_without_the_capability_is_not_supported_yet(contexts: dict) -> None:
    ctx = replace(contexts["schools"], capabilities=frozenset())
    assert "not_supported_yet" in codes({**V, "render": {"type": "h3"}}, ctx)
    assert "not_supported_yet" not in codes(
        {**V, "render": {"type": "h3"}}, contexts["schools"]
    )


def test_stored_documents_get_damaged_instead_of_error(contexts: dict) -> None:
    doc = {
        **V,
        "symbol": {"fill": {"color": {"field": "gone", "palette": "d3:viridis"}}},
    }
    [i] = [
        i
        for i in validate(doc, contexts["districts"], stored=True)
        if i.code == "unknown_field"
    ]
    assert i.level == "damaged" and i.path == "/symbol/fill/color/field"


def test_fields_with_odd_names(contexts: dict) -> None:
    from goatlib.style.context import DataContext, FieldInfo

    ctx = DataContext(
        kind="vector",
        geometry="point",
        fields={"Einwohner 2020": FieldInfo("Einwohner 2020", "number", min=0, max=9)},
    )
    doc = {
        **V,
        "symbol": {
            "label": {"text": "{Einwohner 2020} people"},
            "marker": {"size": {"field": "Einwohner 2020", "range": [2, 9]}},
        },
    }
    assert [i for i in validate(doc, ctx) if i.level == "error"] == []
    assert codes({**V, "symbol": {"label": {"text": "{Straße}"}}}, ctx) == {
        "unknown_field"
    }


def test_unknown_fields_skip_field_checks() -> None:
    from goatlib.style.context import DataContext

    ctx = DataContext(kind="vector", geometry="point")
    assert (
        codes({**V, "classify": [{"field": "anything", "method": "categories"}]}, ctx)
        == set()
    )


def test_catalogues(contexts: dict) -> None:
    assert "unknown_icon" in codes(
        {**V, "symbol": {"marker": {"shape": "icon", "icon": "goat:no-such-icon"}}},
        contexts["schools"],
    )
    assert "unknown_palette" in codes(
        {
            **V,
            "symbol": {"marker": {"color": {"field": "pupils", "palette": "d3:nope"}}},
        },
        contexts["schools"],
    )
    short = {
        **V,
        "classify": [
            {
                "field": "pupils",
                "method": "quantile",
                "count": 5,
                "palette": ["#000000", "#ffffff"],
            }
        ],
    }
    assert "palette_too_short" in codes(short, contexts["schools"])


def test_services(contexts: dict) -> None:
    assert "render_not_for_source" in codes(
        {
            "version": 1,
            "kind": "raster",
            "render": {"type": "image", "bands": [1, 2, 3]},
        },
        contexts["tiles"],
    )
    assert "render_not_for_source" in codes(
        {
            "version": 1,
            "kind": "raster",
            "render": {"type": "image", "service_style": "grey"},
        },
        contexts["satellite"],
    )
    assert "invalid_value" in codes(
        {
            "version": 1,
            "kind": "raster",
            "render": {"type": "image", "service_style": "sepia"},
        },
        contexts["wms"],
    )


def test_huge_documents_finish_quickly(contexts: dict) -> None:
    classes = [{"values": [f"v{n}"]} for n in range(5000)]
    doc = {
        **V,
        "classify": [{"field": "land_use", "method": "categories", "classes": classes}],
        "symbol": {"label": {"text": "x" * 1_000_000}},
    }
    t = time.perf_counter()
    validate(doc, contexts["districts"])
    assert time.perf_counter() - t < 2


def test_map_document_codes() -> None:
    ctx = MapContext(layers={1: frozenset({"s1"}), 2: frozenset({"s1"})})
    doc = {
        "version": 1,
        "layers": [
            {"type": "layer", "id": 1, "style": "s9"},
            {
                "type": "group",
                "name": "G",
                "children": [
                    {"type": "layer", "id": 1},
                    {"type": "layer", "id": 7, "position": "middle"},
                ],
            },
        ],
    }
    assert {i.code for i in validate_map(doc, ctx)} == {
        "unknown_style",
        "duplicate_layer",
        "unknown_layer",
        "unknown_position",
    }


def test_a_broken_template_reports_its_syntax_not_unknown_fields(
    contexts: dict,
) -> None:
    assert codes(
        {**V, "symbol": {"label": {"text": "{{ name }}"}}}, contexts["districts"]
    ) == {"template_syntax"}


def test_boolean_categories_compare_as_text(contexts: dict) -> None:
    doc = {
        **V,
        "classify": [
            {
                "field": "oneway",
                "method": "categories",
                "classes": [{"values": ["true"]}],
            }
        ],
    }
    assert codes(doc, contexts["routes"]) == set()


def test_a_band_formula_domain_is_not_compared_with_band_1(contexts: dict) -> None:
    band = {"name": "NDVI", "expression": "(b4 - b1) / (b4 + b1)"}
    doc = {
        "version": 1,
        "kind": "raster",
        "render": {
            "type": "continuous",
            "band": band,
            "palette": "goat:green",
            "domain": [-0.4, 0.7],
        },
    }
    assert codes(doc, contexts["satellite"]) == set()


def test_liquid_reads_unicode_and_hyphenated_field_names() -> None:
    from goatlib.style.context import DataContext, FieldInfo

    fields = {n: FieldInfo(n, "string") for n in ("Straße", "Größe", "road-class")}
    ctx = DataContext(kind="vector", geometry="point", fields=fields)
    html = "{{ Straße }} {% if Größe %}{{ Größe | round }}{% endif %} {{ road-class }}"
    assert codes({**V, "popup": {"mode": "html", "html": html}}, ctx) == set()


def test_rasters_get_document_checks(contexts: dict) -> None:
    doc = {
        "version": 1,
        "kind": "raster",
        "min_zoom": 10,
        "max_zoom": 5,
        "opacity": 0.1,
        "render": {"type": "image"},
    }
    assert {"zoom_range_invalid", "low_opacity"} <= codes(doc, contexts["satellite"])


WRONG_CONTAINERS = [
    {**V, "classify": -5},
    {**V, "rules": -5},
    {**V, "popup": {"blocks": 3.7}},
    {
        **V,
        "classify": [
            {"field": "land_use", "method": "categories", "classes": [{"values": 7}]}
        ],
    },
    {**V, "classify": [{"field": "land_use", "method": "categories", "classes": 3}]},
    {**V, "symbol": {"label": {"text": 5, "priority": 3}}},
    {"version": 1, "kind": "raster", "render": {"type": "categorical", "classes": 4}},
]


def test_wrong_container_types_give_issues_not_exceptions(contexts: dict) -> None:
    from goatlib.style.ids import assign_ids
    from goatlib.style.merge import merge

    for doc in WRONG_CONTAINERS:
        ctx = (
            contexts["landcover"] if doc["kind"] == "raster" else contexts["districts"]
        )
        assert validate(doc, ctx)
        assign_ids(doc)
        merge(doc, doc, doc)


def test_deep_nesting_anywhere_is_refused(contexts: dict) -> None:
    deep: dict = {}
    node = deep
    for _ in range(1000):
        node["x"] = {}
        node = node["x"]
    issues = validate({**V, "ext": {"goat:deep": deep}}, contexts["districts"])
    assert "invalid_value" in {i.code for i in issues}


def test_many_classifications_finish_quickly(contexts: dict) -> None:
    one = {
        "field": "land_use",
        "method": "categories",
        "classes": [{"values": ["green"], "fill": {"color": "#000000"}}],
        "other": {"fill": {"color": "#ffffff"}},
    }
    t = time.perf_counter()
    validate({**V, "classify": [dict(one) for _ in range(600)]}, contexts["districts"])
    assert time.perf_counter() - t < 2


def test_duplicate_ids_are_reported(contexts: dict) -> None:
    rule = {
        "id": "r1",
        "when": {"op": "isNull", "args": [{"property": "name"}]},
        "visible": False,
    }
    issues = validate({**V, "rules": [rule, dict(rule)]}, contexts["districts"])
    assert ("invalid_value", "/rules/1/id") in {(i.code, i.path) for i in issues}


def test_fuzzed_documents_never_raise(spec_examples: list, contexts: dict) -> None:
    import copy
    import random

    from goatlib.style.ids import assign_ids
    from goatlib.style.merge import merge

    rnd = random.Random(7)
    junk = [
        None,
        True,
        -3,
        2.5,
        "x",
        "{{ x }}",
        [],
        {},
        [1, "a", None],
        {"zoom": 3},
        {"field": 7},
        {"op": "and", "args": 5},
    ]

    def mutate(node: object) -> object:
        if isinstance(node, dict) and node and rnd.random() < 0.7:
            key = rnd.choice(list(node))
            node[key] = rnd.choice(junk) if rnd.random() < 0.5 else mutate(node[key])
        elif isinstance(node, list) and node and rnd.random() < 0.7:
            i = rnd.randrange(len(node))
            node[i] = rnd.choice(junk) if rnd.random() < 0.5 else mutate(node[i])
        return node

    docs = [e for e in spec_examples if e["target"] not in ("map", "maplibre")]
    for n in range(1500):
        ex = docs[n % len(docs)]
        doc = mutate(copy.deepcopy(ex["doc"]))
        validate(doc, contexts[ex["target"]])
        if isinstance(doc, dict):
            assign_ids(doc)
            merge(ex["doc"], doc, ex["doc"])


def test_icons_name_their_library(contexts: dict) -> None:
    def icon(ref: str) -> set[str]:
        return codes(
            {**V, "symbol": {"marker": {"shape": "icon", "icon": ref}}},
            contexts["schools"],
        )

    assert icon("goat:park") == set()
    assert icon("asset:7f3a") == set()
    assert icon("emoji:1f525") == set()
    assert icon("emoji:fire") == {"unknown_icon"}
    assert icon("maki:park") == {"unknown_icon"}
    assert icon("lib:park") == {"unknown_icon"}


def test_referenced_fields_are_the_fields_the_checks_read() -> None:
    from goatlib.style.data_check import referenced_fields

    doc = {
        "version": 1,
        "kind": "vector",
        "symbol": {
            "marker": {
                "size": {"zoom": [[5, 4], [12, {"field": "pupils", "range": [2, 12]}]]}
            },
            "label": {
                "text": "{name} ({kind})",
                "priority": {"field": "rank", "top": "largest"},
            },
        },
        "classify": [{"field": "density", "method": "quantile", "count": 3}],
        "rules": [
            {
                "when": {"op": "=", "args": [{"property": "oneway"}, True]},
                "line": {"width": 2},
            }
        ],
        "order": {"field": "height"},
        "popup": {
            "blocks": [{"type": "attributes", "attributes": [{"field": "street"}]}]
        },
    }
    assert referenced_fields(doc) == {
        "pupils",
        "name",
        "kind",
        "rank",
        "density",
        "oneway",
        "height",
        "street",
    }


R = {"version": 1, "kind": "raster"}
NONE: frozenset[str] = frozenset()


def test_one_band_with_written_values_needs_no_raster_service(contexts: dict) -> None:
    ctx = replace(contexts["elevation"], capabilities=NONE)
    for render in (
        {
            "type": "continuous",
            "band": 1,
            "palette": "goat:elevation",
            "domain": [200, 450],
        },
        {
            "type": "continuous",
            "stops": [
                {"value": 0, "color": "#000000"},
                {"value": 9, "color": "#ffffff"},
            ],
        },
        {"type": "terrain", "method": "igor"},
        {
            "type": "continuous",
            "domain": [0, 9],
            "classify": {"method": "manual", "classes": [{"to": 3}, {"from": 3}]},
        },
    ):
        assert "not_supported_yet" not in codes({**R, "render": render}, ctx), render


def test_computed_raster_values_need_the_raster_service(contexts: dict) -> None:
    ctx = replace(contexts["elevation"], capabilities=NONE)
    assert "not_supported_yet" in codes(
        {**R, "render": {"type": "continuous", "palette": "goat:elevation"}}, ctx
    )
    assert "not_supported_yet" in codes(
        {
            **R,
            "render": {
                "type": "continuous",
                "domain": [0, 9],
                "classify": {"method": "quantile", "count": 5},
            },
        },
        ctx,
    )


def test_a_band_other_than_one_is_not_a_formula(contexts: dict) -> None:
    ctx = replace(contexts["satellite"], capabilities=NONE)
    assert "not_supported_yet" not in codes(
        {**R, "render": {"type": "continuous", "band": 4, "domain": [10, 230]}}, ctx
    )
    formula = {"name": "NDVI", "expression": "(b4 - b1) / (b4 + b1)"}
    assert "not_supported_yet" in codes(
        {**R, "render": {"type": "continuous", "band": formula, "domain": [-1, 1]}},
        ctx,
    )


def test_service_styles_are_checked_only_when_known(contexts: dict) -> None:
    unknown = replace(contexts["wms"], service_styles=())
    doc = {**R, "render": {"type": "image", "service_style": "grey"}}
    assert "invalid_value" not in codes(doc, unknown)
    doc = {**R, "render": {"type": "image", "service_style": "sepia"}}
    assert "invalid_value" in codes(doc, contexts["wms"])


def test_a_band_formula_is_checked_with_the_formula_parser_the_service_evaluates(
    contexts: dict,
) -> None:
    def formula(expression: str) -> dict:
        band = {"name": "Index", "expression": expression}
        return {**R, "render": {"type": "continuous", "band": band, "domain": [-1, 1]}}

    assert "invalid_band_expression" not in codes(
        formula("(b4 - b1) / (b4 + b1)"), contexts["satellite"]
    )
    for broken in ("b4 +", "(b4 - b1", "b4 b1", "b0 + b1", "b9 - b1", "5"):
        assert "invalid_band_expression" in codes(
            formula(broken), contexts["satellite"]
        ), broken
