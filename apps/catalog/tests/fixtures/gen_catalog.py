"""Synthetic STAC-catalog fixture generator for tests.

Adapted from the design-phase benchmark generator (``catalog_bench.py``):
reuses the same topic/region/license/category vocabulary and polygon
footprint approach over Germany, minus the timing/benchmark harness.

Produces a deterministic (``random.Random(42)``) parquet fixture matching
the catalog's Global-Constraints schema, plus a small NUTS lookup parquet.

The ``document`` column holds **native STAC** documents -- the same shape
real harvester output takes (see ``tests/fixtures/real/*.json``, captured
from the real bucket): a Feature-shaped Item with top-level
``id``/``bbox``/``geometry``/``collection``/``stac_version``/
``stac_extensions``, a real ``assets`` map (``data`` + ``thumbnail`` plus a
per-row mix of provider-format assets), and ``properties`` matching real
absence/presence: ``title``/``description``/``keywords``/``themes``/
``license``/``datetime``/``contacts``/``goat:*``/``table:*`` are always
present; ``language``/``version``/``created``/``goat:geographical_code`` are
never embedded in the document (even though the identically-named parquet
*columns* stay populated -- only the JSON content's shape changed);
``updated`` is present on roughly half the rows, absent on the rest, mirroring
the real harvester's actual output. A Collection row is the STAC-Collection
tier (``extent``/``license``/``providers``/``summaries``/``assets.thumbnail``).

Row 0 and a fixed "bundle" (a collection row plus four member rows) are
pinned to specific ids/titles so later tasks' tests can assert on them
verbatim; every other row is filled from the same deterministic RNG stream.

Pinned content contract (seed 42):
- Row 0: id ``radverkehrsnetz-dresden-0``, title ``Radverkehrsnetz Dresden
  2018``, license ``CC-BY-4.0``, category ``transportation``, language
  ``de``, collection ``NULL`` -- a genuine standalone item (see
  ``BUNDLE_COLLECTION_ID`` below for the bundle case).
- Bundle: collection row id ``src-1`` (``BUNDLE_COLLECTION_ID``) at row index
  ``BUNDLE_COLLECTION_INDEX`` with 4 member item rows at
  ``BUNDLE_ROW_INDICES`` (all ``collection == "src-1"``) -- exercises the
  real multi-item "bundle" case (a collection with >1 item; 3+ members is the
  real-world bundle shape, this fixture uses 4 to keep the existing pinned
  row layout other tasks' tests already assert on).
"""

import json
import random
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import duckdb
from goatlib.tasks.catalog_mirror import build_mirror

TOPICS = [
    "Flurstücke",
    "Radverkehrsnetz",
    "Bebauungsplan",
    "Adresspunkte",
    "Haltestellen",
    "Schulstandorte",
    "Grünflächen",
    "Lärmkartierung",
    "Hochwassergefahr",
    "Baumkataster",
    "Liegenschaftskataster",
    "Bevölkerungsdichte",
    "Landnutzung",
    "Solarpotenzial",
    "Straßennetz",
    "Kindertagesstätten",
    "Spielplätze",
    "Denkmalschutz",
    "Luftqualität",
    "Wanderwege",
    "Parkraumbewirtschaftung",
    "Stadtgrenzen",
    "Wahlbezirke",
    "Gewässernetz",
]
REGIONS = [
    "Thüringen",
    "Brandenburg",
    "Sachsen",
    "Bayern",
    "Hessen",
    "Berlin",
    "Hamburg",
    "Nordrhein-Westfalen",
    "Kreis Kleve",
    "Dresden",
    "München",
    "Frankfurt am Main",
    "Stuttgart",
    "Leipzig",
    "Köln",
    "Niedersachsen",
    "Rheinland-Pfalz",
    "Saarland",
]
DESC_WORDS = (
    "Der Datensatz enthält die aktuellen Geometrien und Sachdaten für das "
    "Antragsverfahren der Verwaltung . Die Daten werden regelmäßig aktualisiert "
    "und stehen als Download sowie über Dienste bereit . Erfassung erfolgt durch "
    "die zuständige Fachbehörde auf Grundlage amtlicher Vermessung und "
    "Fernerkundung . Geeignet für Analysen in Planung Umwelt Verkehr und "
    "Statistik . Qualitätsgeprüft vollständig flächendeckend"
).split()
LICENSES = [
    "dl-de-by-2.0",
    "CC-BY-4.0",
    "ODbL-1.0",
    "CC0-1.0",
    "dl-de-zero-2.0",
    "CC-BY-SA-4.0",
    "other",
    "CC-BY-NC-4.0",
]
CATEGORIES = [
    "transportation",
    "boundary",
    "landuse",
    "people",
    "environment",
    "places",
    "basemap",
    "imagery",
    "other",
]
PUBLISHERS = (
    [f"Landesamt {i}" for i in range(30)]
    + [f"Stadt {r}" for r in REGIONS]
    + ["govdata.de", "OpenStreetMap"]
)
TYPES = ["feature", "feature", "feature", "table", "raster"]
GEOMS = ["polygon", "point", "line"]

