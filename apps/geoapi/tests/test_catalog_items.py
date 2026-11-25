"""Catalog items that are not layers yet, read for a preview.

geoapi answers its own tile and raster routes for the collection
`catalog:<item id>`: a vector item's published `.pmtiles` and a raster item's
GeoTIFF, both from the private catalog bucket. These tests pin who may read
(one rule, always enforced), that the object read is the item's own, and that
the files are read by the code that reads a layer's."""

import gzip
import io
import random
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import UUID

import duckdb
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from goatlib.raster.source import BandStats, PointValues, RasterInfo
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write as write_pmtiles

from geoapi.config import settings
from geoapi.deps import authz
from geoapi.services import catalog_items as ci
from geoapi.services import raster_service as rs
from geoapi.services.tile_service import tile_service

USER = UUID("22222222-2222-2222-2222-222222222222")
SIGNED_IN = {"Authorization": "Bearer a-token"}
VECTOR = "c6f85bab-bbd7-4d07-ae40-fea03947690c"
RASTER = "d6267836-c9ca-4366-bd7c-78f80b0b7a75"
TABLE = "0604091a-c95e-40a5-a412-68530196fc95"
TILES = f"/collections/catalog:{VECTOR}/tiles/WebMercatorQuad"
COVERAGE = f"/collections/catalog:{RASTER}/coverage/tiles/WebMercatorQuad"
#: Every route a preview asks, of a vector and of a raster item.
PREVIEW_ROUTES = [
    f"{TILES}/0/0/0",
    COVERAGE,
    f"{COVERAGE}/12/1420/2178?f=webp&band=1&base=0&step=1",
    f"/collections/catalog:{RASTER}/raster/tiles",
    f"/collections/catalog:{RASTER}/raster/tiles/12/2178/1420.webp",
    f"/collections/catalog:{RASTER}/raster/info",
    f"/collections/catalog:{RASTER}/raster/point?lon=11.5&lat=48.1",
]


INFO = RasterInfo(
    512,
    512,
    (11.5, 48.1, 11.6, 48.2),
    1,
    "float32",
    -9999.0,
    (32,),
    None,
    (1.0,),
    (0.0,),
    ("Band 1",),
    maxzoom=17,
    minzoom=10,
)


class FakeSource:
    """goatlib's `RasterSource` as the raster service opens it: what it was
    opened with, and fixed answers."""

    opened: list[str] = []
    hosts: list[tuple[str, ...]] = []

    def __init__(self, url: str, private_hosts: Any = (), **_: Any) -> None:
        self.url = url
        FakeSource.hosts.append(tuple(private_hosts))

    def __enter__(self) -> "FakeSource":
        FakeSource.opened.append(self.url)
        return self

    def __exit__(self, *args: Any) -> None:
        pass

    def info(self) -> RasterInfo:
        return INFO

    def statistics(self) -> list[BandStats]:
        return [BandStats(1, 100.0, 400.0, 250.0, 80.0, 106.0, 394.0, None, None)]

    def tile(self, *args: Any, **kwargs: Any) -> bytes:
        return b"RIFF-image"

    def values(self, *args: Any, **kwargs: Any) -> bytes:
        return b"RIFF-values"

    def point(self, lon: float, lat: float, formula: Any = None) -> PointValues:
        return PointValues([250.0], None)


def _missing(operation: str, status: int = 404) -> ClientError:
    code = "PreconditionFailed" if status == 412 else "NoSuchKey"
    return ClientError(
        {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}},
        operation,
    )


