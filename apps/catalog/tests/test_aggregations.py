"""Tests for the STAC Aggregation extension (v0.3.0) facet-count layer.

Aggregations must apply the exact same predicates as Item Search (via
``build_filters``), including the blanket exclusion of collection-type rows
-- verified here rather than re-derived, since ``build_filters`` already
owns that rule (see ``catalog.services.search``).
"""

from pathlib import Path

import duckdb
import pytest
from fastapi.testclient import TestClient

from catalog.app import create_app
from catalog.config import CatalogSettings
from catalog.errors import ApiError
from catalog.services.aggregations import (
    aggregation_names,
    available_aggregations,
    facet_aggregations,
    run_aggregations,
)
from catalog.services.search import SearchParams, build_filters
from catalog.store import CatalogStore


def test_available_aggregations_shape(store: CatalogStore) -> None:
    doc = available_aggregations(store)
    names = {a["name"] for a in doc["aggregations"]}
    assert names == set(aggregation_names(store))

    by_name = {a["name"]: a for a in doc["aggregations"]}
    assert by_name["total_count"]["data_type"] == "integer"
    for facet_name in facet_aggregations(store):
        entry = by_name[facet_name]
        assert entry["data_type"] == "frequency_distribution"
        assert entry["frequency_distribution_data_type"] == "string"


def test_default_run_returns_total_and_all_facets(store: CatalogStore) -> None:
    result = run_aggregations(store, SearchParams(), None)
    assert result["type"] == "AggregationCollection"
    names = {a["name"] for a in result["aggregations"]}
    assert names == set(aggregation_names(store))


def test_total_count_matches_non_collection_row_count(store: CatalogStore) -> None:
    expected = store.query(f"SELECT count(*) FROM {store.ITEMS} ")[0][0]

    result = run_aggregations(store, SearchParams(), None)
    by_name = {a["name"]: a for a in result["aggregations"]}
    assert by_name["total_count"]["value"] == expected


def test_license_bucket_frequencies_sum_to_total(store: CatalogStore) -> None:
    result = run_aggregations(store, SearchParams(), None)
    by_name = {a["name"]: a for a in result["aggregations"]}

    total = by_name["total_count"]["value"]
    license_sum = sum(b["frequency"] for b in by_name["license_count"]["buckets"])
    assert total > 0
    assert license_sum == total


def test_category_predicate_narrows_buckets(store: CatalogStore) -> None:
    # `?themes=` filters the underlying `category` column: the registry seeds
    # that parameter name for it, while the aggregation stays `category_count`.
    result = run_aggregations(
        store,
        SearchParams(fields={"themes": "transportation"}),
        ["category_count", "total_count"],
    )
    by_name = {a["name"]: a for a in result["aggregations"]}

    buckets = by_name["category_count"]["buckets"]
    assert buckets  # the fixture has transportation rows (row 0, the bundle)
    assert all(b["key"] == "transportation" for b in buckets)

    # And the facet count is internally consistent with total_count under
    # the same predicate.
    assert sum(b["frequency"] for b in buckets) == by_name["total_count"]["value"]


def test_names_filter_returns_only_requested(store: CatalogStore) -> None:
    result = run_aggregations(store, SearchParams(), ["total_count"])
    assert [a["name"] for a in result["aggregations"]] == ["total_count"]


def test_unknown_aggregation_name_is_400(store: CatalogStore) -> None:
    with pytest.raises(ApiError) as exc_info:
        run_aggregations(store, SearchParams(), ["not_a_real_aggregation"])
    assert exc_info.value.status_code == 400


