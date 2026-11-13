"""The PMTiles rebuild tasks' DuckDB connection is capped like a tool run's.

The tile query's ORDER BY sorts the whole layer, and DuckDB spills a sort only
when it reaches its own memory_limit. Without one it takes 80% of the
container, so a 38M row layer used to grow until the worker was killed.
"""

import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from goatlib.storage import BaseDuckLakeManager
from goatlib.tasks.sync_pmtiles import PMTilesSyncTask
from goatlib.utils import container_memory

GIB = 1024**3


@pytest.fixture
def task(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """A task on a real DuckDB connection, without a catalog to attach."""
    limit = tmp_path / "memory.max"
    limit.write_text(str(4 * GIB) + "\n")
    monkeypatch.setattr(container_memory, "CGROUP_MEMORY_LIMIT_FILES", (limit,))
    for step in ("_install_extensions", "_load_extensions", "_setup_s3"):
        monkeypatch.setattr(BaseDuckLakeManager, step, lambda self, con: None)
    monkeypatch.setattr(
        BaseDuckLakeManager, "_attach_ducklake", lambda self, con, **_: None
    )

    task = PMTilesSyncTask()
    task.settings = SimpleNamespace(
        ducklake_postgres_uri="postgresql://u:p@localhost/db",
        ducklake_data_dir="s3://bucket/lake",
        ducklake_catalog_schema="ducklake",
    )
    yield task
    task.close()


def _settings(con) -> tuple[str, str]:
    memory_limit, temp_directory = con.execute(
        "SELECT current_setting('memory_limit'), current_setting('temp_directory')"
    ).fetchone()
    return memory_limit, temp_directory


@pytest.mark.unit
def test_the_connection_gets_the_work_share_of_the_container(task) -> None:
    with task._get_manager().connection() as con:
        memory_limit, _ = _settings(con)

    # Half of 4 GiB, the share of a tool run's work connection: this one does
    # the task's work, and manby only starts once it has written its input.
    # A quarter failed the sort of a layer of large country borders.
    assert memory_limit == "2.0 GiB"


@pytest.mark.unit
def test_the_connection_spills_into_a_writable_directory_of_its_own(task) -> None:
    with task._get_manager().connection() as con:
        _, temp_directory = _settings(con)

    spill_dir = Path(temp_directory)
    assert spill_dir.is_dir() and os.access(spill_dir, os.W_OK)
    # Not DuckDB's default, a `.tmp` next to the working directory.
    assert spill_dir.is_absolute()


@pytest.mark.unit
def test_a_replacement_connection_is_bounded_too(task) -> None:
    """A 5 minute old connection is swapped for a new one, and a build runs longer."""
    manager = task._get_manager()
    with manager.connection() as con:
        first = _settings(con)

    manager.reconnect()

    with manager.connection() as con:
        again = _settings(con)
    assert again == first
    assert again[0] == "2.0 GiB"


@pytest.mark.unit
def test_closing_the_task_removes_the_spill_directory(task) -> None:
    with task._get_manager().connection() as con:
        _, temp_directory = _settings(con)
    assert Path(temp_directory).is_dir()

    task.close()

    assert not Path(temp_directory).exists()