BASE_DATETIME = datetime(2026, 1, 1, tzinfo=timezone.utc)
PARQUET_ASSET_BASE_URL = "s3://p4b-catalog/catalog/data"
THUMBS_ASSET_BASE_URL = "s3://p4b-catalog/catalog/thumbs"
SOURCE_PORTAL_BASE_URL = "https://data.example.org/katalog/datasets"
HARVEST_PORTAL_BASE_URL = "https://harvest.example.org/dataset"

STAC_VERSION = "1.0.0"
THEMES_SCHEME = "https://goat.plan4better.de/data-categories"
ITEM_STAC_EXTENSIONS = ["https://stac-extensions.github.io/table/v1.2.0/schema.json"]
COLLECTION_STAC_EXTENSIONS = [
    "https://stac-extensions.github.io/collection-assets/v1.0.0/schema.json"
]

# Fixed content contract (seed 42): row 0 is a pinned deterministic item;
# rows BUNDLE_ROW_INDICES are members of the collection at
# BUNDLE_COLLECTION_INDEX (id BUNDLE_COLLECTION_ID). Later tasks' tests
# assert on these positions/ids verbatim.
BUNDLE_COLLECTION_INDEX = 9
BUNDLE_ROW_INDICES = (10, 11, 12, 13)

#: The one item left without a collection, so the collection-less branch of the
#: assembler stays covered (no `collection`/`parent` links, self link under
#: `/items/`). Row 0 is the pinned row those tests reach for, so it is the orphan;
#: every other item gets its own dataset.
ORPHAN_INDEX = 0
BUNDLE_COLLECTION_ID = "src-1"

# A per-row mix of "provider download" assets (real harvester items carry
# whichever formats that source's WFS/WMS actually exposes -- never the same
# set twice), selected deterministically off ``Row.idx`` so asset-filtering
# logic sees real variety instead of one identical shape on every row.
_ASSET_TITLES: dict[str, str] = {
    "kml": "KML-Download",
    "kmz": "WMS GetMap (KMZ)",
    "shp": "SHP-Download",
    "gpkg": "GPKG-Download",
    "json": "WFS GetFeature (JSON)",
    "json_2": "WFS GetFeature (JSON) - alt 1",
    "json_3": "WFS GetFeature (JSON) - alt 2",
    "wfs_srvc": "WFS GetCapabilities",
}
_PROVIDER_ASSET_PROFILES: list[list[str]] = [
    ["kml", "shp", "gpkg", "json", "wfs_srvc"],
    ["kmz", "json", "json_2", "json_3", "wfs_srvc"],
    ["wfs_srvc"],
    ["shp", "gpkg"],
]

