"""Tests for `/assets/{item_id}/{kind}` (catalog.services.assets).

No network: the reader's one bucket-shaped seam (`object_url`) is pointed at
local files, so the prefix allow-list, the media-type rule, the size ceiling,
the href rewriting and the route's wiring are all exercised offline.

The security properties are the point of most of this file. The route takes an
item id and a kind — never an object key — so the questions worth asking are
"can a caller reach an object the harvester did not point at" and "can a body be
served under a type it is not".
"""

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from catalog.app import create_app
from catalog.config import CatalogSettings
from catalog.errors import ApiError
from catalog.services.assets import (
    ASSET_KINDS,
    AssetKind,
    AssetReader,
    valid_item_id,
)
from catalog.services.preview import object_key
from catalog.services.stac_build import _public_assets

BUCKET = "p4b-catalog-test"
THUMB = ASSET_KINDS["thumbnail"]
STYLE = ASSET_KINDS["style"]


class _LocalReader(AssetReader):
    """A reader whose 'bucket' is a directory.

    Everything above the fetch — key resolution, the allow-list, the media-type
    rule, the ceiling — is the same code that runs against S3.
    """

    def __init__(self, settings: CatalogSettings, root: Path) -> None:
        super().__init__(settings)
        self._root = root

    def object_url(self, key: str) -> str:
        return (self._root / key).as_posix()


def _settings(tmp_path: Path, **overrides: Any) -> CatalogSettings:
    return CatalogSettings(
        data_dir=tmp_path,
        s3_catalog_bucket=BUCKET,
        s3_access_key_id="key",
        s3_secret_access_key="secret",
        s3_endpoint_url="https://example.invalid",
        **overrides,
    )


@pytest.fixture()
def objects(tmp_path: Path) -> Path:
    """A stand-in bucket holding one thumbnail, one style and one data object."""
    root = tmp_path / "bucket"
    (root / "thumbs").mkdir(parents=True)
    (root / "styles").mkdir(parents=True)
    (root / "data").mkdir(parents=True)
    (root / "thumbs" / "item-1.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'
    )
    (root / "styles" / "item-1.json").write_text(json.dumps({"stroke_width": 3}))
    (root / "data" / "item-1.parquet").write_bytes(b"PAR1-not-really")
    return root


@pytest.fixture()
def reader(tmp_path: Path, objects: Path) -> AssetReader:
    return _LocalReader(_settings(tmp_path), objects)


def _row(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": "item-1",
        "assets": {
            "thumbnail": {
                "href": "../../../thumbs/item-1.svg",
                "type": "image/svg+xml",
            },
            "style": {
                "href": "../../../styles/item-1.json",
                "type": "application/json",
            },
            "data": {
                "href": "../../../data/item-1.parquet",
                "type": "application/x-parquet",
            },
        },
    }
    row.update(overrides)
    return row


# ────────────────────────────────────────────────────────────────────────
# What a caller can reach
# ────────────────────────────────────────────────────────────────────────


