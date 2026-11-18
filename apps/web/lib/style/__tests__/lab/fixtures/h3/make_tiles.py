"""Makes the style lab's H3 fixture tiles from synthetic points, with geoapi's
own tile code, and the styles the lab draws over them with the values goatlib
computes for them.

The points sit at the middles of the resolution 8 hexagons around the lab
map's center [0, 0]: each hexagon holds a known number of points (its count)
that all carry one `pop` value (its mean), so every hexagon's value is known.

- {key}/{z}/{x}/{y}.pbf: the tiles of the view the lab's scenes draw, as
  geoapi answers the hexagon request `key` names: `h3_tile_query` for the
  hexagons (h3-auto-count, h3-auto-mean-pop), `_generate_dynamic_tile` for the
  points themselves (points). A tile without features is not written: geoapi
  answers it empty.
- styles.json: the lab's H3 styles with `render.computed` written in by
  goatlib's statistics over the same points (`apply_computed`), as the server
  computes them.
- facts.json: each hexagon's index, middle, count and `pop`, and the zooms.

apps/geoapi/tests/test_h3_lab_fixture.py makes a stored hexagon tile again with
geoapi's code and fails once what it holds differs: then run this again.

Run from the repository root, then format the JSON as the web app does:
    uv run --no-sync python apps/web/lib/style/__tests__/lab/fixtures/h3/make_tiles.py
    pnpm --filter @p4b/web exec prettier --write "lib/style/__tests__/lab/fixtures/h3/*.json"
"""

import importlib
import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import duckdb

# geoapi builds its settings at import and asks for a sign-in server unless
# sign-in is off; the tile code reads none of it.
os.environ["AUTH"] = "False"

from geoapi.services.tile_service import h3_tile_query  # noqa: E402
from goatlib.style.compute import apply_computed, needed_stats  # noqa: E402
from goatlib.style.data import compute_stats  # noqa: E402

HERE = Path(__file__).resolve().parent
#: The zoom the hexagon scenes draw at ("auto" draws resolution 8 there) and the
#: zoom the points take over from (`points_from_zoom`).
ZOOM = 12
POINTS_ZOOM = 13
RESOLUTION = 8
#: How many rings of hexagons around the middle one hold points: past the edges
#: of the lab's map at ZOOM.
RINGS = 9
#: A hexagon's count and `pop` cycle through these, by its place among the
#: hexagons sorted by index: neighbours get different values.
COUNTS = 9
POPS = 17
POP_STEP = 10

STYLES = {
    # Classes of the count, computed by the server.
    "classes": {
        "version": 1,
        "kind": "vector",
        "geometry": "point",
        "render": {
            "type": "h3",
            "value": {"op": "count"},
            "classify": {"method": "equal_interval", "count": 4},
            "points_from_zoom": POINTS_ZOOM,
        },
    },
    # The palette over the range of the mean of a field.
    "ramp": {
        "version": 1,
        "kind": "vector",
        "geometry": "point",
        "render": {"type": "h3", "value": {"op": "mean", "field": "pop"}},
    },
}

#: The tile requests the lab answers: the hexagons of a value at ZOOM, the
#: points at POINTS_ZOOM.
REQUESTS = {
    "h3-auto-count": ("count", None, ZOOM),
    "h3-auto-mean-pop": ("mean", "pop", ZOOM),
    "points": (None, None, POINTS_ZOOM),
}


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    # One thread: rows come out in one order, so the tiles are the same bytes on
    # every run.
    con.execute("SET threads TO 1")
    con.execute("INSTALL spatial; LOAD spatial; INSTALL h3 FROM community; LOAD h3;")
    return con


def make_points(con: duckdb.DuckDBPyConnection) -> list[dict]:
    """The hexagons and their points in table `pts`; the hexagons' facts."""
    rows = con.execute(
        f"""
        SELECT h3_h3_to_string(cell) AS cell, h3_cell_to_lng(cell), h3_cell_to_lat(cell)
        FROM (SELECT unnest(h3_grid_disk(h3_latlng_to_cell(0, 0, {RESOLUTION}), {RINGS})) AS cell)
        ORDER BY cell
        """
    ).fetchall()
    cells = [
        {
            "cell": cell,
            "lng": lng,
            "lat": lat,
            "count": 1 + i % COUNTS,
            "pop": POP_STEP * (i % POPS),
        }
        for i, (cell, lng, lat) in enumerate(rows)
    ]
    con.execute("CREATE TABLE pts (geometry GEOMETRY, pop DOUBLE)")
    con.executemany(
        "INSERT INTO pts VALUES (ST_Point(?, ?), ?)",
        [(c["lng"], c["lat"], c["pop"]) for c in cells for _ in range(c["count"])],
    )
    return cells


def tiles_around_center(z: int) -> list[tuple[int, int]]:
    """The four tiles that meet at [0, 0]: the lab's map at z shows no other."""
    half = 2 ** (z - 1)
    return [(x, y) for x in (half - 1, half) for y in (half - 1, half)]


def hexagon_tile(
    con: duckdb.DuckDBPyConnection, z: int, x: int, y: int, op: str, field: str | None
) -> bytes | None:
    sql, params = h3_tile_query(
        "pts", "geometry", z, x, y, "auto", op, field, extra_where_sql="", params=[]
    )
    row = con.execute(sql, params).fetchone()
    return bytes(row[0]) if row and row[0] else None


def point_tile(con: duckdb.DuckDBPyConnection, z: int, x: int, y: int) -> bytes | None:
    """geoapi's tile of the points themselves, its DuckLake pool answered by the
    connection."""
    service = importlib.import_module("geoapi.services.tile_service")
    service.ducklake_pool.execute_with_retry = (
        lambda sql, params=None, **_: con.execute(sql, params or []).fetchone()
    )
    return service.TileService()._generate_dynamic_tile(
        layer_info=SimpleNamespace(full_table_name="pts", table_name="pts"),
        z=z,
        x=x,
        y=y,
        columns=[
            {"name": "geometry", "type": "GEOMETRY"},
            {"name": "pop", "type": "DOUBLE"},
        ],
        geometry_type="point",
    )


def computed(con: duckdb.DuckDBPyConnection, style: dict) -> dict:
    out, notes = apply_computed(
        style,
        compute_stats(con, "pts", needed_stats(style)),
        geometry="point",
        fingerprint="style-lab",
        at="2026-01-01T00:00:00Z",
    )
    if notes:
        raise RuntimeError(f"computing the style gave notes: {notes}")
    return out


def main() -> None:
    con = connect()
    cells = make_points(con)
    for key, (op, field, z) in REQUESTS.items():
        shutil.rmtree(HERE / key, ignore_errors=True)
        for x, y in tiles_around_center(z):
            tile = (
                point_tile(con, z, x, y)
                if op is None
                else hexagon_tile(con, z, x, y, op, field)
            )
            if tile:
                path = HERE / key / str(z) / str(x) / f"{y}.pbf"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(tile)
    styles = {name: computed(con, style) for name, style in STYLES.items()}
    (HERE / "styles.json").write_text(json.dumps(styles, indent=2) + "\n")
    facts = {"zoom": ZOOM, "points_zoom": POINTS_ZOOM, "cells": cells}
    (HERE / "facts.json").write_text(json.dumps(facts, indent=2) + "\n")


if __name__ == "__main__":
    main()
