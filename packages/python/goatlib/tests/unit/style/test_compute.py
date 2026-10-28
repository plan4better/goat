"""Computed values written into a style (the specification's section 12)."""

import copy
from typing import Any

import pytest
from goatlib.style.colors import range_values, sample_colors
from goatlib.style.compute import (
    Breaks,
    apply_computed,
    breaks_for_classes,
    needed_stats,
    same_ignoring_stamps,
)
from goatlib.style.context import DataContext
from goatlib.style.validate import validate

QUANTILE = {
    "version": 1,
    "kind": "vector",
    "symbol": {"fill": {"color": "#cccccc"}},
    "classify": [
        {
            "id": "density",
            "field": "density",
            "method": "quantile",
            "count": 5,
            "palette": "colorbrewer:OrRd",
        }
    ],
}
KEY = ("breaks", "density", "quantile", "5")
STATS = {KEY: Breaks((2800, 3600, 4300, 6300), 1000, 9000, False)}


def compute(
    doc: dict[str, Any], stats: dict, geometry: str | None = "polygon", **kw: Any
) -> tuple[dict[str, Any], list]:
    out, notes = apply_computed(
        doc,
        stats,
        geometry=geometry,
        fingerprint=kw.get("fingerprint", "f"),
        at=kw.get("at", "t"),
    )
    errors = [
        i
        for i in validate(out, DataContext(kind="vector", geometry=geometry))
        if i.level == "error"
    ]
    assert errors == []
    return out, notes


def test_breaks_for_classes_drop_edges_and_merge() -> None:
    assert breaks_for_classes([1000, 2800, 2800, 9000], 1000, 9000, 5) == Breaks(
        (2800,), 1000, 9000, True
    )
    assert breaks_for_classes([], None, None, 5) == Breaks((), None, None, False)


def test_intent_becomes_the_stored_classes_of_spec_5_2() -> None:
    doc, notes = compute(
        QUANTILE, STATS, fingerprint="ducklake:7", at="2026-10-24T10:00:00Z"
    )
    c = doc["classify"][0]
    assert [(k.get("from"), k.get("to"), k["fill"]["color"]) for k in c["classes"]] == [
        (None, 2800, "#fef0d9"),
        (2800, 3600, "#fdcc8a"),
        (3600, 4300, "#fc8d59"),
        (4300, 6300, "#e34a33"),
        (6300, None, "#b30000"),
    ]
    assert [k["id"] for k in c["classes"]] == ["c1", "c2", "c3", "c4", "c5"]
    assert c["computed"] == {
        "at": "2026-10-24T10:00:00Z",
        "data": "ducklake:7",
        "scope": "dataset",
        "domain": [1000, 9000],
        "generated": {
            "target": "fill.color",
            "values": {
                "c1": "#fef0d9",
                "c2": "#fdcc8a",
                "c3": "#fc8d59",
                "c4": "#e34a33",
                "c5": "#b30000",
            },
        },
    }
    assert notes == [] and "classes" not in QUANTILE["classify"][0]


def test_recompute_keeps_hand_picks_by_position() -> None:
    first, _ = compute(QUANTILE, STATS, fingerprint="f1", at="t1")
    first["classify"][0]["classes"][1].update(
        {"name": "Medium", "fill": {"color": "#123456"}}
    )
    again, _ = compute(
        first,
        {KEY: Breaks((2900, 3700, 4400, 6400), 1000, 9500, False)},
        fingerprint="f2",
        at="t2",
    )
    k = again["classify"][0]["classes"][1]
    assert (k["id"], k["from"], k["to"], k["name"], k["fill"]["color"]) == (
        "c2",
        2900,
        3700,
        "Medium",
        "#123456",
    )