class TestReachableObjects:
    def test_thumbnail_and_style_are_served(self, reader: AssetReader) -> None:
        content, media_type, key = reader.read(THUMB, _row())
        assert content.startswith(b"<svg")
        assert media_type == "image/svg+xml"
        assert key == "thumbs/item-1.svg"

        content, media_type, key = reader.read(STYLE, _row())
        assert json.loads(content) == {"stroke_width": 3}
        assert media_type == "application/json"
        assert key == "styles/item-1.json"

    def test_the_data_object_is_unreachable_through_either_kind(
        self, reader: AssetReader
    ) -> None:
        """The GeoParquet has no kind, and no kind's prefix admits it.

        Both halves matter: there is no `data` row in ASSET_KINDS to ask for, and
        an href pointing into `data/` is refused even when it arrives under a
        kind that does exist.
        """
        assert "data" not in ASSET_KINDS
        row = _row(
            assets={
                "thumbnail": {
                    "href": "../../../data/item-1.parquet",
                    "type": "image/svg+xml",
                }
            }
        )
        with pytest.raises(ApiError) as excinfo:
            reader.read(THUMB, row)
        assert excinfo.value.status_code == 404

    @pytest.mark.parametrize(
        "href",
        [
            "../../../items.parquet",  # the catalog's own metadata
            "../../../../etc/passwd",
            "thumbs/../data/item-1.parquet",
            "thumbs/../../secrets/key.svg",
            "s3://someone-elses-bucket/thumbs/item-1.svg",
            "https://nbg1.your-objectstorage.com/other-bucket/thumbs/x.svg",
            "http://169.254.169.254/latest/meta-data/",
            "file:///etc/passwd",
            "",
        ],
    )
    def test_an_href_outside_the_kinds_prefix_is_refused(
        self, reader: AssetReader, href: str
    ) -> None:
        """The href is publisher-controlled input to a fetch we perform.

        A harvester change cannot turn the thumbnail route into a reader of
        anything else — including the metadata parquet next to the objects.
        """
        with pytest.raises(ApiError):
            reader.read(THUMB, _row(assets={"thumbnail": {"href": href}}))

    def test_a_style_href_may_not_borrow_the_thumbnail_prefix(
        self, reader: AssetReader
    ) -> None:
        with pytest.raises(ApiError):
            reader.read(
                STYLE, _row(assets={"style": {"href": "../../../thumbs/x.svg"}})
            )

    def test_an_item_without_the_asset_is_a_404(self, reader: AssetReader) -> None:
        with pytest.raises(ApiError) as excinfo:
            reader.read(
                THUMB, _row(assets={"style": {"href": "../../../styles/a.json"}})
            )
        assert excinfo.value.status_code == 404

    def test_a_published_href_whose_object_is_missing_is_a_404(
        self, reader: AssetReader
    ) -> None:
        """Upstream drift, not a server error: the href names nothing uploaded."""
        with pytest.raises(ApiError) as excinfo:
            reader.read(
                THUMB, _row(assets={"thumbnail": {"href": "../../../thumbs/nope.svg"}})
            )
        assert excinfo.value.status_code == 404


class TestConcurrentReads:
    """The reader is shared across FastAPI's threadpool, so two requests read
    at the same time. A single DuckDB connection is not safe for that: an
    ``execute`` on one thread can be answered by a ``fetchall`` on another,
    handing one item's bytes to a request for a different item. The other
    readers clone a cursor per call; this one must too.

    The objects are a couple of megabytes on purpose. With tiny ones each read
    finishes before another thread can interleave, and the test passes against
    the unsafe code.
    """

    def test_parallel_reads_each_get_their_own_object(self, tmp_path: Path) -> None:
        import concurrent.futures
        from collections import Counter

        root = tmp_path / "bucket"
        (root / "thumbs").mkdir(parents=True)
        (root / "styles").mkdir(parents=True)
        thumb = b"A" * 2_000_000
        style = b"B" * 2_000_000
        (root / "thumbs" / "item-1.svg").write_bytes(thumb)
        (root / "styles" / "item-1.json").write_bytes(style)
        reader = _LocalReader(_settings(tmp_path, assets_max_bytes=10_000_000), root)
        expected = {THUMB: thumb, STYLE: style}

        def one(kind: AssetKind) -> str:
            content, _media, _key = reader.read(kind, _row())
            return "ok" if content == expected[kind] else "another object's bytes"

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            outcomes = Counter(pool.map(one, [THUMB, STYLE] * 1000))

        assert outcomes == {"ok": 2000}, dict(outcomes)


class TestMediaType:
    def test_a_type_the_kind_does_not_serve_is_refused(
        self, reader: AssetReader
    ) -> None:
        """`text/html` from our own origin would be script execution.

        The declared type is publisher-adjacent, so it is checked against the
        kind rather than echoed.
        """
        with pytest.raises(ApiError):
            reader.media_type(THUMB, "text/html")
        with pytest.raises(ApiError):
            reader.media_type(STYLE, "image/svg+xml")

    def test_a_raster_thumbnail_needs_no_code_change(self, reader: AssetReader) -> None:
        assert reader.media_type(THUMB, "image/png") == "image/png"

    def test_parameters_are_stripped_and_case_is_ignored(
        self, reader: AssetReader
    ) -> None:
        assert reader.media_type(THUMB, "IMAGE/SVG+XML; charset=utf-8") == (
            "image/svg+xml"
        )

    def test_an_undeclared_type_falls_back_to_the_kinds_own(
        self, reader: AssetReader
    ) -> None:
        assert reader.media_type(THUMB, None) == "image/svg+xml"


