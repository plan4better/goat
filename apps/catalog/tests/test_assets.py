"""Tests for `/assets/{item_id}/{kind}` (catalog.services.assets).

No network: the reader's one bucket-shaped seam (`object_url`) is pointed at
local files, so the prefix allow-list, the media-type rule, the size ceiling,
the href rewriting and the route's wiring are all exercised offline.

The security properties are the point of most of this file. The route takes an
item id and a kind — never an object key — so the questions worth asking are
"can a caller reach an object the harvester did not point at" and "can a body be
served under a type it is not".
"""

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
from catalog.services.stac_build import _public_assets, collection_from_row

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
        # A dataset serves its own thumbnail where it publishes one, else a layer's.
        base = "https://catalog.example.com/assets"
        borrowed = {"id": "plan", "thumbnail_item": "layer-1"}
        own = {**borrowed, "assets": {"thumbnail": _row()["assets"]["thumbnail"]}}
        assert collection_from_row(borrowed, assets_base=base)["assets"]["thumbnail"][
            "href"
        ] == (f"{base}/layer-1/thumbnail")
        assert collection_from_row(own, assets_base=base)["assets"]["thumbnail"][
            "href"
        ] == (f"{base}/plan/thumbnail")
        # A thumbnail struct without an href is no picture of its own.
        empty = {**borrowed, "assets": {"thumbnail": {"href": None}}}
        assert collection_from_row(empty, assets_base=base)["assets"]["thumbnail"][
            "href"
        ] == (f"{base}/layer-1/thumbnail")

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
        assert r.status_code == 404

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
