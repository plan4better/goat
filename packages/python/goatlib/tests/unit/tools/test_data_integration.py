"""Tag filters compiled to SQL.

The part with logic in it: a tag condition becomes two tests, and both have to
agree. `LIKE '%amenity%'` would match `amenity:parking`, and a value typed by a
user reaches a string literal.
"""

import pytest
from goatlib.tools import data_integration as module
from goatlib.tools.data_integration import FEATURE_TYPES, TagFilter, _tag_sql


def test_a_key_and_value_match_the_whole_pair() -> None:
    pre, exact = _tag_sql([TagFilter(key="amenity", values=["restaurant"])])
    # The quotes are what stop `amenity` matching `amenity:parking`; the
    # alternation is what lets one key carry several values.
    assert pre == 'regexp_matches(all_tags, \'"amenity"=>"(restaurant)"\')'
    assert exact == "tags['amenity'] IN ('restaurant')"


def test_a_key_alone_matches_any_value() -> None:
    pre, exact = _tag_sql([TagFilter(key="amenity")])
    assert pre.endswith("'\"amenity\"=>')")
    assert exact == "map_contains(tags, 'amenity')"


def test_no_filter_keeps_everything_in_the_area() -> None:
    assert _tag_sql([]) == ("TRUE", "TRUE")


@pytest.mark.parametrize("value", ["O'Brien", "a'); DROP TABLE t; --"])
def test_a_quote_cannot_end_the_literal(value) -> None:
    _, exact = _tag_sql([TagFilter(key="name", values=[value])])
    # Doubled, so it stays inside its own quotes.
    assert "''" in exact and exact.count("'") % 2 == 0


def test_every_feature_type_names_a_geometry() -> None:
    assert set(FEATURE_TYPES) == {"points", "lines", "multipolygons"}
    # Each layer carries the licence of what it holds, not one for every source.
    osm, ov = module.SOURCES["osm"], module.SOURCES["overture"]
    assert osm.licence_of("points") == ("ODbL-1.0", "© OpenStreetMap contributors")
    assert ov.licence_of("places")[0] == "CDLA-Permissive-2.0"
    assert ov.licence_of("buildings")[0] == ov.licence_of("waterways")[0] == "ODbL-1.0"
    # And the lineage reads as a sentence, not as mirror bookkeeping.
    f = [TagFilter(key="amenity", values=["school", "kindergarten"])]
    assert module.lineage_text(osm, "points", [("austria", "20261011"), ("germany", "20261010")], f) == (
        "OpenStreetMap data for Austria and Germany, as of 11 Oct 2026. "
        "Only features where amenity is school or kindergarten."
    )
    assert module.lineage_text(ov, "buildings", [("buildings", "2026-09-23.1")], []) == (
        "Overture Maps buildings, release 2026-09-23.1."
    )