NUTS_REGIONS: list[tuple[str, str, int, str]] = [
    ("DE", "Deutschland", 0, "DE"),
    ("DE1", "Baden-Württemberg", 1, "DE"),
    ("DE2", "Bayern", 1, "DE"),
    ("DE3", "Berlin", 1, "DE"),
    ("DE4", "Brandenburg", 1, "DE"),
    ("DE5", "Bremen", 1, "DE"),
    ("DE6", "Hamburg", 1, "DE"),
    ("DE7", "Hessen", 1, "DE"),
    ("DE8", "Mecklenburg-Vorpommern", 1, "DE"),
    ("DE9", "Niedersachsen", 1, "DE"),
    ("DEA", "Nordrhein-Westfalen", 1, "DE"),
    ("DEB", "Rheinland-Pfalz", 1, "DE"),
    ("DEC", "Saarland", 1, "DE"),
    ("DED", "Sachsen", 1, "DE"),
    ("DEE", "Sachsen-Anhalt", 1, "DE"),
    ("DEF", "Schleswig-Holstein", 1, "DE"),
    ("DEG", "Thüringen", 1, "DE"),
]


@dataclass
class Row:
    """One catalog row: parquet-schema fields plus a GeoJSON geometry.

    ``idx`` is the row's build-time position, used only to deterministically
    vary the *document*'s sparse/optional content (which provider assets it
    carries, whether it embeds ``updated``, ...) -- it is not itself a parquet
    column. Defaults to 0 so hand-built ``Row``s (e.g. a test inserting one
    extra row directly) don't need to supply it.
    """

    id: str
    collection: str | None
    type: str
    geom_type: str | None
    title: str
    description: str
    license: str
    category: str
    language: str
    publisher: str
    geometry_wkt: str
    geometry_geojson: dict[str, Any]
    item_datetime: datetime
    created: datetime
    updated: datetime
    version: str
    parquet_url: str | None
    idx: int = 0


def _polygon(rng: random.Random) -> tuple[str, dict[str, Any]]:
    """Generate a small rectangular polygon footprint over Germany."""
    w = rng.uniform(5.9, 14.5)
    s = rng.uniform(47.3, 54.5)
    dx = rng.uniform(0.05, 1.5)
    dy = rng.uniform(0.05, 1.0)
    coords = [[[w, s], [w + dx, s], [w + dx, s + dy], [w, s + dy], [w, s]]]
    wkt = f"POLYGON(({w} {s},{w + dx} {s},{w + dx} {s + dy}," f"{w} {s + dy},{w} {s}))"
    return wkt, {"type": "Polygon", "coordinates": coords}


def _make_row(
    rng: random.Random,
    i: int,
    *,
    topic: str | None = None,
    region: str | None = None,
    license_id: str | None = None,
    category: str | None = None,
    language: str | None = None,
    collection: str | None = None,
    row_type: str | None = None,
) -> Row:
    topic = topic or rng.choice(TOPICS)
    region = region or rng.choice(REGIONS)
    title = f"{topic} {region} {2018 + i % 9}"
    description = " ".join(rng.sample(DESC_WORDS, k=30)) + f" {topic} {region}."
    license_id = license_id or rng.choice(LICENSES)
    category = category or rng.choice(CATEGORIES)
    language = language or rng.choice(["de", "en"])
    publisher = rng.choice(PUBLISHERS)
    row_type = row_type or rng.choice(TYPES)

    geom_type: str | None
    if row_type == "table":
        geom_type = None
    elif row_type == "raster":
        geom_type = "polygon"
    else:
        geom_type = rng.choice(GEOMS)

    wkt, geojson = _polygon(rng)
    dt = BASE_DATETIME + timedelta(days=i)
    created = dt
    updated = dt + timedelta(days=1)
    version = f"v{1 + i % 4}"
    item_id = f"{topic.lower()}-{region.lower().replace(' ', '-')}-{i}"
    parquet_url = f"{PARQUET_ASSET_BASE_URL}/{item_id}.parquet"

    return Row(
        id=item_id,
        collection=collection,
        type=row_type,
        geom_type=geom_type,
        title=title,
        description=description,
        license=license_id,
        category=category,
        language=language,
        publisher=publisher,
        geometry_wkt=wkt,
        geometry_geojson=geojson,
        item_datetime=dt,
        created=created,
        updated=updated,
        version=version,
        parquet_url=parquet_url,
        idx=i,
    )