def test_classes_listed_by_position_get_the_palette_where_they_set_nothing() -> None:
    doc = copy.deepcopy(QUANTILE)
    doc["classify"][0]["count"] = 3
    doc["classify"][0]["classes"] = [
        {"name": "Low"},
        {"name": "Mid", "fill": {"color": "#000000"}},
        {"name": "High"},
    ]
    out, _ = compute(
        doc,
        {
            ("breaks", "density", "quantile", "3"): Breaks(
                (3000, 5000), 1000, 9000, False
            )
        },
    )
    classes = out["classify"][0]["classes"]
    colors = sample_colors("colorbrewer:OrRd", 3)
    assert [k["fill"]["color"] for k in classes] == [colors[0], "#000000", colors[2]]
    assert [k["name"] for k in classes] == ["Low", "Mid", "High"]


def test_merged_breaks_rebuild_and_say_so() -> None:
    doc, notes = compute(QUANTILE, {KEY: Breaks((3000, 5000), 1000, 9000, True)})
    classes = doc["classify"][0]["classes"]
    assert [k["fill"]["color"] for k in classes] == sample_colors("colorbrewer:OrRd", 3)
    assert [n.code for n in notes] == ["classes_merged"]
    assert notes[0].level == "info" and notes[0].path == "/classify/density"


def test_one_value_everywhere_gives_one_class() -> None:
    doc, notes = compute(QUANTILE, {KEY: Breaks((), 7, 7, True)})
    classes = doc["classify"][0]["classes"]
    assert len(classes) == 1 and "from" not in classes[0] and "to" not in classes[0]
    assert classes[0]["fill"]["color"] == sample_colors("colorbrewer:OrRd", 1)[0]
    assert [n.code for n in notes] == ["classes_merged"]


def test_number_targets_take_the_range() -> None:
    doc = {
        **QUANTILE,
        "classify": [
            {
                "id": "p",
                "field": "population",
                "method": "equal_interval",
                "count": 4,
                "target": "outline.width",
                "range": [0.5, 4],
            }
        ],
    }
    out, _ = compute(
        doc,
        {
            ("breaks", "population", "equal_interval", "4"): Breaks(
                (11000, 16000, 21000), 6000, 26000, False
            )
        },
    )
    assert [k["outline"]["width"] for k in out["classify"][0]["classes"]] == [
        0.5,
        1.7,
        2.8,
        4.0,
    ]


def test_number_targets_without_a_range_take_the_default_one() -> None:
    doc = {
        **QUANTILE,
        "classify": [
            {
                "id": "p",
                "field": "population",
                "method": "equal_interval",
                "count": 3,
                "target": "fill.opacity",
            }
        ],
    }
    out, _ = compute(
        doc,
        {
            ("breaks", "population", "equal_interval", "3"): Breaks(
                (11000, 16000), 6000, 26000, False
            )
        },
    )
    assert [k["fill"]["opacity"] for k in out["classify"][0]["classes"]] == [
        0.2,
        0.6,
        1.0,
    ]


def test_choice_targets_and_no_geometry_get_bounds_only() -> None:
    dash = {
        **QUANTILE,
        "classify": [
            {
                "id": "d",
                "field": "density",
                "method": "quantile",
                "count": 2,
                "target": "outline.dash",
            }
        ],
    }
    out, _ = compute(
        dash,
        {("breaks", "density", "quantile", "2"): Breaks((5000,), 1000, 9000, False)},
    )
    assert out["classify"][0]["classes"] == [
        {"id": "c1", "to": 5000},
        {"id": "c2", "from": 5000},
    ]
    plain = {
        **dash,
        "symbol": {},
        "classify": [{**dash["classify"][0], "target": None}],
    }
    del plain["classify"][0]["target"]
    out, _ = apply_computed(
        plain,
        {("breaks", "density", "quantile", "2"): Breaks((5000,), 1000, 9000, False)},
        geometry=None,
        fingerprint="f",
        at="t",
    )
    assert out["classify"][0]["classes"] == [
        {"id": "c1", "to": 5000},
        {"id": "c2", "from": 5000},
    ]


