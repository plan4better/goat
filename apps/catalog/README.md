# GOAT Catalog API

STAC API implementation for the GOAT data catalog.

## Overview

This service serves the harvested GOAT data catalog as a [STAC API](https://stacspec.org/) (v1.0.0: Core, Collections, OGC API - Features, Item Search; extensions: Filter/CQL2, Free-text, Sort, Collection Search, Aggregation), plus GOAT-specific helpers.

It is **database-less by design**. The whole catalog lives in four files under `${DATA_DIR}/catalog`:

| File | Contents |
|------|----------|
| `mirror_items.parquet` | One row per STAC Item |
| `mirror_collections.parquet` | One row per Collection |
| `nuts.parquet` | NUTS regions, for the spatial-filter region search |
| `VERSION` | Marker identifying the loaded generation |

The two mirror files are maintained by the goatlib `sync_catalog` task (S3 → local, ETag-gated, atomic swap with `VERSION` written last); `nuts.parquet` has its own producer, `sync_nuts` (built from Eurostat). The service watches the files and reloads automatically when they change, without interrupting in-flight requests.

Items and collections are exposed as DuckDB **views** over the parquet files rather than resident tables, so a query reads only the columns it projects and a file swap costs no extra copy of the data. There is no full-text index — free-text search scans the mirror's precomputed `search_text` column. NUTS is small, so it is materialized as a table.

## Why a Separate Service?

Same rationale as the geoapi/processes split: catalog browse/search traffic must never contend with the latency-critical tile path. Because the service needs no database and no object storage at request time, it scales by simply running more replicas against the same read-only files.

## Design Decisions

- **Discovery is public, data stays inside GOAT.** Anyone may browse and search the metadata, so the catalog page can be embedded on a public website. GOAT never redistributes the harvested files: served items never reference GOAT's own GeoParquet copy. That location stays in the mirror's `parquet_url` column, which only the preview and promotion read, and `stac_build` drops every asset whose href is not an absolute http(s) URL. Org-restricted entries must never enter the public catalog file; that is what makes anonymous serving safe.
- **No database.** The mirror is a pair of local stac-geoparquet files queried by DuckDB, not a Postgres table. The service holds no connection pool and adds no pressure on the pooler, and the expected scale (up to around 100k items) fits DuckDB over parquet comfortably. Promotion state lives on core's `customer.layer`, so the mirror holds no GOAT state and can be rebuilt from the bucket at any time.
- **A fully compliant STAC API**, not a private API behind a compliance layer, so external STAC tools (QGIS, pystac-client, stac-browser) work against it unchanged.
- **Slim serving dependencies.** FastAPI and DuckDB; no asyncpg and no DuckLake. From goatlib it uses the small CQL2 evaluator. The service is named `catalog`, not `stac`, because it also serves NUTS regions.
- **Promote-on-use with snapshot semantics** (implemented in core). Adding a catalog item to a project materializes it once into a shared, read-only `customer.layer` row, identified by `(catalog_external_uid, catalog_version)`. The partial unique index `uq_layer_catalog_identity` decides between concurrent promotes of the same version. Projects keep the version they added; moving to a newer version is a user action. Promotion reads the data from the catalog bucket, never from the original provider.

## Harvester Contract

The harvesting pipeline publishes to the catalog bucket and GOAT consumes it. What GOAT relies on:

- **Two files at the bucket root**: `items.parquet` (one row per STAC Item) and `collections.parquet` (one row per Collection), following the stac-geoparquet convention: `properties.*` hoisted to top-level columns, `bbox` as a struct, `geometry` as WKB. GOAT reads only these two files; the static JSON tree next to them is for external STAC tools and is never walked.
- **Data and assets under fixed prefixes**: `data/<id>.parquet` for the layer data, `styles/` for rendering styles, `thumbs/` for thumbnails.
- **Change detection is the S3 ETag** of both files; the mirror's version marker is a hash of the two. A byte-identical rewrite must keep its ETag, or every sync rebuilds the mirror for nothing.
- **Deletion means absence.** The mirror is rebuilt wholesale on every change, so an item that disappears from the file is gone from browse. Layers already promoted into projects keep working.
- **Adding a column is free**: it is served and becomes searchable with no GOAT code change. **Renaming or removing a column is a breaking change** that needs coordinating with GOAT first.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /stac` | Landing page (Catalog + `conformsTo`) |
| `GET /stac/conformance` | Conformance classes |
| `GET /stac/queryables` · `GET /stac/collections/{cid}/queryables` | CQL2 filterable properties; `?unit=collections` (GOAT extension) lists what Collection Search can filter and sort by |
| `GET /stac/collections` | Dataset collections (Collection Search params) |
| `GET /stac/collections/{cid}` · `/items` · `/items/{itemId}` | Collection browse (OGC API - Features) |
| `GET`/`POST /stac/search` | Item Search (bbox, intersects, ids, datetime, CQL2 `filter`, free-text `q`, `sortby`, facet params) |
| `GET /stac/aggregations` · `GET /stac/aggregate` | Aggregation extension (facet discovery + counts) |
| `GET /stac/resolve/{id}` · `GET /stac/items/{id}` | GOAT extensions: id resolution / collection-agnostic item lookup |
| `GET /stac/suggest?prefix=` | GOAT extension: titles containing a word that starts with `prefix` (a term probe for the assistant's catalog tools) |
| `GET /stac/items/{id}/preview` | GOAT extension: bounded GeoJSON sample of an item's data |
| `GET /stac/nuts` · `GET /stac/nuts/{id}/geometry` | NUTS region typeahead + boundary (spatial-filter UI) |
| `GET /healthz` | Liveness + loaded catalog version and item/collection counts |
| `GET /api/docs` · `/api/redoc` · `/api/openapi.json` | Interactive API docs + OpenAPI schema (same layout as geoapi/processes) |

The MCP endpoint that used to live here is served by the assistant service (`apps/assistant`, `/assistant/mcp` behind the gateway).

`GET /stac` responses carry an `ETag` and a short `Cache-Control`, so conditional requests answer `304` while a generation is unchanged.

Auth follows the repo-wide `AUTH` switch (JWT via Keycloak when enabled). `/stac` reads are **public**: no credentials means anonymous, but an invalid or expired token is a `401` rather than a silent downgrade. With `AUTH_ALLOWED_CLIENTS` set, a token issued to any other client of the realm counts as invalid, so it gets the same `401` as any invalid token, on the public reads too.

## Running Locally

```bash
# Needs a catalog mirror. Generate a synthetic one for development:
cd apps/catalog
uv run python -c "
from pathlib import Path; import sys; sys.path.insert(0, 'tests')
from fixtures.gen_catalog import write_catalog, write_nuts
d = Path('/tmp/goat-catalog-dev/catalog'); d.mkdir(parents=True, exist_ok=True)
write_catalog(d, n=1000); write_nuts(d)"

DATA_DIR=/tmp/goat-catalog-dev AUTH=False uv run uvicorn catalog.main:app --reload --port 8400
curl localhost:8400/stac | jq .

# Tests
uv run pytest tests/
```

## Configuration

Env prefix `CATALOG_`; shared values (`AUTH`, `DATA_DIR`, `KEYCLOAK_SERVER_URL`, `REALM_NAME`, `CORS_ORIGINS`, `S3_*`) are read from their repo-wide names with `CATALOG_`-prefixed overrides. Notable settings:

- `CATALOG_DUCKDB_TEMP_DIR` (spill target — keeps a heavy concurrent moment a slow query instead of an out-of-memory error), plus optional `CATALOG_DUCKDB_MEMORY_LIMIT` / `CATALOG_DUCKDB_THREADS` to keep peak usage under a container limit.
- `/assets/{item_id}/thumbnail|style` serves a dataset's picture and its rendering style out of the private bucket -- nothing else, since the GeoParquet has no route and the object key is resolved from the item's own published href rather than from the request. Together with previews these are the only routes that read remotely, and they need a bucket plus credentials — `CATALOG_S3_BUCKET`/`_ENDPOINT_URL`/`_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`/`_REGION`, each falling back to the shared `S3_*`. Without them `/stac/items/{id}/preview` returns 404 (which is what a `404 …/preview` in the browser console means). `CATALOG_PREVIEW_CACHE_DIR` is unset by default (no server-side cache — clients cache on the ETag instead).
- `CORS_ORIGINS` defaults to the GOAT web app's own origin rather than `*`. This only constrains browsers; QGIS, pystac-client and other STAC tooling are unaffected.
