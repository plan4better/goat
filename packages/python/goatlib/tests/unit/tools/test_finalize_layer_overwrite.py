"""finalize_layer's side of "Overwrite on re-run".

Which layer a re-run writes into is decided by
``goatlib.tools.workflow_export_target`` against the real schema (see
``apps/core/tests/authz/test_workflow_export_target.py``). These tests cover
what finalize does with that answer: authorize first, hold the export lock
around resolve + write, then

- no target        → create a layer and add it to the project,
- ``in_place``     → replace the layer's data, whoever owns it,
- ``adopt``        → the same, and record this workflow as its producer,
- ``copy_on_write``→ create a layer and point the existing entry at it,

stamping every project entry it writes. DuckLake, PMTiles and Postgres are
replaced at the level below finalize's own logic.
"""

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from goatlib.tools import finalize_layer as finalize_module
from goatlib.tools.finalize_layer import (
    FinalizeLayerOutput,
    FinalizeLayerParams,
    FinalizeLayerRunner,
)
from goatlib.tools.workflow_export_target import ExportTarget

USER = "00000000-0000-0000-0000-000000000001"
OTHER_USER = "00000000-0000-0000-0000-000000000002"
WORKFLOW = "00000000-0000-0000-0000-000000000010"
NODE = "tool-00000000-0000-0000-0000-000000000020"
EXPORT_NODE = "export-node-abc"
PROJECT = "00000000-0000-0000-0000-000000000030"
FOLDER = "00000000-0000-0000-0000-000000000040"
PRIOR_LAYER = "00000000-0000-0000-0000-000000000abc"
LINK = 77


def _params(**overrides: Any) -> FinalizeLayerParams:
    kwargs: dict[str, Any] = dict(
        user_id=USER,
        workflow_id=WORKFLOW,
        node_id=NODE,
        project_id=PROJECT,
        folder_id=FOLDER,
        layer_name="My Report",
        overwrite_previous=True,
        export_node_id=EXPORT_NODE,
    )
    kwargs.update(overrides)
    return FinalizeLayerParams(**kwargs)


def _runner() -> FinalizeLayerRunner:
    r = FinalizeLayerRunner()
    settings = MagicMock()
    settings.customer_schema = "customer"
    settings.tiles_data_dir = "/tmp/tiles"
    settings.pmtiles_enabled = False
    r.settings = settings
    return r


def _temp(tmp_path: Path) -> tuple[Path, Path, dict]:
    base = tmp_path / "base"
    base.mkdir()
    parquet = base / "t_x.parquet"
    parquet.write_bytes(b"data")
    return base, parquet, {}


class TestParams:
    def test_defaults(self) -> None:
        p = FinalizeLayerParams(
            user_id=USER,
            workflow_id=WORKFLOW,
            node_id=NODE,
            project_id=PROJECT,
            folder_id=FOLDER,
        )
        assert p.overwrite_previous is False
        assert p.export_node_id is None