def test_geometry_type_buckets_exclude_nulls(store: CatalogStore) -> None:
    # gen_catalog sets goat:geometryType = NULL for row_type == "table" rows, so the
    # non-collection table rows exist but must not surface as a NULL bucket
    # nor be silently counted into some other key.
    null_geom_rows = store.query(
        f'SELECT count(*) FROM {store.ITEMS} WHERE "goat:geometryType" IS NULL'
    )[0][0]
    assert null_geom_rows > 0  # sanity: the fixture actually has table rows

    result = run_aggregations(
        store, SearchParams(), ["geometry_type_count", "total_count"]
    )
    by_name = {a["name"]: a for a in result["aggregations"]}

    buckets = by_name["geometry_type_count"]["buckets"]
    assert all(b["key"] is not None for b in buckets)

    bucket_sum = sum(b["frequency"] for b in buckets)
    total = by_name["total_count"]["value"]
    assert bucket_sum == total - null_geom_rows
    assert bucket_sum < total


def test_bucket_ordering_by_frequency_desc_then_key_asc(store: CatalogStore) -> None:
    expected_rows = store.query(
        f"SELECT license AS key, count(*) AS frequency FROM {store.ITEMS} "
        f"WHERE license IS NOT NULL "
        f"GROUP BY license ORDER BY frequency DESC, key ASC"
    )
    expected = [(row[0], row[1]) for row in expected_rows]

    result = run_aggregations(store, SearchParams(), ["license_count"])
    buckets = result["aggregations"][0]["buckets"]
    actual = [(b["key"], b["frequency"]) for b in buckets]

    assert actual == expected


def test_discovery_publishes_the_parameter_that_narrows_each_facet(
    client: TestClient,
) -> None:
    """A client must be able to build a filter sidebar from discovery alone.

    Stripping `_count` off the aggregation name is not enough and fails
    silently: `category_count` is narrowed with `?themes=`, not `?category=`.
    Without this field every consumer hardcodes that mapping and drifts from
    the server the first time a facet is added or renamed.
    """
    aggregations = client.get("/stac/aggregations").json()["aggregations"]
    by_name = {a["name"]: a for a in aggregations}

    assert (
        "goat:filter_param" not in by_name["total_count"]
    ), "total_count is not a facet and nothing narrows it"
    for name, aggregation in by_name.items():
        if name == "total_count":
            continue
        param = aggregation.get("goat:filter_param")
        assert param, f"{name} does not say how to filter by it"
        # The parameter must actually be accepted by Item Search.
        response = client.get("/stac/search", params={param: "x", "limit": 1})
        assert response.status_code == 200, f"?{param}= is not a search parameter"


def test_executed_aggregations_carry_the_filter_param_too(client: TestClient) -> None:
    """The sidebar reads buckets and links from the same response."""
    aggregations = client.get(
        "/stac/aggregate", params={"aggregations": "type_count"}
    ).json()["aggregations"]
    assert aggregations[0]["goat:filter_param"] == "type"


class TestCountingUnit:
    """A facet count and the result set it describes must be in the same unit.

    The live catalog holds 10,793 layers in 3,834 datasets. Counting layers under
    a page that lists datasets reported "8,166 bundles" where selecting that
    bucket returned 1,207 -- the sidebar and the results disagreed by 6.8x, which
    is what made the numbers look broken.

    The fixture's bundle is the interesting case: four layers, two ``point`` and
    two ``line``, and the representative is a ``point``.
    """

    def test_layer_counts_are_the_default(self, store: CatalogStore) -> None:
        """`unit` defaults to items, so existing Item Search clients are unmoved."""
        buckets = {
            b["key"]: b["frequency"]
            for b in run_aggregations(store, SearchParams(), ["geometry_type_count"])[
                "aggregations"
            ][0]["buckets"]
        }
        assert buckets["line"] >= 2, "counts layers, as Item Search always did"

    def test_a_bundles_layers_count_once_as_a_dataset(
        self, store: CatalogStore
    ) -> None:
        """Two line layers in one dataset are one line dataset, not two."""
        result = run_aggregations(
            store,
            SearchParams(collections=["src-1"]),
            ["geometry_type_count"],
            "collections",
        )
        buckets = {
            b["key"]: b["frequency"] for b in result["aggregations"][0]["buckets"]
        }
        # Both values are present because the dataset HAS both -- and each counts
        # the dataset once, which `count(*)` over items could not express.
        assert buckets == {"point": 1, "line": 1}

    def test_dataset_total_counts_collections(self, store: CatalogStore) -> None:
        items = run_aggregations(store, SearchParams(), ["total_count"])[
            "aggregations"
        ][0]["value"]
        datasets = run_aggregations(
            store, SearchParams(), ["total_count"], "collections"
        )["aggregations"][0]["value"]
        assert datasets < items, "the fixture bundles several layers into one dataset"

    def test_item_level_facets_are_still_offered_for_datasets(
        self, store: CatalogStore
    ) -> None:
        """Geometry lives on layers, and is worth counting per dataset anyway."""
        doc = available_aggregations(store, "collections")
        names = {a["name"] for a in doc["aggregations"]}
        assert "geometry_type_count" in names


