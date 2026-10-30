"""The Explorer snapshot of a small, hand-checked feed.

The feed (``tests/fixtures/explorer_mini_gtfs``) has stops 0.01° of longitude
apart at 52.5° N, about 677 m, and:

- R1: T1 and T2 S1→S5 and T4 S1→S3 (a short turn numbered 10, 20, 30)
  in direction 0, T3 S5→S1 in direction 1; T1, T2, T4 give
  ``shape_dist_traveled`` in kilometres;
- R2: U1 S2→S6 23:50→24:10 and U2 S6→S2 past midnight, one block, no
  direction_id; U2 names a stop that does not exist;
- R3: the loop L1 S1→S2→S3→S1, Saturdays only;
- R4: F1, a frequency trip, and F2 on a calendar_dates-only service;
- Z1, on a route the feed does not have.
"""

import zipfile
from pathlib import Path
from typing import Any, Dict

import duckdb
import pytest
from goatlib.bundles.explorer.snapshot import FILES, build_snapshot
from goatlib.bundles.importers.base import bound_duckdb
from goatlib.bundles.importers.pt_network.gtfs import GtfsImporter

FIXTURE = Path(__file__).parents[2] / "fixtures" / "explorer_mini_gtfs"


@pytest.fixture(scope="module")
def snapshot(tmp_path_factory: pytest.TempPathFactory) -> Dict[str, Any]:
    root = tmp_path_factory.mktemp("explorer")
    archive = root / "mini_gtfs.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for f in sorted(FIXTURE.iterdir()):
            zf.write(f, f.name)
    work = root / "work"
    work.mkdir()
    paths = {
        layer.role: layer.file_path
        for layer in GtfsImporter().extract_layers(str(archive), str(work))
    }
    out = root / "snapshot"
    out.mkdir()
    con = bound_duckdb(duckdb.connect(), str(work))
    manifest = build_snapshot(
        con,
        lambda role: f"read_parquet('{paths[role]}')" if role in paths else None,
        str(out),
    )
    return {"manifest": manifest, "dir": out, "con": con}


def _rows(snapshot: Dict[str, Any], sql: str) -> list:
    out = snapshot["dir"]
    for name in FILES:
        sql = sql.replace(f"{{{name}}}", f"read_parquet('{out}/{name}.parquet')")
    return snapshot["con"].execute(sql).fetchall()


def test_every_file_is_written_and_listed(snapshot: Dict[str, Any]) -> None:
    files = {f["name"]: f for f in snapshot["manifest"]["files"]}
    assert list(files) == list(FILES)
    for name in FILES:
        assert (snapshot["dir"] / f"{name}.parquet").exists()
    # 34 in the feed, less Z1's two (no route) and U2's stop at NOPE.
    assert files["stop_times"]["rows"] == 31
    assert snapshot["manifest"]["service_window"] == ["2026-01-05", "2026-12-31"]


def test_data_the_feed_contradicts_is_counted(snapshot: Dict[str, Any]) -> None:
    assert snapshot["manifest"]["warnings"] == {
        "stop_times_without_stop": 1,  # U2 → NOPE
        "trips_without_route_or_service": 1,  # Z1 → RX
    }


def test_ids_keep_their_index(snapshot: Dict[str, Any]) -> None:
    stops = dict(_rows(snapshot, "SELECT stop_id, stop_idx FROM {stops}"))
    assert stops == {
        f: i for i, f in enumerate(["P", "S1", "S2", "S3", "S4", "S5", "S6", "X"])
    }
    assert _rows(snapshot, "SELECT parent_idx FROM {stops} WHERE stop_id = 'S1'") == [
        (0,)
    ]
    # Routes in agency, sort order and number order: 1, 2, F, L.
    assert _rows(snapshot, "SELECT route_id FROM {routes} ORDER BY route_idx") == [
        ("R1",),
        ("R2",),
        ("R4",),
        ("R3",),
    ]


