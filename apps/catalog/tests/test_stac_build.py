"""Tests for the document -> STAC transform layer (catalog.services.stac_build)."""

import json
from pathlib import Path
from typing import Any

import pytest

from catalog.services import capabilities
from catalog.services.registry import QueryableRegistry, build_registry
from catalog.services.stac_build import (
    STAC_VERSION,
    _is_private_href,
    catalog_landing,
    collection_to_stac,
    item_collection,
    item_from_row,
    record_to_item,
)

from .fixtures.gen_catalog import (
    BUNDLE_COLLECTION_ID,
    _build_rows,
    build_document,
)

STAC_BASE = "https://catalog.example.com/stac"


def _row0_document() -> dict[str, Any]:
    rows = _build_rows(20)
    return build_document(rows[0])


def _bundle_collection_document() -> dict[str, Any]:
    rows = _build_rows(20)
    by_id = {row.id: row for row in rows}
    return build_document(by_id[BUNDLE_COLLECTION_ID])


class TestRecordToItem:
    def test_type_and_stac_version(self) -> None:
        item = record_to_item(_row0_document(), stac_base=STAC_BASE)
        assert item["type"] == "Feature"
        assert item["stac_version"] == STAC_VERSION

    def test_an_item_says_that_it_has_published_tiles_not_where(self) -> None:
        """The tile file stays private and has no route here: geoapi reads it
        for a preview. The served item only says that it exists, so a client
        knows whether to ask."""
        doc = _row0_document()
        doc["assets"] = {
            **doc.get("assets", {}),
            "tiles": {"href": "../../../data/a.pmtiles", "roles": ["tiles"]},
        }
        item = record_to_item(
            doc, stac_base=STAC_BASE, assets_base="https://api.example/assets"
        )
        assert item["properties"]["goat:tiles"] is True
        assert "tiles" not in item["assets"]
        assert "a.pmtiles" not in str(item)
        plain = record_to_item(_row0_document(), stac_base=STAC_BASE)
        assert "goat:tiles" not in plain["properties"]

    def test_omits_collection_when_unresolved(self) -> None:
        """A standalone item with no real collection (no explicit
        ``collection_id`` and no stashed ``goat:row_collection``) must never
        get a synthetic "datasets" collection: the field is omitted, and
        ``self`` points at the collection-agnostic ``/items/{id}`` route
        with no ``parent``/``collection`` link rels."""
        item = record_to_item(_row0_document(), stac_base=STAC_BASE)
        assert "collection" not in item
        rels = {lk["rel"] for lk in item["links"]}
        assert "parent" not in rels
        assert "collection" not in rels
        by_rel = {lk["rel"]: lk for lk in item["links"]}
        assert by_rel["self"]["href"] == f"{STAC_BASE}/items/{item['id']}"

    def test_row_collection_used_when_no_explicit_collection_id(self) -> None:
        """``goat:row_collection`` (stashed by ``search_items``/``resolve_id``
        for a real bundle member) is used when the caller passes no explicit
        ``collection_id``."""
        doc = _row0_document()
        doc["goat:row_collection"] = "src-1"
        item = record_to_item(doc, stac_base=STAC_BASE)
        assert item["collection"] == "src-1"
        coll_href = f"{STAC_BASE}/collections/src-1"
        by_rel = {lk["rel"]: lk for lk in item["links"]}
        assert by_rel["self"]["href"] == f"{coll_href}/items/{item['id']}"
        assert by_rel["parent"]["href"] == coll_href
        assert "goat:row_collection" not in item  # stashing key never leaks

    def test_explicit_collection_id_wins_over_row_collection(self) -> None:
        doc = _row0_document()
        doc["goat:row_collection"] = "src-1"
        item = record_to_item(doc, stac_base=STAC_BASE, collection_id="other")
        assert item["collection"] == "other"

    def test_collection_id_override(self) -> None:
        item = record_to_item(
            _row0_document(), stac_base=STAC_BASE, collection_id="src-1"
        )
        assert item["collection"] == "src-1"

    def test_datetime_passes_through_untouched(self) -> None:
        """The publisher owns ``datetime``; serving must not re-derive it.

        Replaces an earlier test that asserted a ``time.interval`` -> datetime
        transformation: the stored documents are native STAC, so there is no
        interval to convert and nothing to recompute.
        """
        doc = _row0_document()
        stored = doc["properties"]["datetime"]
        item = record_to_item(doc, stac_base=STAC_BASE)
        assert item["properties"]["datetime"] == stored

    def test_private_s3_assets_are_stripped_provider_assets_survive(self) -> None:
        """GOAT's own copies (``s3://``) must never be published (design S14).

        Replaces an earlier test asserting the ``data`` asset was *built* from
        an enclosure link's ``goat:parquet_url``; native STAC documents ship a
        real ``assets`` map, and our GeoParquet/thumbnail entries in it are
        exactly what must not reach a client.
        """
        doc = _row0_document()
        stored = doc["assets"]
        private = {k for k, a in stored.items() if a["href"].startswith("s3://")}
        public = set(stored) - private
        assert private, "fixture must carry s3:// assets for this to mean anything"
        assert public, "fixture must carry provider assets too"

        item = record_to_item(doc, stac_base=STAC_BASE)

        assert set(item["assets"]) == public
        assert not any(
            str(a["href"]).startswith("s3://") for a in item["assets"].values()
        )
        for key in public:
            assert item["assets"][key] == stored[key]

    def test_links_contain_required_rels(self) -> None:
        item = record_to_item(
            _row0_document(), stac_base=STAC_BASE, collection_id="datasets"
        )
        rels = {lk["rel"] for lk in item["links"]}
        assert {"self", "parent", "collection", "root"} <= rels

        coll_href = f"{STAC_BASE}/collections/datasets"
        by_rel = {lk["rel"]: lk for lk in item["links"]}
        assert by_rel["self"]["href"] == f"{coll_href}/items/{item['id']}"
        assert by_rel["parent"]["href"] == coll_href
        assert by_rel["collection"]["href"] == coll_href
        assert by_rel["root"]["href"] == STAC_BASE

    def test_properties_carry_title_and_geometry(self) -> None:
        doc = _row0_document()
        item = record_to_item(doc, stac_base=STAC_BASE)
        assert item["properties"]["title"] == doc["properties"]["title"]
        assert item["geometry"] == doc["geometry"]
        assert item["bbox"] is not None

    def test_unusual_stored_datetime_is_not_normalised(self) -> None:
        """A date-only value stays as the publisher wrote it.

        Real harvester output carries values like ``2025-11-20Z``; whether that
        is strictly RFC 3339 is the publisher's business (tracked as a metadata
        finding). Serving must not silently rewrite it -- that would mask the
        upstream problem and make the API's output differ from the catalog's.
        """
        doc: dict[str, Any] = {
            "id": "item-date-only",
            "type": "Feature",
            "geometry": None,
            "properties": {"title": "Date-only datetime", "datetime": "2020-05-01"},
            "links": [],
        }
        item = record_to_item(doc, stac_base=STAC_BASE)
        assert item["properties"]["datetime"] == "2020-05-01"

    def test_absent_datetime_is_not_invented_here(self) -> None:
        """`record_to_item` adjusts a document; it does not complete one.

        The required-member guarantee lives one layer down in
        `item_from_row` (see `TestItemFromRow`), which is where every served
        document is assembled. Asserted here so the two rules cannot be read
        as contradicting each other.
        """
        doc: dict[str, Any] = {
            "id": "item-no-time",
            "type": "Feature",
            "geometry": None,
            "properties": {"title": "No datetime whatsoever"},
            "links": [],
        }
        item = record_to_item(doc, stac_base=STAC_BASE)
        assert "datetime" not in item["properties"]

    def test_missing_or_non_enclosure_links_yield_no_data_asset(self) -> None:
        no_links_doc: dict[str, Any] = {
            "id": "item-no-links",
            "type": "Feature",
            "geometry": None,
            "properties": {"type": "dataset", "title": "No links key at all"},
        }
        item_no_links = record_to_item(no_links_doc, stac_base=STAC_BASE)
        assert item_no_links["assets"] == {}

        non_enclosure_doc: dict[str, Any] = {
            "id": "item-non-enclosure-link",
            "type": "Feature",
            "geometry": None,
            "properties": {"type": "dataset", "title": "Preview link only"},
            "links": [
                {"rel": "preview", "type": "image/png", "href": "https://x/thumb.png"}
            ],
        }
        item_non_enclosure = record_to_item(non_enclosure_doc, stac_base=STAC_BASE)
        assert "data" not in item_non_enclosure["assets"]


