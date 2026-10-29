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
| `style/` | GOAT Style, the layer style format: validation, conversion of today's styles, merge, defaults, JSON Schema |
| `raster/` | Raster files read and colored on the server: band formulas, the coloring a tile URL carries, coloring, reading COGs with rio-tiler, statistics for computed values (the `raster` extra) |
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

## GOAT Style (`style/`)

GOAT Style is the format of layer styles: one JSON document per style, written
by the style panel and the AI, compiled to MapLibre by the web app. This package
is its single validator; core, processes and the catalog import it, and it does
no IO except `dryrun` and `data` (the data description and statistics, read from
DuckDB by processes).

The format is specified in `docs/style-spec.md`; "spec N" in the code, tests and
READMEs means section N of that file.

- **Documents stay dicts.** The models in `style/models/` check structure and
  produce the JSON Schema (`style/data/goat-style.schema.json`, regenerated with
  `python -m goatlib.style.schema --write`, checked by a test). Nothing rebuilds
  a document from a model, so a stored style holds exactly what its author set;
  defaults belong to the compiler. For the same reason the models are strict
  about JSON types: `"0.5"` is not a number.
- **MapLibre's limits live in one table.** GOAT Style is its own format, not
  MapLibre's, but most settings compile to a MapLibre property and must stay
  inside what MapLibre accepts: its bounds (opacity 0 to 1, layer zooms 0 to 24)
  and its value forms (a property MapLibre does not take data-driven values for
  takes no attribute mapping and is set once per layer). Those limits are copied,
  per GOAT setting, into `style/data/maplibre_limits.json`, next to the MapLibre
  properties the setting compiles to and GOAT's own choices; the models read them
  through `limits.py`. The web's drift test
  (`apps/web/lib/style/__tests__/maplibre-limits.test.ts`) compares the table
  with the installed style spec, so a MapLibre upgrade that moves a limit fails
  there by name. A new MapLibre feature does not reach GOAT by itself: it is
  added deliberately, through the models, the editor and the compiler.
- **Three layers of checks**, each returning `Issue`s with a code, a level and a
  JSON pointer (list items addressed by their `id`): the models (`parse.py`),
  rules about the document as a whole (`check.py`), and rules against the data
  (`data_check.py`), which read a `DataContext` built by whoever can see the data.
  `validate.py` runs all three.
- **Styles before GOAT Style are version 0.** `convert_v0.py` turns them into
  documents and returns map state (`visibility`, `legend.collapsed`) and what it
  could not keep separately; it never raises, because the server never validated
  those styles. `upgrade.py` runs it for anything that still arrives in the old
  shape, and `migrate.py` holds what every place that stores such a style uses:
  `migrate_style` (convert, give ids, stamp the computed values with the data
  they belong to, fall back to the default style rather than fail; core's data
  migration and the import of older project archives) and `current` (any
  version to the current one with ids: a saved workflow result's remembered
  style, a catalog style asset, a 1.2 archive).
- **Merging** (`merge.py`) follows the save protocol: objects merge key by key,
  lists of items with ids merge item by item, every other list is one value, and
  values the server computes are never part of a diff. Items added without an id
  get one first (`ids.py`), and what one side removed stays removed. The browser
  runs the same rules; `tests/unit/style/fixtures/merge_cases.json` keeps the two
  equal.
- **Catalogues** (`style/data/palettes.json`, `icons.json`) are the palette and
  icon ids styles may use; palettes are published to the web and the AI from here.
- **Computed values** (`compute.py`): a style states the intent (a method and a
  count, a value form without a domain), `needed_stats` names the statistics it
  needs, whoever can read the data computes them, and `apply_computed` writes the
  results next to the intent with the data's fingerprint. `data.compute_into`
  does both over a DuckDB relation; processes' style check and the tools (for
  the layers they create) call it, so both compute alike. The server is the only place classes, colors and domains are
  computed, so the compiler, the legend and published maps never disagree;
  palette sampling and ranges live in `colors.py`, breaks in the shared
  `analysis.statistics` module. A recompute keeps what classes carry (by position
  for numeric classes, by value for categories); values the server wrote itself
  (`computed.generated`) follow the palette and range, values set by hand stay.
  Numeric classes keep open first and last classes and store the field's minimum
  and maximum as `computed.domain` (manual classes get only that), so labels can
  show the data's ends. A
  part with an error of its own is not computed, so a malformed style comes back
  as issues. `same_ignoring_stamps` lets a save tell a recompute with the same
  result from a change.
  A raster style's computed values are the same kind of statistics over the band
  (or band formula) as the field: its range as `render.computed.domain`, classes
  into `render.classify`, computed by `raster.stats` from an overview sample with
  the shared class breaks.

- **The data fingerprint** (`fingerprint.py`): computed values record the data
  they come from (`ducklake:<layer.data_snapshot>`, `catalog:<catalog_version>`,
  a raster file's `url:<hash of its address>`: core reads no file, so a file
  replaced under the same address is not noticed) and `is_stale` compares. `layer.data_snapshot` is moved by one Postgres
  statement, `advance_data_snapshots_sql`, which reads DuckLake's change log after
  a cursor; core runs it when a map loads (after `data_snapshots_pending_sql`,
  three index reads, says something is new), the maintenance task before it
  expires snapshots. No data writer has to remember to mark its layer, and a change that
  expired unseen makes every layer recompute once, which is safe. A tool that
  creates a layer writes the snapshot that wrote its table, the value the
  statement would set (it only ever raises the column), so the layer's classes
  are not stale on its first load.