def test_a_routes_trips_are_one_range_in_direction_then_pattern_order(
    snapshot: Dict[str, Any],
) -> None:
    trips = _rows(
        snapshot,
        "SELECT trip_id, trip_idx FROM {trips} ORDER BY trip_idx",
    )
    # R1: direction 0 first, the two-trip pattern before the short turn, then
    # direction 1.
    assert [t for t, _ in trips[:4]] == ["T1", "T2", "T4", "T3"]
    assert _rows(
        snapshot, "SELECT trip_lo, trip_hi FROM {routes} WHERE route_id = 'R1'"
    ) == [(0, 3)]
    for route_id, lo, hi in _rows(
        snapshot, "SELECT route_id, trip_lo, trip_hi FROM {routes}"
    ):
        in_range = _rows(
            snapshot,
            f"SELECT count(*) FROM {{trips}} t JOIN {{routes}} r USING (route_idx) "
            f"WHERE r.route_id = '{route_id}' AND t.trip_idx BETWEEN {lo} AND {hi}",
        )[0][0]
        assert in_range == hi - lo + 1


def test_patterns_are_ordered_stops_whatever_the_sequence_numbers(
    snapshot: Dict[str, Any],
) -> None:
    names = dict(_rows(snapshot, "SELECT stop_idx, stop_id FROM {stops}"))
    patterns = _rows(
        snapshot,
        "SELECT p.stops, p.n_trips FROM {patterns} p JOIN {routes} r USING (route_idx) "
        "WHERE r.route_id = 'R1' ORDER BY p.pattern_idx",
    )
    assert [([names[s] for s in stops], n) for stops, n in patterns] == [
        (["S1", "S2", "S3", "S4", "S5"], 2),
        (["S5", "S4", "S3", "S2", "S1"], 1),
        (["S1", "S2", "S3"], 1),  # T4, numbered 10, 20, 30
    ]
    loop = _rows(
        snapshot,
        "SELECT p.stops FROM {patterns} p JOIN {routes} r USING (route_idx) "
        "WHERE r.route_id = 'R3'",
    )
    assert [names[s] for s in loop[0][0]] == ["S1", "S2", "S3", "S1"]


def test_times_are_seconds_and_run_past_midnight(snapshot: Dict[str, Any]) -> None:
    assert _rows(
        snapshot,
        "SELECT first_dep_s, last_arr_s FROM {trips} WHERE trip_id = 'U1'",
    ) == [(23 * 3600 + 50 * 60, 24 * 3600 + 10 * 60)]
    st = _rows(
        snapshot,
        "SELECT st.stop_sequence, st.arrival_s FROM {stop_times} st "
        "JOIN {trips} t USING (trip_idx) WHERE t.trip_id = 'U2' ORDER BY 1",
    )
    assert st == [(1, 87600), (3, 89400)]  # the stop time naming NOPE is gone


def test_lengths_come_from_the_best_source_and_say_which(
    snapshot: Dict[str, Any],
) -> None:
    assert snapshot["manifest"]["shape_dist_unit"] == "km"
    lengths = dict(
        (t, (round(m), src))
        for t, m, src in _rows(
            snapshot, "SELECT trip_id, length_m, length_src FROM {trips}"
        )
    )
    assert lengths["T1"] == (2720, 1)  # shape_dist_traveled, kilometres → metres
    assert lengths["T4"] == (1360, 1)
    # No distances and no shape: the straight line from stop to stop.
    assert lengths["T3"][1] == 3
    assert lengths["T3"][0] == pytest.approx(4 * 676.9, rel=0.01)


