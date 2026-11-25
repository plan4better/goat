"""A second manby.tile call in one process, after a failed call or not.

Finding (manby 0.1.6, pyarrow 25.0.0, DuckDB 1.5.4): the second `manby.tile`
call with a table input segfaults the Python process whenever pyarrow was not
imported before the first call. The failed first call is not the cause: two
successful calls crash the same way, and a fresh DuckDB cursor does not help.

The crash is in pyarrow, not in manby or DuckDB. manby's feeder thread imports
pyarrow lazily (`_write_ipc`), so pyarrow and its default memory pool
(mimalloc) are set up in that short-lived thread. After it exits, the next
feeder thread segfaults in its first pyarrow IPC write, and the manby process
then reports an empty Arrow stream. Without manby and DuckDB, a thread writing
an IPC stream after pyarrow was first imported in an exited thread crashes the
same way. Nothing crashes with the system or jemalloc pool, or when the thread
that imported pyarrow stays alive.

So a caller that streams a table through manby.tile must import pyarrow at
module level: the thread that loads it (the main thread) then sets pyarrow up
before the first manby.tile call. Neither a fresh cursor nor a child process
per build is needed. The PMTiles builder streams nothing: it runs manby's
program on a file.

Each scenario runs in its own interpreter, so a segfault fails the test
instead of killing pytest.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

_SCRIPT = """
import sys
from pathlib import Path

import duckdb
import manby

out = Path(sys.argv[1])
con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")
ONE_POINT = "SELECT 'a' AS name, ST_AsWKB(ST_Point(7.6, 47.5)) AS geometry"
TWO_POINTS = (
    "SELECT * FROM (VALUES "
    "('a', ST_AsWKB(ST_Point(7.6, 47.5))), "
    "('b', ST_AsWKB(ST_Point(7.7, 47.6)))"
    ") AS t(name, geometry)"
)


def build_failing(relation):
    # -zg cannot guess a max zoom from a single location
    try:
        manby.tile(relation, out / "first.pmtiles", "-zg")
    except manby.ManbyError:
        return
    raise SystemExit("-zg on one point should have failed")


"""

_CRASH = (
    "pyarrow first imported in manby's short-lived feeder thread: the next "
    "feeder thread segfaults in pyarrow's IPC write (see module docstring)"
)

pyarrow_first = pytest.mark.parametrize(
    "import_pyarrow_first",
    [
        pytest.param(True, id="pyarrow-imported-first"),
        pytest.param(
            False,
            id="pyarrow-imported-by-manby",
            marks=pytest.mark.xfail(strict=True, reason=_CRASH),
        ),
    ],
)


def _run(scenario: str, import_pyarrow_first: bool, tmp_path: Path) -> None:
    script = ("import pyarrow\n" if import_pyarrow_first else "") + _SCRIPT
    script += scenario + '\nprint("ok")\n'
    # the memory pool decides whether it crashes: test pyarrow's default
    env = {k: v for k, v in os.environ.items() if k != "ARROW_DEFAULT_MEMORY_POOL"}
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    assert result.returncode == 0, (result.returncode, result.stderr[-2000:])
    assert result.stdout.strip() == "ok"
    assert (tmp_path / "second.pmtiles").stat().st_size > 0


@pyarrow_first
def test_two_successful_calls_in_one_process(
    import_pyarrow_first: bool, tmp_path: Path
) -> None:
    scenario = (
        'manby.tile(con.sql(TWO_POINTS), out / "first.pmtiles", "-z10", "-r1")\n'
        'manby.tile(con.sql(TWO_POINTS), out / "second.pmtiles", "-z10", "-r1")\n'
    )
    _run(scenario, import_pyarrow_first, tmp_path)


@pyarrow_first
def test_call_after_failed_call_same_connection(
    import_pyarrow_first: bool, tmp_path: Path
) -> None:
    scenario = (
        "build_failing(con.sql(ONE_POINT))\n"
        'manby.tile(con.sql(TWO_POINTS), out / "second.pmtiles", "-z10", "-r1")\n'
    )
    _run(scenario, import_pyarrow_first, tmp_path)


@pyarrow_first
def test_call_after_failed_call_fresh_cursor(
    import_pyarrow_first: bool, tmp_path: Path
) -> None:
    scenario = (
        "build_failing(con.sql(ONE_POINT))\n"
        "manby.tile(\n"
        '    con.cursor().sql(TWO_POINTS), out / "second.pmtiles", "-z10", "-r1"\n'
        ")\n"
    )
    _run(scenario, import_pyarrow_first, tmp_path)
