"""Editing a bundle: which roles allow it, and how a rebuild publishes.

Covers the spec-level contract (``RoleSpec.editable``), the bookkeeping a
rebuild depends on (upsert, revision-guarded publish), and the wiring that makes
the rebuild tool reachable.
"""

import pytest
from goatlib.bundles.artifacts.build_mixin import BundleArtifactBuildMixin
from goatlib.bundles.runner import BundleImportRunner
from goatlib.models.bundle import (
    SPECS,
    BundleArtifactBuildStatus,
    BundleTypeName,
    RoleSpec,
    artifact_state,
)
from goatlib.tools.bundle_artifact_rebuild import (
    BundleArtifactRebuildParams,
    BundleArtifactRebuildRunner,
)
from goatlib.tools.db import ToolDatabaseService
from goatlib.tools.registry import TOOL_REGISTRY
from pydantic import ValidationError

USER = "11111111-1111-1111-1111-111111111111"
BUNDLE = "22222222-2222-2222-2222-222222222222"
ARTIFACT = "33333333-3333-3333-3333-333333333333"
LAYER = "44444444-4444-4444-4444-444444444444"
FOLDER = "55555555-5555-5555-5555-555555555555"


# --- editability -----------------------------------------------------------


@pytest.mark.parametrize(
    ("bundle_type", "role", "expected"),
    [
        (BundleTypeName.street_network, "edges", True),
        # The editor maintains nodes when edges are saved, so they are not
        # offered for editing.
        (BundleTypeName.street_network, "nodes", False),
        (BundleTypeName.pt_network_gtfs, "stops", False),
        (BundleTypeName.pt_network_gtfs, "shapes", False),
    ],
)
def test_role_editability(bundle_type, role, expected):
    assert SPECS[bundle_type].role(role).editable is expected


def test_a_role_is_not_editable_until_someone_says_so():
    """Fails closed: a role added later must not accept writes by default."""
    assert RoleSpec(key="whatever", label="Whatever").editable is False
    assert [
        r.key for r in SPECS[BundleTypeName.pt_network_gtfs].roles if r.editable
    ] == []


# --- artifact bookkeeping --------------------------------------------------


class FakePool:
    """Records the SQL it is handed, so the guarantees can be asserted."""

    def __init__(self, rows=None, execute_result="UPDATE 1"):
        self.calls: list[tuple] = []
        self._rows = rows or []
        self._execute_result = execute_result

    async def fetchrow(self, query, *args):
        self.calls.append((query, args))
        return self._rows[0] if self._rows else None

    async def fetch(self, query, *args):
        self.calls.append((query, args))
        return self._rows

    async def execute(self, query, *args):
        self.calls.append((query, args))
        return self._execute_result


def _service(pool):
    svc = ToolDatabaseService.__new__(ToolDatabaseService)
    svc.schema = "customer"
    svc.pool = pool
    return svc


async def test_create_artifact_upserts_so_a_rebuild_can_reuse_the_row():
    """(bundle_id, kind) is unique — a plain INSERT would raise on rebuild."""
    svc = _service(FakePool([{"id": ARTIFACT}]))
    await svc.create_artifact(bundle_id=BUNDLE, kind="street_network_graph")
    query = svc.pool.calls[0][0]
    assert "ON CONFLICT (bundle_id, kind)" in query
    assert "DO UPDATE" in query


async def test_marking_a_row_building_cannot_contradict_a_newer_artifact():
    """The row is shared by every build of this (bundle, kind). Writing
    `building` on one that already published from this revision or a newer one
    would take a working graph offline for the length of the build — which is
    exactly what pressing Update on a ready bundle does."""
    svc = _service(FakePool([{"id": ARTIFACT}]))
    await svc.create_artifact(
        bundle_id=BUNDLE, kind="street_network_graph", built_revision=4
    )
    query, args = svc.pool.calls[0]
    # The guard is inside the statement, not a read followed by a write, so two
    # workers cannot interleave.
    assert "a.revision < $5" in query
    assert "ELSE a.build_status" in query
    assert args[-1] == 4


async def test_a_lost_build_cannot_stamp_failed_over_a_newer_one():
    """R1(rev 2) and R2(rev 3) race and R2 wins. R1 then records its own
    failure on the shared row — and without the guard `artifact_state` reports
    `failed` for R2's valid current graph, with nothing to re-queue."""
    svc = _service(FakePool())
    await svc.set_artifact_build_status(
        artifact_id=ARTIFACT,
        status=BundleArtifactBuildStatus.failed,
        built_revision=2,
    )
    query, args = svc.pool.calls[0]
    assert "revision < $3" in query
    assert args[-1] == 2


