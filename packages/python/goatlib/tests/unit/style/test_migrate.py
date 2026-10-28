"""The migration of today's styles (spec 17): convert, give ids,
stamp computed values so nothing goes stale on the first map load."""

import copy
from typing import Any

import pytest
from goatlib.style import migrate as migrate_module
from goatlib.style.compute import Breaks, apply_computed
from goatlib.style.context import DataContext
from goatlib.style.defaults import default_style
from goatlib.style.fingerprint import is_stale
from goatlib.style.migrate import context_for, migrate_style, stamp_computed
from goatlib.style.validate import validate

DISTRICTS = DataContext(kind="vector", geometry="polygon")
QUANTILE_V0: dict[str, Any] = {
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
    "visibility": False,
}


def errors(doc: dict[str, Any], ctx: DataContext) -> list[str]:
    return [i.code for i in validate(doc, ctx) if i.level == "error"]


def test_a_converted_classified_style_is_not_stale_for_its_fingerprint() -> None:
    m = migrate_style(
        QUANTILE_V0, DISTRICTS, fingerprint="ducklake:7", at="2026-10-25T00:00:00Z"
    )
    assert not is_stale(m.document, "ducklake:7")
    assert is_stale(m.document, "ducklake:8")
    assert m.document["classify"][0]["computed"] == {
        "at": "2026-10-25T00:00:00Z",
        "data": "ducklake:7",
        "scope": "dataset",
    }
    assert errors(m.document, DISTRICTS) == []
    assert not m.fell_back


def test_ids_are_given_so_merges_address_classes() -> None:
    m = migrate_style(QUANTILE_V0, DISTRICTS, fingerprint="ducklake:7", at="t")
    c = m.document["classify"][0]
    assert c["id"] == "density"
    assert all(isinstance(k.get("id"), str) for k in c["classes"])


def test_a_recompute_with_the_same_count_keeps_the_migrated_colors() -> None:
    m = migrate_style(QUANTILE_V0, DISTRICTS, fingerprint="ducklake:7", at="t")
    colors = [k["fill"]["color"] for k in m.document["classify"][0]["classes"]]
    key = ("breaks", "density", "quantile", "3")
    out, _ = apply_computed(
        m.document,
        {key: Breaks((3000, 5000), 100, 9500, False)},
        geometry="polygon",
        fingerprint="ducklake:8",
        at="t2",
    )
    classes = out["classify"][0]["classes"]
    assert [k["fill"]["color"] for k in classes] == colors
    assert [k.get("to") for k in classes] == [3000, 5000, None]


def test_map_state_leaves_the_document() -> None:
    m = migrate_style(QUANTILE_V0, DISTRICTS, fingerprint=None, at="t")
    assert m.map_state == {"visible": False}
    assert "visibility" not in m.document
    assert "computed" not in m.document["classify"][0]


def test_a_row_that_raises_falls_back_to_the_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def broken(*_: Any, **__: Any) -> Any:
        raise RuntimeError("unforeseen")

    monkeypatch.setattr(migrate_module, "convert_v0", broken)
    m = migrate_style(
        QUANTILE_V0, DISTRICTS, fingerprint="ducklake:1", at="t", seed="abc"
    )
    assert m.fell_back
    assert m.document == default_style(DISTRICTS, seed="abc")
    assert errors(m.document, DISTRICTS) == []


def test_a_conversion_that_stopped_early_falls_back_to_the_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from goatlib.style import convert_v0

    def broken(*_: Any, **__: Any) -> Any:
        raise RuntimeError("unforeseen")

    monkeypatch.setattr(convert_v0._Converter, "vector", broken)
    m = migrate_style(
        QUANTILE_V0, DISTRICTS, fingerprint="ducklake:1", at="t", seed="abc"
    )
    assert m.fell_back
    assert m.document == default_style(DISTRICTS, seed="abc")
    assert [n.key for n in m.lossy] == ["*"]


def test_null_or_missing_properties_convert_from_nothing() -> None:
    for value in (None, "x", []):
        m = migrate_style(value, DISTRICTS, fingerprint=None, at="t")
        assert m.document["version"] == 1 and not m.fell_back
        assert errors(m.document, DISTRICTS) == []


def test_stamping_touches_only_what_the_server_computes() -> None:
    manual = copy.deepcopy(QUANTILE_V0)
    doc = migrate_style(manual, DISTRICTS, fingerprint=None, at="t").document
    doc["classify"][0]["method"] = "manual"
    assert "computed" not in stamp_computed(doc, "ducklake:1", "t")["classify"][0]
    raster = {"version": 1, "kind": "raster", "render": {"type": "image"}}
    assert stamp_computed(raster, "ducklake:1", "t") == raster


def test_rasters_and_map_services_get_todays_opacity_by_default() -> None:
    for source in ("file", "wms", "wmts", "xyz"):
        doc = default_style(DataContext(kind="raster", source=source))  # type: ignore[arg-type]
        assert doc["opacity"] == 0.8
        assert errors(doc, DataContext(kind="raster", source=source)) == []  # type: ignore[arg-type]


def test_the_context_follows_the_layer_row() -> None:
    assert context_for("feature", "polygon", None) == DISTRICTS
    assert context_for("raster", None, "wms") == DataContext(
        kind="raster", source="wms"
    )
    assert context_for("raster", None, "cog") == DataContext(kind="raster")
    assert context_for(None, None, None) == DataContext(kind="vector")


def test_a_stored_document_is_current_valid_or_the_default() -> None:
    from goatlib.style.migrate import stored_document

    converted = stored_document(QUANTILE_V0, DISTRICTS, seed="L")
    assert converted["version"] == 1 and errors(converted, DISTRICTS) == []
    valid = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#00aa00"}}}
    assert stored_document(valid, DISTRICTS, seed="L") == valid
    broken = {
        "version": 1,
        "kind": "vector",
        "symbol": {"fill": {"color": "green-ish"}},
    }
    assert errors(broken, DISTRICTS)
    assert stored_document(broken, DISTRICTS, seed="L") == default_style(
        DISTRICTS, seed="L"
    )
    assert stored_document([1, 2], DISTRICTS, seed="L") == default_style(
        DISTRICTS, seed="L"
    )
