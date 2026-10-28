import json

import pytest
from goatlib.style.convert_v0 import convert_v0
from goatlib.style.upgrade import palette_id_for_v0, upgrade
from goatlib.style.validate import validate


def errors(doc: dict, ctx: object) -> list:
    return [(i.code, i.path) for i in validate(doc, ctx) if i.level == "error"]


def test_point_radius_becomes_diameter(contexts: dict) -> None:
    r = convert_v0(
        {"color": [230, 85, 13], "radius": 6, "opacity": 0.8, "filled": True},
        contexts["schools"],
    )
    assert r.document["symbol"]["marker"]["size"] == 12
    assert r.document["symbol"]["marker"]["color"] == "#e6550d"
    assert errors(r.document, contexts["schools"]) == []


def test_label_offset_ems_become_px(contexts: dict) -> None:
    r = convert_v0(
        {"text_label": {"field": "name", "size": 14, "offset": [0, 1.5]}},
        contexts["schools"],
    )
    label = r.document["symbol"]["label"]
    assert label["text"] == "{name}"
    assert label["offset"] == [0, 21]


def test_raster_brightness_and_hillshade_formulas(contexts: dict) -> None:
    img = convert_v0(
        {"style": {"style_type": "image", "brightness_min": 0.2, "brightness_max": 1}},
        contexts["satellite"],
    )
    assert img.document["brightness"] == 0.2
    hs = convert_v0(
        {
            "style": {
                "style_type": "hillshade",
                "azimuth": 315,
                "altitude": 45,
                "z_factor": 3,
            }
        },
        contexts["elevation"],
    )
    assert hs.document["render"]["exaggeration"] == 1
    assert any(n.key == "style.z_factor" for n in hs.lossy)


def test_raster_color_range_becomes_stops(contexts: dict) -> None:
    style = {
        "band": 1,
        "color_map": [[200, "#c7e9c0"], [600, "#74c476"]],
        "style_type": "color_range",
        "interpolate": False,
        "no_data_color": "transparent",
    }
    r = convert_v0({"style": style}, contexts["elevation"])
    assert r.document["render"] == {
        "type": "continuous",
        "band": 1,
        "stops": [
            {"value": 200, "color": "#c7e9c0"},
            {"value": 600, "color": "#74c476"},
        ],
        "interpolate": "nearest",
    }


def test_map_state_leaves_the_style(contexts: dict) -> None:
    r = convert_v0(
        {"visibility": False, "legend": {"show": True, "collapsed": True}},
        contexts["districts"],
    )
    assert r.map_state == {"visible": False, "legend_expanded": False}
    assert "visibility" not in json.dumps(r.document)
    assert "collapsed" not in json.dumps(r.document)


def test_cluster_until_zoom_is_max_zoom_plus_one(contexts: dict) -> None:
    r = convert_v0(
        {"cluster": {"enabled": True, "max_zoom": 14, "color": [40, 56, 178]}},
        contexts["schools"],
    )
    assert r.document["render"]["type"] == "cluster"
    assert r.document["render"]["cluster_until_zoom"] == 15
    assert (
        convert_v0({"cluster": {"enabled": False}}, contexts["schools"]).document.get(
            "render"
        )
        is None
    )


def test_service_layers_get_an_image_style(contexts: dict) -> None:
    r = convert_v0(
        {"visibility": True, "opacity": 0.7, "min_zoom": 10, "resampling": "linear"},
        contexts["wms"],
    )
    assert r.document == {
        "version": 1,
        "kind": "raster",
        "opacity": 0.7,
        "min_zoom": 10,
        "resampling": "linear",
        "render": {"type": "image"},
    }
    assert r.map_state == {"visible": True}


def test_todays_defaults_are_written_when_absent(contexts: dict) -> None:
    r = convert_v0({"color": [1, 2, 3], "filled": True}, contexts["districts"])
    assert r.document["symbol"]["fill"]["opacity"] == 1


