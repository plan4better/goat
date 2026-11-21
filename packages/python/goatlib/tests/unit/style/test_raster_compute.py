"""Computed values of raster styles (the specification's sections 9.2, 9.4 and 12): the default domain from the
band's range and classes from the band's values, written like a vector style's."""

import copy
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


@pytest.mark.parametrize("method", ["quantile", "natural_breaks"])
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


def _file(values: Any) -> Any:
    from types import SimpleNamespace

    return SimpleNamespace(
        info=lambda: SimpleNamespace(count=1, value_bands=(1,)),
        sample=lambda formula: values,
    )


@pytest.mark.parametrize("method", ["quantile", "natural_breaks", "std_dev"])
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
