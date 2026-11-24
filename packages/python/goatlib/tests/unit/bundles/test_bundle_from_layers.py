"""A bundle from layers a job wrote itself, as both network fetches make one.

Created and ingested, its artifacts marked building, and then ready; rolled
back whole when the ingest fails; added to the project, and kept when that
fails, since the bundle is complete without it. Its artifacts are built by a
job of their own, started last; one that cannot be started leaves them failed.
"""

import pytest
from goatlib.bundles import runner as runner_module
from goatlib.bundles.importers.base import ExtractedLayer
from goatlib.bundles.runner import BundleImportRunner, ImportedLayer
from goatlib.models.bundle import BundleStatus, BundleTypeName

LAYERS = [
    ExtractedLayer(role="stops", name="Stops", layer_type="feature", file_path="s")
]


class _Db:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def create_bundle(self, **kwargs) -> None:
        self.calls.append(f"create {kwargs['status'].value}")

    async def create_artifact(self, *, bundle_id, kind, build_status) -> None:
        self.calls.append(f"artifact {kind.value} {build_status.value}")

    async def update_bundle_status(self, *, bundle_id, status) -> None:
        self.calls.append(f"status {status.value}")

    async def mark_bundle_artifacts_failed(self, bundle_id) -> None:
        self.calls.append("artifacts failed")


@pytest.fixture
def queue(monkeypatch: pytest.MonkeyPatch):
    """The build job's start, recorded instead of sent; ``fails`` refuses it."""
    started: list[dict] = []
    refuse: list[bool] = []

    def start(**kwargs) -> str:
        if refuse:
            raise RuntimeError("windmill unreachable")
        started.append(kwargs)
        return "job-1"

    monkeypatch.setattr(runner_module, "_queue_artifact_build", start)
    start.started = started
    start.fails = lambda: refuse.append(True)
    return start


def _runner(db: _Db, *, ingest_fails=False, project_fails=False) -> BundleImportRunner:
    runner = BundleImportRunner()

    async def ingest(db_, **kwargs):
        if ingest_fails:
            raise RuntimeError("no layers")
        db.calls.append(f"ingest {len(kwargs['layers'])}")
        return [
            ImportedLayer(
                layer_id="L1", role="stops", name="Stops", layer_type="feature"
            )
        ]

    async def rollback(db_, **kwargs):
        db.calls.append(f"rollback {len(kwargs['imported'])}")

    async def place(db_, **kwargs):
        if project_fails:
            raise RuntimeError("no project")
        db.calls.append(f"project {kwargs['project_id']}")

    runner._ingest_layers = ingest
    runner._rollback_bundle = rollback
    runner._add_bundle_to_project = place
    return runner


async def _create(runner: BundleImportRunner, db: _Db) -> dict:
    return await runner.create_bundle_from_layers(
        db,
        bundle_type=BundleTypeName.pt_network_gtfs,
        name="Cut",
        dataset_metadata={},
        layers=LAYERS,
        user_id="u",
        folder_id="f",
        project_id="p",
    )


async def test_a_bundle_is_ready_once_its_layers_are(queue) -> None:
    db = _Db()
    result = await _create(_runner(db), db)
    assert db.calls == [
        f"create {BundleStatus.processing.value}",
        "ingest 1",
        "artifact pt_network_graph building",
        "artifact pt_network_linkage building",
        f"status {BundleStatus.ready.value}",
        "project p",
    ]
    # The build is a job of its own, started once the bundle is in the project.
    assert queue.started == [{"bundle_id": result["bundle_id"], "user_id": "u"}]
    assert result["artifact_build_job_id"] == "job-1"
    assert result["bundle_type"] == "pt_network_gtfs"
    assert [layer["layer_id"] for layer in result["layers"]] == ["L1"]


async def test_a_failed_ingest_rolls_the_bundle_back(queue) -> None:
    db = _Db()
    with pytest.raises(RuntimeError, match="no layers"):
        await _create(_runner(db, ingest_fails=True), db)
    assert db.calls[-1] == "rollback 0"
    assert f"status {BundleStatus.ready.value}" not in db.calls
    assert queue.started == []


async def test_a_bundle_stays_when_the_project_cannot_take_it(queue) -> None:
    db = _Db()
    result = await _create(_runner(db, project_fails=True), db)
    assert "project p" not in db.calls
    assert result["layers"]
    assert result["artifact_build_job_id"] == "job-1"


async def test_a_build_that_cannot_start_leaves_the_artifacts_failed(queue) -> None:
    queue.fails()
    db = _Db()
    result = await _create(_runner(db), db)
    # Failed rather than building for good: failed is what offers a rebuild.
    assert db.calls[-1] == "artifacts failed"
    assert result["artifact_build_job_id"] is None
    assert result["layers"]