def test_services_and_their_exceptions(snapshot: Dict[str, Any]) -> None:
    services = {
        sid: (days, str(start), str(end))
        for sid, days, start, end in _rows(
            snapshot, "SELECT service_id, days, start_date, end_date FROM {services}"
        )
    }
    assert services == {
        "SA": (32, "2026-01-05", "2026-12-31"),
        "WK": (31, "2026-01-05", "2026-12-31"),
        # Only calendar_dates names it: no weekdays, its dates as its range.
        "XMAS": (None, "2026-12-25", "2026-12-25"),
    }
    assert _rows(
        snapshot,
        "SELECT s.service_id, CAST(cd.date AS VARCHAR), cd.exception_type FROM {calendar_dates} cd "
        "JOIN {services} s USING (service_idx) ORDER BY 1",
    ) == [("WK", "2026-04-06", 2), ("XMAS", "2026-12-25", 1)]


def test_frequencies_and_blocks(snapshot: Dict[str, Any]) -> None:
    assert _rows(
        snapshot,
        "SELECT t.trip_id, f.start_s, f.end_s, f.headway_s, f.exact_times "
        "FROM {frequencies} f JOIN {trips} t USING (trip_idx)",
    ) == [("F1", 6 * 3600, 9 * 3600, 600, 0)]
    blocks = dict(_rows(snapshot, "SELECT trip_id, block_idx FROM {trips}"))
    assert blocks["U1"] == blocks["U2"] is not None
    assert blocks["T1"] is None


def test_stop_times_are_compact_types(snapshot: Dict[str, Any]) -> None:
    types = dict(
        (c, t) for c, t, *_ in _rows(snapshot, "DESCRIBE SELECT * FROM {stop_times}")
    )
    assert types == {
        "trip_idx": "INTEGER",
        "stop_sequence": "INTEGER",
        "stop_idx": "INTEGER",
        "arrival_s": "INTEGER",
        "departure_s": "INTEGER",
        "shape_dist": "FLOAT",
    }


def test_the_web_apps_copy_is_current(snapshot: Dict[str, Any]) -> None:
    """The web app's tests read a committed copy of this snapshot; regenerate
    it with ``tests/fixtures/explorer_web_fixture.py`` when this fails."""
    repo = Path(__file__).parents[6]
    web_fixture = repo / "apps" / "web" / "lib" / "explorer" / "__fixtures__" / "mini"
    con = snapshot["con"]
    for name in FILES:
        built = f"read_parquet('{snapshot['dir']}/{name}.parquet')"
        committed = f"read_parquet('{web_fixture}/{name}.parquet')"
        for a, b in ((built, committed), (committed, built)):
            extra = con.execute(f"SELECT count(*) FROM (FROM {a} EXCEPT ALL FROM {b})")
            assert extra.fetchone()[0] == 0, f"{name}.parquet is stale"


def test_a_trip_whose_end_has_no_time_has_no_schedule(tmp_path: Path) -> None:
    """A GTFS-Flex trip gives its last stop a pickup window, not a time; it
    must not look like a trip that arrives when it leaves."""
    archive = tmp_path / "flex_gtfs.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for f in sorted(FIXTURE.iterdir()):
            text = f.read_text()
            if f.name == "trips.txt":
                text += "R1,WK,FLEX,Fifth,0,,\n"
            if f.name == "stop_times.txt":
                text += "FLEX,21:20:00,21:20:00,S1,1,\nFLEX,,,S2,2,\n"
            zf.writestr(f.name, text)
    work = tmp_path / "work"
    work.mkdir()
    paths = {
        layer.role: layer.file_path
        for layer in GtfsImporter().extract_layers(str(archive), str(work))
    }
    out = tmp_path / "snapshot"
    out.mkdir()
    con = bound_duckdb(duckdb.connect(), str(work))
    build_snapshot(
        con,
        lambda role: f"read_parquet('{paths[role]}')" if role in paths else None,
        str(out),
    )
    row = con.execute(
        f"SELECT first_dep_s, last_arr_s FROM read_parquet('{out}/trips.parquet') "
        "WHERE trip_id = 'FLEX'"
    ).fetchall()
    assert row == [(21 * 3600 + 20 * 60, None)]