class TestCeiling:
    def test_an_object_over_the_ceiling_is_not_served(
        self, tmp_path: Path, objects: Path
    ) -> None:
        """A read is whole-object, so the ceiling is the memory guard."""
        (objects / "thumbs" / "big.svg").write_bytes(b"<svg>" + b"x" * 4096)
        reader = _LocalReader(_settings(tmp_path, assets_max_bytes=1024), objects)
        with pytest.raises(ApiError):
            reader.read(
                THUMB, _row(assets={"thumbnail": {"href": "../../../thumbs/big.svg"}})
            )


class TestItemIdShape:
    @pytest.mark.parametrize(
        "item_id",
        [
            "8ae1da9d-1295-4e88-8b4c-23693f310e28",
            "data_gv_at:2f5baa1f-208c-42c2-8d",  # real ids carry a source prefix
            "a.b_c-d",
        ],
    )
    def test_real_ids_are_accepted(self, item_id: str) -> None:
        assert valid_item_id(item_id)

    @pytest.mark.parametrize(
        "item_id",
        ["../data/x", "a/b", "a\\b", "a b", "", "x" * 201, "a%2fb", "a\x00b"],
    )
    def test_anything_path_shaped_is_not(self, item_id: str) -> None:
        assert not valid_item_id(item_id)


# ────────────────────────────────────────────────────────────────────────
# What the served documents say
# ────────────────────────────────────────────────────────────────────────


class TestServedHrefs:
    def test_the_two_kinds_are_rewritten_onto_this_api(self) -> None:
        served = _public_assets(
            _row()["assets"],
            item_id="item-1",
            assets_base="https://catalog.example.com/assets",
        )
        assert served["thumbnail"]["href"] == (
            "https://catalog.example.com/assets/item-1/thumbnail"
        )
        assert served["style"]["href"] == (
            "https://catalog.example.com/assets/item-1/style"
        )

    def test_the_data_asset_is_still_dropped(self) -> None:
        served = _public_assets(
            _row()["assets"],
            item_id="item-1",
            assets_base="https://catalog.example.com/assets",
        )
        assert "data" not in served

    def test_an_id_needing_escaping_survives_the_href(self) -> None:
        served = _public_assets(
            _row()["assets"],
            item_id="data_gv_at:2f5b",
            assets_base="https://catalog.example.com/assets",
        )
        assert served["thumbnail"]["href"].endswith("/data_gv_at%3A2f5b/thumbnail")

    def test_without_a_base_nothing_relative_is_published(self) -> None:
        """An offline rebuild has no API base, and a relative href is unservable."""
        assert _public_assets(_row()["assets"]) == {}

    def test_the_type_and_the_other_members_are_preserved(self) -> None:
        served = _public_assets(
            {
                "thumbnail": {
                    "href": "../../../thumbs/a.svg",
                    "type": "image/png",
                    "roles": ["thumbnail"],
                }
            },
            item_id="item-1",
            assets_base="https://catalog.example.com/assets",
        )
        assert served["thumbnail"]["type"] == "image/png"
        assert served["thumbnail"]["roles"] == ["thumbnail"]


# ────────────────────────────────────────────────────────────────────────
# The route
# ────────────────────────────────────────────────────────────────────────


