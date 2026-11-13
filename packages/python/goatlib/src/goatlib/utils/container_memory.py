"""DuckDB memory budgets derived from the container's memory limit.

DuckDB spills to disk only when it reaches its own `memory_limit`, and a
connection without one takes 80% of the container's limit for itself. A
process with several connections can therefore pass the container's limit,
and be killed, before any of them spills. Giving each connection a share of
the container's limit keeps them under it together.
"""

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import duckdb

# cgroup v2, then v1.
CGROUP_MEMORY_LIMIT_FILES = (
    Path("/sys/fs/cgroup/memory.max"),
    Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
)
# cgroup v1 reports "no limit" as a number close to 2**63.
_UNLIMITED = 1 << 60

# A Windmill worker runs one job at a time. The job's work connection (an
# analysis, or a tool's own DuckDB) gets half the container and the runner's
# DuckLake connection a quarter; Python, routing and the worker share the rest.
JOB_WORK_MEMORY_SHARE = 0.5
JOB_DUCKLAKE_MEMORY_SHARE = 0.25
# A tile build writes the layer to a file with one of those connections first
# and runs manby on it afterwards, so manby never shares the container with a
# running query: it keeps its features and tiles under this share and spills
# the rest to disk. The connection that wrote the file hands the memory of its
# sort back once the file is written (`_write_tile_input` in io/pmtiles.py), so
# the other half holds only what the job's connections keep between queries (a
# tool's tables in memory, catalog metadata), Python and the job runner, and
# manby passing its budget a little. A larger share barely sped up builds of
# millions of features, and a layer that fills the budget could then take the
# container over its limit.
MANBY_MEMORY_SHARE = 0.5


def container_memory_limit() -> int | None:
    """The container's memory limit in bytes, or None when it has none."""
    for path in CGROUP_MEMORY_LIMIT_FILES:
        try:
            raw = path.read_text().strip()
        except OSError:
            continue
        if not raw.isdigit():
            return None
        limit = int(raw)
        return limit if limit < _UNLIMITED else None
    return None


def duckdb_memory_limit(share: float, default: str | None = None) -> str | None:
    """A DuckDB `memory_limit` of `share` of the container's memory limit.

    `default` without a container limit (local runs).
    """
    limit = container_memory_limit()
    if limit is None:
        return default
    return f"{int(limit * share) // (1024 * 1024)}MiB"


def set_memory_share(
    con: "duckdb.DuckDBPyConnection", share: float, default: str | None = None
) -> None:
    """Cap `con` at `share` of the container's memory limit.

    Without a container limit `default` applies, or DuckDB's own default when
    that is None.
    """
    memory_limit = duckdb_memory_limit(share, default)
    if memory_limit:
        con.execute(f"SET memory_limit='{memory_limit}'")
