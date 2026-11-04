"""Creating a bundle from a filtered copy of another one.

Covers the four things the copy has to get right whatever the bundle type: it
may only read a source the caller can reach and write into a folder they own,
a filter that did not compile is a failure rather than a full copy, the parquet
it exports is cleaned up, and the copy carries the role's contract so it
behaves like a freshly imported bundle.
"""

from pathlib import Path
from types import SimpleNamespace

import duckdb
import pytest
from goatlib.bundles.runner import ImportedLayer
from goatlib.models.bundle import BundleTypeName, get_spec, role_field_config
from goatlib.tools import bundle_create_filtered as module
from goatlib.tools.authz import authorize_bundle_copy
from goatlib.tools.bundle_create_filtered import BundleCreateFilteredRunner

USER = "11111111-1111-1111-1111-111111111111"
BUNDLE = "22222222-2222-2222-2222-222222222222"
FOLDER = "33333333-3333-3333-3333-333333333333"


# --- the role's contract travels with the copy ------------------------------


def test_role_field_config_projects_the_whole_contract() -> None:
    """One function, so an import, a filtered copy and a backfill cannot
    produce three different answers for the same role."""
    config = role_field_config(get_spec(BundleTypeName.street_network).role("edges"))

    length = config["length_m"]
    assert length["is_computed"] is True
    assert length["kind"] == "length"
    assert length["depends_on"] == ["geometry"]
    # Computed *and* locked: where the value comes from and who owns it are
    # different questions.
    assert length["is_locked"] is True

    assert config["source_node"]["is_locked"] is True
    assert "unknown" in config["class"]["allowed_values"]
    assert config["class"]["allow_other"] is False
    assert config["class"]["default_value"] == "unknown"


def test_role_field_config_is_empty_for_a_role_with_no_contract() -> None:
    config = role_field_config(get_spec(BundleTypeName.street_network).role("nodes"))
    assert config == {}
    # And a member whose role the spec does not know at all.
    assert role_field_config(None) == {}


def test_the_roles_contract_is_added_under_what_the_layer_stores() -> None:
    """The point of the ordering. A copy of a bundle imported before the
    contract existed still gets it — that is what lets the copy be editable
    when its source is not — while anything the user authored still wins."""
    stored = {
        # A legacy edges layer: a display setting the user chose, and nothing
        # the role declares.
        "length_m": {"display_config": {"decimals": 1}},
    }
    merged = BundleCreateFilteredRunner._merged_field_config(
        role_field_config(get_spec(BundleTypeName.street_network).role("edges")),
        stored,
    )
    # The contract arrived.
    assert merged["length_m"]["is_computed"] is True
    assert merged["class"]["default_value"] == "unknown"
    # The user's own setting survived it.
    assert merged["length_m"]["display_config"] == {"decimals": 1}


def test_the_layers_own_entry_wins_where_both_name_the_same_key() -> None:
    merged = BundleCreateFilteredRunner._merged_field_config(
        role_field_config(get_spec(BundleTypeName.street_network).role("edges")),
        {"class": {"allowed_values": ["residential"], "allow_other": True}},
    )
    assert merged["class"]["allowed_values"] == ["residential"]
    assert merged["class"]["allow_other"] is True
    # The half the layer said nothing about is still the role's.
    assert merged["class"]["default_value"] == "unknown"


def test_a_layer_with_no_stored_config_gets_the_contract_alone() -> None:
    merged = BundleCreateFilteredRunner._merged_field_config(
        role_field_config(get_spec(BundleTypeName.street_network).role("edges")), None
    )
    assert merged["length_m"]["is_computed"] is True


# --- authorization ----------------------------------------------------------


class _Authz:
    """Answers `user_can` from a table, and records what was asked."""

    def __init__(self, allowed: dict) -> None:
        self.allowed = allowed
        self.asked: list[tuple] = []

    async def user_can(self, resource_type, resource_id, user_id, action):
        self.asked.append((resource_type, resource_id, user_id, action))
        return self.allowed.get((resource_type, action), False)


async def test_a_copy_asks_about_both_the_source_and_the_destination() -> None:
    db = _Authz({("bundle", "read"): True, ("folder", "write"): True})
    await authorize_bundle_copy(
        db, user_id=USER, source_bundle_id=BUNDLE, folder_id=FOLDER
    )
    assert db.asked == [
        ("bundle", BUNDLE, USER, "read"),
        ("folder", FOLDER, USER, "write"),
    ]


async def test_copying_another_tenants_bundle_is_refused() -> None:
    """`source_bundle_id` is a tool input. Without this check an authenticated
    user could copy any bundle in the deployment into their own folder."""
    db = _Authz({("folder", "write"): True})
    with pytest.raises(ValueError, match="cannot be copied"):
        await authorize_bundle_copy(
            db, user_id=USER, source_bundle_id=BUNDLE, folder_id=FOLDER
        )


