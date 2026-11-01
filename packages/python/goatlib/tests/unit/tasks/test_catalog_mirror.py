"""Tests for the native stac-geoparquet -> flat mirror converter."""

from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.tasks.catalog_mirror import build_mirror
from goatlib.tasks.sync_catalog import (
    REQUIRED_ITEM_COLUMNS,
)


@pytest.fixture()
def published(tmp_path: Path) -> tuple[Path, Path]:
    """A miniature published catalog: 3 items (one geometry-less), 1 collection."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        """
        CREATE TABLE items AS
        SELECT * FROM (VALUES
            ('i-geom', 'c-1', 'With geometry', 'de',
             ST_GeomFromText('POLYGON((10 50, 11 50, 11 51, 10 51, 10 50))'),
             {'xmin': 10.0, 'ymin': 50.0, 'xmax': 11.0, 'ymax': 51.0}, 100),
            ('i-bboxless', 'c-1', 'Geometry but no bbox', 'de',
             ST_GeomFromText('POINT(9 48)'), NULL, 5),
            ('i-nogeom', 'c-1', 'Statistical table', 'de', NULL, NULL, 7)
        ) AS t(id, collection, title, "language_code", geometry, bbox,
               "table:row_count")
        """
    )
    # `language` is a STRUCT upstream; mirror that shape.
    con.execute(
        """CREATE TABLE items2 AS SELECT id, collection, title,
           {'code': language_code} AS language, geometry, bbox,
           "table:row_count", '1.0.0' AS stac_version FROM items"""
    )
    con.execute(
        """
        CREATE TABLE collections AS
        SELECT * FROM (VALUES
            ('c-1', 'Collection', 'CC-BY-4.0',
             [{'name': 'Stadt Wien', 'roles': ['producer']}],
             [{'scheme': 'https://goat.plan4better.de/data-categories',
               'concepts': [{'id': 'transport'}]}],
             'feature')
        ) AS t(id, title, license, providers, themes, "goat:layerType")
        """
    )
    items_path = tmp_path / "items.parquet"
    collections_path = tmp_path / "collections.parquet"
    con.execute(f"COPY items2 TO '{items_path.as_posix()}' (FORMAT PARQUET)")
    con.execute(f"COPY collections TO '{collections_path.as_posix()}' (FORMAT PARQUET)")
    con.close()
    return items_path, collections_path


def _row(con: duckdb.DuckDBPyConnection, sql: str) -> tuple[Any, ...]:
    """The single row a query is expected to return."""
    row = con.execute(sql).fetchone()
    assert row is not None, f"expected one row from: {sql}"
    return row


def _scalar(con: duckdb.DuckDBPyConnection, sql: str) -> Any:
    return _row(con, sql)[0]


def _documents(out: Path) -> dict[str, dict[str, Any]]:
    """Mirror rows by id, geometry as GeoJSON.

    The mirror no longer stores rendered JSON: it passes the published columns
    through and the *service* assembles the document per response. So this
    converter's tests assert on columns, and the document-shape assertions live
    with the assembler, in ``apps/catalog/tests/test_mirror_roundtrip.py``.
    """
    con = duckdb.connect()
    con.execute("LOAD spatial;")
    rows = con.execute(
        f"SELECT * REPLACE (ST_AsGeoJSON(geometry::GEOMETRY) AS geometry) "
        f"FROM read_parquet('{out.as_posix()}')"
    )
    names = [d[0] for d in rows.description]
    records = {}
    for row in rows.fetchall():
        record = dict(zip(names, row, strict=True))
        records[record["id"]] = record
    con.close()
    return records


class TestBboxAndGeometry:
    """STAC pulls these two in opposite directions.

    ``geometry`` is REQUIRED and may be null, so it must be *present* as null.
    ``bbox`` is required only when geometry is non-null, so it must be
    *absent* -- not ``[null,null,null,null]``, which is what a naive
    strip-nulls pass produces and which fails validation on every
    geometry-less item.
    """

    def test_geometry_less_item_keeps_null_geometry_and_omits_bbox(
        self, published: tuple[Path, Path], tmp_path: Path
    ) -> None:
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        build_mirror(*published, out, out_c)
        row = _documents(out)["i-nogeom"]
        assert row["geometry"] is None
        assert row["bbox"] is None

    def test_published_bbox_is_used(
        self, published: tuple[Path, Path], tmp_path: Path
    ) -> None:
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        build_mirror(*published, out, out_c)
        bbox = _documents(out)["i-geom"]["bbox"]
        assert [bbox["xmin"], bbox["ymin"], bbox["xmax"], bbox["ymax"]] == [
            10.0,
            50.0,
            11.0,
            51.0,
        ]

    def test_bbox_is_derived_when_only_geometry_is_published(
        self, published: tuple[Path, Path], tmp_path: Path
    ) -> None:
        """bbox is REQUIRED whenever geometry is non-null, so it is computed."""
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        build_mirror(*published, out, out_c)
        row = _documents(out)["i-bboxless"]
        # No published bbox: the envelope columns carry the geometry's extent,
        # and the service derives the document's `bbox` from the geometry.
        assert (row["bbox_xmin"], row["bbox_ymin"]) == (9.0, 48.0)


class TestDenormalisation:
    def test_collection_fields_are_joined_onto_items(
        self, published: tuple[Path, Path], tmp_path: Path
    ) -> None:
        """license/publisher live only on the Collection; the page facets items."""
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        build_mirror(*published, out, out_c)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        row = _row(
            con,
            f"""SELECT license, publisher, category, language_code,
                       "goat:layerType"
                FROM read_parquet('{out.as_posix()}') WHERE id = 'i-geom'""",
        )
        con.close()
        assert row == ("CC-BY-4.0", "Stadt Wien", "transport", "de", "feature")

    def test_row_count_is_items_plus_collections(
        self, published: tuple[Path, Path], tmp_path: Path
    ) -> None:
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        assert build_mirror(*published, out, out_c) == (3, 1)


class TestDerivedColumns:
    """Columns the mirror computes so the service never has to per request."""

    def test_items_and_collections_are_separate_relations(
        self, published: tuple[Path, Path], tmp_path: Path
    ) -> None:
        """No discriminator column: the relation *is* the kind.

        A single `type` column used to carry both the STAC object kind and the
        GOAT layer vocabulary, so the service's items-only predicate depended on
        a value the harvester also writes.
        """
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        build_mirror(*published, out, out_c)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        item_columns = {
            row[0]
            for row in con.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{out.as_posix()}')"
            ).fetchall()
        }
        n_items = _scalar(con, f"SELECT count(*) FROM read_parquet('{out.as_posix()}')")
        n_collections = _scalar(
            con, f"SELECT count(*) FROM read_parquet('{out_c.as_posix()}')"
        )
        con.close()
        assert n_items == 3
        assert n_collections == 1
        assert "kind" not in item_columns, "no discriminator column is needed"
        # An item states its layer type, denormalised from its collection.
        assert "goat:layerType" in item_columns

    def test_search_text_folds_title_description_keywords(
        self, published: tuple[Path, Path], tmp_path: Path
    ) -> None:
        """One lowercase haystack per row, so `q` is a single-column scan."""
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        build_mirror(*published, out, out_c)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        text = _scalar(
            con,
            f"SELECT search_text FROM read_parquet('{out.as_posix()}') "
            f"WHERE id = 'i-geom'",
        )
        con.close()
        assert text == text.lower()
        title = _documents(out)["i-geom"]["title"]
        assert title.lower() in text

    def test_bundle_membership_is_precomputed(
        self, published: tuple[Path, Path], tmp_path: Path
    ) -> None:
        """Every member row carries the real size of its dataset.

        This is what lets a card state "4 layers" without a GROUP BY over every
        item row per request.
        """
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        build_mirror(*published, out, out_c)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        groups = con.execute(
            f"""SELECT coalesce(collection, id) AS grp,
                       count(*) AS members,
                       max(member_count) AS stored
                FROM read_parquet('{out.as_posix()}')
                GROUP BY grp"""
        ).fetchall()
        con.close()
        assert groups
        for _grp, members, stored in groups:
            assert stored == members, "member_count must equal the real group size"


class TestSchemaTolerance:
    def test_absent_columns_become_null_not_an_error(
        self, published: tuple[Path, Path], tmp_path: Path
    ) -> None:
        """The published schema changes without notice; a missing promoted
        column must yield NULL rather than a binder error."""
        items_path, collections_path = published
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        stripped = tmp_path / "items-stripped.parquet"
        con.execute(
            f"""COPY (SELECT id, collection, title, geometry
                      FROM read_parquet('{items_path.as_posix()}'))
                TO '{stripped.as_posix()}' (FORMAT PARQUET)"""
        )
        con.close()
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        assert build_mirror(stripped, collections_path, out, out_c) == (3, 1)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        # A column the published file lacks is a typed NULL, not a bind error:
        # `language_code` is guaranteed, `version` is simply absent.
        columns = _scalar(
            con,
            f"SELECT list(column_name) FROM (DESCRIBE SELECT * FROM "
            f"read_parquet('{out.as_posix()}'))",
        )
        code = _scalar(
            con,
            f"SELECT language_code FROM read_parquet('{out.as_posix()}') "
            f"WHERE id = 'i-geom'",
        )
        con.close()
        assert "version" not in columns
        assert code is None


def test_timestamps_are_rfc3339_in_the_document(tmp_path: Path) -> None:
    """DuckDB renders TIMESTAMPTZ as '2025-01-14 00:00:00+00', which is not
    RFC 3339 and which the catalog's own datetime parser rejects."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    items = tmp_path / "items.parquet"
    colls = tmp_path / "collections.parquet"
    con.execute(
        f"""COPY (SELECT 'i' AS id, 'c' AS collection, NULL::GEOMETRY AS geometry,
                  TIMESTAMPTZ '2025-01-14 08:30:00+02' AS datetime)
            TO '{items.as_posix()}' (FORMAT PARQUET)"""
    )
    con.execute(f"COPY (SELECT 'c' AS id) TO '{colls.as_posix()}' (FORMAT PARQUET)")
    con.close()
    out = tmp_path / "catalog.parquet"
    out_c = tmp_path / "collections_mirror.parquet"
    build_mirror(items, colls, out, out_c)
    # The mirror keeps a real timestamp; RFC 3339 formatting is the service's
    # job now that it assembles the document.
    from catalog.services.stac_build import item_from_row  # noqa: PLC0415

    assert (
        item_from_row(_documents(out)["i"])["properties"]["datetime"]
        == "2025-01-14T06:30:00Z"
    )