class FakeBucket:
    """The catalog bucket as boto3 answers for it."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.reads: list[tuple[str, int, int]] = []
        self.signed: list[str] = []

    def get_object(
        self, Bucket: str, Key: str, Range: str, IfMatch: str | None = None
    ) -> dict[str, Any]:
        if Key not in self.objects:
            raise _missing("GetObject")
        data, etag = self.objects[Key]
        if IfMatch is not None and IfMatch != etag:
            raise _missing("GetObject", 412)
        start, end = (int(part) for part in Range.removeprefix("bytes=").split("-"))
        self.reads.append((Key, start, end))
        return {"Body": io.BytesIO(data[start : end + 1]), "ETag": etag}

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        if Key not in self.objects:
            raise _missing("HeadObject")
        return {"ETag": self.objects[Key][1]}

    def generate_presigned_url(
        self, operation: str, Params: dict[str, str], ExpiresIn: int
    ) -> str:
        self.signed.append(Params["Key"])
        return (
            f"https://bucket.example/{Params['Bucket']}/{Params['Key']}"
            f"?X-Amz-Signature=s{len(self.signed)}"
        )


#: A tile that does not fit in the head of its file (`HEAD_BYTES`): it and
#: the tiles after it are read from the bucket in ranges of their own.
WORLD = random.Random(7).randbytes(ci.HEAD_BYTES + 4096)


def _pmtiles(path: Path, tiles: dict[tuple[int, int, int], bytes]) -> bytes:
    """A tile file holding `tiles` (gzip MVT), as bytes."""
    with write_pmtiles(str(path)) as writer:
        for zxy in sorted(tiles, key=lambda t: zxy_to_tileid(*t)):
            writer.write_tile(zxy_to_tileid(*zxy), gzip.compress(tiles[zxy]))
        writer.finalize(
            {
                "tile_type": TileType.MVT,
                "tile_compression": Compression.GZIP,
                "min_zoom": min(z for z, _, _ in tiles),
                "max_zoom": max(z for z, _, _ in tiles),
                "min_lon_e7": -1800000000,
                "min_lat_e7": -850000000,
                "max_lon_e7": 1800000000,
                "max_lat_e7": 850000000,
                "center_zoom": 0,
                "center_lon_e7": 0,
                "center_lat_e7": 0,
            },
            {"vector_layers": [{"id": "default", "fields": {}}]},
        )
    return path.read_bytes()


@pytest.fixture
def bucket(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeBucket]:
    """A mirror with a vector item with published tiles, a raster item and a
    table, and the bucket their files are in."""
    href = "../../../../../../data"
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE items AS SELECT * FROM (VALUES "
        f"('{VECTOR}', '{href}/{VECTOR}.parquet', "
        f" {{'data': {{'href': '{href}/{VECTOR}.parquet'}}, "
        f"   'tiles': {{'href': '{href}/{VECTOR}.pmtiles'}}}}), "
        f"('{RASTER}', '{href}/{RASTER}.tif', "
        f" {{'data': {{'href': '{href}/{RASTER}.tif'}}, 'tiles': NULL}}), "
        f"('{TABLE}', '{href}/{TABLE}.parquet', "
        f" {{'data': {{'href': '{href}/{TABLE}.parquet'}}, 'tiles': NULL}}) "
        ") AS t(id, parquet_url, assets)"
    )
    con.execute(f"COPY items TO '{tmp_path / ci.MIRROR_ITEMS}' (FORMAT PARQUET)")
    con.close()
    fake = FakeBucket()
    fake.objects[f"data/{VECTOR}.pmtiles"] = (
        _pmtiles(tmp_path / "a.pmtiles", {(0, 0, 0): WORLD, (1, 1, 0): b"east"}),
        '"tiles-1"',
    )
    fake.objects[f"data/{RASTER}.tif"] = (b"II*\x00", '"tif-1"')
    monkeypatch.setattr(settings, "CATALOG_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "CATALOG_S3_BUCKET", "catalog")
    monkeypatch.setattr(settings, "AUTH", True)
    ci.catalog_items.clear()
    tile_service.forget_catalog_tiles()
    rs.raster_service.clear()
    with patch.object(ci.catalog_items, "_client", return_value=fake):
        yield fake
    ci.catalog_items.clear()
    tile_service.forget_catalog_tiles()


@pytest.fixture
def client(bucket: FakeBucket, test_client: TestClient) -> Iterator[TestClient]:
    """Signed in for a request with `SIGNED_IN`; the raster reader is faked
    (goatlib's is tested there)."""
    FakeSource.opened, FakeSource.hosts = [], []

    def decode(token: str) -> dict[str, str]:
        from goatlib.auth import JOSEError

        if token != "a-token":
            raise JOSEError("bad token")
        return {"sub": str(USER)}

    with (
        patch("geoapi.deps.auth.decode_token", decode),
        patch.object(rs, "RasterSource", FakeSource),
        patch.object(rs, "remote_validator", return_value=None),
    ):
        yield test_client


# --- who may read ---------------------------------------------------------


def test_the_rule_is_signed_in_users() -> None:
    """The one place that decides: a public read-only catalog later is a
    change of this function, not of the routes."""
    assert authz.catalog_read_allowed(VECTOR, None) is False
    assert authz.catalog_read_allowed(VECTOR, USER) is True


@pytest.mark.parametrize("route", PREVIEW_ROUTES)
def test_no_preview_without_a_sign_in(client: TestClient, route: str) -> None:
    """Refused whatever `ENFORCE_READ_AUTHZ` says: layers are in shadow mode by
    default, catalog items never are. Nothing is read for the refusal."""
    can = AsyncMock(return_value=True)
    with (
        patch.object(settings, "ENFORCE_READ_AUTHZ", False),
        patch.object(authz.layer_service, "user_can_read_layer", can),
    ):
        anonymous = client.get(route)
        bad_token = client.get(route, headers={"Authorization": "Bearer other"})
    assert anonymous.status_code == 401
    assert anonymous.headers["www-authenticate"] == "Bearer"
    assert bad_token.status_code == 401
    # Not a layer: the layers' rule is not asked.
    can.assert_not_awaited()
    assert ci.catalog_items._client().reads == []
    assert FakeSource.opened == []


def test_auth_off_reads_without_a_token(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`AUTH=False` is the one switch that turns sign-in off everywhere."""
    monkeypatch.setattr(settings, "AUTH", False)
    assert client.get(f"{TILES}/0/0/0").status_code == 200


def test_a_malformed_item_id_is_refused(client: TestClient) -> None:
    r = client.get("/collections/catalog:..%2Fsecret/tiles/WebMercatorQuad/0/0/0")
    assert r.status_code in (400, 404)
    assert ci.catalog_items._client().reads == []


def test_only_tiles_and_rasters_are_served_for_an_item(client: TestClient) -> None:
    """The features, the download and the other layer routes know no catalog
    item: its data file has no route."""
    for route in ("items", "items/1", "queryables", "download?format=gpkg"):
        r = client.get(f"/collections/catalog:{VECTOR}/{route}", headers=SIGNED_IN)
        assert r.status_code in (400, 404, 405), route


# --- vector tiles ---------------------------------------------------------


def test_a_tile_of_the_items_published_tiles(
    client: TestClient, bucket: FakeBucket
) -> None:
    r = client.get(f"{TILES}/1/1/0", headers=SIGNED_IN)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/vnd.mapbox-vector-tile"
    assert r.headers["content-encoding"] == "gzip"
    assert r.content == b"east"  # the test client decodes gzip
    # Read with a sign-in: no shared cache may keep it.
    assert r.headers["cache-control"].startswith("private")
    # The item's own file, named by its href's file name under data/.
    assert {key for key, _, _ in bucket.reads} == {f"data/{VECTOR}.pmtiles"}


def test_the_head_of_a_tile_file_is_read_once(
    client: TestClient, bucket: FakeBucket
) -> None:
    client.get(f"{TILES}/0/0/0", headers=SIGNED_IN)
    first = len(bucket.reads)
    client.get(f"{TILES}/1/1/0", headers=SIGNED_IN)
    # The second tile costs its own bytes only: header and directory are kept.
    assert len(bucket.reads) == first + 1


def test_an_empty_tile_has_no_content(client: TestClient) -> None:
    r = client.get(f"{TILES}/1/0/1", headers=SIGNED_IN)
    assert r.status_code == 204


def test_a_tile_below_the_stored_ones_is_cut_from_its_parent(
    client: TestClient,
) -> None:
    """Published tiles stop where a tile holds all its detail (variable depth),
    as a layer's own: a deeper tile is cut from the stored parent."""
    cut = AsyncMock(return_value=gzip.compress(b"cut"))
    with patch.object(tile_service, "_overzoom_tile", cut):
        r = client.get(f"{TILES}/3/7/0", headers=SIGNED_IN)
    assert r.status_code == 200 and r.content == b"cut"
    parent, *where = cut.await_args.args[:7]
    assert gzip.decompress(parent) == b"east"
    assert where == [1, 1, 0, 3, 7, 0]


def test_a_replaced_tile_file_is_read_anew(
    client: TestClient, bucket: FakeBucket, tmp_path: Path
) -> None:
    """goat-data replaces a tile file under the same name: a read against the
    old file fails its ETag and the file is opened again."""
    assert client.get(f"{TILES}/0/0/0", headers=SIGNED_IN).content == WORLD
    bucket.objects[f"data/{VECTOR}.pmtiles"] = (
        _pmtiles(tmp_path / "b.pmtiles", {(0, 0, 0): WORLD[::-1]}),
        '"tiles-2"',
    )
    assert client.get(f"{TILES}/0/0/0", headers=SIGNED_IN).content == WORLD[::-1]


def test_a_small_replaced_tile_file_is_read_anew_after_a_minute(
    client: TestClient, bucket: FakeBucket, tmp_path: Path
) -> None:
    """A file that fits in its head is answered without a read of the bucket,
    so nothing tells that it was replaced: its reader is kept for a minute."""
    key = f"data/{VECTOR}.pmtiles"
    bucket.objects[key] = (_pmtiles(tmp_path / "s.pmtiles", {(0, 0, 0): b"a"}), '"1"')
    assert client.get(f"{TILES}/0/0/0", headers=SIGNED_IN).content == b"a"
    bucket.objects[key] = (_pmtiles(tmp_path / "t.pmtiles", {(0, 0, 0): b"b"}), '"2"')
    assert client.get(f"{TILES}/0/0/0", headers=SIGNED_IN).content == b"a"
    assert tile_service._catalog_readers.ttl == 60
    tile_service._catalog_readers.expire(time.monotonic() + 61)
    assert client.get(f"{TILES}/0/0/0", headers=SIGNED_IN).content == b"b"


def test_an_item_without_published_tiles_has_none(client: TestClient) -> None:
    for item in (TABLE, RASTER, "3fa85f64-5717-4562-b3fc-2c963f66afa6"):
        r = client.get(
            f"/collections/catalog:{item}/tiles/WebMercatorQuad/0/0/0",
            headers=SIGNED_IN,
        )
        assert r.status_code == 404, item


def test_tiles_missing_from_the_bucket_are_not_found(
    client: TestClient, bucket: FakeBucket
) -> None:
    del bucket.objects[f"data/{VECTOR}.pmtiles"]
    assert client.get(f"{TILES}/0/0/0", headers=SIGNED_IN).status_code == 404


def test_the_key_is_the_hrefs_file_name_under_data(tmp_path: Path) -> None:
    """Whatever an item's href walks to, the object read is `data/<name>` with
    the asset's own suffix: an href is the harvester's input, not an address."""
    item = ci.item_of(
        "x",
        "../../secret/x.tif",
        {"tiles": {"href": "s3://other-bucket/private/../y.pmtiles"}},
    )
    assert item.raster_key == "data/x.tif" and item.tiles_key == "data/y.pmtiles"
    wrong = ci.item_of("x", "../data/x.parquet", {"tiles": {"href": "../x.txt"}})
    assert wrong.raster_key is None and wrong.tiles_key is None


def test_no_bucket_no_preview(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "CATALOG_S3_BUCKET", None)
    assert client.get(f"{TILES}/0/0/0", headers=SIGNED_IN).status_code == 404
    assert client.get(COVERAGE, headers=SIGNED_IN).status_code == 404


# --- rasters --------------------------------------------------------------


def test_a_raster_items_value_tiles_are_described_as_a_layers(
    client: TestClient, bucket: FakeBucket
) -> None:
    r = client.get(COVERAGE, headers=SIGNED_IN)
    assert r.status_code == 200
    body = r.json()
    # The tiles are asked for under the same collection id.
    assert (
        f"/collections/catalog:{RASTER}/coverage/tiles/WebMercatorQuad/"
        in (body["links"][0]["href"])
    )
    assert body["goat:values"]["encoding"]
    assert r.headers["cache-control"].startswith("private")
    # Read by the reader a layer's file is read by (goatlib's `RasterSource`,
    # which refuses a tile that would read a file without overviews whole),
    # from an address signed for the item's own file.
    assert bucket.signed == [f"data/{RASTER}.tif"]
    assert len(FakeSource.opened) == 1
    assert FakeSource.opened[0].startswith(
        f"https://bucket.example/catalog/data/{RASTER}.tif?"
    )
    # The bucket is GOAT's own storage: the URL guard lets its host through.
    assert "bucket.example" in FakeSource.hosts[0]


def test_a_raster_items_tiles_are_read_from_one_address(
    client: TestClient, bucket: FakeBucket
) -> None:
    """The signed address is reused: what goatlib and GDAL keep of a file is
    kept by its address."""
    version = client.get(COVERAGE, headers=SIGNED_IN).json()["goat:values"]["version"]
    tile = f"{COVERAGE}/12/1420/2178?f=webp&band=1&base=0&step=1&v={version}"
    assert client.get(tile, headers=SIGNED_IN).status_code == 200
    rs.raster_service._rows.clear()  # the item is looked up again after a minute
    assert client.get(tile, headers=SIGNED_IN).status_code == 200
    assert len(bucket.signed) == 1
    assert len(set(FakeSource.opened)) == 1


def test_a_replaced_raster_gets_another_version(
    client: TestClient, bucket: FakeBucket
) -> None:
    first = client.get(COVERAGE, headers=SIGNED_IN).json()["goat:values"]["version"]
    bucket.objects[f"data/{RASTER}.tif"] = (b"II*\x00", '"tif-2"')
    rs.raster_service._rows.clear()
    second = client.get(COVERAGE, headers=SIGNED_IN).json()["goat:values"]["version"]
    assert first != second


def test_the_signed_address_reaches_no_client(client: TestClient) -> None:
    for route in (COVERAGE, f"/collections/catalog:{RASTER}/raster/tiles"):
        r = client.get(route, headers=SIGNED_IN)
        assert r.status_code == 200
        assert "X-Amz" not in r.text and "bucket.example" not in r.text


def test_an_item_that_is_no_raster_has_no_raster_routes(client: TestClient) -> None:
    for item in (VECTOR, TABLE, "3fa85f64-5717-4562-b3fc-2c963f66afa6"):
        r = client.get(
            f"/collections/catalog:{item}/coverage/tiles/WebMercatorQuad",
            headers=SIGNED_IN,
        )
        assert r.status_code == 404, item