class TestRoute:
    def test_assets_are_404_when_no_bucket_is_configured(
        self, catalog_dir: Path
    ) -> None:
        """The default deployment serves no assets, so the route is not there."""
        app = create_app(CatalogSettings(data_dir=catalog_dir, auth=False))
        with TestClient(app) as client:
            r = client.get("/assets/radverkehrsnetz-dresden-0/thumbnail")
        assert r.status_code == 404

    def test_an_unknown_kind_is_404(self, catalog_dir: Path) -> None:
        app = create_app(
            CatalogSettings(
                data_dir=catalog_dir,
                auth=False,
                s3_catalog_bucket=BUCKET,
                s3_access_key_id="key",
                s3_secret_access_key="secret",
            )
        )
        with TestClient(app) as client:
            r = client.get("/assets/radverkehrsnetz-dresden-0/data")
        assert r.status_code == 404

    def test_an_unknown_item_is_404(self, catalog_dir: Path) -> None:
        app = create_app(
            CatalogSettings(
                data_dir=catalog_dir,
                auth=False,
                s3_catalog_bucket=BUCKET,
                s3_access_key_id="key",
                s3_secret_access_key="secret",
            )
        )
        with TestClient(app) as client:
            r = client.get("/assets/does-not-exist/thumbnail")
            # Same bounds as geoapi's tile routes, refused before any read.
            too_deep = client.get("/assets/does-not-exist/tiles/40/0/0")
        assert r.status_code == 404
        assert too_deep.status_code == 400

    def test_a_served_asset_carries_its_type_and_cache_and_guard_headers(
        self, catalog_dir: Path, objects: Path
    ) -> None:
        """The response is cacheable, and cannot be re-interpreted by a browser."""
        settings = CatalogSettings(
            data_dir=catalog_dir,
            auth=False,
            s3_catalog_bucket=BUCKET,
            s3_access_key_id="key",
            s3_secret_access_key="secret",
        )
        app = create_app(settings)
        with TestClient(app) as client:
            app.state.asset_reader = _LocalReader(settings, objects)
            # The fixture catalog's own row, pointed at the stand-in objects.
            store = app.state.store
            row_id = store.query(
                f"SELECT id FROM {store.ITEMS} WHERE id = 'radverkehrsnetz-dresden-0'"
            )[0][0]
            app.state.asset_reader = _LocalReader(settings, objects)

            original_read = app.state.asset_reader.read

            def read_with_our_href(kind: Any, row: dict[str, Any]) -> Any:
                return original_read(kind, _row())

            app.state.asset_reader.read = read_with_our_href  # type: ignore[method-assign]
            r = client.get(f"/assets/{row_id}/thumbnail")

        assert r.status_code == 200
        assert r.headers["content-type"].startswith("image/svg+xml")
        assert "max-age=86400" in r.headers["cache-control"]
        assert r.headers["x-content-type-options"] == "nosniff"
        assert "default-src 'none'" in r.headers["content-security-policy"]
        assert r.headers["content-disposition"] == 'inline; filename="item-1.svg"'
        assert r.content.startswith(b"<svg")

    def test_a_served_item_points_at_the_asset_route(self, catalog_dir: Path) -> None:
        """End to end: what a client is handed is a URL it can fetch."""
        app = create_app(CatalogSettings(data_dir=catalog_dir, auth=False))
        with TestClient(app) as client:
            r = client.get("/stac/search", params={"limit": 1})
        assert r.status_code == 200
        item = r.json()["features"][0]
        thumb = item["assets"].get("thumbnail")
        assert thumb is not None, "the fixture publishes a thumbnail on every item"
        assert thumb["href"].endswith(f"/assets/{item['id']}/thumbnail")
        assert "data" not in item["assets"]


def test_object_key_keeps_the_prefixes_apart() -> None:
    """One resolver, one allow-list per caller.

    The preview passes `data/` and the assets route passes its kind's prefix, so
    neither can read the other's objects even though both use this function.
    """
    assert object_key("../../../data/a.parquet", BUCKET, prefixes=("data/",)) == (
        "data/a.parquet"
    )
    with pytest.raises(ApiError):
        object_key("../../../data/a.parquet", BUCKET, prefixes=("thumbs/",))
    with pytest.raises(ApiError):
        object_key("../../../thumbs/a.svg", BUCKET, prefixes=("data/",))