def test_quantile_classes_from_stored_breaks(contexts: dict) -> None:
    props = {
        "filled": True,
        "color": [200, 200, 200],
        "color_field": {"name": "density", "type": "number"},
        "color_scale": "quantile",
        "color_range": {
            "name": "ColorBrewer OrRd-3",
            "category": "ColorBrewer",
            "colors": ["#fee8c8", "#fdbb84", "#e34a33"],
        },
        "color_scale_breaks": {
            "min": 100,
            "max": 9000,
            "mean": 3000,
            "breaks": [2800, 3600],
        },
    }
    r = convert_v0(props, contexts["districts"])
    [c] = r.document["classify"]
    assert (c["field"], c["method"], c["palette"], c["count"]) == (
        "density",
        "quantile",
        "colorbrewer:OrRd",
        3,
    )
    assert c["classes"] == [
        {"to": 2800, "fill": {"color": "#fee8c8"}},
        {"from": 2800, "to": 3600, "fill": {"color": "#fdbb84"}},
        {"from": 3600, "fill": {"color": "#e34a33"}},
    ]
    assert errors(r.document, contexts["districts"]) == []


def test_ordinal_colors_become_categories(contexts: dict) -> None:
    props = {
        "filled": True,
        "color_field": {"name": "land_use", "type": "string"},
        "color_scale": "ordinal",
        "color_range": {
            "colors": ["#66c2a5", "#fc8d62"],
            "color_map": [
                [["green"], "#66c2a5"],
                [["mixed", "residential"], "#fc8d62"],
            ],
        },
    }
    [c] = convert_v0(props, contexts["districts"]).document["classify"]
    assert c["method"] == "categories"
    assert c["classes"] == [
        {"values": ["green"], "fill": {"color": "#66c2a5"}},
        {"values": ["mixed", "residential"], "fill": {"color": "#fc8d62"}},
    ]
    assert c["other"] == {"fill": {"color": "#aaaaaa"}}


def test_custom_breaks_with_legend_names(contexts: dict) -> None:
    props = {
        "filled": True,
        "color_field": {"name": "population", "type": "number"},
        "color_scale": "custom_breaks",
        "color_range": {
            "colors": ["#fee5d9", "#fcae91"],
            "color_map": [[["1"], "#fee5d9"], [["15000"], "#fcae91"]],
            "color_legends": {"1": "Small", "15000": "Large"},
        },
    }
    [c] = convert_v0(props, contexts["districts"]).document["classify"]
    assert c["method"] == "manual"
    assert c["classes"] == [
        {"to": 15000, "name": "Small", "fill": {"color": "#fee5d9"}},
        {"from": 15000, "name": "Large", "fill": {"color": "#fcae91"}},
    ]


def test_library_markers_become_lib_icons(contexts: dict) -> None:
    props = {
        "custom_marker": True,
        "marker": {
            "url": "https://assets.plan4better.de/icons/maki/park.svg",
            "name": "park",
        },
        "marker_size": 24,
        "color": [0, 0, 0],
        "marker_anchor": "bottom-left",
    }
    marker = convert_v0(props, contexts["schools"]).document["symbol"]["marker"]
    assert (marker["shape"], marker["icon"], marker["size"], marker["anchor"]) == (
        "icon",
        "goat:park",
        24,
        "bottom_left",
    )


def test_line_arrows_and_dash(contexts: dict) -> None:
    props = {
        "stroke_color": [33, 102, 172],
        "stroke_width": 3,
        "stroke_pattern": "dashed",
        "stroke_dash_density": "tight",
        "decoration_type": "arrow",
        "decoration_placement": "start_and_end",
        "decoration_allow_overlap": False,
    }
    r = convert_v0(props, contexts["routes"])
    assert r.document["symbol"]["line"]["dash"] == "dashed"
    assert r.document["symbol"]["arrows"]["placement"] == "both_ends"
    assert {n.key for n in r.lossy} >= {
        "stroke_dash_density",
        "decoration_allow_overlap",
    }
    assert errors(r.document, contexts["routes"]) == []


@pytest.mark.parametrize(
    "junk",
    [
        {},
        {"color": None},
        {"color": "red"},
        {"color": [1, 2, 3, 4]},
        {"radius": "big"},
        {"text_label": "x"},
        {"popup": 5},
        {"color_range": {"colors": None}},
        {"color_field": {"name": None}, "color_scale": "quantile"},
        {"style": "x"},
        {"cluster": []},
    ],
)
def test_converter_never_raises_on_junk(junk: dict, contexts: dict) -> None:
    for name in ("schools", "routes", "districts", "elevation", "wms"):
        convert_v0(junk, contexts[name])