def test_top_categories_domains_and_manual() -> None:
    cats = {
        "version": 1,
        "kind": "vector",
        "classify": [{"id": "t", "field": "type", "method": "categories", "count": 2}],
    }
    out, _ = compute(
        cats, {("top", "type", "2"): [("school", 40), ("park", 12)]}, "point"
    )
    classes = out["classify"][0]["classes"]
    assert [k["values"] for k in classes] == [["school"], ["park"]]
    assert [k["marker"]["color"] for k in classes] == sample_colors(
        "colorbrewer:Set2", 2
    )
    assert "other" not in out["classify"][0]
    marker = {
        "version": 1,
        "kind": "vector",
        "symbol": {
            "marker": {
                "size": {"field": "pupils", "range": [2, 12]},
                "color": {
                    "field": "pupils",
                    "palette": "d3:viridis",
                    "domain": [0, 1500],
                },
            }
        },
    }
    out, _ = compute(marker, {("range", "pupils"): (20.0, 1200.0)}, "point")
    assert out["symbol"]["marker"]["size"]["computed"] == {
        "at": "t",
        "data": "f",
        "scope": "dataset",
        "domain": [20.0, 1200.0],
    }
    assert "computed" not in out["symbol"]["marker"]["color"]
    manual = {
        **QUANTILE,
        "classify": [
            {
                "id": "m",
                "field": "density",
                "method": "manual",
                "classes": [{"to": 5}, {"from": 5}],
            }
        ],
    }
    assert needed_stats(manual) == [("range", "density")]
    out, _ = compute(manual, {("range", "density"): (0.73, 100.0)})
    # Manual classes stay the author's; the data's ends label the open classes.
    assert out["classify"][0]["classes"] == manual["classify"][0]["classes"]
    assert out["classify"][0]["computed"] == {
        "at": "t",
        "data": "f",
        "scope": "dataset",
        "domain": [0.73, 100.0],
    }
    again, notes = compute(out, {}, fingerprint="g")
    assert again["classify"][0]["computed"]["domain"] == [0.73, 100.0]
    assert notes == []
    empty, notes = compute(manual, {("range", "density"): (None, None)})
    assert "domain" not in empty["classify"][0]["computed"]
    assert [n.code for n in notes] == ["no_values"]


def test_categories_recompute_keeps_classes_by_value() -> None:
    cats = {
        "version": 1,
        "kind": "vector",
        "symbol": {"marker": {"color": "#999999"}},
        "classify": [
            {
                "id": "t",
                "field": "type",
                "method": "categories",
                "count": 2,
                "classes": [
                    {
                        "id": "c1",
                        "values": ["school"],
                        "name": "Schools",
                        "marker": {"color": "#111111"},
                    },
                    {
                        "id": "c2",
                        "values": ["park"],
                        "name": "Parks",
                        "marker": {"color": "#222222"},
                    },
                ],
                "other": {"name": "Other"},
                "computed": {"at": "t0", "data": "f0", "scope": "dataset"},
            }
        ],
    }
    out, _ = compute(
        cats, {("top", "type", "2"): [("park", 50), ("pool", 30)]}, "point"
    )
    c = out["classify"][0]
    # A dropped class's id is not reused: an open editor may still address it.
    assert [(k["id"], k["values"], k.get("name")) for k in c["classes"]] == [
        ("c2", ["park"], "Parks"),
        ("c3", ["pool"], None),
    ]
    assert c["classes"][0]["marker"]["color"] == "#222222"
    assert c["classes"][1]["marker"]["color"] != "#222222"
    assert c["other"] == {"name": "Other"}


