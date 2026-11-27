"""Unit tests for GeocodingTool with mocked Pelias API."""

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import duckdb
import pytest
from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.geoanalysis import GeocodingTool
from goatlib.analysis.schemas.geocoding import (
    FieldSourceType,
    GeocodingInputMode,
    GeocodingParams,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.geocoding import GeocodingToolParams, GeocodingToolRunner

# =============================================================================
# Mock Pelias Responses
# =============================================================================


def create_pelias_response(
    lat: float | None,
    lon: float | None,
    confidence: float | None = 1.0,
    match_type: str | None = "exact",
    label: str | None = None,
    postalcode: str | None = None,
) -> dict:
    """Create a mock Pelias GeoJSON response."""
    if lat is None or lon is None:
        return {"type": "FeatureCollection", "features": []}

    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [lon, lat],
                },
                "properties": {
                    "confidence": confidence,
                    "match_type": match_type,
                    "label": label or f"Mocked Address at {lat}, {lon}",
                    "postalcode": postalcode,
                },
            }
        ],
    }


# Mock responses for different addresses
MOCK_RESPONSES = {
    "Marienplatz 1, München, Germany": create_pelias_response(
        48.137563, 11.574858, postalcode="80331"
    ),
    "Alexanderplatz 1, Berlin, Germany": create_pelias_response(
        52.521270, 13.412683, postalcode="10178"
    ),
    "Unknown Address, Nowhere": create_pelias_response(None, None),
}


def get_mock_response(
    url: str, query_text: str | None = None, query_params: dict | None = None
) -> dict:
    """Get mock response for a query (works for both free-text and structured)."""
    if query_text and query_text in MOCK_RESPONSES:
        return MOCK_RESPONSES[query_text]

    # Default response with coordinates based on hash of query
    key = query_text or str(sorted((query_params or {}).items()))
    hash_val = hash(key) % 1000
    lat = 48.0 + (hash_val / 1000)
    lon = 11.0 + (hash_val / 1000)
    return create_pelias_response(lat, lon, confidence=0.8, match_type="interpolated")


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def test_input_path(tmp_path: Path) -> Path:
    """Create a test input parquet file."""
    con = duckdb.connect(":memory:")
    con.execute("""
        CREATE TABLE test_addresses AS
        SELECT * FROM (VALUES
            (1, 'Marienplatz 1', 'München', '80331', 'Marienplatz 1, München, Germany'),
            (2, 'Alexanderplatz 1', 'Berlin', '10178', 'Alexanderplatz 1, Berlin, Germany'),
            (3, 'Königstraße 26', 'Stuttgart', '70173', 'Königstraße 26, Stuttgart, Germany')
        ) AS t(id, street, city, postal_code, full_address)
    """)

    output_path = tmp_path / "test_addresses.parquet"
    con.execute(f"COPY test_addresses TO '{output_path}' (FORMAT PARQUET)")
    con.close()

    return output_path


@pytest.fixture
def large_input_path(tmp_path: Path) -> Path:
    """Create a test input parquet file with more than MAX_FEATURES rows."""
    con = duckdb.connect(":memory:")
    con.execute("""
        CREATE TABLE big_addresses AS
        SELECT
            i AS id,
            'Street ' || i AS street,
            'City' AS city,
            '12345' AS postal_code,
            'Street ' || i || ', City, Germany' AS full_address
        FROM generate_series(1, 30001) AS t(i)
    """)

    output_path = tmp_path / "big_addresses.parquet"
    con.execute(f"COPY big_addresses TO '{output_path}' (FORMAT PARQUET)")
    con.close()

    return output_path


# =============================================================================
# Helpers
# =============================================================================


def make_mock_client(side_effect: Any) -> AsyncMock:
    """Build an AsyncMock httpx client with the given side_effect for .get()."""
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(side_effect=side_effect)
    return mock_client


def patch_httpx(mock_client: AsyncMock) -> Any:
    """Context manager that patches httpx.AsyncClient in the geocoding module."""
    mock_class = MagicMock()
    mock_class.return_value.__aenter__ = AsyncMock(return_value=mock_client)
    mock_class.return_value.__aexit__ = AsyncMock(return_value=None)
    return patch("goatlib.analysis.geoanalysis.geocoding.httpx.AsyncClient", mock_class)


# =============================================================================
# Tests
# =============================================================================


