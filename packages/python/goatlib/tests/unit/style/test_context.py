import json

from goatlib.style.context import DataContext

from .conftest import FIXTURES


def test_every_sample_dataset_loads() -> None:
    raw = json.loads((FIXTURES / "sample_datasets.json").read_text())
    assert {name: DataContext.from_dict(d).kind for name, d in raw.items()}[
        "districts"
    ] == "vector"


def test_districts(contexts: dict) -> None:
    d = contexts["districts"]
    assert d.geometry == "polygon"
    assert d.fields["land_use"].type == "string"
    assert "residential" in d.fields["land_use"].values
    assert isinstance(d.fields["density"].min, (int, float))


def test_rasters_and_services(contexts: dict) -> None:
    assert len(contexts["satellite"].bands) == 4
    assert contexts["wms"].source == "wms"
    assert contexts["wms"].service_styles == ("default", "grey")


def test_unknown_fields_are_none_not_empty() -> None:
    assert DataContext(kind="vector", geometry="point").fields is None


def test_raster_files_carry_the_cell_fields(contexts: dict) -> None:
    from goatlib.style.context import raster_fields

    files = {n: c for n, c in contexts.items() if c.kind == "raster"}
    files = {n: c for n, c in files.items() if not c.is_service}
    assert set(files) == {"elevation", "landcover", "satellite"}
    for name, ctx in files.items():
        assert ctx.fields == raster_fields(len(ctx.bands)), name
    assert contexts["wms"].fields is None and contexts["tiles"].fields is None
