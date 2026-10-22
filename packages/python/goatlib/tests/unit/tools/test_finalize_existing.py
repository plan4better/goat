""" "Save as dataset" set to an existing dataset: finalize_layer's
``target_layer_id`` path.

Rights, lock and order are finalize's own logic here; the column plan and the
SQL append are covered in ``test_append_rows.py``, so they are replaced at the
level below (``_append_rows_into``), like DuckLake, PMTiles and Postgres.
"""

from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from goatlib.tools.append_rows import AppendError
from goatlib.tools.finalize_layer import (
    FinalizeLayerOutput,
    FinalizeLayerParams,
    FinalizeLayerRunner,
)

USER = "00000000-0000-0000-0000-000000000001"
OWNER = "00000000-0000-0000-0000-000000000002"
WORKFLOW = "00000000-0000-0000-0000-000000000010"
PROJECT = "00000000-0000-0000-0000-000000000030"
TARGET = "00000000-0000-0000-0000-000000000abc"


def _params(**overrides: Any) -> FinalizeLayerParams:
    kwargs: dict[str, Any] = dict(
        user_id=USER,
        workflow_id=WORKFLOW,
        node_id="tool-1",
        export_node_id="export-1",
        project_id=PROJECT,
        target_layer_id=TARGET,
    )
    kwargs.update(overrides)
    return FinalizeLayerParams(**kwargs)


def _target(**overrides: Any) -> dict[str, Any]:
    t: dict[str, Any] = dict(
        id=TARGET,
        user_id=OWNER,
        name="Monitoring",
        type="feature",
        geometry_type="point",
        field_config={"nr": {"kind": "serial"}},
        size=100,
        deleted=False,
        write_allowed=True,
    )
    t.update(overrides)
    return t


class _Harness:
    """A runner with everything below its own logic replaced, and a log of
    the order things happened in."""

    def __init__(self, tmp_path: Path, targets: list[dict[str, Any] | None]) -> None:
        self.log: list[str] = []
        self.runner = FinalizeLayerRunner()
        self.runner.settings = MagicMock()
        parquet = tmp_path / "t_x.parquet"
        parquet.write_bytes(b"data")
        log = self.log
        queue = list(targets)

        async def target(params: FinalizeLayerParams) -> dict[str, Any] | None:
            log.append("target")
            return queue.pop(0) if len(queue) > 1 else queue[0]

        @contextmanager
        def lock(layer_id: str) -> Iterator[None]:
            log.append("lock")
            try:
                yield "lock-conn"
            finally:
                log.append("unlock")

        self.rows = 3
        self.refresh_error: Exception | None = None
        self.link_error: Exception | None = None

        def append(**kw: Any) -> int:
            log.append("append")
            self.append_kwargs = kw
            if kw.get("counters") is not None and self.rows:
                kw["counters"].record("nr", 12)
            return self.rows

        def refresh(**kw: Any) -> None:
            log.append("refresh")
            if self.refresh_error:
                raise self.refresh_error

        self.patches = [
            patch.object(
                self.runner,
                "_resolve_temp_parquet",
                return_value=(tmp_path, parquet, {}),
            ),
            patch.object(
                self.runner,
                "_authorize",
                new_callable=AsyncMock,
                side_effect=lambda p: log.append("authorize"),
            ),
            patch.object(self.runner, "_existing_target", side_effect=target),
            patch.object(self.runner, "_layer_write_lock", side_effect=lock),
            patch.object(self.runner, "_append_rows_into", side_effect=append),
            patch.object(self.runner, "_refresh_existing", side_effect=refresh),
            patch.object(self.runner, "_create_new_layer", side_effect=AssertionError),
            patch.object(
                self.runner, "_export_with_overwrite", side_effect=AssertionError
            ),
            patch.object(
                self.runner,
                "_read_marks",
                new_callable=AsyncMock,
                side_effect=lambda conn, layer_id, names: log.append("marks")
                or {"nr": 9},
            ),
            patch.object(
                self.runner,
                "_advance_marks",
                new_callable=AsyncMock,
                side_effect=lambda conn, layer_id, assigned: log.append(
                    f"advance {assigned}"
                ),
            ),
            patch.object(
                self.runner,
                "_ensure_project_link",
                new_callable=AsyncMock,
                side_effect=lambda params, name: (
                    log.append("link") or self._raise(self.link_error)
                ),
            ),
        ]

    @staticmethod
    def _raise(error: Exception | None) -> None:
        if error:
            raise error

    def run(self, params: FinalizeLayerParams) -> FinalizeLayerOutput:
        for p in self.patches:
            p.start()
        try:
            return self.runner.run(params)
        finally:
            for p in self.patches:
                p.stop()


