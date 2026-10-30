"""The Explorer snapshot endpoint: build once per revision, then serve files.

The build itself (DuckLake → Parquet) is goatlib's and tested there; here it
is replaced by a stand-in, so what is tested is the endpoint's own protocol:
202 while building, one build however often it is asked, 200 with the files,
files cached for a month and served uncompressed, failures remembered, old revisions
pruned.
"""

import asyncio
import json
import os
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from goatlib.bundles.explorer.snapshot import SCHEMA_VERSION as S

BUNDLE = "22222222-2222-2222-2222-222222222222"
STOPS = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
MANIFEST_URL = f"/bundles/{BUNDLE}/explorer"


@pytest.fixture
def explorer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from geoapi.routers import explorer

    monkeypatch.setattr(explorer, "EXPLORER_DIR", tmp_path)
    explorer._builds.clear()
    explorer._failures.clear()
    yield explorer
    explorer._builds.clear()
    explorer._failures.clear()


@pytest.fixture
def builds(explorer):
    """A stand-in build: writes a snapshot of two small files after a moment."""
    calls: list[int] = []

    async def fake_build(bundle_id: str, revision: int, members: dict) -> None:
        calls.append(revision)
        await asyncio.sleep(0.2)
        target = explorer._snapshot_dir(bundle_id, revision)
        target.mkdir(parents=True)
        payload = b"PAR1" + b"x" * 5000 + b"PAR1"
        (target / "stop_times.parquet").write_bytes(payload)
        manifest = {
            "schema_version": 1,
            "files": [{"name": "stop_times", "rows": 1, "bytes": len(payload)}],
            "warnings": {},
            "layers_revision": revision,
        }
        (target / "manifest.json").write_text(json.dumps(manifest))

    with patch.object(explorer, "_build", side_effect=fake_build):
        yield calls


@pytest.fixture
def client(mock_ducklake_manager, explorer):
    """A client whose event loop outlives each request, as a server's does —
    a build started by one request is still running at the next. Startup's
    connections (Postgres, DuckLake, Redis) are not made."""
    from geoapi import main

    with (
        patch.object(main.layer_service, "init", AsyncMock()),
        patch.object(main.layer_service, "close", AsyncMock()),
        patch.object(main.ducklake_pool, "init"),
        patch.object(main.ducklake_pool, "close"),
        patch.object(main.ducklake_manager, "init"),
        patch.object(main.ducklake_manager, "close"),
        patch.object(main, "start_subscriber"),
        patch.object(main, "stop_subscriber"),
        patch.object(
            explorer,
            "_bundle",
            AsyncMock(return_value={"revision": 3, "members": {"stops": STOPS}}),
        ),
        patch.object(explorer, "enforce_layer_read", AsyncMock(return_value=None)),
        TestClient(main.app) as test_client,
    ):
        yield test_client


def _until_ready(client: TestClient, attempts: int = 50) -> dict:
    for _ in range(attempts):
        response = client.get(MANIFEST_URL)
        if response.status_code != 202:
            return {"status": response.status_code, "body": response.json()}
        time.sleep(0.05)
    raise AssertionError("never ready")


def test_first_request_builds_and_later_ones_get_the_files(client, builds) -> None:
    first = client.get(MANIFEST_URL)
    assert first.status_code == 202
    assert first.json() == {"status": "building", "layers_revision": 3}
    assert first.headers["retry-after"] == "2"
    assert client.get(MANIFEST_URL).status_code == 202  # still building

    ready = _until_ready(client)
    assert ready["status"] == 200
    assert builds == [3]  # one build, however often it was asked
    body = ready["body"]
    assert body["status"] == "ready"
    assert body["files"][0]["url"] == (
        f"/bundles/{BUNDLE}/explorer/r3/s{S}/stop_times.parquet"
    )