def test_the_cache_key_changes_with_the_snapshot(tmp_path, monkeypatch) -> None:
    """Building the tag list costs ten seconds, so it is kept. Keeping it across
    a new weekly mirror would answer this week's question from last week's data."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    env = (11.5, 48.1, 11.6, 48.2)
    last = module._tag_cache_path("layer-1", "points", [("germany", "20260921")], env)
    this = module._tag_cache_path("layer-1", "points", [("germany", "20260928")], env)
    assert last != this
    # And a different area, or a different geometry, is a different question.
    assert last != module._tag_cache_path("layer-2", "points", [("germany", "20260921")], env)
    assert last != module._tag_cache_path("layer-1", "lines", [("germany", "20260921")], env)


def test_the_join_between_filters_is_chosen() -> None:
    """Two conditions on one key can never both hold, so AND silently returns
    nothing — which is exactly how someone asks for restaurants or cafes."""
    f = [TagFilter(key="amenity", values=["restaurant"]), TagFilter(key="amenity", values=["cafe"])]
    src = module.SOURCES["osm"]
    assert " AND " in module.filter_sql(f, src, "all")[1]
    assert " OR " in module.filter_sql(f, src, "any")[1]


def test_the_prefilter_uses_the_same_join() -> None:
    """It runs before the parse, so an AND there would drop rows the exact
    test would have kept."""
    f = [TagFilter(key="amenity", values=["restaurant"]), TagFilter(key="shop", values=["bakery"])]
    pre, exact = module.filter_sql(f, module.SOURCES["osm"], "any")
    assert " OR " in pre and " OR " in exact


def test_several_values_on_one_key_are_any_of_them() -> None:
    """A feature has one value per key, so AND-ing two of them matches nothing —
    which is exactly how someone asks for restaurants or cafes."""
    f = [TagFilter(key="amenity", values=["restaurant", "cafe"])]
    pre, exact = module.filter_sql(f, module.SOURCES["osm"])
    assert exact == "tags['amenity'] IN ('restaurant', 'cafe')"
    # The prefilter runs first, so it has to admit both or the exact test never sees them.
    assert "(restaurant|cafe)" in pre


def test_only_indexed_files_touching_the_area(tmp_path) -> None:
    """The index decides which files are read, from each file's real bounds. A unit
    whose bbox misses the area is skipped without reading its index."""
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    base = tmp_path / "europe" / "20261005"
    base.mkdir(parents=True)
    con.execute(f"""COPY (SELECT * FROM (VALUES
        ('points/part-00000.parquet', 'points', 'europe', 11.0, 48.0, 12.0, 49.0, 10, 1),
        ('points/part-00001.parquet', 'points', 'europe', 30.0, 60.0, 31.0, 61.0, 10, 1),
        ('lines/part-00000.parquet', 'lines', 'europe', 11.0, 48.0, 12.0, 49.0, 10, 1)
        ) t(path, layer, continent, xmin, ymin, xmax, ymax, rows, bytes)) TO '{base}/_index.parquet' (FORMAT PARQUET)""")
    src = module.Source(str(tmp_path), "geom", "osm_id", True)
    units = {"europe": {"version": "20261005", "bbox": [-25, 34, 45, 72]},
             "africa": {"version": "20261005", "bbox": [-20, -35, 52, 37]}}
    env = (11.5, 48.1, 11.6, 48.2)
    files, read = module.covering(con, units, src, "points", env)
    assert files == [f"{base}/points/part-00000.parquet"] and read == [("europe", "20261005")]
    # A unit without an index is left out, not every other unit with it.
    unindexed = {**units, "alps": {"version": "20261005", "bbox": [5, 45, 17, 49]}}
    assert module.covering(con, unindexed, src, "points", env)[0] == files
    # A version's index is read once: deleted, the same files still come back.
    (base / "_index.parquet").unlink()
    assert module.covering(con, units, src, "points", env)[0] == files
    # The bbox predicate is what skips row groups; ST_Intersects alone reads them all.
    sql = module.candidates_sql(files, src, env, "TRUE")
    assert "bbox.xmin <= 11.6" in sql and "bbox.ymax >= 48.1" in sql

    # A base type mixes geometries; each option keeps one, so the layer has one type.
    ov = module.SOURCES["overture"]
    assert (ov.unit_of("waterways"), ov.layer_of("waterways"), ov.geometry_of("waterways")) == ("base", "water", "line")
    assert "LINESTRING" in ov.geometry_filter("waterways") and "POLYGON" not in ov.geometry_filter("waterways")
    # A split mirror holds the geometry in the layer: no geometry is read then.
    assert ov.split_layer_of("waterways") == "water_line" and ov.split_layer_of("places") is None
    assert ov.geometry_filter("waterways", ["s3://m/base/v/austria/water_line.parquet"]) == "TRUE"
    assert src.geometry_filter("points") == "TRUE"

    # Overture's mirror puts the version on top: the pointer's path says where.
    first = tmp_path / "v2" / "europe"
    first.mkdir(parents=True)
    con.execute(f"""COPY (SELECT 'points/germany.parquet' AS path, 'points' AS layer, 'europe' AS continent,
        11.0 AS xmin, 48.0 AS ymin, 12.0 AS xmax, 49.0 AS ymax, 10 AS rows, 1 AS bytes)
        TO '{first}/_index.parquet' (FORMAT PARQUET)""")
    files, read = module.covering(con, {"europe": {"version": "v2", "path": "v2/europe"}}, src, "points", env)
    assert files == [f"{first}/points/germany.parquet"] and read == [("europe", "v2")]

    # No pointer yet means no data here, not a crash.
    assert module.pointer(con, module.Source(str(tmp_path / "nowhere"), "geom", "osm_id", True)) == {}
    assert module.pointer(con, module.Source("", "geom", "osm_id", True)) == {}

    # Overture's nested name and sources become plain columns the tiles keep:
    # distinct datasets in order, licences without the missing one, NULL when absent.
    src_type = "STRUCT(dataset VARCHAR, license VARCHAR, record_id VARCHAR, update_time VARCHAR)[]"
    data = tmp_path / "overture.parquet"
    con.execute(f"""COPY (SELECT * FROM (VALUES
        ('a', {{'primary': 'Rathaus'}}::STRUCT("primary" VARCHAR),
         [{{'dataset': 'OpenStreetMap', 'license': 'ODbL-1.0', 'record_id': 'w1494403985@1',
            'update_time': '2026-03-30T18:37:29Z'}},
          {{'dataset': 'Microsoft ML Buildings', 'license': NULL, 'record_id': 'm7',
            'update_time': '2025-01-01T00:00:00Z'}}]::{src_type}),
        ('b', NULL::STRUCT("primary" VARCHAR), []::{src_type})
        ) t(id, names, sources)) TO '{data}' (FORMAT PARQUET)""")
    cols = {str(r[0]): str(r[1]) for r in con.execute(f"DESCRIBE SELECT * FROM '{data}'").fetchall()}
    plain = ", ".join(module.overture_plain_columns(cols))
    rows = con.execute(f"SELECT id, {plain} FROM read_parquet('{data}') c ORDER BY id").fetchall()
    assert rows[0][1:4] == ("Rathaus", "OpenStreetMap; Microsoft ML Buildings", "ODbL-1.0")
    assert rows[0][4:] == ("w1494403985@1; m7", "2026-03-30T18:37:29Z")
    assert rows[1][1:] == (None, None, None, None, None)


def test_the_area_and_the_sql_are_checked(tmp_path) -> None:
    duckdb = pytest.importorskip("duckdb")
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    box = {"type": "Polygon", "coordinates": [[[11.5, 48.1], [11.6, 48.1], [11.6, 48.2], [11.5, 48.1]]]}
    assert module.area_envelope(con, module.area_table(con, box)) == (11.5, 48.1, 11.6, 48.2)
    with pytest.raises(ValueError, match="polygon"):
        module.area_table(con, {"type": "Point", "coordinates": [11.5, 48.1]})

    data = tmp_path / "p.parquet"
    con.execute(f"COPY (SELECT 1 AS osm_id, '' AS all_tags) TO '{data}' (FORMAT PARQUET)")
    src = module.SOURCES["osm"]
    ok = "tags['amenity'] IN ('school') AND tags['wheelchair'] IS NOT NULL"
    assert module.checked_where(con, [str(data)], src, ok) == f"({ok})"
    for bad in ["1=1; DROP TABLE t", "osm_id IN (SELECT 1)", "read_parquet('x') IS NULL"]:
        with pytest.raises(ValueError, match="not allowed"):
            module.checked_where(con, [str(data)], src, bad)

    # Tags as hstore text in one country and as a native map in another, as
    # mid-republish: both answer the same filter, and keys list the same way.
    text, mapped = tmp_path / "text.parquet", tmp_path / "map.parquet"
    env = (11.5, 48.1, 11.6, 48.2)
    bbox = "{'xmin': 11.5, 'ymin': 48.1, 'xmax': 11.5, 'ymax': 48.1}"
    con.execute(f"""COPY (SELECT 1 AS osm_id, '"amenity"=>"school","name"=>"A","check_date"=>"2024-05-01"' AS all_tags,
        {bbox} AS bbox, ST_Point(11.5, 48.1) AS geom) TO '{text}' (FORMAT PARQUET)""")
    con.execute(f"""COPY (SELECT 2 AS osm_id, MAP {{'amenity': 'school'}} AS tags,
        {bbox} AS bbox, ST_Point(11.5, 48.1) AS geom) TO '{mapped}' (FORMAT PARQUET)""")
    f = [TagFilter(key="amenity", values=["school"])]
    for files, storage in (([str(text)], "text"), ([str(mapped)], "map"), ([str(text), str(mapped)], "both")):
        assert module.tag_storage(module.mirror_columns(con, files)) == storage
        pre, exact = module.filter_sql(f, src, storage=storage)
        hits = con.execute(f"SELECT osm_id FROM ({module.candidates_sql(files, src, env, pre, storage)}) WHERE {exact}").fetchall()
        assert len(hits) == len(files)
        keys, _ = module._count_tags(con, module._raw_tags_sql(files, env, "TRUE", storage), None, 10, storage)
        assert keys[0] == ("amenity", len(files))
        assert not {"name", "check_date"} & {k for k, _ in keys}

    # A tag the files also hold as a column is counted from that column, if every file has it.
    col = tmp_path / "col.parquet"
    con.execute(f"""COPY (SELECT i AS osm_id, CASE WHEN i < 3 THEN 'primary' WHEN i < 4 THEN 'bus_stop' END AS highway,
        {bbox} AS bbox FROM range(6) t(i)) TO '{col}' (FORMAT PARQUET)""")
    assert module._key_column(con, [str(col)], "highway") and not module._key_column(con, [str(col), str(text)], "highway")
    assert module._column_counts(con, [str(col)], env, "highway", 10) == ([("primary", 3), ("bus_stop", 1)], 4)


def test_a_big_view(tmp_path, monkeypatch) -> None:
    import json

    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    base = tmp_path / "de" / "v1"
    base.mkdir(parents=True)
    (tmp_path / "_current.json").write_text(json.dumps({"units": {"de": {"version": "v1"}}}))
    # 40,000 points over 0.3°, sorted along y: 20 row groups of 2,048.
    con.execute(f"""COPY (SELECT i AS osm_id, 'P' || i AS name, CASE WHEN i % 4 = 0 THEN 'bus_stop' END AS highway,
            MAP {{'surface': CASE WHEN i % 2 = 0 THEN 'asphalt' ELSE 'gravel' END}} AS tags,
            {{'xmin': x, 'ymin': y, 'xmax': x, 'ymax': y}} AS bbox, ST_Point(x, y) AS geom
        FROM (SELECT i, 11 + (i % 200) * 0.0015 AS x, 48 + (i // 200) * 0.0015 AS y FROM range(40000) t(i))
        ORDER BY y, x) TO '{base}/points.parquet' (FORMAT PARQUET, ROW_GROUP_SIZE 2048)""")
    con.execute(f"""COPY (SELECT 'points.parquet' AS path, 'points' AS layer, 40000 AS rows,
        11.0 AS xmin, 48.0 AS ymin, 11.3 AS xmax, 48.3 AS ymax) TO '{base}/_index.parquet' (FORMAT PARQUET)""")
    monkeypatch.setitem(module.SOURCES, "osm", module.Source(str(tmp_path), "geom", "osm_id", True))
    monkeypatch.setattr(module, "SUGGESTION_ROWS", 10_000)
    square = {"type": "Polygon", "coordinates": [[[11.0, 48.0], [11.3, 48.0], [11.3, 48.3], [11.0, 48.3], [11.0, 48.0]]]}
    files = [str(base / "points.parquet")]

    # The size from row-group bounds: the whole square holds all 40,000.
    assert abs(module._group_rows(module.row_groups(con, files, "geom"), (11.0, 48.0, 11.3, 48.3)) - 40_000) < 2_100
    sized = module.mirror_values(con, area=square, feature_type="points", source_name="osm", size_only=True)
    assert sized["values"] == [] and abs(sized["estimate"] - 40_000) < 2_100

    # Over the cap the tag list is the files' tag columns, without counts.
    keys = module.mirror_values(con, area=square, feature_type="points", source_name="osm", quick=True)
    assert [v["value"] for v in keys["values"]] == ["highway"] and keys["complete"] and keys["estimate"] > 10_000

    # With the build's counts the quick ask answers from them; a backfilled file is seen after the recheck.
    module._no_counts.clear()
    con.execute(f"""COPY (SELECT * FROM (VALUES
        ('points.parquet', 'points', 'highway', NULL, 10000), ('points.parquet', 'points', 'highway', 'bus_stop', 10000),
        ('points.parquet', 'points', 'surface', NULL, 40000), ('points.parquet', 'points', 'surface', 'asphalt', 20000),
        ('points.parquet', 'points', 'surface', 'gravel', 19000), ('points.parquet', 'points', 'addr:street', NULL, 30000)
        ) t(path, layer, key, value, count)) TO '{base}/_values.parquet' (FORMAT PARQUET)""")
    keys = module.mirror_values(con, area=square, feature_type="points", source_name="osm", quick=True)
    assert [v["value"] for v in keys["values"]] == ["surface", "highway"] and keys["complete"]
    surface = module.mirror_values(con, area=square, feature_type="points", key="surface", source_name="osm", quick=True)
    assert [v["value"] for v in surface["values"]] == ["asphalt", "gravel"] and surface["complete"]
    corner = {"type": "Polygon", "coordinates": [[[11.0, 48.0], [11.01, 48.0], [11.01, 48.01], [11.0, 48.01], [11.0, 48.0]]]}
    small = module.mirror_values(con, area=corner, feature_type="points", key="surface", source_name="osm", quick=True)
    assert not small["complete"]

    # Over the read limit a fetch is refused before reading, whatever its filters.
    monkeypatch.setattr(module, "MAX_READ_FEATURES", 30_000)
    with pytest.raises(ValueError, match="too large"):
        module.check_read_size(con, files, [(11.0, 48.0, 11.3, 48.3)], "geom")
    module.check_read_size(con, files, [(11.0, 48.0, 11.1, 48.1)], "geom")
    # Two small parts far apart count as two small boxes, not the box around both.
    two = {"type": "MultiPolygon", "coordinates": [[[[11.0, 48.0], [11.02, 48.0], [11.02, 48.02], [11.0, 48.02], [11.0, 48.0]]],
                                                   [[[11.28, 48.28], [11.3, 48.28], [11.3, 48.3], [11.28, 48.3], [11.28, 48.28]]]]}
    module.check_read_size(con, files, module.area_boxes(con, module.area_table(con, two)), "geom")
    # Heavy geometry is refused too, before reading: features few, bytes many.
    monkeypatch.setattr(module, "MAX_READ_FEATURES", 10**9)
    monkeypatch.setattr(module, "MAX_READ_BYTES", 1_000)
    with pytest.raises(ValueError, match="too large"):
        module.check_read_size(con, files, [(11.0, 48.0, 11.3, 48.3)], "geom")
    assert module.mirror_values(con, area=square, feature_type="points", source_name="osm", size_only=True)["too_large"]