def _make_collection_row(rng: random.Random, i: int) -> Row:
    """Build the ``src-1`` collection row that bundles the member rows."""
    wkt, geojson = _polygon(rng)
    dt = BASE_DATETIME + timedelta(days=i)
    created = dt
    updated = dt + timedelta(days=1)
    publisher = rng.choice(PUBLISHERS)

    return Row(
        id=BUNDLE_COLLECTION_ID,
        collection=None,
        type="collection",
        geom_type=None,
        title="Radverkehrsnetz Bundle",
        description=(
            "Sammlung mehrerer Radverkehrsnetz-Layer, gebündelt für die "
            "Katalogsuche."
        ),
        license="CC-BY-4.0",
        category="transportation",
        language="de",
        publisher=publisher,
        geometry_wkt=wkt,
        geometry_geojson=geojson,
        item_datetime=dt,
        created=created,
        updated=updated,
        version="v1",
        parquet_url=None,
        idx=i,
    )


def _dataset_collection_for(item: Row) -> Row:
    """The Collection that *is* this single-layer dataset.

    Every published item belongs to a collection -- 0 of the real catalog's
    10,793 items are orphans -- because the harvester emits one Collection per
    source dataset and one Item per layer of it. The fixture used to leave all
    but the bundle members collection-less, which made a dataset-level search
    (Collection Search, which the catalog page and the MCP tool both use) see a
    single dataset and nothing to page through.

    Metadata is copied from the layer, as it is upstream: for a one-layer dataset
    the layer's title and licence *are* the dataset's.
    """
    return Row(
        id=f"src-{item.id}",
        collection=None,
        type="collection",
        geom_type=None,
        title=item.title,
        description=item.description,
        license=item.license,
        category=item.category,
        language=item.language,
        publisher=item.publisher,
        geometry_wkt=item.geometry_wkt,
        geometry_geojson=item.geometry_geojson,
        item_datetime=item.item_datetime,
        created=item.created,
        updated=item.updated,
        version=item.version,
        parquet_url=None,
        idx=item.idx,
    )