class TestGeocodingTool:
    """Tests for GeocodingTool."""

    def test_geocode_full_address_mode(
        self, test_input_path: Path, tmp_path: Path
    ) -> None:
        """Test geocoding with full_address mode."""
        output_path = tmp_path / "geocoded_output.parquet"

        params = GeocodingParams(
            input_path=str(test_input_path),
            input_mode=GeocodingInputMode.full_address,
            full_address_field="full_address",
            output_path=str(output_path),
            geocoder_url="https://mock.geocoder.test",
            geocoder_authorization="Basic placeholder",
        )

        def mock_get_side_effect(
            url: str, params: dict | None = None, headers: dict | None = None
        ) -> MagicMock:
            query_text = (params or {}).get("text", "")
            response_data = get_mock_response(url, query_text=query_text)
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = response_data
            return mock_response

        mock_client = make_mock_client(mock_get_side_effect)
        with patch_httpx(mock_client):
            tool = GeocodingTool()
            results = tool.run(params)

        assert len(results) == 1
        result_path, metadata = results[0]

        assert isinstance(metadata, DatasetMetadata)
        assert metadata.source_type == "vector"
        assert metadata.format == "geoparquet"
        assert metadata.geometry_type == "Point"
        assert metadata.crs == "EPSG:4326"

        assert result_path.exists()

        con = duckdb.connect(":memory:")
        con.execute("INSTALL spatial; LOAD spatial;")

        result = con.execute(f"""
            SELECT id, full_address, geocode_latitude, geocode_longitude,
                   geocode_confidence, geocode_match_type, geocode_label,
                   ST_AsText(geometry) as geom
            FROM read_parquet('{result_path}')
            ORDER BY id
        """).fetchall()

        assert len(result) == 3

        row = result[0]
        assert row[0] == 1
        assert row[1] == "Marienplatz 1, München, Germany"
        assert row[2] is not None  # latitude
        assert row[3] is not None  # longitude
        assert row[7] is not None  # geometry

        con.close()

    def test_geocode_structured_mode_uses_structured_endpoint(
        self, test_input_path: Path, tmp_path: Path
    ) -> None:
        """Structured mode must call /v1/search/structured, not /v1/search."""
        output_path = tmp_path / "geocoded_structured.parquet"

        params = GeocodingParams(
            input_path=str(test_input_path),
            input_mode=GeocodingInputMode.structured,
            address_field="street",
            locality_source_type=FieldSourceType.field,
            locality_field="city",
            postalcode_field="postal_code",
            country_source_type=FieldSourceType.constant,
            country_constant="Germany",
            output_path=str(output_path),
            geocoder_url="https://mock.geocoder.test",
            geocoder_authorization="Basic placeholder",
        )

        called_urls: list[str] = []

        def mock_get_side_effect(
            url: str, params: dict | None = None, headers: dict | None = None
        ) -> MagicMock:
            called_urls.append(url)
            response_data = get_mock_response(url, query_params=params)
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = response_data
            return mock_response

        mock_client = make_mock_client(mock_get_side_effect)
        with patch_httpx(mock_client):
            tool = GeocodingTool()
            results = tool.run(params)

        result_path, _ = results[0]
        assert result_path.exists()

        # All requests must go to the structured endpoint
        assert all(
            "/v1/search/structured" in u for u in called_urls
        ), f"Expected all calls to /v1/search/structured, got: {called_urls}"

        # Verify output has geocode_input_text column
        con = duckdb.connect(":memory:")
        result = con.execute(f"""
            SELECT geocode_input_text
            FROM read_parquet('{result_path}')
            ORDER BY id
        """).fetchall()

        assert "Marienplatz 1" in result[0][0]
        assert "München" in result[0][0]
        con.close()

    def test_full_address_plz_scoring_picks_matching_plz(self, tmp_path: Path) -> None:
        """Full-address mode should prefer the candidate whose PLZ matches the query."""
        con = duckdb.connect(":memory:")
        con.execute("""
            CREATE TABLE addrs AS
            SELECT 1 AS id, 'Sautierstraße 1, 79104, Freiburg' AS full_address
        """)
        input_path = tmp_path / "input.parquet"
        con.execute(f"COPY addrs TO '{input_path}' (FORMAT PARQUET)")
        con.close()

        output_path = tmp_path / "output.parquet"

        params = GeocodingParams(
            input_path=str(input_path),
            input_mode=GeocodingInputMode.full_address,
            full_address_field="full_address",
            output_path=str(output_path),
            geocoder_url="https://mock.geocoder.test",
            geocoder_authorization="Basic placeholder",
        )

        # Return two candidates: first is Geisingen (wrong PLZ), second is Freiburg (correct)
        wrong_response = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [8.65, 47.93]},
                    "properties": {
                        "confidence": 0.9,
                        "match_type": "exact",
                        "label": "Sautierstraße 1, 78187 Geisingen",
                        "postalcode": "78187",
                    },
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [7.85, 47.99]},
                    "properties": {
                        "confidence": 0.85,
                        "match_type": "exact",
                        "label": "Sautierstraße 1, 79104 Freiburg",
                        "postalcode": "79104",
                    },
                },
            ],
        }

        def mock_get_side_effect(
            url: str, params: dict | None = None, headers: dict | None = None
        ) -> MagicMock:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = wrong_response
            return mock_response

        mock_client = make_mock_client(mock_get_side_effect)
        with patch_httpx(mock_client):
            tool = GeocodingTool()
            results = tool.run(params)

        con = duckdb.connect(":memory:")
        row = con.execute(f"""
            SELECT geocode_postalcode, geocode_label
            FROM read_parquet('{results[0][0]}')
        """).fetchone()
        con.close()

        assert row[0] == "79104", f"Expected Freiburg PLZ 79104, got {row[0]}"
        assert "Freiburg" in (row[1] or ""), f"Expected Freiburg in label, got {row[1]}"

    def test_plz_mismatch_overrides_match_type(self, tmp_path: Path) -> None:
        """When no candidate has a matching PLZ, match_type must be 'plz_mismatch', not 'exact'."""
        con = duckdb.connect(":memory:")
        con.execute("""
            CREATE TABLE addrs AS
            SELECT 1 AS id, 'Markgrafstr. 8, Karlsruhe, 76131' AS full_address
        """)
        input_path = tmp_path / "input.parquet"
        con.execute(f"COPY addrs TO '{input_path}' (FORMAT PARQUET)")
        con.close()

        output_path = tmp_path / "output.parquet"
        params = GeocodingParams(
            input_path=str(input_path),
            input_mode=GeocodingInputMode.full_address,
            full_address_field="full_address",
            output_path=str(output_path),
            geocoder_url="https://mock.geocoder.test",
            geocoder_authorization="Basic placeholder",
        )

        # All 3 candidates have the wrong PLZ (76571, 76135, 76530) — none matches 76131
        wrong_response = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [8.32, 48.80]},
                    "properties": {
                        "confidence": 1.0,
                        "match_type": "exact",
                        "label": "Markgraf-Wilhelm-Straße 8, Gaggenau",
                        "postalcode": "76571",
                    },
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [8.40, 49.00]},
                    "properties": {
                        "confidence": 0.9,
                        "match_type": "exact",
                        "label": "Markgrafstraße 8, Karlsruhe",
                        "postalcode": "76135",
                    },
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [8.24, 48.76]},
                    "properties": {
                        "confidence": 0.8,
                        "match_type": "exact",
                        "label": "Markgrafstraße 8, Baden-Baden",
                        "postalcode": "76530",
                    },
                },
            ],
        }

        def mock_get(
            url: str, params: dict | None = None, headers: dict | None = None
        ) -> MagicMock:
            r = MagicMock()
            r.status_code = 200
            r.json.return_value = wrong_response
            return r

        mock_client = make_mock_client(mock_get)
        with patch_httpx(mock_client):
            tool = GeocodingTool()
            results = tool.run(params)

        con = duckdb.connect(":memory:")
        row = con.execute(f"""
            SELECT geocode_match_type, geocode_postalcode
            FROM read_parquet('{results[0][0]}')
        """).fetchone()
        con.close()

        assert row[0] == "plz_mismatch", (
            f"Expected 'plz_mismatch' but got '{row[0]}' — "
            "Pelias's 'exact' must not be passed through when PLZ doesn't match"
        )

    def test_structured_plz_mismatch_overrides_match_type(self, tmp_path: Path) -> None:
        """Structured mode must also flag PLZ mismatches, not pass through 'exact'."""
        con = duckdb.connect(":memory:")
        con.execute("""
            CREATE TABLE addrs AS
            SELECT 1 AS id, 'Bahnhofstr. 1-3' AS street,
                   '69190' AS plz, 'Walldorf' AS city
        """)
        input_path = tmp_path / "input.parquet"
        con.execute(f"COPY addrs TO '{input_path}' (FORMAT PARQUET)")
        con.close()

        output_path = tmp_path / "output.parquet"
        params = GeocodingParams(
            input_path=str(input_path),
            input_mode=GeocodingInputMode.structured,
            address_field="street",
            postalcode_field="plz",
            locality_source_type=FieldSourceType.field,
            locality_field="city",
            country_source_type=FieldSourceType.constant,
            country_constant="DE",
            output_path=str(output_path),
            geocoder_url="https://mock.geocoder.test",
            geocoder_authorization="Basic placeholder",
        )

        # Structured endpoint returns a result with a different PLZ (fallback to wrong city)
        wrong_response = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [9.12, 49.14]},
                    "properties": {
                        "confidence": 0.8,
                        "match_type": "fallback",
                        "label": "Bahnhofstraße, Walldorf, TH, Germany",
                        "postalcode": "99441",  # wrong — Walldorf in Thüringen
                    },
                }
            ],
        }

        def mock_get(
            url: str, params: dict | None = None, headers: dict | None = None
        ) -> MagicMock:
            r = MagicMock()
            r.status_code = 200
            r.json.return_value = wrong_response
            return r

        mock_client = make_mock_client(mock_get)
        with patch_httpx(mock_client):
            tool = GeocodingTool()
            results = tool.run(params)

        con = duckdb.connect(":memory:")
        row = con.execute(f"""
            SELECT geocode_match_type FROM read_parquet('{results[0][0]}')
        """).fetchone()
        con.close()

        assert (
            row[0] == "plz_mismatch"
        ), f"Expected 'plz_mismatch' for structured mode PLZ mismatch, got '{row[0]}'"

    def test_geocode_with_locality_constant(
        self, test_input_path: Path, tmp_path: Path
    ) -> None:
        """Test geocoding with locality as a constant."""
        output_path = tmp_path / "geocoded_constants.parquet"

        params = GeocodingParams(
            input_path=str(test_input_path),
            input_mode=GeocodingInputMode.structured,
            address_field="street",
            locality_source_type=FieldSourceType.constant,
            locality_constant="Munich",
            country_source_type=FieldSourceType.constant,
            country_constant="Germany",
            output_path=str(output_path),
            geocoder_url="https://mock.geocoder.test",
            geocoder_authorization="Basic placeholder",
        )

        called_params: list[dict] = []

        def mock_get_side_effect(
            url: str, params: dict | None = None, headers: dict | None = None
        ) -> MagicMock:
            called_params.append(params or {})
            response_data = get_mock_response(url, query_params=params)
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = response_data
            return mock_response

        mock_client = make_mock_client(mock_get_side_effect)
        with patch_httpx(mock_client):
            tool = GeocodingTool()
            results = tool.run(params)

        result_path, _ = results[0]
        assert result_path.exists()

        # All structured requests should contain locality=Munich
        for p in called_params:
            assert p.get("locality") == "Munich", f"Missing locality in params: {p}"
            assert p.get("country") == "Germany", f"Missing country in params: {p}"

        check_tool_style(
            GeocodingToolRunner,
            tool_params(GeocodingToolParams, params, input_layer_id=U),
            result_path,
        )

    def test_max_features_limit(self, large_input_path: Path, tmp_path: Path) -> None:
        """Test that geocoding fails when input exceeds MAX_FEATURES."""
        output_path = tmp_path / "geocoded_big.parquet"

        params = GeocodingParams(
            input_path=str(large_input_path),
            input_mode=GeocodingInputMode.full_address,
            full_address_field="full_address",
            output_path=str(output_path),
            geocoder_url="https://mock.geocoder.test",
            geocoder_authorization="Basic placeholder",
        )

        tool = GeocodingTool()
        with pytest.raises(ValueError) as exc_info:
            tool.run(params)

        assert "30001" in str(exc_info.value)
        assert "30000" in str(exc_info.value)

    def test_geocode_handles_no_match(self, tmp_path: Path) -> None:
        """Test that geocoding handles addresses with no match."""
        con = duckdb.connect(":memory:")
        con.execute("""
            CREATE TABLE no_match AS
            SELECT 1 AS id, 'Unknown Address, Nowhere' AS full_address
        """)
        input_path = tmp_path / "no_match.parquet"
        con.execute(f"COPY no_match TO '{input_path}' (FORMAT PARQUET)")
        con.close()

        output_path = tmp_path / "geocoded_no_match.parquet"

        params = GeocodingParams(
            input_path=str(input_path),
            input_mode=GeocodingInputMode.full_address,
            full_address_field="full_address",
            output_path=str(output_path),
            geocoder_url="https://mock.geocoder.test",
            geocoder_authorization="Basic placeholder",
        )

        def mock_get_side_effect(
            url: str, params: dict | None = None, headers: dict | None = None
        ) -> MagicMock:
            query_text = (params or {}).get("text", "")
            response_data = get_mock_response(url, query_text=query_text)
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = response_data
            return mock_response

        mock_client = make_mock_client(mock_get_side_effect)
        with patch_httpx(mock_client):
            tool = GeocodingTool()
            results = tool.run(params)

        result_path, _ = results[0]

        con = duckdb.connect(":memory:")
        con.execute("INSTALL spatial; LOAD spatial;")
        result = con.execute(f"""
            SELECT geocode_latitude, geocode_longitude, geometry
            FROM read_parquet('{result_path}')
        """).fetchone()

        assert result[0] is None
        assert result[1] is None
        assert result[2] is None

        con.close()

    def test_geocode_handles_api_error(
        self, test_input_path: Path, tmp_path: Path
    ) -> None:
        """Test that geocoding handles API errors gracefully."""
        output_path = tmp_path / "geocoded_error.parquet"

        params = GeocodingParams(
            input_path=str(test_input_path),
            input_mode=GeocodingInputMode.full_address,
            full_address_field="full_address",
            output_path=str(output_path),
            geocoder_url="https://mock.geocoder.test",
            geocoder_authorization="Basic placeholder",
        )

        def mock_error_response(
            url: str, params: dict | None = None, headers: dict | None = None
        ) -> MagicMock:
            mock_response = MagicMock()
            mock_response.status_code = 500
            return mock_response

        mock_client = make_mock_client(mock_error_response)
        with patch_httpx(mock_client):
            tool = GeocodingTool()
            results = tool.run(params)

        result_path, _ = results[0]
        assert result_path.exists()

        con = duckdb.connect(":memory:")
        result = con.execute(f"""
            SELECT COUNT(*) as total, COUNT(geocode_latitude) as with_coords
            FROM read_parquet('{result_path}')
        """).fetchone()

        assert result[0] == 3
        assert result[1] == 0

        con.close()


