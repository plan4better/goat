"""A run that fails after writing a new layer's table drops that table again.

A tool writes its result table (`t_<layer id>`) before it saves the layer
record. A failure in between used to leave the table in DuckLake with nothing
pointing at it. These tests run the real ingest against an in-memory `lake`
and replace only Postgres: the record step, and the question "does a layer row
carry this id", which the runner asks before it drops anything.
"""

from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator
from unittest.mock import AsyncMock, MagicMock, patch

import duckdb
import pytest
from goatlib.models.io import ConversionReport, ConvertedDataset, DatasetMetadata
from goatlib.tools import base as base_module
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import ToolInputBase
from goatlib.utils.layer import layer_id_to_table_name

USER = "11111111-1111-1111-1111-111111111111"
FOLDER = "22222222-2222-2222-2222-222222222222"
PROJECT = "33333333-3333-3333-3333-333333333333"
EXISTING = "44444444-4444-4444-4444-444444444444"


@pytest.fixture
def con() -> Iterator[duckdb.DuckDBPyConnection]:
    con = duckdb.connect()
    con.execute("ATTACH ':memory:' AS lake")
    yield con
    con.close()


def _parquet(tmp_path: Path, name: str = "out") -> Path:
    path = tmp_path / f"{name}.parquet"
    duckdb.connect().execute(
        f"COPY (SELECT 1 AS id, 'a' AS label) TO '{path}' (FORMAT PARQUET)"
    )
    return path


def _lake_tables(con: duckdb.DuckDBPyConnection) -> set[str]:
    return {
        row[0]
        for row in con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_catalog = 'lake'"
        ).fetchall()
    }


class _Records:
    """The layer rows Postgres would hold: written by the fake record step,
    read by the runner's check before it drops a table."""

    def __init__(self, fail_for: int | None = None, error: Exception | None = None):
        self.ids: set[str] = set()
        self.calls = 0
        self.fail_for = fail_for
        self.error = error or ValueError(
            "folder_id is required, or project_id must be provided to derive it"
        )

    async def create(self, *, output_layer_id: str, **_: Any) -> dict[str, Any]:
        self.calls += 1
        if self.calls == self.fail_for:
            raise self.error
        self.ids.add(output_layer_id)
        return {"folder_id": FOLDER, "layer_project_id": None}

    def recorded(self, layer_ids: list[str]) -> set[str]:
        return {i for i in layer_ids if i in self.ids}


def _wire(runner: Any, con: duckdb.DuckDBPyConnection, records: _Records) -> None:
    runner.settings = MagicMock(customer_schema="customer", pmtiles_enabled=False)
    runner._duckdb_con = con

    async def _noop() -> None:
        return None

    runner._init_db_service = _noop
    runner._close_db_service = _noop
    runner._create_db_records = records.create
    runner._recorded_layer_ids = records.recorded