def _rfc3339(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _bbox_from_geojson(geojson: dict[str, Any]) -> list[float]:
    lons = [pt[0] for pt in geojson["coordinates"][0]]
    lats = [pt[1] for pt in geojson["coordinates"][0]]
    return [min(lons), min(lats), max(lons), max(lats)]


def _style_for(row: Row) -> dict[str, Any]:
    """A trimmed-down ``goat:style`` block -- real ones carry a lot more
    (color_range, breaks, ...), but nothing downstream reads into this any
    deeper than existence, so only a plausible shell is reproduced here."""
    return {
        "color": [102, 194, 165],
        "filled": True,
        "opacity": 0.8,
        "stroked": row.geom_type != "polygon",
        "max_zoom": 22,
        "min_zoom": 1,
        "visibility": True,
    }


def _table_columns(row: Row) -> list[dict[str, Any]]:
    columns: list[dict[str, Any]] = [{"name": "id"}]
    if row.type == "table":
        columns.append({"name": "value", "type": "number", "null_pct": 0})
    columns.extend([{"name": "geometry"}, {"name": "bbox"}])
    return columns


def _provider_assets(row: Row) -> dict[str, dict[str, Any]]:
    profile = _PROVIDER_ASSET_PROFILES[row.idx % len(_PROVIDER_ASSET_PROFILES)]
    base = f"https://harvest-source.example.org/geoserver/ows?typeName={row.id}"
    return {
        key: {
            "href": f"{base}&format={key}",
            "type": "application/octet-stream",
            "roles": ["data"],
            "title": _ASSET_TITLES[key],
        }
        for key in profile
    }


def _item_assets(row: Row) -> dict[str, dict[str, Any]]:
    href = row.parquet_url or f"{PARQUET_ASSET_BASE_URL}/{row.id}.parquet"
    assets: dict[str, dict[str, Any]] = {
        "data": {
            "href": href,
            "type": "application/x-parquet",
            "roles": ["data"],
            "title": "GeoParquet",
        },
        "thumbnail": {
            "href": f"{THUMBS_ASSET_BASE_URL}/{row.id}.svg",
            "type": "image/svg+xml",
            "roles": ["thumbnail"],
            "title": "Thumbnail",
        },
    }
    assets.update(_provider_assets(row))
    return assets


def _item_links(row: Row) -> list[dict[str, Any]]:
    links: list[dict[str, Any]] = [
        {"rel": "self", "href": f"{row.id}.json", "type": "application/geo+json"},
        {"rel": "root", "href": "../../../catalog.json", "type": "application/json"},
    ]
    if row.collection:
        links.append(
            {"rel": "parent", "href": "../collection.json", "type": "application/json"}
        )
        links.append(
            {
                "rel": "collection",
                "href": "../collection.json",
                "type": "application/json",
            }
        )
    links.append(
        {
            "rel": "via",
            "href": f"{SOURCE_PORTAL_BASE_URL}/{row.id}",
            "type": "text/html",
            "title": "Source dataset",
        }
    )
    links.append(
        {
            "rel": "via",
            "href": f"{HARVEST_PORTAL_BASE_URL}/{row.id}",
            "type": "text/html",
            "title": "Harvested from",
        }
    )
    return links


def _item_properties(row: Row) -> dict[str, Any]:
    """Real Item properties: always present are title/description/keywords/
    themes/license/datetime/contacts/goat:*/table:* -- ``language``,
    ``version``, ``created`` and ``goat:geographical_code`` are never
    embedded (real harvester output omits them entirely), and ``updated`` is
    present on roughly half of real items, absent on the rest (``row.idx``
    parity reproduces that mix deterministically)."""
    topic = row.title.split(" ")[0]
    props: dict[str, Any] = {
        "title": row.title,
        "themes": [{"scheme": THEMES_SCHEME, "concepts": [{"id": row.category}]}],
        "license": row.license,
        "contacts": [{"name": row.publisher, "roles": ["publisher"]}],
        "datetime": _rfc3339(row.item_datetime),
        "keywords": [topic.lower()],
        "description": row.description,
        "goat:resourceId": f"{row.id}::{topic.lower()}",
        "table:row_count": 100 + row.idx * 7,
    }
    if row.idx % 2 == 0:
        # Real ``updated`` is date-precision with a bare trailing "Z"
        # (e.g. "2026-04-27Z"), not a full RFC3339 timestamp.
        props["updated"] = row.updated.date().isoformat() + "Z"
    if row.geom_type:
        props["goat:geometryType"] = row.geom_type
        props["goat:style"] = _style_for(row)
    if row.type != "raster":
        props["table:columns"] = _table_columns(row)
    if row.idx % 3 == 0:
        props["externalIds"] = [{"value": row.id, "scheme": "ckan"}]
    return props


def _build_item_document(row: Row) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "id": row.id,
        "type": "Feature",
        "stac_version": STAC_VERSION,
        "stac_extensions": list(ITEM_STAC_EXTENSIONS),
        "bbox": _bbox_from_geojson(row.geometry_geojson),
        "geometry": row.geometry_geojson,
        "links": _item_links(row),
        "assets": _item_assets(row),
        "properties": _item_properties(row),
    }
    if row.collection:
        doc["collection"] = row.collection
    return doc


def _union_bbox(bboxes: list[list[float]]) -> list[float]:
    return [
        min(b[0] for b in bboxes),
        min(b[1] for b in bboxes),
        max(b[2] for b in bboxes),
        max(b[3] for b in bboxes),
    ]


