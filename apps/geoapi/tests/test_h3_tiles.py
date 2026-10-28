"""H3 hexagon tiles (style render "h3"): the cells a tile draws and their values."""

import duckdb
import pytest

from geoapi.routers.tiles import build_tile_etag_seed
from geoapi.services.tile_service import (
    h3_tile_cells_sql,
    h3_tile_query,
    tile_to_bbox_4326,
)


@pytest.fixture
def duck() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial; INSTALL h3 FROM community; LOAD h3;")
    # A grid of points around the border of two z12 tiles in Berlin, with a value.
    con.execute(
        "CREATE TABLE pts AS SELECT ST_Point(13.358125 + i * 0.002, 52.50 + j * 0.002) AS geometry, "
        "(i + j)::DOUBLE AS pop FROM range(40) a(i), range(20) b(j)"
    )
    return con


def _tile_of(z: int, lng: float, lat: float) -> tuple[int, int]:
    import math

    n = 2**z
    x = int((lng + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def _cells(con, z, x, y, op="count", field=None, resolution="auto"):
    sql, params = h3_tile_cells_sql(
        "pts", "geometry", z, x, y, resolution, op, field, extra_where_sql="", params=[]
    )
    return {
        cell: (value, n, res)
        for cell, value, n, res in con.execute(sql, params).fetchall()
    }


def test_neighbouring_tiles_agree_on_the_cells_they_share(duck) -> None:
    z = 12
    x, y = _tile_of(z, 13.398125, 52.52)
    west = _cells(duck, z, x, y)
    east = _cells(duck, z, x + 1, y)
    shared = set(west) & set(east)
    assert shared, "no cell crosses the tile border"
    for cell in shared:
        assert west[cell] == east[cell]
    # z12 draws resolution 8 under auto.
    assert {res for _, _, res in west.values()} == {8}


def test_only_cells_touching_the_tile_are_drawn(duck) -> None:
    z = 12
    x, y = _tile_of(z, 13.398125, 52.52)
    xmin, ymin, xmax, ymax = tile_to_bbox_4326(z, x, y)
    sql, params = h3_tile_cells_sql(
        "pts", "geometry", z, x, y, 8, "count", None, extra_where_sql="", params=[]
    )
    for (inside,) in duck.execute(
        f"SELECT ST_Intersects(ST_GeomFromText(h3_cell_to_boundary_wkt(h3_string_to_h3(cell))), "
        f"ST_MakeEnvelope({xmin}, {ymin}, {xmax}, {ymax})) FROM ({sql})",
        params,
    ).fetchall():
        assert inside


def test_sum_and_mean_read_the_field(duck) -> None:
    z = 12
    x, y = _tile_of(z, 13.398125, 52.52)
    counts = _cells(duck, z, x, y, resolution=8)
    sums = _cells(duck, z, x, y, op="sum", field="pop", resolution=8)
    means = _cells(duck, z, x, y, op="mean", field="pop", resolution=8)
    for cell, (n, _, _) in counts.items():
        assert sums[cell][0] == pytest.approx(means[cell][0] * n)


def test_the_tile_is_a_vector_tile_with_an_h3_layer(duck) -> None:
    z = 12
    x, y = _tile_of(z, 13.398125, 52.52)
    sql, params = h3_tile_query(
        "pts", "geometry", z, x, y, "auto", "count", None, extra_where_sql="", params=[]
    )
    tile = duck.execute(sql, params).fetchone()[0]
    assert tile and b"h3" in bytes(tile)
    empty_sql, empty_params = h3_tile_query(
        "pts",
        "geometry",
        12,
        0,
        0,
        "auto",
        "count",
        None,
        extra_where_sql="",
        params=[],
    )
    assert duck.execute(empty_sql, empty_params).fetchone() is None


def test_the_etag_seed_keys_on_the_h3_request() -> None:
    seed = build_tile_etag_seed("layer1", 3, h3="auto:sum:pop")
    assert seed == "layer1:3:h=auto:sum:pop"
    assert build_tile_etag_seed("layer1", 3) == "layer1:3"


def test_h3_requests_need_points_and_a_numeric_field_for_sum_and_mean() -> None:
    from fastapi import HTTPException

    from geoapi.routers.tiles import check_h3_request

    columns = [{"name": "pop", "type": "DOUBLE"}, {"name": "name", "type": "VARCHAR"}]
    check_h3_request("count", None, columns, "point")
    check_h3_request("sum", "pop", columns, "multipoint")
    for op, field, geometry in [
        ("count", None, "polygon"),
        ("sum", None, "point"),
        ("mean", "missing", "point"),
        ("mean", "name", "point"),
    ]:
        with pytest.raises(HTTPException) as err:
            check_h3_request(op, field, columns, geometry)
        assert err.value.status_code == 400


def test_h3_tiles_count_only_the_requested_features(duck, monkeypatch) -> None:
    """An atlas page asks for its feature's hexagon alone (`ids`)."""
    import asyncio
    import importlib
    from types import SimpleNamespace

    from goatlib.storage.query_builder import build_filters

    service = importlib.import_module("geoapi.services.tile_service")

    def execute(sql, params=None, **_):
        return duck.execute(sql, params or []).fetchone()

    monkeypatch.setattr(service.ducklake_pool, "execute_with_retry", execute)
    z = 12
    x, y = _tile_of(z, 13.398125, 52.52)
    (rowid,) = duck.execute(
        "SELECT rowid FROM pts WHERE abs(ST_X(geometry) - 13.398125) < 1e-9 "
        "AND abs(ST_Y(geometry) - 52.52) < 1e-9"
    ).fetchone()
    feature = str(rowid + 1)

    async def tile(ids):
        return await service.TileService().get_h3_tile(
            layer_info=SimpleNamespace(full_table_name="pts"),
            z=z,
            x=x,
            y=y,
            resolution="8",
            op="count",
            field=None,
            column_names=["geometry", "pop"],
            ids=ids,
        )

    one = build_filters(ids=[feature], column_names=["geometry", "pop"])
    sql, params = h3_tile_query(
        "pts", "geometry", z, x, y, "8", "count", None, one.to_where_sql(), one.params
    )
    expected = bytes(duck.execute(sql, params).fetchone()[0])
    assert asyncio.run(tile([feature])) == expected
    assert asyncio.run(tile(None)) != expected


def test_feature_ids_are_for_h3_tiles() -> None:
    from fastapi import HTTPException

    from geoapi.routers.tiles import tile_feature_ids

    assert tile_feature_ids(None, None) is None
    assert tile_feature_ids("4,12", "auto") == ["4", "12"]
    with pytest.raises(HTTPException) as err:
        tile_feature_ids("4", None)
    assert err.value.status_code == 400