class TestGeocodingParams:
    """Tests for GeocodingParams schema."""

    def _base_params(self, **kwargs: Any) -> dict:
        return {
            "input_path": "/tmp/test.parquet",
            "output_path": "/tmp/output.parquet",
            "geocoder_url": "https://test.geocoder",
            "geocoder_authorization": "Basic placeholder",
            **kwargs,
        }

    def test_build_query_text_full_address(self) -> None:
        params = GeocodingParams(
            **self._base_params(
                input_mode=GeocodingInputMode.full_address,
                full_address_field="address",
            )
        )
        row = {"address": "Marienplatz 1, Munich, Germany", "id": 1}
        assert params.build_query_text(row) == "Marienplatz 1, Munich, Germany"

    def test_build_structured_query_params(self) -> None:
        params = GeocodingParams(
            **self._base_params(
                input_mode=GeocodingInputMode.structured,
                address_field="street",
                locality_source_type=FieldSourceType.field,
                locality_field="city",
                postalcode_field="zip",
                country_source_type=FieldSourceType.constant,
                country_constant="Germany",
            )
        )
        row = {"street": "Marienplatz 1", "city": "Munich", "zip": "80331"}
        p = params.build_structured_query_params(row)

        assert p["address"] == "Marienplatz 1"
        assert p["locality"] == "Munich"
        assert p["postalcode"] == "80331"
        assert p["country"] == "Germany"
        assert "region" not in p  # not provided

    def test_build_structured_query_params_excludes_none_region(self) -> None:
        """Region should not appear in structured params when not set."""
        params = GeocodingParams(
            **self._base_params(
                input_mode=GeocodingInputMode.structured,
                address_field="street",
                locality_source_type=FieldSourceType.constant,
                locality_constant="Walldorf",
                postalcode_field="plz",
                country_source_type=FieldSourceType.constant,
                country_constant="DE",
            )
        )
        row = {"street": "Bahnhofstr. 1-3", "plz": "69190"}
        p = params.build_structured_query_params(row)

        assert p["address"] == "Bahnhofstr. 1-3"
        assert p["locality"] == "Walldorf"
        assert p["postalcode"] == "69190"
        assert p["country"] == "DE"
        assert "region" not in p  # "Baden" must NOT appear as a free-text component