def test_upgrade_reads_version_0_and_keeps_version_1(contexts: dict) -> None:
    assert upgrade({"color": [1, 2, 3]}, contexts["districts"]).version_from == 0
    v1 = {"version": 1, "kind": "vector"}
    r = upgrade(v1, contexts["districts"])
    assert (r.document, r.version_from, r.lossy, r.map_state) == (v1, 1, (), {})


def test_palette_ids_for_todays_ranges() -> None:
    assert (
        palette_id_for_v0(
            {
                "name": "ColorBrewer OrRd-6",
                "category": "ColorBrewer",
                "colors": ["#fef0d9"] * 6,
            }
        )
        == "colorbrewer:OrRd"
    )
    assert (
        palette_id_for_v0(
            {
                "name": "Global Warming",
                "category": "Uber",
                "colors": ["#5a1846", "#ffc300"],
            }
        )
        == "uber:global_warming"
    )
    assert palette_id_for_v0({"name": "Mine", "colors": ["#000000", "#ffffff"]}) == [
        "#000000",
        "#ffffff",
    ]


def test_custom_marker_without_a_base_icon_draws_only_mapped_values(
    contexts: dict,
) -> None:
    props = {
        "custom_marker": True,
        "marker_field": {"name": "type", "type": "string"},
        "marker_mapping": [
            [["primary"], {"name": "school", "url": "x", "source": "library"}],
            [["x"], {"id": "", "url": "", "name": "", "source": "custom"}],
        ],
    }
    r = convert_v0(props, contexts["schools"])
    assert r.document["symbol"]["marker"]["shape"] == "icon"
    [c] = r.document["classify"]
    assert c["classes"] == [{"values": ["primary"], "marker": {"icon": "goat:school"}}]
    assert c["other"] == {"visible": False}
    assert [
        i for i in validate(r.document, contexts["schools"]) if i.level == "error"
    ] == []


def test_custom_marker_without_any_icon_is_switched_off(contexts: dict) -> None:
    r = convert_v0({"custom_marker": True}, contexts["schools"])
    assert r.document["symbol"]["marker"] is False
    assert any(n.key == "marker" for n in r.lossy)


def test_an_empty_zoom_range_hides_the_layer_as_today(contexts: dict) -> None:
    r = convert_v0(
        {"min_zoom": 1, "max_zoom": 1, "visibility": True}, contexts["districts"]
    )
    assert "min_zoom" not in r.document and "max_zoom" not in r.document
    assert r.map_state["visible"] is False
    assert any(n.key == "min_zoom" for n in r.lossy)


def test_todays_label_defaults_are_not_lossy(contexts: dict) -> None:
    tl = {
        "field": "name",
        "anchor": "center",
        "alignment": "center",
        "background": False,
        "font_family": ["Open Sans Regular", "Arial Unicode MS Regular"],
        "background_color": [0, 0, 0, 0],
    }
    assert convert_v0({"text_label": tl}, contexts["schools"]).lossy == ()


def test_library_icons_missing_from_the_catalogue_stay_library_icons(
    contexts: dict,
) -> None:
    props = {
        "custom_marker": True,
        "marker": {
            "url": "https://assets.plan4better.de/icons/maki/not_in_catalogue_icon.svg",
            "name": "not_in_catalogue_icon",
        },
    }
    r = convert_v0(props, contexts["schools"])
    assert r.document["symbol"]["marker"]["icon"] == "goat:not_in_catalogue_icon"
    assert r.lossy == ()
    assert "unknown_icon" in {i.code for i in validate(r.document, contexts["schools"])}


def test_icons_from_other_hosts_are_lost(contexts: dict) -> None:
    props = {
        "custom_marker": True,
        "marker": {"url": "https://example.org/pin.svg", "name": "pin"},
    }
    r = convert_v0(props, contexts["schools"])
    assert r.document["symbol"]["marker"] is False
    assert {n.key for n in r.lossy} == {"marker"}


def test_popup_sizes_are_capped(contexts: dict) -> None:
    r = convert_v0(
        {
            "popup": {
                "enabled": True,
                "mode": "html",
                "html": "<p>x</p>",
                "max_height": 9999,
                "width": 0,
            }
        },
        contexts["schools"],
    )
    assert r.document["popup"]["max_height"] == 4000
    assert "width" not in r.document["popup"]