def test_appends_in_order_and_reports(tmp_path: Path) -> None:
    h = _Harness(tmp_path, [_target()])
    out = h.run(_params())
    assert h.log == [
        "authorize",
        "target",
        "lock",
        "target",
        "marks",
        "append",
        "advance {'nr': 12}",
        "unlock",
        "refresh",
        "link",
    ]
    assert h.append_kwargs["counters"].high_water == {"nr": 9}
    assert out.layer_id == TARGET
    assert out.layer_name == "Monitoring"
    assert out.rows_appended == 3


def test_fails_without_write_right_and_writes_nothing(tmp_path: Path) -> None:
    # The editor keeps such a run from starting (validation); this is the net
    # for rights taken away in between. Nothing is locked, written or linked.
    h = _Harness(tmp_path, [_target(write_allowed=False)])
    with pytest.raises(AppendError, match="no edit rights on Monitoring"):
        h.run(_params())
    assert not {"lock", "append", "refresh", "link"} & set(h.log)


def test_missing_target_fails_too(tmp_path: Path) -> None:
    # Gone for good, or never visible to the runner: nothing tells the two
    # apart without revealing a layer, so both get one message.
    h = _Harness(tmp_path, [None])
    with pytest.raises(AppendError, match="not found, or you have no edit rights"):
        h.run(_params())
    assert "append" not in h.log


def test_no_rights_on_a_trashed_target_reveals_nothing(tmp_path: Path) -> None:
    h = _Harness(tmp_path, [_target(deleted=True, write_allowed=False)])
    with pytest.raises(AppendError, match="no edit rights on Monitoring"):
        h.run(_params())


def test_trashed_target_fails_for_someone_who_may_edit_it(tmp_path: Path) -> None:
    h = _Harness(tmp_path, [_target(deleted=True, write_allowed=True)])
    with pytest.raises(AppendError, match="no longer exists"):
        h.run(_params())
    assert "append" not in h.log


def test_refresh_failure_after_the_rows_are_in_still_reports_them(
    tmp_path: Path,
) -> None:
    # The rows are committed; failing the step now would make a re-run add
    # them twice. The refresh is logged and retried by the next write.
    h = _Harness(tmp_path, [_target()])
    h.refresh_error = RuntimeError("tippecanoe crashed")
    out = h.run(_params())
    assert out.rows_appended == 3


def test_project_link_failure_after_the_rows_are_in_still_reports_them(
    tmp_path: Path,
) -> None:
    h = _Harness(tmp_path, [_target()])
    h.link_error = RuntimeError("db hiccup")
    out = h.run(_params())
    assert out.rows_appended == 3


def test_zero_rows_skip_the_tile_refresh(tmp_path: Path) -> None:
    h = _Harness(tmp_path, [_target()])
    h.rows = 0
    out = h.run(_params())
    assert out.rows_appended == 0
    assert "refresh" not in h.log


def test_refuses_target_trashed_after_lock(tmp_path: Path) -> None:
    h = _Harness(tmp_path, [_target(), _target(deleted=True)])
    with pytest.raises(AppendError, match="no longer exists"):
        h.run(_params())
    assert "append" not in h.log
    assert h.log[-1] == "unlock"


def test_refuses_raster_target(tmp_path: Path) -> None:
    h = _Harness(tmp_path, [_target(type="raster")])
    with pytest.raises(AppendError, match="feature layer or a table"):
        h.run(_params())
    assert "append" not in h.log



def test_add_to_project_off_leaves_project_alone(tmp_path: Path) -> None:
    h = _Harness(tmp_path, [_target()])
    h.run(_params(add_to_project=False))
    assert "link" not in h.log


def test_project_link_shareable_only_with_share_right() -> None:
    # D7: a layer the runner may not share must not travel with the project.
    import asyncio

    runner = FinalizeLayerRunner()
    runner.settings = MagicMock()
    runner.settings.customer_schema = "customer"
    pool = MagicMock()
    pool.fetchrow = AsyncMock(side_effect=[None, {"id": 7}])
    pool.execute = AsyncMock()
    pool.close = AsyncMock()
    with patch.object(runner, "get_postgres_pool", new=AsyncMock(return_value=pool)):
        asyncio.run(runner._ensure_project_link(_params(), "Monitoring"))
    insert_sql = pool.fetchrow.call_args_list[1].args[0]
    assert "shareable" in insert_sql
    assert "customer.layer_is_catalog" in insert_sql
    assert "customer.can('layer'" in insert_sql
    assert pool.execute.await_count == 1  # layer_order updated