class TestCollectionMirrorAsset:
    """The bulk-parquet asset is a static-tree affordance, not an API one."""

    def _collection(self, href: str) -> dict[str, Any]:
        return {
            "type": "Collection",
            "id": "c-1",
            "description": "A dataset",
            "license": "CC-BY-4.0",
            "extent": {},
            "links": [],
            "assets": {
                "collection-mirror": {
                    "href": href,
                    "type": "application/vnd.apache.parquet",
                    "roles": ["collection-mirror"],
                },
                "thumbnail": {
                    "href": "https://provider.example/thumb.png",
                    "roles": ["thumbnail"],
                },
            },
        }

    def test_dropped_even_when_the_href_is_absolute(self) -> None:
        """The exclusion must not depend on the href being unresolvable.

        Today the published href is relative (`../../items.parquet`) and the
        private-href filter removes it as a side effect. Resolving hrefs
        (contract C8) would otherwise start publishing, on all 3,834
        collections, a link to the catalog-wide items file -- which is not
        what a `collection-mirror` asset claims to be.
        """
        served = collection_to_stac(
            self._collection("https://cdn.example/items.parquet"),
            stac_base=STAC_BASE,
        )
        assert "collection-mirror" not in served["assets"]

    def test_other_assets_are_untouched(self) -> None:
        served = collection_to_stac(
            self._collection("../../items.parquet"), stac_base=STAC_BASE
        )
        assert list(served["assets"]) == ["thumbnail"]