def _build_collection_document(
    row: Row, member_bboxes: list[list[float]] | None = None
) -> dict[str, Any]:
    # A Collection's spatial extent must cover its members, so it is the union
    # of their bboxes rather than the collection row's own random geometry.
    # (With an extent that excluded its own items, an `intersects` search
    # derived from the extent -- which is exactly what stac-api-validator
    # does -- found nothing and looked like a spatial-filter bug.)
    own_bbox = _bbox_from_geojson(row.geometry_geojson)
    bbox = _union_bbox([own_bbox, *member_bboxes]) if member_bboxes else own_bbox
    instant = _rfc3339(row.item_datetime)
    topic = row.title.split(" ")[0]
    return {
        "id": row.id,
        "type": "Collection",
        "stac_version": STAC_VERSION,
        "stac_extensions": list(COLLECTION_STAC_EXTENSIONS),
        "title": row.title,
        "description": row.description,
        "license": row.license,
        "keywords": [topic.lower()],
        "providers": [{"name": row.publisher, "roles": ["producer"]}],
        "extent": {
            "spatial": {"bbox": [bbox]},
            "temporal": {"interval": [[instant, instant]]},
        },
        "summaries": {
            "themes": [{"scheme": THEMES_SCHEME, "concepts": [{"id": row.category}]}],
            "goat:layerType": ["feature"],
            "goat:geometryType": ["polygon"],
        },
        "assets": {
            "thumbnail": {
                "href": f"{THUMBS_ASSET_BASE_URL}/{row.id}.svg",
                "type": "image/svg+xml",
                "roles": ["thumbnail"],
                "title": "Thumbnail",
            }
        },
        "links": [
            {"rel": "self", "href": "collection.json", "type": "application/json"},
            {"rel": "root", "href": "../../catalog.json", "type": "application/json"},
            {"rel": "parent", "href": "../catalog.json", "type": "application/json"},
        ],
    }


#: The published vocabulary, best first, with its score (7, 5, 3, 1).
_TOPIC_TIERS = ("base", "statutory", "nice_to_have", "low_priority")


def build_document(
    row: Row, member_bboxes: list[list[float]] | None = None
) -> dict[str, Any]:
    """Build the native-STAC ``document`` JSON for one catalog row.

    Matches real harvester output (``tests/fixtures/real/*.json``): a
    Collection row becomes a STAC Collection, everything else becomes a STAC
    Item -- see the module docstring for the exact presence/absence contract
    this reproduces.

    ``member_bboxes`` are the bboxes of the rows belonging to this collection;
    passed for a Collection row, they widen its spatial extent to cover its
    members (ignored for Item rows). ``write_catalog`` supplies them.
    """
    if row.type == "collection":
        return _build_collection_document(row, member_bboxes)
    return _build_item_document(row)


def _build_rows(n: int) -> list[Row]:
    min_n = max(BUNDLE_COLLECTION_INDEX, *BUNDLE_ROW_INDICES) + 1
    if n < min_n:
        raise ValueError(f"n must be >= {min_n} to fit the fixed fixture rows")

    rng = random.Random(42)
    rows: list[Row] = []
    for i in range(n):
        if i == BUNDLE_COLLECTION_INDEX:
            rows.append(_make_collection_row(rng, i))
            continue
        if i in BUNDLE_ROW_INDICES:
            rows.append(
                _make_row(rng, i, collection=BUNDLE_COLLECTION_ID, row_type="feature")
            )
            continue
        item = (
            _make_row(
                rng,
                i,
                topic="Radverkehrsnetz",
                region="Dresden",
                license_id="CC-BY-4.0",
                category="transportation",
                language="de",
            )
            if i == 0
            else _make_row(rng, i)
        )
        # One Collection per layer, as the harvester publishes it. `ORPHAN_INDEX`
        # keeps exactly one collection-less Item, because STAC permits it and the
        # assembler has a branch for it (no `collection`/`parent` links, and a
        # self link under `/items/`).
        if i == ORPHAN_INDEX:
            rows.append(item)
            continue
        dataset = _dataset_collection_for(item)
        rows.append(replace(item, collection=dataset.id))
        rows.append(dataset)
    return rows


