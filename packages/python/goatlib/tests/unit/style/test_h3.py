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
    return {"version": "1.0.0", "kind": "vector", "render": {"type": "h3", **render}}


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


def test_the_margin_covers_two_and_a_half_edges_and_grows_towards_the_poles() -> None:
    lat, lng = tile_margin_degrees(8, 0)
    assert lat == pytest.approx(2.5 * 0.531414 / 111.32, rel=0.01)
    assert lng == pytest.approx(lat, rel=0.01)
    assert tile_margin_degrees(8, 60)[1] == pytest.approx(2 * lat, rel=0.01)


def test_the_margin_reaches_across_the_widest_hexagons(duck) -> None:
    """A tile reads the points of every hexagon that touches it: as far as a
    hexagon is wide. The widest are about 1.1 times two average edges (central
    Europe 0.9 to 1.0, Madrid 1.04), so two edges missed points of the far
    side of some border cells."""
    for res in AUTO_RESOLUTIONS:
        widest = duck.execute(
            f"""
            WITH c AS (
                SELECT unnest(h3_grid_disk(h3_latlng_to_cell(lat, lng, {res}), 3)) AS cell
                FROM (VALUES (40.4, -3.7), (0.0, 20.0), (65.0, 30.0), (-30.0, 140.0)) v(lat, lng)
            ), g AS (
                SELECT ST_GeomFromText(h3_cell_to_boundary_wkt(cell)) AS h,
                       h3_cell_to_lat(cell) AS lat FROM c
            )
            SELECT max(greatest(ST_YMax(h) - ST_YMin(h),
                                (ST_XMax(h) - ST_XMin(h)) * cos(radians(lat))))
            FROM g
            """
        ).fetchone()[0]
        assert widest < tile_margin_degrees(res, 0)[0]


# A point in Berlin whose res-10 cell's res-5 parent (851f18b3fffffff) does not
# contain it; its own res-5 cell does.
STRAY = (13.374887889918698, 52.49010891250051)


def test_a_point_counts_in_the_hexagon_that_contains_it(duck) -> None:
    lng, lat = STRAY
    duck.execute(f"CREATE TABLE stray AS SELECT ST_Point({lng}, {lat}) AS geom")

    ((cell, _, _),) = duck.execute(
        cell_values_sql("stray", "geom", "count", None, 5)
    ).fetchall()

    assert duck.execute(
        f"SELECT h3_h3_to_string({cell}::UBIGINT) <> '851f18b3fffffff', "
        f"ST_Contains(ST_GeomFromText(h3_cell_to_boundary_wkt({cell}::UBIGINT)), "
        f"ST_Point({lng}, {lat}))"
    ).fetchone() == (True, True)


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
def test_classes_are_computed_from_the_cells_the_tiles_draw(duck, op) -> None:
    value = {"op": op} if op == "count" else {"op": op, "field": "pop"}
    out, _ = compute_into(
        duck, "t", doc(value=value), geometry="point", fingerprint="f"
    )
    for res in AUTO_RESOLUTIONS:
        sql = cell_values_sql("t", "geom", op, value.get("field"), res)
        rows = [v for _, v, _ in duck.execute(sql).fetchall()]
        stored = out["render"]["computed"]["resolutions"][str(res)]
        assert (stored["min"], stored["max"]) == pytest.approx((min(rows), max(rows)))


def test_h3_extrude() -> None:
    from goatlib.style.models.layer import VectorStyle

    from .conftest import codes

    doc: dict = {
        "version": "1.0.0",
        "kind": "vector",
        "geometry": "point",
        "render": {
            "type": "h3",
            "value": {"op": "sum", "field": "pupils"},
            "extrude": {"tallest": 1700, "scale": "sqrt"},
        },
    }
    assert codes(VectorStyle, doc) == []
    doc["render"]["extrude"] = {"tallest": {"zoom": [[8, 3000], [13, 600]]}, "base": 20}
    assert codes(VectorStyle, doc) == []
    doc["render"]["extrude"] = {"scale": "log"}
    assert codes(VectorStyle, doc) == ["invalid_value"]
    # Columns chart a value over hexagons up to ~20 km wide: far taller than a
    # building (polygon heights stop at 5000 m).
    doc["render"]["extrude"] = {"tallest": {"zoom": [[5, 60000], [13, 600]]}}
    assert codes(VectorStyle, doc) == []
    doc["render"]["extrude"] = {"tallest": 200001}
    assert codes(VectorStyle, doc) == ["invalid_value"]
    doc["render"]["extrude"] = {"tallest": {"field": "x", "range": [0, 100]}}
    assert codes(VectorStyle, doc) == ["value_form_not_allowed"]


def test_extrude_only_on_h3_renders() -> None:
    from goatlib.style.models.layer import VectorStyle

    from .conftest import codes

    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "render": {"type": "heatmap", "extrude": {}},
    }
    assert codes(VectorStyle, doc) == ["unknown_key"]


def test_h3_extrude_defaults() -> None:
    from goatlib.style.defaults import REFERENCE_DEFAULTS

    assert REFERENCE_DEFAULTS["h3.extrude.tallest"] == 1000
    assert REFERENCE_DEFAULTS["h3.extrude.base"] == 0
    assert REFERENCE_DEFAULTS["h3.extrude.scale"] == "sqrt"


def test_columns_over_manual_classes_need_the_cell_range(duck) -> None:
    manual = {"method": "manual", "classes": [{"to": 3}, {"from": 3}]}
    style = doc(resolution=8, classify=manual, extrude={"tallest": 500})
    assert computed_missing(style)
    out, _ = compute_into(duck, "t", style, geometry="point", fingerprint="f")
    assert out["render"]["computed"]["resolutions"]["8"] == {"min": 1, "max": 3}
    assert not computed_missing(out)
    assert [
        i.code for i in validate(out, DataContext(kind="vector", geometry="point"))
    ] == []
    assert needed_stats(
        doc(resolution=8, classify=manual, extrude={"tallest": 500})
    ) == [("h3", "count", "", "8", "", "")]


@pytest.mark.parametrize("op", ["count", "sum", "mean"])
def test_classes_count_the_points_inside_each_hexagon(duck, op) -> None:
    """Every resolution groups the points by their own cell. Rolled up from
    the finest resolution, a few percent of the points landed in a coarse
    hexagon that does not contain them."""
    lng, lat = STRAY
    duck.execute(f"INSERT INTO t VALUES (100, ST_Point({lng}, {lat}))")
    duck.execute(
        "INSERT INTO t SELECT 5, ST_Point(13.30 + i * 0.01, 52.45 + i * 0.002) FROM range(30) r(i)"
    )
    value = {"op": op} if op == "count" else {"op": op, "field": "pop"}
    agg = {"count": "count(*)", "sum": "sum(pop)", "mean": "avg(pop)"}[op]

    out, _ = compute_into(
        duck, "t", doc(value=value), geometry="point", fingerprint="f"
    )

    for res in AUTO_RESOLUTIONS:
        low, high = duck.execute(
            f"""
            SELECT min(v), max(v) FROM (
                SELECT h3_latlng_to_cell(ST_Y(geom), ST_X(geom), {res}) AS cell,
                       CAST({agg} AS DOUBLE) AS v
                FROM t GROUP BY cell
            ) WHERE v IS NOT NULL
            """
        ).fetchone()
        stored = out["render"]["computed"]["resolutions"][str(res)]
        assert (stored["min"], stored["max"]) == pytest.approx((low, high)), res
