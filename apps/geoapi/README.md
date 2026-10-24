# GOAT GeoAPI

OGC API - Features and Tiles for GOAT layers, served from DuckLake with DuckDB.

## Overview

GeoAPI serves the **data** of a layer; core holds its metadata. It provides:

- **Features**: OGC API - Features with CQL2 filtering, sorting and paging (`/collections/{layerId}/items`).
- **Vector tiles**: OGC API - Tiles as MVT, from prebuilt PMTiles where they exist, generated on the fly otherwise.
- **Editing**: create, update and delete features and columns, and batch edits of a bundle's network layers.
- **Expressions**: validating and previewing computed-column expressions.
- **Download**: exporting a layer of a published project in common GIS formats.

The collection id is the layer UUID. The full, current route list is the OpenAPI document at `/api/docs`.

## Why a Separate Service?

Tiles and features are the latency-critical path every map view hits. Keeping them here, and long analytics in processes, means a heavy job never slows down map rendering.

## Storage Model

- Each layer is one DuckLake table, `t_<layer id without hyphens>`. New layers live in schema `main`; layers created before the flat layout stay in their old `user_<id>` schema and are found by an indexed lookup in DuckLake's own Postgres catalog.
- **Feature ids are `rowid + 1`**, because MapLibre treats an MVT feature id of 0 as "unset". The bundle editor keys on the layer's `id` column instead, since deletes within one batch would shift rowids.
- **Promoted catalog datasets** are not DuckLake tables: they are parquet files under `CATALOG_LAYERS_DIR`, exposed through an in-memory view that adds the same `rowid`. They are read-only.
- **PMTiles** live in `TILES_DATA_DIR` (user layers) and `CATALOG_TILES_DIR` (catalog layers). They are built outside geoapi, by goatlib tasks.
- **Workflow previews** are parquet and PMTiles files under `/app/data/temporary/user_<id>/…`, read with `?temp=true`.

## How It Stays Consistent