def _write_published(
    con: duckdb.DuckDBPyConnection,
    rows: list[Row],
    members: dict[str, list[list[float]]],
    items_path: Path,
    collections_path: Path,
) -> None:
    """Write published-shaped stac-geoparquet, the way the bucket has it.

    Item ``properties`` are hoisted to top-level columns and ``assets``/
    ``links``/``themes`` stay real nested types -- verified against the real
    ``items.parquet``. Built through ``read_json_auto`` so DuckDB infers those
    shapes rather than this fixture asserting them by hand.
    """
    structural = {
        "id",
        "stac_version",
        "stac_extensions",
        "collection",
        "bbox",
        "assets",
        "links",
    }
    stamps = ("datetime", "created", "updated")

    def norm(key: str, value: Any) -> Any:
        """``2026-01-02Z`` -> ``2026-01-02T00:00:00Z``.

        The documents carry date-with-Z values, matching the harvester's JSON
        tree; the published *parquet* types those columns as real timestamps,
        so this reproduces the file the converter actually reads.
        """
        if key in stamps and isinstance(value, str) and len(value) == 11:
            return f"{value[:-1]}T00:00:00Z"
        return value

    def hoist(row: Row) -> dict[str, Any]:
        doc = build_document(row, members.get(row.id))
        if doc.get("type") == "Collection":
            out = {k: norm(k, v) for k, v in doc.items() if k != "type"}
            at = row.idx % len(_TOPIC_TIERS)
            out["goat:topicRelevance"] = _TOPIC_TIERS[at]
            out["goat:topicRelevanceScore"] = 7 - at * 2
        else:
            out = {k: v for k, v in doc.items() if k in structural}
            bbox = doc.get("bbox")
            if bbox:
                out["bbox"] = {
                    "xmin": bbox[0],
                    "ymin": bbox[1],
                    "xmax": bbox[2],
                    "ymax": bbox[3],
                }
            out.update({k: norm(k, v) for k, v in doc.get("properties", {}).items()})
            # The real published items carry these two as columns even when the
            # JSON tree omits them (verified against the bucket), so the fixture
            # has to as well -- otherwise the language and geographical-code
            # facets silently disappear from every test.
            out["language"] = {"code": row.language}
            out.setdefault("goat:geographical_code", "DE")
            # The published *columns* exist even where the JSON tree omits the
            # property -- verified against the bucket, whose items.parquet
            # carries `created`/`updated`/`license` for every row. Leaving them
            # out made half the corpus unsortable by `updated` and left
            # `license` null on every item outside a collection.
            out["created"] = norm("created", row.created.strftime("%Y-%m-%dT%H:%M:%SZ"))
            out["updated"] = norm("updated", row.updated.strftime("%Y-%m-%dT%H:%M:%SZ"))
            out["license"] = row.license
        if row.geometry_wkt and doc.get("type") != "Collection":
            out["__geom"] = json.dumps(row.geometry_geojson)
        return out

    for path_out, wanted in ((items_path, False), (collections_path, True)):
        subset = [r for r in rows if (r.type == "collection") is wanted]
        name = "published_collections" if wanted else "published_items"
        nd = path_out.with_suffix(".ndjson")
        nd.write_text(
            "\n".join(json.dumps(hoist(r), ensure_ascii=False) for r in subset)
        )
        con.execute(
            f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM read_json_auto('{nd.as_posix()}')"
        )
        cols = [r[0] for r in con.execute(f"DESCRIBE {name}").fetchall()]
        stamps = ("datetime", "created", "updated")
        geometry = "ST_GeomFromGeoJSON(__geom) AS geometry," if "__geom" in cols else ""
        kept = [f'"{c}"' for c in cols if c not in stamps and c != "__geom"]
        casts = [f'"{c}"::TIMESTAMPTZ AS "{c}"' for c in cols if c in stamps]
        con.execute(
            f"COPY (SELECT {geometry} {', '.join(kept + casts)} FROM {name}) "
            f"TO '{path_out.as_posix()}' (FORMAT PARQUET)"
        )
        nd.unlink()


