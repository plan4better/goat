"""Stored travel-time matrices exist with the cost column named `cost` or
`traveltime`; one directory may hold both layouts."""

from pathlib import Path

import duckdb
import pytest
from goatlib.analysis.accessibility.base import HeatmapToolBase

CELL_A = "8a1f05a4a3affff"
CELL_B = "8a1f05a4a3b7fff"


def _write(path: Path, cost_column: str, cost: int) -> None:
    con = duckdb.connect()
    con.execute("INSTALL h3 FROM community; LOAD h3;")
    con.execute(
        f"COPY (SELECT h3_string_to_h3('{CELL_A}') AS orig_id, "
        f"h3_string_to_h3('{CELL_B}') AS dest_id, {cost} AS {cost_column}) "
        f"TO '{path}' (FORMAT PARQUET)"
    )
    con.close()


def test_a_directory_with_both_layouts_reads_as_one(tmp_path: Path) -> None:
    _write(tmp_path / "a.parquet", "cost", 5)
    _write(tmp_path / "b.parquet", "traveltime", 7)
    tool = HeatmapToolBase()
    view, resolution = tool._prepare_od_matrix(str(tmp_path))
    costs = sorted(
        r[0] for r in tool.con.execute(f"SELECT cost FROM {view}").fetchall()
    )
    assert costs == [5, 7]
    assert resolution == 10


def _view_sql(tool: HeatmapToolBase, view: str) -> str:
    return tool.con.execute(
        "SELECT sql FROM duckdb_views() WHERE view_name = ?", [view]
    ).fetchone()[0]


def test_a_single_layout_keeps_the_plain_read(tmp_path: Path) -> None:
    """Matching files by name reads every file footer on each bind of the
    view, so a matrix in one layout is read as before."""
    _write(tmp_path / "a.parquet", "cost", 5)
    _write(tmp_path / "b.parquet", "cost", 7)
    tool = HeatmapToolBase()
    view, _ = tool._prepare_od_matrix(str(tmp_path))
    assert "union_by_name" not in _view_sql(tool, view).lower()
    costs = sorted(
        r[0] for r in tool.con.execute(f"SELECT cost FROM {view}").fetchall()
    )
    assert costs == [5, 7]


def test_a_file_without_a_time_cost_still_fails(tmp_path: Path) -> None:
    """A file with neither layout's cost column (here a distance) is neither
    read as empty costs nor mixed in: the read fails on the schema."""
    _write(tmp_path / "a.parquet", "cost", 5)
    _write(tmp_path / "b.parquet", "distance", 900)
    tool = HeatmapToolBase()
    with pytest.raises(duckdb.Error, match="schema mismatch"):
        view, _ = tool._prepare_od_matrix(str(tmp_path))
        tool.con.execute(f"SELECT cost FROM {view}").fetchall()
