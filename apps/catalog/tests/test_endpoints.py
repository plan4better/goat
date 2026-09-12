"""HTTP-layer tests for the ``/stac`` router (Task 9): landing, conformance,
queryables, collections, Item Search (GET+POST), aggregations, the GOAT
resolve/items extensions, ETag caching, and the auth gate. Every handler is
exercised through the real FastAPI app (``TestClient``) against the
deterministic fixture catalog (``tests/fixtures/gen_catalog.py``).
"""

import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from goatlib.auth import JOSEError

from catalog.app import create_app
from catalog.config import CatalogSettings
from catalog.deps import get_store
from catalog.services.aggregations import aggregation_names
from catalog.store import CatalogStore

from .fixtures.gen_catalog import write_catalog


def test_health_absent(tmp_path: Path) -> None:
    app = create_app(CatalogSettings(data_dir=tmp_path))
    with TestClient(app) as client:
        r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {
        "status": "ok",
        "catalog": "absent",
        "items": 0,
        "collections": 0,
    }


def test_health_with_catalog(client: TestClient) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["catalog"] == "v-test-1"
    assert body["items"] == 199


def _member_ids(store: CatalogStore) -> list[str]:
    return [
        row[0]
        for row in store.query(
            f"SELECT id FROM {store.ITEMS} WHERE collection = 'src-1'"
        )
    ]


# --------------------------------------------------------------------------
# Landing / conformance / queryables
# --------------------------------------------------------------------------


def test_landing_conformsto_in_body(client: TestClient) -> None:
    r = client.get("/stac")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "Catalog"
    assert body["conformsTo"]  # non-empty

    rels = {link["rel"] for link in body["links"]}
    assert {"root", "self", "service-desc", "conformance", "data", "search"} <= rels
    assert "aggregate" in rels
    assert "aggregations" in rels
    assert any("queryables" in rel for rel in rels)


def test_forwarded_proto_sets_href_scheme(client: TestClient) -> None:
    """Behind a TLS-terminating proxy every absolute href must be https.

    An http asset href on an https page is active mixed content, which the
    browser blocks -- the style then never loads and the preview falls back to
    an unstyled footprint.
    """
    plain = client.get("/stac").json()
    assert next(
        link["href"] for link in plain["links"] if link["rel"] == "self"
    ).startswith("http://")

    fwd = client.get("/stac", headers={"X-Forwarded-Proto": "https"}).json()
    for link in fwd["links"]:
        assert not link["href"].startswith("http://"), link

    # Asset hrefs are built from the same base, and are the ones the browser fetches.
    items = client.get(
        "/stac/collections/src-1/items", headers={"X-Forwarded-Proto": "https"}
    ).json()
    for feature in items["features"]:
        for asset in (feature.get("assets") or {}).values():
            assert not asset["href"].startswith("http://"), asset


def test_forwarded_proto_ignores_junk(client: TestClient) -> None:
    """Only a scheme this API is served over, and only the first proxy's value."""
    first = client.get("/stac", headers={"X-Forwarded-Proto": "https, http"}).json()
    first_self = next(link["href"] for link in first["links"] if link["rel"] == "self")
    assert first_self.startswith("https://")

    junk = client.get("/stac", headers={"X-Forwarded-Proto": "gopher"}).json()
    junk_self = next(link["href"] for link in junk["links"] if link["rel"] == "self")
    assert junk_self.startswith("http://")


def test_queryables_media_type(client: TestClient) -> None:
    r = client.get("/stac/queryables")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/schema+json")
    props = set(r.json()["properties"])
    assert {"id", "collection", "geometry", "datetime"} <= props


def test_collection_queryables_media_type(client: TestClient) -> None:
    r = client.get("/stac/collections/src-1/queryables")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/schema+json")
    assert r.json()["$id"].endswith("/collections/src-1/queryables")


def test_collection_queryables_404(client: TestClient) -> None:
    r = client.get("/stac/collections/does-not-exist/queryables")
    assert r.status_code == 404


# --------------------------------------------------------------------------
# Collections
# --------------------------------------------------------------------------


