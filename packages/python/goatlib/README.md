# goatlib

Shared Python library for the GOAT platform. It contains the analytics tools,
analysis algorithms, geospatial I/O, and shared models used by the `core`,
`geoapi`, `processes`, and `catalog` services.

## Package layout

| Module | Purpose |
|--------|---------|
| `tools/` | Analytics tools (buffer, clip, catchment areas, heatmaps, …). Each tool is a `BaseToolRunner[TParams]` subclass, registered in `tools/registry.py` and executed as a Windmill job. |
| `analysis/` | Analysis algorithms backing the tools |
| `io/` | Dataset import/export, format conversion, remote sources (WFS, …), and the readers for GOAT's base data: the OpenStreetMap/Overture mirror, the street network and the public transport network (`io/fetch/`) |
| `models/` | Pydantic models shared across services |
| `style/` | GOAT Style, the layer style format: validation, conversion of today's styles, merge, defaults, JSON Schema, the edit operations and one-line summaries the AI uses |
| `filter/` | Layer filters (CQL2-JSON): the spellings the services read, the checker, the limits, the filter panel's rows and areas |
| `raster/` | Raster files read on the server: band formulas, value tiles the browser colors (`values.py`), the coloring an image tile's URL carries and coloring those tiles, reading COGs with rio-tiler, statistics for computed values (the `raster` extra) |
| `services/`, `storage/`, `tasks/` | Service clients, object storage, background task helpers |
| `workflows/` | Workflow code that needs no analytics dependencies: the shape check core runs on save, the graph helpers and settings-visibility rules the full check in processes builds on, and the operations the assistant edits a stored workflow with |
| `computed_columns/`, `i18n/`, `config/`, `utils/` | Supporting modules |

## Adding an analytics tool

1. Create the tool in `src/goatlib/tools/your_tool.py`:
   - inherit from `BaseToolRunner[YourToolParams]`
   - define the input parameters as a Pydantic model extending `ToolInputBase`
   - implement `process()` and set `tool_class`, `output_geometry_type`,
     `default_output_name`
2. Register it in `tools/registry.py`
3. Sync it to Windmill with `tools/sync_windmill.py`. Both syncs (tools and
   `tasks/sync_windmill.py`) write a script in place (`windmill_scripts.py`):
   a new version when it changed, nothing when it did not, never a delete,
   so the path always resolves to a script and Windmill keeps its version
   history. These scripts are managed from goatlib: a code change deploys a
   new version, which replaces per-script settings made in the Windmill UI
   (timeout, concurrency, environment variables).

Tools run with service credentials and never check the caller themselves:
the `processes` service checks every layer, project, folder and bundle a
request names before it submits the job (`apps/processes/README.md`). A new
input that names a layer needs `widget="layer-selector"` or an entry in that
check. SQL a user writes goes through `validate_sql_query` /
`validate_sql_expression` in `utils/sql_validation.py`, which allow the declared
input aliases only.

A workflow step is checked before it runs (`apps/processes/README.md`):
processes builds the step's arguments with the runner's own code
(`tools/workflow_arguments.py`) and hands them to the tool's parameter model,
so the message of a `model_validator` error is what people see on the step.
Write it for them.

A run built without the form (a workflow the assistant drafts, a template, an
API call) must behave like one built with it. The editor derives some settings
from others (x-ui `default_by_field`, `default_from`, `compute_from`,
`default_all`) and does not run while a setting it shows without a default is
empty, so each tool applies the same value itself, from the constant its widget
option is built from (the per-mode speeds are `DEFAULT_SPEED_KMH` in
`analysis/schemas/catchment_area_v2.py`), or refuses in its parameter model.
The generated Windmill script (`tools/codegen.py`) declares every optional
argument as None and drops the None ones, so a setting a job leaves out reaches
the model as absent: a default the model resolves from the job's other settings,
such as a travel budget per mode and cost type, applies. A static default in the
signature would reach the model as if the job had set it.

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
  `validate.py` runs all three. The message is English, for people and the AI
  alike. The issues the style panel words also carry `params`, the facts their
  message names, so the panel shows them in the user's language; for any other
  code it shows the message. A service reads another's issues with
  `read_issue`, which leaves out keys it does not know, so a newer sender never
  fails an older reader.
- **Versions are three numbers** (`style/version.py`, spec 14 and 21), one for
  layer styles and the map document. A written document gets the lowest
  version its keys need (`stamp`, which every writer calls: core's saves,
  `stored_document`, the map document): the keys of 1.0.0 (catalogue palettes and
  library icons count as keys) are listed in `style/data/keys-1.0.0.json`,
  later ones in `SINCE`, and a test fails for a schema key in neither, so a
  document that uses nothing newer stays readable by older servers. A newer major or minor is refused (`newer_version`), a
  newer patch only warns, and the integer 1 of earlier documents reads as 1.0.0.
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
  result from a change; computed numbers keep 12 significant digits (`stable`),
  because DuckDB sums in parallel and the last digits of a mean would otherwise
  differ between two runs over the same data.
  A raster style's computed values are the same kind of statistics over the band
  (or band formula) as the field: its range as `render.computed.domain`, classes
  into `render.classify`, computed by `raster.stats` from an overview sample with
  the shared class breaks.
- **A derived color is the word `"auto"` on a color key** (spec 18.10): the
  color follows another part's color, and for labels the basemap's tone. Which
  keys take it, by which rule and following what, is defined once, in the
  specification's table and in `style/data/color_keys.json`; a test walks the
  JSON Schema and fails for a color key the table does not name, so no key takes
  the word by accident. The rules themselves (a darker shade, a label's text and
  halo, the color that reads on a marker) exist once here in `style/colors.py`
  and once in the web, held equal by the shared fixture
  `tests/unit/style/fixtures/color_rules.json`. goatlib only validates the word:
  resolving it for the map, and knowing the basemap's tone, is the web
  compiler's, since only the map knows what it draws on. A key left out keeps
  its reference color, so a style that never says `"auto"` keeps its look. The
  AI's operations write the word on the key itself (`/symbol/outline/color`);
  `"auto"` sent as a whole part is refused (`style/edit.py`, below).

