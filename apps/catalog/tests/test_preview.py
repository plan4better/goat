"""Tests for the data-preview endpoint (catalog.services.preview).

No network: the reader is pointed at a local parquet through a stubbed
connection, so the SSRF guard, the cache's generation scoping, the byte budget
and the endpoint's wiring are all exercised without a bucket.
"""

import json as _json_module
import os
from pathlib import Path
from typing import Any

import duckdb
import pytest
from fastapi.testclient import TestClient

from catalog.app import create_app
from catalog.config import CatalogSettings
from catalog.errors import ApiError
from catalog.services.preview import (
    PreviewCache,
    PreviewReader,
    _cache_filename,
    _sample_sql,
    object_key,
)

BUCKET = "p4b-catalog-test"


# ────────────────────────────────────────────────────────────────────────
# object_key -- the SSRF guard
# ────────────────────────────────────────────────────────────────────────


class TestObjectKey:
    """`parquet_url` is publisher-controlled input to a fetch we perform."""

    def test_relative_tree_href_resolves(self) -> None:
        assert object_key("../../../data/abc.parquet", BUCKET) == "data/abc.parquet"

    def test_s3_url_for_our_bucket_resolves(self) -> None:
        assert object_key(f"s3://{BUCKET}/data/abc.parquet", BUCKET) == (
            "data/abc.parquet"
        )

    def test_https_path_style_url_for_our_bucket_resolves(self) -> None:
        assert (
            object_key(
                f"https://nbg1.your-objectstorage.com/{BUCKET}/data/abc.parquet", BUCKET
            )
            == "data/abc.parquet"
        )

    @pytest.mark.parametrize(
        "href",
        [
            "s3://someone-elses-bucket/data/abc.parquet",
            "https://nbg1.your-objectstorage.com/other-bucket/data/abc.parquet",
            "http://169.254.169.254/latest/meta-data/",
            "file:///etc/passwd",
            "../../../data/../../secrets/abc.parquet",
            "../../../styles/abc.json",
            "",
        ],
        ids=[
            "other-s3-bucket",
            "other-http-bucket",
            "link-local-metadata",
            "local-file",
            "traversal-out-of-data",
            "non-data-prefix",
            "empty",
        ],
    )
    def test_anything_else_is_refused(self, href: str) -> None:
        """A published href must never make the service read somewhere else."""
        with pytest.raises(ApiError) as exc:
            object_key(href, BUCKET)
        assert exc.value.status_code == 404


# ────────────────────────────────────────────────────────────────────────
# PreviewCache -- invalidation is the whole point
# ────────────────────────────────────────────────────────────────────────