async def test_artifact_lookup_reads_everything_the_state_is_derived_from():
    """`resolve_bundle_artifact` derives the state from four things, three of
    which come from this row plus the bundle's own revision — so the JOIN is
    not decoration. A lookup missing any of them cannot answer "is this graph
    still the one the layers describe"."""
    svc = _service(
        FakePool(
            [
                {
                    "storage_path": f"{BUNDLE}/street_network_graph-r7-abc.tar",
                    "build_status": "complete",
                    "revision": 7,
                    "layers_revision": 7,
                }
            ]
        )
    )
    row = await svc.get_bundle_artifact(BUNDLE, "street_network_graph")
    assert set(row) >= {
        "storage_path",
        "build_status",
        "revision",
        "layers_revision",
    }
    query = svc.pool.calls[0][0]
    for column in ("a.build_status", "a.revision", "b.layers_revision"):
        assert column in query
    # `layers_revision` is the bundle's, not the artifact's, so dropping the
    # join loses the only thing that says whether the file is still current.
    assert "JOIN" in query and ".bundle b" in query
    # And the state is derived, never read from a stored flag.
    assert artifact_state(**row) is not None


async def test_publish_is_guarded_by_the_revision_it_built_from():
    """A build overtaken by a later save must not publish its output, and only
    the build that did publish may remove the file it displaced."""
    svc = _service(
        FakePool([{"displaced_path": f"{BUNDLE}/old.tar"}]),
    )
    current, displaced = await svc.publish_artifact_if_current(
        artifact_id=ARTIFACT,
        bundle_id=BUNDLE,
        built_revision=7,
        storage_path=f"{BUNDLE}/street_network_graph-r7-abc.tar",
        size=123,
    )
    assert current is True
    assert displaced == f"{BUNDLE}/old.tar"
    # The comparison lives in the WHERE clause, so there is no window between
    # checking and writing.
    query = svc.pool.calls[0][0]
    assert "layers_revision = $5" in query


async def test_a_superseded_build_publishes_nothing_and_displaces_nothing():
    """No row back means the revision moved on: this build's output is already
    out of date, and the file it would have displaced is not its to remove."""
    svc = _service(FakePool())
    current, displaced = await svc.publish_artifact_if_current(
        artifact_id=ARTIFACT,
        bundle_id=BUNDLE,
        built_revision=7,
        storage_path=f"{BUNDLE}/street_network_graph-r7-abc.tar",
        size=123,
    )
    assert (current, displaced) == (False, None)


async def test_the_displaced_path_is_read_under_a_lock():
    """Two same-revision rebuilds can both win. Without a lock the second reads
    the path from before either commit and reports *that* as displaced — so the
    first winner's fresh archive is left on the volume with nothing pointing at
    it, and the file the second replaced is never removed."""
    svc = _service(FakePool([{"displaced_path": f"{BUNDLE}/old.tar"}]))
    await svc.publish_artifact_if_current(
        artifact_id=ARTIFACT,
        bundle_id=BUNDLE,
        built_revision=7,
        storage_path=f"{BUNDLE}/new.tar",
        size=1,
    )
    query = svc.pool.calls[0][0]
    assert "FOR UPDATE" in query
    # One statement: the read of the old path and the write of the new one
    # cannot be separated by another transaction's commit.
    assert query.count("UPDATE") >= 1 and "RETURNING prev.storage_path" in query


async def test_a_bundle_read_carries_what_a_copy_of_it_needs():
    """A copy of a bundle keeps what the source says about itself. Neither
    column being selected is how they came to be silently dropped."""
    svc = _service(
        FakePool(
            [
                {
                    "bundle_type": "street_network",
                    "user_id": USER,
                    "layers_revision": 3,
                    "description": "Augsburg, trimmed",
                    "dataset_metadata": '{"license": "ODbL"}',
                }
            ]
        )
    )
    bundle = await svc.get_bundle(BUNDLE)
    assert bundle["description"] == "Augsburg, trimmed"
    # Decoded, so a caller can hand it straight back to `create_bundle`.
    assert bundle["dataset_metadata"] == {"license": "ODbL"}
    query = svc.pool.calls[0][0]
    assert "description" in query and "dataset_metadata" in query


