"""Computed values of raster styles (the specification's sections 9.2, 9.4 and 12): the default domain from the
band's range and classes from the band's values, written like a vector style's."""

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from goatlib.style.colors import sample_colors
from goatlib.style.compute import Breaks, apply_computed, computed_missing, needed_stats
from goatlib.style.context import BandInfo, DataContext
from goatlib.style.fingerprint import is_stale, layer_fingerprint
from goatlib.style.validate import validate

ELEVATION = DataContext(
    kind="raster", bands=(BandInfo(1, 181, 440),), data_type="float32"
)
NDVI = {"name": "NDVI", "expression": "(b4 - b1) / (b4 + b1)"}


def raster(**render: Any) -> dict[str, Any]:
    return {"version": "1.0.0", "kind": "raster", "render": render}


def compute(doc: dict[str, Any], stats: dict) -> tuple[dict[str, Any], list]:
    out, notes = apply_computed(
        doc, stats, geometry=None, fingerprint="url:abc", at="t"
    )
    assert [i for i in validate(out, ELEVATION) if i.level == "error"] == []
    return out, notes


def test_geometric_intervals_of_a_band_reaching_zero_make_one_class_and_say_why() -> (
    None
):
    doc, notes = compute(
        raster(
            type="continuous",
            palette="goat:elevation",
            classify={"method": "geometric_interval", "count": 5},
        ),
        {
            ("range", "b1"): (-3.0, 90.0),
            ("breaks", "b1", "geometric_interval", "5"): Breaks((), -3.0, 90.0, False),
        },
    )
    assert len(doc["render"]["classify"]["classes"]) == 1
    assert [(n.code, n.path, n.message) for n in notes] == [
        (
            "classes_merged",
            "/render/classify",
            "Geometric intervals need values above 0: 1 class instead of 5.",
        )
    ]


def test_a_palette_without_a_domain_needs_the_bands_range() -> None:
    assert needed_stats(raster(type="continuous", palette="goat:elevation")) == [
        ("range", "b1")
    ]
    assert needed_stats(raster(type="continuous")) == [("range", "b1")]
    assert needed_stats(raster(type="continuous", band=NDVI, palette="goat:green")) == [
        ("range", "(b4 - b1) / (b4 + b1)")
    ]
    assert (
        needed_stats(raster(type="continuous", palette="goat:elevation", domain=[0, 1]))
        == []
    )
    assert needed_stats(raster(type="hillshade")) == []
    assert needed_stats(raster(type="image")) == []


def test_computed_classes_need_the_bands_breaks() -> None:
    doc = raster(
        type="continuous",
        palette="goat:elevation",
        classify={"method": "quantile", "count": 4},
    )
    assert needed_stats(doc) == [("range", "b1"), ("breaks", "b1", "quantile", "4")]
    inside = raster(
        type="hillshade",
        palette="goat:elevation",
        domain=[181, 440],
        classify={"method": "equal_interval", "count": 6},
    )
    assert needed_stats(inside) == [
        ("breaks", "b1", "equal_interval", "6", "181", "440")
    ]
    manual = raster(
        type="continuous",
        domain=[0, 9],
        classify={"method": "manual", "classes": [{"to": 3}, {"from": 3}]},
    )
    assert needed_stats(manual) == []


def test_the_bands_range_becomes_the_computed_domain() -> None:
    doc = raster(type="continuous", palette="goat:elevation")
    out, notes = compute(doc, {("range", "b1"): (181.0, 440.0)})
    assert out["render"]["computed"] == {
        "at": "t",
        "data": "url:abc",
        "scope": "dataset",
        "domain": [181.0, 440.0],
    }
    assert notes == []
    assert not computed_missing(out) and computed_missing(doc)
    written = raster(
        type="continuous",
        palette="goat:elevation",
        domain=[0, 1],
        computed=out["render"]["computed"],
    )
    assert "computed" not in compute(written, {})[0]["render"]