def test_shapes_are_simplified_with_the_distance_along_them(
    snapshot: Dict[str, Any],
) -> None:
    # SH1 leaves S1 north-east to 52.505° N, comes back down at S2 and runs
    # due east to S5. Its point at 13.42 lies on the straight run: simplified
    # away. Each leg of the detour is 650.9 m; 0.01° of longitude 676.9 m.
    points = _rows(
        snapshot,
        """SELECT i, lon, lat, d FROM {shape_points} JOIN {shapes_meta} USING (shape_idx)
           WHERE shape_id = 'SH1' ORDER BY i""",
    )
    assert [round(p[1], 3) for p in points] == [13.4, 13.405, 13.41, 13.44]
    assert [round(p[3]) for p in points] == [0, 651, 1302, 3332]


def test_stops_are_placed_along_their_trips_shape(snapshot: Dict[str, Any]) -> None:
    # The main pattern S1 → S5 on SH1: S2 after the detour, then 676.9 m a stop.
    along = _rows(
        snapshot,
        """SELECT p.d FROM {pattern_shape_stops} p JOIN {patterns} USING (pattern_idx)
           WHERE n_stops = 5 AND stops[1] < stops[5] ORDER BY i""",
    )
    assert [round(a[0]) for a in along] == [0, 1302, 1979, 2656, 3332]
    # Patterns whose trips have no shape (R1's return, R2, R3, R4) are placed
    # along the line through their stops: every pattern is.
    assert _rows(
        snapshot,
        "SELECT count(DISTINCT pattern_idx) = (SELECT count(*) FROM {patterns}) "
        "FROM {pattern_shape_stops}",
    ) == [(True,)]
    assert _rows(
        snapshot, "SELECT DISTINCT route_idx FROM {shape_route} ORDER BY 1"
    ) == [
        (0,),
        (1,),
        (2,),
        (3,),
    ]


def test_trips_without_a_shape_take_the_line_through_their_stops(
    snapshot: Dict[str, Any], tmp_path: Path
) -> None:
    # Every trip has a shape: its own, or the line through its stops.
    assert _rows(snapshot, "SELECT count(*) FROM {trips} WHERE shape_idx IS NULL") == [
        (0,)
    ]
    # R1's return T3 runs S5 → S1 straight along the stops, 676.9 m a stop,
    # and keeps its length from them.
    shape = _rows(
        snapshot,
        """SELECT m.shape_id, m.length_m, t.length_src FROM {trips} t
           JOIN {shapes_meta} m USING (shape_idx) WHERE t.trip_id = 'T3'""",
    )
    [(shape_id, length_m, length_src)] = shape
    assert shape_id.startswith("stops-")
    assert length_m == pytest.approx(4 * 676.9, rel=0.01)
    assert length_src == 3
    points = _rows(
        snapshot,
        """SELECT round(lon, 3), round(d) FROM {shape_points} JOIN {shapes_meta}
           USING (shape_idx) WHERE shape_id = '%s' ORDER BY i"""
        % shape_id,
    )
    assert [p[0] for p in points] == pytest.approx([13.44, 13.43, 13.42, 13.41, 13.4])
    # Each stop lies on it where the stops put it, never projected.
    along = _rows(
        snapshot,
        """SELECT round(p.d) FROM {pattern_shape_stops} p JOIN {trips} t
           USING (pattern_idx, shape_idx) WHERE t.trip_id = 'T3' ORDER BY p.i""",
    )
    assert [a[0] for a in along] == [round(p[1]) for p in points]
    # The same id the importer gives the line in the bundle's shape_lines, so
    # the map's tiles draw it.
    archive = tmp_path / "mini_gtfs.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for f in sorted(FIXTURE.iterdir()):
            zf.write(f, f.name)
    work = tmp_path / "work"
    work.mkdir()
    lines = next(
        layer.file_path
        for layer in GtfsImporter().extract_layers(str(archive), str(work))
        if layer.role == "shape_lines"
    )
    member = {
        r[0]
        for r in duckdb.connect()
        .execute(f"SELECT shape_id FROM read_parquet('{lines}')")
        .fetchall()
    }
    assert {
        r[0] for r in _rows(snapshot, "SELECT shape_id FROM {shapes_meta}")
    } <= member


