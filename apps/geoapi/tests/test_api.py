"""Tests for API endpoints."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from geoapi.dependencies import LayerInfo


def features_json_fragment(features):
    """Mimic get_features_json's return: (fragment, returned, total)."""
    fragment = ",".join(json.dumps(f, separators=(",", ":")) for f in features)
    return fragment, len(features)


class TestHealthCheck:
    """Tests for health check endpoint."""

    def test_health_check(self, test_client):
        """Test health check returns ok."""
        response = test_client.get("/healthz")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["ping"] == "pong"


class TestLandingPage:
    """Tests for landing page endpoint."""

    def test_landing_page(self, test_client):
        """Test landing page returns correct structure."""
        response = test_client.get("/")
        assert response.status_code == 200
        data = response.json()

        assert "title" in data
        assert "links" in data
        assert len(data["links"]) > 0

        # Check for required link relations
        rels = [link["rel"] for link in data["links"]]
        assert "self" in rels
        assert "conformance" in rels


class TestConformance:
    """Tests for conformance endpoint."""

    def test_conformance(self, test_client):
        """Test conformance returns conformance classes."""
        response = test_client.get("/conformance")
        assert response.status_code == 200
        data = response.json()

        assert "conformsTo" in data
        assert len(data["conformsTo"]) > 0

        # Check for some expected conformance classes
        assert any("ogcapi-features" in c for c in data["conformsTo"])
        assert any("ogcapi-tiles" in c for c in data["conformsTo"])


class TestTileMatrixSets:
    """Tests for tile matrix sets endpoints."""

    def test_list_tile_matrix_sets(self, test_client):
        """Test listing tile matrix sets."""
        response = test_client.get("/tileMatrixSets")
        assert response.status_code == 200
        data = response.json()

        assert "tileMatrixSets" in data
        assert len(data["tileMatrixSets"]) > 0

        # Check for WebMercatorQuad
        ids = [tms["id"] for tms in data["tileMatrixSets"]]
        assert "WebMercatorQuad" in ids

    def test_get_tile_matrix_set(self, test_client):
        """Test getting a specific tile matrix set."""
        response = test_client.get("/tileMatrixSets/WebMercatorQuad")
        assert response.status_code == 200
        data = response.json()

        assert data["id"] == "WebMercatorQuad"

    def test_get_invalid_tile_matrix_set(self, test_client):
        """Test getting an invalid tile matrix set returns 400."""
        response = test_client.get("/tileMatrixSets/InvalidTMS")
        assert response.status_code == 400


class TestCollectionEndpoints:
    """Tests for collection endpoints."""

    @patch("geoapi.routers.metadata.layer_service")
    def test_get_collection(
        self, mock_layer_service, test_client, sample_layer_metadata
    ):
        """Test getting collection metadata."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )

        response = test_client.get("/collections/abc123de-f456-7890-1234-5678901234ab")
        assert response.status_code == 200
        data = response.json()

        assert "id" in data
        assert "links" in data

    @patch("geoapi.routers.metadata.layer_service")
    def test_get_collection_not_found(self, mock_layer_service, test_client):
        """Test getting non-existent collection returns 404."""
        mock_layer_service.get_layer_metadata = AsyncMock(return_value=None)

        response = test_client.get("/collections/abc123de-f456-7890-1234-5678901234ab")
        assert response.status_code == 404

    def test_get_collection_invalid_format(self, test_client):
        """Test getting collection with invalid ID format returns 400."""
        response = test_client.get("/collections/invalid-format")
        assert response.status_code == 400

    @patch("geoapi.routers.metadata.layer_service")
    def test_get_queryables(
        self, mock_layer_service, test_client, sample_layer_metadata
    ):
        """Test getting collection queryables."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/queryables"
        )
        assert response.status_code == 200
        data = response.json()

        assert "title" in data
        assert "properties" in data
        assert "type" in data
        assert data["type"] == "object"