def test_quantile_classes_are_filled_and_the_authors_color_and_name_at_a_position_survive() -> (
    None
):
    doc = raster(
        type="continuous",
        palette="goat:elevation",
        domain=[181, 440],
        classify={
            "method": "quantile",
            "count": 5,
            "classes": [
                {"name": "Valley floor"},
                {"color": "#2bb381"},
                {},
                {},
                {"visible": False},
            ],
        },
    )
    key = ("breaks", "b1", "quantile", "5", "181", "440")
    out, _ = compute(doc, {key: Breaks((240, 275, 300, 340), 181, 440, False)})
    classes = out["render"]["classify"]["classes"]
    colors = sample_colors("goat:elevation", 5)
    assert [(k.get("from"), k.get("to")) for k in classes] == [
        (None, 240),
        (240, 275),
        (275, 300),
        (300, 340),
        (340, None),
    ]
    assert classes[0]["name"] == "Valley floor" and classes[0]["color"] == colors[0]
    assert classes[1]["color"] == "#2bb381"
    assert classes[4]["visible"] is False and classes[4]["color"] == colors[4]
    assert out["render"]["classify"]["computed"]["data"] == "url:abc"
    assert all(isinstance(k["id"], str) for k in classes)
    # A recompute with other breaks keeps everything but the bounds.
    again, _ = compute(out, {key: Breaks((250, 280, 310, 350), 181, 440, False)})
    assert again["render"]["classify"]["classes"][1]["color"] == "#2bb381"
    assert again["render"]["classify"]["classes"][0]["to"] == 250


def test_the_classifications_own_palette_colors_the_classes() -> None:
    doc = raster(
        type="continuous",
        palette="goat:elevation",
        domain=[0, 9],
        classify={
            "method": "equal_interval",
            "count": 3,
            "palette": "colorbrewer:BuGn",
            "reverse": True,
        },
    )
    out, _ = compute(
        doc,
        {
            ("breaks", "b1", "equal_interval", "3", "0", "9"): Breaks(
                (3, 6), 0, 9, False
            )
        },
    )
    assert [k["color"] for k in out["render"]["classify"]["classes"]] == sample_colors(
        "colorbrewer:BuGn", 3, reverse=True
    )


def test_a_band_without_values_is_noted_and_the_classes_stay() -> None:
    doc = raster(
        type="continuous",
        palette="goat:elevation",
        classify={"method": "quantile", "count": 3},
    )
    out, notes = compute(
        doc,
        {
            ("range", "b1"): (None, None),
            ("breaks", "b1", "quantile", "3"): Breaks((), None, None, False),
        },
    )
    assert {n.code for n in notes} == {"no_values"}
    assert "domain" not in out["render"]["computed"]
    assert out["render"]["classify"]["computed"]["data"] == "url:abc"


def test_a_classification_turned_manual_loses_what_the_server_computed() -> None:
    doc = raster(
        type="continuous",
        palette="goat:elevation",
        domain=[0, 9],
        classify={"method": "quantile", "count": 2},
    )
    out, _ = compute(
        doc, {("breaks", "b1", "quantile", "2", "0", "9"): Breaks((4,), 0, 9, False)}
    )
    manual = copy.deepcopy(out)
    manual["render"]["classify"]["method"] = "manual"
    assert "computed" not in compute(manual, {})[0]["render"]["classify"]


def test_a_raster_file_has_a_fingerprint_and_a_map_service_none() -> None:
    url = "https://cdn.example/canopy.tif"
    assert layer_fingerprint("raster", "cog", url=url) == layer_fingerprint(
        "raster", "cog", url=url
    )
    assert layer_fingerprint("raster", "cog", url=url).startswith("url:")
    assert layer_fingerprint("raster", "cog", url=url) != layer_fingerprint(
        "raster", "cog", url=url + "?v=2"
    )
    assert (
        layer_fingerprint("raster", "cog", url=url, catalog_version="7") == "catalog:7"
    )
    # A raster promoted from the catalog has no address: it is read from its
    # copy, and its version is its fingerprint.
    assert layer_fingerprint("raster", "cog", catalog_version="7") == "catalog:7"
    assert layer_fingerprint("raster", "cog") is None
    assert layer_fingerprint("raster", "wms", url=url) is None
    assert layer_fingerprint("feature", None, data_snapshot=5) == "ducklake:5"