- **The data fingerprint** (`fingerprint.py`): computed values record the data
  they come from (`ducklake:<layer.data_snapshot>`; a promoted catalog layer's
  `catalog:<catalog_version>`, or `catalog:unversioned` for an item without a
  version, since a catalog layer's data is never in DuckLake; a raster file's `url:<hash of its address>`: core reads no file, so a file
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
- **3D is map state plus one layer part.** The map document's `view.mode`,
  `view.projection` and `scene` (terrain, basemap buildings, sky, fog, globe glow,
  light; `style/models/scene.py`) say how the map looks; heights stay in the layer
  style (the polygon part `extrude`, H3 `render.extrude`; spec 3.6, 8.3, 10.1,
  10.2). Every `scene` key is
  optional and a missing one is automatic, so documents from before 3D stay
  valid unchanged. What automatic means (`style/scene.py`: the auto table by basemap
  tone; a missing `fog` draws none and a missing `light` stands with the camera,
  and the web takes the horizon colour from the basemap's ground, spec 10.2) is
  goatlib's, published to the web in the JSON Schema's `x-scene-*` extras, so the
  compiler never holds its own copy. `validate_map`
  checks the scene against what only the caller knows, through `MapContext`:
  which layers draw heights and whether the deployment has terrain and building
  sources.
- **The AI edits a style with operations** (`style/edit.py`, spec 20):
  `apply_edits` applies a list of them (`set`, `remove`, `retarget`,
  `use_field`, `round`, `add`, `move`) in order, all or none, and a refusal
  names what exists, so the model's next call can be right; validating the
  result stays the server's check. A key set under a part that is `false`
  switches the part on, because models change a part key by key and rarely send
  it as one object.
- **A style in one line** (`style/summary.py`): `summarize` describes a
  document in plain words for the layer lists the AI reads, from the plain
  dict, so a damaged document gives a shorter line instead of an error.

## Layer filters (`filter/`)

A project layer's filter is saved in `layer_project.query.cql` as standard OGC
CQL2-JSON, and that stays its saved form: other applications that speak OGC API
Features can read and write it. The one GOAT-specific piece is a function in
CQL2's own call syntax, `daysAgo(n)` (`{"op": "daysAgo", "args": [n]}`), so a
CQL2 parser still reads the filter. What only the web's filter panel needs
(switched-off rows) is kept apart in `query.ui`; deleting it never changes which
features pass.

- **`normalize` sits in front of the parser.** pygeofilter follows an older CQL2
  draft in places, and older clients saved legacy spellings; `normalize.py`
  rewrites both to the one form the evaluator takes, and every place that parses
  a filter (geoapi, the catalog, the storage query builder, the tools, core's
  save check) calls it first. Its module docstring lists the rewrites.
- **"In the last N days" is resolved when the filter is read** (`days_ago` in
  `normalize.py`). The panel saves `daysAgo(n)`, not a date, so the filter
  keeps counting back from today on the map, in counts, the table, exports,
  tools and published projects alike; the date a save counted back to would
  stay where it was. Since every reader goes through `normalize`, resolving
  there reaches them all, the published map document included, which carries
  the CQL without the panel's notes. It resolves to the start of the day in
  UTC, not to the moment: geoapi keys its tile caches and ETags on the filter
  it passes on (resolved at its entry, `cql_filter_query`), which so stays one
  filter all day. A filter saved before kept a date and a note in `query.ui`;
  the panel reads it as the row and writes `daysAgo` on the next save.
- **Saved negations were converted once, not reinterpreted** (`convert.py`).
  The panel writes every negation with the empty value as an alternative (and
  "is empty" on text with the empty text), while `normalize` keeps evaluating a
  `!=` or a bare `isNull` as written, since other clients still send them. Core's
  data migration `0023_filter_empty_values` rewrote the stored filters into the
  panel's form with `convert_query`, so a saved row filters the same before and
  after the panel saves it again. It follows the web's reader and writer, which
  a fixture shared with the web's tests (`filter_conversions.json`) holds to the
  same answers.
- **A tool or an export applies a filter in full or not at all**
  (`checked_cql_filter` in `storage/query_builder.py`). `build_cql_filter`
  drops a filter it cannot read, which on the map shows every feature; a tool
  or an export would run on the whole layer and hand back a result that looks
  right. Every place a tool, the If step, the layer export and the sync
  statistics of processes read a layer with its filter goes through
  `checked_cql_filter`, which refuses (`UnreadableFilterError`, a `ValueError`)
  a filter over a request ceiling, one the checker finds broken as a saved
  filter (errors and damaged fields; limits are warnings, as on the map) and
  one the evaluator does not translate, naming why.
- **An area is evaluated as its union** (`area.py`). Clients put an area's
  pieces side by side in one MultiPolygon, so its polygons may overlap or fill
  one another's holes, and DuckDB and a prepared shapely geometry read a point
  in two pieces as outside. The evaluator, geoapi's stored tiles and the
  catalog's `intersects` hand on the union instead, so every writer and every
  saved filter is answered alike; a valid area passes through as it is.
  Repairing an outline costs by how often it crosses, touches or lies within
  itself, not by its points, so those are counted first, at a bounded cost,
  and an area past a cap is refused instead of repaired: the checker reports
  `area_crosses_itself` on a save and on a request, and `normalize_area`
  raises for a caller that skipped the checker. Each area is worked out once
  and kept by its digest, so a path that asks per tile pays once per filter.
- **One checker, two modes** (`validate.py`). `validate(cql, ctx)` reports
  issues with the style's codes and levels (`issues.py`): malformed or
  unsupported forms, fields the layer does not have, values of the wrong type,
  the limits. A new save (`stored=False`) is refused on any error; a filter read
  back (`stored=True`) keeps loading: a field a later data change broke is
  `damaged` and a limit is a warning. It accepts every form the services
  evaluate (any `like` pattern, the functions the evaluator allows, the spatial
  and arithmetic operators), so no saved filter becomes invalid.
- **Save limits and request ceilings are different things.** The save limits
  (`data/operators.json`, read by the web too, loaded in `limits.py`) are the
  product's rule, applied when a save changes a filter. The request ceilings
  (`REQUEST_MAX_*` in `limits.py`, checked by `over_request_limits` on every
  filter a request brings to geoapi, the sync analytics of processes and the
  catalog's search) only protect the services, so they lie well above the save
  limits and a filter saved over one still filters. CQL2 text has to be parsed
  to be measured (`over_request_limits_text`).
- **One set of cases for Python and the web.**
  `tests/unit/filter/fixtures/filter_cases.json` holds each filter shape with
  the issues the checker reports and the rows the web's panel reads; the web's
  tests read the same file, and `test_saved_shapes.py` runs every error-free
  case through the evaluator and DuckDB.
- **The panel's rows and areas in Python** (`rows.py`, `areas.py`), for the
  assistant, which changes a layer's filter the way the panel does:
  `read_rows` and `write_rows` turn a stored filter into the panel's rows and
  back, and `areas.py` builds an area from its pieces (regions, another
  layer's features, the map view) as the panel writes it, simplifying an
  outline to fit the limits. Both use the standard library only, since the
  assistant has no geometry libraries, and fixtures shared with the web's
  tests (`filter_rows.json`, `filter_areas.json`) hold both sides to the same
  answers.
- **A workflow's filter rows are a second writer of the same CQL2.** A dataset
  step and an If step store their conditions as the panel's rows
  (`{attribute, expression, value}`), which the assistant reads and writes too;
  `tools/workflow_runner.py` (`convert_filter_to_cql`) writes each row as the
  panel writes it for a layer (`apps/web/lib/filter/rows.ts`), so a step keeps
  the rows the layer filter keeps. An operator added to the panel needs both
  writers; `tests/unit/tools/test_workflow_filter_rows.py` compares the rows
  both keep, per operator and on every stable shared case. Where the run does
  not know a field's type, it writes a form that keeps the same rows on any
  type (a day as its start in UTC, which a date column reads as the day).
  Only "is empty" and "is not empty" cannot do without it, since on text they
  also take the empty text: for those a dataset step reads its layer's field
  types. "In the last N days" counts back from the day the run started, to
  the start of that day as the layer filter's `daysAgo` does, written once per
  run so every step reads the same day.

## Raster files (`raster/`)

Raster layers are COG addresses read in place over HTTP: geoapi serves value
tiles, colored tiles for images, statistics and point values from them,
processes computes a raster style's values. Both install the `raster` extra
(rio-tiler; rasterio's wheel bundles its own GDAL, so neither image needs a
system GDAL). core needs none of it: `formula` and `token` import no raster
stack, so validation runs in core too.

- **One formula grammar** (`formula.py`): `b1`, `b2`, ... up to the file's band
  count, numbers, `+ - * /`, brackets, parsed into a small tree and evaluated with
  numpy, never `eval`. Validation (`style.data_check`) and evaluation use the same
  parser, and the web's style panel mirrors it to check a typed formula (both run
  the cases of `tests/unit/raster/fixtures/formulas.json`). Division by zero is no
  data.
- **Value tiles hold the cells' values; the browser colors them** (`values.py`):
  each pixel holds a code `q = R * 65536 + G * 256 + B` for the value
  `base + q * step`, `q = 0` for no data, which a MapLibre `raster-dem` source
  with the custom encoding decodes. A color edit is then a paint change in the
  browser, and hillshade shades the same values. Unscaled 8 and 16 bit whole
  numbers are stored exactly, 32 bit ones too when their range fits in the codes;
  everything else steps by eight float32 units at the range's magnitude, with a
  tenth of the span as room below the sampled minimum (statistics come from an
  overview). MapLibre decodes in float32, which sets the limits: a narrow range
  far from zero gets few levels (1,000,000 to 1,000,010 gets 20), a 32 bit range
  wider than the codes is stored in steps (32 for 0 to 40,000,000), and whole
  numbers beyond 2^24 are no longer exact in the browser. `ENCODING_VERSION`
  joins every value tile's and colored tile's version, so a changed encoding
  never serves old tiles: caches keep both for good, so any change in a tile's
  pixels for the same address (the packing, the read, the resampling, which is
  the reprojection's too, `colorize`, and the statistics or sample whose range
  a coloring without a domain spreads over, which a colored tile's address does
  not name) bumps it, and `tests/unit/raster/test_reference_value_tiles.py` pins
  reference value and colored tiles to catch one. Tiles are lossless WebP at
  libwebp's effort 50 (`WEBP_EFFORT`, GDAL's
  `QUALITY` for a lossless image): the same pixels as the default 75 at about the
  same size, in less time; the bytes may differ, which needs no bump.
- **An image tile's coloring travels in its URL** (`token.py`): for image renders,
  colors over float values of an unknown range (their codes cover only a stand-in
  span), and colorings with more stops than the browser takes whose coloring fits
  in a URL (longer ones are reported as not supported), the web resolves the
  style into a coloring (palette colors, class bounds and colors) and sends it as
  base64url JSON; the service needs no palette catalogue and no lookup, and the
  token is its own cache key. `tests/unit/raster/fixtures/web_tokens.json` holds
  tokens the web wrote; both test suites read it.
- **Colors match the browser's of before the service** (`color.py`): a ramp is a
  256-color lookup, stops blend or take the nearest, classes are `[from, to)`,
  categories match the rounded value; no data (the file's, with float32 rounding,
  NaN, the style's values) is transparent. `outside` works for classes as for a
  ramp: with `clamp` the first and last class are open, with `hide` they end at
  their own `from` and `to`, else at the token's `domain`, else at the band's
  range (the last holding its end), and the cells beyond are transparent. A
  color's own alpha (`#rrggbbaa`) is painted, blended premultiplied as MapLibre
  blends the browser's colors; the layer opacity stays the browser's.
- **A band's class breaks come ready for every method and count** (`stats.py`,
  `precomputed_breaks`): geoapi's raster info gives them with the band's
  statistics for the band it is asked for alone (none without one), or for a
  band formula with its
  statistics (`formula_statistics`, over the formula's values from the same
  overview), so a style panel switches methods without asking. They are the
  vector classes' breaks: one call of the shared classifier per method gives
  every count, exactly as asking for each count alone does
  (`calculate_class_breaks_by_count`: one quantile query, one Fisher-Jenks run),
  over an in-memory DuckDB table on one thread (DuckDB sums in parallel, and
  every pod must give the same digits), from at most 100,000 of the overview's
  values drawn with a fixed seed (`classified_sample`). The style check
  classifies a band or formula with every method but equal intervals
  (quantiles, natural breaks, standard deviation, geometric intervals, heads
  and tails) over the same sample of the whole band, whatever the style's
  `render.domain`, so the breaks a panel offers are the classes a saved style
  gets; only equal intervals use the domain (they split it), and without one
  read the ends of all the overview's values. A count's list can be shorter
  than its count less one, or empty (equal breaks merge; standard deviation
  leaves out breaks outside the data). Counts run from 3 to 13; geometric
  intervals need every value above 0, so a band reaching 0 or below has none
  (`{}`). A file of whole numbers (`whole_number_values`: an integer type,
  neither scaled nor offset) gets whole-number breaks for its bands, rounded
  half up and kept once, in the info and the check alike; formulas keep theirs,
  except a formula of one band alone (`b2`, ` b2 `, `b02`: `single_band` in
  `formula.py`, which both take), which is that band. geoapi reads the band's
  values alone
  (`RasterSource.sample` of `b<n>`, as the check reads them) with
  `remember_failures` off, so a failed read for the breaks never marks the
  file failing for its tiles.
- **An alpha band is the image's transparency, not a band of values**
  (`source.py`, `RasterInfo.value_bands`): rio-tiler reads it as the other
  bands' mask, so statistics, band samples, class breaks and point values cover
  the other bands only. Tiles and validation take the same bands, wherever the
  alpha band is: a coloring or formula naming it is refused in the same words
  ("The raster has 3 bands.", `check_bands`; validation checks the band indexes
  it knows), and its popup has no field for it (`raster_fields`). The file's
  band count (`RasterInfo.count`) still includes it.
- **An image without chosen bands draws the bands its file marks red, green and
  blue** (`color.py`, `image_bands`, from `RasterInfo.color_interp`): a file
  stored blue, green, red and marked so draws red from its third band. Without
  all three marks it draws its first three value bands, or its first. The web
  mirrors this rule (`imageBands` in `apps/web/lib/style/raster/metadata.ts`) to
  read an image's values from its pixels, so a change here changes both.
- **Only checked addresses open** (`source.py`): http(s) hosts that resolve to
  public addresses or are listed by the service (`private_hosts`); redirects
  answered to a HEAD request are followed hop by hop with the same check
  (`io/remote_source/url_guard.py`, shared with WFS imports), the result kept ten
  minutes. The guard also refuses an address that its URL parser and the HTTP
  client's (urllib3) would read with another scheme, host or port, and any
  address with a backslash, whitespace or a control character inside it
  (`assert_unambiguous_url`, which core's layer address check runs too, so such
  an address is never stored). Remote and stored files open with GDAL's
  GeoTIFF driver only (`GEOTIFF_DRIVER`, which reads COGs), never a driver GDAL
  picks by the content: a file of another format under a `.tif` name is
  unavailable like any file that cannot be read. The same HEAD gives the file's ETag or Last-Modified
  (`remote_validator`; none from a HEAD that fails, as a host that refuses HEAD
  may still send one), which geoapi adds to the value tiles' version, so a file
  replaced at the same address gets new tiles. GDAL keeps what it read of a
  remote file for the process, so a check that finds another validator, or none,
  drops those blocks (`forget_cached_reads`). GDAL resolves the name again and
  follows redirects a server sends only to its reads: the residual `url_guard`
  names, so deployments also restrict the services' outgoing traffic. A file
  that does not answer fails within seconds (no retries, a stalled transfer cut
  after five seconds) and then fails at once for 30 seconds; geoapi marks a file
  failing in the same memory when a tile read runs past its deadline
  (`remember_failure`). A read that would decimate the coarsest overview more
  than 8x is skipped, so a COG without overviews is never downloaded whole.
  Only a path GDAL reads through S3 (`s3://`, `/vsis3/`) opens with rasterio's
  AWS session (`gdal_env`): with AWS credentials in the environment that session
  builds a boto3 session for every open, and GDAL reads an http(s) address
  unsigned, a bucket's included, so the session would do nothing there. goatlib
  opens an http(s) address by its `/vsicurl/` name (`_gdal_path`), as rasterio
  would pass it, because rasterio's own open takes an amazonaws.com address for
  S3 and builds a session for it: without AWS credentials in the environment, as
  geoapi runs, botocore then looks for them, the cloud's metadata service last,
  about two seconds for every open. rasterio's reprojection helper still builds
  a session of its own for a file in another projection when credentials are in
  the environment (dev stacks): a few ms and a "Found credentials" line.
- **A file's address is an access key in answers and logs** (`source.py`): a
  signed link carries one in its query. A failure answers in plain words
  (`read_failure`), and goatlib's own log names the file and the error without
  query, fragment or `user:password@` (`logged`). rasterio logs GDAL's errors
  with the whole address at INFO and urllib3 the HEAD's request line at DEBUG,
  so importing the reader puts a filter that removes those parts on every
  rasterio, rio-tiler and urllib3 logger there is (`_clean_library_logs`); a
  filter acts only on its own logger, so a rasterio logger created after the
  import (a module the reader never imports) is not covered.

## Styles of the layers goatlib creates

Tools, bundles, catalog promotion, workflow results and project imports write
style rows themselves, through `tools/style_rows.py`: the dataset's default style
and a project layer's first named style, "Default", copied from it and active
(core's add paths write the same rows with their own driver). They store only
documents goatlib built or upgraded:

- **Tool looks** are documents from `tools/style.py` (`classified`,
  `categories`, the bundle role symbols, ...). A tool returns its look from
  `BaseToolRunner.get_layer_style`; the runner fills the classes from the result
  (`computed_style`) and stamps them with the new table's snapshot. A tool whose
  result is a number per feature asks for it through `numeric_default`: a ramp
  and direction by the kind of value (values on both sides of 0 on a diverging
  palette where each side holds a real share of the rows, `centred` in
  `style/data.py`), a legend title and unit, grey for features without a
  value, and `fit`. That key is why a tool's classes suit its result: the shared
  computation fits them to the data on every compute, not once in the run
  (`style/data.py`, `fitted_breaks`; spec 5.2), so a result that later gains or
  loses values grows or shrinks its classes. Only tools write it, so a style
  made by hand computes as it always did; a class edit in the panel or by the
  assistant turns a fitted classification manual as it is, and an edit of its
  field, method or count removes the key (`style/edit.py`, `settle_fit`, and
  the web editor's `settleFit`). The runner's own fit of a run's style
  (`tools/style.py`, `fit_classes`: the count fitted once to the distinct
  values, a single class dropped unless features without a value sit beside
  it) is left for a numeric classification a tool asks for without the key. A
  style handed on from elsewhere (a template's, a filtered copy's) gets neither
  that nor the runner's decimals; a `fit` it carries is honoured by the shared
  computation as anywhere, decimals included. A title is stored text,
  written once in the run's `language` (`style_title`, from the
  `style_titles` translations; English for a language they do not hold or
  none), so it does not follow whoever looks at the layer later; field names
  and a statistic's own result name are never translated. Its number of decimals
  depends on the classes. For a classification with `fit` the shared
  computation works it out whenever it works out the classes and records it
  (`computed.decimals`, `class_decimals` in `style/compute.py`; spec 5.2), so
  the labels follow the data; a `format` with `decimals` wins. For a tool's
  other numeric classifications the runner writes it as a format after
  computing them (`with_decimals`), on the same style the fit acts on and only
  there: the format has no mark that tells a tool's default from a hand-made
  style. One rule serves both. The
  domain's ends and the breaks read apart, but an end at or above 0 may read 0,
  so a minimum next to 0 does not push every label to many decimals. A single
  class over one value has no break and shows the value itself: with `fit` as
  any value shown alone (below), else with up to two decimals and more where
  fewer would read it as 0. A fitted class that holds
  one value is labelled with it (`computed.single`, which the legend and the
  panel read), so the decimals also show each such value with its first three
  significant digits (0.087 reads 0.087, 99.789 reads 99.8, 1234.5 reads
  1,235); a value with more digits is rounded.
  Classified and categorized point looks draw each marker with a thin outline
  in a darker shade of its own color (`result_styled`), so a pale class stays
  readable on a light basemap; the cluster summary's overlapping translucent
  circles and the black stations draw none. Area looks get the same outline
  where the areas are the user's polygons or lie side by side (aggregation
  onto polygons, join, dissolve, Huff, the ÖV-Güteklassen), but not on H3
  cells (`on_h3_cells`: a grid the tool makes, told by its parameters, or a
  heatmap result run onto, told by its `h3_index` column), nor on the bands
  of a buffer or a catchment area: their palest band lies inside or beside a
  darker one, never alone on the ground, and overlapping bands would cross
  each other's outlines. Bands
  of a distance or travel cost (`bands`) are fixed categories in whole units, so
  they carry their unit, no decimals and the first band on top from the start.
  What a tool's style must hold for its result is the style contract
  (`tools/style_contract.py`): the fields it reads exist, its parts fit the
  geometry and the document validates (hard rules), plus a title, a no-data
  color and classes that hold features (design rules). The tool tests assert the
  hard rules and a class list of one on the results their analyses write
  (`assert_tool_style`) and report the design rules, which depend on the data,
  as notes. A run checks the hard rules on the same style the fit acts on: a
  tool style that breaks one gives the layer the default style of its geometry
  and a warning. When the check itself fails, the tool's style is kept and the
  failure logged. A workflow
  preview has no layer: its result and the preview's metadata file carry the
  document as `style`, stamped `temp`, and saving the result computes it again.
- **Catalog items** promote with their published style asset upgraded for the
  item's geometry (`catalog/item.py`, shared with the catalog service's asset
  route), stamped `catalog:<version>`, else the default style.
- **Project archives** (format 1.2) carry every layer's default style, every
  project layer's named styles with the active one, the map state of layers and
  groups, and the uploaded icons the styles name (`asset:<id>`, remapped to the
  imported assets); archives before 1.2 carry `properties`, which the import
  converts. The import reads the version of every style in the archive first
  (`tools/project_import.py`): a newer GOAT Style minor or major refuses the
  whole import before anything is written, since `stored_document` would swap
  such a style for the default one; a newer patch is imported with the version
  its keys need, the styles inside workflow and report layout configs too, and
  the job result lists it under `warnings`.
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

## XPlan bundles are decoded at import

An XPlanGML file states codes and links, not meanings: `besondereArtDerBaulNutzung
= 1500`, `refTextInhalt = #GML_...`. The meanings are in the standard's code
lists. The XPlan importer (`bundles/importers/xplan/`) writes them into the
data, a `<field>Wert` column per code field, the linked clause text in
`refTextInhaltWert` and the plan's details on every object, because the AI
assistant, filters and exports read columns and never the map style. Decoding
only in the style, as plan viewers commonly do, would leave all of them with
numbers.

- What GOAT knows about the format is the XPlan schema
  (`bundles/importers/xplan/schema.py`), the counterpart of the GTFS importer's
  `gtfs_schema.py`: per version, which fields of a class hold codes (the ones
  inside the data types it holds included, under the innermost name GDAL reads
  them into), from which code list, and what each code means. A format needs as much schema as its
  files leave out: Overture's GeoParquet names its values in words, GTFS is
  untyped text, XPlan states only codes. At about 1,700 codes per version it
  is generated (`generate_schema.py`, into `versions/`) from the XLeitstelle's
  own publication, not fetched at import: the worker may have no internet and
  the decoding must not depend on a website. The same lists ship with an open
  source XPlan server, but under the AGPL. A code the version's list does not hold stays without a name.
- One member layer per XPlan class, as every XPlan tool cuts a plan. The plan
  is a bundle because its layers only make sense together, not because a tool
  needs a particular member, so the `xplan` type declares no roles: a plan holds
  whichever of the standard's classes it uses, and each member's role is its
  class name, which is what its style is looked up by.
- The file is read by `io/gml.py`, as a plain `.gml` upload is (see "A file is
  read as the format it is named" below). Plans draw arcs,
  which GDAL hands over as curve geometries DuckDB does not parse, so the
  geometry is read as WKB and `io/curves.py` straightens it. Links between
  objects are read only with `GML_ATTRIBUTES_TO_OGR_FIELDS`, and for some WFS
  downloads only when the root declares the xlink namespace
  (`copy_with_root_xlink`).
- A `.gml` is XPlan by its content (the namespace declared on the root), not
  its name; the web app reads the same 64 KB to route the upload.
- A plan also comes as its archive (XPlanArchiv): a ZIP holding the plan as
  `xplan.gml`, its documents and raster sheets beside it. An archive is one by
  that member in its directory, which core and the web app can tell without
  unpacking anything. The importer has no unpacking of its own: the archive
  goes through the dataset upload's `extract_zip_safely` (`io/discover.py`),
  so one limit on the unpacked size and one refusal of members outside the
  archive hold for both, and what was unpacked is removed after the read.
  Only the plan is imported; the files beside it are not.

## GOAT's public transport network is cut like an upload

GOAT's default public transport network combines many operators' feeds, too
large to be a bundle. Its timetable lies on the workers' shared volume
(`${DATA_DIR}/pt_network/gtfs.bin`), and next to it the same feeds as GTFS
tables (`${DATA_DIR}/pt_network/gtfs_tables/`), which `fetch_pt_network` cuts
to an area as a new GTFS bundle. Both arrive with the `public_transport` base
data version (`tasks/sync_base_data.py`), which is built and published outside
this repository (the goat-data pipeline), with the network's coverage mask and
the dates its timetable covers.

The tables are the GTFS importer's own output, and a cut writes the same, so
it is ingested, typed and built (timetable, access and egress) exactly as an
uploaded feed is. A cut keeps whole lines: every line serving a stop in the
area, or its station, with all its trips and every stop they call at, inside
the area or not, so a trip still runs end to end. Every other table keeps a
row only where each id it names is kept, so no reference is left dangling
(`io/fetch/pt_network.py`).

Finding a cut's lines and reading their rows would otherwise read every stop
time and shape point of the network, tens of seconds on a worker's one CPU
for any area. So the tables are indexed for the cut (`index_store` in
`bundles/importers/pt_network/store.py`, schema 2): which line serves which
stop, and every line numbered along a Hilbert curve through its stops'
centre, with `stop_times` and `shapes` sorted by that number. An area's rows
then lie together, and DuckDB reads only the row groups of the kept lines'
numbers. The number is a column because DuckDB skips row groups by column
statistics, not by row position; the cut leaves it out of what it writes.
Tables written outside `build_store` are indexed on their own with
`--index`, before the version's manifest is made. Schema 1 tables still cut,
the slow way.

Both network fetches create their bundle through
`BundleImportRunner.create_bundle_from_layers`: created and ingested as an
import is, and in the project as soon as its layers are. Its artifacts (a
timetable and the stops' links to the streets, or a routable graph) take
about as long again, so they are built by a `bundle_artifact_rebuild` job of
their own, started as a top-level job so it shows in the jobs list. Until then
they read as building, which keeps the routing tools off the bundle; a build
that fails, or cannot be started, leaves them failed and the bundle offers a
rebuild. A failed ingest still rolls the whole bundle back.

Trip count and ÖV-Güteklassen count departures from the same tables, for one
date: a bundle's own on the date picked, the default network's on the anchor
date of the kind of day picked (`analysis/pt_time.py`). The default network is
cut to the area and the date first (`cut_network_tables` in
`tools/pt_network.py`), as a count joined across a continent's stop times
would not fit a worker; indexed tables are read only in the area's lines.

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

## Errors of a failed workflow run

A workflow run (`tools/workflow_runner.py`) returns its result when a step
fails, with `status: "failed"` and one `{"node_id", "message"}` per failed
step, instead of raising: Windmill keeps only an exception's text as a failed
job's result, so each step's own error would be lost. The message is the
step's error reduced by `workflows/run_errors.py`: the Windmill error's
`message` (its `name` when empty), never the stack, at most 500 characters.
processes applies the same reduction to a failed child job while a run goes
on, so a step's error reads the same during and after the run.

## Exports behind a dataset or an If step

An export saves what `finalize_layer` finds in the temp folder of the step it
reads, and only a tool step writes one. A dataset step writes nothing: it
delivers its layer with its filter, and an If step passes both on
(`dataset_filter_for_source` in `tools/workflow_runner.py`). Behind an If on a
tool, the temp layer id the If passes on names that tool's step, whose folder
is saved. Behind a dataset, directly or through Ifs, the run first copies the
dataset's rows, with its filter, into the temp folder of the step the export
is connected to (`layer_create_filtered` in temp mode, once per step; a
failed copy is the error of every export behind the step), so they are saved
like a tool's result. The copy carries the active style of the dataset
step's project entry, which `layer_create_filtered` reads from the entry it is
given (`entry_id` in `tools/workflow_dataset_nodes.py`); a dataset step without
an entry saves in the default style, and a template's remembered style for the
export still wins. An export connected to both a
step's result and a dataset saves the step's result.

## Results without rows

A step can get or give a layer without rows: a dataset filter outside the
data's extent, an overlay without overlap. DuckDB writes the GeoParquet `geo`
metadata only for a file with rows, and without it reads a GEOMETRY column
back as plain BLOB, so the next tool would find no geometry column. Every
parquet COPY in goatlib therefore takes its options from
`parquet_copy_options` (`io/config.py`), which names a GeoParquet version
that also stores the column as Parquet's own GEOMETRY type. A unit test keeps
it that way, also for a COPY that leaves the format to the file name; only
`layer_export`'s download for programs outside GOAT spells its own. Files
written without DuckDB (pyarrow in `layer_create`) set their types
themselves. `write_optimized_parquet` (`io/parquet.py`) gives an empty result
the same columns as a full one, bbox included. The overlay tools take the
geometry family they keep from the input's first geometry and keep every type
when there is none.

A layer's type comes from its rows' geometries, so a result without rows
takes the geometry type its tool gives it instead (`result_geometry_type` in
`tools/base.py`): the type the analysis reports, the runner's
`output_geometry_type` (a catchment area's follows its kind), or, for a tool
whose result keeps its input's geometry (`output_geometry_follows_input`:
clip, erase, intersection, union, dissolve, join, merge, a dataset's filtered
copy), the type of the first layer it read. `_write_temp_result` works it out
also for a runner with its own `run()`, and the temp result carries it to the
export, which saves a feature layer of that type. A custom SQL result without
rows has no such type and is saved as a table layer. A second layer that a
runner's own `run()` saves beside its result outside a workflow (the points of
an origin-destination run, for example; a workflow step writes only the first
layer) takes the type its own metadata names
(`_fill_second_layer_geometry_type`), never the first layer's
`output_geometry_type`. A member of a filtered bundle copy that the filter
empties keeps its source layer's geometry type.

An export whose data has a geometry type turns a table layer it writes into
a feature layer: an overwrite in place (`_update_layer_metadata` in
`tools/layer_replace.py`), and a re-run that writes a new layer behind a
project entry made for a table (copy-on-write, in finalize). The map draws an
entry only with a style (`visibility`, `filled`, `color`), and an entry made
for a table holds none, or only the keys the web's layer tree writes
(`legend`). So the layer and its entries get the default style beneath the
keys they hold, which win (`style_entries_as_feature_layer`); an entry's own
style stays. A feature layer never becomes a table.

## Catchment start points

A catchment area (`tools/catchment_area_v2.py`) whose starting points are
empty after their filter writes a result without rows itself, with the columns
of its kind, since the routing engine refuses zero points: a filter that
matches nothing, such as a district without the stops asked about, gives a
run with 0 rows instead of a failed one. More start points than one run takes
are refused; the limits live in `tools/limits.py`, a module without imports,
so the assistant's workflow check reads the same numbers and refuses such a
draft before it runs. The travel cost matrix's cap on origin and destination
pairs lives there for the same reason.

## Measuring areas

Area statistics (`analysis/statistics/area_statistics.py`, processes'
`area-statistics`, also per value of a group column) measure square metres on
the WGS84 spheroid, not in a projection: Web Mercator is not equal-area and
enlarges areas more the farther they lie from the equator. A geometry in
another CRS is brought to lon/lat first, with `always_xy` so its axes are not
swapped.

## Overlays on large polygons

DuckDB spatial takes a copy of a geometry for every row it tests against it
(ST_Intersects, ST_Intersection, ST_Difference) and frees the copies only after
the whole vector of rows; that memory cannot spill. A dissolved city-wide
catchment tested row by row against a few thousand points or parcels runs out
of memory whatever the threads or memory limit. So clip, erase, union and
aggregate_points cut polygons above `SUBDIVIDE_MAX_VERTICES` vertices into
pieces first (`subdivide_polygons` in `analysis/core/base.py`, a quad split,
since the extension has no ST_Subdivide) and find the pieces each row touches
with a spatial join. Clip, erase and union then intersect or erase each row
once with the union of only those pieces (`local_union_cte`), which gives the
dissolved overlay's result. aggregate_points counts a point on a cut line once
per area. A big row on the other side (a polygon, a line such as a route, or a
multipoint), such as the input of an erase, is cut too, but only to find its
pieces; the intersection or difference uses the row itself.

The cut lines add vertices to the output where they cross the overlay's
boundary. Where that boundary is slanted, such a vertex is computed in
floating point and lies a rounding error off the edge, so the union of the
pieces bends the edge by that much. A polygon row with an edge along it can
then come back as a hair-thin sliver where the dissolved overlay leaves it
nothing, or only a line. A row whose result has such a part is recomputed
against the whole overlay, as before the pieces, in batches that bound the
copies (`recompute_slivers`, `NEAR_EMPTY_WIDTH_RATIO`). A known edge case
remains: a line lying exactly on the overlay's boundary along such a bent edge
has no width to detect, so it is not recomputed and can lose or keep that edge
where the dissolved overlay would give the other result.
Not covered yet: union's overlapping parts pair each input row with each
overlay row it touches, so one big input row touching many overlay rows is
still copied once per pair, as in the intersection and spatial join tools.

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
runner's DuckLake connection. The scheduled tile tasks (`sync_pmtiles`,
`rebuild_edited_pmtiles`) give their DuckLake connection the work share, as it
does their work (it sorts each layer for manby, which starts only once the sort
is written), and make its spill directory themselves, as DuckDB's default is
`.tmp` in the working directory, which need not be writable.

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

## A file is read as the format it is named

`ALL_EXTS` (`io/formats.py`) is the one list of accepted formats: core
presigns an upload only under such a name (`apps/core/src/core/schemas/datasets.py`),
the import refuses any other before downloading the file, and the converter
refuses it before reading (all through `refuse_unsupported_format`). Each
accepted suffix has a reader, which a unit test keeps true: GDAL drivers in
`READ_DRIVERS`, DuckDB's own readers or unpacking (`NON_GDAL_EXTS`), or the
raster path.

GDAL picks a driver by a file's content, not its name. Every `ST_Read` of a
user file therefore names the drivers of its suffix (`allowed_drivers_sql`):
only the drivers of the file's format may open it, and a new format needs its
drivers listed before it imports. `ST_Read_Meta` takes no driver list, so a
user file's schema and CRS come from a `DESCRIBE` of its reader; only a
GeoPackage's layers are listed with it, and only once the file has the SQLite
header (`io/discover.py`).

GML has a reader of its own for that reason (`io/gml.py`), and no plain
`ST_Read` is built for it (`allowed_drivers_sql` refuses the suffix):

- Its classes come from the schema file (`.gfs`) the GML driver writes on the
  first read, not from `ST_Read_Meta`.
- That first read runs in a process of its own: DuckDB's reader ends the
  process on a GML without any feature class instead of raising, and only the
  read tells whether a file has one.
- A file is read through a link in a directory of its own, where the schema
  file is written. GDAL takes a `.gfs` or `.xsd` beside a GML as its schema,
  and one beside an upload is the uploader's.
- A field GDAL types a whole number stays text when a value has a leading zero
  (a municipality key, a postal code): the GDAL in DuckDB would drop the zero.

A file's name (an archive member's is the uploader's own text), its layer and
its column names are data, never SQL: each is a bound parameter where DuckDB
takes one, otherwise written through `sql_literal` or `sql_identifier`
(`io/sql.py`). That holds past the converter too, wherever an upload's file or
columns reach a statement: the DuckLake ingest and replace
(`tools/base.py`, `tools/layer_replace.py`), the workflow preview
(`tools/temp_writer.py`) and the tiles export (`io/pmtiles.py`).

## Rows are stored in spatial order

A tile or any bbox query skips the row groups whose `bbox` column misses its
window, which only helps when neighbours on the map are neighbours in the
file. Every write of a layer's rows (the ingest and replace in `tools/base.py`
and `tools/layer_replace.py`, the workflow result in `tools/finalize_layer.py`,
the catalog copy in `tools/catalog_materialize.py`, and the parquet writers in
`io/parquet.py` and `io/geoparquet.py`) therefore sorts along a Hilbert curve
over the rows' own extent, with `hilbert_key` (`io/spatial_order.py`).
DuckDB's `ST_Hilbert` without that box maps the coordinates' raw float bits
and kept no neighbours together: each row group of a German layer spanned the
whole country, and every tile read the whole table.

