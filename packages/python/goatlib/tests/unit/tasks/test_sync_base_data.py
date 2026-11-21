"""Install and update semantics of the base data sync.

A fake zone (channels.json + versioned data sets with manifests) is served over
real HTTP with range support, or read as a plain folder, and synced into a
temporary data dir. What is under test is the contract the tools rely on: the
legacy paths (`street_network/`, `gtfs/`, ...) resolve to a verified version,
switching versions never exposes a partial one, and a bad publication never
replaces a good install.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
from collections.abc import Iterator
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.tasks.sync_base_data import (
    SyncBaseDataParams,
    h3_3_cells_for_bbox,
    mirror,
    sync,
)

# ─── fake zone ─────────────────────────────────────────────────────────────


def publish(
    zone: Path,
    dataset: str,
    version: str,
    files: dict[str, bytes],
    *,
    requires: dict[str, str] | None = None,
    data_schema: int = 1,
) -> None:
    """Write one data set version and its manifest, the way the publisher does."""
    root = zone / dataset / version
    entries = []
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        entry: dict[str, Any] = {
            "path": rel,
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
        for part in rel.split("/"):
            if part.startswith("h3_3="):
                entry["h3_3"] = int(part.split("=", 1)[1])
        entries.append(entry)
    manifest = {
        "dataset": dataset,
        "version": version,
        "data_schema": data_schema,
        "requires": requires or {},
        "total_bytes": sum(e["bytes"] for e in entries),
        "files": entries,
    }
    (root / "manifest.json").write_text(json.dumps(manifest))


def set_channel(
    zone: Path, stable: dict[str, str], schemas: dict[str, int] | None = None
) -> None:
    versions: dict[str, list[dict[str, Any]]] = {}
    for dataset_dir in sorted(p for p in zone.iterdir() if p.is_dir()):
        for version_dir in sorted(p for p in dataset_dir.iterdir() if p.is_dir()):
            schema = (schemas or {}).get(f"{dataset_dir.name}/{version_dir.name}", 1)
            versions.setdefault(dataset_dir.name, []).append(
                {"version": version_dir.name, "data_schema": schema}
            )
    (zone / "channels.json").write_text(
        json.dumps({"format": 1, "channels": {"stable": stable}, "versions": versions})
    )


STREET_V1 = {
    "edges/h3_3=8097/data_0.parquet": b"edges-8097-v1",
    "edges/h3_3=7954/data_0.parquet": b"edges-7954-v1",
    "nodes/h3_3=8097/data_0.parquet": b"nodes-8097-v1",
}
PT_V1 = {
    "gtfs/stops.parquet": b"stops-v1",
    "pt_network/gtfs.bin": b"timetable-v1" * 100,
}


@pytest.fixture
def zone(tmp_path: Path) -> Path:
    z = tmp_path / "zone"
    z.mkdir()
    return z


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    return d


class _Server:
    def __init__(self, root: Path) -> None:
        self.requests: list[tuple[str, str | None]] = []
        server = self

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                super().__init__(*args, directory=str(root), **kwargs)

            def log_message(self, *args: Any) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                server.requests.append((self.path, self.headers.get("Range")))
                rng = self.headers.get("Range")
                path = Path(self.translate_path(self.path))
                if not rng or not path.is_file():
                    return super().do_GET()
                start = int(rng.removeprefix("bytes=").split("-")[0])
                data = path.read_bytes()[start:]
                self.send_response(206)
                self.send_header("Content-Length", str(len(data)))
                self.send_header(
                    "Content-Range",
                    f"bytes {start}-{start + len(data) - 1}/{path.stat().st_size}",
                )
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def data_requests(self) -> list[tuple[str, str | None]]:
        """Requests for data files, i.e. not channels.json or a manifest."""
        return [
            r
            for r in self.requests
            if not r[0].endswith(("channels.json", "manifest.json"))
        ]


@pytest.fixture
def server(zone: Path) -> Iterator[_Server]:
    s = _Server(zone)
    yield s
    s.httpd.shutdown()


def run(url: str, data_dir: Path, **kwargs: Any) -> dict[str, Any]:
    kwargs.setdefault("datasets", ["street_network", "public_transport"])
    return sync(
        SyncBaseDataParams(sources=[{"url": url}], data_dir=str(data_dir), **kwargs)
    )


def installed(data_dir: Path, dataset: str) -> str:
    """The version a legacy path currently resolves to."""
    link = {"street_network": "street_network", "public_transport": "gtfs"}[dataset]
    return Path(os.readlink(data_dir / link)).parts[2]


# ─── install ───────────────────────────────────────────────────────────────


def test_fresh_install_links_the_legacy_paths_to_the_version(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    publish(
        zone,
        "public_transport",
        "2026-09-17",
        PT_V1,
        requires={"street_network": "2026-09-17"},
    )
    set_channel(
        zone, {"street_network": "2026-09-17", "public_transport": "2026-09-17"}
    )

    result = run(server.url, data_dir)

    assert result["street_network"]["status"] == "installed"
    assert result["public_transport"]["status"] == "installed"
    assert (
        data_dir / "street_network/edges/h3_3=8097/data_0.parquet"
    ).read_bytes() == b"edges-8097-v1"
    assert (data_dir / "gtfs/stops.parquet").read_bytes() == b"stops-v1"
    assert (data_dir / "pt_network/gtfs.bin").read_bytes() == b"timetable-v1" * 100
    for link in ("street_network", "gtfs", "pt_network"):
        assert (data_dir / link).is_symlink()


def test_links_are_relative_so_a_volume_mounted_elsewhere_still_resolves(
    zone: Path, server: _Server, data_dir: Path, tmp_path: Path
) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    set_channel(zone, {"street_network": "2026-09-17"})
    run(server.url, data_dir, datasets=["street_network"])

    assert not os.readlink(data_dir / "street_network").startswith("/")
    moved = tmp_path / "mounted-elsewhere"
    shutil.move(data_dir, moved)
    assert (
        moved / "street_network/nodes/h3_3=8097/data_0.parquet"
    ).read_bytes() == b"nodes-8097-v1"


def test_duckdb_reads_hive_partitions_through_the_link(
    zone: Path, server: _Server, data_dir: Path, tmp_path: Path
) -> None:
    # The tools glob `<edges>/**/*.parquet` with hive partitioning; that must
    # work when `street_network` is a symlink into .base/.
    con = duckdb.connect()
    files = {}
    for cell in (8097, 7954):
        out = tmp_path / f"{cell}.parquet"
        con.execute(f"COPY (SELECT {cell} * 10 AS id) TO '{out}' (FORMAT parquet)")
        files[f"edges/h3_3={cell}/data_0.parquet"] = out.read_bytes()
    publish(zone, "street_network", "2026-09-17", files)
    set_channel(zone, {"street_network": "2026-09-17"})
    run(server.url, data_dir, datasets=["street_network"])

    rows = con.execute(
        f"SELECT h3_3, id FROM read_parquet('{data_dir}/street_network/edges/**/*.parquet',"
        " hive_partitioning = true) ORDER BY h3_3"
    ).fetchall()
    assert rows == [(7954, 79540), (8097, 80970)]


def test_rerun_with_the_same_version_downloads_nothing(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    set_channel(zone, {"street_network": "2026-09-17"})
    run(server.url, data_dir, datasets=["street_network"])
    server.requests.clear()

    result = run(server.url, data_dir, datasets=["street_network"])

    assert result["street_network"]["status"] == "up_to_date"
    assert server.data_requests() == []


def test_a_deleted_install_is_restored_rather_than_reported_current(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    # Links whose version folder was removed by hand dangle; the tools then
    # find nothing, so the sync must re-install, not call it up to date.
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    set_channel(zone, {"street_network": "2026-09-17"})
    run(server.url, data_dir, datasets=["street_network"])
    shutil.rmtree(data_dir / ".base/street_network/2026-09-17")

    result = run(server.url, data_dir, datasets=["street_network"])

    assert result["street_network"]["status"] == "installed"
    nodes = data_dir / "street_network/nodes/h3_3=8097/data_0.parquet"
    assert nodes.read_bytes() == b"nodes-8097-v1"


# ─── update ────────────────────────────────────────────────────────────────


def test_new_version_switches_the_link_and_keeps_only_the_previous_one(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    for v in ("2026-09-17", "2026-12-01", "2027-03-01"):
        publish(
            zone, "street_network", v, {"edges/h3_3=8097/data_0.parquet": v.encode()}
        )
        set_channel(zone, {"street_network": v})
        run(server.url, data_dir, datasets=["street_network"])

    assert (
        data_dir / "street_network/edges/h3_3=8097/data_0.parquet"
    ).read_bytes() == b"2027-03-01"
    kept = sorted(p.name for p in (data_dir / ".base/street_network").iterdir())
    assert kept == ["2026-12-01", "2027-03-01"]


def test_checksum_mismatch_keeps_the_current_version(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    set_channel(zone, {"street_network": "2026-09-17"})
    run(server.url, data_dir, datasets=["street_network"])

    publish(zone, "street_network", "2026-12-01", STREET_V1)
    (zone / "street_network/2026-12-01/edges/h3_3=8097/data_0.parquet").write_bytes(
        b"tampered"
    )
    set_channel(zone, {"street_network": "2026-12-01"})

    with pytest.raises(RuntimeError, match="sha256"):
        run(server.url, data_dir, datasets=["street_network"])

    assert installed(data_dir, "street_network") == "2026-09-17"
    assert (
        data_dir / "street_network/edges/h3_3=8097/data_0.parquet"
    ).read_bytes() == b"edges-8097-v1"


def test_resumes_a_partial_download_with_a_range_request(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    publish(zone, "public_transport", "2026-09-17", PT_V1)
    set_channel(zone, {"public_transport": "2026-09-17"})
    part = (
        data_dir / ".base/.staging/public_transport/2026-09-17/pt_network/gtfs.bin.part"
    )
    part.parent.mkdir(parents=True)
    part.write_bytes(PT_V1["pt_network/gtfs.bin"][:500])

    run(server.url, data_dir, datasets=["public_transport"])

    assert (
        "/public_transport/2026-09-17/pt_network/gtfs.bin",
        "bytes=500-",
    ) in server.requests
    assert (data_dir / "pt_network/gtfs.bin").read_bytes() == PT_V1[
        "pt_network/gtfs.bin"
    ]


def test_pin_overrides_the_channel(zone: Path, server: _Server, data_dir: Path) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    publish(
        zone, "street_network", "2026-12-01", {"edges/h3_3=8097/data_0.parquet": b"new"}
    )
    set_channel(zone, {"street_network": "2026-12-01"})

    run(
        server.url,
        data_dir,
        datasets=["street_network"],
        pin={"street_network": "2026-09-17"},
    )

    assert installed(data_dir, "street_network") == "2026-09-17"


# ─── refusals ──────────────────────────────────────────────────────────────


def test_a_data_schema_this_goatlib_cannot_read_is_skipped(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1, data_schema=2)
    set_channel(
        zone, {"street_network": "2026-09-17"}, schemas={"street_network/2026-09-17": 2}
    )

    with pytest.raises(RuntimeError, match="data_schema"):
        run(server.url, data_dir, datasets=["street_network"])

    assert not (data_dir / "street_network").exists()
    assert server.data_requests() == []


def test_public_transport_needs_the_street_network_it_was_built_against(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    publish(
        zone,
        "public_transport",
        "2026-12-01",
        PT_V1,
        requires={"street_network": "2026-12-01"},
    )
    set_channel(
        zone, {"street_network": "2026-09-17", "public_transport": "2026-12-01"}
    )

    with pytest.raises(RuntimeError, match="requires street_network 2026-12-01"):
        run(server.url, data_dir)

    assert installed(data_dir, "street_network") == "2026-09-17"
    assert not (data_dir / "gtfs").exists()


def test_an_existing_directory_is_left_alone_without_adopt(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    (data_dir / "street_network/edges").mkdir(parents=True)
    (data_dir / "street_network/edges/old.parquet").write_bytes(b"hand-copied")
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    set_channel(zone, {"street_network": "2026-09-17"})

    result = run(server.url, data_dir, datasets=["street_network"])

    assert result["street_network"]["status"] == "unmanaged"
    assert not (data_dir / "street_network").is_symlink()
    assert (
        data_dir / "street_network/edges/old.parquet"
    ).read_bytes() == b"hand-copied"
    assert server.data_requests() == []


def test_adopt_moves_the_existing_directory_aside_and_links_the_version(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    (data_dir / "street_network/edges").mkdir(parents=True)
    (data_dir / "street_network/edges/old.parquet").write_bytes(b"hand-copied")
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    set_channel(zone, {"street_network": "2026-09-17"})

    run(server.url, data_dir, datasets=["street_network"], adopt=True)

    assert installed(data_dir, "street_network") == "2026-09-17"
    adopted = data_dir / ".base/street_network/adopted/edges/old.parquet"
    assert adopted.read_bytes() == b"hand-copied"


def test_dry_run_changes_nothing(zone: Path, server: _Server, data_dir: Path) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    set_channel(zone, {"street_network": "2026-09-17"})

    result = run(server.url, data_dir, datasets=["street_network"], dry_run=True)

    assert result["street_network"]["status"] == "would_install"
    assert result["street_network"]["files"] == 3
    assert list(data_dir.iterdir()) == []


def test_dry_run_of_a_fresh_install_reports_dependent_data_sets(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    publish(
        zone,
        "public_transport",
        "2026-09-17",
        PT_V1,
        requires={"street_network": "2026-09-17"},
    )
    set_channel(
        zone, {"street_network": "2026-09-17", "public_transport": "2026-09-17"}
    )

    result = run(server.url, data_dir, dry_run=True)

    assert result["street_network"]["status"] == "would_install"
    assert result["public_transport"]["status"] == "would_install"
    assert list(data_dir.iterdir()) == []


# ─── regions ───────────────────────────────────────────────────────────────


def test_region_filter_fetches_only_its_cells_and_every_unpartitioned_file(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    publish(
        zone,
        "public_transport",
        "2026-09-17",
        PT_V1,
        requires={"street_network": "2026-09-17"},
    )
    set_channel(
        zone, {"street_network": "2026-09-17", "public_transport": "2026-09-17"}
    )

    run(server.url, data_dir, h3_3=[8097])

    edges = sorted(
        p.parent.name for p in (data_dir / "street_network/edges").rglob("*.parquet")
    )
    assert edges == ["h3_3=8097"]
    assert (data_dir / "pt_network/gtfs.bin").exists()


def test_widening_the_region_fetches_only_the_new_cells(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    set_channel(zone, {"street_network": "2026-09-17"})
    run(server.url, data_dir, datasets=["street_network"], h3_3=[8097])
    server.requests.clear()

    result = run(server.url, data_dir, datasets=["street_network"], h3_3=[8097, 7954])

    assert result["street_network"]["status"] == "updated"
    assert [r[0] for r in server.data_requests()] == [
        "/street_network/2026-09-17/edges/h3_3=7954/data_0.parquet"
    ]
    assert (
        data_dir / "street_network/edges/h3_3=7954/data_0.parquet"
    ).read_bytes() == b"edges-7954-v1"
    assert (
        data_dir / "street_network/edges/h3_3=8097/data_0.parquet"
    ).read_bytes() == b"edges-8097-v1"


def test_bbox_covers_its_cells_plus_a_ring() -> None:
    try:
        cells = h3_3_cells_for_bbox([6.9, 50.6, 7.3, 50.8], ring=1)
    except duckdb.Error as exc:  # h3 is a community extension; skip where absent
        pytest.skip(f"duckdb h3 extension unavailable: {exc}")
    # Bonn sits in res-3 cell 8097; a bbox smaller than one cell still gets it
    # (H3's polygon fill alone returns nothing for it) plus its six neighbours.
    assert 8097 in cells
    assert len(cells) == 7


# ─── other sources ─────────────────────────────────────────────────────────


def test_a_plain_folder_works_as_a_source(zone: Path, data_dir: Path) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    set_channel(zone, {"street_network": "2026-09-17"})

    run(zone.as_uri() + "/", data_dir, datasets=["street_network"])

    assert installed(data_dir, "street_network") == "2026-09-17"


def test_a_mirror_is_a_complete_source_for_an_offline_site(
    zone: Path, server: _Server, data_dir: Path, tmp_path: Path
) -> None:
    publish(zone, "street_network", "2026-09-17", STREET_V1)
    publish(
        zone,
        "public_transport",
        "2026-09-17",
        PT_V1,
        requires={"street_network": "2026-09-17"},
    )
    set_channel(
        zone, {"street_network": "2026-09-17", "public_transport": "2026-09-17"}
    )
    copy = tmp_path / "usb-stick"

    mirror(
        server.url, copy, datasets=["street_network", "public_transport"], h3_3=[8097]
    )
    result = run(copy.as_uri() + "/", data_dir)

    assert result["public_transport"]["status"] == "installed"
    assert sorted(
        p.parent.name for p in (data_dir / "street_network/edges").rglob("*.parquet")
    ) == ["h3_3=8097"]


def test_nuts_links_a_single_file_inside_the_existing_catalog_dir(
    zone: Path, server: _Server, data_dir: Path
) -> None:
    (data_dir / "catalog").mkdir()
    (data_dir / "catalog/catalog.parquet").write_bytes(b"mirror")
    publish(zone, "nuts", "2024-01M", {"nuts.parquet": b"regions"})
    set_channel(zone, {"nuts": "2024-01M"})

    run(server.url, data_dir, datasets=["nuts"])

    assert (data_dir / "catalog/nuts.parquet").is_symlink()
    assert (data_dir / "catalog/nuts.parquet").read_bytes() == b"regions"
    assert (data_dir / "catalog/catalog.parquet").read_bytes() == b"mirror"


def test_registered_as_a_weekly_task_that_starts_switched_off() -> None:
    from goatlib.tasks.registry import TASK_REGISTRY

    task = next(t for t in TASK_REGISTRY if t.name == "sync_base_data")
    assert task.windmill_path == "f/goat/tasks/sync_base_data"
    assert task.get_params_class() is SyncBaseDataParams
    assert task.schedule is not None
    assert task.enabled is False


@pytest.mark.integration
def test_an_s3_bucket_works_as_a_source(zone: Path, data_dir: Path) -> None:
    import uuid

    import boto3
    from botocore.config import Config

    endpoint = os.environ.get("S3_ENDPOINT_URL")
    key, secret = (
        os.environ.get("S3_ACCESS_KEY_ID"),
        os.environ.get("S3_SECRET_ACCESS_KEY"),
    )
    bucket = os.environ.get("S3_BUCKET_NAME")
    if not (endpoint and key and secret and bucket):
        pytest.skip(
            "S3_ENDPOINT_URL / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_BUCKET_NAME unset"
        )
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=key,
        aws_secret_access_key=secret,
        config=Config(
            s3={"addressing_style": "path"},
            connect_timeout=3,
            retries={"max_attempts": 1},
        ),
    )
    try:
        s3.head_bucket(Bucket=bucket)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"S3 not reachable: {exc}")

    publish(zone, "street_network", "2026-09-17", STREET_V1)
    set_channel(zone, {"street_network": "2026-09-17"})
    prefix = f"_test-sync-base-data/{uuid.uuid4().hex}"
    keys = []
    for path in zone.rglob("*"):
        if path.is_file():
            k = f"{prefix}/{path.relative_to(zone).as_posix()}"
            s3.upload_file(str(path), bucket, k)
            keys.append(k)
    try:
        run(f"s3://{bucket}/{prefix}/", data_dir, datasets=["street_network"])
        assert installed(data_dir, "street_network") == "2026-09-17"
        assert (
            data_dir / "street_network/nodes/h3_3=8097/data_0.parquet"
        ).read_bytes() == b"nodes-8097-v1"
    finally:
        for k in keys:
            s3.delete_object(Bucket=bucket, Key=k)


def test_the_windmill_script_defaults_are_plain_data() -> None:
    # Windmill runs the generated script without goatlib's models in scope, so
    # a default rendered as `BaseDataSource(...)` is a NameError at load time.
    from goatlib.tasks.registry import TASK_REGISTRY
    from goatlib.tasks.sync_windmill import generate_task_script

    task = next(t for t in TASK_REGISTRY if t.name == "sync_base_data")
    script = generate_task_script(task)

    assert "BaseDataSource(" not in script
    assert (
        SyncBaseDataParams().sources[0].url == "https://goat-base-data.plan4better.de/"
    )