def test_a_raster_style_computed_from_another_file_is_stale() -> None:
    doc, _ = compute(
        raster(type="continuous", palette="goat:elevation"),
        {("range", "b1"): (1.0, 2.0)},
    )
    assert not is_stale(doc, "url:abc")
    assert is_stale(doc, "url:other")
    assert is_stale(raster(type="continuous", palette="goat:elevation"), "url:abc")
    assert not is_stale(raster(type="image"), "url:abc")


@pytest.mark.parametrize("method", ["quantile", "natural_breaks", "geometric_interval"])
@pytest.mark.parametrize("band", [None, NDVI], ids=["band", "formula"])
def test_precomputed_breaks_match_a_style_check(
    method: str, band: dict[str, str] | None
) -> None:
    """The breaks the raster panel is given for a method and count are those a
    style check writes into the classes for them, also for a band with more
    values than are classified, and a formula is classified over the same
    sample."""
    from types import SimpleNamespace

    import numpy as np
    from goatlib.raster.stats import (
        PRECOMPUTE_SAMPLE,
        compute_raster_into,
        precomputed_breaks,
    )

    values = np.random.default_rng(11).gamma(2.0, 50.0, PRECOMPUTE_SAMPLE * 3)
    file = SimpleNamespace(
        info=lambda: SimpleNamespace(count=4, value_bands=(1, 2, 3, 4)),
        sample=lambda formula: values,
    )
    doc = raster(
        type="continuous",
        palette="goat:elevation",
        classify={"method": method, "count": 5},
        **({"band": band} if band else {}),
    )
    checked, _ = compute_raster_into(file, doc, fingerprint="url:abc")  # type: ignore[arg-type]
    written = [k["to"] for k in checked["render"]["classify"]["classes"][:-1]]
    assert len(written) == 4
    assert written == precomputed_breaks(values)[method]["5"]


def _whole_file(values: Any, **info: Any) -> Any:
    """A one-band file of whole numbers (uint8, neither scaled nor offset)."""
    from types import SimpleNamespace

    facts = {"count": 1, "value_bands": (1,), "dtype": "uint8", "scaled": False, **info}
    return SimpleNamespace(
        info=lambda: SimpleNamespace(**facts), sample=lambda formula: values
    )


def _bounds(file: Any, **render: Any) -> tuple[list[float], list[Any]]:
    from goatlib.raster.stats import compute_raster_into

    checked, notes = compute_raster_into(
        file,
        raster(type="continuous", palette="goat:elevation", **render),
        fingerprint="u",
    )
    return [k["to"] for k in checked["render"]["classify"]["classes"][:-1]], notes


@pytest.mark.parametrize(
    "method", ["quantile", "natural_breaks", "std_dev", "geometric_interval"]
)
def test_a_whole_number_bands_classes_break_at_whole_numbers(method: str) -> None:
    """The check writes the panel's precomputed breaks, whole numbers too."""
    import numpy as np
    from goatlib.raster.stats import precomputed_breaks

    values = np.random.default_rng(9).gamma(2.0, 30.0, 50_000).round().clip(7, 255)
    written, _ = _bounds(_whole_file(values), classify={"method": method, "count": 5})
    assert written and all(float(b).is_integer() for b in written)
    assert written == precomputed_breaks(values, whole=True)[method]["5"]


def test_whole_number_breaks_that_round_together_merge_with_a_note() -> None:
    import numpy as np

    # Geometric breaks over 1 to 6 in 7 classes: 1.29, 1.67, 2.15, 2.78, 3.59, 4.63.
    codes = np.repeat([1.0, 2.0, 3.0, 4.0, 5.0, 6.0], 300)
    written, notes = _bounds(
        _whole_file(codes), classify={"method": "geometric_interval", "count": 7}
    )
    assert written == [2, 3, 4, 5]
    assert [(n.code, n.message) for n in notes] == [
        ("classes_merged", "Equal breaks merged: 5 classes instead of 7.")
    ]


EQUAL_INTERVAL_CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "equal_interval_cases.json").read_text()
)