def test_mirror_emits_every_column_the_consumer_requires(
    published: tuple[Path, Path], tmp_path: Path
) -> None:
    """``build_mirror`` must produce every column the contract requires.

    That tuple is what ``sync_catalog`` validates a downloaded mirror against
    and what ``apps/catalog`` declares as its schema, and the two live in
    separate deployables that cannot import each other. Nothing else compares
    them, so a column renamed on one side of the contract and not the other
    reaches the service as a runtime binder error on whichever endpoint happens
    to touch it -- which is how ``group_bbox_*`` first shipped as ``group_*``.
    """
    out = tmp_path / "catalog.parquet"
    out_c = tmp_path / "collections_mirror.parquet"
    build_mirror(*published, out, out_c)
    con = duckdb.connect()
    con.execute("LOAD spatial;")
    produced = {
        row[0]
        for row in con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{out.as_posix()}')"
        ).fetchall()
    }
    con.close()
    missing = set(REQUIRED_ITEM_COLUMNS) - produced
    assert not missing, f"build_mirror does not emit: {sorted(missing)}"
    # Extra columns are expected: the mirror passes every published column
    # through, so the contract is a floor rather than the exact schema.


@pytest.fixture
def dataset_level_text(tmp_path: Path) -> tuple[Path, Path]:
    """The live catalog's real shape: prose on the Collection, not on the items.

    Measured on the harvested mirror: 0 of 10,793 items carry a description and 0
    carry keywords, while 3,834 of 3,834 collections carry a description and 96%
    carry keywords. The published item is a *layer* of a dataset and the
    description belongs to the dataset.
    """
    con = duckdb.connect()
    con.execute("LOAD spatial;")
    con.execute(
        """
        CREATE TABLE items AS
        SELECT * FROM (VALUES
            ('i-1', 'c-1', 'Bodenbedeckung Stichtag 2021', NULL, NULL,
             ST_GeomFromText('POINT(9 48)'), '1.0.0'),
            ('i-own', 'c-1', 'Layer with its own words', 'Layer prose.',
             ['layerword'], ST_GeomFromText('POINT(9 48)'), '1.0.0')
        ) AS t(id, collection, title, description, keywords, geometry, stac_version)
        """
    )
    con.execute(
        """
        CREATE TABLE collections AS
        SELECT * FROM (VALUES
            ('c-1', 'Digitales Landschaftsmodell',
             'Umfasst die Flächen von Flüssen über 5 m Breite.',
             ['Gewässer', 'Landschaftsmodell'])
        ) AS t(id, title, description, keywords)
        """
    )
    items_path = tmp_path / "items.parquet"
    collections_path = tmp_path / "collections.parquet"
    con.execute(f"COPY items TO '{items_path.as_posix()}' (FORMAT PARQUET)")
    con.execute(f"COPY collections TO '{collections_path.as_posix()}' (FORMAT PARQUET)")
    con.close()
    return items_path, collections_path


