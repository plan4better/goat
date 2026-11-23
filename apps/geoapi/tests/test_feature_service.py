"""Tests for feature service query construction."""

import json

import duckdb
import pytest

from geoapi.services.feature_service import (
    build_features_json_query,
    build_items_select_clause,
)

NATIVE_COLUMN_TYPES = {
    "id": "UUID",
    "name": "VARCHAR",
    "bbox_1": "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)",
    "geometry": "GEOMETRY",
}


class TestBuildItemsSelectClause:
    """The items SELECT must not ship internal storage columns."""

    def test_excludes_renamed_bbox_struct(self):
        clause = build_items_select_clause(
            properties=None,
            geometry_column="geometry",
            has_geometry=True,
            native_column_types=NATIVE_COLUMN_TYPES,
        )
        assert "EXCLUDE" in clause
        assert '"bbox_1"' in clause
        assert 'ST_AsGeoJSON("geometry") AS geom_json' in clause

    def test_excludes_plain_bbox_struct(self):
        types = {
            "name": "VARCHAR",
            "bbox": "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)",
            "geometry": "GEOMETRY",
        }
        clause = build_items_select_clause(
            properties=None,
            geometry_column="geometry",
            has_geometry=True,
            native_column_types=types,
        )
        assert '"bbox"' in clause
        assert "EXCLUDE" in clause

    def test_keeps_user_column_that_only_looks_like_bbox(self):
        types = {
            "bbox_2": "VARCHAR",
            "geometry": "GEOMETRY",
        }
        clause = build_items_select_clause(
            properties=None,
            geometry_column="geometry",
            has_geometry=True,
            native_column_types=types,
        )
        assert '"bbox_2"' not in clause

    def test_excludes_raw_geometry_column_from_star(self):
        clause = build_items_select_clause(
            properties=None,
            geometry_column="geometry",
            has_geometry=True,
            native_column_types=NATIVE_COLUMN_TYPES,
        )
        assert '"geometry"' in clause.split("EXCLUDE")[1]

    def test_no_geometry_layer_without_hidden_columns(self):
        clause = build_items_select_clause(
            properties=None,
            geometry_column=None,
            has_geometry=False,
            native_column_types={"name": "VARCHAR"},
        )
        assert clause == "rowid, *"

    def test_explicit_properties_are_honored(self):
        clause = build_items_select_clause(
            properties=["name"],
            geometry_column="geometry",
            has_geometry=True,
            native_column_types=NATIVE_COLUMN_TYPES,
        )
        assert '"name"' in clause
        assert "EXCLUDE" not in clause
        assert 'ST_AsGeoJSON("geometry") AS geom_json' in clause

    def test_unknown_column_types_still_excludes_geometry(self):
        clause = build_items_select_clause(
            properties=None,
            geometry_column="geometry",
            has_geometry=True,
            native_column_types=None,
        )
        assert 'EXCLUDE ("geometry")' in clause


NATIVE_TYPES_FULL = {
    "name": "VARCHAR",
    "value": "INTEGER",
    "tags": "JSON",
    "created": "TIMESTAMP",
    "created_tz": "TIMESTAMP WITH TIME ZONE",
    "geometry": "GEOMETRY",
}

PROP_COLS = ["name", "value", "tags", "created", "created_tz"]


@pytest.fixture
def con():
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("SET TimeZone='Europe/Berlin'")
    con.execute("""
        CREATE TABLE feats (
            name VARCHAR, value INTEGER, tags JSON,
            created TIMESTAMP, created_tz TIMESTAMPTZ, geometry GEOMETRY
        )
    """)
    con.execute("""
        INSERT INTO feats VALUES
        ('alpha', 10, '{"a": 1}', TIMESTAMP '2026-02-25 06:00:00.578',
         TIMESTAMPTZ '2026-02-25 06:00:00+01', ST_Point(10.0, 52.0)),
        ('beta', 30, NULL, NULL, NULL, ST_Point(11.5, 48.1)),
        ('gamma', 20, '{"b": [2]}', TIMESTAMP '2026-02-25 07:00:00',
         TIMESTAMPTZ '2026-02-25 07:00:00+01', NULL)
    """)
    yield con
    con.close()


def run_query(con, **overrides):
    kwargs = dict(
        table="feats",
        prop_columns=PROP_COLS,
        geometry_column="geometry",
        where_sql="1=1",
        sortby=None,
        limit=10,
        offset=0,
        native_column_types=NATIVE_TYPES_FULL,
    )
    kwargs.update(overrides)
    sql = build_features_json_query(**kwargs)
    features_json, returned = con.execute(sql).fetchone()
    features = json.loads(f"[{features_json}]") if features_json else []
    return features, returned