class TestTiles:
    """`/assets/{id}/tiles/{z}/{x}/{y}`: one tile at a time from the item's
    published `.pmtiles`, never the file and never another object."""

    @staticmethod
    def _pmtiles(path: Path, tile: bytes = b"tile-0") -> None:
        from pmtiles.tile import Compression, TileType, zxy_to_tileid
        from pmtiles.writer import Writer

        with open(path, "wb") as f:
            writer = Writer(f)
            writer.write_tile(zxy_to_tileid(0, 0, 0), tile)
            writer.finalize(
                {
                    "tile_type": TileType.MVT,
                    "tile_compression": Compression.GZIP,
                    "min_zoom": 0,
                    "max_zoom": 0,
                    "min_lon_e7": -1800000000,
                    "min_lat_e7": -850000000,
                    "max_lon_e7": 1800000000,
                    "max_lat_e7": 850000000,
                    "center_zoom": 0,
                    "center_lon_e7": 0,
                    "center_lat_e7": 0,
                },
                {"vector_layers": []},
            )

    def _reader(self, tmp_path: Path, objects: Path) -> tuple[Any, list[int]]:
        from catalog.services.tiles import TileReader

        self._pmtiles(objects / "data" / "item-1.pmtiles")
        reads: list[int] = []

        class _Local(TileReader):
            def read_range(
                self, key: str, offset: int, length: int
            ) -> tuple[bytes, str]:
                reads.append(offset)
                with open(objects / key, "rb") as f:
                    whole = f.read()
                etag = hashlib.md5(whole).hexdigest()  # noqa: S324 - as S3's
                return whole[offset : offset + length], f'"{etag}"'

        return _Local(_settings(tmp_path)), reads

    def test_a_tile_is_served_and_the_header_read_once(
        self, tmp_path: Path, objects: Path
    ) -> None:
        reader, reads = self._reader(tmp_path, objects)
        row = {
            "id": "item-1",
            "assets": {"tiles": {"href": "../../../data/item-1.pmtiles"}},
        }
        assert reader.tile(row, 0, 0, 0) == (b"tile-0", "gzip")
        assert reader.tile(row, 3, 1, 1) is None  # no such tile
        assert reader.tile(row, 2, 9, 9) is None  # cannot exist
        assert reader.tile(row, 0, 0, 0) == (b"tile-0", "gzip")
        assert reads.count(0) == 1, "the header and root directory are cached"

    def test_a_file_replaced_under_the_same_name_is_read_anew(
        self, tmp_path: Path, objects: Path
    ) -> None:
        """goat-data rewrites a layer's tiles under the same name: the cached
        head must not point into the new file."""
        reader, reads = self._reader(tmp_path, objects)
        path = objects / "data" / "item-1.pmtiles"
        row = {"assets": {"tiles": {"href": "../../../data/item-1.pmtiles"}}}
        # Past the cached head, so the tile itself is a range read.
        self._pmtiles(path, b"a" * 20_000)
        before = reader.version(row)
        assert reader.tile(row, 0, 0, 0) == (b"a" * 20_000, "gzip")
        self._pmtiles(path, b"b" * 20_000)
        assert reader.tile(row, 0, 0, 0) == (b"b" * 20_000, "gzip")
        assert reader.version(row) != before
        assert reads.count(0) == 2

    def test_the_served_item_points_at_the_tile_route(self) -> None:
        served = _public_assets(
            {"tiles": {"href": "../../../data/item-1.pmtiles", "roles": ["tiles"]}},
            item_id="item-1",
            assets_base="https://cat.example/assets",
        )
        assert served["tiles"]["href"] == "https://cat.example/assets/item-1/tiles"
        # A raster's GeoTIFF stays private; its drawn tiles are announced instead.
        raster = _public_assets(
            {"data": {"href": "../../../data/r-1.tif", "roles": ["data"]}},
            item_id="r-1",
            assets_base="https://cat.example/assets",
        )
        assert raster == {
            "raster": {
                "href": "https://cat.example/assets/r-1/raster",
                "type": "image/webp",
                "roles": ["tiles"],
            }
        }

    @pytest.mark.parametrize(
        "assets",
        [
            {},
            {"tiles": {"href": "../../../thumbs/item-1.pmtiles"}},
            {"tiles": {"href": "../../../data/item-1.parquet"}},
            {"tiles": {"href": "https://elsewhere.example/data/item-1.pmtiles"}},
        ],
    )
    def test_nothing_but_the_items_own_tiles_is_reachable(
        self, tmp_path: Path, objects: Path, assets: dict[str, Any]
    ) -> None:
        reader, _ = self._reader(tmp_path, objects)
        with pytest.raises(ApiError) as err:
            reader.tile({"id": "item-1", "assets": assets}, 0, 0, 0)
        assert err.value.status_code == 404


