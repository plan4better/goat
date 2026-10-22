# goatlib

Shared Python library for the GOAT platform. It contains the analytics tools,
analysis algorithms, geospatial I/O, and shared models used by the `core`,
`geoapi`, `processes`, and `catalog` services.

## Package layout

| Module | Purpose |
|--------|---------|
| `tools/` | Analytics tools (buffer, clip, catchment areas, heatmaps, …). Each tool is a `BaseToolRunner[TParams]` subclass, registered in `tools/registry.py` and executed as a Windmill job. |
| `analysis/` | Analysis algorithms backing the tools |
| `io/` | Dataset import/export, format conversion, and remote sources (WFS, …) |
| `models/` | Pydantic models shared across services |
| `services/`, `storage/`, `tasks/` | Service clients, object storage, background task helpers |
| `computed_columns/`, `i18n/`, `config/`, `utils/` | Supporting modules |

## Adding an analytics tool

1. Create the tool in `src/goatlib/tools/your_tool.py`:
   - inherit from `BaseToolRunner[YourToolParams]`
   - define the input parameters as a Pydantic model extending `ToolInputBase`
   - implement `process()` and set `tool_class`, `output_geometry_type`,
     `default_output_name`
2. Register it in `tools/registry.py`
3. Sync it to Windmill with `tools/sync_windmill.py`

Tools run with service credentials and never check the caller themselves:
the `processes` service checks every layer, project, folder and bundle a
request names before it submits the job (`apps/processes/README.md`). A new
input that names a layer needs `widget="layer-selector"` or an entry in that
check. SQL a user writes goes through `validate_sql_query` /
`validate_sql_expression` in `utils/sql_validation.py`, which allow the declared
input aliases only.

## Token verification

core, geoapi, processes and catalog verify Keycloak tokens with one class,
`KeycloakAuth` in `auth.py`, so a token is accepted or refused the same way by
every API. It checks the signature against the realm's public key, fetched on
first use so a service can start before Keycloak is up.

A realm can serve other applications too, and each of their clients can get a
token signed with the same key. `AUTH_ALLOWED_CLIENTS` (comma-separated client
IDs) limits the services to tokens issued to those clients, read from the
token's `azp`. Keycloak always sets `azp` to the client that requested the
token, while `aud` holds only what audience mappers and client roles add (by
default just `account`), so checking the audience would need every operator to
configure their realm first. A refused token raises `JOSEError` like any other
invalid token, so every service answers `401` without code of its own; the
caller sees a generic "Invalid authorized party", and the refused client is
logged. Empty accepts every client; with `AUTH=False` tokens are not verified
at all. A list must include GOAT's own client, or nobody can use GOAT:
`require_own_client_allowed` refuses that at startup, in core, the service
that knows `KEYCLOAK_CLIENT_ID`.

## Field config and generated fields

A layer's `field_config` (in core's `customer.layer`) says what each column
means beyond its storage type: its kind, vocabulary, default, formatting or
formula. Two writers produce entries — geoapi when a column is added, and the
`layer_create` tool when a layer is declared with its columns — so the rules for
an entry live here, in `utils/field_config.py` and `utils/generated_fields.py`.

The generated kinds, `serial` (a running number, BIGINT) and `uuid` (UUID v4 as
text), are filled by whoever inserts a row, never by the user. Their settings
sit flat in the entry next to `kind` (`{"kind": "serial", "start": 1}`), so
later variants — a display `format` such as `V-{0000}`, a yearly `reset`, a
UUID `version` — are further settings, not a migration. Those variants are not
implemented yet; the module docstring describes how each would fit.