async def test_writing_the_copy_into_someone_elses_folder_is_refused() -> None:
    db = _Authz({("bundle", "read"): True})
    with pytest.raises(ValueError, match="nowhere to go"):
        await authorize_bundle_copy(
            db, user_id=USER, source_bundle_id=BUNDLE, folder_id=FOLDER
        )


async def test_authorization_happens_before_any_work(monkeypatch) -> None:
    """A refused job must leave nothing behind — so the questions are asked
    before the source is even read, let alone a bundle created."""

    class _Db:
        def __init__(self, pool, schema=None) -> None:
            pass

        async def user_can(self, *args, **kwargs):
            return False

        async def get_bundle(self, *args, **kwargs):
            raise AssertionError("the source was read before authorization")

        async def create_bundle(self, *args, **kwargs):
            raise AssertionError("a bundle was created before authorization")

    closed: list[bool] = []

    class _Pool:
        async def close(self) -> None:
            closed.append(True)

    monkeypatch.setattr(module, "ToolDatabaseService", _Db)
    runner = BundleCreateFilteredRunner.__new__(BundleCreateFilteredRunner)
    runner.settings = SimpleNamespace(customer_schema="customer")
    runner._duckdb_con = None

    async def _pool():
        return _Pool()

    runner.get_postgres_pool = _pool

    with pytest.raises(ValueError, match="cannot be copied"):
        await runner.run_filtered(
            source_bundle_id=BUNDLE,
            cql_filter={},
            user_id=USER,
            folder_id=FOLDER,
        )
    # And the connection pool is still released on the refusal path.
    assert closed == [True]


# --- exporting a member -----------------------------------------------------