class TestRasterTiles:
    """`/assets/{id}/raster/...`: the item's own GeoTIFF drawn tile by tile with
    goatlib's raster code, read through a signed address that stays server side."""

    RAMP = {
        "v": 1,
        "noData": [],
        "kind": "ramp",
        "band": 1,
        "colors": ["#000000", "#ffffff"],
        "domain": [0, 4],
    }

    def _reader(self, tmp_path: Path, tags: dict[str, str] | None = None) -> Any:
        import numpy as np
        import rasterio
        from goatlib.raster.source import RasterSource
        from rasterio.transform import from_bounds

        from catalog.services.tiles import RasterTileReader, TileReader

        tif = tmp_path / "classes.tif"
        with rasterio.open(
            tif,
            "w",
            driver="GTiff",
            width=64,
            height=64,
            count=1,
            dtype="uint8",
            crs="EPSG:4326",
            transform=from_bounds(10, 47, 11, 48, 64, 64),
        ) as dst:
            dst.write((np.arange(64 * 64).reshape(64, 64) % 4 + 1).astype("uint8"), 1)
            if tags:
                dst.update_tags(1, **tags)

        class _Local(RasterTileReader):
            def _source(self, generation: str, key: str) -> RasterSource:
                return RasterSource(None, stored_file=tif)

            def _version(self, generation: str, key: str) -> str:
                return "file-1"

        settings = _settings(tmp_path)
        return _Local(settings, TileReader(settings))

    def test_a_tile_inside_is_drawn_and_one_outside_is_empty(
        self, tmp_path: Path
    ) -> None:
        from goatlib.raster.token import encode_token

        reader = self._reader(tmp_path)
        row = {"id": "r-1", "parquet_url": "../../../data/r-1.tif"}
        token = encode_token(self.RAMP)
        drawn = reader.tile("g", row, 8, 135, 90, token)  # covers 10.5 E, 47.5 N
        assert drawn is not None and drawn[:4] == b"RIFF" and drawn[8:12] == b"WEBP"
        assert reader.tile("g", row, 8, 10, 10, token) is None

    def test_only_the_items_own_geotiff_and_a_valid_coloring(
        self, tmp_path: Path
    ) -> None:
        from goatlib.raster.token import encode_token

        reader = self._reader(tmp_path)
        with pytest.raises(ApiError) as no_raster:
            reader.tile(
                "g",
                {"parquet_url": "../../../data/x.parquet"},
                8,
                135,
                90,
                encode_token(self.RAMP),
            )
        assert no_raster.value.status_code == 404
        with pytest.raises(ApiError) as bad_token:
            reader.tile(
                "g", {"parquet_url": "../../../data/r-1.tif"}, 8, 135, 90, "not-a-token"
            )
        assert bad_token.value.status_code == 400

    def test_values_are_tiled_for_the_browser_to_color(self, tmp_path: Path) -> None:
        """GOAT Style colors a raster in the browser from value tiles; the
        description says how their codes become values, like geoapi's."""
        from goatlib.raster.formula import parse_formula

        reader = self._reader(tmp_path)
        row = {"id": "r-1", "parquet_url": "../../../data/r-1.tif"}
        band = parse_formula("b1")
        encoding, maxzoom, version = reader.value_tileset("g", row, band)
        assert encoding.integer and encoding.range == (1.0, 4.0)
        assert maxzoom is not None and version == "file-1"
        tile = reader.value_tile("g", row, 8, 135, 90, band, encoding, "nearest")
        assert tile is not None and tile[8:12] == b"WEBP"
        assert reader.value_tile("g", row, 8, 10, 10, band, encoding, "nearest") is None
        with pytest.raises(ApiError) as missing_band:
            reader.value_tileset("g", row, parse_formula("b2"))
        assert missing_band.value.status_code == 400

    def test_a_raster_its_reader_cannot_parse_is_not_available(
        self, tmp_path: Path
    ) -> None:
        """Statistics written with a decimal comma break every read: 404, not 500."""
        from goatlib.raster.formula import parse_formula
        from goatlib.raster.token import encode_token
        from goatlib.raster.values import value_encoding

        reader = self._reader(
            tmp_path, {"STATISTICS_MINIMUM": "1,5", "STATISTICS_MAXIMUM": "4,5"}
        )
        row = {"id": "r-1", "parquet_url": "../../../data/r-1.tif"}
        band = parse_formula("b1")
        with pytest.raises(ApiError) as drawn:
            reader.tile("g", row, 8, 135, 90, encode_token(self.RAMP))
        encoding = value_encoding("uint8", scaled=False, value_range=None)
        with pytest.raises(ApiError) as values:
            reader.value_tile("g", row, 8, 135, 90, band, encoding, "nearest")
        assert drawn.value.status_code == values.value.status_code == 404

    def test_the_signed_address_names_the_bucket_object(self, tmp_path: Path) -> None:
        from catalog.services.tiles import TileReader

        url = TileReader(_settings(tmp_path)).presign("data/r-1.tif", expires=600)
        assert url.startswith(f"https://example.invalid/{BUCKET}/data/r-1.tif?")
        assert "X-Amz-Expires=600" in url and "X-Amz-Signature=" in url