class TestItemFacetsOnCollectionSearch:
    """A dataset matches when ANY of its layers does.

    Filtering the designated representative instead silently dropped datasets: on
    the live catalog 1,886 datasets contain a polygon layer but a representative
    test returned 1,658, because 569 bundles mix geometry types.
    """

    def test_a_dataset_matches_on_a_non_representative_layer(
        self, client: TestClient
    ) -> None:
        """The fixture bundle's representative is a point; it also has lines."""
        found = client.get("/stac/collections", params={"geometry_type": "line"})
        assert found.status_code == 200
        assert "src-1" in {c["id"] for c in found.json()["collections"]}

    def test_the_same_filter_on_item_search_still_means_layers(
        self, client: TestClient
    ) -> None:
        """Item Search is unchanged: it answers about layers, not datasets."""
        response = client.get("/stac/search", params={"geometry_type": "line"})
        assert response.status_code == 200
        geoms = {
            f["properties"].get("goat:geometryType")
            for f in response.json()["features"]
        }
        assert geoms == {"line"}

    def test_an_unresolvable_parameter_lists_the_promoted_names_too(
        self, store: CatalogStore
    ) -> None:
        """Promotion must widen the error's "available" list, not hide it.

        Exercised through ``build_filters`` rather than the endpoint because an
        *undeclared* query parameter never reaches it -- ``FacetFilters`` declares
        the accepted names statically, so FastAPI drops the rest. What can still
        go wrong is a declared parameter that resolves against neither relation,
        and the 400 has to say what would have worked.
        """
        with pytest.raises(ApiError) as raised:
            build_filters(
                SearchParams(fields={"not_a_facet": "x"}),
                registry=store.collection_registry,
                relation="collections",
                item_registry=store.registry,
            )
        assert raised.value.status_code == 400
        assert "geometry_type" in str(raised.value.detail), (
            "an item-level facet is available on collection search now, "
            "so it belongs in the list of what the caller could have sent"
        )


def test_every_dataset_aggregation_carries_a_filter_param(store: CatalogStore) -> None:
    """Counting datasets offers the collection registry's facets too; each must
    still resolve to the parameter that narrows it, or the lookup was a
    KeyError -> 500 the first time the two registries disagreed."""
    from catalog.services.aggregations import run_aggregations
    from catalog.services.search import SearchParams

    body = run_aggregations(store, SearchParams(limit=1), None, "collections")
    facets = [
        a
        for a in body["aggregations"]
        if a.get("data_type") == "frequency_distribution"
    ]
    assert facets, "no facet aggregations were produced"
    missing = [a["name"] for a in facets if not a.get("goat:filter_param")]
    assert not missing, missing