@pytest.mark.parametrize("case", EQUAL_INTERVAL_CASES, ids=lambda c: c["about"])
def test_equal_intervals_as_the_browser_writes_them(case: dict[str, Any]) -> None:
    """Shared with the web (editor-raster.test.ts, `equalIntervalClasses`): the
    check splits a range into the same classes the panel writes."""
    import numpy as np

    file = _whole_file(
        np.arange(-10.0, 300.0), dtype="uint8" if case["whole"] else "float32"
    )
    written, _ = _bounds(
        file,
        domain=case["domain"],
        classify={"method": "equal_interval", "count": case["count"]},
    )
    assert written == case["breaks"]


@pytest.mark.parametrize("expression", ["b1", " b1 ", "b01"])
def test_a_formula_of_one_band_alone_breaks_as_the_band(expression: str) -> None:
    """However it is typed, a formula of one band alone is that band (spec
    9.4): whole-number breaks on a file of whole numbers."""
    import numpy as np

    values = np.random.default_rng(9).gamma(2.0, 30.0, 50_000).round().clip(7, 255)
    geometric = {"method": "geometric_interval", "count": 5}
    band, _ = _bounds(_whole_file(values), classify=geometric)
    written, _ = _bounds(
        _whole_file(values),
        classify=geometric,
        band={"name": "Alone", "expression": expression},
    )
    assert written == band and all(float(b).is_integer() for b in written)


def test_formulas_scaled_files_and_floats_keep_their_breaks() -> None:
    import numpy as np

    values = np.random.default_rng(9).gamma(2.0, 30.0, 50_000).round().clip(7, 255)
    geometric = {"method": "geometric_interval", "count": 5}
    formula = {"name": "Third", "expression": "b1 / 3"}
    for file, extra in (
        (_whole_file(values), {"band": formula}),
        (_whole_file(values, scaled=True), {}),
        (_whole_file(values, dtype="float32"), {}),
    ):
        written, _ = _bounds(file, classify=geometric, **extra)
        assert not all(float(b).is_integer() for b in written), extra


def _file(values: Any) -> Any:
    from types import SimpleNamespace

    return SimpleNamespace(
        info=lambda: SimpleNamespace(count=1, value_bands=(1,)),
        sample=lambda formula: values,
    )


@pytest.mark.parametrize(
    "method", ["quantile", "natural_breaks", "std_dev", "geometric_interval"]
)
def test_a_domain_does_not_narrow_computed_classes(method: str) -> None:
    """Quantiles, natural breaks and standard deviation classify the whole band,
    as the panel's precomputed breaks do: a style with a domain is checked to
    the same bounds as without one, so saving moves no class."""
    import numpy as np
    from goatlib.raster.stats import (
        PRECOMPUTE_SAMPLE,
        compute_raster_into,
        precomputed_breaks,
    )

    values = np.random.default_rng(12).gamma(2.0, 50.0, PRECOMPUTE_SAMPLE * 3)

    def bounds(**domain: Any) -> list[float]:
        doc = raster(
            type="continuous",
            palette="goat:elevation",
            classify={"method": method, "count": 5},
            **domain,
        )
        checked, _ = compute_raster_into(_file(values), doc, fingerprint="url:abc")
        return [k["to"] for k in checked["render"]["classify"]["classes"][:-1]]

    whole = bounds()
    assert whole == precomputed_breaks(values)[method]["5"]
    assert bounds(domain=[20, 300]) == whole


def test_equal_intervals_read_every_value_not_the_sample() -> None:
    """A value the sample leaves out still sets the top of equal intervals."""
    import numpy as np
    from goatlib.raster.stats import (
        PRECOMPUTE_SAMPLE,
        classified_sample,
        compute_raster_into,
    )

    size = PRECOMPUTE_SAMPLE * 3
    drawn = set(classified_sample(np.arange(size, dtype="float64")).astype(int))
    outlier = next(i for i in range(size) if i not in drawn)
    values = np.random.default_rng(13).uniform(0, 100, size)
    values[outlier] = 1000.0
    assert classified_sample(values).max() < 1000
    doc = raster(
        type="continuous",
        palette="goat:elevation",
        classify={"method": "equal_interval", "count": 4},
    )
    checked, _ = compute_raster_into(_file(values), doc, fingerprint="url:abc")
    written = [k["to"] for k in checked["render"]["classify"]["classes"][:-1]]
    low = float(values.min())
    assert written == pytest.approx([low + i * (1000 - low) / 4 for i in (1, 2, 3)])
