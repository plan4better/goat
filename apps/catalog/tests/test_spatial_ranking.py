"""A known place must put the datasets *of* that place first.

Every row a spatial filter returns merely intersects the area, and the
catalog's stored extents are often far larger than the data they describe —
a Baden-Württemberg dataset whose bbox spans 41° x 40°, an unprojected one
1,087,569° wide. Filtering a city in Albania therefore returned 21 German
datasets, all honest `ST_Intersects` matches against dishonest rectangles.

The place is the spatial filter, else the map view (`bbox_boost`). Under a map
view the rows whose footprint touches it come first; inside that, the fit:
the share of the place a footprint covers times the share of it inside the
place, kept to its first digit. No threshold hides anything: it is ordered.
"""

import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

from catalog.config import CatalogSettings
from catalog.services.search import (
    SearchParams,
    _build_order_by,
    search_collections,
    search_items,
)
from catalog.store import CatalogStore

from .fixtures.gen_catalog import Row, write_catalog, write_nuts

#: A box around one city; small enough that a country-sized row dwarfs it.
CITY = [11.36, 48.06, 11.72, 48.25]


def _row(
    row_id: str,
    title: str,
    ring: list[list[float]],
    updated: datetime,
    description: str = "Ein Datensatz.",
    footprint: bool = True,
) -> Row:
    wkt = "POLYGON((" + ", ".join(f"{x} {y}" for x, y in ring) + "))"
    return Row(
        id=row_id,
        collection=None,
        type="feature",
        geom_type="polygon",
        title=title,
        description=description,
        license="CC-BY-4.0",
        category="transportation",
        language="de",
        publisher="Landesamt 1",
        geometry_wkt=wkt if footprint else "",
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
    description="Wertstoffinseln an Schulen.",
)
SPRAWLING = _row(
    "sprawling-1",
    "Baustellen im ganzen Land",
    _box(-9.0, 30.0, 32.0, 70.0),
    datetime(2026, 6, 1, tzinfo=timezone.utc),
)
# Newest of all and the word in its title, but in Hamburg.
ELSEWHERE = _row(
    "elsewhere-1",
    "Schulen in der Hansestadt",
    _box(9.7, 53.4, 10.3, 53.7),
    datetime(2026, 8, 1, tzinfo=timezone.utc),
)
REGIONAL = _row(
    "region-1",
    "Baustellen im Land",
    _box(9.0, 47.3, 13.8, 50.6),
    datetime(2026, 1, 5, tzinfo=timezone.utc),
)
# A rectangle around the city but no footprint: it must not count as touching.
NO_FOOTPRINT = _row(
    "nogeom-1",
    "Ohne Geometrie",
    _box(11.0, 47.9, 12.0, 48.5),
    datetime(2026, 9, 1, tzinfo=timezone.utc),
    footprint=False,
)


@pytest.fixture()
def store(tmp_path: Path) -> CatalogStore:
    write_catalog(
        tmp_path,
        n=20,
        extra_rows=[LOCAL, SPRAWLING, ELSEWHERE, REGIONAL, NO_FOOTPRINT],
    )
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


def test_the_map_view_beats_a_title_match(store) -> None:
    ids = _ids(store, q="schulen", bbox_boost=CITY)
    assert ids.index("local-1") < ids.index("elsewhere-1")


def test_covering_rows_beat_rows_elsewhere(store) -> None:
    ids = _ids(store, bbox_boost=CITY)
    # A Land-sized dataset fits the city better than a country-sized one.
    assert ids.index("local-1") < ids.index("region-1") < ids.index("sprawling-1")
    assert ids.index("sprawling-1") < ids.index("elsewhere-1")
    # Its rectangle covers the view, but without a footprint it is elsewhere.
    assert ids.index("sprawling-1") < ids.index("nogeom-1")


def test_a_filter_replaces_the_map_view(store) -> None:
    hamburg = [9.7, 53.4, 10.3, 53.7]
    assert _ids(store, bbox=hamburg, bbox_boost=CITY) == _ids(store, bbox=hamburg)
    assert "nogeom-1" not in _ids(store, bbox=CITY)


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

    def test_points(self, store, tmp_path: Path) -> None:
        """A footprint without area divides by zero. Reading that as "fully
        contained" put every point dataset in the country at the top of a
        city's list; a point inside the view still beats one far away."""
        far_point = _row(
            "far-point-1",
            "Ein Messpunkt weit weg",
            _box(2.0, 41.0, 2.0, 41.0),  # zero area, ~1,000 km away
            datetime(2026, 7, 1, tzinfo=timezone.utc),  # newest, so it leads by default
        )
        near_point = _row(
            "near-point-1",
            "Ein Messpunkt in der Stadt",
            _box(11.50, 48.14, 11.50, 48.14),  # zero area, inside the viewport
            datetime(2026, 1, 1, tzinfo=timezone.utc),  # oldest
        )
        write_catalog(
            tmp_path, n=20, extra_rows=[LOCAL, SPRAWLING, far_point, near_point]
        )
        write_nuts(tmp_path)
        fresh = CatalogStore(CatalogSettings(data_dir=tmp_path))
        fresh.ensure_current()

        ids = _ids(fresh, bbox_boost=CITY)

        assert ids.index("local-1") < ids.index("far-point-1")
        assert ids.index("near-point-1") < ids.index("far-point-1")


def _scaled(box: list[float], factor: float) -> list[list[float]]:
    """``box`` around its centre with ``factor`` times its area."""
    w, s, e, n = box
    cx, cy, k = (w + e) / 2, (s + n) / 2, factor**0.5 / 2
    return _box(cx - (e - w) * k, cy - (n - s) * k, cx + (e - w) * k, cy + (n - s) * k)