def test_collections_datetime_param(client: TestClient) -> None:
    # `limit` past the default page: the relevance order moves src-1 off it.
    r = client.get(
        "/stac/collections",
        params={"datetime": "2026-01-01T00:00:00Z/..", "limit": 200},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["numberMatched"] >= 1
    ids = {c["id"] for c in body["collections"]}
    assert "src-1" in ids


def test_collection_by_id(client: TestClient) -> None:
    r = client.get("/stac/collections/src-1")
    assert r.status_code == 200
    assert r.json()["id"] == "src-1"
    assert r.json()["type"] == "Collection"


def test_collection_not_found_404(client: TestClient) -> None:
    r = client.get("/stac/collections/does-not-exist")
    assert r.status_code == 404
    assert r.json()["code"] == 404


def test_collection_items(client: TestClient, store: CatalogStore) -> None:
    r = client.get("/stac/collections/src-1/items")
    assert r.status_code == 200
    body = r.json()
    assert body["numberMatched"] == 4
    assert {f["id"] for f in body["features"]} == set(_member_ids(store))
    assert all(f["collection"] == "src-1" for f in body["features"])


def test_collection_items_404_for_unknown_collection(client: TestClient) -> None:
    r = client.get("/stac/collections/does-not-exist/items")
    assert r.status_code == 404


def test_collection_item_by_id(client: TestClient, store: CatalogStore) -> None:
    item_id = _member_ids(store)[0]
    r = client.get(f"/stac/collections/src-1/items/{item_id}")
    assert r.status_code == 200
    assert r.json()["id"] == item_id
    assert r.json()["collection"] == "src-1"


def test_collection_item_not_found_404(client: TestClient) -> None:
    r = client.get("/stac/collections/src-1/items/does-not-exist")
    assert r.status_code == 404


def test_collections_intersects_filters_like_bbox(client: TestClient) -> None:
    """A drawn shape narrows Collection Search the way a bbox does.

    The parameter has to be declared on the collections query model: FastAPI
    drops an undeclared query parameter without a word, and the catalog page
    sends every drawn polygon and buffered point as `intersects` -- so the
    filter silently returned the whole catalog.
    """
    # The western half of the fixture's footprints, so some rows fall outside.
    envelope = {
        "type": "Polygon",
        "coordinates": [[[5, 47], [10, 47], [10, 56], [5, 56], [5, 47]]],
    }
    everything = client.get("/stac/collections", params={"limit": 1}).json()
    boxed = client.get(
        "/stac/collections", params={"bbox": "5,47,10,56", "limit": 1}
    ).json()
    drawn = client.get(
        "/stac/collections",
        params={"intersects": json.dumps(envelope), "limit": 1},
    ).json()

    assert drawn["numberMatched"] == boxed["numberMatched"]
    assert drawn["numberMatched"] < everything["numberMatched"]


def test_collections_intersects_invalid_400(client: TestClient) -> None:
    r = client.get("/stac/collections", params={"intersects": "{not json"})
    assert r.status_code == 400


def test_collections_bbox_boost_invalid_400(client: TestClient) -> None:
    r = client.get("/stac/collections", params={"bbox_boost": "5,47,16"})
    assert r.status_code == 400


def test_collections_bbox_boost_valid_ranks_without_excluding(
    client: TestClient,
) -> None:
    r0 = client.get("/stac/collections")
    assert r0.status_code == 200
    n0 = r0.json()["numberMatched"]

    r1 = client.get("/stac/collections", params={"bbox_boost": "5,47,16,56"})
    assert r1.status_code == 200
    assert r1.json()["numberMatched"] == n0


# --------------------------------------------------------------------------
# Item Search
# --------------------------------------------------------------------------


def test_search_get_all_six_core_params(
    client: TestClient, store: CatalogStore
) -> None:
    member_ids = _member_ids(store)
    r = client.get(
        "/stac/search",
        params={
            "collections": "src-1",
            "ids": ",".join(member_ids),
            "bbox": "5,47,16,56",
            "datetime": "2026-01-01T00:00:00Z/..",
            "limit": 10,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert body["numberMatched"] == 4
    assert {f["id"] for f in body["features"]} == set(member_ids)


def test_search_get_intersects_urlencoded(client: TestClient) -> None:
    geometry = {
        "type": "Polygon",
        "coordinates": [[[5, 47], [16, 47], [16, 56], [5, 56], [5, 47]]],
    }
    r = client.get("/stac/search", params={"intersects": json.dumps(geometry)})
    assert r.status_code == 200
    assert r.json()["numberMatched"] > 0


def test_search_post_json_body(client: TestClient, store: CatalogStore) -> None:
    member_ids = _member_ids(store)
    r = client.post(
        "/stac/search",
        json={
            "ids": member_ids,
            "filter": {"op": "=", "args": [{"property": "collection"}, "src-1"]},
            "filter-lang": "cql2-json",
            "limit": 50,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert body["numberMatched"] == 4
    assert {f["id"] for f in body["features"]} == set(member_ids)


def test_search_items_collection_field_and_links_dereference(
    client: TestClient, store: CatalogStore
) -> None:
    """C1 regression: cross-collection ``/search`` results must carry the
    row's REAL collection (never a fabricated "datasets"), and every
    self/parent/collection link on every returned item must dereference to
    200 -- not 404 against a collection that doesn't exist."""
    member_ids = _member_ids(store)
    standalone_id = "radverkehrsnetz-dresden-0"
    r = client.get(
        "/stac/search", params={"ids": ",".join([*member_ids, standalone_id])}
    )
    assert r.status_code == 200
    by_id = {f["id"]: f for f in r.json()["features"]}

    standalone = by_id[standalone_id]
    assert "collection" not in standalone
    rels = {lk["rel"]: lk for lk in standalone["links"]}
    assert "parent" not in rels
    assert "collection" not in rels
    assert client.get(rels["self"]["href"]).status_code == 200

    bundle_member = by_id[member_ids[0]]
    assert bundle_member["collection"] == "src-1"
    member_rels = {lk["rel"]: lk for lk in bundle_member["links"]}
    for rel in ("self", "parent", "collection"):
        assert client.get(member_rels[rel]["href"]).status_code == 200


def test_search_collections_filter_all_report_matching_collection(
    client: TestClient,
) -> None:
    r = client.get("/stac/search", params={"collections": "src-1", "limit": 10})
    assert r.status_code == 200
    features = r.json()["features"]
    assert features
    assert all(f["collection"] == "src-1" for f in features)


def test_search_bbox_plus_intersects_400(client: TestClient) -> None:
    r = client.get(
        "/stac/search",
        params={
            "bbox": "5,47,16,56",
            "intersects": json.dumps({"type": "Point", "coordinates": [8, 50]}),
        },
    )
    assert r.status_code == 400
    assert r.json()["code"] == 400


def test_search_bad_datetime_400(client: TestClient) -> None:
    r = client.get("/stac/search", params={"datetime": "not-a-date"})
    assert r.status_code == 400
    assert r.json()["code"] == 400


def test_sortby_get_syntax(client: TestClient, store: CatalogStore) -> None:
    # `properties.updated` is sparse on the stored document by design (real
    # harvester items omit it on roughly half of rows -- see
    # tests/fixtures/gen_catalog.py), so sort order is checked against the
    # underlying `updated` column (always populated) rather than the
    # embedded JSON field, which may be absent on some returned features.
    r = client.get("/stac/search", params={"sortby": "-properties.updated", "limit": 5})
    assert r.status_code == 200
    ids = [f["id"] for f in r.json()["features"]]
    assert len(ids) > 1
    placeholders = ", ".join("?" for _ in ids)
    rows = store.query(
        f"SELECT id, updated FROM {store.ITEMS} WHERE id IN ({placeholders})", ids
    )
    updated_by_id = dict(rows)
    updated_values = [updated_by_id[i] for i in ids]
    assert updated_values == sorted(updated_values, reverse=True)


def test_search_get_pagination_links_preserve_query_params(client: TestClient) -> None:
    r = client.get(
        "/stac/search",
        params={"q": "Radverkehrsnetz", "bbox": "5,47,16,56", "limit": 2, "offset": 0},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["numberMatched"] > 2  # enough matches to have a next page

    links = {link["rel"]: link for link in body["links"]}
    assert "next" in links
    next_qs = parse_qs(urlparse(links["next"]["href"]).query)
    assert next_qs["q"] == ["Radverkehrsnetz"]
    assert next_qs["bbox"] == ["5,47,16,56"]
    assert next_qs["offset"] == ["2"]
    assert next_qs["limit"] == ["2"]

    first_qs = parse_qs(urlparse(links["first"]["href"]).query)
    assert first_qs["q"] == ["Radverkehrsnetz"]
    assert first_qs["offset"] == ["0"]

    # self round-trips: fetching it returns the same numberMatched.
    r2 = client.get(links["self"]["href"])
    assert r2.status_code == 200
    assert r2.json()["numberMatched"] == body["numberMatched"]


def test_search_post_pagination_link_has_method_and_body(client: TestClient) -> None:
    r = client.post(
        "/stac/search", json={"q": "Radverkehrsnetz", "limit": 2, "offset": 0}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["numberMatched"] > 2

    next_links = [link for link in body["links"] if link["rel"] == "next"]
    assert len(next_links) == 1
    next_link = next_links[0]
    assert next_link["method"] == "POST"
    assert next_link["merge"] is False
    assert next_link["body"]["offset"] == 2
    assert next_link["body"]["q"] == "Radverkehrsnetz"
    assert next_link["body"]["limit"] == 2


def test_search_get_intersects_missing_coordinates_400(client: TestClient) -> None:
    r = client.get("/stac/search", params={"intersects": json.dumps({"type": "Point"})})
    assert r.status_code == 400


def test_search_post_intersects_missing_coordinates_400(client: TestClient) -> None:
    r = client.post("/stac/search", json={"intersects": {"type": "Point"}})
    assert r.status_code == 400


def test_search_post_bbox_as_csv_string_400(client: TestClient) -> None:
    """A POST body must spell `bbox` as an array, not the GET way.

    One params model serves both verbs, so its CSV parser is reachable from a
    JSON body — and this used to succeed, against Item Search's POST schema
    (`bbox` is an array of numbers there) and against what stac-api-validator
    asserts. The GET spelling and a JSON array both still work.
    """
    assert client.post("/stac/search", json={"bbox": "10,50,11,51"}).status_code == 400
    assert (
        client.post("/stac/search", json={"bbox_boost": "10,50,11,51"}).status_code
        == 400
    )
    assert (
        client.post("/stac/search", json={"bbox": [10, 50, 11, 51]}).status_code == 200
    )
    assert client.get("/stac/search", params={"bbox": "10,50,11,51"}).status_code == 200
    # An empty POST is a valid search for everything, and must not trip the check.
    assert client.post("/stac/search").status_code == 200


def test_search_intersects_semantically_invalid_geometry_400(
    client: TestClient,
) -> None:
    # Valid JSON, has 'type'+'coordinates', but DuckDB's ST_GeomFromGeoJSON
    # itself rejects it -- the safe_query backstop, not the shallow check.
    r = client.post(
        "/stac/search",
        json={"intersects": {"type": "Polygon", "coordinates": "not-an-array"}},
    )
    assert r.status_code == 400


# --------------------------------------------------------------------------
# Aggregation extension
# --------------------------------------------------------------------------


def test_aggregations_discovery(client: TestClient, store: CatalogStore) -> None:
    r = client.get("/stac/aggregations")
    assert r.status_code == 200
    names = {a["name"] for a in r.json()["aggregations"]}
    assert names == set(aggregation_names(store))


def test_aggregate_shape(client: TestClient) -> None:
    r = client.get("/stac/aggregate")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "AggregationCollection"
    by_name = {a["name"]: a for a in body["aggregations"]}
    assert by_name["total_count"]["data_type"] == "integer"
    assert "value" in by_name["total_count"]


# --------------------------------------------------------------------------
# GOAT extensions: resolve / items
# --------------------------------------------------------------------------


def test_item_links(client: TestClient) -> None:
    # radverkehrsnetz-dresden-0 (row 0) is a genuine standalone item -- no
    # collection column, so no "parent"/"collection" rels (see C1: no
    # synthetic "datasets" collection is ever invented).
    r = client.get("/stac/items/radverkehrsnetz-dresden-0")
    assert r.status_code == 200
    body = r.json()
    assert "collection" not in body
    rels = {link["rel"] for link in body["links"]}
    assert {"root", "self"} <= rels
    assert "parent" not in rels
    assert "collection" not in rels


def test_item_links_for_bundle_member_has_collection(
    client: TestClient, store: CatalogStore
) -> None:
    member_id = [
        row[0]
        for row in store.query(
            f"SELECT id FROM {store.ITEMS} WHERE collection = 'src-1'"
        )
    ][0]
    r = client.get(f"/stac/items/{member_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["collection"] == "src-1"
    rels = {link["rel"] for link in body["links"]}
    assert {"root", "self", "parent", "collection"} <= rels


def test_every_item_route_carries_the_open_in_goat_link(
    client: TestClient, store: CatalogStore
) -> None:
    """The `alternate` link is the public page's only call to action.

    Design S14: an anonymous reader gets metadata and no data, so the way
    out of a served Item is the deep link into GOAT. It is appended by
    `record_to_item` only when the route passes a UI base URL, which made it
    something each handler had to remember -- and the collection-agnostic
    `/stac/items/{id}` route did not, so deep-linked items silently lost it.
    Asserted across every route that serves an Item rather than on one.
    """
    member_id = store.query(
        f"SELECT id FROM {store.ITEMS} WHERE collection = 'src-1' LIMIT 1"
    )[0][0]
    routes = [
        f"/stac/items/{member_id}",
        f"/stac/collections/src-1/items/{member_id}",
    ]
    for route in routes:
        body = client.get(route).json()
        alternate = [lk for lk in body["links"] if lk["rel"] == "alternate"]
        assert alternate, f"{route} served an item with no 'alternate' link"

    for route in ("/stac/search", "/stac/collections/src-1/items"):
        feature = client.get(route, params={"limit": 1}).json()["features"][0]
        assert [lk for lk in feature["links"] if lk["rel"] == "alternate"], route


def test_item_not_found_404(client: TestClient) -> None:
    r = client.get("/stac/items/does-not-exist")
    assert r.status_code == 404


def test_resolve_item_and_collection(client: TestClient) -> None:
    r_item = client.get("/stac/resolve/radverkehrsnetz-dresden-0")
    assert r_item.status_code == 200
    item_body = r_item.json()
    assert item_body["kind"] == "item"
    assert item_body["item"]["id"] == "radverkehrsnetz-dresden-0"

    r_coll = client.get("/stac/resolve/src-1")
    assert r_coll.status_code == 200
    coll_body = r_coll.json()
    assert coll_body["kind"] == "collection"
    assert coll_body["collection"]["id"] == "src-1"
    assert len(coll_body["items"]) == 4


def test_resolve_not_found_404(client: TestClient) -> None:
    r = client.get("/stac/resolve/does-not-exist")
    assert r.status_code == 404


# --------------------------------------------------------------------------
# Middleware stack (I2): CORS, gzip, observability boot
# --------------------------------------------------------------------------


def test_cors_preflight_from_the_goat_ui_origin(client: TestClient) -> None:
    """The browser callers we serve are the GOAT catalog page's.

    ``cors_origins`` defaults to ``[goat_ui_base_url]`` (conftest leaves that
    at its own default), not ``["*"]``.
    """
    r = client.options(
        "/stac",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_cors_preflight_from_a_foreign_origin_is_not_allowed(
    client: TestClient,
) -> None:
    """A wildcard would let any site use this API as its own backend.

    CORS constrains browsers only, so this costs nothing for QGIS/pystac-client
    and other non-browser STAC tooling.
    """
    r = client.options(
        "/stac",
        headers={
            "Origin": "https://somebody-elses-site.test",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}


def test_several_cors_origins_are_each_allowed(catalog_dir: Path) -> None:
    """More than one origin is the normal local-dev case.

    The web dev server moves to 3001+ whenever another worktree holds 3000, so
    `CATALOG_CORS_ORIGINS` takes a list and every entry in it is served.
    """
    app = create_app(
        CatalogSettings(
            data_dir=catalog_dir,
            cors_origins=["http://localhost:3000", "http://localhost:3001"],
        )
    )
    with TestClient(app) as c:
        for origin in ("http://localhost:3000", "http://localhost:3001"):
            r = c.options(
                "/stac",
                headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
            )
            assert r.status_code == 200, origin
            assert r.headers["access-control-allow-origin"] == origin


def test_explicit_cors_origins_override_the_derived_default(
    catalog_dir: Path,
) -> None:
    settings = CatalogSettings(
        data_dir=catalog_dir,
        goat_ui_base_url="https://ui.example",
        cors_origins=["https://embed.example"],
    )
    assert settings.cors_origins == ["https://embed.example"]

    derived = CatalogSettings(
        data_dir=catalog_dir, goat_ui_base_url="https://ui.example/"
    )
    assert derived.cors_origins == ["https://ui.example"]


def test_large_search_response_is_gzipped(client: TestClient) -> None:
    r = client.get(
        "/stac/search",
        params={"limit": 100},
        headers={"Accept-Encoding": "gzip"},
    )
    assert r.status_code == 200
    assert r.headers.get("content-encoding") == "gzip"
    assert r.json()["numberReturned"] > 0


def test_app_boots_with_observability_unconfigured(
    catalog_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``setup_observability`` is a no-op unless ``OTEL_ENABLED=true`` --
    the app must boot cleanly with it never configured at all (the default
    in every other test in this file too, implicitly)."""
    monkeypatch.delenv("OTEL_ENABLED", raising=False)
    app = create_app(CatalogSettings(data_dir=catalog_dir, auth=False))
    with TestClient(app) as c:
        r = c.get("/stac")
    assert r.status_code == 200


# --------------------------------------------------------------------------
# ETag / caching + reload-on-version-change
# --------------------------------------------------------------------------


def test_etag_304(client: TestClient) -> None:
    r1 = client.get("/stac")
    assert r1.status_code == 200
    etag = r1.headers["etag"]
    assert etag
    assert r1.headers["cache-control"] == "public, max-age=60"

    r2 = client.get("/stac", headers={"If-None-Match": etag})
    assert r2.status_code == 304
    assert r2.content == b""
    assert r2.headers["etag"] == etag


def test_error_response_has_no_etag_or_cache_control(client: TestClient) -> None:
    r = client.get("/stac/collections/does-not-exist")
    assert r.status_code == 404
    assert "etag" not in r.headers
    assert "cache-control" not in r.headers


def test_etag_reflects_handler_observed_version_not_post_handler_reload(
    catalog_dir: Path,
) -> None:
    """I1 regression: the ETag middleware must stamp whatever state the
    handler actually built its body against (stashed by ``catalog.deps
    .get_store`` onto ``request.state.catalog_etag_seed``), never the store's
    live seed re-read after the handler already returned. A reload landing in
    that gap must not desync the stamped ETag from the body a client actually
    received.
    """
    app = create_app(CatalogSettings(data_dir=catalog_dir, auth=False))

    observed: list[str] = []

    def racy_get_store(request: Request) -> CatalogStore:
        store: CatalogStore = request.app.state.store
        store.ensure_current()
        request.state.catalog_etag_seed = store.etag_seed
        observed.append(store.etag_seed)
        # Simulate a concurrent reload finishing in the gap between the
        # handler observing this state and the ETag middleware running.
        store._etag_seed = "reloaded-mid-request"
        return store

    app.dependency_overrides[get_store] = racy_get_store

    with TestClient(app) as client:
        r = client.get("/stac")

    assert r.status_code == 200
    assert r.headers["etag"] == f'W/"{observed[0]}"'
    assert "reloaded-mid-request" not in r.headers["etag"]


def test_etag_changes_when_content_changes_under_the_same_version(
    catalog_dir: Path,
) -> None:
    """The ETag must track the bytes served, not the upstream VERSION marker.

    The mirror is *derived* from the harvester's published file
    (``goatlib.tasks.catalog_mirror``), so the same upstream version can yield
    different served bytes whenever the converter changes -- and it did. Seeding
    the tag from VERSION meant a client holding a stale body revalidated into a
    304 forever, since the tag it presented still matched.
    """
    app = create_app(CatalogSettings(data_dir=catalog_dir, auth=False))
    with TestClient(app) as client:
        first = client.get("/stac/collections", params={"limit": 1})
        etag_before = first.headers["etag"]
        # Same VERSION content, different catalog bytes.
        version_text = (catalog_dir / "VERSION").read_text()
        write_catalog(catalog_dir, n=250)
        (catalog_dir / "VERSION").write_text(version_text)

        second = client.get("/stac/collections", params={"limit": 1})
        etag_after = second.headers["etag"]

        assert second.status_code == 200
        assert (
            etag_after != etag_before
        ), "content changed under an unchanged VERSION, so the ETag must move"
        # And the stale tag must no longer satisfy a conditional GET.
        stale = client.get(
            "/stac/collections",
            params={"limit": 1},
            headers={"If-None-Match": etag_before},
        )
        assert stale.status_code == 200


def test_reload_on_version_change(client: TestClient, catalog_dir: Path) -> None:
    r1 = client.get("/stac/search", params={"limit": 1})
    etag1 = r1.headers["etag"]
    n1 = r1.json()["numberMatched"]

    write_catalog(catalog_dir, n=250, version="v-test-2")

    r2 = client.get("/stac/search", params={"limit": 1})
    etag2 = r2.headers["etag"]
    n2 = r2.json()["numberMatched"]

    assert etag2 != etag1
    assert n2 != n1


# --------------------------------------------------------------------------
# Auth (api spec §1)
# --------------------------------------------------------------------------


def test_reads_are_public_even_with_auth_enabled(
    catalog_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The read paths must serve anonymous callers (design S1/S14).

    The GOAT catalog page is a public route embedded off-site, so its visitors
    carry no token; if these 401'd, the public catalog could not work at all.
    """
    monkeypatch.setattr(
        "catalog.auth.validate_token",
        lambda settings, token: {"sub": "test-user"},
    )
    app = create_app(CatalogSettings(data_dir=catalog_dir, auth=True))
    with TestClient(app) as authed_client:
        for path in (
            "/stac",
            "/stac/conformance",
            "/stac/collections",
            "/stac/search",
            "/stac/aggregate",
            "/stac/queryables",
            "/stac/nuts",
        ):
            assert authed_client.get(path).status_code == 200, path

        # A valid token is still accepted (and will later unlock more).
        r = authed_client.get("/stac", headers={"Authorization": "Bearer sometoken"})
        assert r.status_code == 200


def test_openapi_advertises_no_security_on_public_reads(client: TestClient) -> None:
    """The docs must not claim credentials are needed.

    Depending on ``oauth2_scheme`` would register an OpenAPI security
    requirement and make Swagger draw a padlock on every public read endpoint
    -- telling readers of a public API that they need a token they do not.
    """
    schema = client.get("/api/openapi.json").json()
    assert not schema.get("components", {}).get("securitySchemes")
    advertising = [
        path
        for path, ops in schema["paths"].items()
        for op in ops.values()
        if isinstance(op, dict) and op.get("security")
    ]
    assert advertising == []


def test_invalid_token_is_rejected_not_downgraded_to_anonymous(
    catalog_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Presenting a *bad* token is an error, not a silent fall-back.

    Treating an expired/garbage token as "anonymous" would hide credential
    failures from clients and make a broken integration look like it works.
    """

    def _reject(settings: object, token: str) -> dict[str, str]:
        raise JOSEError("expired")

    monkeypatch.setattr("catalog.auth.validate_token", _reject)
    app = create_app(CatalogSettings(data_dir=catalog_dir, auth=True))
    with TestClient(app) as authed_client:
        r = authed_client.get("/stac", headers={"Authorization": "Bearer bad"})
        assert r.status_code == 401
        assert r.json()["code"] == 401
        assert r.headers["www-authenticate"] == "Bearer"


def test_auth_open_access_when_disabled(client: TestClient) -> None:
    # `client` (conftest) is built with auth=False -- no token needed at all.
    r = client.get("/stac")
    assert r.status_code == 200


def test_conditional_get_with_bad_token_401s_rather_than_304(
    catalog_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Dependency order still matters after opening the reads.

    An *anonymous* 304 is correct now (these are public reads), but a caller
    presenting broken credentials must get the 401 from the auth dependency
    rather than a cache-hit 304 that hides the credential failure.
    """
    tokens = {"good": {"sub": "test-user"}}

    def _validate(settings: object, token: str) -> dict[str, str]:
        if token not in tokens:
            raise JOSEError("expired")
        return tokens[token]

    monkeypatch.setattr("catalog.auth.validate_token", _validate)
    app = create_app(CatalogSettings(data_dir=catalog_dir, auth=True))
    with TestClient(app) as authed_client:
        etag = authed_client.get("/stac").headers["etag"]

        # Anonymous conditional GET: 304 is the intended public behaviour.
        anon = authed_client.get("/stac", headers={"If-None-Match": etag})
        assert anon.status_code == 304

        # Same conditional GET, but with a bad token -> 401, never 304.
        bad = authed_client.get(
            "/stac",
            headers={"If-None-Match": etag, "Authorization": "Bearer bad"},
        )
        assert bad.status_code == 401


def test_api_favicon_is_served_from_the_package(client: TestClient) -> None:
    """The favicon must ship *inside* the installed package.

    The image runs `uvicorn catalog.main:app` against the installed wheel, so
    a path relative to the source tree would not exist at runtime; this test
    fails if the PNG stops being packaged with the module.
    """
    resp = client.get("/static/api_favicon.png")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert resp.content[:8] == b"\x89PNG\r\n\x1a\n"


@pytest.mark.parametrize("path", ["/api/docs", "/api/redoc"])
def test_docs_pages_reference_the_favicon(client: TestClient, path: str) -> None:
    resp = client.get(path)
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    assert "/static/api_favicon.png" in resp.text


def test_keycloak_settings_read_repo_wide_env_vars(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KEYCLOAK_SERVER_URL", "https://kc.example.test")
    monkeypatch.setenv("REALM_NAME", "example-realm")
    settings = CatalogSettings()
    assert settings.keycloak_server_url == "https://kc.example.test"
    assert settings.realm_name == "example-realm"


def test_keycloak_settings_catalog_prefixed_override_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KEYCLOAK_SERVER_URL", "https://kc.example.test")
    monkeypatch.setenv(
        "CATALOG_KEYCLOAK_SERVER_URL", "https://catalog-only.example.test"
    )
    settings = CatalogSettings()
    assert settings.keycloak_server_url == "https://catalog-only.example.test"


class TestLimitHandling:
    """``limit`` is clamped, not rejected, above the endpoint maximum.

    STAC API: "if the value is greater than the maximum, the server must
    return the maximum" -- a 422 there fails conformance, so the ceilings are
    applied in the handler rather than as a pydantic ``le=`` constraint.
    """

    @pytest.mark.parametrize(
        ("path", "maximum"),
        [
            ("/stac/collections", 1000),
            ("/stac/search", 100),
        ],
    )
    def test_over_maximum_is_clamped_not_rejected(
        self, client: TestClient, path: str, maximum: int
    ) -> None:
        resp = client.get(path, params={"limit": 99999})
        assert resp.status_code == 200
        # The server-built paging links carry the limit actually applied, which
        # is where the clamp is observable. (`self` deliberately echoes the
        # caller's own URL, which replays to this same clamped response.)
        paging = [
            link
            for link in resp.json()["links"]
            if link.get("rel") in ("first", "next", "prev")
        ]
        assert paging, "expected server-built paging links"
        assert all(f"limit={maximum}" in link["href"] for link in paging)

    def test_post_search_over_maximum_is_clamped(self, client: TestClient) -> None:
        resp = client.post("/stac/search", json={"limit": 99999})
        assert resp.status_code == 200
        assert len(resp.json()["features"]) <= 100

    @pytest.mark.parametrize("bad", [0, -1])
    def test_below_one_is_400_with_the_shared_envelope(
        self, client: TestClient, bad: int
    ) -> None:
        """OGC API - Features answers an invalid parameter value with 400."""
        resp = client.get("/stac/search", params={"limit": bad})
        assert resp.status_code == 400
        assert resp.json()["code"] == 400

    def test_other_invalid_params_are_400_not_422(self, client: TestClient) -> None:
        """Pydantic-rejected params use the same status and envelope.

        FastAPI would answer 422 with its own ``{"detail": [...]}`` body,
        giving one API two unrelated error shapes.
        """
        resp = client.get("/stac/search", params={"offset": -5})
        assert resp.status_code == 400
        body = resp.json()
        assert body["code"] == 400
        assert "offset" in body["description"]


class TestIntersectsGeometryTypes:
    """Item Search must accept every GeoJSON geometry type."""

    def test_geometry_collection_is_accepted(self, client: TestClient) -> None:
        """A GeometryCollection carries ``geometries``, not ``coordinates`` --
        requiring ``coordinates`` unconditionally rejected valid input."""
        gc = {
            "type": "GeometryCollection",
            "geometries": [
                {"type": "Point", "coordinates": [11.5, 48.1]},
                {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [11.0, 48.0],
                            [12.0, 48.0],
                            [12.0, 49.0],
                            [11.0, 49.0],
                            [11.0, 48.0],
                        ]
                    ],
                },
            ],
        }
        get_resp = client.get("/stac/search", params={"intersects": json.dumps(gc)})
        assert get_resp.status_code == 200, get_resp.text
        post_resp = client.post("/stac/search", json={"intersects": gc})
        assert post_resp.status_code == 200, post_resp.text

    def test_geometry_collection_without_geometries_is_400(
        self, client: TestClient
    ) -> None:
        resp = client.post(
            "/stac/search", json={"intersects": {"type": "GeometryCollection"}}
        )
        assert resp.status_code == 400

    def test_geometry_without_coordinates_is_400(self, client: TestClient) -> None:
        resp = client.post("/stac/search", json={"intersects": {"type": "Polygon"}})
        assert resp.status_code == 400


def test_landing_page_has_no_service_doc_link(client: TestClient) -> None:
    """The API's consumer is the GOAT UI, not a person reading reference docs,
    so the landing page links the OpenAPI document and nothing human-facing."""
    links = client.get("/stac").json()["links"]
    rels = {link["rel"] for link in links}
    assert "service-desc" in rels
    assert "service-doc" not in rels