@pytest.fixture()
def runner():
    """A runner with a real DuckDB connection over a one-row 'layer'."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    con.execute("""
        CREATE TABLE member AS
        SELECT 'e1' AS id, ST_Point(11.0, 48.0) AS geometry
    """)
    instance = BundleCreateFilteredRunner.__new__(BundleCreateFilteredRunner)
    instance._duckdb_con = con
    instance.get_layer_table_path = lambda layer_id: "member"
    yield instance
    con.close()


def test_the_export_writes_into_the_workdir_it_is_given(runner, tmp_path) -> None:
    """A directory per member from `mkdtemp` was never removed, so a job leaked
    tens to hundreds of MB on the worker. The caller owns the directory now."""
    out = runner._export_filtered("layer-1", None, str(tmp_path))
    assert Path(out).parent == tmp_path
    assert Path(out).exists()


def test_a_filter_that_does_not_compile_fails_the_job(runner, tmp_path) -> None:
    """`build_cql_filter` logs the parse error and returns no clauses, which
    here would mean copying every row of every member and calling it the
    filtered copy the user asked for."""
    with pytest.raises(ValueError, match="filter could not be applied"):
        runner._export_filtered("layer-1", {"not": "a cql2 filter"}, str(tmp_path))


def test_a_member_with_no_geometry_is_copied_whole(runner, tmp_path) -> None:
    """A geometry predicate means nothing against an attribute table, so such a
    member is copied unfiltered — and that is not the failure above."""
    out = runner._export_filtered("layer-1", None, str(tmp_path))
    rows = runner.duckdb_con.execute(
        f"SELECT count(*) FROM read_parquet('{out}')"
    ).fetchone()
    assert rows[0] == 1


# --- rollback ---------------------------------------------------------------


async def test_a_failed_copy_removes_its_artifact_files_too(monkeypatch) -> None:
    """The copy's rollback used to omit `delete_bundle_artifacts`, so a copy
    that failed after storing an artifact left the file on the volume with no
    row pointing at it. Both callers now go through one function."""
    removed: list[str] = []
    deleted: list[str] = []
    dropped: list[list] = []

    from goatlib.bundles import runner as runner_module

    monkeypatch.setattr(
        runner_module,
        "delete_bundle_artifacts",
        lambda data_dir, bundle_id: removed.append(bundle_id),
    )

    class _Db:
        async def delete_bundle(self, bundle_id):
            deleted.append(bundle_id)

    async def _cleanup_layers(db, user_id, layer_ids):
        dropped.append(layer_ids)

    runner = BundleCreateFilteredRunner.__new__(BundleCreateFilteredRunner)
    runner.settings = SimpleNamespace(bundles_data_dir="/data/bundles")
    runner._cleanup_layers = _cleanup_layers

    await runner._rollback_bundle(
        _Db(),
        user_id=USER,
        bundle_id=BUNDLE,
        imported=[
            ImportedLayer(
                role="edges", layer_id="l-edges", name="Edges", layer_type="feature"
            )
        ],
    )
    assert dropped == [["l-edges"]]
    assert removed == [BUNDLE]
    assert deleted == [BUNDLE]


def test_the_import_and_the_copy_share_one_rollback() -> None:
    """Two spellings of the same choreography had already drifted apart once."""
    import inspect

    from goatlib.bundles.runner import BundleImportRunner

    for source in (
        inspect.getsource(BundleImportRunner.ingest_into_bundle),
        inspect.getsource(BundleCreateFilteredRunner.run_filtered),
    ):
        assert "_rollback_bundle" in source
        # Neither re-spells the steps itself any more.
        assert "delete_bundle_artifacts(" not in source
        assert "db.delete_bundle(" not in source


# --- the copied member layer ------------------------------------------------


class _CopyDb:
    """The handful of writes `_copy_member` makes, recorded."""

    def __init__(self, source: dict) -> None:
        self.source = source
        self.field_config: dict | None = None
        self.linked: list[tuple] = []

    async def get_layer_info(self, layer_id):
        return dict(self.source)

    async def create_layer(self, **kwargs):
        self.created = kwargs

    async def set_layer_field_config(self, layer_id, field_config):
        self.field_config = field_config

    async def add_layer_to_bundle(self, *, bundle_id, layer_id, role):
        self.linked.append((bundle_id, role))


async def _copy_edges(tmp_path, stored_field_config) -> _CopyDb:
    db = _CopyDb(
        {
            "id": "l-edges",
            "name": "Augsburg Edges",
            "type": "feature",
            "feature_layer_type": "standard",
            "geometry_type": "line",
            "field_config": stored_field_config,
        }
    )
    runner = BundleCreateFilteredRunner.__new__(BundleCreateFilteredRunner)
    runner._export_filtered = lambda layer_id, cql, workdir: str(tmp_path / "x.parquet")
    runner._ingest_to_ducklake = lambda **kwargs: {
        "geometry_type": "LINESTRING",
        "feature_count": 3,
        "size": 10,
    }
    await runner._copy_member(
        db,
        member={"role": "edges", "layer_id": "l-edges"},
        cql_filter={},
        user_id=USER,
        folder_id=FOLDER,
        bundle_id=BUNDLE,
        bundle_name="Augsburg (filtered)",
        spec=get_spec(BundleTypeName.street_network),
        workdir=str(tmp_path),
    )
    return db


async def test_a_copy_of_a_legacy_bundle_gets_the_roles_contract(tmp_path) -> None:
    """The whole point of merging the role's config in: a bundle imported
    before the contract existed has no `field_config` at all, so carrying only
    what the source stores would leave the copy's edges layer with no computed
    length, no locked endpoints and no class vocabulary — uneditable in exactly
    the way its source is."""
    db = await _copy_edges(tmp_path, None)
    assert db.field_config is not None
    assert db.field_config["length_m"]["is_computed"] is True
    assert db.field_config["length_m"]["kind"] == "length"
    assert db.field_config["source_node"]["is_locked"] is True
    assert db.field_config["class"]["default_value"] == "unknown"


async def test_a_copy_keeps_what_the_source_layer_authored(tmp_path) -> None:
    db = await _copy_edges(tmp_path, {"length_m": {"display_config": {"decimals": 2}}})
    assert db.field_config["length_m"]["display_config"] == {"decimals": 2}
    # And still gained the contract.
    assert db.field_config["length_m"]["is_computed"] is True


async def test_a_member_the_filter_empties_keeps_its_source_s_geometry(
    tmp_path,
) -> None:
    """A filter that keeps none of a member's rows leaves no geometry to read
    the type from: the copy is a layer of its source's geometry type, styled
    as its role is."""
    db = _CopyDb(
        {
            "id": "l-edges",
            "name": "Augsburg Edges",
            "type": "feature",
            "feature_layer_type": "standard",
            "geometry_type": "line",
            "field_config": None,
        }
    )
    runner = BundleCreateFilteredRunner.__new__(BundleCreateFilteredRunner)
    runner._export_filtered = lambda layer_id, cql, workdir: str(tmp_path / "x.parquet")
    runner._ingest_to_ducklake = lambda **kwargs: {
        "geometry_column": "geometry",
        "geometry_type": None,
        "feature_count": 0,
        "size": 10,
    }
    copied = await runner._copy_member(
        db,
        member={"role": "edges", "layer_id": "l-edges"},
        cql_filter={"op": "s_intersects"},
        user_id=USER,
        folder_id=FOLDER,
        bundle_id=BUNDLE,
        bundle_name="Augsburg (filtered)",
        spec=get_spec(BundleTypeName.street_network),
        workdir=str(tmp_path),
    )
    assert (db.created["layer_type"], db.created["geometry_type"]) == (
        "feature",
        "line",
    )
    assert db.created["properties"] is not None
    assert copied.geometry_type == "line"