def test_files_are_cached_for_good_and_never_gzipped(client, builds) -> None:
    _until_ready(client)
    response = client.get(
        f"/bundles/{BUNDLE}/explorer/r3/s{S}/stop_times.parquet",
        headers={"Accept-Encoding": "gzip"},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, max-age=2592000, immutable"
    assert "content-encoding" not in response.headers
    assert response.headers["content-length"] == str(len(response.content))
    assert response.content.startswith(b"PAR1")


@pytest.mark.parametrize(
    "path",
    [
        f"r3/s{S}/manifest.parquet",  # not a snapshot file
        "r3/s9/stop_times.parquet",  # another schema version
        f"r2/s{S}/stop_times.parquet",  # a revision that is not there
    ],
)
def test_anything_else_is_not_found(client, builds, path: str) -> None:
    _until_ready(client)
    assert client.get(f"/bundles/{BUNDLE}/explorer/{path}").status_code == 404


def test_a_failed_build_is_reported_not_retried_at_once(client, explorer) -> None:
    async def failing(bundle_id: str, revision: int, members: dict) -> None:
        explorer._failures[(bundle_id, revision)] = (time.time(), "boom")

    with patch.object(explorer, "_build", side_effect=failing) as build:
        assert client.get(MANIFEST_URL).status_code == 202
        time.sleep(0.1)
        response = client.get(MANIFEST_URL)
        assert response.status_code == 500
        assert response.json()["detail"] == "boom"
        client.get(MANIFEST_URL)
        assert build.call_count == 1


def test_try_again_forgets_a_failed_build(client, explorer) -> None:
    async def failing(bundle_id: str, revision: int, members: dict) -> None:
        explorer._failures[(bundle_id, revision)] = (time.time(), "boom")

    with patch.object(explorer, "_build", side_effect=failing) as build:
        client.get(MANIFEST_URL)
        time.sleep(0.1)
        assert client.get(MANIFEST_URL).status_code == 500
        assert client.get(f"{MANIFEST_URL}?retry=true").status_code == 202
        time.sleep(0.1)
        assert build.call_count == 2


def test_a_reader_the_layer_rule_refuses_gets_nothing(client, explorer) -> None:
    with patch.object(
        explorer,
        "enforce_layer_read",
        AsyncMock(side_effect=HTTPException(status_code=403, detail="no")),
    ):
        assert client.get(MANIFEST_URL).status_code == 403
        url = f"/bundles/{BUNDLE}/explorer/r3/s{S}/stop_times.parquet"
        assert client.get(url).status_code == 403


def test_superseded_revisions_are_pruned_the_previous_after_an_hour(
    explorer, tmp_path: Path
) -> None:
    for rev in (1, 2, 3, 4):
        (tmp_path / BUNDLE / f"r{rev}.s{S}").mkdir(parents=True)
    old = time.time() - 2 * 3600
    os.utime(tmp_path / BUNDLE / f"r2.s{S}", (old, old))

    explorer._prune(BUNDLE, 4)
    # r3, the one before, stays while downloads of it may be in flight; r2
    # was superseded long ago and r1 is two behind.
    assert sorted(p.name for p in (tmp_path / BUNDLE).iterdir()) == [
        f"r3.s{S}",
        f"r4.s{S}",
    ]

    (tmp_path / BUNDLE / f"r5.s{S}").mkdir()
    explorer._prune(BUNDLE, 5)
    assert sorted(p.name for p in (tmp_path / BUNDLE).iterdir()) == [
        f"r4.s{S}",
        f"r5.s{S}",
    ]


def test_cleanup_removes_what_no_build_will_finish(explorer, tmp_path: Path) -> None:
    bundle = tmp_path / BUNDLE
    (bundle / ".tmp-r3-abc").mkdir(parents=True)
    (bundle / ".building-r3").write_text("pod")
    (bundle / f"r3.s{S}").mkdir()
    old = time.time() - 2 * 3600
    for name in (".tmp-r3-abc", ".building-r3"):
        os.utime(bundle / name, (old, old))

    assert explorer.cleanup_explorer_dir() == 2
    assert [p.name for p in bundle.iterdir()] == [f"r3.s{S}"]


def test_bundle_lookup_rejects_what_is_not_a_public_transport_bundle() -> None:
    from geoapi.routers import explorer

    pool = AsyncMock()
    pool.fetchrow = AsyncMock(
        return_value={
            "bundle_type": "street_network",
            "layers_revision": 0,
            "members": {},
        }
    )
    with patch.object(explorer.layer_service, "_pool", pool):
        with pytest.raises(HTTPException) as refused:
            asyncio.run(explorer._bundle(UUID(BUNDLE)))
    assert refused.value.status_code == 404


def test_an_older_schemas_snapshot_goes_once_superseded(
    explorer, tmp_path: Path
) -> None:
    (tmp_path / BUNDLE / f"r3.s{S - 1}").mkdir(parents=True)
    (tmp_path / BUNDLE / f"r3.s{S}").mkdir()
    old = time.time() - 2 * 3600
    os.utime(tmp_path / BUNDLE / f"r3.s{S - 1}", (old, old))
    explorer._prune(BUNDLE, 3)
    assert [p.name for p in (tmp_path / BUNDLE).iterdir()] == [f"r3.s{S}"]