def test_library_icons_take_the_file_name_from_their_url(contexts: dict) -> None:
    props = {
        "custom_marker": True,
        "marker": {
            "url": "https://assets.plan4better.de/icons/maki/food_vending_machine.svg",
            "name": "vending-machine",
            "source": "library",
        },
    }
    assert (
        convert_v0(props, contexts["schools"]).document["symbol"]["marker"]["icon"]
        == "goat:food_vending_machine"
    )


def test_uploaded_icons_without_an_id_are_found_by_url(contexts: dict) -> None:
    url = "https://assets.plan4better.de/goat/prod/users/u1/icon/f451cd0e.svg"
    props = {
        "custom_marker": True,
        "marker": {"url": url, "name": "bus final", "source": "custom"},
    }
    found = convert_v0(
        props,
        contexts["schools"],
        asset_for_url={"goat/prod/users/u1/icon/f451cd0e.svg": "e44bc903-d7a0"}.get,
    )
    assert found.document["symbol"]["marker"]["icon"] == "asset:e44bc903-d7a0"
    lost = convert_v0(props, contexts["schools"])
    assert lost.document["symbol"]["marker"] is False


def test_repeated_size_breaks_collapse(contexts: dict) -> None:
    props = {
        "radius_field": {"name": "pupils", "type": "number"},
        "radius_scale": "quantile",
        "radius_range": [2, 10],
        "radius_scale_breaks": {"min": 3, "max": 91, "mean": 6, "breaks": [3, 3, 5, 8]},
    }
    r = convert_v0(props, contexts["schools"])
    [c] = r.document["classify"]
    assert [(k.get("from"), k.get("to")) for k in c["classes"]] == [
        (None, 3),
        (3, 5),
        (5, 8),
        (8, None),
    ]
    assert [
        i for i in validate(r.document, contexts["schools"]) if i.level == "error"
    ] == []


def test_a_category_value_in_two_classes_stays_with_the_first(contexts: dict) -> None:
    props = {
        "filled": True,
        "color_field": {"name": "land_use", "type": "string"},
        "color_scale": "ordinal",
        "color_range": {
            "colors": ["#66c2a5", "#fc8d62"],
            "color_map": [[["green", "mixed"], "#66c2a5"], [["mixed"], "#fc8d62"]],
        },
    }
    [c] = convert_v0(props, contexts["districts"]).document["classify"]
    assert [k["values"] for k in c["classes"]] == [["green", "mixed"]]


def test_a_value_in_two_icon_classes_stays_with_the_first(contexts: dict) -> None:
    lib = {"name": "school", "url": "x", "source": "library"}
    props = {
        "custom_marker": True,
        "marker": lib,
        "marker_field": {"name": "type", "type": "string"},
        "marker_mapping": [
            [["primary", "special"], lib],
            [["special"], {"name": "park", "url": "y", "source": "library"}],
        ],
    }
    [c] = convert_v0(props, contexts["schools"]).document["classify"]
    assert [k["values"] for k in c["classes"]] == [["primary", "special"]]


def test_a_transparent_no_data_color_hides_only_that_color(contexts: dict) -> None:
    props = {
        "filled": True,
        "color_field": {"name": "land_use", "type": "string"},
        "color_scale": "ordinal",
        "color_no_data": "transparent",
        "color_range": {"colors": ["#66c2a5"], "color_map": [[["green"], "#66c2a5"]]},
    }
    [c] = convert_v0(props, contexts["districts"]).document["classify"]
    assert c["no_data"] == {"fill": {"color": "#00000000"}}


def test_icon_offsets_scale_with_the_icon(contexts: dict) -> None:
    props = {
        "custom_marker": True,
        "marker": {"name": "park", "url": "u", "source": "library"},
        "marker_size": 100,
        "marker_offset": [0, -2],
        "filled": True,
    }
    assert convert_v0(props, contexts["schools"]).document["symbol"]["marker"][
        "offset"
    ] == [0, -1]


def test_boolean_category_values_read_as_true_and_false(contexts: dict) -> None:
    props = {
        "stroke_color_field": {"name": "oneway", "type": "boolean"},
        "stroke_color_scale": "ordinal",
        "stroke_color_range": {
            "colors": ["#000000"],
            "color_map": [[[True], "#000000"]],
        },
    }
    [c] = convert_v0(props, contexts["routes"]).document["classify"]
    assert c["classes"][0]["values"] == ["true"]