class TestItemFromRow:
    """Assembly of an Item from a mirror row."""

    def test_null_datetime_is_present_not_omitted(self) -> None:
        """`properties.datetime` is REQUIRED even when its value is unknown.

        Nulls are dropped during assembly -- a parquet row carries every
        column of the schema, so keeping them would serve dozens of null
        members. `datetime` is the exception the Item spec makes: the member
        must exist, and may be null. Omitting it failed validation on 52% of
        the real catalog (5,593 items the harvester publishes with no date).
        """
        item = item_from_row(
            {"id": "i-1", "geometry": None, "datetime": None, "title": "No date"}
        )
        assert "datetime" in item["properties"]
        assert item["properties"]["datetime"] is None

    def test_datetime_is_not_backfilled_from_created_or_updated(self) -> None:
        """A harvest timestamp is not temporal coverage.

        `created`/`updated` are populated on every real item, so they are the
        obvious backfill -- and the wrong one: they are the harvest run's
        clock (contract C11), so using them would make a `datetime=2020/2021`
        search match datasets by when GOAT scraped them.
        """
        item = item_from_row(
            {
                "id": "i-1",
                "geometry": None,
                "datetime": None,
                "created": "2026-07-31T14:23:53Z",
                "updated": "2026-07-31T14:23:53Z",
            }
        )
        assert item["properties"]["datetime"] is None

    def test_published_datetime_survives(self) -> None:
        item = item_from_row(
            {"id": "i-1", "geometry": None, "datetime": "2020-05-01T00:00:00Z"}
        )
        assert item["properties"]["datetime"] == "2020-05-01T00:00:00Z"


class TestCollectionToStac:
    def test_collection_shape(self) -> None:
        doc = _bundle_collection_document()
        collection = collection_to_stac(doc, stac_base=STAC_BASE)

        assert collection["type"] == "Collection"
        assert collection["stac_version"] == STAC_VERSION
        assert collection["id"] == BUNDLE_COLLECTION_ID
        assert collection["title"] == doc["title"]
        assert collection["description"] == doc["description"]
        assert collection["license"] == doc["license"]
        assert "extent" in collection
        assert (
            collection["extent"]["spatial"]["bbox"] == doc["extent"]["spatial"]["bbox"]
        )

    def test_collection_links(self) -> None:
        doc = _bundle_collection_document()
        collection = collection_to_stac(doc, stac_base=STAC_BASE)
        rels = {lk["rel"] for lk in collection["links"]}
        assert {"root", "self", "items"} <= rels


