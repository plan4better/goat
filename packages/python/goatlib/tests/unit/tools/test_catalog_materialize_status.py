"""A materialize job that cannot even start must say so in the layer's status."""

import shutil
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import duckdb
import pytest
from goatlib.tools.catalog_materialize import (
    CatalogMaterializeParams,
    CatalogMaterializeRunner,
)


@pytest.mark.parametrize(
    ("layer", "expected_error"),
    [
        (
            {
                "type": "unknown",
                "other_properties": {"catalog_item": {"parquet_url": "x"}},
            },
            "No materialize handler",
        ),
        (
            {"type": "feature", "other_properties": {"catalog_item": {}}},
            "has no parquet_url",
        ),
        (
            {"type": "raster", "other_properties": {"catalog_item": {}}},
            "has no parquet_url",
        ),
    ],
)
def test_input_errors_land_as_failed_not_pending(
    layer: dict, expected_error: str
) -> None:
    """Raising past the status writes left the layer at `pending` forever, the
    web polling it, and core's heal re-running the same doomed job on every
    re-add."""
    runner = CatalogMaterializeRunner()
    runner.settings = object()  # only checked for None before the work starts
    statuses: list[tuple[str, dict | None]] = []

    async def fake_set_status(
        layer_id: str, status: str, extra: dict | None = None
    ) -> None:
        statuses.append((status, extra))

    with (
        patch.object(runner, "_load_layer", AsyncMock(return_value=layer)),
        patch.object(runner, "_set_status", side_effect=fake_set_status),
        pytest.raises(ValueError, match=expected_error),
    ):
        runner.run(
            CatalogMaterializeParams(
                layer_id="3fa85f64-5717-4562-b3fc-2c963f66afa6", user_id="u"
            )
        )

    assert statuses, "no status was written at all"
    status, extra = statuses[-1]
    assert status == "failed"
    assert expected_error.split()[0] in (extra or {}).get("error", "")


def test_tiles_are_written_to_the_catalog_tiles_directory(
    tmp_path, monkeypatch
) -> None:
    """A catalog layer's tiles belong to the catalog tree, in their own directory.

    Pinned because the two directories are configured separately: nothing else
    fails if the generator keeps writing into `TILES_DATA_DIR`, the files just
    scatter and the GC's second location quietly becomes the only one in use.
    """
    monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path / "catalog" / "layers"))
    monkeypatch.setenv("CATALOG_TILES_DIR", str(tmp_path / "catalog" / "tiles"))
    monkeypatch.setenv("TILES_DATA_DIR", str(tmp_path / "tiles"))

    from goatlib.utils.layer import catalog_layers_dir, catalog_tiles_dir

    seen: dict[str, object] = {}

    class _Generator:
        def __init__(self, tiles_data_dir, config):  # noqa: ANN001
            seen["dir"] = tiles_data_dir

        def generate_from_table(self, **_kwargs):  # noqa: ANN003
            return tmp_path / "catalog" / "tiles" / "t_x.pmtiles"

        def generate_anchor_from_table(self, **_kwargs):  # noqa: ANN003
            return None

    import goatlib.io.pmtiles as pmtiles_module

    monkeypatch.setattr(pmtiles_module, "PMTilesGenerator", _Generator)

    runner = CatalogMaterializeRunner()
    runner.settings = SimpleNamespace(
        pmtiles_enabled=True, pmtiles_min_zoom=0, pmtiles_max_zoom=14
    )
    parquet = tmp_path / "src.parquet"
    fixture = duckdb.connect()
    fixture.execute("INSTALL spatial; LOAD spatial;")
    fixture.execute(
        f"COPY (SELECT 1 AS id, ST_Point(0, 0) AS geom) TO '{parquet}' (FORMAT PARQUET)"
    )
    fixture.close()

    runner._generate_catalog_pmtiles(
        "00000000-0000-0000-0000-0000000000x1", parquet, "geom"
    )

    assert seen["dir"] == catalog_tiles_dir()
    # Beside the parquet, not in it: the tiles are a cache of that file and are
    # cleared without touching it.
    assert seen["dir"] != catalog_layers_dir()
    assert seen["dir"].parent == catalog_layers_dir().parent


@pytest.mark.parametrize(
    ("select", "expected"),
    [
        # A feature without a geometry is no feature a tool can use: tools
        # seed from the rows that have one, and the workflow check compares
        # this count with their limits.
        (
            "SELECT * FROM (VALUES (1, ST_Point(0, 0)), (2, NULL::GEOMETRY), "
            "(3, ST_Point(1, 1))) t(id, geom)",
            2,
        ),
        # A table has no geometry column: every row counts.
        ("SELECT * FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) t(id, name)", 3),
    ],
)
def test_the_recorded_count_is_of_features_with_a_geometry(
    tmp_path, monkeypatch, select: str, expected: int
) -> None:
    monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path / "catalog" / "layers"))
    monkeypatch.setenv("CATALOG_S3_BUCKET", "catalog")
    source = tmp_path / "item.parquet"
    fixture = duckdb.connect()
    fixture.execute("INSTALL spatial; LOAD spatial;")
    fixture.execute(f"COPY ({select}) TO '{source}' (FORMAT PARQUET)")
    fixture.close()

    def download_file(_bucket: str, _key: str, target: str) -> None:
        shutil.copyfile(source, target)

    runner = CatalogMaterializeRunner()
    monkeypatch.setattr(
        runner, "_catalog_s3", lambda: SimpleNamespace(download_file=download_file)
    )

    _, feature_count, _, _ = runner._materialize_vector(
        "00000000-0000-0000-0000-000000000001", "../../../data/item.parquet"
    )

    assert feature_count == expected