def test_every_label_anchor_but_center_and_bottom_is_a_loss(contexts: dict) -> None:
    assert any(
        n.key == "text_label.anchor"
        for n in convert_v0(
            {"text_label": {"field": "name"}}, contexts["schools"]
        ).lossy
    )
    assert not convert_v0(
        {"text_label": {"field": "name", "anchor": "bottom"}}, contexts["schools"]
    ).lossy


def test_repeated_color_breaks_pair_like_todays_renderer(contexts: dict) -> None:
    props = {
        "filled": True,
        "color_field": {"name": "density", "type": "number"},
        "color_scale": "quantile",
        "color_range": {"colors": ["#000001", "#000002", "#000003", "#000004"]},
        "color_scale_breaks": {
            "min": 0,
            "max": 100,
            "mean": 50,
            "breaks": [10, 10, 50],
        },
    }
    [c] = convert_v0(props, contexts["districts"]).document["classify"]
    assert [(k.get("from"), k.get("to"), k["fill"]["color"]) for k in c["classes"]] == [
        (None, 10, "#000002"),
        (10, 50, "#000003"),
        (50, None, "#000004"),
    ]


def test_absent_keys_draw_like_todays_renderer(contexts: dict) -> None:
    poly = convert_v0({"color": [1, 2, 3]}, contexts["districts"]).document["symbol"]
    assert poly["fill"] is False and poly["outline"] is False
    line = convert_v0({"stroke_color": [1, 2, 3]}, contexts["routes"]).document[
        "symbol"
    ]["line"]
    assert (line["width"], line["opacity"]) == (1, 1)


def test_an_absent_icon_size_draws_like_today(contexts: dict) -> None:
    props = {
        "custom_marker": True,
        "marker": {"name": "park", "url": "u", "source": "library"},
    }
    assert (
        convert_v0(props, contexts["schools"]).document["symbol"]["marker"]["size"]
        == 100
    )


def test_features_without_a_value_keep_todays_unmatched_color(contexts: dict) -> None:
    # Today's match reads a missing value as "" and draws it in the unmatched color; `other` covers values only.
    props = {
        "filled": True,
        "color_field": {"name": "land_use", "type": "string"},
        "color_scale": "ordinal",
        "color_range": {"colors": ["#66c2a5"], "color_map": [[["green"], "#66c2a5"]]},
    }
    [c] = convert_v0(props, contexts["districts"]).document["classify"]
    assert c["no_data"] == {"fill": {"color": "#aaaaaa"}}


def test_mapped_icons_without_a_base_icon_hide_features_without_a_value(
    contexts: dict,
) -> None:
    props = {
        "custom_marker": True,
        "marker_field": {"name": "type", "type": "string"},
        "marker_mapping": [
            [["primary"], {"name": "school", "url": "x", "source": "library"}]
        ],
    }
    [c] = convert_v0(props, contexts["schools"]).document["classify"]
    assert c["no_data"] == {"visible": False}


def test_unfilled_points_become_hollow_markers(contexts: dict) -> None:
    r = convert_v0(
        {
            "color": [230, 85, 13],
            "opacity": 0.8,
            "filled": False,
            "stroked": True,
            "stroke_color": [0, 0, 0],
        },
        contexts["schools"],
    )
    marker = r.document["symbol"]["marker"]
    assert marker["fill"] is False
    assert marker["opacity"] == 0.8
    assert r.document["symbol"]["outline"]["color"] == "#000000"
    assert errors(r.document, contexts["schools"]) == []