class TestDatasetLevelTextIsInherited:
    """An item borrows its Collection's description and keywords.

    Without this the catalog looks empty and searches badly: every result card
    has no description to show, and ``q`` matches titles only -- the item
    haystack measured 44 characters against the collection's 655, so ~93% of the
    catalog's searchable prose was unreachable.
    """

    def test_item_without_description_inherits_the_collections(
        self, dataset_level_text: tuple[Path, Path], tmp_path: Path
    ) -> None:
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        build_mirror(*dataset_level_text, out, out_c)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        inherited, keywords = _row(
            con,
            f"SELECT description, keywords FROM read_parquet('{out.as_posix()}') "
            f"WHERE id = 'i-1'",
        )
        con.close()
        assert inherited == "Umfasst die Flächen von Flüssen über 5 m Breite."
        assert list(keywords) == ["Gewässer", "Landschaftsmodell"]

    def test_an_items_own_description_wins(
        self, dataset_level_text: tuple[Path, Path], tmp_path: Path
    ) -> None:
        """Inheritance is a fallback, not an override."""
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        build_mirror(*dataset_level_text, out, out_c)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        own, keywords = _row(
            con,
            f"SELECT description, keywords FROM read_parquet('{out.as_posix()}') "
            f"WHERE id = 'i-own'",
        )
        con.close()
        assert own == "Layer prose."
        assert list(keywords) == ["layerword"]

    def test_inherited_text_reaches_the_free_text_haystack(
        self, dataset_level_text: tuple[Path, Path], tmp_path: Path
    ) -> None:
        """`q` has to match a word that only the Collection states."""
        out = tmp_path / "catalog.parquet"
        out_c = tmp_path / "collections_mirror.parquet"
        build_mirror(*dataset_level_text, out, out_c)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        text = _scalar(
            con,
            f"SELECT search_text FROM read_parquet('{out.as_posix()}') "
            f"WHERE id = 'i-1'",
        )
        con.close()
        assert "flüssen" in text, "description words must be searchable"
        assert "gewässer" in text, "keywords must be searchable"
        assert "bodenbedeckung" in text, "the item's own title still counts"