def test_the_fit_to_the_place(tmp_path: Path) -> None:
    """The place's own size leads, then a tenth of it (fit 0.1), then ten times
    it (0.01), then a single point inside it (its smallest-place share), whatever
    the score, the date or the size say. A rectangle stretched by a far piece
    counts only the share of its footprint inside, and one stretched by a far
    island is sized by its main piece."""

    def dataset(row_id: str, factor: float, idx: int, month: int) -> Row:
        ring = _scaled(CITY, factor)
        updated = datetime(2026, month, 1, tzinfo=timezone.utc)
        row = _row(row_id, f"Datensatz {row_id}", ring, updated)
        return replace(row, type="collection", idx=idx)

    same = dataset("fit-same", 1, 3, 1)  # lowest score, oldest
    small = dataset("fit-small", 1 / 10, 1, 2)  # score 5
    big = dataset("fit-big", 10, 0, 9)  # score 7, newest and larger
    point = replace(
        _row(
            "fit-point",
            "Datensatz fit-point",
            _box(11.5, 48.15, 11.5, 48.15),
            datetime(2026, 12, 1, tzinfo=timezone.utc),
        ),
        type="collection",
        idx=0,
    )  # score 7, newest
    # Layers keep their own footprint: a strip inside, a ten times larger piece
    # east of the city. Its rectangle fits like 0.4, its footprint like 0.05.
    june = datetime(2026, 6, 1, tzinfo=timezone.utc)
    piece = "[[{0}, 48.06], [{1}, 48.06], [{1}, 48.25], [{0}, 48.25], [{0}, 48.06]]"
    scattered = replace(
        _row("layer-scattered", "Ebene", _box(11.40, 48.06, 11.90, 48.25), june),
        geometry_geojson={
            "type": "MultiPolygon",
            "coordinates": [
                [json.loads(piece.format(11.40, 11.41))],
                [json.loads(piece.format(11.80, 11.90))],
            ],
        },
    )
    layer_small = _row("layer-small", "Ebene", _scaled(CITY, 1 / 10), june)
    island = replace(
        _row("layer-island", "Ebene", _box(11.36, 48.06, 30.01, 48.25), june),
        geometry_geojson={
            "type": "MultiPolygon",
            "coordinates": [[_box(*CITY)], [_box(30.0, 48.06, 30.01, 48.07)]],
        },
    )
    write_catalog(
        tmp_path,
        n=20,
        extra_rows=[same, small, big, point, scattered, layer_small, island],
    )
    write_nuts(tmp_path)
    fresh = CatalogStore(CatalogSettings(data_dir=tmp_path))
    fresh.ensure_current()

    for spatial in ({"bbox_boost": CITY}, {"bbox": CITY}):
        rows, _ = search_collections(fresh, SearchParams(limit=50, **spatial))
        ids = [r["id"] for r in rows]
        assert ids.index("fit-same") < ids.index("fit-small") < ids.index("fit-big")
        assert ids.index("fit-big") < ids.index("fit-point")

    layers = _ids(fresh, bbox_boost=CITY)
    assert layers.index("layer-island") < layers.index("layer-small")
    assert layers.index("layer-small") < layers.index("layer-scattered")


def test_the_reader_language_decides_within_a_topic_score(tmp_path: Path) -> None:
    """The topic score leads whatever the language; among equal scores the
    reader's language comes first, ahead of the larger and newer dataset."""

    def dataset(row_id: str, idx: int, language: str, size: float, month: int) -> Row:
        updated = datetime(2026, month, 1, tzinfo=timezone.utc)
        ring = _box(10.0, 48.0, 10.0 + size, 48.0 + size)
        row = _row(row_id, f"Datensatz {row_id}", ring, updated)
        return replace(row, type="collection", idx=idx, collection_language=language)

    rows = [
        dataset("top-de", 0, "de", 2.0, 9),  # score 7, larger and newer
        dataset("top-en", 0, "en", 0.5, 1),  # score 7
        dataset("low-en", 1, "en", 3.0, 10),  # score 5, largest and newest
        dataset("low-de", 1, "de", 0.5, 1),  # score 5
    ]
    write_catalog(tmp_path, n=20, extra_rows=rows)
    write_nuts(tmp_path)
    fresh = CatalogStore(CatalogSettings(data_dir=tmp_path))
    fresh.ensure_current()

    def order(language: str) -> list[str]:
        found, _ = search_collections(
            fresh, SearchParams(limit=50, language_boost=[language])
        )
        return [r["id"] for r in found if r["id"] in {row.id for row in rows}]

    assert order("en") == ["top-en", "top-de", "low-en", "low-de"]
    assert order("de") == ["top-de", "top-en", "low-de", "low-en"]


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

    def test_a_filter_containing_the_view_ignores_it(self, store) -> None:
        """One place at a time: even a region holding the view orders as the
        region alone, where the city dataset filling more of it leads."""
        ids = _ids(store, bbox=REGION, bbox_boost=CITY)

        assert ids == _ids(store, bbox=REGION)
        assert ids.index("local-1") < ids.index("far-local-1")


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

    # The same across the boundary between rows touching the view and the rest.
    pages = [
        search_items(store, SearchParams(limit=5, offset=o, bbox_boost=CITY))[0]
        for o in (0, 5)
    ]
    paged = [r["id"] for page in pages for r in page]
    assert paged == _ids(store, bbox_boost=CITY)[:10]

    # A world view, or a place with no area, has nothing to divide by.
    assert "local-1" in _ids(store, bbox_boost=[-180, -90, 180, 90])
    point = _box(11.5, 48.15, 11.5000001, 48.1500001)
    assert "local-1" in _ids(
        store, intersects={"type": "Polygon", "coordinates": [point]}
    )


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
