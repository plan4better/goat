"""A spatial filter must put the datasets *of* that place first.

Every row a spatial filter returns merely intersects the area, and the
catalog's stored extents are often far larger than the data they describe —
a Baden-Württemberg dataset whose bbox spans 41° x 40°, an unprojected one
1,087,569° wide. Filtering a city in Albania therefore returned 21 German
datasets, all honest `ST_Intersects` matches against dishonest rectangles.

Ranking by containment — how much of the DATASET falls inside the filter —
answers the question the user actually asked. A dataset drawn around one city
scores 1.0 there; a continent-sized one scores about 0.00002. No threshold is
involved: nothing is hidden, it is ordered.
"""

from datetime import datetime, timezone
from pathlib import Path

import pytest

from catalog.config import CatalogSettings
from catalog.services.search import SearchParams, _build_order_by, search_items
from catalog.store import CatalogStore

from .fixtures.gen_catalog import Row, write_catalog, write_nuts

#: A box around one city; small enough that a country-sized row dwarfs it.
CITY = [11.36, 48.06, 11.72, 48.25]


def _row(row_id: str, title: str, ring: list[list[float]], updated: datetime) -> Row:
    wkt = "POLYGON((" + ", ".join(f"{x} {y}" for x, y in ring) + "))"
    return Row(
        id=row_id,
        collection=None,
        type="feature",
        geom_type="polygon",
        title=title,
        description="Ein Datensatz.",
        license="CC-BY-4.0",
        category="transportation",
        language="de",
        publisher="Landesamt 1",
        geometry_wkt=wkt,
        geometry_geojson={
            "type": "Polygon",
            "coordinates": [[[x, y] for x, y in ring]],
        },
        item_datetime=datetime(2026, 1, 2, tzinfo=timezone.utc),
        created=datetime(2026, 1, 2, tzinfo=timezone.utc),
        updated=updated,
        version="v1",
        parquet_url=None,
    )


def _box(w: float, s: float, e: float, n: float) -> list[list[float]]:
    return [[w, s], [e, s], [e, n], [w, n], [w, s]]


# The sprawling row is deliberately the NEWER one: under the default
# `updated DESC` it comes first, so a test that sees the local row first can
# only be seeing spatial ranking — not an ordering that ignores space.
LOCAL = _row(
    "local-1",
    "Wertstoffinseln in der Stadt",
    _box(11.45, 48.10, 11.60, 48.20),
    datetime(2026, 1, 3, tzinfo=timezone.utc),
)
SPRAWLING = _row(
    "sprawling-1",
    "Baustellen im ganzen Land",
    _box(-9.0, 30.0, 32.0, 70.0),
    datetime(2026, 6, 1, tzinfo=timezone.utc),
)


@pytest.fixture()
def store(tmp_path: Path) -> CatalogStore:
    write_catalog(tmp_path, n=20, extra_rows=[LOCAL, SPRAWLING])
    write_nuts(tmp_path)
    s = CatalogStore(CatalogSettings(data_dir=tmp_path))
    s.ensure_current()
    return s


def _ids(store: CatalogStore, **kwargs) -> list[str]:
    rows, _ = search_items(store, SearchParams(limit=50, **kwargs))
    return [row["id"] for row in rows]


def test_the_local_dataset_outranks_the_one_that_merely_covers_the_city(store) -> None:
    ids = _ids(store, bbox=CITY)

    assert "local-1" in ids and "sprawling-1" in ids, "both intersect the city"
    assert ids.index("local-1") < ids.index("sprawling-1")


def test_the_sprawling_dataset_is_still_returned(store) -> None:
    """Ranking, not filtering: a country-wide dataset covering the city is a
    real answer, just a worse one. Nothing is hidden."""
    assert "sprawling-1" in _ids(store, bbox=CITY)


def test_a_polygon_filter_ranks_the_same_way(store) -> None:
    """The picker sends a place as `intersects` (a point becomes a buffered
    ring), so the ranking cannot live in the bbox branch alone."""
    ids = _ids(
        store,
        intersects={
            "type": "Polygon",
            "coordinates": [[[x, y] for x, y in _box(*CITY)]],
        },
    )

    assert ids.index("local-1") < ids.index("sprawling-1")


def test_without_a_spatial_filter_the_order_is_unchanged(store) -> None:
    """`updated DESC` still decides, so the newer sprawling row comes first."""
    ids = _ids(store)

    assert ids.index("sprawling-1") < ids.index("local-1")


def test_an_explicit_sort_wins(store) -> None:
    """A caller that asked for an order gets it — relevance never overrides it."""
    ids = _ids(store, bbox=CITY, sortby=[("updated", "desc")])

    assert ids.index("sprawling-1") < ids.index("local-1")