class TestProcess:
    """process(): authorize, then resolve and write under the export lock."""

    def _run(
        self,
        tmp_path: Path,
        params: FinalizeLayerParams,
        target: ExportTarget | None,
        events: list[str] | None = None,
    ) -> tuple[str, MagicMock, MagicMock]:
        r = _runner()
        events = events if events is not None else []

        @asynccontextmanager
        async def lock(conn: Any, **kwargs: Any) -> AsyncIterator[None]:
            events.append(f"lock {kwargs['workflow_id']} {kwargs['export_node_id']}")
            yield
            events.append("unlock")

        async def resolve(conn: Any, *args: Any, **kwargs: Any) -> ExportTarget | None:
            events.append("resolve")
            resolved_on.append(conn)
            return target

        def create(*args: Any, **kwargs: Any) -> str:
            events.append("create")
            return "new-layer-id"

        def overwrite(*args: Any, **kwargs: Any) -> str:
            events.append("overwrite")
            return PRIOR_LAYER

        conn = MagicMock()
        conn.close = AsyncMock()
        connect = AsyncMock(return_value=conn)
        pool = _pool()
        resolved_on: list[Any] = []
        self.resolved_on = resolved_on
        self.lock_conn = conn
        with (
            patch.object(r, "_resolve_temp_parquet", return_value=_temp(tmp_path)),
            patch.object(r, "_authorize", new=AsyncMock()),
            patch.object(r, "_connect", new=connect),
            patch.object(r, "get_postgres_pool", new=AsyncMock(return_value=pool)),
            patch.object(finalize_module, "export_lock", lock),
            patch.object(finalize_module, "resolve_export_target", resolve),
            patch.object(r, "_create_new_layer", side_effect=create) as mock_create,
            patch.object(
                r, "_overwrite_in_place", side_effect=overwrite
            ) as mock_overwrite,
        ):
            layer_id = r.process(params)
        # The lock's connection, when one was opened, is always closed.
        assert conn.close.await_count == connect.await_count
        return layer_id, mock_create, mock_overwrite

    def test_refused_run_writes_nothing(self, tmp_path: Path) -> None:
        r = _runner()
        with (
            patch.object(r, "_resolve_temp_parquet", return_value=_temp(tmp_path)),
            patch.object(
                r,
                "_authorize",
                new=AsyncMock(side_effect=ValueError("cannot be saved there")),
            ),
            patch.object(r, "_create_new_layer") as mock_create,
            patch.object(r, "_overwrite_in_place") as mock_overwrite,
        ):
            with pytest.raises(ValueError, match="cannot be saved there"):
                r.process(_params())
        mock_create.assert_not_called()
        mock_overwrite.assert_not_called()

    def test_manual_save_is_authorized_too(self, tmp_path: Path) -> None:
        """The plain "Save" (no export node) also adds a layer to the project."""
        r = _runner()
        with (
            patch.object(r, "_resolve_temp_parquet", return_value=_temp(tmp_path)),
            patch.object(
                r, "_authorize", new=AsyncMock(side_effect=ValueError("refused"))
            ),
            patch.object(r, "_create_new_layer") as mock_create,
        ):
            with pytest.raises(ValueError):
                r.process(_params(overwrite_previous=False, export_node_id=None))
        mock_create.assert_not_called()

    def test_no_target_creates_a_layer(self, tmp_path: Path) -> None:
        layer_id, mock_create, mock_overwrite = self._run(tmp_path, _params(), None)
        assert layer_id == "new-layer-id"
        assert mock_create.call_args.kwargs.get("claim_link_id") is None
        mock_overwrite.assert_not_called()

    @pytest.mark.parametrize("mode", ["in_place", "adopt"])
    def test_own_or_adoptable_layer_is_overwritten(
        self, tmp_path: Path, mode: str
    ) -> None:
        target = ExportTarget(layer_id=PRIOR_LAYER, link_id=LINK, mode=mode)  # type: ignore[arg-type]
        layer_id, mock_create, mock_overwrite = self._run(tmp_path, _params(), target)
        assert layer_id == PRIOR_LAYER
        assert mock_overwrite.call_args.args[-1] == target
        mock_create.assert_not_called()

    def test_inherited_layer_gets_a_new_layer_behind_the_same_entry(
        self, tmp_path: Path
    ) -> None:
        target = ExportTarget(layer_id=PRIOR_LAYER, link_id=LINK, mode="copy_on_write")
        layer_id, mock_create, mock_overwrite = self._run(tmp_path, _params(), target)
        assert layer_id == "new-layer-id"
        assert mock_create.call_args.kwargs["claim_link_id"] == LINK
        mock_overwrite.assert_not_called()

    def test_resolve_and_write_happen_under_the_export_lock(
        self, tmp_path: Path
    ) -> None:
        events: list[str] = []
        target = ExportTarget(layer_id=PRIOR_LAYER, link_id=LINK, mode="in_place")
        self._run(tmp_path, _params(), target, events)
        assert events == [
            f"lock {WORKFLOW} {EXPORT_NODE}",
            "resolve",
            "overwrite",
            "unlock",
        ]

    def test_target_is_resolved_outside_the_lock_transaction(
        self, tmp_path: Path
    ) -> None:
        """Reads in the lock's transaction would hold their table locks for the
        whole export (DuckLake write + tippecanoe), so a migration's ALTER on
        customer.layer would queue behind it and every query behind that."""
        self._run(tmp_path, _params(), None)
        assert self.resolved_on and self.resolved_on[0] is not self.lock_conn

    def test_without_overwrite_nothing_is_looked_up(self, tmp_path: Path) -> None:
        events: list[str] = []
        layer_id, mock_create, _ = self._run(
            tmp_path, _params(overwrite_previous=False), None, events
        )
        assert layer_id == "new-layer-id"
        assert events == ["create"]


def _layer_row(owner: str) -> dict[str, Any]:
    return {
        "id": PRIOR_LAYER,
        "user_id": owner,
        "folder_id": FOLDER,
        "name": "Old Name",
        "type": "feature",
        "data_type": None,
        "feature_layer_type": "tool",
        "feature_layer_geometry_type": "point",
        "other_properties": {},
    }


def _pool(fetchrow_result: Any = None) -> MagicMock:
    pool = MagicMock()
    pool.fetchrow = AsyncMock(return_value=fetchrow_result)
    pool.execute = AsyncMock()
    pool.close = AsyncMock()
    return pool


