"""Every Postgres attach takes its password from the DuckDB connection's
secret (`goatlib.utils.credentials.postgres_attach_target`)."""

from typing import Any

import pytest
from goatlib.storage import ducklake, ducklake_init
from goatlib.tools.base import SimpleToolRunner, ToolSettings

PASSWORD = "hunter2"
URI = f"postgresql://goat:{PASSWORD}@db:5432/goat"


class _RecordingConnection:
    def __init__(self) -> None:
        self.executed: list[str] = []
        self.parameters: list[Any] = []

    def execute(self, sql: str, *parameters: Any) -> "_RecordingConnection":
        self.executed.append(sql)
        self.parameters.append(parameters)
        return self

    def fetchone(self) -> None:
        return None

    def fetchall(self) -> list[Any]:
        # `SELECT current_setting('threads')` is the only list read here.
        return [(4,)]

    def close(self) -> None:
        pass


def _assert_password_only_in_the_secret(con: _RecordingConnection) -> None:
    attaches = [sql for sql in con.executed if "ATTACH" in sql]
    assert attaches
    assert not [sql for sql in attaches if PASSWORD in sql]
    secret = "CREATE OR REPLACE SECRET (TYPE postgres, PASSWORD ?)"
    assert con.parameters[con.executed.index(secret)] == ([PASSWORD],)


@pytest.mark.unit
def test_the_manager_attaches_its_catalog_without_the_password() -> None:
    manager = ducklake.BaseDuckLakeManager()
    manager._postgres_uri = URI
    manager._storage_path = "/tmp/ducklake"
    manager._catalog_schema = "ducklake"
    con = _RecordingConnection()

    manager._attach_ducklake(con)  # type: ignore[arg-type]

    _assert_password_only_in_the_secret(con)


@pytest.mark.unit
def test_the_pool_attaches_its_catalog_without_the_password(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    con = _RecordingConnection()
    monkeypatch.setattr(ducklake.duckdb, "connect", lambda *_, **__: con)
    pool = ducklake.DuckLakePool()
    pool._postgres_uri = URI
    pool._storage_path = "/tmp/ducklake"
    pool._catalog_schema = "ducklake"
    pool._extensions_installed = True

    pool._create_connection()

    _assert_password_only_in_the_secret(con)


@pytest.mark.unit
def test_the_bootstrap_attaches_the_catalog_without_the_password(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    con = _RecordingConnection()
    monkeypatch.setattr(ducklake_init.duckdb, "connect", lambda: con)
    monkeypatch.setenv("DUCKDB_EXTENSION_DIRECTORY", str(tmp_path / "extensions"))
    monkeypatch.delenv("S3_ENDPOINT_URL", raising=False)
    monkeypatch.setenv("POSTGRES_PASSWORD", PASSWORD)
    monkeypatch.setenv("DUCKLAKE_DATA_DIR", str(tmp_path / "ducklake"))

    ducklake_init.bootstrap_from_env()

    _assert_password_only_in_the_secret(con)


@pytest.mark.unit
def test_a_tool_attaches_the_catalog_without_the_password(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import goatlib.tools.base as base

    con = _RecordingConnection()
    monkeypatch.setattr(base.duckdb, "connect", lambda *_, **__: con)
    runner = SimpleToolRunner()
    runner.init(
        ToolSettings(
            postgres_server="db",
            postgres_port=5432,
            postgres_user="goat",
            postgres_password=PASSWORD,
            postgres_db="goat",
            ducklake_postgres_uri=URI,
            ducklake_catalog_schema="ducklake",
            ducklake_data_dir="/data",
        )
    )

    runner._get_duckdb_connection()

    _assert_password_only_in_the_secret(con)


@pytest.mark.unit
def test_the_gtfs_typed_storage_migration_attaches_without_the_password() -> None:
    from goatlib.tasks.gtfs_typed_storage import GtfsTypedStorageTask

    class _NoBundles(_RecordingConnection):
        def fetchall(self) -> list[Any]:
            return []

    con = _NoBundles()
    task = GtfsTypedStorageTask()
    task.settings = ToolSettings(
        postgres_server="db",
        postgres_port=5432,
        postgres_user="goat",
        postgres_password=PASSWORD,
        postgres_db="goat",
        ducklake_postgres_uri=URI,
        ducklake_catalog_schema="ducklake",
        ducklake_data_dir="/data",
    )

    task._members(con, None)

    _assert_password_only_in_the_secret(con)