class TestViewportBoost:
    """`bbox_boost` highlights where the user is working, without filtering.

    Opening the catalog from a project should surface the datasets around the
    current map view first — the user is working in Munich, so Munich data is
    what they mean — while everything else stays reachable by scrolling. That
    is a ranking signal, not a filter: nothing is excluded and no count changes.
    """

    def test_the_local_dataset_is_lifted_to_the_top(self, store) -> None:
        ids = _ids(store, bbox_boost=CITY)

        assert ids.index("local-1") < ids.index("sprawling-1")

    def test_nothing_is_filtered_out(self, store) -> None:
        with_boost, total_boosted = search_items(
            store, SearchParams(limit=50, bbox_boost=CITY)
        )
        without, total_plain = search_items(store, SearchParams(limit=50))

        assert total_boosted == total_plain
        assert {r["id"] for r in with_boost} == {r["id"] for r in without}

    def test_a_point_dataset_far_away_is_not_treated_as_fully_inside(
        self, store, tmp_path: Path
    ) -> None:
        """A zero-extent row divides by zero. Reading that as "fully contained"
        put every point dataset in the country at the top of a city's list."""
        far_point = _row(
            "far-point-1",
            "Ein Messpunkt weit weg",
            _box(2.0, 41.0, 2.0, 41.0),  # zero area, ~1,000 km away
            datetime(2026, 7, 1, tzinfo=timezone.utc),  # newest, so it leads by default
        )
        write_catalog(tmp_path, n=20, extra_rows=[LOCAL, SPRAWLING, far_point])
        write_nuts(tmp_path)
        fresh = CatalogStore(CatalogSettings(data_dir=tmp_path))
        fresh.ensure_current()

        ids = _ids(fresh, bbox_boost=CITY)

        assert ids.index("local-1") < ids.index("far-point-1")

    def test_a_point_dataset_inside_the_view_is_fully_relevant(
        self, store, tmp_path: Path
    ) -> None:
        near_point = _row(
            "near-point-1",
            "Ein Messpunkt in der Stadt",
            _box(11.50, 48.14, 11.50, 48.14),  # zero area, inside the viewport
            datetime(
                2026, 1, 1, tzinfo=timezone.utc
            ),  # oldest, so only rank can lift it
        )
        write_catalog(tmp_path, n=20, extra_rows=[LOCAL, SPRAWLING, near_point])
        write_nuts(tmp_path)
        fresh = CatalogStore(CatalogSettings(data_dir=tmp_path))
        fresh.ensure_current()

        ids = _ids(fresh, bbox_boost=CITY)

        assert ids.index("near-point-1") < ids.index("sprawling-1")


#: A second city far enough away that nothing in it can touch `CITY`.
FAR_CITY = [13.30, 52.45, 13.50, 52.55]
#: A region containing BOTH cities, for the case where view and filter agree.
REGION = [10.0, 47.0, 15.0, 54.0]

# Newer than LOCAL, so under the default `updated DESC` it leads — only the
# viewport can put LOCAL in front of it.
FAR_LOCAL = _row(
    "far-local-1",
    "Trinkbrunnen in der anderen Stadt",
    _box(13.35, 52.47, 13.45, 52.53),
    datetime(2026, 1, 4, tzinfo=timezone.utc),
)


class TestViewportAgainstASpatialFilter:
    """What happens when the map view and the filter disagree.

    A user viewing Munich who filters for Berlin means Berlin. The two areas do
    not overlap at all, so the only rows that can score above zero on the
    viewport are the ones sprawling across both cities — precisely the rows the
    filter ranked last. The viewport therefore ranks BELOW the filter, where it
    can only break its ties.
    """

    @pytest.fixture()
    def store(self, tmp_path: Path) -> CatalogStore:
        write_catalog(tmp_path, n=20, extra_rows=[LOCAL, SPRAWLING, FAR_LOCAL])
        write_nuts(tmp_path)
        s = CatalogStore(CatalogSettings(data_dir=tmp_path))
        s.ensure_current()
        return s

    def test_the_filtered_city_keeps_its_own_data_first(self, store) -> None:
        """The viewport must not promote the sprawling row over the city asked
        for. It overlaps the view; the city's own data cannot."""
        ids = _ids(store, bbox=FAR_CITY, bbox_boost=CITY)

        assert ids.index("far-local-1") < ids.index("sprawling-1")

    def test_a_view_elsewhere_changes_nothing(self, store) -> None:
        """Being disjoint, the viewport has nothing to say about any row the
        filter returned — so the order is the one the filter alone produces."""
        assert _ids(store, bbox=FAR_CITY, bbox_boost=CITY) == _ids(store, bbox=FAR_CITY)

    def test_the_view_still_orders_a_filter_that_contains_it(self, store) -> None:
        """Where the two agree the viewport does the real work: a region filter
        ties both cities at 1.0, and the view decides which comes first."""
        ids = _ids(store, bbox=REGION, bbox_boost=CITY)

        assert ids.index("local-1") < ids.index("far-local-1")

    def test_that_ordering_is_the_viewport_and_not_the_filter(self, store) -> None:
        """The same region filter without a viewport puts the other city first
        (it is newer), so the previous test can only be seeing the viewport."""
        ids = _ids(store, bbox=REGION)

        assert ids.index("far-local-1") < ids.index("local-1")


def test_the_default_order_is_stable_without_an_explicit_sort(store) -> None:
    """Paging must not need a `sortby`, because sending one turns ranking off.

    `updated` is far from unique in the real catalog — 3,834 datasets share 970
    timestamps — so ordering by it alone leaves ties unordered and offset paging
    can return the same row twice. The client used to add `sortby=-updated,id`
    for that, which is exactly what silenced every ranking signal.
    """
    first, _ = search_items(store, SearchParams(limit=10, offset=0))
    second, _ = search_items(store, SearchParams(limit=10, offset=10))

    ids = [r["id"] for r in first] + [r["id"] for r in second]
    assert len(ids) == len(set(ids)), "a row appeared on two pages"


def test_the_collections_default_order_ends_in_a_unique_key(store) -> None:
    """The relevance keys rank, they do not order: four score values and a
    footprint that ties across every NULL or oversized bbox leave thousands of
    rows equal, so `updated DESC, id` still has to close the order behind them
    or offset paging serves one collection on two pages."""
    clause, _ = _build_order_by(
        SearchParams(), None, registry=store.snapshot().collection_registry
    )

    assert "goat:topicRelevanceScore" in clause
    assert clause.endswith("updated DESC, id")