class TestSingleScan:
    """Every facet is counted in one pass, and counts the same thing it used to.

    The per-facet loop ran one full filtered scan per facet plus one for the
    total -- eight scans of the mirror for the default sidebar. These pin the
    behaviour that replaced it: identical numbers, one query.
    """

    @staticmethod
    def _count_queries(
        store: CatalogStore, monkeypatch: pytest.MonkeyPatch
    ) -> list[str]:
        seen: list[str] = []
        original = store.query

        def recording(sql, params=None, con=None):  # type: ignore[no-untyped-def]
            seen.append(sql)
            return original(sql, params, con=con)

        monkeypatch.setattr(store, "query", recording)
        return seen

    def test_all_facets_and_the_total_take_one_query(
        self, store: CatalogStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen = self._count_queries(store, monkeypatch)

        run_aggregations(store, SearchParams(), None)

        assert len(seen) == 1, seen

    def test_every_facet_matches_its_own_group_by(self, store: CatalogStore) -> None:
        """Parity with the per-facet query each bucket list replaced."""
        result = run_aggregations(store, SearchParams(), None)
        by_name = {a["name"]: a for a in result["aggregations"]}

        for name, column in facet_aggregations(store).items():
            expected = [
                (row[0], row[1])
                for row in store.query(
                    f"SELECT {column} AS key, count(*) AS frequency "
                    f"FROM {store.ITEMS} WHERE {column} IS NOT NULL "
                    f"GROUP BY {column} ORDER BY frequency DESC, key ASC"
                )
            ]
            actual = [(b["key"], b["frequency"]) for b in by_name[name]["buckets"]]
            assert actual == expected, name

    def test_the_total_is_the_empty_grouping_set(self, store: CatalogStore) -> None:
        """Asking for the total alongside facets must not change it."""
        alone = run_aggregations(store, SearchParams(), ["total_count"])
        together = run_aggregations(store, SearchParams(), None)

        assert alone["aggregations"][0]["value"] == next(
            a["value"] for a in together["aggregations"] if a["name"] == "total_count"
        )

    def test_a_narrowed_search_narrows_every_bucket(self, store: CatalogStore) -> None:
        """One WHERE clause feeds every grouping set, as the loop's did."""
        params = SearchParams(q="a")
        result = run_aggregations(store, params, None)
        by_name = {a["name"]: a for a in result["aggregations"]}
        total = by_name["total_count"]["value"]

        for name, aggregation in by_name.items():
            if name == "total_count":
                continue
            bucket_sum = sum(b["frequency"] for b in aggregation["buckets"])
            assert bucket_sum <= total, name


def _published_dataset_types(catalog_dir: Path) -> None:
    """Give the fixture's datasets the `goat:layerType` goat-data publishes on
    them: `bundle` for the multi-layer `src-1`, the layer's kind otherwise."""
    target = catalog_dir / "mirror_collections.parquet"
    tmp = catalog_dir / "collections_typed.parquet"
    duckdb.execute(
        f"""COPY (SELECT *, CASE WHEN id = 'src-1' THEN 'bundle' ELSE 'feature'
                  END AS "goat:layerType" FROM read_parquet('{target}'))
            TO '{tmp}' (FORMAT PARQUET)"""
    )
    tmp.replace(target)


def test_the_type_of_a_dataset_is_the_kinds_of_its_layers(catalog_dir: Path) -> None:
    """`bundle` is how a dataset is packed, not what its data is: the type
    filter and its counts read the layers, so a bundle is found by them."""
    _published_dataset_types(catalog_dir)
    store = CatalogStore(CatalogSettings(data_dir=catalog_dir))
    store.ensure_current()
    counts = run_aggregations(
        store, SearchParams(collections=["src-1"]), ["type_count"], "collections"
    )
    buckets = {b["key"]: b["frequency"] for b in counts["aggregations"][0]["buckets"]}
    assert buckets == {"feature": 1}

    with TestClient(create_app(CatalogSettings(data_dir=catalog_dir, auth=False))) as c:

        def ids(kind: str) -> set[str]:
            found = c.get("/stac/collections", params={"type": kind, "limit": 500})
            assert found.status_code == 200, found.text
            return {col["id"] for col in found.json()["collections"]}

        assert "src-1" in ids("feature")
        assert "src-1" not in ids("bundle")

    # A typed bundle (an XPlan plan) is found by its type, not its layers' kinds:
    # the filter reads `goat:dataType`, which the mirror gives its layers.
    items = catalog_dir / "mirror_items.parquet"
    typed = catalog_dir / "items_typed.parquet"
    duckdb.execute(
        f"""COPY (SELECT * REPLACE (CASE WHEN collection = 'src-1' THEN 'xplan'
                  ELSE "goat:dataType" END AS "goat:dataType")
                  FROM read_parquet('{items}')) TO '{typed}' (FORMAT PARQUET)"""
    )
    typed.replace(items)
    with TestClient(create_app(CatalogSettings(data_dir=catalog_dir, auth=False))) as c:
        found = c.get("/stac/collections", params={"type": "xplan", "limit": 500})
        assert {col["id"] for col in found.json()["collections"]} == {"src-1"}
        found = c.get("/stac/collections", params={"type": "feature", "limit": 500})
        assert "src-1" not in {col["id"] for col in found.json()["collections"]}


def _mirror_without_data_type(catalog_dir: Path) -> None:
    """A mirror whose items carry `goat:layerType` but no `goat:dataType`, with
    the layers of `src-1` typed `table` so the two kinds tell rows apart."""
    items = catalog_dir / "mirror_items.parquet"
    tmp = catalog_dir / "items_untyped.parquet"
    duckdb.execute(
        f"""COPY (SELECT * EXCLUDE ("goat:dataType") REPLACE (
                  CASE WHEN collection = 'src-1' THEN 'table'
                  ELSE "goat:layerType" END AS "goat:layerType")
                  FROM read_parquet('{items}')) TO '{tmp}' (FORMAT PARQUET)"""
    )
    tmp.replace(items)


def test_the_type_filter_reads_the_layer_type_without_a_data_type(
    catalog_dir: Path,
) -> None:
    """The service can run ahead of the mirror it reads: without `goat:dataType`
    the Data type filter and its counts read `goat:layerType`."""
    _published_dataset_types(catalog_dir)
    _mirror_without_data_type(catalog_dir)
    total = duckdb.execute(
        f"SELECT count(*) FROM read_parquet('{catalog_dir / 'mirror_items.parquet'}')"
    ).fetchone()[0]
    collections = catalog_dir / "mirror_collections.parquet"
    datasets = duckdb.execute(
        f"SELECT count(*) FROM read_parquet('{collections}')"
    ).fetchone()[0]

    with TestClient(create_app(CatalogSettings(data_dir=catalog_dir, auth=False))) as c:
        tables = c.get("/stac/search", params={"type": "table", "limit": 500})
        assert tables.status_code == 200, tables.text
        assert {f["collection"] for f in tables.json()["features"]} == {"src-1"}
        assert tables.json()["numberMatched"] == 4
        features = c.get("/stac/search", params={"type": "feature", "limit": 1})
        assert features.status_code == 200, features.text
        assert features.json()["numberMatched"] == total - 4

        def ids(kind: str) -> set[str]:
            found = c.get("/stac/collections", params={"type": kind, "limit": 500})
            assert found.status_code == 200, found.text
            return {col["id"] for col in found.json()["collections"]}

        assert ids("table") == {"src-1"}
        assert "src-1" not in ids("feature")
        # The dataset's own `bundle` says how it is packed, not what it holds.
        assert ids("bundle") == set()

        names = {a["name"] for a in c.get("/stac/aggregations").json()["aggregations"]}
        assert "type_count" in names
        counts = c.get("/stac/aggregate", params={"aggregations": "type_count"})
        assert counts.status_code == 200, counts.text
        buckets = {
            b["key"]: b["frequency"]
            for b in counts.json()["aggregations"][0]["buckets"]
        }
        assert buckets == {"feature": total - 4, "table": 4}

        # Counted by datasets: `src-1` once as `table`, never as its `bundle`.
        by_dataset = c.get(
            "/stac/aggregate",
            params={"aggregations": "type_count", "unit": "collections"},
        )
        assert by_dataset.status_code == 200, by_dataset.text
        buckets = {
            b["key"]: b["frequency"]
            for b in by_dataset.json()["aggregations"][0]["buckets"]
        }
        assert buckets == {"feature": datasets - 1, "table": 1}