def test_value_forms_in_zoom_stops_and_scales() -> None:
    doc = {
        "version": 1,
        "kind": "vector",
        "symbol": {
            "marker": {
                "size": {
                    "zoom": [
                        [5, {"field": "pupils", "range": [1, 4]}],
                        [12, {"field": "pupils", "range": [2, 12], "scale": "log"}],
                    ]
                }
            }
        },
    }
    assert needed_stats(doc) == [("range", "pupils"), ("range", "pupils", "log")]
    out, _ = compute(
        doc,
        {("range", "pupils"): (0.0, 1200.0), ("range", "pupils", "log"): (3.0, 1200.0)},
        "point",
    )
    stops = out["symbol"]["marker"]["size"]["zoom"]
    assert stops[0][1]["computed"]["domain"] == [0.0, 1200.0]
    assert stops[1][1]["computed"]["domain"] == [3.0, 1200.0]


def test_a_color_on_a_log_scale_reads_its_range_above_zero() -> None:
    doc = {
        "version": 1,
        "kind": "vector",
        "symbol": {
            "marker": {
                "color": {"field": "share", "palette": "goat:green", "scale": "log"}
            }
        },
    }
    assert needed_stats(doc) == [("range", "share", "log")]
    out, _ = compute(doc, {("range", "share", "log"): (0.5, 100.0)}, "point")
    assert out["symbol"]["marker"]["color"]["computed"]["domain"] == [0.5, 100.0]


def test_needed_stats_stamps_and_empty_data() -> None:
    assert needed_stats(QUANTILE) == [KEY]
    no_count = copy.deepcopy(QUANTILE)
    del no_count["classify"][0]["count"]
    assert needed_stats(no_count) == [("breaks", "density", "quantile", "5")]
    a, _ = compute(QUANTILE, STATS, fingerprint="f1", at="t1")
    b, _ = compute(QUANTILE, STATS, fingerprint="f2", at="t2")
    assert a != b and same_ignoring_stamps(a, b)
    assert not same_ignoring_stamps(a, QUANTILE)
    empty, notes = compute(QUANTILE, {KEY: Breaks((), None, None, False)})
    assert "classes" not in empty["classify"][0]
    assert [(n.code, n.level, n.path) for n in notes] == [
        ("no_values", "info", "/classify/density")
    ]
    assert empty["classify"][0]["computed"] == {
        "at": "t",
        "data": "f",
        "scope": "dataset",
    }


def test_numeric_classes_keep_the_data_minimum_and_maximum() -> None:
    """The open first and last classes are labelled with the data's ends."""
    one, _ = compute(QUANTILE, {KEY: Breaks((), 4.5, 4.5, True)})
    c = one["classify"][0]
    assert [("from" in k, "to" in k) for k in c["classes"]] == [(False, False)]
    assert c["computed"]["domain"] == [4.5, 4.5]
    cats = {
        "version": 1,
        "kind": "vector",
        "classify": [{"id": "t", "field": "type", "method": "categories", "count": 2}],
    }
    out, _ = compute(cats, {("top", "type", "2"): [("school", 40)]}, "point")
    assert "domain" not in out["classify"][0]["computed"]


def test_numeric_classes_computed_without_the_data_ends_are_computed_again() -> None:
    from goatlib.style.fingerprint import is_stale

    out, _ = compute(QUANTILE, STATS, fingerprint="ducklake:1")
    assert not is_stale(out, "ducklake:1")
    del out["classify"][0]["computed"]["domain"]
    assert is_stale(out, "ducklake:1")
    empty, _ = compute(QUANTILE, {KEY: Breaks((), None, None, False)}, fingerprint="d")
    assert not is_stale(empty, "d")
    # Stamped without `generated` (a migrated or copied style): its classes stay.
    del out["classify"][0]["computed"]["generated"]
    assert not is_stale(out, "ducklake:1")


def test_a_stamped_copy_keeps_the_data_ends() -> None:
    from goatlib.style.compute import stamp_computed

    out, _ = compute(QUANTILE, STATS, fingerprint="ducklake:1")
    copied = stamp_computed(out, "ducklake:9", "t9")
    assert copied["classify"][0]["computed"] == {
        "at": "t9",
        "data": "ducklake:9",
        "scope": "dataset",
        "domain": [1000, 9000],
    }