A serial number is never handed out twice: the writer counts from the larger of
the table's maximum and the column's high-water mark (core's
`layer_serial_counter`, read and advanced under the per-layer lock in
`goatlib.utils.layer_lock`: by geoapi's feature writes, and by `finalize_layer`
when a workflow's "Save as dataset" adds rows to an existing dataset, which
follows the same field rules as a hand edit (`goatlib.utils.field_config`).
`layer_create_filtered` copies the source's marks along with its
`field_config`; a copy made any other way (project export and import) has no
mark and continues from its own highest number.

## Copies behind a project entry

Two tools replace the layer a `layer_project` entry shows instead of adding a
new entry: a workflow re-run that must not change a copied project
(`tools/workflow_export_target.py`), and `layer_copy`, which gives a template
user their own editable copy of a dataset (`tools/layer_copy.py`). Keeping the
entry is the point: dashboards, layouts, filters and workflow dataset nodes
name the entry (`layer_project_id`), so they follow the swap without being
rewritten; only the nodes' saved `layerId` is retargeted
(`tools/workflow_dataset_nodes.py`). Nodes saved with a `layerId` but no
entry (common in older projects) are retargeted by layer, and given the entry,
but only while no other entry of the project still shows the old layer: such a
node could mean that one. `layer_copy` copies DuckLake table to
table rather than through parquet, so an empty copy keeps its GEOMETRY column
(DuckDB writes no GeoParquet metadata for an empty table); it is idempotent
(an advisory lock per project and source, and a `template_copy` stamp on the
copy and its entries), and a failed run leaves the entries on the source.

## Tables of failed runs

A run writes a new layer's DuckLake table before it saves the layer record, so
a run that fails in between would leave a table nothing points to. The `run`
of every runner that writes layer tables is wrapped in `drops_unrecorded_tables`
(`tools/base.py`): on failure it drops the tables the run created, but only
those Postgres confirms no layer row points to. A row committed before the
failure keeps its table; so does every table when Postgres cannot be asked, or
when the run failed on a lost connection or an interrupt, after which a record
may still turn up. A table is only tracked once the run itself created it, so
a failed update or overwrite never touches an existing layer's table. A
cancelled Windmill job is killed without a SIGTERM first, so nothing in the
run can clean up after it; the `ducklake_orphan_tables` task reports the
tables left behind and, when asked to, drops those older than a day.

## DuckLake catalog connections

Every DuckLake read runs a few catalog queries inside a Postgres transaction,
and DuckDB keeps that transaction open until the query's result has been read
to the end. The managers in `storage/ducklake.py` read their own results fully
and close whatever a caller left unread when a connection goes back to its
lock or pool (`release_result`); otherwise the session stays `idle in
transaction` and holds back vacuum for as long as the connection lives.
Connections no manager takes back, such as a tool run's own, read single rows
with `fetch_one`, which closes the result the same way.

DuckDB also caches catalog connections per attach, by default a multiple of
the host's cores, so every attach caps them (`cap_catalog_connections`).
Service connections cap at what one query can use at once, one per DuckDB
thread plus one; a lower cap makes DuckDB reconnect for every first read of a
table. Tool runs, which read few tables, keep a small fixed number, and
attaches that run one small query at a time (the snapshot poll) keep one.

DuckDB spills to disk only at its own `memory_limit`, and a connection without
one takes 80% of the container. A job's connections therefore take shares of
the container's memory limit (`goatlib.utils.container_memory`): half for its
work connection (an analysis, or a tool's own DuckDB), a quarter for the
runner's DuckLake connection.

Sessions carry an `application_name` (`goat-geoapi-ducklake`, `goat-tools`,
…) so operators can tell them apart in `pg_stat_activity`.

No attach puts a password into its connection string:
`goatlib.utils.credentials.postgres_attach_target` moves it into the DuckDB
connection's Postgres secret, which every Postgres connection of that DuckDB
connection uses, and hands back the rest as a libpq string, the only form
DuckDB merges the secret into. One DuckDB connection therefore holds one
Postgres password. Error text that processes or a workflow run hands on goes
through `redact_credentials`. Postgres URIs are built with `postgres_uri`,
which percent-encodes the user, password and database, and libpq strings quote
their values, so a password may hold any character.

Behind a connection pooler in transaction mode (`POSTGRES_TRANSACTION_POOLER`)
each query may run on another server connection, and a pooler with stock
settings neither tracks prepared statements nor passes on startup parameters it
doesn't know. `goatlib.config.postgres.asyncpg_connect_args` then turns off
asyncpg's statement cache and the keepalive settings; every tool and task
connection goes through it (`ToolSettings.postgres_connect_args`). DuckLake's
catalog connections go to the database itself (`DUCKLAKE_POSTGRES_SERVER`).

## Development

The repo is a uv workspace — sync everything from the repo root:

```bash
uv sync --all-packages
```

Run the tests from this directory:

```bash
uv run pytest tests/unit         # unit tests (run in CI, advisory)
uv run pytest tests/integration  # needs local infra (DB, Garage, …)
```

## GDAL dependency

`goatlib` depends on the `gdal` Python bindings, which are distributed as an
sdist and compile against the system GDAL library — `libgdal-dev` (apt) or
equivalent must be installed to build them. Only the WFS and converter paths
in `io/` import `osgeo`, and they do so lazily, so the other services install
the workspace with `--no-install-package gdal` in CI and skip the system
dependency entirely.