def test_existing_project_link_is_kept() -> None:
    import asyncio

    runner = FinalizeLayerRunner()
    runner.settings = MagicMock()
    runner.settings.customer_schema = "customer"
    pool = MagicMock()
    pool.fetchrow = AsyncMock(return_value={"id": 3})
    pool.execute = AsyncMock()
    pool.close = AsyncMock()
    with patch.object(runner, "get_postgres_pool", new=AsyncMock(return_value=pool)):
        asyncio.run(runner._ensure_project_link(_params(), "Monitoring"))
    assert pool.fetchrow.await_count == 1
    assert pool.execute.await_count == 0


def test_no_separate_append_script_is_synced() -> None:
    # Adding to an existing dataset is part of "Save as dataset"
    # (finalize_layer), not a tool or Windmill script of its own.
    from goatlib.tools.registry import get_tool
    from goatlib.tools.sync_windmill import WindmillSyncer

    assert get_tool("layer_append") is None
    syncer = WindmillSyncer(base_url="http://windmill", token="t")
    paths = [r["path"] for r in syncer.sync_workflow_scripts(dry_run=True)]
    assert "f/goat/tools/layer_append" not in paths
    assert "f/goat/tools/finalize_layer" in paths


def test_existing_dataset_is_never_marked_as_this_exports_result(
    tmp_path: Path,
) -> None:
    # "Overwrite on re-run" finds what it may replace by the workflow_export
    # stamp on a layer or its project entry. Adding rows to an existing
    # dataset must never set that stamp, so a later "New" run of the same
    # node with overwrite on cannot replace the shared dataset.
    h = _Harness(tmp_path, [_target()])
    h.patches += [
        patch.object(h.runner, "_claim", side_effect=AssertionError("stamped")),
        patch.object(h.runner, "_restamp", side_effect=AssertionError("stamped")),
    ]
    h.run(_params())


def test_project_entry_for_the_target_carries_no_export_stamp() -> None:
    import asyncio

    runner = FinalizeLayerRunner()
    runner.settings = MagicMock()
    runner.settings.customer_schema = "customer"
    pool = MagicMock()
    pool.fetchrow = AsyncMock(side_effect=[None, {"id": 7}])
    pool.execute = AsyncMock()
    pool.close = AsyncMock()
    with patch.object(runner, "get_postgres_pool", new=AsyncMock(return_value=pool)):
        asyncio.run(runner._ensure_project_link(_params(), "Monitoring"))
    insert_sql = pool.fetchrow.call_args_list[1].args[0]
    assert "other_properties" not in insert_sql
    assert "workflow_export" not in insert_sql


def test_adding_the_target_uses_finalizes_own_link_helper() -> None:
    # One way to add a layer to a project: the export's own helper, told to
    # mark the entry shareable only if the runner may share the layer (D7).
    import asyncio

    runner = FinalizeLayerRunner()
    runner.settings = MagicMock()
    with patch.object(
        runner, "_get_or_create_project_link", new=AsyncMock(return_value=7)
    ) as link:
        asyncio.run(runner._ensure_project_link(_params(), "Monitoring"))
    link.assert_awaited_once_with(
        layer_id=TARGET, project_id=PROJECT, name="Monitoring", shareable_for=USER
    )


def test_new_dataset_links_stay_shareable_as_before() -> None:
    # Without shareable_for the helper inserts exactly as it did.
    import asyncio

    runner = FinalizeLayerRunner()
    runner.settings = MagicMock()
    runner.settings.customer_schema = "customer"
    pool = MagicMock()
    pool.fetchrow = AsyncMock(side_effect=[None, {"id": 5}])
    pool.execute = AsyncMock()
    pool.close = AsyncMock()
    with patch.object(runner, "get_postgres_pool", new=AsyncMock(return_value=pool)):
        asyncio.run(runner._get_or_create_project_link(TARGET, PROJECT, "Result"))
    insert_sql = pool.fetchrow.call_args_list[1].args[0]
    assert "shareable" not in insert_sql
