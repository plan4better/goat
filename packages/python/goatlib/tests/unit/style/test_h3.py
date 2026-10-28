"""H3 hexagons (spec 8.3): the auto resolution, the statistics per resolution and where they are stored."""

import duckdb
import pytest
from goatlib.style.compute import computed_missing, needed_stats, same_ignoring_stamps
from goatlib.style.context import DataContext
from goatlib.style.data import compute_into
from goatlib.style.fingerprint import is_stale
from goatlib.style.h3 import (
    AUTO_RESOLUTIONS,
    auto_resolution,
    cell_values_sql,
    resolutions_of,
    tile_margin_degrees,
)
from goatlib.style.validate import validate


def doc(**render: object) -> dict:
    return {"version": 1, "kind": "vector", "render": {"type": "h3", **render}}


@pytest.fixture
def duck() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial; INSTALL h3 FROM community; LOAD h3;")
    con.execute("CREATE TABLE t (pop DOUBLE, geom GEOMETRY)")
    # Three points in one res-8 cell in Berlin, one in another, one far away.
    con.execute(
        "INSERT INTO t VALUES "
        "(1, ST_Point(13.4000, 52.5200)), (2, ST_Point(13.4001, 52.5201)), "
        "(3, ST_Point(13.4002, 52.5199)), (10, ST_Point(13.5000, 52.5700)), "
        "(NULL, ST_Point(11.58, 48.14))"
    )
    return con


def test_auto_resolution_follows_the_zoom() -> None:
    got = {z: auto_resolution(z) for z in (0, 7, 8, 9, 10, 11, 12, 13, 14, 22)}
    assert got == {0: 5, 7: 5, 8: 6, 9: 6, 10: 7, 11: 8, 12: 8, 13: 9, 14: 10, 22: 10}
    assert AUTO_RESOLUTIONS == (5, 6, 7, 8, 9, 10)


def test_resolutions_of_a_render() -> None:
    assert resolutions_of({"type": "h3"}) == AUTO_RESOLUTIONS
    assert resolutions_of({"type": "h3", "resolution": "auto"}) == AUTO_RESOLUTIONS
    assert resolutions_of({"type": "h3", "resolution": 8}) == (8,)


def test_the_margin_covers_two_edges_and_grows_towards_the_poles() -> None:
    lat, lng = tile_margin_degrees(8, 0)
    assert lat == pytest.approx(2 * 0.531414 / 111.32, rel=0.01)
    assert lng == pytest.approx(lat, rel=0.01)
    assert tile_margin_degrees(8, 60)[1] == pytest.approx(2 * lat, rel=0.01)


def test_cell_values_count_sum_and_mean(duck) -> None:
    def rows(op: str, field: str | None = None) -> list[tuple[float, int]]:
        sql = cell_values_sql("t", "geom", op, field, 8)
        return sorted((v, n) for _, v, n in duck.execute(sql).fetchall())

    # (value, points): the cell with three points, the one with one, and the
    # point without pop, which counts but has no sum or mean.
    assert rows("count") == [(1, 1), (1, 1), (3, 3)]
    assert rows("sum", "pop") == [(6, 3), (10, 1)]
    assert rows("mean", "pop") == [(2, 3), (10, 1)]


def test_an_auto_render_needs_statistics_for_every_auto_resolution() -> None:
    keys = needed_stats(doc(classify={"method": "quantile", "count": 4}))
    assert keys == [
        ("h3", "count", "", str(r), "quantile", "4") for r in AUTO_RESOLUTIONS
    ]
    assert needed_stats(doc(resolution=8, value={"op": "mean", "field": "pop"})) == [
        ("h3", "mean", "pop", "8", "", "")
    ]
    # Manual classes are the author's: nothing to compute for the classes, but
    # nothing for the colors either (they have from and to).
    assert (
        needed_stats(
            doc(
                resolution=8,
                classify={"method": "manual", "classes": [{"to": 3}, {"from": 3}]},
            )
        )
        == []
    )


def test_compute_into_stores_one_stamp_and_values_per_resolution(duck) -> None:
    style = doc(resolution=8, classify={"method": "equal_interval", "count": 2})
    assert computed_missing(style)
    out, notes = compute_into(
        duck, "t", style, geometry="point", fingerprint="ducklake:1"
    )
    computed = out["render"]["computed"]
    assert computed["data"] == "ducklake:1" and computed["scope"] == "dataset"
    assert computed["resolutions"]["8"]["min"] == 1
    assert computed["resolutions"]["8"]["max"] == 3
    assert computed["resolutions"]["8"]["breaks"] == [2]
    assert not computed_missing(out)
    assert not is_stale(out, "ducklake:1")
    assert is_stale(out, "ducklake:2")
    assert notes == []
    again, _ = compute_into(duck, "t", out, geometry="point", fingerprint="ducklake:1")
    assert same_ignoring_stamps(again, out)
    assert [
        i.code for i in validate(out, DataContext(kind="vector", geometry="point"))
    ] == []


def test_continuous_colors_store_the_range_only(duck) -> None:
    out, _ = compute_into(
        duck,
        "t",
        doc(resolution=8, value={"op": "sum", "field": "pop"}),
        geometry="point",
        fingerprint="f",
    )
    assert out["render"]["computed"]["resolutions"]["8"] == {"min": 6, "max": 10}


def test_an_auto_style_misses_values_while_a_resolution_is_absent(duck) -> None:
    out, _ = compute_into(duck, "t", doc(), geometry="point", fingerprint="f")
    assert set(out["render"]["computed"]["resolutions"]) == {
        str(r) for r in AUTO_RESOLUTIONS
    }
    assert not computed_missing(out)
    del out["render"]["computed"]["resolutions"]["7"]
    assert computed_missing(out)


def test_a_geometry_with_a_crs_is_read_too(duck) -> None:
    # Catalog layers are parquet views whose geometry type names its CRS.
    duck.execute(
        "CREATE TABLE crs AS SELECT pop, geom::GEOMETRY('OGC:CRS84') AS geom FROM t"
    )
    out, _ = compute_into(
        duck, "crs", doc(resolution=8), geometry="point", fingerprint="f"
    )
    assert out["render"]["computed"]["resolutions"]["8"] == {"min": 1, "max": 3}


def test_a_relation_without_geometry_stores_empty_resolutions() -> None:
    con = duckdb.connect()
    con.execute("CREATE TABLE plain AS SELECT 1 AS pop")
    out, _ = compute_into(
        con, "plain", doc(resolution=8), geometry="point", fingerprint="f"
    )
    assert out["render"]["computed"]["resolutions"] == {"8": {}}
    assert not computed_missing(out)


@pytest.mark.parametrize("op", ["count", "sum", "mean"])
def test_coarser_resolutions_roll_up_to_what_grouping_the_points_gives(
    duck, op
) -> None:
    value = {"op": op} if op == "count" else {"op": op, "field": "pop"}
    out, _ = compute_into(
        duck, "t", doc(value=value), geometry="point", fingerprint="f"
    )
    for res in AUTO_RESOLUTIONS:
        sql = cell_values_sql("t", "geom", op, value.get("field"), res)
        rows = [v for _, v, _ in duck.execute(sql).fetchall()]
        stored = out["render"]["computed"]["resolutions"][str(res)]
        assert (stored["min"], stored["max"]) == pytest.approx((min(rows), max(rows)))