- **Reads are pinned to a DuckLake snapshot.** A background thread polls for new snapshots and swaps in a fresh, warmed connection off the request path. After a write, the pod also publishes on the Redis channel `ducklake:changed` so other pods refresh at once; the poll is the fallback when Redis is unavailable.
- **Every write deletes the layer's PMTiles**, so tiles fall back to dynamic generation until the scheduled Windmill task `rebuild_edited_pmtiles` rebuilds them once the layer has been idle for a while. Schema changes do not create a DuckLake snapshot, which is why the files are removed rather than trusted.
- **Generated columns are filled by the writer, never by the client.** A `serial` (running number) or `uuid` column, declared by `kind` in the layer's `field_config`, gets its value on every create path — single and batch creates, and the bundle editor's new and split edges — and a client's value for one is ignored. An update that would change one is refused (400); sending the stored value back, as editors do, is fine. A serial number is never handed out twice: it is `max(high-water mark, max(existing), start - 1) + 1`, where the high-water mark is the highest number the column ever handed out, kept in core's `customer.layer_serial_counter` — so deleting the feature with the highest number does not free it. Adding such a column to a layer with rows backfills them once, in `rowid` order, and sets the mark; dropping the column forgets the mark and renaming moves it, so a column re-added under the same name starts over. A layer without a mark (an import, or before core's migration ran) continues from its own highest number. The rules live in goatlib (`goatlib.utils.generated_fields`; defaults, allowed values and computed columns in `goatlib.utils.field_config`), so a workflow adding rows to an existing dataset fills them the same way.
- **An existing number column can become a serial** (`PATCH …/columns/{name}` with `kind: "serial"`), keeping its name and values: Bonn-style hand-typed project numbers that workflows already reference. It is refused, with the offending values named, for duplicates or fractions; blank rows get numbers after the highest; the mark starts at the highest value, so gaps are never filled. A non-BIGINT column is rebuilt as BIGINT under the same name (moving to the end of the column order) rather than `ALTER … SET DATA TYPE`d: after an in-place INTEGER→BIGINT promotion, `max()` fails on a connection that had read the column's statistics. `kind: "number"` turns a serial back and drops its mark. Columns of a bundle member cannot be converted, and nothing converts to `uuid`.
- **Serial numbers are assigned under a per-layer Postgres advisory lock** (`services/layer_write_lock.py`; its key is defined once in `goatlib.utils.layer_lock`, so goatlib's `finalize_layer` takes the same lock when a workflow's "Save as dataset" adds rows to an existing dataset). The write manager's `threading.Lock` serializes writes within a pod only, and DuckLake commits two concurrent appends to one table without a conflict, so two pods reading the same `max` would hand out the same number. The lock is transaction-scoped (`pg_advisory_xact_lock`), so a pod that dies releases it. Every feature create, update and replace takes it and reads `field_config` under it (one extra round trip), because any number column can become a serial at any moment and a write that read the old definition must not slip a typed-in duplicate past the conversion; the bundle editor and the add-column backfill take it only for serial columns. The high-water mark is read and advanced in that same transaction, after the DuckLake rows are in: a failed write leaves it alone, and if storing it fails after DuckLake committed, the rows still carry the numbers, so `max` covers them. UUIDs need no lock.
- **Bundle edits are optimistic.** The client sends the bundle revision it edited; a stale revision answers 409. The edges and nodes layers are written in one DuckLake transaction, then a `bundle_artifact_rebuild` job is sent to processes (`GOAT_PROCESSES_URL`).
- **Caches**: layer metadata and PMTiles-served tiles are cached in Redis; dynamic tiles and feature responses use ETags derived from the layer version and the pinned snapshot instead. Without Redis everything still works, only slower.

## Access Rules

- A layer of a published project is readable by anyone. Otherwise `customer.can('layer', …, 'read')` in core's database decides. **Read authorization runs in shadow mode by default** (`GEOAPI_ENFORCE_READ_AUTHZ=false`, also read as `ENFORCE_READ_AUTHZ`, the name the Helm chart sets): a denial is only logged as `read_authz.would_deny`, and the layer is served anyway.
- Writes need a user and pass `customer.layer_write_allowed`. Features of a bundle member layer are edited through the bundle routes, though columns may still be added to it; catalog layers cannot be edited.
- Download needs no token but only works for layers of a published project.
- A token must verify, and with `AUTH_ALLOWED_CLIENTS` set it must be issued to one of those clients (goatlib's `KeycloakAuth`). A token that fails is a 401 where a user is required; where a token is optional, the request runs as anonymous.
- With `AUTH=False`, requests without a token run as the built-in development user.

## Gotchas

- **Settings use the `GEOAPI_` prefix.** A bare name works only for the settings that read it explicitly (for example `AUTH`, `AUTH_ALLOWED_CLIENTS`, `KEYCLOAK_SERVER_URL`, `POSTGRES_*`, `DUCKLAKE_DATA_DIR`, `DUCKLAKE_PIN_SNAPSHOT`, `REDIS_URL`, `GOAT_PROCESSES_URL`, `ENFORCE_READ_AUTHZ`); everything else, such as `DUCKLAKE_POOL_SIZE` or the timeouts, must be set as `GEOAPI_<NAME>`. All settings are in `src/geoapi/config.py`.
- Point `DUCKLAKE_POSTGRES_SERVER` (and `DUCKLAKE_POSTGRES_PORT` when it differs) at Postgres directly, not through a transaction pooler: DuckLake attaches keep their catalog connections for as long as they live and are not verified behind one.
- When `POSTGRES_SERVER` is a pooler in transaction mode, set `POSTGRES_TRANSACTION_POOLER`: the query pool then caches no prepared statements and sends no TCP keepalive settings, which a pooler with stock settings refuses at connect.
- DuckDB's memory budget per pod is `GEOAPI_DUCKDB_MEMORY_LIMIT × (GEOAPI_DUCKLAKE_POOL_SIZE + 2)`: pooled cursors share one DuckDB instance budgeted for the whole pool, and the read and write connections get one budget each. Keep it under the container's memory limit with room for the catalog metadata each connection keeps outside that budget; DuckDB spills only at its own budget, so above the limit the pod is killed first. Keep `GEOAPI_DUCKDB_THREADS × GEOAPI_DUCKLAKE_POOL_SIZE` at about the container's CPUs.
- Updating a row inserted in the same DuckLake transaction leaves it with a transaction-local rowid that breaks MVT feature ids; `bundle_edit_service.py` writes derived columns in the insert itself for that reason.
- Never enumerate all DuckLake tables (`information_schema`, `SHOW TABLES`) on a request path: it loads every table's metadata, which takes very long on a large catalog.

## Development

Load the repo's root `.env` and run on port 8100, which is what the web app expects:

```bash
set -a && . ./.env && set +a          # from the repo root
cd apps/geoapi
uv run fastapi dev src/geoapi/main.py --port 8100

uv run pytest tests/                  # mocked, needs no services
uv run pytest tests/integration -m integration   # needs Postgres with the customer schema
```

At runtime it needs Postgres (core's `customer` schema and the DuckLake catalog), the shared data volume, and optionally Redis. The Docker image runs `fastapi run` on port 8000 with the DuckDB extensions and `tippecanoe-overzoom` baked in.
