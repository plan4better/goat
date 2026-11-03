"""Building the default public transport network and publishing it as base data.

The timetable and access/egress build is the GTFS bundle build, stood in for
here (the routing extension is not in every test environment); everything
around it runs: the feed fetched from its folder, the tables built from it,
the version published with its manifest, and installed by a sync.
"""

import json
import tarfile
import zipfile
from pathlib import Path
from types import SimpleNamespace

import duckdb
import pytest
from goatlib.bundles.artifacts import gtfs as gtfs_artifacts
from goatlib.bundles.artifacts.base import BuiltArtifact
from goatlib.models.bundle import BundleArtifactKind
from goatlib.tasks import build_pt_network
from goatlib.tasks.build_pt_network import BuildPtNetworkParams, BuildPtNetworkTask
from goatlib.tasks.sync_base_data import SyncBaseDataParams, sync

FEED = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\n"
    "A,Local,https://a.example,Europe/Berlin\n",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\n"
    "S1,One,48.10,11.50\nS2,Two,48.20,11.60\n",
    "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\n",
    "trips.txt": "route_id,service_id,trip_id\nR1,WK,T1\n",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
    "T1,08:00:00,08:00:00,S1,1\nT1,08:10:00,08:10:00,S2,2\n",
    "calendar_dates.txt": "service_id,date,exception_type\nWK,20261105,1\n",
}


@pytest.fixture
def source(tmp_path: Path) -> Path:
    folder = tmp_path / "source"
    folder.mkdir()
    with zipfile.ZipFile(folder / "gtfs_combined.zip", "w") as zf:
        for name, text in FEED.items():
            zf.writestr(name, text)
    return folder


def _fake_build(asked: dict, error: str | None = None):
    def build(self, *, source_path, workdir, dependencies=None, options=None):
        asked.update(source=source_path, dependencies=dependencies, options=options)
        timetable = Path(workdir) / "pt_network_graph.bin"
        timetable.write_bytes(b"nigiri")
        table = Path(workdir) / "accessegress_walking_r9.parquet"
        duckdb.connect().execute(
            f"COPY (SELECT 1 AS stop_idx, 8::UBIGINT AS cell, 3.5 AS minutes) "
            f"TO '{table}'"
        )
        archive = Path(workdir) / "pt_network_linkage.tar"
        with tarfile.open(archive, "w") as tar:
            tar.add(table, arcname=table.name)
        return [
            BuiltArtifact(
                kind=BundleArtifactKind.pt_network_graph,
                local_path=str(timetable),
                properties={"service_start": "2026-11-05", "service_days": 1},
            ),
            BuiltArtifact(
                kind=BundleArtifactKind.pt_network_linkage,
                local_path=None if error else str(archive),
                error=error,
            ),
        ]

    return build


def _task(tmp_path: Path) -> BuildPtNetworkTask:
    task = BuildPtNetworkTask()
    task.settings = SimpleNamespace(
        street_network_edges_base_path=str(tmp_path / "data/street_network/edges"),
        street_network_nodes_base_path=str(tmp_path / "data/street_network/nodes"),
    )
    return task


def test_the_network_is_published_as_a_version_a_sync_installs(
    source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    asked: dict = {}
    monkeypatch.setattr(gtfs_artifacts.GtfsArtifactBuilder, "build", _fake_build(asked))
    monkeypatch.setattr(
        build_pt_network, "installed_version", lambda d, s: "2026-10-07"
    )
    zone = tmp_path / "zone"

    result = _task(tmp_path).run(
        BuildPtNetworkParams(
            source_url=source.as_uri() + "/",
            dest_url=zone.as_uri() + "/",
            version="2026-11-02",
            coverage_name="Test",
            license="CC-BY-4.0",
        )
    )

    # The bundle build, against the worker's global network, walking only.
    street = asked["dependencies"]["street_network"]
    assert street["edge_path"].endswith("street_network/edges")
    assert asked["options"] == {"linkage_modes": ["walking"]}

    manifest = json.loads(
        (zone / "public_transport/2026-11-02/manifest.json").read_text()
    )
    paths = {f["path"] for f in manifest["files"]}
    assert {
        "pt_network/gtfs.bin",
        "pt_network/accessegress_walking_r9.parquet",
        "pt_network/gtfs_tables/info.json",
        "pt_network/gtfs_tables/stop_times.parquet",
    } <= paths
    assert manifest["requires"] == {"street_network": "2026-10-07"}
    assert manifest["coverage"] == {"bbox": [11.5, 48.1, 11.6, 48.2], "name": "Test"}
    assert result["service"]["service_days"] == 1

    # Listed, and no channel moved without asking.
    channels = json.loads((zone / "channels.json").read_text())
    assert channels["versions"]["public_transport"][0]["version"] == "2026-11-02"
    assert "public_transport" not in channels.get("channels", {}).get("stable", {})

    # The tables carry what was stated about the feed.
    info = zone / "public_transport/2026-11-02/pt_network/gtfs_tables/info.json"
    assert json.loads(info.read_text())["license"] == "CC-BY-4.0"


def test_a_published_version_installs_on_a_server(
    source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(gtfs_artifacts.GtfsArtifactBuilder, "build", _fake_build({}))
    monkeypatch.setattr(build_pt_network, "installed_version", lambda d, s: None)
    zone = tmp_path / "zone"
    _task(tmp_path).run(
        BuildPtNetworkParams(
            source_url=source.as_uri() + "/",
            dest_url=zone.as_uri() + "/",
            version="2026-11-02",
        )
    )
    data = tmp_path / "server"
    data.mkdir()

    sync(
        SyncBaseDataParams(
            sources=[{"url": zone.as_uri() + "/"}],
            data_dir=str(data),
            datasets=["public_transport"],
            pin={"public_transport": "2026-11-02"},
        )
    )

    assert (data / "pt_network/gtfs.bin").read_bytes() == b"nigiri"
    assert (data / "pt_network/gtfs_tables/info.json").is_file()


def test_a_failed_build_publishes_nothing(
    source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        gtfs_artifacts.GtfsArtifactBuilder,
        "build",
        _fake_build({}, error="The linked street network is not ready to route on."),
    )
    monkeypatch.setattr(build_pt_network, "installed_version", lambda d, s: None)
    zone = tmp_path / "zone"
    with pytest.raises(RuntimeError, match="not ready to route on"):
        _task(tmp_path).run(
            BuildPtNetworkParams(
                source_url=source.as_uri() + "/", dest_url=zone.as_uri() + "/"
            )
        )
    assert not zone.exists()


def test_registered_as_a_manual_task_on_the_routing_worker() -> None:
    from goatlib.tasks.registry import TASK_REGISTRY

    task = next(t for t in TASK_REGISTRY if t.name == "build_pt_network")
    assert task.schedule is None and task.worker_tag == "tools"