def test_a_collection_is_shaped_like_its_layers_not_like_their_bounding_box(
    published: tuple[Path, Path], tmp_path: Path
) -> None:
    """The Koblenz case: the gap between two far-apart layers is not covered."""
    out, out_c = tmp_path / "catalog.parquet", tmp_path / "collections.parquet"
    build_mirror(*published, out, out_c)
    con = duckdb.connect()
    con.execute("LOAD spatial;")
    # Between the polygon layer and the point layer, inside the envelope of both.
    gap = "ST_Point(9.5, 49.0)"
    in_geometry, in_envelope = con.execute(
        f"""SELECT ST_Intersects(geometry, {gap}),
                   ST_Intersects(ST_Envelope(geometry), {gap})
              FROM read_parquet('{out_c.as_posix()}')"""
    ).fetchone()
    con.close()
    assert in_envelope is True, "the gap must lie inside the bounding box"
    assert in_geometry is False, "the collection must not claim the gap"


def test_a_bundle_of_tables_claims_nowhere(tmp_path: Path) -> None:
    """A table-only Collection carries no geometry: its STAC extent is the world."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        """CREATE TABLE items AS SELECT * FROM (VALUES
             ('t-1', 'c-tables', 'Population by age', 'de',
              CAST(NULL AS GEOMETRY), NULL, 50),
             ('t-2', 'c-tables', 'Households', 'de',
              CAST(NULL AS GEOMETRY), NULL, 20)
           ) AS t(id, collection, title, "language_code", geometry, bbox,
                  "table:row_count")"""
    )
    con.execute(
        """CREATE TABLE collections AS SELECT * FROM (VALUES
             ('c-tables', 'Statistics', {'spatial': {'bbox': [[-180.0, -90.0, 180.0, 90.0]]}})
           ) AS t(id, title, extent)"""
    )
    items_p, colls_p = tmp_path / "i.parquet", tmp_path / "c.parquet"
    con.execute(f"COPY items TO '{items_p.as_posix()}' (FORMAT PARQUET)")
    con.execute(f"COPY collections TO '{colls_p.as_posix()}' (FORMAT PARQUET)")
    con.close()

    out, out_c = tmp_path / "mi.parquet", tmp_path / "mc.parquet"
    build_mirror(items_p, colls_p, out, out_c)
    con = duckdb.connect()
    con.execute("LOAD spatial;")
    # The mirror stores the column as Parquet's GEOMETRY type, so it reads
    # back as a geometry also when no row has one.
    geom, hit = con.execute(
        f"""SELECT geometry,
                   ST_Intersects(geometry, ST_MakeEnvelope(6.0, 50.0, 7.0, 51.0))
              FROM read_parquet('{out_c.as_posix()}')"""
    ).fetchone()
    con.close()
    assert geom is None, "a bundle of tables must not claim the world"
    assert hit is None, "and must not match a spatial query"
