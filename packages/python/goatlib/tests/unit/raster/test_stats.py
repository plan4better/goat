import pytest
from goatlib.raster.source import RasterSource
from goatlib.raster.stats import compute_raster_into, raster_context
from goatlib.style.compute import Breaks
from goatlib.style.validate import validate

LOCAL = ("127.0.0.1",)


def raster(**render: object) -> dict:
    return {"version": "1.0.0", "kind": "raster", "render": render}


def test_the_context_describes_the_files_bands(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/landcover.tif", LOCAL) as src:
        ctx = raster_context(
            src, capabilities=frozenset({"raster_service", "band_formulas"})
        )
    assert ctx.kind == "raster" and ctx.source == "file"
    assert [(b.index, b.min, b.max) for b in ctx.bands] == [(1, 1, 4)]
    assert ctx.data_type == "uint8" and ctx.color_table and ctx.no_data == 0
    assert "band_formulas" in ctx.capabilities


def test_a_palette_without_a_domain_gets_the_bands_range(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        out, notes = compute_raster_into(
            src,
            raster(type="continuous", palette="goat:elevation"),
            fingerprint="url:x",
        )
    lo, hi = out["render"]["computed"]["domain"]
    assert lo == pytest.approx(100, abs=2) and hi == pytest.approx(400, abs=2)
    assert notes == []


def test_quantile_classes_come_from_the_bands_values(cog_server: str) -> None:
    doc = raster(
        type="continuous",
        palette="goat:elevation",
        classify={"method": "quantile", "count": 4},
    )
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        out, _ = compute_raster_into(src, doc, fingerprint="url:x")
    bounds = [k.get("to") for k in out["render"]["classify"]["classes"][:-1]]
    # A linear ramp from 100 to 400: quartiles near 175, 250 and 325.
    assert bounds == pytest.approx([175, 250, 325], abs=8)


def test_equal_classes_inside_the_authors_domain_split_the_domain(
    cog_server: str,
) -> None:
    doc = raster(
        type="hillshade",
        palette="goat:elevation",
        domain=[200, 300],
        classify={"method": "equal_interval", "count": 4},
    )
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        out, _ = compute_raster_into(src, doc, fingerprint="url:x")
    assert [
        k.get("to") for k in out["render"]["classify"]["classes"][:-1]
    ] == pytest.approx([225, 250, 275])


def test_a_formula_is_classified_over_its_values(cog_server: str) -> None:
    doc = raster(
        type="continuous",
        band={"name": "Index", "expression": "b4 / b1"},
        palette="goat:green",
        classify={"method": "natural_breaks", "count": 3},
    )
    with RasterSource(f"{cog_server}/multiband.tif", LOCAL) as src:
        out, notes = compute_raster_into(src, doc, fingerprint="url:x")
        ctx = raster_context(
            src, capabilities=frozenset({"raster_service", "band_formulas"})
        )
    # One value everywhere (5): the classes merge into one.
    assert out["render"]["computed"]["domain"] == [5.0, 5.0]
    assert {n.code for n in notes} <= {"classes_merged"}
    assert [i for i in validate(out, ctx) if i.level == "error"] == []


def test_breaks_are_those_of_the_shared_class_break_statistics() -> None:
    import numpy as np
    from goatlib.raster.stats import breaks_of

    values = np.arange(1, 101, dtype="float64")
    b = breaks_of(values, "equal_interval", 4)
    assert isinstance(b, Breaks) and b.breaks == pytest.approx((25.75, 50.5, 75.25))
    assert b.min == 1 and b.max == 100
    assert breaks_of(np.array([], dtype="float64"), "quantile", 3).min is None


def test_raster_context_lists_value_class_and_bands(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/rgb.tif", LOCAL) as src:
        ctx = raster_context(src)
    assert ctx.fields is not None
    assert {name: f.type for name, f in ctx.fields.items()} == {
        "value": "number",
        "class": "string",
        "band_1": "number",
        "band_2": "number",
        "band_3": "number",
    }
    assert all(name == f.name for name, f in ctx.fields.items())


def test_precomputed_breaks_cover_every_method_and_count() -> None:
    import numpy as np
    from goatlib.raster.stats import BREAK_COUNTS, BREAK_METHODS, precomputed_breaks

    values = np.random.default_rng(7).normal(250, 50, 20_000)
    out = precomputed_breaks(values)
    assert BREAK_METHODS == (
        "quantile",
        "natural_breaks",
        "std_dev",
        "geometric_interval",
    )
    # The other product's class counts: 3 to 13.
    assert list(BREAK_COUNTS) == list(range(3, 14))
    assert tuple(out) == BREAK_METHODS
    for method, by_count in out.items():
        assert list(by_count) == [str(n) for n in BREAK_COUNTS]
        for count, breaks in by_count.items():
            assert breaks == sorted(set(breaks)), (method, count)
            assert all(values.min() < b < values.max() for b in breaks)
            if method == "std_dev":
                # Standard deviation classes outside the data are left out (5.8).
                assert 0 < len(breaks) <= int(count) - 1, count
            else:
                assert len(breaks) == int(count) - 1, (method, count)


def test_a_whole_number_bands_breaks_are_whole_numbers() -> None:
    """An 8 bit band's classes break at whole numbers, so they read "28 to 84":
    each break rounded half up, breaks that round together kept once."""
    import math

    import numpy as np
    from goatlib.raster.stats import BREAK_COUNTS, BREAK_METHODS, precomputed_breaks
    from goatlib.style.compute import stable

    values = np.random.default_rng(4).gamma(2.0, 30.0, 20_000).round().clip(7, 255)
    plain = precomputed_breaks(values)
    whole = precomputed_breaks(values, whole=True)
    assert tuple(whole) == BREAK_METHODS
    lo, hi = values.min(), values.max()
    for method in BREAK_METHODS:
        for count in map(str, BREAK_COUNTS):
            rounded = sorted(
                {math.floor(stable(b) + 0.5) for b in plain[method][count]} - {lo, hi}
            )
            assert whole[method][count] == [b for b in rounded if lo < b < hi]
            assert all(float(b).is_integer() for b in whole[method][count])
    # A band of four codes: quantile breaks that round together give fewer classes.
    codes = np.repeat([0.0, 1.0, 2.0, 3.0], 500)
    assert precomputed_breaks(codes, whole=True)["quantile"]["7"] == [1, 2]


def whole_number_values_of(dtype: str, scales: tuple = (1.0,), offsets: tuple = (0.0,)):
    from types import SimpleNamespace

    from goatlib.raster.stats import whole_number_values

    info = SimpleNamespace(dtype=dtype, scales=scales, offsets=offsets)
    info.scaled = any(s != 1 for s in scales) or any(o != 0 for o in offsets)
    return whole_number_values(info)


def test_whole_number_bands_are_integer_and_unscaled() -> None:
    assert whole_number_values_of("uint8") is True
    assert whole_number_values_of("int16") is True
    assert whole_number_values_of("float32") is False
    assert whole_number_values_of("uint16", scales=(0.01,)) is False
    assert whole_number_values_of("int16", offsets=(-100.0,)) is False


def test_a_band_with_values_at_or_below_zero_has_no_geometric_intervals() -> None:
    import numpy as np
    from goatlib.raster.stats import precomputed_breaks

    for low in (0.0, -40.0):
        values = np.concatenate([[low], np.random.default_rng(5).uniform(1, 900, 999)])
        out = precomputed_breaks(values)
        assert out["geometric_interval"] == {}
        assert len(out["quantile"]["5"]) == 4


def test_precomputed_breaks_are_empty_for_a_constant_or_empty_band() -> None:
    import numpy as np
    from goatlib.raster.stats import precomputed_breaks

    assert precomputed_breaks(np.array([], dtype="float64")) == {}
    assert precomputed_breaks(np.full(500, 7.0)) == {}


def test_a_large_band_is_classified_from_a_fixed_sample(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import numpy as np
    from goatlib.raster import stats

    values = np.random.default_rng(3).uniform(0, 1000, stats.PRECOMPUTE_SAMPLE * 3)
    classified: list[int] = []
    real = stats._breaks_by

    def spy(sample: np.ndarray, pairs: list[tuple[str, int]], *rest: bool) -> dict:
        classified.append(sample.size)
        return real(sample, pairs, *rest)

    monkeypatch.setattr(stats, "_breaks_by", spy)
    first = stats.precomputed_breaks(values)
    # The same file gives the same breaks on every pod.
    assert stats.precomputed_breaks(values) == first
    assert classified == [stats.PRECOMPUTE_SAMPLE] * 2
    assert first["quantile"]["4"] == pytest.approx([250, 500, 750], abs=10)


def test_a_bands_histogram_has_fifty_bins(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        [band] = src.statistics()
    counts, edges = band.histogram
    assert len(counts) == 50 and len(edges) == 51


@pytest.mark.parametrize(
    "values",
    [[1e16] * 6, [1e300] * 3, [1e16, 1e16 + 2], [1.0, 1.0 + 2e-16]],
    ids=["one large value", "one huge value", "large neighbours", "neighbours"],
)
def test_values_too_close_for_fifty_bins_get_one_bin(values: list[float]) -> None:
    """One large value, or values a float apart, leave no room for fifty bins
    between them: the statistics hold one bin of them all, from the minimum to
    the maximum."""
    import numpy as np
    from goatlib.raster.source import formula_statistics

    stats = formula_statistics(np.array(values))
    assert (stats.min, stats.max) == (min(values), max(values))
    assert stats.histogram == ([len(values)], [min(values), max(values)])
    assert stats.p2 is not None and stats.mean is not None


def test_one_ordinary_value_keeps_fifty_bins_around_it() -> None:
    import numpy as np
    from goatlib.raster.source import formula_statistics

    counts, edges = formula_statistics(np.zeros(6)).histogram
    assert len(counts) == 50 and sum(counts) == 6
    assert (edges[0], edges[-1]) == (-0.5, 0.5)


def test_a_band_of_one_large_value_has_statistics(tmp_path) -> None:  # noqa: ANN001
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds

    path = tmp_path / "constant.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=64,
        height=64,
        count=1,
        dtype="float64",
        crs="EPSG:4326",
        transform=from_bounds(11.5, 48.1, 11.6, 48.2, 64, 64),
    ) as dst:
        dst.write(np.full((1, 64, 64), 1e16, "float64"))
    with RasterSource(None, stored_file=path) as src:
        [band] = src.statistics()
    assert band.min == band.max == 1e16
    assert band.histogram == ([64 * 64], [1e16, 1e16])


def test_a_band_is_classified_once_per_method(monkeypatch: pytest.MonkeyPatch) -> None:
    """One query (and one Fisher-Jenks run) per method gives every class count."""
    import numpy as np
    from goatlib.analysis.statistics import class_breaks
    from goatlib.raster.stats import BREAK_METHODS, precomputed_breaks

    real = class_breaks.calculate_class_breaks_by_count
    asked: list[object] = []

    def spy(*args: object, **kwargs: object) -> object:
        asked.append(args[3])
        return real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(class_breaks, "calculate_class_breaks_by_count", spy)
    precomputed_breaks(np.random.default_rng(2).gamma(2.0, 50.0, 5_000))
    assert len(asked) == len(BREAK_METHODS)


def test_breaks_are_computed_on_one_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    """DuckDB sums in parallel, so a pod with other cores could give other last
    digits: one thread gives every pod the same breaks."""
    import duckdb
    import numpy as np
    from goatlib.raster.stats import breaks_of, precomputed_breaks

    real = duckdb.connect
    configs: list[object] = []

    def spy(*args: object, **kwargs: object) -> duckdb.DuckDBPyConnection:
        configs.append(kwargs.get("config"))
        return real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(duckdb, "connect", spy)
    values = np.random.default_rng(2).gamma(2.0, 50.0, 5_000)
    precomputed_breaks(values)
    breaks_of(values, "quantile", 4)
    assert configs and all(c == {"threads": 1} for c in configs)


def _undrawn(size: int, count: int) -> list[int]:
    """Positions `classified_sample` leaves out of a band of `size` values: the
    draw picks positions, whatever the values."""
    import numpy as np
    from goatlib.raster.stats import classified_sample

    drawn = set(classified_sample(np.arange(size, dtype="float64")).astype(int))
    return [i for i in range(size) if i not in drawn][:count]


def test_a_band_whose_sample_holds_one_value_has_no_breaks() -> None:
    import numpy as np
    from goatlib.raster.stats import (
        PRECOMPUTE_SAMPLE,
        classified_sample,
        precomputed_breaks,
    )

    size = PRECOMPUTE_SAMPLE * 3
    values = np.full(size, 7.0)
    values[_undrawn(size, 5)] = [1.0, 2.0, 3.0, 4.0, 5.0]
    sample = classified_sample(values)
    assert sample.min() == sample.max() == 7.0
    assert precomputed_breaks(values) == {}


def test_an_alpha_band_is_no_band_a_style_can_color(cog_server: str) -> None:
    """Validation sees an orthophoto's three color bands: its alpha band is
    the image's transparency."""
    with RasterSource(f"{cog_server}/rgba.tif", LOCAL) as src:
        ctx = raster_context(src)
    assert [b.index for b in ctx.bands] == [1, 2, 3]
    issues = validate(raster(type="continuous", band=4), ctx)
    assert any(i.code == "unknown_band" for i in issues)
    assert not any(
        i.code == "unknown_band"
        for i in validate(raster(type="continuous", band=3), ctx)
    )


def test_an_alpha_band_is_no_popup_field(cog_server: str) -> None:
    """An orthophoto's popup reads its three color bands: its alpha band has no
    field, as the panel, the point query and popup.md leave it out."""
    with RasterSource(f"{cog_server}/rgba.tif", LOCAL) as src:
        ctx = raster_context(src)
    assert ctx.fields is not None
    assert [n for n in ctx.fields if n.startswith("band_")] == [
        "band_1",
        "band_2",
        "band_3",
    ]
    attributes = [{"field": "band_3"}, {"field": "band_4"}]
    popup = {"blocks": [{"type": "field_list", "attributes": attributes}]}
    issues = validate({**raster(type="image"), "popup": popup}, ctx)
    assert [(i.code, i.path) for i in issues if i.code == "unknown_field"] == [
        ("unknown_field", "/popup/blocks/0/attributes/1/field")
    ]


def test_validation_takes_the_value_bands_wherever_the_alpha_band_is() -> None:
    """An alpha band first (bands 2 to 4 hold values): band 1 is unknown, band
    4 is known, as tiles take them."""
    from goatlib.style.context import BandInfo, DataContext

    ctx = DataContext(
        kind="raster",
        source="file",
        bands=tuple(BandInfo(index=i, min=0, max=255) for i in (2, 3, 4)),
        data_type="uint8",
    )

    def codes(**render: object) -> set[str]:
        return {i.code for i in validate(raster(**render), ctx)}

    assert "unknown_band" in codes(type="continuous", band=1)
    assert "unknown_band" not in codes(type="continuous", band=4)
    assert "unknown_band" in codes(type="image", bands=[1, 2, 3])
    assert "unknown_band" not in codes(type="image", bands=[2, 3, 4])
    formula = {"name": "Index", "expression": "b4 * 2"}
    assert "invalid_band_expression" not in codes(type="continuous", band=formula)
    formula = {"name": "Index", "expression": "b1 * 2"}
    assert "invalid_band_expression" in codes(type="continuous", band=formula)
    [said] = [
        i.message
        for i in validate(raster(type="continuous", band=1), ctx)
        if i.code == "unknown_band"
    ]
    assert said == "The raster has 3 bands."