class TestFeatureEndpoints:
    """Tests for feature endpoints."""

    @patch("geoapi.routers.features.feature_service")
    @patch("geoapi.routers.features.layer_service")
    def test_get_features(
        self,
        mock_layer_service,
        mock_feature_service,
        test_client,
        sample_layer_metadata,
        sample_features,
    ):
        """Test getting features from a collection."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        fragment, returned = features_json_fragment(sample_features)
        mock_feature_service.get_features_json = MagicMock(
            return_value=(fragment, returned, 2)
        )

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/items"
        )
        assert response.status_code == 200
        data = response.json()

        assert data["type"] == "FeatureCollection"
        assert "features" in data
        assert "numberMatched" in data
        assert "numberReturned" in data
        assert "links" in data

    @patch("geoapi.routers.features.feature_service")
    @patch("geoapi.routers.features.layer_service")
    def test_get_features_has_no_per_feature_links(
        self,
        mock_layer_service,
        mock_feature_service,
        test_client,
        sample_layer_metadata,
        sample_features,
    ):
        """Features in the items response must not carry per-feature links.

        OGC API Features Core only requires links on the response document
        (/req/core/fc-links) and on the single-feature resource
        (/req/core/f-links); per-feature links in the collection are pure
        payload overhead for bulk consumers.
        """
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        fragment, returned = features_json_fragment(sample_features)
        mock_feature_service.get_features_json = MagicMock(
            return_value=(fragment, returned, 2)
        )

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/items"
        )
        assert response.status_code == 200
        data = response.json()

        assert len(data["features"]) == 2
        for feature in data["features"]:
            assert "links" not in feature

        # Top-level document links stay (OGC requirement)
        rels = [link["rel"] for link in data["links"]]
        assert "self" in rels

    @patch("geoapi.routers.features.feature_service")
    @patch("geoapi.routers.features.layer_service")
    def test_get_features_large_response_is_gzipped(
        self,
        mock_layer_service,
        mock_feature_service,
        test_client,
        sample_layer_metadata,
    ):
        """Items responses above the size threshold are served gzip-encoded."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        features = [
            {
                "type": "Feature",
                "id": str(i),
                "geometry": {"type": "Point", "coordinates": [10.0, 52.0]},
                "properties": {"name": f"feature-{i}", "value": i},
            }
            for i in range(100)
        ]
        fragment, returned = features_json_fragment(features)
        mock_feature_service.get_features_json = MagicMock(
            return_value=(fragment, returned, 100)
        )

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/items",
            headers={"Accept-Encoding": "gzip"},
        )
        assert response.status_code == 200
        assert response.headers.get("content-encoding") == "gzip"
        data = response.json()
        assert data["numberReturned"] == 100

    @patch("geoapi.routers.features.feature_service")
    @patch("geoapi.routers.features.layer_service")
    def test_get_features_with_limit(
        self,
        mock_layer_service,
        mock_feature_service,
        test_client,
        sample_layer_metadata,
        sample_features,
    ):
        """Test getting features with limit parameter."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        fragment, returned = features_json_fragment(sample_features[:1])
        mock_feature_service.get_features_json = MagicMock(
            return_value=(fragment, returned, 2)
        )

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/items?limit=1"
        )
        assert response.status_code == 200
        data = response.json()

        # Check for next page link since there are more items
        rels = [link["rel"] for link in data["links"]]
        assert "next" in rels

    @patch("geoapi.routers.features.feature_service")
    @patch("geoapi.routers.features.layer_service")
    def test_get_feature_by_id(
        self,
        mock_layer_service,
        mock_feature_service,
        test_client,
        sample_layer_metadata,
        sample_features,
    ):
        """Test getting a single feature by ID."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        mock_feature_service.get_feature_by_id = MagicMock(
            return_value=sample_features[0]
        )

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/items/feature-1"
        )
        assert response.status_code == 200
        data = response.json()

        assert data["type"] == "Feature"
        assert data["id"] == "feature-1"

        # Single-feature resource keeps its links (OGC /req/core/f-links)
        rels = [link["rel"] for link in data["links"]]
        assert "self" in rels
        assert "collection" in rels

    @patch("geoapi.routers.features.feature_service")
    @patch("geoapi.routers.features.layer_service")
    def test_get_feature_not_found(
        self,
        mock_layer_service,
        mock_feature_service,
        test_client,
        sample_layer_metadata,
    ):
        """Test getting non-existent feature returns 404."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        mock_feature_service.get_feature_by_id = MagicMock(return_value=None)

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/items/nonexistent"
        )
        assert response.status_code == 404


class TestFeatureFieldValidation:
    """Unknown `properties`/`sortby` names must 400, not 500.

    Both reach the query builders as quoted identifiers; before validation
    an unknown name failed inside DuckDB and surfaced as a 500.
    """

    COLLECTION = "/collections/abc123de-f456-7890-1234-5678901234ab/items"

    @patch("geoapi.routers.features.feature_service")
    @patch("geoapi.routers.features.layer_service")
    def test_unknown_sortby_is_rejected(
        self,
        mock_layer_service,
        mock_feature_service,
        test_client,
        sample_layer_metadata,
    ):
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        mock_feature_service.get_features_json = MagicMock(
            side_effect=AssertionError("query must not run for an unknown field")
        )

        response = test_client.get(f"{self.COLLECTION}?sortby=-nope")
        assert response.status_code == 400
        assert "nope" in response.json()["detail"]

    @patch("geoapi.routers.features.feature_service")
    @patch("geoapi.routers.features.layer_service")
    def test_unknown_property_is_rejected(
        self,
        mock_layer_service,
        mock_feature_service,
        test_client,
        sample_layer_metadata,
    ):
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        mock_feature_service.get_features_json = MagicMock(
            side_effect=AssertionError("query must not run for an unknown field")
        )

        response = test_client.get(f"{self.COLLECTION}?properties=name,nope")
        assert response.status_code == 400
        assert "nope" in response.json()["detail"]

    @patch("geoapi.routers.features.feature_service")
    @patch("geoapi.routers.features.layer_service")
    def test_known_fields_still_pass(
        self,
        mock_layer_service,
        mock_feature_service,
        test_client,
        sample_layer_metadata,
        sample_features,
    ):
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        fragment, returned = features_json_fragment(sample_features)
        mock_feature_service.get_features_json = MagicMock(
            return_value=(fragment, returned, 2)
        )

        response = test_client.get(f"{self.COLLECTION}?properties=name,value&sortby=id")
        assert response.status_code == 200

    @patch("geoapi.routers.features.feature_service")
    @patch("geoapi.routers.features.layer_service")
    def test_unknown_property_on_single_feature_is_rejected(
        self,
        mock_layer_service,
        mock_feature_service,
        test_client,
        sample_layer_metadata,
    ):
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        mock_feature_service.get_feature_by_id = MagicMock(
            side_effect=AssertionError("query must not run for an unknown field")
        )

        response = test_client.get(f"{self.COLLECTION}/1?properties=nope")
        assert response.status_code == 400
        assert "nope" in response.json()["detail"]


class TestTileFieldValidation:
    """Unknown `?properties=` on the tile route must 400, not 500.

    The dynamic (GeoParquet) tile path splices the requested property names
    into the MVT query; the PMTiles fast paths ignore them.
    """

    TILE = (
        "/collections/abc123de-f456-7890-1234-5678901234ab"
        "/tiles/WebMercatorQuad/10/512/256"
    )

    @staticmethod
    def _force_dynamic(mock_tile_service):
        mock_tile_service.can_serve_from_pmtiles_by_layer_id = MagicMock(
            return_value=False
        )
        mock_tile_service.can_serve_from_pmtiles = MagicMock(return_value=False)

    @patch("geoapi.routers.tiles.tile_service")
    @patch("geoapi.routers.tiles.layer_service")
    def test_unknown_property_is_rejected(
        self, mock_layer_service, mock_tile_service, test_client, sample_layer_metadata
    ):
        # Cold cache: the column list is resolved once, then validated.
        mock_layer_service.cached_metadata = MagicMock(return_value=None)
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        self._force_dynamic(mock_tile_service)
        mock_tile_service.get_tile = AsyncMock(
            side_effect=AssertionError("tile query must not run for an unknown field")
        )

        response = test_client.get(f"{self.TILE}?dynamic=true&properties=name,nope")
        assert response.status_code == 400
        assert "nope" in response.json()["detail"]

    @patch("geoapi.routers.tiles.tile_service")
    @patch("geoapi.routers.tiles.layer_service")
    def test_known_properties_still_pass(
        self, mock_layer_service, mock_tile_service, test_client, sample_layer_metadata
    ):
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        mock_layer_service.cached_metadata = MagicMock(
            return_value=sample_layer_metadata
        )
        self._force_dynamic(mock_tile_service)
        mock_tile_service.get_tile = AsyncMock(
            return_value=(b"\x1a\x00", False, "geoparquet")
        )

        response = test_client.get(f"{self.TILE}?dynamic=true&properties=name,value")
        assert response.status_code == 200

    @patch("geoapi.routers.tiles.tile_service")
    @patch("geoapi.routers.tiles.layer_service")
    def test_pmtiles_path_rejects_the_same_unknown_property(
        self, mock_layer_service, mock_tile_service, test_client, sample_layer_metadata
    ):
        """A PMTiles-served layer must answer an unknown field like the dynamic path.

        Same request, same 400 — otherwise the contract depends on which
        storage happens to back the tile.
        """
        mock_layer_service.cached_metadata = MagicMock(
            return_value=sample_layer_metadata
        )
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        mock_tile_service.can_serve_from_pmtiles_by_layer_id = MagicMock(
            return_value=True
        )
        mock_tile_service.get_tile_from_pmtiles_by_layer_id = AsyncMock(
            return_value=(b"\x1a\x00", False, "pmtiles")
        )

        response = test_client.get(f"{self.TILE}?properties=name,nope")
        assert response.status_code == 400
        assert "nope" in response.json()["detail"]

    @patch("geoapi.routers.tiles.tile_service")
    @patch("geoapi.routers.tiles.layer_service")
    def test_pmtiles_path_still_serves_known_properties(
        self, mock_layer_service, mock_tile_service, test_client, sample_layer_metadata
    ):
        mock_layer_service.cached_metadata = MagicMock(
            return_value=sample_layer_metadata
        )
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        mock_tile_service.can_serve_from_pmtiles_by_layer_id = MagicMock(
            return_value=True
        )
        mock_tile_service.get_tile_from_pmtiles_by_layer_id = AsyncMock(
            return_value=(b"\x1a\x00", False, "pmtiles")
        )

        response = test_client.get(f"{self.TILE}?properties=name,value")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/vnd.mapbox-vector-tile"

    @patch("geoapi.routers.tiles.tile_service")
    @patch("geoapi.routers.tiles.layer_service")
    def test_a_warm_cache_costs_no_metadata_lookup(
        self, mock_layer_service, mock_tile_service, test_client, sample_layer_metadata
    ):
        """The fast path reads the shared cache, not Postgres/DuckLake, per tile."""
        mock_layer_service.cached_metadata = MagicMock(
            return_value=sample_layer_metadata
        )
        mock_layer_service.get_layer_metadata = AsyncMock(
            side_effect=AssertionError("a warm cache must not trigger a lookup")
        )
        mock_tile_service.can_serve_from_pmtiles_by_layer_id = MagicMock(
            return_value=True
        )
        mock_tile_service.get_tile_from_pmtiles_by_layer_id = AsyncMock(
            return_value=(b"\x1a\x00", False, "pmtiles")
        )

        response = test_client.get(f"{self.TILE}?properties=name")
        assert response.status_code == 200


class TestTileEndpoints:
    """Tests for tile endpoints."""

    @patch("geoapi.routers.tiles.tile_service")
    @patch("geoapi.routers.tiles.layer_service")
    def test_get_tile(
        self, mock_layer_service, mock_tile_service, test_client, sample_layer_metadata
    ):
        """Test getting a vector tile."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        mock_tile_service.can_serve_from_pmtiles_by_layer_id = MagicMock(
            return_value=True
        )
        mock_tile_service.get_tile_from_pmtiles_by_layer_id = AsyncMock(
            return_value=(b"\x1a\x00", False, "pmtiles")  # Minimal MVT bytes
        )

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/tiles/WebMercatorQuad/10/512/256"
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/vnd.mapbox-vector-tile"

    @patch("geoapi.routers.tiles.tile_service")
    @patch("geoapi.routers.tiles.layer_service")
    def test_get_empty_tile(
        self, mock_layer_service, mock_tile_service, test_client, sample_layer_metadata
    ):
        """Test getting an empty tile returns 204."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )
        mock_tile_service.can_serve_from_pmtiles_by_layer_id = MagicMock(
            return_value=True
        )
        mock_tile_service.get_tile_from_pmtiles_by_layer_id = AsyncMock(
            return_value=(b"", False, "pmtiles")
        )

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/tiles/WebMercatorQuad/10/512/256"
        )
        assert response.status_code == 204

    TILE = (
        "/collections/abc123de-f456-7890-1234-5678901234ab"
        "/tiles/WebMercatorQuad/10/512/256"
    )

    @patch("geoapi.dependencies.get_layer_info")
    @patch("geoapi.routers.tiles.tile_service")
    def test_an_unknown_id_is_served_from_workflow_tiles(
        self, mock_tile_service, mock_get_layer_info, test_client
    ):
        """No layer by that id: the workflow temp tree is searched, once."""
        mock_get_layer_info.side_effect = HTTPException(status_code=404)
        mock_tile_service.can_serve_from_pmtiles_by_layer_id = MagicMock(
            return_value=True
        )
        mock_tile_service.get_tile_from_pmtiles_by_layer_id = AsyncMock(
            side_effect=[None, (b"\x1a\x00", False, "pmtiles")]
        )

        response = test_client.get(self.TILE)

        assert response.status_code == 200
        searches = [
            c.kwargs["search_temp"]
            for c in mock_tile_service.get_tile_from_pmtiles_by_layer_id.call_args_list
        ]
        assert searches == [False, True]

    @patch("geoapi.dependencies.get_layer_info")
    @patch("geoapi.routers.tiles.tile_service")
    def test_a_layer_never_searches_workflow_tiles(
        self, mock_tile_service, mock_get_layer_info, test_client
    ):
        """A known layer without flat tiles goes on to its own paths; the
        workflow temp tree is not searched for it."""
        mock_get_layer_info.return_value = LayerInfo(
            layer_id="abc123def456789012345678901234ab",
            schema_name="user_x",
            table_name="t_abc123def456789012345678901234ab",
        )
        mock_tile_service.can_serve_from_pmtiles_by_layer_id = MagicMock(
            return_value=True
        )
        mock_tile_service.get_tile_from_pmtiles_by_layer_id = AsyncMock(
            return_value=None
        )
        mock_tile_service.can_serve_from_pmtiles = MagicMock(return_value=True)
        mock_tile_service.get_tile_from_pmtiles_only = AsyncMock(
            return_value=(b"\x1a\x00", False, "pmtiles")
        )

        response = test_client.get(self.TILE)

        assert response.status_code == 200
        calls = mock_tile_service.get_tile_from_pmtiles_by_layer_id.call_args_list
        assert [c.kwargs["search_temp"] for c in calls] == [False]

    @patch("geoapi.dependencies.get_layer_info")
    @patch("geoapi.routers.tiles.tile_service")
    def test_a_temp_hint_searches_workflow_tiles_straight_away(
        self, mock_tile_service, mock_get_layer_info, test_client
    ):
        mock_tile_service.can_serve_from_pmtiles_by_layer_id = MagicMock(
            return_value=True
        )
        mock_tile_service.get_tile_from_pmtiles_by_layer_id = AsyncMock(
            return_value=(b"\x1a\x00", False, "pmtiles")
        )

        response = test_client.get(f"{self.TILE}?temp=true")

        assert response.status_code == 200
        call = mock_tile_service.get_tile_from_pmtiles_by_layer_id.call_args
        assert call.kwargs["search_temp"] is True
        mock_get_layer_info.assert_not_called()

    @patch("geoapi.routers.tiles.layer_service")
    def test_get_tilejson(self, mock_layer_service, test_client, sample_layer_metadata):
        """Test getting TileJSON."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/tiles/WebMercatorQuad/tilejson.json"
        )
        assert response.status_code == 200
        data = response.json()

        assert "tilejson" in data
        assert "tiles" in data
        assert "vector_layers" in data

    @patch("geoapi.routers.tiles.layer_service")
    def test_get_stylejson(
        self, mock_layer_service, test_client, sample_layer_metadata
    ):
        """Test getting StyleJSON."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/tiles/WebMercatorQuad/style.json"
        )
        assert response.status_code == 200
        data = response.json()

        assert "version" in data
        assert "sources" in data
        assert "layers" in data

    @patch("geoapi.routers.tiles.layer_service")
    def test_list_tilesets(
        self, mock_layer_service, test_client, sample_layer_metadata
    ):
        """Test listing tilesets for a collection."""
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=sample_layer_metadata
        )

        response = test_client.get(
            "/collections/abc123de-f456-7890-1234-5678901234ab/tiles"
        )
        assert response.status_code == 200
        data = response.json()

        assert isinstance(data, list)
        assert len(data) > 0