def test_upgrade_brings_stored_values_inside_maplibres_bounds(contexts: dict) -> None:
    terrain = {
        "version": 1,
        "kind": "raster",
        "render": {"type": "terrain", "direction": 360, "exaggeration": 1.5},
    }
    r = upgrade(terrain, contexts["elevation"])
    assert r.document["render"] == {
        "type": "terrain",
        "direction": 0,
        "exaggeration": 1,
    }
    assert {n.key for n in r.lossy} == {"/render/direction", "/render/exaggeration"}
    assert terrain["render"]["direction"] == 360  # the stored document is not changed
    assert errors(r.document, contexts["elevation"]) == []

    heatmap = {
        "version": 1,
        "kind": "vector",
        "render": {
            "type": "heatmap",
            "radius": {"zoom": [[10, 0], [14, 40]]},
            "weight": -1,
        },
    }
    r = upgrade(heatmap, contexts["schools"])
    assert r.document["render"]["radius"] == {"zoom": [[10, 1], [14, 40]]}
    assert r.document["render"]["weight"] == 0
    assert {n.key for n in r.lossy} == {"/render/radius", "/render/weight"}
    assert errors(r.document, contexts["schools"]) == []

    arrows = {
        "version": 1,
        "kind": "vector",
        "symbol": {"line": {"offset": -4}, "arrows": {"spacing": 0}},
    }
    r = upgrade(arrows, contexts["routes"])
    assert r.document["symbol"] == {"line": {"offset": -4}, "arrows": {"spacing": 1}}
    assert {n.key for n in r.lossy} == {"/symbol/arrows/spacing"}
    assert errors(r.document, contexts["routes"]) == []


def test_upgrade_brings_arrows_in_rules_and_classes_inside(contexts: dict) -> None:
    doc = {
        "version": 1,
        "kind": "vector",
        "rules": [{"id": "r1", "arrows": {"spacing": 0}}],
        "classify": [{"id": "k", "classes": [{"id": "c1", "arrows": {"spacing": -5}}]}],
    }
    r = upgrade(doc, contexts["routes"])
    assert r.document["rules"][0]["arrows"]["spacing"] == 1
    assert r.document["classify"][0]["classes"][0]["arrows"]["spacing"] == 1
    assert {n.key for n in r.lossy} == {
        "/rules/r1/arrows/spacing",
        "/classify/k/classes/c1/arrows/spacing",
    }


def test_upgrade_keeps_a_document_inside_the_bounds_as_it_is(contexts: dict) -> None:
    doc = {
        "version": 1,
        "kind": "raster",
        "render": {"type": "terrain", "direction": 359, "exaggeration": 1},
    }
    r = upgrade(doc, contexts["elevation"])
    assert r.document is doc and r.lossy == ()


def test_a_strict_upgrade_leaves_a_current_document_for_the_validator(
    contexts: dict,
) -> None:
    """A document written now is not brought inside: its values outside the
    bounds are errors with their place, the value and the bound."""
    doc = {
        "version": 1,
        "kind": "raster",
        "render": {"type": "terrain", "direction": 360},
    }
    r = upgrade(doc, contexts["elevation"], strict=True)
    assert r.document is doc and r.lossy == ()
    issues = [i for i in validate(doc, contexts["elevation"]) if i.level == "error"]
    assert [(i.code, i.path) for i in issues] == [
        ("invalid_value", "/render/direction")
    ]
    assert issues[0].message == "360 is more than 359, the most this takes."

    arrows = {
        "version": 1,
        "kind": "vector",
        "symbol": {"line": {"offset": -4}, "arrows": {"spacing": 0}},
    }
    r = upgrade(arrows, contexts["routes"], strict=True)
    assert r.document is arrows and r.lossy == ()
    [issue] = validate(arrows, contexts["routes"])
    assert (issue.path, issue.message) == (
        "/symbol/arrows/spacing",
        "0 is less than 1, the least this takes.",
    )


def test_a_strict_upgrade_still_converts_an_older_document_inside_the_bounds(
    contexts: dict,
) -> None:
    r = upgrade(
        {"style": {"style_type": "hillshade", "azimuth": 360}},
        contexts["elevation"],
        strict=True,
    )
    assert r.document["render"]["direction"] == 0
    assert errors(r.document, contexts["elevation"]) == []


def test_todays_hillshade_and_arrows_convert_inside_maplibres_bounds(
    contexts: dict,
) -> None:
    hs = convert_v0(
        {"style": {"style_type": "hillshade", "azimuth": 360, "z_factor": -1}},
        contexts["elevation"],
    )
    assert hs.document["render"]["direction"] == 0
    assert hs.document["render"]["exaggeration"] == 0
    assert errors(hs.document, contexts["elevation"]) == []
    props = {
        "stroke_offset": -2,
        "decoration_type": "arrow",
        "decoration_spacing": 0,
    }
    r = convert_v0(props, contexts["routes"])
    assert r.document["symbol"]["line"]["offset"] == -2
    assert r.document["symbol"]["arrows"]["spacing"] == 1
    assert errors(r.document, contexts["routes"]) == []