async def test_a_layer_read_carries_its_field_config():
    """`_copy_member` reads `field_config` off the source layer; the column
    never being selected is what made that branch dead, so a filtered copy came
    out with no computed, locked, vocabulary or default metadata at all."""
    svc = _service(
        FakePool(
            [
                {
                    "id": LAYER,
                    "name": "Edges",
                    "user_id": USER,
                    "folder_id": FOLDER,
                    "type": "feature",
                    "feature_layer_type": "standard",
                    "feature_layer_geometry_type": "line",
                    "field_config": '{"length_m": {"is_computed": true}}',
                }
            ]
        )
    )
    info = await svc.get_layer_info(LAYER)
    assert info["field_config"] == {"length_m": {"is_computed": True}}
    assert "field_config" in svc.pool.calls[0][0]


async def test_revision_and_member_helpers_read_what_a_rebuild_needs():
    svc = _service(FakePool([{"layers_revision": 3}]))
    assert await svc.get_bundle_revision(BUNDLE) == 3

    svc = _service(FakePool([{"layers_revision": 8}]))
    assert await svc.bump_bundle_revision(BUNDLE) == 8

    svc = _service(FakePool([{"role": "edges", "layer_id": "l-edges"}]))
    assert (await svc.list_bundle_layers(BUNDLE))[0]["role"] == "edges"


# --- the rebuild tool ------------------------------------------------------


def test_rebuild_requires_a_bundle_id():
    with pytest.raises(ValidationError):
        BundleArtifactRebuildParams(user_id=USER)
    assert BundleArtifactRebuildParams(user_id=USER, bundle_id="b1").bundle_id == "b1"


def test_import_and_rebuild_build_artifacts_through_one_code_path():
    """Two callers, one implementation: an edit is built exactly as an import is."""
    assert issubclass(BundleArtifactRebuildRunner, BundleArtifactBuildMixin)
    assert issubclass(BundleImportRunner, BundleArtifactBuildMixin)


def test_a_layer_based_build_without_members_is_refused():
    with pytest.raises(ValueError, match="member layers"):
        BundleArtifactBuildMixin().export_member_layers(
            user_id=USER, members=[], workdir="/tmp"
        )


def test_the_rebuild_tool_is_dispatchable():
    entry = next(
        (t for t in TOOL_REGISTRY if t.name == "bundle_artifact_rebuild"), None
    )
    assert entry is not None
    assert entry.windmill_path == "f/goat/tools/bundle_artifact_rebuild"
    assert entry.toolbox_hidden is True


# --- the build passes the revision its writes are guarded by ----------------


class _RecordingDb:
    """The artifact bookkeeping calls a build makes, with their arguments."""

    def __init__(self, published: bool = True) -> None:
        self.published = published
        self.created: list[dict] = []
        self.statuses: list[dict] = []

    async def get_bundle_revision(self, bundle_id):
        return 9

    async def create_artifact(self, **kwargs):
        self.created.append(kwargs)
        return ARTIFACT

    async def publish_artifact_if_current(self, **kwargs):
        return self.published, None

    async def set_artifact_build_status(self, **kwargs):
        self.statuses.append(kwargs)

    async def mark_bundle_artifacts_failed(self, bundle_id):
        pass


def _stub_build(monkeypatch, tmp_path):
    """A builder that produces one file, and storage that does nothing."""
    from goatlib.bundles.artifacts import base, build_mixin
    from goatlib.models.bundle import BundleArtifactKind

    artifact_file = tmp_path / "graph.tar"
    artifact_file.write_bytes(b"x")

    class _Builder(base.ArtifactBuilder):
        builds_from_layers = False
        produces = (BundleArtifactKind.street_network_graph,)

        def build(self, *, source_path, workdir, **kwargs):
            return [
                base.BuiltArtifact(
                    kind=BundleArtifactKind.street_network_graph,
                    local_path=str(artifact_file),
                    size=1,
                )
            ]

    monkeypatch.setattr(build_mixin, "get_artifact_builder", lambda t: _Builder())
    monkeypatch.setattr(
        build_mixin, "store_artifact", lambda *a, **k: f"{BUNDLE}/graph.tar"
    )
    monkeypatch.setattr(build_mixin, "delete_artifact_file", lambda *a: None)

    mixin = BundleArtifactBuildMixin()
    mixin.settings = type("S", (), {"bundles_data_dir": str(tmp_path)})()
    return mixin


