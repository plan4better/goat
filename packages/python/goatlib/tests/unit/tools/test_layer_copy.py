"""``layer_copy``: a project's own editable copy of a layer it shows.

The table copy runs against a real in-memory DuckDB with a ``lake`` catalog
attached, the way ``project_import``'s tests do. The run's Postgres side is
replaced at the level of this module's own SQL functions, which are tested
against core's real schema in
``apps/core/tests/authz/test_template_copy.py`` (entry swap, dataset nodes,
dashboard references, access afterwards).
"""

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from goatlib.tools import layer_copy as module
from goatlib.tools.codegen import generate_windmill_script
from goatlib.tools.layer_copy import (
    COPY_STAMP,
    CopyPlan,
    LayerCopyParams,
    LayerCopyRunner,
    copy_other_properties,
    copy_select_list,
)
from goatlib.tools.registry import get_tool
from pydantic import ValidationError

USER = "00000000-0000-0000-0000-000000000001"
PROJECT = "00000000-0000-0000-0000-000000000030"
FOLDER = "00000000-0000-0000-0000-000000000040"
SPACE = "00000000-0000-0000-0000-000000000050"
SOURCE = "0f0e8a4c-5d1f-4c1b-9a51-0d8f2c7e4a10"
TEMPLATE = "3b0c6a2e-5d1f-4c1b-9a51-0d8f2c7e4a10"
SOURCE_TABLE = "lake.main.t_source"


def _params(**overrides: Any) -> LayerCopyParams:
    kwargs: dict[str, Any] = dict(
        user_id=USER,
        source_layer_id=SOURCE,
        project_id=PROJECT,
        layer_project_ids=[11, 12],
        copy_content=True,
        template_id=TEMPLATE,
    )
    kwargs.update(overrides)
    return LayerCopyParams(**kwargs)


@pytest.fixture
def con() -> Any:
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    con.execute("ATTACH ':memory:' AS lake")
    con.execute(
        f"""
        CREATE TABLE {SOURCE_TABLE} AS
        SELECT * FROM (VALUES
            ('Neubau Nord', 120, ST_Point(7.10, 50.73)),
            ('Neubau Süd', 80, ST_Point(7.12, 50.70))
        ) AS t(name, units, geometry)
        """
    )
    # A stray bounding-box copy, as older data carries (goatlib.io.bbox_columns).
    con.execute(
        f"ALTER TABLE {SOURCE_TABLE} ADD COLUMN bbox_1 "
        "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)"
    )
    yield con
    con.close()


def _runner(con: Any = None) -> LayerCopyRunner:
    runner = LayerCopyRunner()
    settings = MagicMock()
    settings.customer_schema = "customer"
    settings.pmtiles_enabled = False
    runner.settings = settings
    if con is not None:
        runner._duckdb_con = con
    return runner


def _columns(con: Any, table: str) -> dict[str, str]:
    return {row[0]: row[1] for row in con.execute(f"DESCRIBE {table}").fetchall()}


def _copy(
    con: Any,
    *,
    copy_content: bool,
    layer_id: str = "11111111-1111-1111-1111-111111111111",
) -> tuple[dict[str, Any], str]:
    runner = _runner(con)
    with patch.object(runner, "resolve_layer_table_path", return_value=SOURCE_TABLE):
        info = runner._copy_table(SOURCE, layer_id, copy_content)
    return info, runner.get_layer_table_path(layer_id)