- **The map document from rows** (`map_rows.py`): the layer tree in order (groups
  and layers share one `order` per parent, top first) with the map state of
  every entry. core's map request, publishing and data migration assemble it with
  `build_map_document`; the thumbnail task draws a project's `drawn_layers`.

## Raster files (`raster/`)

Raster layers are COG addresses read in place over HTTP: geoapi serves colored
tiles, elevation tiles, statistics and point values from them, processes computes
a raster style's values. Both install the `raster` extra (rio-tiler; rasterio's
wheel bundles its own GDAL, so neither image needs a system GDAL). core needs
none of it: `formula` and `token` import no raster stack, so validation runs in
core too.

- **One formula grammar** (`formula.py`): `b1`, `b2`, ... up to the file's band
  count, numbers, `+ - * /`, brackets, parsed into a small tree and evaluated with
  numpy, never `eval`. Validation (`style.data_check`) and evaluation use the same
  parser. Division by zero is no data.
- **The coloring travels in the tile URL** (`token.py`): the web resolves the
  style into a coloring (palette colors, class bounds and colors) and sends it as
  base64url JSON; the service needs no palette catalogue and no lookup, and the
  token is its own cache key. `tests/unit/raster/fixtures/web_tokens.json` holds
  tokens the web wrote; both test suites read it.
- **Colors match the browser's of before the service** (`color.py`): a ramp is a
  256-color lookup, stops blend or take the nearest, classes are `[from, to)`,
  categories match the rounded value; no data (the file's, with float32 rounding,
  NaN, the style's values) is transparent.
- **Only checked addresses open** (`source.py`): http(s) hosts that resolve to
  public addresses or are listed by the service (`private_hosts`); redirects
  answered to a HEAD request are followed hop by hop with the same check
  (`io/remote_source/url_guard.py`, shared with WFS imports), the result kept ten
  minutes. GDAL resolves the name again and follows redirects a server sends only
  to its reads: the residual `url_guard` names, so deployments also restrict the
  services' outgoing traffic. A file that does not answer fails within seconds
  (no retries, a stalled transfer cut after five seconds) and then fails at once
  for 30 seconds. A read that would decimate the coarsest overview more than 8x
  is skipped, so a COG without overviews is never downloaded whole.

## Styles of the layers goatlib creates

Tools, bundles, catalog promotion, workflow results and project imports write
style rows themselves, through `tools/style_rows.py`: the dataset's default style
and a project layer's first named style, "Default", copied from it and active
(core's add paths write the same rows with their own driver). They store only
documents goatlib built or upgraded:

- **Tool looks** are documents from `tools/style.py` (`classified`,
  `categories`, the bundle role symbols, ...). A tool returns its look from
  `BaseToolRunner.get_layer_style`; the runner fills the classes from the result
  (`computed_style`) and stamps them with the new table's snapshot. A workflow
  preview has no layer: its result and the preview's metadata file carry the
  document as `style`, stamped `temp`, and saving the result computes it again.
- **Catalog items** promote with their published style asset upgraded for the
  item's geometry (`catalog/item.py`, shared with the catalog service's asset
  route), stamped `catalog:<version>`, else the default style.
- **Project archives** (format 1.2) carry every layer's default style, every
  project layer's named styles with the active one, the map state of layers and
  groups, and the uploaded icons the styles name (`asset:<id>`, remapped to the
  imported assets); archives before 1.2 carry `properties`, which the import
  converts.
## GTFS bundles are stored typed

A GTFS bundle keeps one member layer per file of the feed, every column as
published. The fields the GTFS reference types are stored as those types —
times as `INTERVAL` (GTFS times run past midnight, `25:10:00`, which a `TIME`
cannot hold), dates as `DATE`, coordinates and distances as `DOUBLE`, enums
and counts as `INTEGER` — and everything else stays text: ids (so `007` keeps
its zeros), names, colours, unknown and vendor columns, and whole files the
schema does not describe (fares, pathways, Flex).

The one declaration is `bundles/importers/pt_network/gtfs_schema.py`: the
import parses with it, the timetable write-back (`_write_feed_from_layers`)
turns values back into GTFS text with it, and the `gtfs_typed_storage` task
converted the bundles imported before typing with it. Parsing is stricter
than DuckDB's own casts (no `1.0` as an integer, no negative time). A value
that does not parse fails the file when the reference requires the field —
the import is refused for a file the feed cannot do without, an optional file
is skipped — and is dropped and logged otherwise. Code reading GTFS layers
should not assume either storage until every bundle has been converted;
`analysis/accessibility/base.py` compares dates and enums as text for that
reason.

Shapes are optional in GTFS, and many feeds have none or have them for some
trips only. The derived `shape_lines` member draws the feed's shapes and, for
every trip without a usable one, a line through its stops
(`bundles/importers/pt_network/stop_chains.py`), named after the stops so the
Explorer's snapshot gives those trips the same line as their shape. Like any
derived member it is never written back to the feed.

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