class _Runner(BaseToolRunner[ToolInputBase]):
    tool_class = object
    output_geometry_type = None
    default_output_name = "Result"

    def __init__(self, tmp_path: Path) -> None:
        super().__init__()
        self.tmp_path = tmp_path

    def process(
        self, params: ToolInputBase, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        path = _parquet(temp_dir)
        return path, DatasetMetadata(path=str(path), source_type="tabular")


class TestBaseRun:
    def test_a_run_failing_at_the_save_step_drops_its_table(
        self, con: duckdb.DuckDBPyConnection, tmp_path: Path
    ) -> None:
        """The case seen on a dev machine: no folder to save into."""
        runner = _Runner(tmp_path)
        records = _Records(fail_for=1)
        _wire(runner, con, records)

        with pytest.raises(ValueError, match="folder_id is required"):
            runner.run(ToolInputBase(user_id=USER))

        assert _lake_tables(con) == set()

    def test_a_run_failing_after_its_record_exists_keeps_the_table(
        self, con: duckdb.DuckDBPyConnection, tmp_path: Path
    ) -> None:
        """The layer row was written before the failure: it points at the
        table, so the table is the layer's data now."""
        runner = _Runner(tmp_path)
        records = _Records()
        _wire(runner, con, records)

        async def create_then_fail(**kwargs: Any) -> dict[str, Any]:
            await records.create(**kwargs)
            raise RuntimeError("could not add the layer to the project")

        runner._create_db_records = create_then_fail

        with pytest.raises(RuntimeError, match="could not add"):
            runner.run(ToolInputBase(user_id=USER, project_id=PROJECT))

        (layer_id,) = records.ids
        assert _lake_tables(con) == {layer_id_to_table_name(layer_id)}

    def test_a_successful_run_keeps_its_table(
        self, con: duckdb.DuckDBPyConnection, tmp_path: Path
    ) -> None:
        runner = _Runner(tmp_path)
        records = _Records()
        _wire(runner, con, records)

        result = runner.run(ToolInputBase(user_id=USER, folder_id=FOLDER))

        assert _lake_tables(con) == {layer_id_to_table_name(result["layer_id"])}

    def test_a_table_the_run_did_not_create_is_never_dropped(
        self, con: duckdb.DuckDBPyConnection, tmp_path: Path
    ) -> None:
        """A table already under the run's name (an existing layer's, however
        it got there) makes the CREATE fail; the run must leave it alone even
        though no layer row is found for it."""
        existing = layer_id_to_table_name(EXISTING)
        con.execute(f"CREATE TABLE lake.main.{existing} AS SELECT 42 AS answer")
        runner = _Runner(tmp_path)
        records = _Records()
        _wire(runner, con, records)

        with (
            patch.object(base_module.uuid_module, "uuid4", return_value=EXISTING),
            pytest.raises(duckdb.CatalogException),
        ):
            runner.run(ToolInputBase(user_id=USER, folder_id=FOLDER))

        assert _lake_tables(con) == {existing}
        assert con.execute(f"SELECT answer FROM lake.main.{existing}").fetchall() == [
            (42,)
        ]

    def test_a_lost_connection_at_the_save_step_keeps_the_table(
        self, con: duckdb.DuckDBPyConnection, tmp_path: Path
    ) -> None:
        """The record's commit may have gone through without its reply, and
        may only turn visible later (a synchronous replica): no row found now
        proves nothing, so the table stays for the orphan-tables task."""
        runner = _Runner(tmp_path)
        records = _Records(fail_for=1, error=ConnectionResetError("reset by peer"))
        _wire(runner, con, records)

        with pytest.raises(ConnectionResetError):
            runner.run(ToolInputBase(user_id=USER, folder_id=FOLDER))

        assert len(_lake_tables(con)) == 1

    def test_a_table_stays_when_postgres_cannot_be_asked(
        self, con: duckdb.DuckDBPyConnection, tmp_path: Path
    ) -> None:
        """Without an answer the record may exist: keep the table for the
        orphan-tables task rather than risk a layer without data."""
        runner = _Runner(tmp_path)
        records = _Records(fail_for=1)
        _wire(runner, con, records)

        def unreachable(layer_ids: list[str]) -> set[str]:
            raise OSError("connection refused")

        runner._recorded_layer_ids = unreachable

        with pytest.raises(ValueError, match="folder_id is required"):
            runner.run(ToolInputBase(user_id=USER))

        assert len(_lake_tables(con)) == 1


class TestMultiOutputRun:
    def test_the_second_output_failing_drops_only_its_own_table(
        self, con: duckdb.DuckDBPyConnection, tmp_path: Path
    ) -> None:
        """Catchment area writes the polygons and the starting points, then
        records them one after the other."""
        from goatlib.tools.catchment_area import CatchmentAreaToolRunner

        runner = CatchmentAreaToolRunner()
        records = _Records(fail_for=2)
        _wire(runner, con, records)
        polygons = _parquet(tmp_path, "polygons")
        points = _parquet(tmp_path, "points")

        def process(params: Any, temp_dir: Path) -> tuple[Path, DatasetMetadata]:
            runner._starting_points_parquet = points
            return polygons, DatasetMetadata(path=str(polygons), source_type="tabular")

        runner.process = process
        params = SimpleNamespace(
            user_id=USER,
            folder_id=FOLDER,
            project_id=None,
            result_layer_name=None,
            output_name=None,
            starting_points_layer_name=None,
            temp_mode=False,
            triggered_by_email=None,
        )

        with pytest.raises(ValueError):
            runner.run(params)  # type: ignore[arg-type]

        (polygon_layer,) = records.ids
        assert _lake_tables(con) == {layer_id_to_table_name(polygon_layer)}


class TestLayerImport:
    def test_a_dataset_failing_at_its_record_loses_its_table_not_the_others(
        self, con: duckdb.DuckDBPyConnection, tmp_path: Path
    ) -> None:
        """One upload, three datasets, the second cannot be recorded: the job
        still succeeds with two layers, and the second table is gone."""
        from goatlib.tools.layer_import import LayerImportParams, LayerImportRunner

        runner = LayerImportRunner()
        records = _Records(fail_for=2)
        _wire(runner, con, records)
        datasets = [
            ConvertedDataset(
                source=f"/tmp/city.gpkg::{name}",
                name=name,
                path=str(_parquet(tmp_path, name)),
                metadata=DatasetMetadata(path=name, source_type="tabular"),
            )
            for name in ("roads", "stops", "rail")
        ]
        runner._convert_upload = lambda params, temp_dir: ConversionReport(
            outputs=datasets
        )

        result = runner.run(
            LayerImportParams(user_id=USER, folder_id=FOLDER, s3_key="u/city.gpkg")
        )

        assert [layer["name"] for layer in result["imported"]] == ["roads", "rail"]
        assert result["skipped"][0]["name"] == "stops"
        assert _lake_tables(con) == {layer_id_to_table_name(i) for i in records.ids}
        assert len(records.ids) == 2


class TestFinalizeLayer:
    def test_saving_a_workflow_result_that_fails_drops_the_new_table(
        self, con: duckdb.DuckDBPyConnection, tmp_path: Path
    ) -> None:
        from goatlib.tools.finalize_layer import (
            FinalizeLayerParams,
            FinalizeLayerRunner,
        )

        runner = FinalizeLayerRunner()
        records = _Records()
        _wire(runner, con, records)
        base = tmp_path / "temp"
        base.mkdir()
        _parquet(base, "t_preview")

        with (
            patch.object(runner, "get_temp_base_path", return_value=base),
            patch.object(runner, "_authorize", new=AsyncMock()),
            patch.object(runner, "_get_ducklake_snapshot_id", return_value=None),
            patch.object(
                runner,
                "get_postgres_pool",
                new=AsyncMock(side_effect=OSError("db down")),
            ),
            pytest.raises(OSError, match="db down"),
        ):
            runner.run(
                FinalizeLayerParams(
                    user_id=USER,
                    workflow_id="55555555-5555-5555-5555-555555555555",
                    node_id="n1",
                    project_id=PROJECT,
                    folder_id=FOLDER,
                )
            )

        assert _lake_tables(con) == set()


class TestBundleCreateFiltered:
    async def test_a_member_failing_after_its_ingest_is_rolled_back(
        self, tmp_path: Path
    ) -> None:
        """`_rollback_bundle` only knows the members that finished, so a
        member failing between its ingest and its bundle link cleans up
        after itself."""
        from goatlib.models.bundle import BundleTypeName, get_spec
        from goatlib.tools.bundle_create_filtered import BundleCreateFilteredRunner

        runner = BundleCreateFilteredRunner.__new__(BundleCreateFilteredRunner)
        runner._export_filtered = lambda layer_id, cql, workdir: str(
            tmp_path / "x.parquet"
        )
        ingested: list[str] = []

        def ingest(*, user_id: str, layer_id: str, parquet_path: Path) -> dict:
            ingested.append(layer_id)
            return {"geometry_type": "LINESTRING", "feature_count": 3, "size": 10}

        runner._ingest_to_ducklake = ingest
        runner._cleanup_layers = AsyncMock()
        db = MagicMock()
        db.get_layer_info = AsyncMock(
            return_value={"type": "feature", "geometry_type": "line", "name": "E"}
        )
        db.create_layer = AsyncMock()
        db.set_layer_field_config = AsyncMock()
        db.add_layer_to_bundle = AsyncMock(side_effect=RuntimeError("link failed"))

        with pytest.raises(RuntimeError, match="link failed"):
            await runner._copy_member(
                db,
                member={"role": "edges", "layer_id": "l-edges"},
                cql_filter={},
                user_id=USER,
                folder_id=FOLDER,
                bundle_id="b1",
                bundle_name="Augsburg (filtered)",
                spec=get_spec(BundleTypeName.street_network),
                workdir=str(tmp_path),
            )

        runner._cleanup_layers.assert_awaited_once_with(db, USER, ingested)


def test_every_runner_that_writes_layer_tables_drops_them_on_failure() -> None:
    """A new runner that overrides `run` has to keep the guard, or its failed
    runs leave their tables behind again."""
    from goatlib.tools.finalize_layer import FinalizeLayerRunner
    from goatlib.tools.project_import import ProjectImportRunner
    from goatlib.tools.registry import TOOL_REGISTRY

    runners = {FinalizeLayerRunner, ProjectImportRunner}
    for tool in TOOL_REGISTRY:
        cls = tool.get_runner_class()
        if cls is not None and issubclass(cls, BaseToolRunner):
            runners.add(cls)

    unguarded = sorted(
        cls.__name__
        for cls in runners
        if not getattr(cls.run, "drops_unrecorded_tables", False)
    )
    assert unguarded == []