async def test_the_building_upsert_carries_the_revision_it_builds_from(
    monkeypatch, tmp_path
):
    """The guard in `create_artifact` is inert unless the build says which
    revision it is producing."""
    mixin = _stub_build(monkeypatch, tmp_path)
    db = _RecordingDb()
    await mixin.build_and_store_artifacts(
        db,
        bundle_id=BUNDLE,
        bundle_type=BundleTypeName.street_network,
        source_path="src.zip",
        user_id=USER,
        built_revision=5,
    )
    assert db.created[0]["built_revision"] == 5


async def test_a_superseded_builds_failure_carries_its_own_revision(
    monkeypatch, tmp_path
):
    """This is the write that used to overwrite a newer build's status."""
    mixin = _stub_build(monkeypatch, tmp_path)
    db = _RecordingDb(published=False)
    published = await mixin.build_and_store_artifacts(
        db,
        bundle_id=BUNDLE,
        bundle_type=BundleTypeName.street_network,
        source_path="src.zip",
        user_id=USER,
        built_revision=2,
    )
    assert published is False
    assert db.statuses[0]["built_revision"] == 2


async def test_marking_a_bundles_artifacts_failed_spares_newer_ones():
    """The widest version of the same hazard: this writes every artifact row of
    the bundle at once, so a build that dies while a newer build has already
    published would mark that newer, valid artifact failed."""
    svc = _service(FakePool())
    await svc.mark_bundle_artifacts_failed(BUNDLE, built_revision=3)
    query, args = svc.pool.calls[0]
    assert "revision < $3" in query
    assert args[-1] == 3


async def test_the_revision_is_read_before_the_build_not_after(monkeypatch, tmp_path):
    """Only a concurrent edit moves `layers_revision`. Reading it after the
    build would pick that edit up and claim output built from the *older*
    layers came from the newer revision — sailing straight through the publish
    guard that exists to reject exactly that."""
    mixin = _stub_build(monkeypatch, tmp_path)

    order: list[str] = []

    class _Db(_RecordingDb):
        async def get_bundle_revision(self, bundle_id):
            order.append("read revision")
            return 4

    db = _Db()

    from goatlib.bundles.artifacts import build_mixin

    real = build_mixin.get_artifact_builder(None)

    def _spy(bundle_type):
        builder = real

        class _Spy:
            builds_from_layers = builder.builds_from_layers
            produces = builder.produces

            def build(self, *, source_path, workdir, **kwargs):
                order.append("build")
                return builder.build(source_path=source_path, workdir=workdir)

        return _Spy()

    monkeypatch.setattr(build_mixin, "get_artifact_builder", _spy)

    await mixin.build_and_store_artifacts(
        db,
        bundle_id=BUNDLE,
        bundle_type=BundleTypeName.street_network,
        source_path="src.zip",
        user_id=USER,
    )
    assert order == ["read revision", "build"]
    # And the revision it read is the one the artifact row claims.
    assert db.created[0]["built_revision"] == 4


async def test_a_dying_builds_failure_carries_the_revision_it_started_from(
    monkeypatch, tmp_path
):
    """The `mark_bundle_artifacts_failed` guard is only reachable because the
    revision is now known *before* the build — it was read after, so the
    except branch had nothing to guard with."""
    mixin = _stub_build(monkeypatch, tmp_path)
    from goatlib.bundles.artifacts import build_mixin

    class _Exploding:
        builds_from_layers = False
        produces = ()

        def build(self, *, source_path, workdir, **kwargs):
            raise RuntimeError("the builder died")

    monkeypatch.setattr(build_mixin, "get_artifact_builder", lambda t: _Exploding())

    marked: list[dict] = []

    class _Db(_RecordingDb):
        async def mark_bundle_artifacts_failed(self, bundle_id, built_revision=None):
            marked.append({"bundle_id": bundle_id, "built_revision": built_revision})

    with pytest.raises(RuntimeError, match="the builder died"):
        await mixin.build_and_store_artifacts(
            _Db(),
            bundle_id=BUNDLE,
            bundle_type=BundleTypeName.street_network,
            source_path="src.zip",
            user_id=USER,
            built_revision=2,
        )
    assert marked == [{"bundle_id": BUNDLE, "built_revision": 2}]