class TestCopyTable:
    def test_a_full_copy_has_every_row_and_column(self, con: Any) -> None:
        info, table = _copy(con, copy_content=True)

        assert info["feature_count"] == 2
        assert info["geometry_type"] == "POINT"
        assert info["extent_wkt"] is not None
        columns = _columns(con, table)
        assert list(columns) == ["name", "units", "geometry"]
        assert columns["geometry"].startswith("GEOMETRY")
        assert con.execute(
            f"SELECT name, units, ST_AsText(geometry) FROM {table} ORDER BY name"
        ).fetchall() == [
            ("Neubau Nord", 120, "POINT (7.1 50.73)"),
            ("Neubau Süd", 80, "POINT (7.12 50.7)"),
        ]

    def test_an_empty_copy_keeps_the_columns_and_the_geometry_type(
        self, con: Any
    ) -> None:
        """The layer users enter their own planning into: no rows, but a
        GEOMETRY column, so drawing into it works (a parquet round trip would
        have turned it into BLOB)."""
        info, table = _copy(con, copy_content=False)

        assert info["feature_count"] == 0
        assert info["extent_wkt"] is None
        columns = _columns(con, table)
        assert list(columns) == ["name", "units", "geometry"]
        assert columns["geometry"].startswith("GEOMETRY")
        assert columns["units"] == "INTEGER"
        con.execute(f"INSERT INTO {table} VALUES ('Mein Vorhaben', 3, ST_Point(7, 50))")
        assert con.execute(f"SELECT COUNT(*) FROM {table}").fetchone() == (1,)

    def test_a_wkb_blob_geometry_comes_back_as_geometry(
        self, con: Any, tmp_path: Any
    ) -> None:
        """DuckDB writes no GeoParquet metadata for an empty table, so an empty
        file-backed source reads its geometry as BLOB."""
        parquet = tmp_path / "empty.parquet"
        con.execute(
            f"COPY (SELECT * EXCLUDE (bbox_1) FROM {SOURCE_TABLE} WHERE false) "
            f"TO '{parquet}' (FORMAT PARQUET)"
        )
        con.execute(f"CREATE VIEW blob_source AS SELECT * FROM '{parquet}'")
        assert _columns(con, "blob_source")["geometry"] == "BLOB"
        runner = _runner(con)
        with patch.object(
            runner, "resolve_layer_table_path", return_value="blob_source"
        ):
            runner._copy_table(SOURCE, "22222222-2222-2222-2222-222222222222", False)

        table = runner.get_layer_table_path("22222222-2222-2222-2222-222222222222")
        assert _columns(con, table)["geometry"].startswith("GEOMETRY")

    def test_rows_the_author_adds_later_do_not_reach_the_copy(self, con: Any) -> None:
        _, table = _copy(con, copy_content=True)

        con.execute(
            f"INSERT INTO {SOURCE_TABLE} (name, units, geometry) "
            "VALUES ('Später', 1, ST_Point(7, 50))"
        )
        con.execute(f"UPDATE {SOURCE_TABLE} SET units = 0")

        assert con.execute(f"SELECT COUNT(*) FROM {table}").fetchone() == (2,)
        assert con.execute(f"SELECT SUM(units) FROM {table}").fetchone() == (200,)

    def test_a_catalog_view_leaves_its_rowid_behind(self, con: Any) -> None:
        con.execute(
            f"CREATE VIEW catalog_view AS SELECT 7 AS rowid, * EXCLUDE (bbox_1) "
            f"FROM {SOURCE_TABLE}"
        )
        runner = _runner(con)
        with (
            patch.object(
                runner, "resolve_layer_table_path", return_value="catalog_view"
            ),
            patch.object(module, "_catalog_layer_parquet", return_value="/x.parquet"),
        ):
            runner._copy_table(SOURCE, "33333333-3333-3333-3333-333333333333", True)

        table = runner.get_layer_table_path("33333333-3333-3333-3333-333333333333")
        assert list(_columns(con, table)) == ["name", "units", "geometry"]

    def _copy_tables(self, con: Any) -> int:
        return con.execute(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_catalog = 'lake' AND table_name = 't_11111111111111111111111111111111'"
        ).fetchone()[0]

    def test_a_failed_copy_can_be_dropped(self, con: Any) -> None:
        layer_id = "11111111-1111-1111-1111-111111111111"
        _, table = _copy(con, copy_content=True, layer_id=layer_id)
        runner = _runner(con)
        runner._track_new_table(layer_id, table)
        runner._recorded_layer_ids = lambda ids: set()
        runner._drop_table(layer_id)
        assert self._copy_tables(con) == 0

    def test_a_copy_whose_row_was_committed_is_kept(self, con: Any) -> None:
        """The commit went through but its reply was lost: the row points at
        the table, so dropping it would leave the entries on a layer without
        data."""
        layer_id = "11111111-1111-1111-1111-111111111111"
        _, table = _copy(con, copy_content=True, layer_id=layer_id)
        runner = _runner(con)
        runner._track_new_table(layer_id, table)
        runner._recorded_layer_ids = lambda ids: set(ids)
        runner._drop_table(layer_id)
        assert self._copy_tables(con) == 1

    def test_only_the_runs_own_table_is_dropped(self, con: Any) -> None:
        layer_id = "11111111-1111-1111-1111-111111111111"
        _copy(con, copy_content=True, layer_id=layer_id)
        runner = _runner(con)
        runner._recorded_layer_ids = lambda ids: set()
        runner._drop_table(layer_id)
        assert self._copy_tables(con) == 1