def test_an_empty_or_unknown_shape_id_counts_as_none(tmp_path: Path) -> None:
    # T1 names no shape ("") and T2 one the feed does not have: both are
    # drawn through their stops, the same line, and no phantom shape appears.
    root = tmp_path / "in"
    root.mkdir()
    archive = root / "mini_gtfs.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for f in sorted(FIXTURE.iterdir()):
            text = f.read_text()
            if f.name == "trips.txt":
                text = text.replace("R1,WK,T1,Fifth,0,,SH1", "R1,WK,T1,Fifth,0,,")
                text = text.replace("R1,WK,T2,Fifth,0,,SH1", "R1,WK,T2,Fifth,0,,GONE")
            zf.writestr(f.name, text)
    work = tmp_path / "work"
    work.mkdir()
    paths = {
        layer.role: layer.file_path
        for layer in GtfsImporter().extract_layers(str(archive), str(work))
    }
    out = tmp_path / "snapshot"
    out.mkdir()
    con = bound_duckdb(duckdb.connect(), str(work))
    build_snapshot(
        con,
        lambda role: f"read_parquet('{paths[role]}')" if role in paths else None,
        str(out),
    )
    rows = con.execute(
        f"""SELECT t.trip_id, m.shape_id FROM read_parquet('{out}/trips.parquet') t
            JOIN read_parquet('{out}/shapes_meta.parquet') m USING (shape_idx)
            WHERE t.trip_id IN ('T1', 'T2', 'T4') ORDER BY t.trip_id"""
    ).fetchall()
    assert rows[0][1] == rows[1][1] and rows[0][1].startswith("stops-")
    assert rows[2] == ("T4", "SH1")
    assert con.execute(
        f"SELECT count(*) FROM read_parquet('{out}/shapes_meta.parquet') WHERE shape_id = ''"
    ).fetchone() == (0,)


@pytest.mark.parametrize("layout", ["points", "lines_as_shapes"])
def test_shapes_read_alike_however_the_bundle_keeps_them(
    snapshot: Dict[str, Any], tmp_path: Path, layout: str
) -> None:
    # Newer imports keep the GTFS points and a shape_lines member (the module
    # snapshot); a bundle may have the points alone, or, imported earlier, one
    # line per shape as its shapes member. The lines through the stops come
    # out alike too: the snapshot draws them from the stops, member or not.
    root = tmp_path / "in"
    root.mkdir()
    archive = root / "mini_gtfs.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for f in sorted(FIXTURE.iterdir()):
            zf.write(f, f.name)
    work = root / "work"
    work.mkdir()
    paths = {
        layer.role: layer.file_path
        for layer in GtfsImporter().extract_layers(str(archive), str(work))
    }
    if layout == "points":
        del paths["shape_lines"]
    else:
        paths["shapes"] = paths.pop("shape_lines")
    out = tmp_path / "snapshot"
    out.mkdir()
    con = bound_duckdb(duckdb.connect(), str(work))
    manifest = build_snapshot(
        con,
        lambda role: f"read_parquet('{paths[role]}')" if role in paths else None,
        str(out),
    )
    expected = {None if layout == "points" else "shapes"}
    assert {manifest["shape_lines_role"]} == expected
    for name in ("shape_points", "pattern_shape_stops"):
        rows = con.execute(
            f"SELECT * FROM read_parquet('{out}/{name}.parquet') ORDER BY ALL"
        ).fetchall()
        assert rows == _rows(snapshot, f"SELECT * FROM {{{name}}} ORDER BY ALL"), name
    # A shape's length: from its points where there are any, else from the
    # simplified line — within a metre of each other.
    (length,) = con.execute(
        f"SELECT length_m FROM read_parquet('{out}/shapes_meta.parquet')"
    ).fetchone()
    assert length == pytest.approx(3332.5, abs=1)
