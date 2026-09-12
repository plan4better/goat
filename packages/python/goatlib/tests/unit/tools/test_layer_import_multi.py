"""Importing an upload that holds several datasets, as one job.

The ingest and record-keeping per layer need DuckLake and Postgres, so they are stubbed:
what is under test is the part this tool owns — how many layers one upload becomes, what
they are called, and what happens when one of them cannot be imported.
"""

from pathlib import Path

import pytest
from goatlib.models.io import (
    ConversionFailure,
    ConversionReport,
    ConvertedDataset,
    DatasetMetadata,
)
from goatlib.tools.layer_import import (
    MAX_DATASETS_PER_IMPORT,
    LayerImportParams,
    LayerImportRunner,
)

USER = "11111111-1111-1111-1111-111111111111"


def _dataset(name: str) -> ConvertedDataset:
    return ConvertedDataset(
        source=f"/tmp/city.gpkg::{name}",
        name=name,
        path=f"/tmp/converted/city_{name}.parquet",
        metadata=DatasetMetadata(
            path=f"/tmp/converted/city_{name}.parquet", source_type="vector"
        ),
    )


@pytest.fixture
def runner(monkeypatch) -> LayerImportRunner:
    """A runner whose per-layer work is recorded rather than performed."""
    instance = LayerImportRunner()

    async def _noop(self=None):
        return None

    monkeypatch.setattr(LayerImportRunner, "_init_db_service", _noop, raising=False)
    monkeypatch.setattr(LayerImportRunner, "_close_db_service", _noop, raising=False)

    instance.calls = []  # type: ignore[attr-defined]

    def fake_import_one(*, params, parquet, metadata, name, loop):
        instance.calls.append(name)  # type: ignore[attr-defined]
        if name == "explodes":
            raise RuntimeError("ingest failed")
        return {
            "layer_id": f"id-{name}",
            "name": name,
            "folder_id": "f1",
            "user_id": USER,
            "table_name": f"t_{name}",
        }

    monkeypatch.setattr(instance, "_import_one", fake_import_one)
    return instance


def _params(**kwargs) -> LayerImportParams:
    return LayerImportParams(
        user_id=USER, s3_key="users/u/imports/uploads/city.gpkg", **kwargs
    )


def _report(runner, monkeypatch, report: ConversionReport) -> None:
    monkeypatch.setattr(runner, "_convert_upload", lambda params, temp_dir: report)


def test_every_dataset_becomes_a_layer(runner, monkeypatch):
    _report(
        runner,
        monkeypatch,
        ConversionReport(
            outputs=[_dataset("roads"), _dataset("stops"), _dataset("rail")]
        ),
    )

    result = runner.run(_params(name="ignored when there are several"))

    assert [layer["name"] for layer in result["imported"]] == ["roads", "stops", "rail"]
    assert result["skipped"] == []
    # The first layer's own output is still the top level, so a caller reading a single
    # import keeps working.
    assert result["layer_id"] == "id-roads"


def test_a_single_dataset_takes_the_name_the_user_typed(runner, monkeypatch):
    _report(runner, monkeypatch, ConversionReport(outputs=[_dataset("tlm_strassen")]))

    result = runner.run(_params(name="Vienna roads"))

    assert [layer["name"] for layer in result["imported"]] == ["Vienna roads"]


def test_several_datasets_take_their_own_names(runner, monkeypatch):
    """One typed name cannot describe five layers, so each keeps the name it came with."""
    _report(
        runner, monkeypatch, ConversionReport(outputs=[_dataset("a"), _dataset("b")])
    )

    result = runner.run(_params(name="Vienna roads"))

    assert [layer["name"] for layer in result["imported"]] == ["a", "b"]


def test_one_layer_failing_does_not_lose_the_others(runner, monkeypatch):
    _report(
        runner,
        monkeypatch,
        ConversionReport(
            outputs=[_dataset("roads"), _dataset("explodes"), _dataset("stops")]
        ),
    )

    result = runner.run(_params())

    assert [layer["name"] for layer in result["imported"]] == ["roads", "stops"]
    assert result["skipped"] == [{"name": "explodes", "reason": "ingest failed"}]


def test_datasets_that_would_not_convert_are_reported_too(runner, monkeypatch):
    _report(
        runner,
        monkeypatch,
        ConversionReport(
            outputs=[_dataset("roads")],
            failures=[
                ConversionFailure(
                    source="/tmp/mixed.zip", name="broken", reason="invalid geojson"
                )
            ],
        ),
    )

    result = runner.run(_params())

    assert [layer["name"] for layer in result["imported"]] == ["roads"]
    assert result["skipped"] == [{"name": "broken", "reason": "invalid geojson"}]


def test_nothing_importable_fails_the_job_with_the_reasons(runner, monkeypatch):
    _report(
        runner,
        monkeypatch,
        ConversionReport(
            failures=[
                ConversionFailure(source="a", name="a", reason="bad"),
                ConversionFailure(source="b", name="b", reason="worse"),
            ]
        ),
    )

    with pytest.raises(ValueError, match="a: bad; b: worse"):
        runner.run(_params())


def test_an_empty_source_fails_the_job(runner, monkeypatch):
    _report(runner, monkeypatch, ConversionReport())

    with pytest.raises(ValueError, match="No convertible datasets"):
        runner.run(_params())


def test_too_many_datasets_is_refused_before_anything_is_imported(
    monkeypatch, tmp_path
):
    """The cap is checked on what discovery found, not after importing part of it."""
    runner = LayerImportRunner()

    class _Settings:
        s3_bucket_name = "bucket"
        max_upload_dataset_file_size = 5 * 1024 * 1024 * 1024

    monkeypatch.setattr(runner, "settings", _Settings(), raising=False)
    monkeypatch.setattr(runner, "_get_s3_client", lambda: _StubS3())
    monkeypatch.setattr(
        "goatlib.tools.layer_import.convert_all",
        lambda *a, **k: ConversionReport(
            outputs=[_dataset(f"layer_{i}") for i in range(MAX_DATASETS_PER_IMPORT + 1)]
        ),
    )

    with pytest.raises(ValueError, match=f"at most {MAX_DATASETS_PER_IMPORT}"):
        runner._convert_upload(_params(), tmp_path)


class _StubS3:
    def head_object(self, **kwargs: str) -> dict[str, int]:
        return {"ContentLength": 0}

    def download_file(self, **kwargs: str) -> None:
        Path(kwargs["Filename"]).write_bytes(b"")


def test_a_raster_is_skipped_rather_than_ingested_as_a_table(runner, monkeypatch):
    """A raster converts to a COG; DuckLake ingestion takes parquet, so it cannot pass."""
    raster = ConvertedDataset(
        source="/tmp/mixed.zip::imagery.tif",
        name="imagery",
        path="/tmp/converted/imagery.tif",
        metadata=DatasetMetadata(
            path="/tmp/converted/imagery.tif", source_type="raster"
        ),
    )
    _report(runner, monkeypatch, ConversionReport(outputs=[_dataset("roads"), raster]))

    result = runner.run(_params())

    assert [layer["name"] for layer in result["imported"]] == ["roads"]
    assert result["skipped"] == [
        {"name": "imagery", "reason": "Raster datasets cannot be imported here yet"}
    ]