def test_categories_with_classes_but_no_count_are_the_authors() -> None:
    cats = {
        "version": 1,
        "kind": "vector",
        "classify": [
            {
                "id": "t",
                "field": "type",
                "method": "categories",
                "classes": [{"values": ["a"]}],
            }
        ],
    }
    assert needed_stats(cats) == []


def test_every_number_target_has_a_default_range() -> None:
    from goatlib.style.colors import default_range
    from goatlib.style.models.classify import TARGET_KINDS

    for path, kind in TARGET_KINDS.items():
        if kind == "number":
            assert default_range(path)


MALFORMED = [
    {"palette": 5},
    {"palette": [1, 2]},
    {"target": "outline.width", "range": ["a", "b"]},
    {"classes": [{"fill": "x"} for _ in range(5)]},
    {"classes": [{"label": "x"} for _ in range(5)]},
    {"classes": [{"label": {"halo": "x"}} for _ in range(5)]},
    {"count": 101},
]


@pytest.mark.parametrize("change", MALFORMED)
def test_malformed_classifications_are_left_to_the_checks(change: dict) -> None:
    doc = {**QUANTILE, "classify": [{**QUANTILE["classify"][0], **change}]}
    assert needed_stats(doc) == []
    out, notes = apply_computed(doc, STATS, geometry="polygon", fingerprint="f", at="t")
    assert out == doc and notes == []


def test_malformed_value_forms_are_left_to_the_checks() -> None:
    doc = {
        "version": 1,
        "kind": "vector",
        "symbol": {"marker": {"size": {"field": "pupils", "range": ["a", "b"]}}},
    }
    assert needed_stats(doc) == []
    out, _ = apply_computed(
        doc,
        {("range", "pupils"): (1.0, 2.0)},
        geometry="point",
        fingerprint="f",
        at="t",
    )
    assert out == doc


def test_count_above_a_hundred_is_invalid() -> None:
    doc = {**QUANTILE, "classify": [{**QUANTILE["classify"][0], "count": 101}]}
    issues = validate(doc, DataContext(kind="vector", geometry="polygon"))
    assert any(
        i.code == "invalid_value" and i.path == "/classify/density/count"
        for i in issues
    )


def test_parts_no_longer_computed_lose_their_stamp() -> None:
    stale = {"at": "t0", "data": "f0", "scope": "dataset"}
    doc = {
        "version": 1,
        "kind": "vector",
        "symbol": {
            "fill": {
                "color": {
                    "field": "density",
                    "palette": "d3:viridis",
                    "domain": [0, 10],
                    "computed": {**stale, "domain": [1, 9]},
                }
            }
        },
        "classify": [
            {
                "id": "m",
                "field": "density",
                "method": "categories",
                "classes": [{"values": [5]}],
                "computed": stale,
            },
            {
                "id": "t",
                "field": "kind",
                "method": "categories",
                "classes": [{"values": ["a"]}],
                "computed": stale,
            },
        ],
    }
    out, _ = compute(doc, {})
    assert "computed" not in out["symbol"]["fill"]["color"]
    assert all("computed" not in c for c in out["classify"])


def _colors(doc: dict[str, Any], part: str = "fill", key: str = "color") -> list[Any]:
    return [k.get(part, {}).get(key) for k in doc["classify"][0]["classes"]]


def test_generated_colors_follow_the_palette_and_hand_picks_stay() -> None:
    first, _ = compute(QUANTILE, STATS)
    first["classify"][0]["classes"][1]["fill"]["color"] = "#123456"
    first["classify"][0]["palette"] = "colorbrewer:Blues"
    blues, _ = compute(first, STATS)
    expected = sample_colors("colorbrewer:Blues", 5)
    expected[1] = "#123456"
    assert _colors(blues) == expected
    blues["classify"][0]["reverse"] = True
    reversed_, _ = compute(blues, STATS)
    expected = sample_colors("colorbrewer:Blues", 5, reverse=True)
    expected[1] = "#123456"
    assert _colors(reversed_) == expected


