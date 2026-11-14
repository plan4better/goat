"""Tag filters compiled to SQL.

The part with logic in it: a tag condition becomes two tests, and both have to
agree. `LIKE '%amenity%'` would match `amenity:parking`, and a value typed by a
user reaches a string literal.
"""

import pytest
from goatlib.io.fetch import area
from goatlib.io.fetch.mirror import osm, overture, query, reader, values
from goatlib.io.fetch.mirror.osm import FEATURE_TYPES, _tag_sql
from goatlib.tools.fetch_data import TagFilter


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
    osm, ov = reader.SOURCES["osm"], reader.SOURCES["overture"]
    assert osm.licence_of("points") == ("ODbL-1.0", "© OpenStreetMap contributors")
    assert ov.licence_of("places")[0] == "CDLA-Permissive-2.0"
    assert ov.licence_of("buildings")[0] == ov.licence_of("waterways")[0] == "ODbL-1.0"
    # And the lineage reads as a sentence, not as mirror bookkeeping.
    f = [TagFilter(key="amenity", values=["school", "kindergarten"])]
    assert query.lineage_text(
        osm, "points", [("austria", "20261011"), ("germany", "20261010")], f
    ) == (
        "OpenStreetMap data for Austria and Germany, as of 11 Oct 2026. "
        "Only features where amenity is school or kindergarten."
    )
    assert query.lineage_text(ov, "buildings", [("buildings", "2026-09-23.1")], []) == (
        "Overture Maps buildings, release 2026-09-23.1."
    )


def test_the_cache_key_changes_with_the_snapshot(tmp_path, monkeypatch) -> None:
    """Building the tag list costs ten seconds, so it is kept. Keeping it across
    a new weekly mirror would answer this week's question from last week's data."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    env = (11.5, 48.1, 11.6, 48.2)
    last = osm._tag_cache_path("layer-1", "points", [("germany", "20260921")], env)
    this = osm._tag_cache_path("layer-1", "points", [("germany", "20260928")], env)
    assert last != this
    # And a different area, or a different geometry, is a different question.
    assert last != osm._tag_cache_path(
        "layer-2", "points", [("germany", "20260921")], env
    )
    assert last != osm._tag_cache_path(
        "layer-1", "lines", [("germany", "20260921")], env
    )


def test_the_join_between_filters_is_chosen() -> None:
    """Two conditions on one key can never both hold, so AND silently returns
    nothing — which is exactly how someone asks for restaurants or cafes."""
    f = [
        TagFilter(key="amenity", values=["restaurant"]),
        TagFilter(key="amenity", values=["cafe"]),
    ]
    src = reader.SOURCES["osm"]
    assert " AND " in query.filter_sql(f, src, "all")[1]
    assert " OR " in query.filter_sql(f, src, "any")[1]


def test_the_prefilter_uses_the_same_join() -> None:
    """It runs before the parse, so an AND there would drop rows the exact
    test would have kept."""
    f = [
        TagFilter(key="amenity", values=["restaurant"]),
        TagFilter(key="shop", values=["bakery"]),
    ]
    pre, exact = query.filter_sql(f, reader.SOURCES["osm"], "any")
    assert " OR " in pre and " OR " in exact
    # A tag with its own column is tested there, in both, without the tags.
    pre, exact = query.filter_sql(
        f, reader.SOURCES["osm"], "any", columns=frozenset({"shop"})
    )
    assert pre.endswith("OR list_contains(['bakery'], \"shop\")") and exact.endswith(
        "OR list_contains(['bakery'], \"shop\")"
    )


def test_several_values_on_one_key_are_any_of_them() -> None:
    """A feature has one value per key, so AND-ing two of them matches nothing —
    which is exactly how someone asks for restaurants or cafes."""
    f = [TagFilter(key="amenity", values=["restaurant", "cafe"])]
    pre, exact = query.filter_sql(f, reader.SOURCES["osm"])
    assert exact == "tags['amenity'] IN ('restaurant', 'cafe')"
    # The prefilter runs first, so it has to admit both or the exact test never sees them.
    assert "(restaurant|cafe)" in pre


# Three features: a school, a cafe, and one without the key. Each operator has to keep the
# right ones whether the tags arrive as text (parsed for the exact test) or as a stored map.
_OSM_ROWS = """
    SELECT * FROM (VALUES
        (1, MAP {'amenity': 'school'}, '"amenity"=>"school"'),
        (2, MAP {'amenity': 'cafe'}, '"amenity"=>"cafe"'),
        (3, MAP {'shop': 'bakery'}, '"shop"=>"bakery"')
    ) t(id, tags, all_tags)