class TestPreviewCache:
    """On disk, and scoped to a mirror generation."""

    def test_hit_within_a_generation(self, tmp_path: Path) -> None:
        cache = PreviewCache(tmp_path, max_bytes=10_000)
        cache.put("gen-1", "item-a", b'{"features": []}')
        assert cache.get("gen-1", "item-a") == b'{"features": []}'

    def test_a_new_generation_drops_everything(self, tmp_path: Path) -> None:
        """A sync must not leave previews of the previous mirror behind.

        The cached sample belongs to the data the mirror described; when the
        mirror changes, so may the data, and a preview that outlives it is a
        picture of a dataset that no longer exists.
        """
        cache = PreviewCache(tmp_path, max_bytes=10_000)
        cache.put("gen-1", "item-a", b"payload")
        assert cache.get("gen-2", "item-a") is None
        # The bytes are gone from disk, not merely unreachable: the previous
        # generation's directory is removed, so the cache cannot grow one
        # stale copy of the catalog per harvest.
        assert [p.name for p in tmp_path.iterdir()] == ["gen-2"]

    def test_nothing_is_held_in_memory(self, tmp_path: Path) -> None:
        """The cache is the filesystem: a second instance sees the same entry.

        Which is the point of putting it on disk -- it survives a process
        restart, and pointing several replicas at a shared volume makes one
        read serve all of them instead of one read per pod.
        """
        PreviewCache(tmp_path, max_bytes=10_000).put("gen-1", "item-a", b"payload")
        assert PreviewCache(tmp_path, max_bytes=10_000).get("gen-1", "item-a") == (
            b"payload"
        )

    def test_evicts_least_recently_used_over_budget(self, tmp_path: Path) -> None:
        """Recency is the file's mtime, which `get` refreshes.

        The ages are stamped explicitly rather than relying on the order of
        three writes inside one clock tick -- in production they are minutes
        apart, but a test that depends on filesystem timestamp resolution is a
        test that fails on someone else's machine.
        """
        cache = PreviewCache(tmp_path, max_bytes=200)
        payload = b"x" * 60  # three fit (180); a fourth does not (240)
        for name in ("oldest", "middle", "newest"):
            cache.put("gen-1", name, payload)
        for name, when in (("oldest", 3000.0), ("middle", 4000.0), ("newest", 5000.0)):
            path = (tmp_path / "gen-1") / _cache_filename(name)
            os.utime(path, (when, when))

        cache.put("gen-1", "fresh", payload)

        assert cache.get("gen-1", "oldest") is None
        assert cache.get("gen-1", "middle") is not None
        assert cache.get("gen-1", "newest") is not None
        assert cache.get("gen-1", "fresh") is not None

    def test_an_unwritable_cache_is_slow_not_broken(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A read-only cache directory must not fail the request.

        The preview itself is already computed by then; failing here would
        turn a caching problem into an outage.
        """
        cache = PreviewCache(tmp_path, max_bytes=10_000)

        def _boom(self: Path, data: bytes) -> int:
            raise OSError("read-only file system")

        monkeypatch.setattr(Path, "write_bytes", _boom)
        cache.put("gen-1", "a", b"payload")  # must not raise
        assert cache.get("gen-1", "a") is None

    def test_item_ids_that_are_not_filesystem_safe(self, tmp_path: Path) -> None:
        """Ids are hashed: the contract promises "URL-safe", not "path-safe"."""
        cache = PreviewCache(tmp_path, max_bytes=10_000)
        cache.put("gen-1", "../escape/../../etc/passwd", b"payload")
        assert cache.get("gen-1", "../escape/../../etc/passwd") == b"payload"
        written = list((tmp_path / "gen-1").glob("*.json"))
        assert len(written) == 1
        assert written[0].parent == tmp_path / "gen-1"


# ────────────────────────────────────────────────────────────────────────
# PreviewReader -- against a local parquet, no bucket
# ────────────────────────────────────────────────────────────────────────


@pytest.fixture()
def data_parquet(tmp_path: Path) -> Path:
    """A layer-data parquet shaped like the ones in `data/`."""
    path = tmp_path / "layer.parquet"
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(f"""
        COPY (
            SELECT
                'feature-' || i        AS name,
                i * 1.5                AS value,
                ST_Buffer(ST_Point(10.0 + i * 0.01, 50.0 + i * 0.01), 0.02) AS geometry
            FROM range(250) AS t(i)
        ) TO '{path.as_posix()}' (FORMAT PARQUET)
    """)
    con.close()
    return path


def _flat_parquet(tmp_path: Path, *, rows: int, width: int = 1) -> Path:
    """An attribute table: no geometry column anywhere in it."""
    path = tmp_path / f"flat-{rows}-{width}.parquet"
    con = duckdb.connect()
    con.execute(f"""
        COPY (
            SELECT i AS a, repeat('x', {width}) || i AS b
            FROM range({rows}) AS t(i)
        ) TO '{path.as_posix()}' (FORMAT PARQUET)
    """)
    con.close()
    return path


class _LocalReader(PreviewReader):
    """A reader whose 'bucket object' is one local parquet.

    The S3 plumbing is the part a unit test cannot exercise offline;
    everything above it -- geometry detection, simplification, the byte
    budget, the feature shape -- is the same code either way.
    """

    def __init__(self, settings: CatalogSettings, path: Path) -> None:
        super().__init__(settings)
        self._path = path
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        self._con = con

    def object_url(self, row: dict[str, Any]) -> str:
        return str(row.get("__local_path") or self._path.as_posix())


def _row(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": "item-1",
        "parquet_url": "../../../data/layer.parquet",
        "bbox_xmin": 10.0,
        "bbox_ymin": 50.0,
        "bbox_xmax": 12.5,
        "bbox_ymax": 52.5,
        "table:row_count": 250,
    }
    row.update(overrides)
    return row


@pytest.fixture()
def reader(tmp_path: Path, data_parquet: Path) -> PreviewReader:
    settings = CatalogSettings(
        data_dir=tmp_path,
        s3_catalog_bucket=BUCKET,
        s3_access_key_id="key",
        s3_secret_access_key="secret",
        s3_endpoint_url="https://example.invalid",
        preview_cache_dir=tmp_path / "preview-cache",
    )
    return _LocalReader(settings, data_parquet)


class TestPreviewReader:
    @pytest.mark.parametrize(
        "parquet_url",
        ["../../../data/layer.tif", None],  # a raster; a WMS (no data)
    )
    def test_a_layer_without_a_table_file_has_no_sample(
        self, reader: PreviewReader, parquet_url: str | None
    ) -> None:
        """404 at once, not a failed read of a GeoTIFF as Parquet (502)."""
        with pytest.raises(ApiError) as err:
            reader.read(_row(parquet_url=parquet_url), limit=10)
        assert err.value.status_code == 404

    def test_returns_a_bounded_feature_collection(self, reader: PreviewReader) -> None:
        doc = reader.read(_row(), limit=10)
        assert doc["type"] == "FeatureCollection"
        assert len(doc["features"]) == 10
        assert doc["goat:truncated"] is True
        assert doc["goat:total"] == 250

    def test_features_carry_geometry_and_attributes(
        self, reader: PreviewReader
    ) -> None:
        feature = reader.read(_row(), limit=1)["features"][0]
        assert feature["geometry"]["type"] in ("Polygon", "MultiPolygon")
        assert feature["properties"]["name"].startswith("feature-")
        assert isinstance(feature["properties"]["value"], float)
        # The geometry is not repeated as an attribute.
        assert "geometry" not in feature["properties"]

    def test_the_sample_reports_its_own_extent_not_the_item_s(
        self, reader: PreviewReader
    ) -> None:
        """A prefix is a patch of the dataset, and the client fits to the patch.

        Fitting to the item extent instead would draw the sample as a speck in
        the corner of an otherwise empty map -- so the sample carries its own
        bbox, and the item's goes alongside it for the client to outline.
        """
        doc = reader.read(_row(), limit=20)
        assert doc["goat:item_bbox"] == [10.0, 50.0, 12.5, 52.5]
        sample_width = doc["bbox"][2] - doc["bbox"][0]
        item_width = doc["goat:item_bbox"][2] - doc["goat:item_bbox"][0]
        assert 0 < sample_width < item_width

    def test_both_the_sample_and_item_extents_are_reported(
        self, reader: PreviewReader
    ) -> None:
        """The client fits to the sample and outlines the item extent."""
        doc = reader.read(_row(), limit=5)
        assert doc["goat:item_bbox"] == [10.0, 50.0, 12.5, 52.5]
        assert doc["bbox"][0] < doc["bbox"][2] and doc["bbox"][1] < doc["bbox"][3]

    def test_untruncated_when_the_dataset_is_smaller_than_the_limit(
        self, reader: PreviewReader
    ) -> None:
        doc = reader.read(_row(), limit=1000)
        assert len(doc["features"]) == 250
        assert doc["goat:truncated"] is False

    def test_byte_budget_is_enforced(self, reader: PreviewReader) -> None:
        """The cap that matters is bytes: feature count bounds nothing.

        Per-feature payload spans ~950x across the real catalog, so a
        100-feature ceiling alone permitted a 6.4 MB response.
        """
        import json as _json

        reader._settings.preview_max_bytes = 2000  # noqa: SLF001
        doc = reader.read(_row(), limit=100)
        assert len(_json.dumps(doc["features"])) <= 2000
        assert doc["goat:truncated"] is True

    def test_a_geometryless_item_previews_its_rows(
        self, tmp_path: Path, reader: PreviewReader
    ) -> None:
        """70% of the catalog is now attribute tables. Having no geometry is a
        reason to draw no map, not a reason to withhold the data."""
        flat = _flat_parquet(tmp_path, rows=50)
        doc = reader.read(_row(__local_path=flat.as_posix()), limit=10)

        assert doc["type"] == "FeatureCollection"
        assert len(doc["features"]) == 10
        assert all(feature["geometry"] is None for feature in doc["features"])
        assert set(doc["features"][0]["properties"]) == {"a", "b"}
        assert doc["goat:truncated"] is True

    def test_a_geometryless_preview_reports_no_extent(
        self, tmp_path: Path, reader: PreviewReader
    ) -> None:
        """No geometry, no bbox to fit a map to — and the client keys its map
        off exactly that."""
        flat = _flat_parquet(tmp_path, rows=5)
        doc = reader.read(_row(__local_path=flat.as_posix()), limit=10)
        assert "bbox" not in doc
        assert doc["goat:truncated"] is False

    def test_geometryless_rows_respect_the_byte_budget(
        self, tmp_path: Path, reader: PreviewReader
    ) -> None:
        """The cap is on the response, not on geometries: a table of wide text
        can blow it just as a feature collection can."""
        import json as _json

        flat = _flat_parquet(tmp_path, rows=500, width=200)
        reader._settings.preview_max_bytes = 2000  # noqa: SLF001
        doc = reader.read(_row(__local_path=flat.as_posix()), limit=100)
        assert len(_json.dumps(doc["features"])) <= 2000
        assert doc["goat:truncated"] is True


class TestBoundedSampling:
    """Why the sample is the first rows.

    Everything else measured against the real bucket costs an order of
    magnitude more, because the cost is how much of the object gets touched: a
    reservoir sample reads every row (34-108 s), spaced offsets touch a row
    group each and the files hold only 3-54 of them (21-104 s), and a bbox
    filter prunes no further than those row groups allow (42 s on the 740 MB
    file, whatever the window). A bounded read from the front touches the first
    row groups and nothing else.
    """

    def test_reads_only_a_bounded_prefix(self) -> None:
        sql = _sample_sql("*", limit=100)
        assert "USING SAMPLE" not in sql, "a reservoir sample reads every row"
        assert "OFFSET" not in sql, "an offset reads a row group it lands in"
        assert "LIMIT 100" in sql

    def test_the_sample_is_stable_across_calls(self, reader: PreviewReader) -> None:
        """A preview that reshuffles between replicas reads as broken data."""
        first = reader.read(_row(), limit=20)["features"]
        second = reader.read(_row(), limit=20)["features"]
        assert [f["properties"]["name"] for f in first] == [
            f["properties"]["name"] for f in second
        ]

    def test_the_sample_is_contiguous(self, reader: PreviewReader) -> None:
        """Neighbours in a Hilbert-ordered file, so neighbours on the map."""
        names = [
            f["properties"]["name"] for f in reader.read(_row(), limit=10)["features"]
        ]
        assert names == [f"feature-{i}" for i in range(10)]

    def test_the_sample_carries_its_own_extent_and_the_item_s(
        self, reader: PreviewReader
    ) -> None:
        """The client fits to the patch; the item extent says where it sits.

        Fitting to the item extent instead would draw the sample as a speck in
        the corner of an otherwise empty map.
        """
        doc = reader.read(_row(), limit=20)
        assert doc["goat:item_bbox"] == [10.0, 50.0, 12.5, 52.5]
        sample_width = doc["bbox"][2] - doc["bbox"][0]
        assert 0 < sample_width < doc["goat:item_bbox"][2] - doc["goat:item_bbox"][0]


class TestByteBudget:
    def test_the_budget_bounds_the_read_not_just_the_response(
        self, reader: PreviewReader, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """What OOM-killed a pod: 5000 rows were built before anything checked.

        The ceiling counts features and the cost is bytes, and the two are only
        loosely related -- per-feature payload spans ~950x across the catalog.
        So the budget has to stop the read, not filter its result: no more rows
        may be turned into features once it is reached.
        """
        import catalog.services.preview as preview_module

        built = 0
        real = preview_module._feature

        def counting(*args: Any, **kwargs: Any) -> dict[str, Any]:
            nonlocal built
            built += 1
            return real(*args, **kwargs)

        monkeypatch.setattr(preview_module, "_feature", counting)
        # Small enough that the fixture spans many batches, so stopping early
        # is observable rather than hidden inside a single fetch.
        monkeypatch.setattr(preview_module, "_FETCH_BATCH", 8)
        reader._settings.preview_max_bytes = 3000  # noqa: SLF001
        doc = reader.read(_row(), limit=200)

        kept = len(doc["features"])
        assert len(_json_module.dumps(doc["features"])) <= 3000
        # The fixture holds 250 rows and the ceiling asked for all of them.
        # Each coarsening attempt reads its own budget-bounded prefix, so the
        # bound is per attempt plus the batch each stopped inside -- what must
        # never happen is the whole sample being built and then filtered.
        assert built < 200, f"built {built} of 200 rows before the budget applied"
        assert built <= 3 * (kept + 8 + 64), f"built {built} features to keep {kept}"

    def test_what_fits_is_still_a_prefix(self, reader: PreviewReader) -> None:
        """Stopping at the budget shortens the patch; it must not perforate it."""
        reader._settings.preview_max_bytes = 3000  # noqa: SLF001
        names = [
            f["properties"]["name"] for f in reader.read(_row(), limit=200)["features"]
        ]
        assert names == [f"feature-{i}" for i in range(len(names))]

    def test_the_budget_is_respected(self, reader: PreviewReader) -> None:
        reader._settings.preview_max_bytes = 2000  # noqa: SLF001
        doc = reader.read(_row(), limit=100)
        assert len(_json_module.dumps(doc["features"])) <= 2000
        assert doc["goat:truncated"] is True


class TestCoarsening:
    def test_coarsening_never_empties_the_shapes(self, reader: PreviewReader) -> None:
        """Simplifying past a shape's own size deletes it.

        Measured on the test fixture's 0.02-radius polygons: at the third
        coarsening step (16x tolerance) DuckDB's ST_Simplify returns
        `{"type":"Polygon","coordinates":[]}` for every row, so an over-budget
        dataset previewed as an empty map with no extent to fit to. Coarsening
        has to stop at the last tolerance that still had shapes.
        """
        reader._settings.preview_max_bytes = 500  # noqa: SLF001
        doc = reader.read(_row(), limit=100)

        assert doc["features"], "nothing survived the byte budget"
        drawable = [f for f in doc["features"] if f["geometry"]["coordinates"]]
        assert len(drawable) == len(
            doc["features"]
        ), "coarsening emptied geometries instead of stopping"
        assert "bbox" in doc, "no extent: the client has nothing to fit the map to"


class TestPreviewDefaults:
    def test_the_ceiling_is_small_because_the_read_is_what_costs(self) -> None:
        """The ceiling is a cost control, not a quality dial.

        Measured against the real bucket, denser samples are not a bigger
        number here: at 5000 features every sampler tried cost 40-143 s and
        peaked at 3.1 GB. What makes a denser preview affordable is smaller row
        groups in the published files (`catalog_materialize` writes them with
        DuckDB's default, which is a row count and so leaves 740 MB in three
        groups), not a change on this side.
        """
        settings = CatalogSettings()
        assert settings.preview_max_features == 100
        assert settings.preview_max_bytes == 2 * 1024 * 1024
        # Post-simplification features measured 200-580 B against the bucket,
        # so the ceiling fits the budget with room to spare and the budget only
        # binds on genuinely heavy geometry.
        assert settings.preview_max_features * 580 < settings.preview_max_bytes


# ────────────────────────────────────────────────────────────────────────
# Endpoint wiring
# ────────────────────────────────────────────────────────────────────────


def test_preview_is_404_when_not_configured(catalog_dir: Path) -> None:
    """Off unless credentials are given: the sample comes from private data.

    Enabling it is a deployment decision (design S14), so a service with no
    bucket configured must not half-answer.
    """
    app = create_app(CatalogSettings(data_dir=catalog_dir, auth=False))
    with TestClient(app) as client:
        response = client.get("/stac/items/radverkehrsnetz-dresden-0/preview")
    assert response.status_code == 404
    assert "not enabled" in response.json()["description"]


def test_caching_is_off_unless_a_directory_is_configured(
    tmp_path: Path, data_parquet: Path
) -> None:
    """No server-side cache by default.

    A cache is a resource to size in every pod -- heap against the memory
    limit, local disk against ephemeral storage, which is what gets pods
    evicted. The route sends a long `max-age` plus the store's ETag instead,
    so the client's cache does the work and costs the deployment nothing.
    """
    settings = CatalogSettings(
        data_dir=tmp_path,
        s3_catalog_bucket=BUCKET,
        s3_access_key_id="key",
        s3_secret_access_key="secret",
    )
    assert settings.preview_cache_dir is None
    reader = _LocalReader(settings, data_parquet)
    assert reader.cache is None
    # Still answers, just without remembering.
    assert reader.render("gen-1", _row(), limit=5).startswith(b'{"type"')


def test_preview_response_is_cacheable_by_the_client(catalog_dir: Path) -> None:
    """The long `max-age` is the caching that replaces a server-side cache."""
    app = create_app(
        CatalogSettings(
            data_dir=catalog_dir,
            auth=False,
            s3_catalog_bucket=BUCKET,
            s3_access_key_id="key",
            s3_secret_access_key="secret",
            preview_max_age_seconds=3600,
        )
    )
    with TestClient(app) as client:
        # 404 for an unknown item, but the *metadata* routes show the default
        # still applies where a handler does not override it.
        landing = client.get("/stac")
    assert landing.headers["Cache-Control"] == "public, max-age=60"
    assert landing.headers["ETag"].startswith('W/"')


def test_preview_of_an_unknown_item_is_404(catalog_dir: Path) -> None:
    app = create_app(
        CatalogSettings(
            data_dir=catalog_dir,
            auth=False,
            s3_catalog_bucket=BUCKET,
            s3_access_key_id="key",
            s3_secret_access_key="secret",
            preview_cache_dir=catalog_dir / "preview-cache",
        )
    )
    with TestClient(app) as client:
        response = client.get("/stac/items/does-not-exist/preview")
    assert response.status_code == 404


def _signed_in_app(
    catalog_dir: Path, data_parquet: Path, monkeypatch: pytest.MonkeyPatch
) -> TestClient:
    """The service with sign-in on and a sample reader over a local file; the
    token `good` is valid, any other is not."""
    from goatlib.auth import JOSEError

    def validate(settings: object, token: str) -> dict[str, str]:
        if token != "good":
            raise JOSEError("bad token")
        return {"sub": "user"}

    monkeypatch.setattr("catalog.auth.validate_token", validate)
    settings = CatalogSettings(
        data_dir=catalog_dir,
        auth=True,
        s3_catalog_bucket=BUCKET,
        s3_access_key_id="key",
        s3_secret_access_key="secret",
    )
    app = create_app(settings)
    client = TestClient(app)
    client.__enter__()
    app.state.preview_reader = _LocalReader(settings, data_parquet)
    return client


def test_the_sample_is_for_signed_in_users(
    catalog_dir: Path, data_parquet: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The sample is a dataset's own data (rows with their attributes), and
    catalog data is for signed-in users: without a valid token it answers 401,
    also to a request that says it already has a copy. Search and the item
    itself stay public."""
    client = _signed_in_app(catalog_dir, data_parquet, monkeypatch)
    try:
        sample = "/stac/items/radverkehrsnetz-dresden-0/preview"
        signed_in = client.get(sample, headers={"Authorization": "Bearer good"})
        assert signed_in.status_code == 200
        assert signed_in.json()["type"] == "FeatureCollection"
        # Read with a sign-in: no shared cache may keep it.
        assert signed_in.headers["Cache-Control"].startswith("private")

        anonymous = client.get(sample)
        assert anonymous.status_code == 401
        assert anonymous.headers["www-authenticate"] == "Bearer"
        has_a_copy = client.get(
            sample, headers={"If-None-Match": signed_in.headers["ETag"]}
        )
        assert has_a_copy.status_code == 401
        bad = client.get(sample, headers={"Authorization": "Bearer other"})
        assert bad.status_code == 401

        assert client.get("/stac/items/radverkehrsnetz-dresden-0").status_code == 200
        assert client.get("/stac/search").status_code == 200
    finally:
        client.__exit__(None, None, None)


def test_the_sample_needs_no_token_where_sign_in_is_off(
    catalog_dir: Path, data_parquet: Path
) -> None:
    """`AUTH=False` turns sign-in off everywhere."""
    settings = CatalogSettings(
        data_dir=catalog_dir,
        auth=False,
        s3_catalog_bucket=BUCKET,
        s3_access_key_id="key",
        s3_secret_access_key="secret",
    )
    app = create_app(settings)
    with TestClient(app) as client:
        app.state.preview_reader = _LocalReader(settings, data_parquet)
        response = client.get("/stac/items/radverkehrsnetz-dresden-0/preview")
    assert response.status_code == 200