#: The item mirror's column set, as ``catalog.store`` derives the registry
#: from it. Spelled out here because this module tests the transform layer in
#: isolation (no store, no parquet), and the capability layer needs a registry
#: to answer what the catalog can serve.
_MIRROR_COLUMNS = {
    "id": "VARCHAR",
    "collection": "VARCHAR",
    "title": "VARCHAR",
    "description": "VARCHAR",
    "license": "VARCHAR",
    "category": "VARCHAR",
    "language_code": "VARCHAR",
    "publisher": "VARCHAR",
    "geometry": "GEOMETRY",
    "datetime": "TIMESTAMP WITH TIME ZONE",
    "created": "TIMESTAMP WITH TIME ZONE",
    "updated": "TIMESTAMP WITH TIME ZONE",
    "version": "VARCHAR",
    "parquet_url": "VARCHAR",
    "search_text": "VARCHAR",
    "goat:layerType": "VARCHAR",
    "goat:geometryType": "VARCHAR",
    "goat:geographical_code": "VARCHAR",
}


def _registry() -> QueryableRegistry:
    return build_registry(_MIRROR_COLUMNS)


def _landing(
    source_ids: list[str] | None = None, registry: QueryableRegistry | None = None
) -> dict[str, Any]:
    """A landing page built the way the router builds it.

    The conformance list and the extension links are the capability layer's
    answer for a given registry (``catalog.services.capabilities``), not
    constants of this module -- so this passes them in exactly as the handler
    does.
    """
    reg = registry if registry is not None else _registry()
    return catalog_landing(
        STAC_BASE,
        source_ids=source_ids or [],
        service_desc=f"{STAC_BASE}/api",
        conforms_to=capabilities.conformance_classes(reg),
        capability_links=capabilities.capability_links(reg, STAC_BASE),
    )


class TestCatalogLanding:
    def test_conforms_to_present(self) -> None:
        landing = _landing(["src-1"])
        assert landing["conformsTo"] == capabilities.conformance_classes(_registry())
        assert len(landing["conformsTo"]) > 0

    def test_required_rels_present(self) -> None:
        landing = _landing()
        rels = {lk["rel"] for lk in landing["links"]}
        assert {
            "root",
            "self",
            "service-desc",
            "conformance",
            "data",
            "search",
        } <= rels

    def test_added_rels_present(self) -> None:
        landing = _landing()
        rels = {lk["rel"] for lk in landing["links"]}
        assert "aggregate" in rels
        assert "aggregations" in rels
        assert "http://www.opengis.net/def/rel/ogc/1.0/queryables" in rels

        by_rel = {lk["rel"]: lk for lk in landing["links"]}
        assert by_rel["aggregate"]["href"] == f"{STAC_BASE}/aggregate"
        assert by_rel["aggregations"]["href"] == f"{STAC_BASE}/aggregations"
        assert (
            by_rel["http://www.opengis.net/def/rel/ogc/1.0/queryables"]["href"]
            == f"{STAC_BASE}/queryables"
        )

    def test_extension_links_follow_the_capability(self) -> None:
        """A catalog with nothing to filter on must not link a queryables doc.

        The links and the conformance list come from the same declaration, so
        the page cannot claim an extension it has no data to serve.
        """
        empty = build_registry({})
        landing = _landing(registry=empty)
        rels = {lk["rel"] for lk in landing["links"]}
        assert "http://www.opengis.net/def/rel/ogc/1.0/queryables" not in rels
        assert (
            "https://api.stacspec.org/v1.0.0/item-search#filter"
            not in (landing["conformsTo"])
        )
        # Aggregation needs no particular column (`total_count` always works).
        assert "aggregate" in rels


