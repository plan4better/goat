"""The public download keeps the features the layer's filter keeps.

A public project's map sends the layer's saved filter with its requests; its
download sends it too, so the file holds what the map shows. A filter the
export cannot apply is refused: a file of the whole layer would look right.
"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import duckdb
import pytest

from geoapi.routers.download import _filter_clause

COLLECTION = "/collections/abc123de-f456-7890-1234-5678901234ab/download"
KIND_IS_A = {"op": "=", "args": [{"property": "kind"}, "a"]}


@pytest.fixture
def con():
    con = duckdb.connect()
    con.execute("CREATE TABLE t (id INTEGER, kind VARCHAR)")
    con.execute("INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'a')")
    yield con
    con.close()


class TestFilterClause:
    def test_no_filter_gives_no_clause(self, con):
        assert _filter_clause(con, "t", None) == ""

    def test_the_filter_keeps_its_features(self, con):
        clause = _filter_clause(con, "t", KIND_IS_A)
        assert clause.startswith("WHERE ")
        rows = con.execute(f"SELECT id FROM t {clause} ORDER BY id").fetchall()
        assert rows == [(1,), (3,)]

    def test_a_value_never_reaches_the_sql_as_text(self, con):
        sneaky = {"op": "=", "args": [{"property": "kind"}, "a' OR '1'='1"]}
        clause = _filter_clause(con, "t", sneaky)
        assert con.execute(f"SELECT count(*) FROM t {clause}").fetchone() == (0,)

    def test_a_filter_on_a_missing_field_is_refused(self, con):
        missing = {"op": "=", "args": [{"property": "nope"}, 1]}
        with pytest.raises(ValueError):
            _filter_clause(con, "t", missing)


class TestDownloadRoute:
    @patch("geoapi.routers.download.charge_download", new_callable=AsyncMock)
    @patch("geoapi.routers.download._run_export")
    @patch("geoapi.routers.download.layer_service")
    def test_the_filter_reaches_the_export(
        self, mock_layer_service, mock_export, _charge, test_client, tmp_path
    ):
        mock_layer_service.is_layer_in_public_project = AsyncMock(return_value=True)
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=SimpleNamespace(
                name="Layer", organization_id="org1", user_id="own1"
            )
        )
        zip_path = tmp_path / "layer.zip"
        zip_path.write_bytes(b"z")
        mock_export.return_value = str(zip_path)

        response = test_client.get(
            COLLECTION, params={"format": "csv", "filter": json.dumps(KIND_IS_A)}
        )

        assert response.status_code == 200
        assert mock_export.call_args.kwargs["cql_filter"] == KIND_IS_A

    @patch("geoapi.routers.download.layer_service")
    def test_a_text_filter_is_refused(self, mock_layer_service, test_client):
        mock_layer_service.is_layer_in_public_project = AsyncMock(
            side_effect=AssertionError("export must not start")
        )
        response = test_client.get(
            COLLECTION,
            params={
                "format": "csv",
                "filter": "kind = 'a'",
                "filter-lang": "cql2-text",
            },
        )
        assert response.status_code == 400