class TestOverwriteInPlace:
    TABLE_INFO = {
        "table_name": "lake.layers.t_abc",
        "feature_count": 42,
        "size": 1024,
        "geometry_type": "POINT",
        "extent_wkt": "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))",
        "columns": {"id": "VARCHAR", "geometry": "GEOMETRY"},
        "geometry_column": "geometry",
    }

    def _overwrite(
        self,
        tmp_path: Path,
        target: ExportTarget,
        *,
        owner: str = USER,
    ) -> tuple[FinalizeLayerRunner, str, AsyncMock, AsyncMock, AsyncMock]:
        r = _runner()
        parquet = tmp_path / "t_x.parquet"
        parquet.write_bytes(b"parquet")
        claim = AsyncMock()
        restamp = AsyncMock()
        attach = AsyncMock(return_value=88)
        with (
            patch.object(
                r,
                "get_postgres_pool",
                new=AsyncMock(side_effect=lambda: _pool(_layer_row(owner))),
            ),
            patch.object(r, "_replace_ducklake_table", return_value=self.TABLE_INFO),
            patch.object(r, "_delete_old_pmtiles", return_value=True),
            patch.object(r, "_regenerate_pmtiles"),
            patch.object(
                r, "resolve_layer_table_path", return_value="lake.layers.t_abc"
            ),
            patch.object(r, "_get_ducklake_snapshot_id", return_value=None),
            patch.object(r, "_update_layer_metadata", new=AsyncMock()),
            patch.object(r, "_sync_name_and_get_link", new=AsyncMock()),
            patch.object(r, "_get_or_create_project_link", new=attach),
            patch.object(finalize_module, "claim_link", claim),
            patch.object(finalize_module, "restamp_layer", restamp),
        ):
            layer_id = r._overwrite_in_place(_params(), parquet, target)
        return r, layer_id, claim, restamp, attach

    def test_layer_of_another_member_is_overwritten(self, tmp_path: Path) -> None:
        """Case 3: the workflow is the unit; ownership is not the gate."""
        target = ExportTarget(layer_id=PRIOR_LAYER, link_id=LINK, mode="in_place")
        r, layer_id, claim, restamp, _ = self._overwrite(
            tmp_path, target, owner=OTHER_USER
        )
        assert layer_id == PRIOR_LAYER
        assert r._output_info == FinalizeLayerOutput(
            layer_id=PRIOR_LAYER,
            layer_name="My Report",
            project_id=PROJECT,
            layer_project_id=LINK,
            feature_count=42,
            geometry_type="point",
            overwritten=True,
        )
        claim.assert_awaited_once()
        assert claim.call_args.kwargs == {
            "project_id": PROJECT,
            "link_id": LINK,
            "layer_id": PRIOR_LAYER,
            "workflow_id": WORKFLOW,
            "export_node_id": EXPORT_NODE,
        }
        restamp.assert_not_awaited()

    def test_adopted_layer_records_this_workflow(self, tmp_path: Path) -> None:
        target = ExportTarget(layer_id=PRIOR_LAYER, link_id=LINK, mode="adopt")
        _, _, _, restamp, _ = self._overwrite(tmp_path, target)
        restamp.assert_awaited_once()
        assert restamp.call_args.kwargs == {
            "layer_id": PRIOR_LAYER,
            "workflow_id": WORKFLOW,
            "export_node_id": EXPORT_NODE,
        }

    def test_layer_not_in_the_project_is_attached_and_stamped(
        self, tmp_path: Path
    ) -> None:
        target = ExportTarget(layer_id=PRIOR_LAYER, link_id=None, mode="in_place")
        r, _, claim, _, attach = self._overwrite(tmp_path, target)
        attach.assert_awaited_once()
        assert claim.call_args.kwargs["link_id"] == 88
        assert r._output_info.layer_project_id == 88