class TestItemCollection:
    def test_wraps_features_with_links(self) -> None:
        features = [record_to_item(_row0_document(), stac_base=STAC_BASE)]
        result = item_collection(
            features,
            stac_base=STAC_BASE,
            self_href=f"{STAC_BASE}/search",
            number_matched=1,
        )
        assert result["type"] == "FeatureCollection"
        assert result["numberMatched"] == 1
        assert result["numberReturned"] == 1
        rels = {lk["rel"] for lk in result["links"]}
        assert {"root", "self"} <= rels

    def test_next_prev_links(self) -> None:
        result = item_collection(
            [],
            stac_base=STAC_BASE,
            self_href=f"{STAC_BASE}/search",
            number_matched=0,
            next_href=f"{STAC_BASE}/search?offset=10",
            prev_href=f"{STAC_BASE}/search?offset=0",
        )
        rels = {lk["rel"] for lk in result["links"]}
        assert "next" in rels
        assert "prev" in rels


# --------------------------------------------------------------------------
# Real harvester output. The documents under tests/fixtures/real/ were captured
# verbatim from the harvester's S3 bucket, so these tests fail if the transform
# stops handling what production actually publishes -- the synthetic fixture
# can drift from reality, this cannot.
# --------------------------------------------------------------------------

REAL_DIR = Path(__file__).parent / "fixtures" / "real"


def _real(name: str) -> dict[str, Any]:
    doc: dict[str, Any] = json.loads((REAL_DIR / f"{name}.json").read_text())
    return doc


def _hrefs(doc: dict[str, Any]) -> list[str]:
    return [str(lk.get("href")) for lk in doc.get("links", [])] + [
        str(a.get("href")) for a in doc.get("assets", {}).values()
    ]


class TestRealHarvesterItems:
    @pytest.mark.parametrize("name", ["single_item", "bundle_item_1"])
    def test_no_private_s3_href_survives_anywhere(self, name: str) -> None:
        doc = _real(name)
        assert any(
            h.startswith("s3://") for h in _hrefs(doc)
        ), "captured document must contain s3:// hrefs for this to be meaningful"
        item = record_to_item(doc, stac_base=STAC_BASE)
        assert not [h for h in _hrefs(item) if h.startswith("s3://")]

    @pytest.mark.parametrize("name", ["single_item", "bundle_item_1"])
    def test_provider_download_assets_are_preserved(self, name: str) -> None:
        doc = _real(name)
        provider = {
            k: a
            for k, a in doc["assets"].items()
            if not str(a["href"]).startswith("s3://")
        }
        assert provider, "captured item must carry provider-format assets"
        item = record_to_item(doc, stac_base=STAC_BASE)
        assert item["assets"] == provider

    @pytest.mark.parametrize("name", ["single_item", "bundle_item_1"])
    def test_navigational_links_become_absolute(self, name: str) -> None:
        doc = _real(name)
        cid = doc["collection"]
        item = record_to_item(doc, stac_base=STAC_BASE)
        by_rel = {lk["rel"]: lk["href"] for lk in item["links"]}
        assert item["collection"] == cid
        assert by_rel["self"] == f"{STAC_BASE}/collections/{cid}/items/{doc['id']}"
        assert by_rel["root"] == STAC_BASE
        assert by_rel["parent"] == f"{STAC_BASE}/collections/{cid}"
        assert by_rel["collection"] == f"{STAC_BASE}/collections/{cid}"

    @pytest.mark.parametrize("name", ["single_item", "bundle_item_1"])
    def test_both_via_links_survive(self, name: str) -> None:
        doc = _real(name)
        stored_via = [lk for lk in doc["links"] if lk["rel"] == "via"]
        assert len(stored_via) == 2, "captured items carry source + harvested-from"
        item = record_to_item(doc, stac_base=STAC_BASE)
        assert [lk for lk in item["links"] if lk["rel"] == "via"] == stored_via

    def test_open_in_goat_link_added_when_ui_base_known(self) -> None:
        doc = _real("single_item")
        item = record_to_item(
            doc, stac_base=STAC_BASE, goat_ui_base_url="https://goat.example.com/"
        )
        alt = [lk for lk in item["links"] if lk["rel"] == "alternate"]
        assert len(alt) == 1
        assert alt[0]["title"] == "Open in GOAT"
        assert alt[0]["href"] == f"https://goat.example.com/catalog/{doc['id']}"

    def test_publisher_owned_fields_are_untouched(self) -> None:
        doc = _real("single_item")
        item = record_to_item(doc, stac_base=STAC_BASE)
        for field in ("id", "type", "stac_version", "stac_extensions", "bbox"):
            assert item[field] == doc[field]
        assert item["properties"] == doc["properties"]
        assert item["geometry"] == doc["geometry"]