def test_generated_numbers_follow_the_range() -> None:
    doc = {
        **QUANTILE,
        "classify": [
            {
                "id": "p",
                "field": "density",
                "method": "quantile",
                "count": 5,
                "target": "outline.width",
                "range": [0.5, 4],
            }
        ],
    }
    first, _ = compute(doc, STATS)
    first["classify"][0]["range"] = [1, 2]
    again, _ = compute(first, STATS)
    assert _colors(again, "outline", "width") == [1.0, 1.3, 1.5, 1.8, 2.0]


def test_a_new_target_drops_what_was_generated_for_the_old_one() -> None:
    first, _ = compute(QUANTILE, STATS)
    first["classify"][0]["classes"][0]["fill"]["color"] = "#123456"
    first["classify"][0].update({"target": "outline.width", "range": [0.5, 4]})
    again, _ = compute(first, STATS)
    classes = again["classify"][0]["classes"]
    assert classes[0]["fill"] == {"color": "#123456"}
    assert all("fill" not in k for k in classes[1:])
    assert _colors(again, "outline", "width") == range_values(0.5, 4, 5)


def test_generated_category_colors_stay_with_their_values() -> None:
    cats = {
        "version": 1,
        "kind": "vector",
        "classify": [{"id": "t", "field": "type", "method": "categories", "count": 3}],
    }
    first, _ = compute(
        cats, {("top", "type", "3"): [("a", 9), ("b", 5), ("c", 2)]}, "point"
    )
    before = {
        k["values"][0]: k["marker"]["color"] for k in first["classify"][0]["classes"]
    }
    again, _ = compute(
        first, {("top", "type", "3"): [("b", 9), ("c", 5), ("d", 2)]}, "point"
    )
    after = {
        k["values"][0]: k["marker"]["color"] for k in again["classify"][0]["classes"]
    }
    assert after["b"] == before["b"] and after["c"] == before["c"]
    assert after["d"] == before["a"]


def test_fields_without_values_say_so() -> None:
    cats = {
        "version": 1,
        "kind": "vector",
        "classify": [{"id": "t", "field": "type", "method": "categories", "count": 3}],
        "symbol": {"marker": {"size": {"field": "pupils", "range": [2, 12]}}},
    }
    _, notes = compute(
        cats, {("top", "type", "3"): [], ("range", "pupils"): (None, None)}, "point"
    )
    assert [(n.code, n.path) for n in notes] == [
        ("no_values", "/classify/t"),
        ("no_values", "/symbol/marker/size"),
    ]


def test_a_field_the_data_no_longer_has_is_stamped_so_the_style_is_not_stale() -> None:
    """compute_stats leaves out keys whose field is missing or mistyped; the
    checks report those, and the stamp says the style is as current as it can be,
    so readers do not recompute it on every load (spec 12)."""
    from goatlib.style.fingerprint import is_stale

    previous, _ = compute(QUANTILE, STATS, fingerprint="ducklake:1")
    by_attribute = copy.deepcopy(previous)
    by_attribute["symbol"]["outline"] = {
        "width": {
            "field": "lanes",
            "range": [1, 4],
            "computed": {
                "at": "t",
                "data": "ducklake:1",
                "scope": "dataset",
                "domain": [1, 6],
            },
        }
    }
    out, notes = compute(by_attribute, {}, fingerprint="ducklake:2", at="t2")
    c = out["classify"][0]
    assert c["classes"] == previous["classify"][0]["classes"]
    assert c["computed"]["data"] == "ducklake:2"
    assert (
        c["computed"]["generated"] == previous["classify"][0]["computed"]["generated"]
    )
    assert c["computed"]["domain"] == [1000, 9000]
    width = out["symbol"]["outline"]["width"]
    assert width["computed"] == {
        "at": "t2",
        "data": "ducklake:2",
        "scope": "dataset",
        "domain": [1, 6],
    }
    assert notes == []
    assert not is_stale(out, "ducklake:2")