"""


@pytest.mark.parametrize("storage", ["text", "map"])
@pytest.mark.parametrize(
    ("operator", "values_", "kept"),
    [
        ("is", ["school"], [1]),
        ("is_not", ["school"], [2, 3]),
        ("is_set", [], [1, 2]),
        ("is_not_set", [], [3]),
        # A filter from before operators: no values means the key is set.
        (None, [], [1, 2]),
        # Without values, "is not" asks for the key to be absent.
        ("is_not", [], [3]),
    ],
)
def test_each_operator_keeps_the_right_osm_features(
    storage, operator, values_, kept
) -> None:
    import duckdb

    f = TagFilter(
        key="amenity", values=values_, **({"operator": operator} if operator else {})
    )
    pre, exact = _tag_sql([f], storage=storage)
    rows = duckdb.sql(
        f"SELECT id FROM ({_OSM_ROWS}) WHERE ({pre}) AND ({exact}) ORDER BY id"
    ).fetchall()
    assert [r[0] for r in rows] == kept


def test_not_operators_pass_the_prefilter() -> None:
    """Absence leaves nothing in the raw text to find, so a prefilter that looked for the key
    would drop exactly the features "is not" and "is not set" keep."""
    for operator in ("is_not", "is_not_set"):
        pre, _ = _tag_sql(
            [TagFilter(key="amenity", values=["school"], operator=operator)]
        )
        assert pre == "TRUE"


@pytest.mark.parametrize(
    ("operator", "values_", "kept"),
    [
        ("is", ["cafe"], [1]),
        ("is_not", ["cafe"], [2, 3]),
        ("is_set", [], [1, 2]),
        ("is_not_set", [], [3]),
    ],
)
def test_each_operator_keeps_the_right_overture_features(
    operator, values_, kept
) -> None:
    import duckdb

    f = TagFilter(key="category", values=values_, operator=operator)
    _, exact = query.filter_sql([f], reader.SOURCES["overture"], "all", "places")
    rows = duckdb.sql(
        "SELECT id FROM (SELECT * FROM (VALUES (1, {'primary': 'cafe'}), (2, {'primary': 'bar'}),"
        f" (3, NULL)) t(id, taxonomy)) WHERE {exact} ORDER BY id"
    ).fetchall()
    assert [r[0] for r in rows] == kept


def test_the_lineage_says_each_operator() -> None:
    filters = [
        TagFilter(key="amenity", values=["school"], operator="is_not"),
        TagFilter(key="wheelchair", operator="is_not_set"),
        TagFilter(key="name"),
    ]
    text = query.lineage_text(
        reader.SOURCES["osm"], "points", [("germany", "20261028")], filters
    )
    assert "amenity is not school" in text
    assert "wheelchair is not set" in text
    assert "name is set" in text


def test_a_workflow_steps_provenance_waits_in_its_temp_metadata(tmp_path) -> None:
    import json

    from goatlib.tools.fetch_data import _record_temp_provenance

    (tmp_path / "metadata.json").write_text(json.dumps({"layer_name": "Schools"}))
    _record_temp_provenance(str(tmp_path / "t_x.parquet"), {"license": "ODbL-1.0"})
    assert json.loads((tmp_path / "metadata.json").read_text()) == {
        "layer_name": "Schools",
        "provenance": {"license": "ODbL-1.0"},
    }


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
    src = reader.Source(str(tmp_path), "geom", "osm_id", True)
    units = {
        "europe": {"version": "20261005", "bbox": [-25, 34, 45, 72]},
        "africa": {"version": "20261005", "bbox": [-20, -35, 52, 37]},
    }
    env = (11.5, 48.1, 11.6, 48.2)
    files, read = reader.covering(con, units, src, "points", env)
    assert files == [f"{base}/points/part-00000.parquet"] and read == [
        ("europe", "20261005")
    ]
    # A unit without an index is left out, not every other unit with it.
    unindexed = {**units, "alps": {"version": "20261005", "bbox": [5, 45, 17, 49]}}
    assert reader.covering(con, unindexed, src, "points", env)[0] == files
    # A version's index is read once: deleted, the same files still come back.
    (base / "_index.parquet").unlink()
    assert reader.covering(con, units, src, "points", env)[0] == files
    # The bbox predicate is what skips row groups; ST_Intersects alone reads them all.
    sql = query.candidates_sql(files, src, env, "TRUE")
    assert "bbox.xmin <= 11.6" in sql and "bbox.ymax >= 48.1" in sql

    # A base type mixes geometries; each option keeps one, so the layer has one type.
    ov = reader.SOURCES["overture"]
    assert (
        ov.unit_of("waterways"),
        ov.layer_of("waterways"),
        ov.geometry_of("waterways"),
    ) == ("base", "water", "line")
    assert "LINESTRING" in ov.geometry_filter(
        "waterways"
    ) and "POLYGON" not in ov.geometry_filter("waterways")
    # A split mirror holds the geometry in the layer: no geometry is read then.
    assert (
        ov.split_layer_of("waterways") == "water_line"
        and ov.split_layer_of("places") is None
    )
    assert (
        ov.geometry_filter("waterways", ["s3://m/base/v/austria/water_line.parquet"])
        == "TRUE"
    )
    assert src.geometry_filter("points") == "TRUE"

    # Overture's mirror puts the version on top: the pointer's path says where.
    first = tmp_path / "v2" / "europe"
    first.mkdir(parents=True)
    con.execute(f"""COPY (SELECT 'points/germany.parquet' AS path, 'points' AS layer, 'europe' AS continent,
        11.0 AS xmin, 48.0 AS ymin, 12.0 AS xmax, 49.0 AS ymax, 10 AS rows, 1 AS bytes)
        TO '{first}/_index.parquet' (FORMAT PARQUET)""")
    files, read = reader.covering(
        con, {"europe": {"version": "v2", "path": "v2/europe"}}, src, "points", env
    )
    assert files == [f"{first}/points/germany.parquet"] and read == [("europe", "v2")]

    # No pointer yet means no data here, not a crash.
    assert (
        reader.pointer(
            con, reader.Source(str(tmp_path / "nowhere"), "geom", "osm_id", True)
        )
        == {}
    )
    assert reader.pointer(con, reader.Source("", "geom", "osm_id", True)) == {}

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
    cols = {
        str(r[0]): str(r[1])
        for r in con.execute(f"DESCRIBE SELECT * FROM '{data}'").fetchall()
    }
    plain = ", ".join(overture.overture_plain_columns(cols))
    rows = con.execute(
        f"SELECT id, {plain} FROM read_parquet('{data}') c ORDER BY id"
    ).fetchall()
    assert rows[0][1:4] == (
        "Rathaus",
        "OpenStreetMap; Microsoft ML Buildings",
        "ODbL-1.0",
    )
    assert rows[0][4:] == ("w1494403985@1; m7", "2026-03-30T18:37:29Z")
    assert rows[1][1:] == (None, None, None, None, None)


def test_the_area_and_the_sql_are_checked(tmp_path) -> None:
    duckdb = pytest.importorskip("duckdb")
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    box = {
        "type": "Polygon",
        "coordinates": [[[11.5, 48.1], [11.6, 48.1], [11.6, 48.2], [11.5, 48.1]]],
    }
    assert area.area_envelope(con, area.area_table(con, box)) == (
        11.5,
        48.1,
        11.6,
        48.2,
    )
    with pytest.raises(ValueError, match="polygon"):
        area.area_table(con, {"type": "Point", "coordinates": [11.5, 48.1]})

    data = tmp_path / "p.parquet"
    con.execute(
        f"COPY (SELECT 1 AS osm_id, '' AS all_tags) TO '{data}' (FORMAT PARQUET)"
    )
    src = reader.SOURCES["osm"]
    ok = "tags['amenity'] IN ('school') AND tags['wheelchair'] IS NOT NULL"
    assert query.checked_where(con, [str(data)], src, ok) == f"({ok})"
    for bad in [
        "1=1; DROP TABLE t",
        "osm_id IN (SELECT 1)",
        "read_parquet('x') IS NULL",
    ]:
        with pytest.raises(ValueError, match="not allowed"):
            query.checked_where(con, [str(data)], src, bad)

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
    for files, storage in (
        ([str(text)], "text"),
        ([str(mapped)], "map"),
        ([str(text), str(mapped)], "both"),
    ):
        assert osm.tag_storage(reader.mirror_columns(con, files)) == storage
        pre, exact = query.filter_sql(f, src, storage=storage)
        hits = con.execute(
            f"SELECT osm_id FROM ({query.candidates_sql(files, src, env, pre, storage)}) WHERE {exact}"
        ).fetchall()
        assert len(hits) == len(files)
        keys, _ = osm._count_tags(
            con, osm._raw_tags_sql(files, env, "TRUE", storage), None, 10, storage
        )
        assert keys[0] == ("amenity", len(files))
        assert not {"name", "check_date"} & {k for k, _ in keys}

    # A tag the files also hold as a column is counted from that column, if every file has it.
    col = tmp_path / "col.parquet"
    con.execute(f"""COPY (SELECT i AS osm_id, CASE WHEN i < 3 THEN 'primary' WHEN i < 4 THEN 'bus_stop' END AS highway,
        {bbox} AS bbox, ST_Point(CASE WHEN i = 2 THEN 20 ELSE 11.5 END, 48.1) AS geom FROM range(6) t(i)) TO '{col}' (FORMAT PARQUET)""")
    assert values._key_column(con, [str(col)], "highway") and not values._key_column(
        con, [str(col), str(text)], "highway"
    )
    # Inside the area itself, as the fetch cuts it: the point at 20° E is left out.
    (shape,) = con.execute("SELECT ST_AsHEXWKB(ST_MakeEnvelope(11, 48, 12, 49))").fetchone()
    assert values._column_counts(con, [str(col)], env, "highway", 10, "geom", shape) == (
        [("primary", 2), ("bus_stop", 1)],
        3,
    )

    # The columns named before fetching are the ones the SELECT list writes.
    wrote = tmp_path / "wrote.parquet"
    for files, storage in (
        ([str(text)], "text"),
        ([str(mapped)], "map"),
        ([str(text), str(mapped)], "both"),
    ):
        sel = ", ".join(
            e
            for e, _, _ in query.selected_columns(
                reader.mirror_columns(con, files), src, storage
            )
        )
        con.execute(
            f"COPY (SELECT {sel} FROM ({query.candidates_sql(files, src, env, 'TRUE', storage)}) c) TO '{wrote}' (FORMAT PARQUET)"
        )
        named = query.output_columns(con, files, src, "points")
        assert [n for n, _ in named] == [
            str(r[0])
            for r in con.execute(f"DESCRIBE SELECT * FROM '{wrote}'").fetchall()
            if r[0] != "geom"
        ]
        assert (
            dict(named)["all_tags"] == "VARCHAR"
            and "geom" not in dict(named)
            and "_mirror_file" not in dict(named)
        )
    ov = tmp_path / "ov.parquet"
    con.execute(f"""COPY (SELECT '1' AS id, {{'primary': 'Rathaus'}} AS names, [{{'dataset': 'osm', 'license': 'ODbL'}}] AS sources,
        {{'a': 1}} AS extra, 3 AS height, {bbox} AS bbox, ST_Point(11.5, 48.1) AS geometry) TO '{ov}' (FORMAT PARQUET)""")
    got = dict(
        query.output_columns(con, [str(ov)], reader.SOURCES["overture"], "building")
    )
    assert {"name", "source", "source_license", "height"} <= set(got) and got[
        "extra"
    ] == got["names"] == "VARCHAR"
    assert got["height"] == "INTEGER" and "geometry" not in got and "bbox" not in got


def test_a_big_view(tmp_path, monkeypatch) -> None:
    import json

    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    base = tmp_path / "de" / "v1"
    base.mkdir(parents=True)
    (tmp_path / "_current.json").write_text(
        json.dumps({"units": {"de": {"version": "v1"}}})
    )
    # 40,000 points over 0.3°, sorted along y: 20 row groups of 2,048.
    con.execute(f"""COPY (SELECT i AS osm_id, 'P' || i AS name, CASE WHEN i % 4 = 0 THEN 'bus_stop' END AS highway,
            MAP {{'surface': CASE WHEN i % 2 = 0 THEN 'asphalt' ELSE 'gravel' END}} AS tags,
            {{'xmin': x, 'ymin': y, 'xmax': x, 'ymax': y}} AS bbox, ST_Point(x, y) AS geom
        FROM (SELECT i, 11 + (i % 200) * 0.0015 AS x, 48 + (i // 200) * 0.0015 AS y FROM range(40000) t(i))
        ORDER BY y, x) TO '{base}/points.parquet' (FORMAT PARQUET, ROW_GROUP_SIZE 2048)""")
    con.execute(f"""COPY (SELECT 'points.parquet' AS path, 'points' AS layer, 40000 AS rows,
        11.0 AS xmin, 48.0 AS ymin, 11.3 AS xmax, 48.3 AS ymax) TO '{base}/_index.parquet' (FORMAT PARQUET)""")
    monkeypatch.setitem(
        reader.SOURCES, "osm", reader.Source(str(tmp_path), "geom", "osm_id", True)
    )
    monkeypatch.setattr(values, "SUGGESTION_ROWS", 10_000)
    square = {
        "type": "Polygon",
        "coordinates": [
            [[11.0, 48.0], [11.3, 48.0], [11.3, 48.3], [11.0, 48.3], [11.0, 48.0]]
        ],
    }
    files = [str(base / "points.parquet")]

    # The size is counted: the whole square holds all 40,000, a corner its 7 x 7.
    groups = reader.row_groups(con, files, "geom")
    assert reader.area_size(con, groups, [(11.0, 48.0, 11.3, 48.3)])[0] == 40_000
    assert reader.area_size(con, groups, [(11.0, 48.0, 11.01, 48.01)])[0] == 49
    sized = values.mirror_values(
        con, area=square, feature_type="points", source_name="osm", size_only=True
    )
    assert sized["values"] == [] and sized["estimate"] == 40_000

    # Over the cap the tag list is the files' tag columns, without counts.
    keys = values.mirror_values(
        con, area=square, feature_type="points", source_name="osm", quick=True
    )
    assert (
        [v["value"] for v in keys["values"]] == ["highway"]
        and keys["complete"]
        and keys["estimate"] > 10_000
    )

    # With the build's counts the quick ask answers from them; a backfilled file is seen after the recheck.
    values._no_counts.clear()
    con.execute(f"""COPY (SELECT * FROM (VALUES
        ('points.parquet', 'points', 'highway', NULL, 10000), ('points.parquet', 'points', 'highway', 'bus_stop', 10000),
        ('points.parquet', 'points', 'surface', NULL, 40000), ('points.parquet', 'points', 'surface', 'asphalt', 20000),
        ('points.parquet', 'points', 'surface', 'gravel', 19000), ('points.parquet', 'points', 'addr:street', NULL, 30000)
        ) t(path, layer, key, value, count)) TO '{base}/_values.parquet' (FORMAT PARQUET)""")
    keys = values.mirror_values(
        con, area=square, feature_type="points", source_name="osm", quick=True
    )
    assert [v["value"] for v in keys["values"]] == ["surface", "highway"] and keys[
        "complete"
    ]
    surface = values.mirror_values(
        con,
        area=square,
        feature_type="points",
        key="surface",
        source_name="osm",
        quick=True,
    )
    assert [v["value"] for v in surface["values"]] == ["asphalt", "gravel"] and surface[
        "complete"
    ]
    corner = {
        "type": "Polygon",
        "coordinates": [
            [[11.0, 48.0], [11.01, 48.0], [11.01, 48.01], [11.0, 48.01], [11.0, 48.0]]
        ],
    }
    small = values.mirror_values(
        con,
        area=corner,
        feature_type="points",
        key="surface",
        source_name="osm",
        quick=True,
    )
    assert not small["complete"]

    # Over the read limit a fetch is refused before reading, whatever its filters.
    monkeypatch.setattr(reader, "MAX_READ_FEATURES", 30_000)
    with pytest.raises(ValueError, match="too large"):
        reader.check_read_size(con, files, [(11.0, 48.0, 11.3, 48.3)], "geom")
    reader.check_read_size(con, files, [(11.0, 48.0, 11.1, 48.1)], "geom")
    # Two small parts far apart count as two small boxes, not the box around both.
    two = {
        "type": "MultiPolygon",
        "coordinates": [
            [
                [
                    [11.0, 48.0],
                    [11.02, 48.0],
                    [11.02, 48.02],
                    [11.0, 48.02],
                    [11.0, 48.0],
                ]
            ],
            [
                [
                    [11.28, 48.28],
                    [11.3, 48.28],
                    [11.3, 48.3],
                    [11.28, 48.3],
                    [11.28, 48.28],
                ]
            ],
        ],
    }
    reader.check_read_size(
        con, files, area.area_boxes(con, area.area_table(con, two)), "geom"
    )
    # Heavy geometry is refused too, before reading: features few, bytes many.
    monkeypatch.setattr(reader, "MAX_READ_FEATURES", 10**9)
    monkeypatch.setattr(reader, "MAX_READ_BYTES", 1_000)
    with pytest.raises(ValueError, match="too large"):
        reader.check_read_size(con, files, [(11.0, 48.0, 11.3, 48.3)], "geom")
    assert values.mirror_values(
        con, area=square, feature_type="points", source_name="osm", size_only=True
    )["too_large"]

    # Unless the build's counts show the chosen values of any tag fit one fetch.
    def sized(filters, mode="all"):
        tag_filters = [
            {"key": k, "values": v, **({"operator": o} if o else {})}
            for k, v, o in filters
        ]
        return values.mirror_values(
            con,
            area=square,
            feature_type="points",
            source_name="osm",
            size_only=True,
            tag_filters=tag_filters,
            match_mode=mode,
        )["too_large"]

    assert not sized([("highway", ["bus_stop"], None)]) and not sized(
        [("surface", ["asphalt"], None)]
    )
    # Only "is" with values: no values, or "is not", keeps nearly everything.
    assert sized([("highway", [], None)]) and sized(
        [("highway", ["bus_stop"], "is_not")]
    )
    # A key the build did not count (only its total, or not at all) says nothing.
    assert sized([("addr:street", ["Main"], None)]) and sized([("name", ["P1"], None)])
    # Past the ceiling no filter makes it fit: the read alone is too much.
    monkeypatch.setattr(reader, "MAX_FILTERED_READ_FEATURES", 30_000)
    assert sized([("highway", ["bus_stop"], None)])
    beyond = values.mirror_values(
        con,
        area=square,
        feature_type="points",
        source_name="osm",
        size_only=True,
        tag_filters=[{"key": "highway", "values": ["bus_stop"]}],
    )
    assert not beyond["filters_can_fit"] and beyond["matches"] is None
    monkeypatch.setattr(reader, "MAX_FILTERED_READ_FEATURES", 10**8)
    # With "all", a filter the counts cannot bound leaves the others to bound it.
    assert not sized([("highway", ["bus_stop"], None), ("name", ["P1"], None)])
    assert sized([("highway", ["bus_stop"], None), ("name", ["P1"], None)], "any")
    monkeypatch.setattr(values, "MAX_FEATURES", 15_000)
    assert sized(
        [("highway", ["bus_stop"], None), ("highway", ["bus_stop"], None)], "any"
    )
    # A value the build left out is counted as the rarest kept one, never as none.
    monkeypatch.setattr(values, "MAX_FEATURES", 5_000)
    assert sized([("highway", ["tram_stop"], None)])
    # Where the area can be read, the matches are counted, not bounded.
    monkeypatch.setattr(reader, "MAX_READ_BYTES", 10**12)
    counted = values.mirror_values(
        con,
        area=square,
        feature_type="points",
        source_name="osm",
        size_only=True,
        tag_filters=[{"key": "highway", "values": ["bus_stop"]}],
    )
    assert counted["matches"] == 10_000 and not counted["matches_bound"]


def test_a_sample_shows_what_a_fetch_would_write(tmp_path, monkeypatch) -> None:
    import json

    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    base = tmp_path / "de" / "v1"
    base.mkdir(parents=True)
    (tmp_path / "_current.json").write_text(
        json.dumps({"units": {"de": {"version": "v1"}}})
    )
    # 400 points; every fourth a bus stop on gravel.
    con.execute(f"""COPY (SELECT i AS osm_id, 'P' || i AS name, CASE WHEN i % 4 = 0 THEN 'bus_stop' END AS highway,
            MAP {{'surface': CASE WHEN i % 4 = 0 THEN 'gravel' ELSE 'asphalt' END}} AS tags,
            {{'xmin': x, 'ymin': y, 'xmax': x, 'ymax': y}} AS bbox, ST_Point(x, y) AS geom
        FROM (SELECT i, 11 + (i % 20) * 0.001 AS x, 48 + (i // 20) * 0.001 AS y FROM range(400) t(i))
        ORDER BY y, x) TO '{base}/points.parquet' (FORMAT PARQUET)""")
    con.execute(f"""COPY (SELECT 'points.parquet' AS path, 'points' AS layer, 400 AS rows,
        11.0 AS xmin, 48.0 AS ymin, 11.02 AS xmax, 48.02 AS ymax) TO '{base}/_index.parquet' (FORMAT PARQUET)""")
    monkeypatch.setitem(
        reader.SOURCES, "osm", reader.Source(str(tmp_path), "geom", "osm_id", True)
    )
    square = {
        "type": "Polygon",
        "coordinates": [
            [[11.0, 48.0], [11.02, 48.0], [11.02, 48.02], [11.0, 48.02], [11.0, 48.0]]
        ],
    }

    sample = values.mirror_values(
        con,
        area=square,
        feature_type="points",
        source_name="osm",
        sample_only=True,
        limit=5,
        tag_filters=[{"key": "surface", "values": ["gravel"]}],
    )
    names = [c["name"] for c in sample["columns"]]
    # The fetch's own columns, without the geometry; every value as text.
    assert (
        names[:3] == ["osm_id", "name", "highway"]
        and "geom" not in names
        and "all_tags" in names
    )
    assert len(sample["rows"]) == 5 and all(
        row[names.index("highway")] == "bus_stop" for row in sample["rows"]
    )
    assert all("gravel" in row[names.index("all_tags")] for row in sample["rows"])
    assert all(isinstance(cell, str) for row in sample["rows"] for cell in row)

    # A condition works the same way, and the sample stays small whatever is asked.
    by_sql = values.mirror_values(
        con,
        area=square,
        feature_type="points",
        source_name="osm",
        sample_only=True,
        limit=1000,
        where="highway IS NULL",
    )
    assert len(by_sql["rows"]) == values.MAX_SAMPLE_ROWS
    assert all(row[names.index("highway")] == "" for row in by_sql["rows"])

    # Outside the mirror there is nothing to show, and no error.
    away = {
        "type": "Polygon",
        "coordinates": [
            [[5.0, 40.0], [5.1, 40.0], [5.1, 40.1], [5.0, 40.1], [5.0, 40.0]]
        ],
    }
    assert (
        values.mirror_values(
            con, area=away, feature_type="points", source_name="osm", sample_only=True
        )["rows"]
        == []
    )

    # Over an area no fetch reads, nothing is scanned for a sample.
    monkeypatch.setattr(values, "MAX_READ_FEATURES", 0)
    whole = {
        "type": "Polygon",
        "coordinates": [
            [[0.0, 0.0], [30.0, 0.0], [30.0, 60.0], [0.0, 60.0], [0.0, 0.0]]
        ],
    }
    refused = values.mirror_values(
        con, area=whole, feature_type="points", source_name="osm", sample_only=True
    )
    assert refused["rows"] == [] and refused["too_large"]


def test_a_crowded_row_group_is_counted(tmp_path) -> None:
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    # A town in a corner of a row group that spans a whole region, as the
    # mirror's do: its share of the group's bbox is tiny, its features are not.
    path = tmp_path / "points.parquet"
    con.execute(f"""COPY (SELECT i AS osm_id, {{'xmin': x, 'ymin': y, 'xmax': x, 'ymax': y}} AS bbox, ST_Point(x, y) AS geom
        FROM (SELECT i, CASE WHEN i = 0 THEN 12.0 ELSE 11.0 + (i % 50) * 0.0002 END AS x,
                        CASE WHEN i = 0 THEN 49.0 ELSE 48.0 + (i // 50) * 0.0002 END AS y FROM range(2000) t(i))
        ) TO '{path}' (FORMAT PARQUET, ROW_GROUP_SIZE 2048)""")
    groups = reader.row_groups(con, [str(path)], "geom")
    assert len(groups) == 1 and groups[0][3:7] == (11.0, 48.0, 12.0, 49.0)
    town = (11.0, 48.0, 11.01, 48.01)
    rows, geometry = reader.area_size(con, groups, [town])
    assert rows == 1999 and 0 < geometry <= groups[0][7]
    # Over the limit by the groups wholly inside alone, nothing more is read.
    assert (
        reader.area_size(con, groups, [(10.0, 47.0, 13.0, 50.0)], enough=1_000)[0]
        == 2000
    )
    assert reader.area_size(con, groups, [(13.0, 50.0, 14.0, 51.0)]) == (0, 0)
    # Parts whose boxes overlap count what they share once.
    halves = [(11.0, 48.0, 11.008, 48.01), (11.004, 48.0, 11.01, 48.01)]
    assert reader.area_size(con, groups, halves)[0] == 1999
    whole = [(10.0, 47.0, 13.0, 50.0), (10.5, 47.5, 12.5, 49.5)]
    assert reader.area_size(con, groups, whole, enough=1_000)[0] == 2000


def _merc(lon: float, lat: float) -> list[float]:
    import math

    r = 6378137.0
    return [
        math.radians(lon) * r,
        math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * r,
    ]


@pytest.fixture
def network(tmp_path, monkeypatch):
    """Two partitions: the first with slope columns, the second, older, without."""
    import duckdb
    from goatlib.io.fetch import street_network

    con = duckdb.connect()
    edges = {
        1: [
            (1, 1, 2, (11.40, 47.26), (11.41, 47.26), 0.3),
            (2, 2, 3, (11.415, 47.265), (11.45, 47.265), 0.1),
            (4, 6, 7, (11.39, 47.255), (11.395, 47.255), 0.0),
        ],
        2: [
            (3, 4, 5, (11.5, 47.3), (11.51, 47.3), None),
            (4, 6, 7, (11.39, 47.255), (11.395, 47.255), None),
            (1, 1, 2, (11.40, 47.26), (11.41, 47.26), None),
        ],
    }
    for part, rows in edges.items():
        (tmp_path / "edges" / f"h3_3={part}").mkdir(parents=True)
        slope = part == 1
        values = ", ".join(
            f"({i}::BIGINT, {s}::BIGINT, {t}::BIGINT, 10.0, 'residential', 30::SMALLINT, 30::SMALLINT, "
            f"[{_merc(*a)}, {_merc(*b)}]::DOUBLE[][]"
            + (f", {imp}::DOUBLE, {-imp}::DOUBLE, 0.5::FLOAT" if slope else "")
            + ")"
            for i, s, t, a, b, imp in rows
        )
        cols = "id, source, target, length_m, class_, maxspeed_forward, maxspeed_backward, coordinates_3857"
        cols += (
            ", impedance_slope, impedance_slope_reverse, impedance_surface"
            if slope
            else ""
        )
        con.execute(
            f"COPY (SELECT * FROM (VALUES {values}) t({cols})) TO '{tmp_path}/edges/h3_3={part}/a.parquet'"
        )
    (tmp_path / "nodes" / "h3_3=1").mkdir(parents=True)
    nodes = {
        1: (11.40, 47.26),
        2: (11.41, 47.26),
        3: (11.45, 47.265),
        4: (11.5, 47.3),
        5: (11.51, 47.3),
        6: (11.39, 47.255),
        7: (11.395, 47.255),
    }
    values = ", ".join(
        f"({i}, {_merc(*p)[0]}, {_merc(*p)[1]})" for i, p in nodes.items()
    )
    con.execute(
        f"COPY (SELECT * FROM (VALUES {values}) t(id, x_3857, y_3857)) TO '{tmp_path}/nodes/h3_3=1/a.parquet'"
    )
    monkeypatch.setattr(
        street_network, "h3_3_cells_for_bbox", lambda bbox, ring=1: {1, 2}
    )
    con.execute("INSTALL spatial; LOAD spatial;")
    area = {
        "type": "Polygon",
        "coordinates": [
            [
                [11.38, 47.25],
                [11.42, 47.25],
                [11.42, 47.28],
                [11.38, 47.28],
                [11.38, 47.25],
            ]
        ],
    }
    paths = street_network.export_network(
        con,
        area=area,
        edges_base=str(tmp_path / "edges"),
        nodes_base=str(tmp_path / "nodes"),
        workdir=str(tmp_path),
    )
    return con, paths


def test_network_cut(network) -> None:
    """Touching edges kept whole and once, nodes their ends, slope and surface along."""
    con, paths = network
    edges = f"read_parquet('{paths['edges']}')"
    rows = dict(con.execute(f"SELECT id, ST_XMax(geometry) FROM {edges}").fetchall())
    # The edge reaching out to 11.45 is kept whole; the one at 11.5 is not kept.
    assert set(rows) == {"1", "2", "4"} and round(rows["2"], 3) == 11.45
    assert (
        con.execute(f"SELECT count(*) FROM {edges} WHERE id = '4'").fetchone()[0] == 1
    )
    nodes = {
        r[0]
        for r in con.execute(
            f"SELECT id FROM read_parquet('{paths['nodes']}')"
        ).fetchall()
    }
    assert nodes == {"1", "2", "3", "6", "7"}
    slopes = dict(
        con.execute(
            f"SELECT id, (impedance_slope, impedance_slope_reverse) FROM {edges}"
        ).fetchall()
    )
    # Edge 1 is also in the older partition without slope: the copy with it wins.
    assert slopes["1"] == (0.3, -0.3) and slopes["4"] == (0.0, 0.0)
    surface = dict(con.execute(f"SELECT id, impedance_surface FROM {edges}").fetchall())
    assert surface == {"1": 0.5, "2": 0.5, "4": 0.5}


def test_network_size(tmp_path, monkeypatch) -> None:
    """Counted in H3-6 cells, part by part; a continent from its area alone."""
    import duckdb
    from goatlib.io.fetch import street_network

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    def box(x: float, y: float, d: float) -> list:
        return [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]]

    small = street_network.area_cells(
        con, {"type": "Polygon", "coordinates": box(11.40, 47.26, 0.01)}
    )
    far = street_network.area_cells(
        con, {"type": "Polygon", "coordinates": box(16.40, 48.20, 0.01)}
    )
    both = {
        "type": "MultiPolygon",
        "coordinates": [box(11.40, 47.26, 0.01), box(16.40, 48.20, 0.01)],
    }
    assert 1 <= small <= 2 and street_network.area_cells(con, both) == small + far
    europe = {"type": "Polygon", "coordinates": box(-10.0, 36.0, 40.0)}
    assert street_network.area_cells(con, europe) == street_network.MAX_CELLS + 1
    big = {"type": "Polygon", "coordinates": box(11.0, 47.0, 1.5)}
    with pytest.raises(ValueError, match="too large for a street network"):
        street_network.check_area(con, big)

    # The same answer in mirror-values' shape, which has nothing else to say about it.
    tiny = {"type": "Polygon", "coordinates": box(11.40, 47.26, 0.01)}
    sized = street_network.size(con, tiny)
    assert sized["too_large"] is False and sized["cells"] == small
    assert street_network.size(con, big)["too_large"]

    # Two towns far apart are read as two small boxes, not the one between them.
    asked = []
    monkeypatch.setattr(
        street_network,
        "h3_3_cells_for_bbox",
        lambda bbox, ring=1: asked.append(bbox) or set(),
    )
    with pytest.raises(ValueError, match="does not cover"):
        street_network.export_network(
            con,
            area=both,
            edges_base=str(tmp_path),
            nodes_base=str(tmp_path),
            workdir=str(tmp_path),
        )
    assert len(asked) == 2 and all(b[2] - b[0] < 0.1 for b in asked)


def test_network_islands() -> None:
    """A 2-edge piece (under 1%) is dropped with its nodes; a 4-edge piece (over 1%) stays."""
    import duckdb
    from goatlib.io.fetch import street_network

    con = duckdb.connect()
    con.execute(
        "CREATE TEMP TABLE network_edges (id VARCHAR, source_node VARCHAR, target_node VARCHAR)"
    )
    big = [(f"b{i}", f"n{i}", f"n{i + 1}") for i in range(200)]
    small = [(f"s{i}", f"m{i}", f"m{i + 1}") for i in range(4)]
    island = [("i0", "x0", "x1"), ("i1", "x1", "x2")]
    con.executemany("INSERT INTO network_edges VALUES (?, ?, ?)", big + small + island)
    street_network._drop_islands(con)
    ids = {r[0] for r in con.execute("SELECT id FROM network_edges").fetchall()}
    assert ids == {e[0] for e in big + small}
    nodes = {
        r[0]
        for r in con.execute(
            "SELECT source_node FROM network_edges UNION SELECT target_node FROM network_edges"
        ).fetchall()
    }
    assert not {"x0", "x1", "x2"} & nodes and {"m0", "m4"} <= nodes


@pytest.mark.parametrize(
    ("source_name", "feature_type"), [("foo", "points"), ("overture", "points")]
)
def test_an_unknown_source_or_type_is_refused(source_name, feature_type) -> None:
    import duckdb

    area_ = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
    with pytest.raises(ValueError, match="No 'points'"):
        values.mirror_values(
            duckdb.connect(),
            area=area_,
            feature_type=feature_type,
            source_name=source_name,
        )