class TestRealHarvesterBundleCollection:
    def test_collection_links_and_members_are_absolute(self) -> None:
        doc = _real("bundle_collection")
        cid = doc["id"]
        members = [lk for lk in doc["links"] if lk["rel"] == "item"]
        assert len(members) == 3, "the captured bundle has three members"

        coll = collection_to_stac(doc, stac_base=STAC_BASE)

        by_rel: dict[str, list[str]] = {}
        for lk in coll["links"]:
            by_rel.setdefault(str(lk["rel"]), []).append(str(lk["href"]))
        assert by_rel["self"] == [f"{STAC_BASE}/collections/{cid}"]
        assert by_rel["root"] == [STAC_BASE]
        assert by_rel["items"] == [f"{STAC_BASE}/collections/{cid}/items"]
        assert len(by_rel["item"]) == 3
        for href in by_rel["item"]:
            assert href.startswith(f"{STAC_BASE}/collections/{cid}/items/")
            assert not href.endswith(".json")
        assert len(by_rel["via"]) == 2

    def test_private_thumbnail_stripped_and_metadata_preserved(self) -> None:
        doc = _real("bundle_collection")
        assert str(doc["assets"]["thumbnail"]["href"]).startswith("s3://")
        coll = collection_to_stac(doc, stac_base=STAC_BASE)
        assert coll["assets"] == {}
        for field in ("extent", "summaries", "providers", "license", "keywords"):
            assert coll[field] == doc[field]


class TestPrivateAssetDetection:
    """S14: only absolute http(s) asset hrefs may be served.

    The rule is scheme-*inclusive* rather than ``s3://``-exclusive because the
    harvester changed its spelling once already: item assets moved from
    ``s3://bucket/data/x.parquet`` to tree-relative ``../../../data/x.parquet``,
    which an ``s3://``-only check passes, publishing the private GeoParquet.
    """

    @pytest.mark.parametrize(
        "href",
        [
            "s3://p4b-catalog/data/x.parquet",
            "../../../data/x.parquet",
            "./thumbs/x.svg",
            "/data/x.parquet",
            "data/x.parquet",
            None,
            123,
        ],
    )
    def test_private_hrefs_are_dropped(self, href: object) -> None:
        assert _is_private_href(href) is True

    @pytest.mark.parametrize(
        "href",
        [
            "https://data.wien.gv.at/download/x.zip",
            "http://example.test/x.json",
            "HTTPS://Example.test/x.json",
        ],
    )
    def test_provider_urls_survive(self, href: str) -> None:
        assert _is_private_href(href) is False

    def test_relative_assets_are_stripped_from_a_served_item(self) -> None:
        item = record_to_item(
            {
                "type": "Feature",
                "stac_version": STAC_VERSION,
                "id": "x",
                "geometry": {"type": "Point", "coordinates": [0, 0]},
                "properties": {"datetime": "2026-01-01T00:00:00Z"},
                "assets": {
                    "data": {"href": "../../../data/x.parquet"},
                    "thumbnail": {"href": "../../../thumbs/x.svg"},
                    "provider_dl": {"href": "https://provider.test/x.zip"},
                },
                "links": [],
            },
            stac_base=STAC_BASE,
        )
        assert set(item["assets"]) == {"provider_dl"}


class TestCallerDocumentIsNotMutated:
    """Both transforms copy before editing -- they are handed a row's document,
    and a page of them used to be deep-copied one by one for no reason."""

    def test_record_to_item_leaves_its_argument_alone(self) -> None:
        document = _row0_document()
        before = json.dumps(document, sort_keys=True, default=str)

        record_to_item(document, stac_base=STAC_BASE, assets_base="https://x/assets")

        assert json.dumps(document, sort_keys=True, default=str) == before

    def test_collection_to_stac_leaves_its_argument_alone(self) -> None:
        document = _bundle_collection_document()
        before = json.dumps(document, sort_keys=True, default=str)

        collection_to_stac(document, stac_base=STAC_BASE)

        assert json.dumps(document, sort_keys=True, default=str) == before