def write_catalog(
    path: Path,
    n: int = 200,
    version: str = "v-test-1",
    extra_rows: list[Row] | None = None,
) -> None:
    """Write the two mirror files and the ``VERSION`` marker into ``path``.

    Deterministic for a given ``n`` (seed 42): row 0 and the bundle rows
    (collection ``src-1`` + its 4 members) are pinned; all other rows are
    filled from the same seeded RNG stream, so two calls with the same
    ``n`` produce byte-identical row content.

    ``extra_rows`` appends hand-built rows to the generated ones. A test that
    needs a specific row (a ranking competitor, say) must go through here
    rather than inserting into the loaded store: the catalog is served as a
    *view* over this file, so there is no table to insert into, and the derived
    columns (``search_text``, bundle membership) are computed by this writer.
    """
    path.mkdir(parents=True, exist_ok=True)
    rows = _build_rows(n)
    if extra_rows:
        rows = [*rows, *extra_rows]
    # Member bboxes per collection id, so each Collection document's spatial
    # extent covers the items that claim it (see _build_collection_document).
    members: dict[str, list[list[float]]] = {}
    for row in rows:
        if row.collection:
            members.setdefault(row.collection, []).append(
                _bbox_from_geojson(row.geometry_geojson)
            )

    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(
            """
            CREATE TABLE gen (
                id VARCHAR,
                collection VARCHAR,
                type VARCHAR,
                geom_type VARCHAR,
                title VARCHAR,
                description VARCHAR,
                license VARCHAR,
                category VARCHAR,
                language VARCHAR,
                publisher VARCHAR,
                wkt VARCHAR,
                document VARCHAR,
                datetime TIMESTAMPTZ,
                created TIMESTAMPTZ,
                updated TIMESTAMPTZ,
                version VARCHAR,
                parquet_url VARCHAR
            )
            """
        )
        con.executemany(
            """
            INSERT INTO gen VALUES
                (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            [
                (
                    row.id,
                    row.collection,
                    row.type,
                    row.geom_type,
                    row.title,
                    row.description,
                    row.license,
                    row.category,
                    row.language,
                    row.publisher,
                    row.geometry_wkt,
                    json.dumps(
                        build_document(row, members.get(row.id)),
                        ensure_ascii=False,
                    ),
                    row.item_datetime,
                    row.created,
                    row.updated,
                    row.version,
                    row.parquet_url,
                )
                for row in rows
            ],
        )

        # The fixture is produced by the *real* converter, not a copy of its
        # SQL. An earlier hand-rolled version drifted from `build_mirror` (it
        # named the bundle envelope `group_bbox_*` where the converter emitted
        # `group_*`), and the suite stayed green while production 400'd -- the
        # fixture was testing a file the pipeline never produces.
        published_items = path / "published_items.parquet"
        published_collections = path / "published_collections.parquet"
        _write_published(con, rows, members, published_items, published_collections)
        build_mirror(
            published_items,
            published_collections,
            path / "mirror_items.parquet",
            path / "mirror_collections.parquet",
            con,
        )
        published_items.unlink()
        published_collections.unlink()
    finally:
        con.close()

    # VERSION marker written last: its presence signals a complete catalog.
    (path / "VERSION").write_text(version)


def write_nuts(
    path: Path,
    extra_regions: list[tuple[str, str, int, str, str]] | None = None,
) -> None:
    """Write a small deterministic ``nuts.parquet`` lookup into ``path``.

    ``extra_regions`` appends hand-built ``(nuts_id, nuts_name, level, country,
    wkt)`` rows. The generated regions are all rectangles, and a rectangle's
    envelope *is* its geometry, so they cannot tell an exact spatial test from a
    bounding-box one; a test that needs to must bring a concave shape.
    """
    path.mkdir(parents=True, exist_ok=True)
    rng = random.Random(42)

    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(
            """
            CREATE TABLE nuts_gen (
                nuts_id VARCHAR,
                nuts_name VARCHAR,
                level INTEGER,
                country VARCHAR,
                wkt VARCHAR
            )
            """
        )
        con.executemany(
            "INSERT INTO nuts_gen VALUES (?,?,?,?,?)",
            [
                *(
                    (nuts_id, nuts_name, level, country, _polygon(rng)[0])
                    for nuts_id, nuts_name, level, country in NUTS_REGIONS
                ),
                *(extra_regions or []),
            ],
        )

        nuts_path = (path / "nuts.parquet").as_posix()
        con.execute(
            f"""
            COPY (
                SELECT
                    nuts_id, nuts_name, level, country,
                    ST_GeomFromText(wkt) AS geometry
                FROM nuts_gen
                ORDER BY rowid
            ) TO '{nuts_path}' (FORMAT PARQUET)
            """
        )
    finally:
        con.close()
