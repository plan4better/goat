import pytest
from goatlib.raster.source import RasterSource
from goatlib.raster.stats import compute_raster_into, raster_context
from goatlib.style.compute import Breaks
from goatlib.style.validate import validate

LOCAL = ("127.0.0.1",)


def raster(**render: object) -> dict:
    return {"version": 1, "kind": "raster", "render": render}


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
        type="terrain",
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