A layer's feature ids are its row positions (rowid + 1, a catalog layer's
`file_row_number`), and projects keep them (atlas pages, exclusions, picked
features). Data already written is therefore never reordered: a re-run of
`catalog_materialize` keeps the file in place, and tables written before the
key stay as they are. DuckLake offers no way around it: a rewrite, and
`SET SORTED BY` with `ducklake_merge_adjacent_files`, both number the rows
anew. The `project_import` copy keeps its export's order on purpose.

## Uploaded files are core's

Uploaded icons, images and documents (`uploaded_asset`) are core's alone: core decides where the files live (the
assets bucket, or the data bucket under `ASSETS_PREFIX` in `storage/s3_config.py` when it serves them itself) and
the Windmill workers get no access to that store. Project export and import carry icons and images through core's
HTTP API instead (`tools/core_api.py`), with core's address from processes. `project_export` reads each file from
core's public `/asset/<id>/file` (following the redirect to the image link) and needs no token; documents are not
exported. `project_import` uploads each file through `/asset/upload` with the user's access token as its first step,
while the token is fresh (core keeps it, records it and reuses an identical file of the user's), and writes the
records with the ids core returns. Nothing refreshes the token: a file core refuses stays out with a warning and the
import goes on. A failed import deletes the uploads it created, with the same token, as far as it can.

## A remote file's address in a project archive

A raster layer added from a file's address can carry an access key in it (a signed link's query string, a user and
password before the host), and so can a WFS copy's source address (`other_properties.url`, in the layer and in its
project links), which names the service its features came from. Whoever may read a project may export it, so
`project_export` writes those addresses whole only for an exporter core's `layer_write_allowed` lets edit the layer,
asked in its layer query; anyone else's archive holds them without query string, fragment and credentials. The rule
is `utils/layer_address.py` (`layer_shown`), which core's layer reads use too. Map services keep their address, since
the browser loads their tiles from it. A remote-file layer imported from such an archive needs its full address set
again before its file can be read. A WFS copy imported from it keeps the shortened source address too, so refreshing
it asks the service without the key; no route edits that address (a link save keeps the stored one), so the way back
is a new import from the service. Log lines and job errors, which more people read than a layer's editors, never hold
such a key: the raster reader and the WFS import (`tools/layer_import.py`, `io/remote_source/`) name an address with
`without_key` and clean quoted error text (GDAL's, requests') with `text_without_keys`.

