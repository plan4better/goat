"""A bundle from layers a job wrote itself, as both network fetches make one.

Created, ingested and built in that order and only then ready; rolled back
whole when any of it fails; added to the project last, and kept when that
fails, since the bundle is complete without it.
"""

import pytest
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

    async def update_bundle_status(self, *, bundle_id, status) -> None:
        self.calls.append(f"status {status.value}")


def _runner(db: _Db, *, build_fails=False, project_fails=False) -> BundleImportRunner:
    runner = BundleImportRunner()

    async def ingest(db_, **kwargs):
        db.calls.append(f"ingest {len(kwargs['layers'])}")
        return [
            ImportedLayer(
                layer_id="L1", role="stops", name="Stops", layer_type="feature"
            )
        ]

    async def build(db_, **kwargs):
        if build_fails:
            raise RuntimeError("no timetable")
        db.calls.append(f"build {kwargs['members']}")

    async def rollback(db_, **kwargs):
        db.calls.append(f"rollback {len(kwargs['imported'])}")

    async def place(db_, **kwargs):
        if project_fails:
            raise RuntimeError("no project")
        db.calls.append(f"project {kwargs['project_id']}")

    runner._ingest_layers = ingest
    runner.build_and_store_artifacts = build
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


async def test_a_bundle_is_ready_only_once_built() -> None:
    db = _Db()
    result = await _create(_runner(db), db)
    assert db.calls == [
        f"create {BundleStatus.processing.value}",
        "ingest 1",
        "build [{'role': 'stops', 'layer_id': 'L1'}]",
        f"status {BundleStatus.ready.value}",
        "project p",
    ]
    assert result["bundle_type"] == "pt_network_gtfs"
    assert [layer["layer_id"] for layer in result["layers"]] == ["L1"]


async def test_a_failed_build_rolls_the_bundle_back() -> None:
    db = _Db()
    with pytest.raises(RuntimeError, match="no timetable"):
        await _create(_runner(db, build_fails=True), db)
    assert db.calls[-1] == "rollback 1"
    assert f"status {BundleStatus.ready.value}" not in db.calls


async def test_a_bundle_stays_when_the_project_cannot_take_it() -> None:
    db = _Db()
    result = await _create(_runner(db, project_fails=True), db)
    assert db.calls[-1] == f"status {BundleStatus.ready.value}"
    assert result["layers"]