class TestHelpers:
    def test_the_select_list_quotes_and_skips(self) -> None:
        columns = [
            ("name", "VARCHAR"),
            ('odd "name"', "VARCHAR"),
            ("bbox_1", "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)"),
            ("rowid", "BIGINT"),
            ("geometry", "BLOB"),
        ]
        assert copy_select_list(columns, drop={"rowid"}) == (
            '"name", "odd ""name""", ST_GeomFromWKB("geometry") AS "geometry"'
        )

    def test_a_layer_without_columns_cannot_be_copied(self) -> None:
        with pytest.raises(ValueError):
            copy_select_list([("rowid", "BIGINT")], drop={"rowid"})

    def test_the_copy_keeps_its_metadata_but_not_the_sources_stamps(self) -> None:
        stamp = {
            "source_layer_id": SOURCE,
            "template_id": TEMPLATE,
            "copy_content": True,
        }
        copied = copy_other_properties(
            '{"legend_urls": ["a"], "catalog_item": {"id": "x"}, '
            '"catalog_materialize": {"status": "ready"}, '
            '"workflow_export": {"workflow_id": "w"}, '
            '"template_copy": {"source_layer_id": "older"}}',
            stamp,
        )
        assert copied == {"legend_urls": ["a"], COPY_STAMP: stamp}
        assert copy_other_properties(None, stamp) == {COPY_STAMP: stamp}


class TestParams:
    def test_an_entry_and_a_project_are_required(self) -> None:
        with pytest.raises(ValidationError):
            _params(layer_project_ids=[])
        with pytest.raises(ValidationError):
            LayerCopyParams(user_id=USER, source_layer_id=SOURCE, layer_project_ids=[1])

    def test_the_job_may_carry_the_entrys_name_for_the_job_list(self) -> None:
        assert (
            _params(layer_name="Vorhaben (Eingabe)").layer_name == "Vorhaben (Eingabe)"
        )
        assert _params().layer_name is None

    def test_a_copy_has_its_rows_unless_asked_otherwise(self) -> None:
        params = LayerCopyParams(
            user_id=USER,
            source_layer_id=SOURCE,
            project_id=PROJECT,
            layer_project_ids=[1],
        )
        assert params.copy_content is True
        assert params.template_id is None


class TestRegistration:
    def test_registered_as_a_hidden_data_tool_whose_jobs_show_in_the_tray(
        self,
    ) -> None:
        tool = get_tool("layer_copy")
        assert tool is not None
        assert tool.toolbox_hidden is True
        # The job is what the user waits for after "Use template".
        assert tool.job_hidden is False
        assert tool.windmill_path == "f/goat/tools/layer_copy"
        assert tool.get_params_class() is LayerCopyParams
        assert tool.get_runner_class() is LayerCopyRunner

    def test_the_windmill_script_takes_the_entries_as_a_list(self) -> None:
        script = generate_windmill_script("goatlib.tools.layer_copy", LayerCopyParams)
        assert "layer_project_ids: list[int]" in script
        # Absent unless given: the model applies its own default (True).
        assert "copy_content: bool | None = None" in script
        assert (
            "from goatlib.tools.layer_copy import LayerCopyParams, main as _main"
            in script
        )


def _plan(pending: list[int], existing: str | None = None, **source: Any) -> CopyPlan:
    return CopyPlan(
        pending=pending,
        existing_copy_id=existing,
        source={
            "id": SOURCE,
            "type": "feature",
            "data_type": None,
            "deleted_at": None,
            "feature_layer_geometry_type": "point",
            "size": 4096,
            "other_properties": {"workflow_export": {"workflow_id": "w"}},
            **source,
        },
        folder_id=FOLDER,
        space_id=SPACE,
    )


class FakeConn:
    """Records what runs inside the run's transaction, and whether it ended
    in a commit or a rollback."""

    def __init__(self) -> None:
        self.events: list[str] = []
        self.close = AsyncMock()

    async def execute(self, sql: str, *args: Any) -> str:
        if "pg_advisory_xact_lock" in sql:
            self.events.append(f"lock {args[0]}")
        return "SELECT 1"

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        self.events.append("begin")
        try:
            yield
        except BaseException:
            self.events.append("rollback")
            raise
        self.events.append("commit")