LAYER_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
TIF_HREF = "../../../data/935c5031-d9e3-4afa-803a-9dc2ffe47cb7.tif"
#: A little-endian TIFF header; the job checks the signature, not the image.
TIFF_BYTES = b"II*\x00" + b"\x00" * 60


def _raster_runner(monkeypatch, tmp_path, body: bytes):  # noqa: ANN001, ANN202
    """A runner whose catalog bucket holds `body` under every key, and the
    keys it was asked for."""
    monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path / "catalog" / "layers"))
    monkeypatch.setenv("CATALOG_S3_BUCKET", "catalog")
    asked: list[str] = []

    def download_file(_bucket: str, key: str, target: str) -> None:
        asked.append(key)
        with open(target, "wb") as f:
            f.write(body)

    runner = CatalogMaterializeRunner()
    runner.settings = SimpleNamespace(customer_schema="customer")
    monkeypatch.setattr(
        runner, "_catalog_s3", lambda: SimpleNamespace(download_file=download_file)
    )
    return runner, asked


def _raster_layer() -> dict:
    return {
        "type": "raster",
        "other_properties": {"catalog_item": {"parquet_url": TIF_HREF}},
    }


def test_a_raster_is_copied_beside_the_parquet_copies(tmp_path, monkeypatch) -> None:
    """The catalog bucket is private, so geoapi cannot read the item's GeoTIFF
    where it is published: the job copies it to the data volume, where the
    vector layers' parquet copies are, and the layer is ready once it is there."""
    from goatlib.utils.layer import catalog_layers_dir, stored_raster_file

    runner, asked = _raster_runner(monkeypatch, tmp_path, TIFF_BYTES)
    statuses: list[str] = []
    finish = AsyncMock()

    async def fake_set_status(
        layer_id: str, status: str, extra: dict | None = None
    ) -> None:
        statuses.append(status)

    with (
        patch.object(runner, "_load_layer", AsyncMock(return_value=_raster_layer())),
        patch.object(runner, "_set_status", side_effect=fake_set_status),
        patch.object(runner, "_finish_raster", finish),
    ):
        result = runner.run(CatalogMaterializeParams(layer_id=LAYER_ID, user_id="u"))

    target = stored_raster_file(LAYER_ID)
    assert target.parent == catalog_layers_dir()
    assert target.name == "t_3fa85f6457174562b3fc2c963f66afa6.tif"
    assert target.read_bytes() == TIFF_BYTES
    assert asked == ["data/935c5031-d9e3-4afa-803a-9dc2ffe47cb7.tif"]
    finish.assert_awaited_once_with(LAYER_ID, target)
    assert "failed" not in statuses
    assert result["status"] == "ready" and result["path"] == str(target)


def test_an_object_that_is_no_geotiff_fails_and_leaves_no_file(
    tmp_path, monkeypatch
) -> None:
    from goatlib.utils.layer import stored_raster_file

    runner, _ = _raster_runner(monkeypatch, tmp_path, b"<html>not found</html>")
    statuses: list[str] = []

    async def fake_set_status(
        layer_id: str, status: str, extra: dict | None = None
    ) -> None:
        statuses.append(status)

    with (
        patch.object(runner, "_load_layer", AsyncMock(return_value=_raster_layer())),
        patch.object(runner, "_set_status", side_effect=fake_set_status),
        patch.object(runner, "_finish_raster", AsyncMock()),
        pytest.raises(ValueError, match="GeoTIFF"),
    ):
        runner.run(CatalogMaterializeParams(layer_id=LAYER_ID, user_id="u"))

    assert statuses[-1] == "failed"
    assert not stored_raster_file(LAYER_ID).exists()


@pytest.mark.asyncio
async def test_a_ready_raster_is_a_file_layer_without_an_address(tmp_path) -> None:
    """`data_type = 'cog'` makes it a raster file layer; it has no `url`, since
    the catalog bucket is private and no address of the file exists: geoapi
    and processes read a catalog raster from its copy, by the layer's id."""
    runner = CatalogMaterializeRunner()
    runner.settings = SimpleNamespace(customer_schema="customer")
    executed: list[tuple] = []

    class Pool:
        async def execute(self, sql: str, *args: object) -> None:
            executed.append((" ".join(sql.split()), args))

        async def close(self) -> None:
            pass

    copy = tmp_path / "t_x.tif"
    copy.write_bytes(TIFF_BYTES)
    statuses: list[str] = []

    async def fake_set_status(
        layer_id: str, status: str, extra: dict | None = None
    ) -> None:
        statuses.append(status)

    with (
        patch.object(runner, "get_postgres_pool", AsyncMock(return_value=Pool())),
        patch.object(runner, "_set_status", side_effect=fake_set_status),
    ):
        await runner._finish_raster(LAYER_ID, copy)

    [(sql, args)] = executed
    assert "data_type = 'cog'" in sql and "url = NULL" in sql and "size = $2" in sql
    assert args[1:] == (len(TIFF_BYTES),)
    assert statuses == ["ready"]


def test_the_catalog_gc_removes_a_rasters_copy_too(tmp_path, monkeypatch) -> None:
    """A swept raster layer must not leave its GeoTIFF behind for good."""
    from goatlib.tasks.catalog_gc import CatalogGCTask
    from goatlib.utils.layer import stored_raster_file

    monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path / "catalog" / "layers"))
    task = CatalogGCTask()
    task.settings = None
    assert stored_raster_file(LAYER_ID) in task._artifact_paths(LAYER_ID)