class TestBuildFeaturesJsonQuery:
    """SQL-side GeoJSON generation must match the Python path's output."""

    def test_basic_feature_shape(self, con):
        features, returned = run_query(con)
        assert returned == 3
        assert len(features) == 3
        f = features[0]
        assert sorted(f.keys()) == ["geometry", "id", "properties", "type"]
        assert f["type"] == "Feature"
        assert f["id"] == "1"  # rowid 0 + 1, as string
        assert f["geometry"] == {"type": "Point", "coordinates": [10.0, 52.0]}
        assert sorted(f["properties"].keys()) == sorted(PROP_COLS)
        assert f["properties"]["name"] == "alpha"
        assert f["properties"]["value"] == 10

    def test_json_column_is_nested_not_string(self, con):
        features, _ = run_query(con)
        assert features[0]["properties"]["tags"] == {"a": 1}

    def test_null_values_and_null_geometry(self, con):
        features, _ = run_query(con)
        beta, gamma = features[1], features[2]
        assert beta["properties"]["tags"] is None
        assert beta["properties"]["created"] is None
        assert gamma["geometry"] is None

    def test_timestamp_iso_format_with_t(self, con):
        features, _ = run_query(con)
        assert features[0]["properties"]["created"] == "2026-02-25T06:00:00.578000"

    def test_timestamptz_utc_with_z(self, con):
        features, _ = run_query(con)
        assert features[0]["properties"]["created_tz"] == "2026-02-25T05:00:00.000000Z"

    def test_sortby_desc_orders_output(self, con):
        features, _ = run_query(con, sortby="-value")
        assert [f["properties"]["value"] for f in features] == [30, 20, 10]

    def test_sortby_asc_orders_output(self, con):
        features, _ = run_query(con, sortby="value")
        assert [f["properties"]["value"] for f in features] == [10, 20, 30]

    def test_limit_offset(self, con):
        features, returned = run_query(con, sortby="value", limit=1, offset=1)
        assert returned == 1
        assert features[0]["properties"]["value"] == 20

    def test_where_filter(self, con):
        features, returned = run_query(con, where_sql="value > 15")
        assert returned == 2
        assert {f["properties"]["name"] for f in features} == {"beta", "gamma"}

    def test_empty_result(self, con):
        features, returned = run_query(con, where_sql="1=0")
        assert features == []
        assert returned == 0

    def test_no_geometry_layer(self, con):
        features, _ = run_query(con, geometry_column=None)
        assert all(f["geometry"] is None for f in features)

    def test_default_order_is_rowid(self, con):
        features, _ = run_query(con)
        assert [f["id"] for f in features] == ["1", "2", "3"]


class TestGetFeaturesJsonProperties:
    """`properties` picks the columns; an empty list returns features without properties."""

    @pytest.fixture
    def run(self, con, monkeypatch):
        import importlib
        from unittest.mock import MagicMock

        module = importlib.import_module("geoapi.services.feature_service")

        def execute(_pool, query, params=None, fetch_all=False):
            cursor = con.execute(query, params or [])
            return cursor.fetchone(), cursor.description

        monkeypatch.setattr(module, "execute_with_retry", execute)

        def run(properties):
            fragment, returned, total = module.feature_service.get_features_json(
                layer_info=MagicMock(full_table_name="feats"),
                limit=10,
                properties=properties,
                column_names=PROP_COLS + ["geometry"],
                native_column_types=NATIVE_TYPES_FULL,
            )
            return json.loads(f"[{fragment}]"), returned, total

        return run

    def test_listed_properties_only(self, run):
        features, _, _ = run(["name"])
        assert [f["properties"] for f in features] == [
            {"name": "alpha"},
            {"name": "beta"},
            {"name": "gamma"},
        ]

    def test_empty_list_returns_no_properties(self, run):
        features, returned, total = run([])
        assert (returned, total) == (3, 3)
        assert [f["properties"] for f in features] == [{}, {}, {}]
        assert [f["id"] for f in features] == ["1", "2", "3"]
        assert features[0]["geometry"] == {"type": "Point", "coordinates": [10.0, 52.0]}

    def test_no_list_returns_every_property(self, run):
        features, _, _ = run(None)
        assert set(features[0]["properties"]) == set(PROP_COLS)


class TestGetTempFeaturesProperties:
    """A workflow result's features take `properties` as a stored layer's do."""

    @pytest.fixture
    def run(self, tmp_path, monkeypatch):
        import importlib

        module = importlib.import_module("geoapi.services.feature_service")

        user = "11111111-2222-3333-4444-555555555555"
        layer = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        monkeypatch.setattr(
            module.settings, "DUCKLAKE_DATA_DIR", str(tmp_path / "ducklake")
        )
        folder = tmp_path / "temporary" / f"user_{user.replace('-', '')}" / "w_1"
        folder.mkdir(parents=True)
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(
            "COPY (SELECT * FROM (VALUES ('alpha', 1, ST_Point(10, 52)), "
            "('beta', 2, ST_Point(11, 53))) t(name, value, geometry)) "
            f"TO '{folder / ('t_' + layer.replace('-', '') + '.parquet')}' (FORMAT parquet)"
        )

        def run(properties):
            return module.feature_service.get_temp_features(
                user_id=user,
                layer_uuid=layer,
                limit=10,
                offset=0,
                properties=properties,
            )

        return run

    def test_listed_properties_only(self, run):
        features, total = run(["name"])
        assert total == 2
        assert [f["properties"] for f in features] == [
            {"name": "alpha"},
            {"name": "beta"},
        ]

    def test_empty_list_returns_no_properties(self, run):
        features, total = run([])
        assert total == 2
        assert [f["properties"] for f in features] == [{}, {}]
        assert features[0]["geometry"] == {"type": "Point", "coordinates": [10.0, 52.0]}

    def test_no_list_returns_every_property(self, run):
        features, _ = run(None)
        assert features[0]["properties"] == {"name": "alpha", "value": 1}