class TestCopyRun:
    def _run(
        self,
        params: LayerCopyParams,
        plan: CopyPlan,
        *,
        table_info: dict[str, Any] | None = None,
        insert_error: Exception | None = None,
        point_result: list[int] | None = None,
        copy_error: Exception | None = None,
    ) -> tuple[Any, dict[str, Any]]:
        import asyncio

        runner = _runner()
        conn = FakeConn()
        info = table_info or {
            "feature_count": 2,
            "geometry_type": "POINT",
            "geometry_column": "geometry",
            "extent_wkt": "POLYGON((7 50, 8 50, 8 51, 7 51, 7 50))",
        }
        calls: dict[str, Any] = {}

        def copy_table(
            source: str, layer_id: str, copy_content: bool
        ) -> dict[str, Any]:
            calls["copy_table"] = (source, layer_id, copy_content)
            if copy_error is not None:
                raise copy_error
            return dict(info)

        insert = AsyncMock(side_effect=insert_error)
        point = AsyncMock(
            return_value=point_result if point_result is not None else plan.pending
        )
        with (
            patch.object(runner, "_connect", new=AsyncMock(return_value=conn)),
            patch.object(runner, "_copy_table", side_effect=copy_table),
            patch.object(runner, "_drop_table") as drop,
            patch.object(runner, "_generate_pmtiles") as pmtiles,
            patch.object(runner, "get_job_id", return_value=None),
            patch.object(
                module, "load_copy_plan", new=AsyncMock(return_value=plan)
            ) as load,
            patch.object(module, "insert_copy_layer", new=insert),
            patch.object(module, "point_links_at_copy", new=point),
            patch.object(module, "mark_copy_failed", new=AsyncMock()) as mark_failed,
        ):
            calls.update(
                conn=conn,
                drop=drop,
                pmtiles=pmtiles,
                load=load,
                insert=insert,
                point=point,
                mark_failed=mark_failed,
            )
            try:
                calls["output"] = asyncio.new_event_loop().run_until_complete(
                    runner.copy(params)
                )
            except Exception as exc:  # noqa: BLE001
                calls["error"] = exc
        return calls.get("output"), calls

    def test_a_copy_is_written_and_the_entries_point_at_it(self) -> None:
        output, calls = self._run(_params(), _plan([11, 12]))

        assert output.copied is True
        assert output.layer_project_ids == [11, 12]
        assert output.feature_count == 2
        assert output.geometry_type == "point"
        source, copy_id, content = calls["copy_table"]
        assert (source, content) == (SOURCE, True)
        assert output.layer_id == copy_id

        insert_kwargs = calls["insert"].await_args.kwargs
        assert insert_kwargs["layer_id"] == copy_id
        assert insert_kwargs["user_id"] == USER
        assert insert_kwargs["folder_id"] == FOLDER
        assert insert_kwargs["space_id"] == SPACE
        assert insert_kwargs["size"] == 4096
        assert insert_kwargs["extent_wkt"].startswith("POLYGON")
        stamp = {
            "source_layer_id": SOURCE,
            "template_id": TEMPLATE,
            "copy_content": True,
        }
        # The source's workflow stamp is not the copy's.
        assert insert_kwargs["other_properties"] == {COPY_STAMP: stamp}

        point_kwargs = calls["point"].await_args.kwargs
        assert point_kwargs["link_ids"] == [11, 12]
        assert point_kwargs["layer_id"] == copy_id
        assert point_kwargs["source_layer_id"] == SOURCE
        # The entries say the copy is done; the layer's own stamp has no status.
        assert point_kwargs["stamp"] == {**stamp, "status": "done"}

        # Runs for the same project and source wait for each other.
        assert calls["conn"].events == [
            "begin",
            f"lock layer_copy:{PROJECT}:{SOURCE}",
            "commit",
        ]
        calls["drop"].assert_not_called()
        calls["pmtiles"].assert_called_once()
        assert calls["pmtiles"].call_args.kwargs["layer_id"] == copy_id
        calls["conn"].close.assert_awaited_once()

    def test_an_empty_copy_takes_its_geometry_type_from_the_source(self) -> None:
        output, calls = self._run(
            _params(copy_content=False),
            _plan([11]),
            table_info={
                "feature_count": 0,
                "geometry_type": None,
                "geometry_column": "geometry",
                "extent_wkt": None,
            },
        )

        assert output.copied is True
        assert output.feature_count == 0
        assert output.geometry_type == "point"
        assert calls["copy_table"][2] is False
        insert_kwargs = calls["insert"].await_args.kwargs
        assert insert_kwargs["copy_content"] is False
        assert insert_kwargs["size"] == 0
        assert insert_kwargs["extent_wkt"] is None
        assert insert_kwargs["other_properties"][COPY_STAMP]["copy_content"] is False
        # Nothing to tile.
        calls["pmtiles"].assert_not_called()

    def test_a_second_run_finds_nothing_to_do(self) -> None:
        """Idempotent: the entries already show a copy of this source."""
        output, calls = self._run(_params(), _plan([], existing="copy-1"))

        assert output.copied is False
        assert output.layer_id == "copy-1"
        assert "copy_table" not in calls
        calls["insert"].assert_not_awaited()
        calls["point"].assert_not_awaited()
        assert calls["conn"].events[-1] == "commit"

    def test_an_entry_left_on_the_source_gets_the_existing_copy(self) -> None:
        output, calls = self._run(_params(), _plan([12], existing="copy-1"))

        assert "copy_table" not in calls
        calls["insert"].assert_not_awaited()
        assert calls["point"].await_args.kwargs["layer_id"] == "copy-1"
        assert calls["point"].await_args.kwargs["link_ids"] == [12]
        assert output.layer_id == "copy-1"
        assert output.copied is False
        calls["pmtiles"].assert_not_called()

    def test_a_failed_write_leaves_the_entries_on_the_source(self) -> None:
        output, calls = self._run(
            _params(), _plan([11, 12]), insert_error=RuntimeError("db down")
        )

        assert output is None
        assert isinstance(calls["error"], RuntimeError)
        calls["point"].assert_not_awaited()
        assert calls["conn"].events[-1] == "rollback"
        # The table it wrote is removed again, nothing shows it.
        calls["drop"].assert_called_once_with(calls["copy_table"][1])
        calls["pmtiles"].assert_not_called()
        calls["conn"].close.assert_awaited_once()
        # The entries waiting for the copy say it failed, and why.
        mark_kwargs = calls["mark_failed"].await_args.kwargs
        assert mark_kwargs["link_ids"] == [11, 12]
        assert mark_kwargs["source_layer_id"] == SOURCE
        assert mark_kwargs["error"] == "db down"

    def test_a_failed_table_copy_is_cleaned_up_too(self) -> None:
        output, calls = self._run(
            _params(), _plan([11]), copy_error=RuntimeError("lake gone")
        )

        assert output is None
        assert isinstance(calls["error"], RuntimeError)
        calls["insert"].assert_not_awaited()
        calls["point"].assert_not_awaited()
        calls["drop"].assert_called_once_with(calls["copy_table"][1])
        assert calls["conn"].events[-1] == "rollback"

    def test_a_request_that_can_never_succeed_fails_before_copying(self) -> None:
        import asyncio

        runner = _runner()
        conn = FakeConn()
        with (
            patch.object(runner, "_connect", new=AsyncMock(return_value=conn)),
            patch.object(runner, "_copy_table") as copy_table,
            patch.object(
                module,
                "load_copy_plan",
                new=AsyncMock(side_effect=ValueError("not in project")),
            ),
        ):
            with pytest.raises(ValueError, match="not in project"):
                asyncio.new_event_loop().run_until_complete(runner.copy(_params()))
        copy_table.assert_not_called()
        assert conn.events[-1] == "rollback"

    def test_entries_repointed_meanwhile_drop_the_copy(self) -> None:
        """The user pointed every entry elsewhere while the copy was written:
        nobody would see it, so it goes again and the run reports no copy."""
        output, calls = self._run(_params(), _plan([11]), point_result=[])

        assert "error" not in calls
        calls["mark_failed"].assert_not_awaited()
        assert output.copied is False
        assert output.layer_id is None
        assert calls["conn"].events[-1] == "rollback"
        calls["drop"].assert_called_once_with(calls["copy_table"][1])
        calls["pmtiles"].assert_not_called()

    def test_main_returns_the_output_as_a_dict(self) -> None:
        output = module.LayerCopyOutput(
            layer_id="copy-1",
            source_layer_id=SOURCE,
            project_id=PROJECT,
            layer_project_ids=[11],
            copied=True,
        )
        with (
            patch.object(LayerCopyRunner, "init_from_env"),
            patch.object(LayerCopyRunner, "copy", new=AsyncMock(return_value=output)),
            patch.object(LayerCopyRunner, "cleanup") as cleanup,
        ):
            result = module.main(_params())
        assert result["layer_id"] == "copy-1"
        assert result["copied"] is True
        cleanup.assert_called_once()
