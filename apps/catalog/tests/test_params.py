"""The request models in ``catalog.routers.params``.

Two things are worth pinning here beyond what the endpoint tests already
cover: that the statically declared facet parameters and the registry's
derived ones cannot drift apart, and that one parsing definition really does
serve every encoding a client uses (comma-separated, repeated, JSON body).
"""

from fastapi.testclient import TestClient

from catalog.routers.params import (
    AggregateQuery,
    CollectionSearchQuery,
    FacetFilters,
    SearchQuery,
)
from catalog.services.registry import QueryableRegistry
from catalog.store import CatalogStore


def test_facet_filters_cover_every_seeded_filter_param(
    registry: QueryableRegistry,
) -> None:
    """The declared query parameters must equal the registry's filterable set.

    ``FacetFilters`` is written out by hand so the parameters appear in the
    OpenAPI document and stay visible to the type checker; this is what stops
    that from silently falling behind ``registry.filter_params()``. Seeding a
    new facet therefore fails here until the parameter is declared.
    """
    assert set(FacetFilters.model_fields) == set(registry.filter_params())


def test_filter_fields_uses_canonical_names() -> None:
    """An alias the caller used never reaches the query builder."""
    query = SearchQuery.model_validate({"data_category": "transportation"})
    assert query.filter_fields() == {"themes": "transportation"}


def test_unset_filters_are_absent() -> None:
    assert SearchQuery().filter_fields() == {}


class TestValueEncodings:
    """One parsing definition per value shape, whatever encoding it arrives in."""

    def test_csv_and_repeated_params_agree(self, client: TestClient) -> None:
        csv = client.get(
            "/stac/search", params={"ids": "src-1-member-0,src-1-member-1"}
        )
        repeated = client.get(
            "/stac/search",
            params=[("ids", "src-1-member-0"), ("ids", "src-1-member-1")],
        )
        assert csv.status_code == repeated.status_code == 200
        assert {f["id"] for f in csv.json()["features"]} == {
            f["id"] for f in repeated.json()["features"]
        }

    def test_bbox_parses_the_same_for_get_and_post(self, client: TestClient) -> None:
        get_resp = client.get("/stac/search", params={"bbox": "5,47,16,56"})
        post_resp = client.post("/stac/search", json={"bbox": [5, 47, 16, 56]})
        assert get_resp.status_code == post_resp.status_code == 200
        assert get_resp.json()["numberMatched"] == post_resp.json()["numberMatched"] > 0

    def test_sortby_object_and_string_forms_agree(self, client: TestClient) -> None:
        as_string = client.post("/stac/search", json={"sortby": "-properties.title"})
        as_object = client.post(
            "/stac/search",
            json={"sortby": [{"field": "properties.title", "direction": "desc"}]},
        )
        assert as_string.status_code == as_object.status_code == 200
        assert [f["id"] for f in as_string.json()["features"]] == [
            f["id"] for f in as_object.json()["features"]
        ]

    def test_bbox_mode_is_constrained_to_the_documented_values(
        self, client: TestClient
    ) -> None:
        resp = client.get("/stac/search", params={"bbox_mode": "bogus"})
        assert resp.status_code == 400
        assert resp.json()["code"] == 400


class TestSharedSurface:
    """Every search endpoint accepts the same filters, because they share a model."""

    def test_geometry_type_now_filters_item_search_too(
        self, client: TestClient, store: CatalogStore
    ) -> None:
        """``geometry_type`` used to exist on ``/collections`` only.

        Item Search hardcoded ``geom_type=None``, so the parameter was silently
        ignored there -- exactly the drift that a shared model prevents.
        """
        resp = client.get(
            "/stac/search", params={"geometry_type": "polygon", "limit": 50}
        )
        assert resp.status_code == 200
        docs = resp.json()["features"]
        assert docs
        for feature in docs:
            assert feature["properties"]["goat:geometryType"] == "polygon"

    def test_aggregate_and_search_take_the_same_filters(
        self, client: TestClient
    ) -> None:
        filters = {"themes": "transportation", "license": "CC-BY-4.0"}
        search = client.get("/stac/search", params={**filters, "limit": 100})
        aggregate = client.get("/stac/aggregate", params=filters)
        assert search.status_code == aggregate.status_code == 200
        totals = {
            a["name"]: a.get("value")
            for a in aggregate.json()["aggregations"]
            if a["name"] == "total_count"
        }
        assert totals["total_count"] == search.json()["numberMatched"]

    def test_values_ticked_in_one_facet_are_either(self, client: TestClient) -> None:
        """The web repeats the parameter per ticked value; it means the same OR
        as the comma form, not only the last value."""

        def matched(params: dict[str, str] | list[tuple[str, str]]) -> int:
            resp = client.get("/stac/collections", params=params)
            assert resp.status_code == 200
            return resp.json()["numberMatched"]

        line = matched({"geometry_type": "line"})
        point = matched({"geometry_type": "point"})
        either = matched({"geometry_type": "line,point"})
        assert either > max(line, point)
        assert (
            matched([("geometry_type", "line"), ("geometry_type", "point")]) == either
        )

    def test_year_filter_is_typed_at_the_edge(self, client: TestClient) -> None:
        assert client.get("/stac/search", params={"year": 2026}).status_code == 200
        bad = client.get("/stac/search", params={"year": "not-a-year"})
        assert bad.status_code == 400
        assert bad.json()["code"] == 400

    def test_every_search_model_shares_the_facet_surface(self) -> None:
        for model in (SearchQuery, CollectionSearchQuery, AggregateQuery):
            assert set(FacetFilters.model_fields) <= set(model.model_fields)