class TestCreateNewLayer:
    STAMP = {
        "workflow_export": {"workflow_id": WORKFLOW, "export_node_id": EXPORT_NODE}
    }

    def _create(
        self,
        tmp_path: Path,
        params: FinalizeLayerParams,
        claim_link_id: int | None,
        *,
        claim_error: Exception | None = None,
    ) -> dict[str, Any]:
        r = _runner()
        parquet = tmp_path / "t_x.parquet"
        parquet.write_bytes(b"x")
        con = MagicMock()
        con.execute.return_value.fetchall.return_value = [
            ("id", "VARCHAR"),
            ("geometry", "GEOMETRY"),
        ]
        con.execute.return_value.fetchone.return_value = (1,)
        r._duckdb_con = con

        db = MagicMock()
        db.get_project_folder_id = AsyncMock(return_value=FOLDER)
        db.create_layer = AsyncMock(return_value={"style": "x"})
        db.add_to_project = AsyncMock(return_value=99)
        services: list[Any] = []

        def service(pool_or_conn: Any, schema: str) -> MagicMock:
            services.append(pool_or_conn)
            return db

        # The pool hands out one connection; its transaction records how it
        # ended, which is what makes create + claim all or nothing.
        tx_exits: list[Any] = []
        conn = MagicMock(name="conn")

        @asynccontextmanager
        async def transaction() -> AsyncIterator[None]:
            try:
                yield
            except BaseException as exc:
                tx_exits.append(exc)
                raise
            tx_exits.append(None)

        conn.transaction = transaction

        @asynccontextmanager
        async def acquire() -> AsyncIterator[Any]:
            yield conn

        pool = _pool()
        pool.acquire = acquire
        claim = AsyncMock(side_effect=claim_error)
        retarget = AsyncMock()
        # The entry was made for a table: it is styled for the new layer.
        needs_style = AsyncMock(return_value=True)
        style = AsyncMock()
        outcome: dict[str, Any] = {}
        with (
            patch("goatlib.tools.db.ToolDatabaseService", side_effect=service),
            patch.object(r, "get_postgres_pool", new=AsyncMock(return_value=pool)),
            patch.object(r, "_get_ducklake_snapshot_id", return_value=None),
            patch.object(r, "_sync_name_and_get_link", new=AsyncMock()),
            patch.object(finalize_module, "claim_link", claim),
            patch.object(finalize_module, "retarget_dataset_nodes", retarget),
            patch.object(finalize_module, "entry_needs_feature_style", needs_style),
            patch.object(finalize_module, "style_entries_as_feature_layer", style),
        ):
            try:
                outcome["layer_id"] = r._create_new_layer(
                    params,
                    parquet,
                    metadata={"geometry_type": "POINT"},
                    claim_link_id=claim_link_id,
                )
            except Exception as exc:
                outcome["error"] = exc
        outcome.update(
            db=db,
            claim=claim,
            retarget=retarget,
            style=style,
            conn=conn,
            pool=pool,
            services=services,
            tx_exits=tx_exits,
        )
        return outcome

    def test_new_layer_and_its_stamped_entry_are_created(self, tmp_path: Path) -> None:
        out = self._create(tmp_path, _params(), None)
        assert out["db"].create_layer.call_args.kwargs["other_properties"] == self.STAMP
        assert (
            out["db"].add_to_project.call_args.kwargs["other_properties"] == self.STAMP
        )
        out["claim"].assert_not_awaited()
        out["pool"].close.assert_awaited()

    def test_copy_on_write_points_the_existing_entry_at_the_new_layer(
        self, tmp_path: Path
    ) -> None:
        out = self._create(tmp_path, _params(), LINK)
        layer_id = out["layer_id"]
        out["db"].add_to_project.assert_not_awaited()
        assert out["claim"].call_args.args[0] is out["conn"]
        assert out["claim"].call_args.kwargs == {
            "project_id": PROJECT,
            "link_id": LINK,
            "layer_id": layer_id,
            "workflow_id": WORKFLOW,
            "export_node_id": EXPORT_NODE,
        }
        assert out["retarget"].call_args.args[0] is out["conn"]
        assert out["retarget"].call_args.kwargs == {
            "project_id": PROJECT,
            "link_id": LINK,
            "layer_id": layer_id,
        }
        assert out["services"] == [
            out["conn"]
        ], "layer row written on the same connection"
        assert out["style"].call_args.args[0] is out["conn"]
        assert out["style"].call_args.args[2] == layer_id
        assert out["style"].call_args.kwargs == {"link_id": LINK}
        assert out["tx_exits"] == [None]

    def test_copy_on_write_failing_to_claim_the_entry_keeps_no_layer(
        self, tmp_path: Path
    ) -> None:
        """Creating the layer and repointing the entry commit together, so a
        failure in between cannot leave a layer no project shows."""
        boom = OSError("connection lost")
        out = self._create(tmp_path, _params(), LINK, claim_error=boom)
        assert out["error"] is boom
        out["db"].create_layer.assert_awaited_once()
        assert out["tx_exits"] == [boom]

    def test_manual_save_is_not_stamped(self, tmp_path: Path) -> None:
        out = self._create(
            tmp_path, _params(overwrite_previous=False, export_node_id=None), None
        )
        assert out["db"].create_layer.call_args.kwargs["other_properties"] is None
        assert out["db"].add_to_project.call_args.kwargs["other_properties"] is None
        out["claim"].assert_not_awaited()


class TestMainSignature:
    """main() is what Windmill calls; the runner passes these by name."""

    def test_main_accepts_overwrite_fields(self) -> None:
        import inspect

        from goatlib.tools.finalize_layer import main

        sig = inspect.signature(main)
        assert sig.parameters["overwrite_previous"].default is False
        assert sig.parameters["export_node_id"].default is None