## Files another pod just wrote

The data volume is shared over NFS, and each node remembers for a while that a file name did not exist. A
catalog layer's copy (`catalog_materialize`) or a workflow step's result written by a job on another node can
therefore look missing here for a moment. Where the file must exist (a catalog copy the layer row marks ready, the
result of a finished step), the runners wait for it, bounded, with `goatlib.utils.shared_disk.wait_for`, instead of
concluding it is gone; a catalog layer would otherwise be looked up as a DuckLake table and fail. Where nothing says
the file exists, nothing waits.

## Workflows

`workflows/` holds the workflow code core, processes and the assistant share without the analytics stack: the shape check, the graph helpers and settings-visibility rules of the full check, and the assistant's edit operations. Core refuses a damaged config on save with `checks.shape_issues`; processes runs the same function first in its full check and builds on `find_loops`, `dangling_edges` and `visibility.is_shown`. The package imports the standard library only: core installs goatlib without its extras, so a pydantic model or a tool import here would stop core from starting on its own image (`apps/core/tests/unit/test_runs_without_the_geospatial_stack.py` loads it the way the image does).

`ops.py` applies the assistant's edits (add or remove a step, change its settings, connect, rename, a note's text) to a stored config as pure functions, refusing what a run would get wrong: a loop, or a second connection into an input unless the two come from steps on different branches of one If step (a run passes an If's input on along every connection leaving the If itself, whichever branch it took). An edit is then a plain new config, which processes checks and core saves with `base_revision` like any other save, and the config before it is what the assistant's Undo writes back. Each operation writes the keys the editor writes for the same change and leaves every other step as stored, so an edit never rewrites what a person laid out.

`visibility.py` is a port of the editor's `visible_when` / `hidden_when` evaluator (`apps/web/lib/utils/ogc-utils.ts`), with JavaScript's equality and truthiness, because a required setting counts as missing only while the editor shows it. `visibility_cases.json` is read by the Python and the web tests alike, so a change to one evaluator that the other does not share fails a test.

## Workflow chain tests

Each tool's own tests run that tool alone, on inputs with attributes and with
its settings given. `tests/integration/tools/chains/` runs whole workflows
instead: the real `tools/workflow_runner.py`, each step through the script
sync writes to Windmill for it (`windmill_script` in `tools/sync_windmill.py`,
for a tool its generated wrapper), and the real tools on Postgres and
DuckLake, with only the settings the assistant sets. That is where a step
meets what the step before it wrote, such as the geometry-only layer of a
dissolve without group fields.

Windmill is stood in (`tests/integration/tools/chains/windmill_stand_in.py`):
a job runs at once in the test process, its arguments and result pass
through JSON, and a script whose `main` takes no `**kwargs` gets only the
arguments it names, as Windmill calls it. The layers
(`tests/integration/tools/chains/world.py`) are the assistant eval's
workflow project: its layer ids, names and fields, on a grid in Leipzig.

The tests also run the assistant's regression workflows that do not route
(`apps/assistant/evals/workflow_runs.json`) as the assistant built them,
since their configs name these layers.

CI runs them in the `workflow chains` job, which installs neither the routing
package nor GDAL, so tools that route are not part of these chains. Locally,
on a throwaway database of the Postgres in the root .env file (the chain tests
refuse the goat and goat_slot_ databases), with DuckLake's files in a scratch
directory:

    createdb goat_chains_test && psql -d goat_chains_test -c "CREATE EXTENSION postgis"
    POSTGRES_DB=goat_chains_test DUCKLAKE_DATA_DIR="$(mktemp -d)" uv run --no-sync --env-file ../../../.env pytest tests/integration/tools/chains -v

## PMTiles are built with manby

One builder, `PMTilesGenerator` in `io/pmtiles.py`, makes the PMTiles of every layer: tool results, imports and copies, catalog materialization, `sync_pmtiles` and `rebuild_edited_pmtiles`, and the workflow previews in `tools/temp_writer.py`. It writes the layer from a DuckDB query (`tile_query`), ordered by feature id, to a GeoParquet file in the build's temporary directory, then runs manby on that file with a recipe per geometry type (`manby_flags` holds them). A polygon layer gets its label points in a second file, `_anchor.pmtiles`, built from the same input.

- **The marker**: the tileset's description records `MANBY_MARKER` and the version of its recipe next to the DuckLake snapshot id. geoapi filters a stored tile only when it finds the marker, so tiles from before manby (whose point tiles merged nearby points at every zoom) keep the DuckDB path until they are rebuilt. `is_pmtiles_in_sync` wants the marker, the current version of the file's recipe and the snapshot, so a plain `sync_pmtiles` run after the deploy rebuilds those tiles; stopped and started again, it goes on with the layers still stale, where `force` would rebuild every layer. Each kind of tiles (points, lines, polygons, label anchors) has its own version in `MANBY_RECIPES`, and the file says which kind it holds (its anchor layer, else the geometry of its tile statistics), so bumping one after a change to its recipe in `manby_flags` rebuilds only the tiles of that kind, catalog layers' included. A polygon layer's anchor file has to be in sync too, and is published before the main file, so a main file in sync always has its anchors.
- **Catalog layers**: `sync_pmtiles` also rebuilds the tiles of promoted catalog layers (its `layers` parameter picks DuckLake layers, catalog layers or both), from their local GeoParquet copy with the materialize job's own step (`generate_catalog_pmtiles` in `tools/catalog_materialize.py`). It never downloads or changes the copy. Catalog layers have no snapshot: their tiles are in sync with the current marker when they are no older than the copy, which the job writes before it builds the tiles, so a dataset materialized again makes its old tiles stale. The layers come from the layer rows, never from listing the directory: feature layers a project uses, without a materialize job queued or running, because `catalog_gc` deletes the files of the others (a layer that lost its project entries, such as the old version after an update, stays only while a published map, a workflow or a template still names it, and keeps its tiles as they are).
- **Recipes per geometry type** (`manby_flags`): points and label points end each branch of the pyramid where its tile holds everything below (variable depth). Lines and polygons do not: such a tile holds its features whole at full detail, which made the zoomed out tiles of large polygons and of sparse networks the heaviest of a layer. They are stored at every zoom down to the one manby guesses from the spacing of the vertices, at most `max_zoom` (`--largest-maximum-zoom-guess`, so one build), with full precision at the deepest zoom for the tiles geoapi overzooms from it. A point tile holds far fewer features than the others (`POINT_TILE_FEATURE_LIMIT`): MapLibre numbers the pictures of one symbol layer in a tile with a 16-bit counter, so a denser tile of points drawn as icons or shaped markers is not drawn at all. manby drops the densest points where a tile is over the limit and adds zooms where they are needed.
- **manby is the only builder**: a build manby fails returns None and never fails the tool. geoapi serves a layer without PMTiles from DuckDB, and `sync_pmtiles` builds the missing files when it runs. When only a polygon layer's label build fails, its main tiles are published without anchors (older anchors are removed, or they would leave the layer stale on every sync): the layer is drawn from its tiles, and its label requests go to DuckDB. The one retry is for points whose spacing `-zg` cannot guess a max zoom from (`MANBY_EXIT_NO_ZOOM_GUESS`): they are built to the configured max zoom.
- **DuckDB first, then manby**: streamed straight from the query, manby and the DuckDB connection sorting the layer had to fit in the worker at the same time, and manby slowed to a crawl under the small memory budget that left it. With the file in between, DuckDB has finished before manby starts, so manby gets half the container (`MANBY_MEMORY_SHARE` in `utils/container_memory.py` says why not more). Streaming also crashed the process on a second build unless pyarrow was imported first (`tests/unit/io/test_manby_repeat_calls.py`); with a file, manby's feeder thread does not run.
- **Threads follow the container**: manby starts one thread per core of the machine. On a big node that is dozens of threads in a two-CPU worker, each costing memory, so the builder passes `TIPPECANOE_MAX_THREADS`, which manby reads, from the container's CPU quota (`utils/container_cpu.py`) to manby's process. Without a CPU limit, and the Helm chart and compose set none for the tools workers, that is the CPUs the process may run on: the node's.
- **The pin**: manby comes from PyPI, at the exact version in the `full` extra (the Windmill workers) and in geoapi's own dependencies, never in base goatlib, which core depends on and which stays minimal. What GOAT needs beyond plain tippecanoe (the `like`, `ilike` and `intersects` filter operators, a memory budget kept while reading the input, `--largest-maximum-zoom-guess`) went upstream; `test_manby_available.py` fails on a version without it.

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
