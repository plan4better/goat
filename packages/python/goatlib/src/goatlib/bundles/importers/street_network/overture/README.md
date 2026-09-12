# Street network bundles — stage 1

Scope: get an uploaded Overture transportation extract into a bundle with `edges`
and `nodes` member layers, and build the routing artifact from them.

## Upload contract

A `.zip` containing exactly two files, official Overture transportation schema,
unmodified:

```
segments.geoparquet     Overture `segment` records (subtype=road)
connectors.geoparquet   Overture `connector` records
```

Official Overture is distributed as partitioned parquet covering the planet
(`theme=transportation/type=segment/…`), so what we accept is a bbox *extract* —
two files, however the user chose to name them. The zip is identified either by
name (`*overture*.zip`) or by sniffing its entries, because both bundle types are
zips and the name alone cannot always decide.

Validation rejects rather than repairs: a missing file, or a parquet without the
required columns, fails the import with the missing pieces named.

Two things about extracts, both handled:

* **Connectors outside the clip.** A segment crossing the bbox boundary names a
  connector whose row is not in the file. Those nodes are reconstructed from the
  edge's endpoint, keeping the real GERS id — only the geometry was missing.
  Without this the graph is open at every boundary.
* **Connectors nothing references.** The connectors file covers whatever bbox it
  was clipped to, including nodes for segments we don't have. Those are dropped,
  or they would scatter isolated points across the layer.

## Why Overture rather than raw OSM

* **Topology is explicit.** Every segment carries `connectors[]` of
  `{connector_id, at}`. A PBF converted to any format loses its `<nd ref>` lists —
  GDAL consumes them to build geometry and discards them — so an OSM-native
  importer would have to rebuild topology by matching endpoint coordinates with a
  float tolerance. Overture hands us stable ids instead.
* **`class` is already the routing vocabulary.** Overture `RoadClass` is the OSM
  `highway` taxonomy, which is what the routing engine's `class_` holds.

OSM support, if wanted, becomes an OSM→Overture normalisation in front of this
pipeline rather than a second path through it.

## Pipeline

```
segments.geoparquet          split at every connector `at` and every
connectors.geoparquet   -->  scoped-property `between` boundary   -->  edges + nodes layers
                                     (splitter + flatten)                     |
                                                                              v
                                                                    routing parquet artifact
                                                                     (artifacts/street_network)
```

Splitting runs in the **importer**, because its output *is* the member layers. The
artifact builder then reads those layers — which matters because the layers are
the source of truth: a user edit to `edges` is what the next rebuild picks up,
never the original upload.

## Why splitting is required

Overture deliberately does not split segments at intersections. It keeps geometry
stable and scopes attributes to sub-ranges instead: `speed_limits`,
`road_surface`, `road_flags`, `access_restrictions`, `level_rules`,
`subclass_rules` and `width_rules` are arrays of structs carrying
`between: [a, b]` with `0 <= a < b <= 1`. Connectors likewise sit at `at`
positions that may be interior to a segment.

A routing edge needs one value per attribute and a node at each end, so the
network is cut at every connector position and every attribute-change boundary.
After that cut each piece has exactly two connectors and no linear references.

One exception: `sources` also carries `between` ranges, but those are *provenance*
boundaries — which upstream dataset contributed each stretch — not attribute
changes. Splitting on them produced 2% more edges on Augsburg for no routing
benefit, so `SplitConfig.lr_columns_to_exclude` holds them back.

This mirrors Overture's own
[transportation-splitter](https://github.com/OvertureMaps/transportation-splitter),
including the `start_lr` / `end_lr` range (which it emits as columns, where we fold
it into `id`) and its config knobs. That tool
is not reused: it is a PySpark 3.5 + Apache Sedona + Java 17 application targeting
Databricks and Glue. It also carries TODOs for the linear-referencing cases this
module handles, and locates connectors with planar `ST_LineLocatePoint` rather
than the `at` values.

## Linear referencing is geodetic

Overture defines a linear reference as

```
lr = geodetic_distance_along_segment_from_start / total_geodetic_length
```

on the WGS84 ellipsoid — *not* planar distance over lon/lat treated as x/y, which
underestimates an east-west length by roughly half at 60°N. We use
`pyproj.Geod(ellps="WGS84")`, which is what Overture's reference implementation
uses.

Two related traps, both caught only by cross-checking against pyproj and both
guarded by tests:

* DuckDB's `ST_Length_Spheroid` reads coordinates as **(latitude, longitude)**, so
  unflipped input inflates lengths by ~49% at these latitudes — plausibly, not
  visibly. The artifact builder wraps geometry in `ST_FlipCoordinates`.
* DuckDB's `ST_Transform` honours EPSG:4326's authority axis order, also
  (latitude, longitude). Without `always_xy := true` every projected coordinate
  comes out transposed and nothing snaps to the network.

## What reaches a column, and what doesn't

The schema draws the line. These reference `geometricRangeScopeContainer` and
nothing else, so exactly one rule survives a split and each reduces to a scalar
losslessly:

```
road_surface    -> surface
subclass_rules  -> subclass
```

These also carry heading, temporal, travel-mode, purpose-of-use,
recognized-status and vehicle scope, so no single column can represent them:

```
speed_limits, access_restrictions, prohibited_transitions, destinations, routes
```

**Traversability is expressed entirely through class and speed.** Downstream needs
only those two things, so `speed_limit_kph_forward` / `_backward` carry the whole
answer per direction:

| value | meaning |
|---|---|
| `null` | the class is not drivable (footway, steps, cycleway, path, pedestrian, bridleway) — a speed limit is not a meaningful value |
| a number | Overture stated it, or `CLASS_DEFAULT_MAXSPEED` for that class where it did not |
| `0` | cars may not traverse in that direction |

`0` is unambiguous: Overture's schema puts `speed.value` at a minimum of 1, so it
can never collide with a real limit, and it is already how the routing engine
spells "impassable" (`maxspeed <= 0`). One-ways fall out of this — Overture has no
`oneway` field, it denies access in a heading, and only that heading closes.

Access is evaluated as the schema specifies, for the fact pattern *"an ordinary
car, travelling through, at no particular time"*: a rule matches when its
`heading` is absent or equals the direction and its `mode` is absent or names a
mode a car belongs to (`vehicle`, `motor_vehicle`, `car` — the schema's taxonomy
puts car/truck/motorcycle under `motor_vehicle`), and **the last matching rule
wins**, since rules are written general-first and specific-last following OSM
conditional restrictions. A rule scoped by time, purpose, permit or vehicle
dimensions does not match that pattern, so a street closed 15:00–18:00 stays
drivable in general. With no matching rule the direction is open.

Class defaults live here rather than in the artifact builder so the layer is
self-describing: an editor opening it sees `30`, not a null needing
interpretation.

## Output

`edges` — one row per split piece:

| column | source |
|---|---|
| `id` | `{original_id}@{start_lr}-{end_lr}` — the parent id alone repeats across pieces, so the range is what makes it unique (see below) |
| `original_id` | the upstream id of the unsplit line this edge came from (a GERS id, for an Overture import) |
| `class`, `subclass`, `name` | `name` is the primary well-known name |
| `source_node`, `target_node` | the node ids at each end; the artifact resolves them to its integer `source`/`target` |
| `surface` | flattened surface rule |
| `speed_limit_kph_forward` / `_backward` | traversability, per the table above |
| `geometry` | LineString, EPSG:4326 |
| `other` | JSON residual, null when the columns say everything |

Column names are source-agnostic on purpose: an importer for another upstream
format writes the same layer, so nothing here names Overture. They follow
data_preparation's `output_segment` type, which is where `original_id` and the
source/target pair come from.

`nodes` — `id`, `geometry`. A node the splitter minted (rather than one read
from the upload) is named as such in its own id, so no separate flag records it;
those ids are not GERS-resolvable when they came from an attribute boundary.

### The linear-reference range in `id`

One Overture segment becomes several edges, so an edge's id is its parent's upstream
id plus the stretch it covers:

```
c48a001a-1840-491c-8ba6-7271e799e0ab@0.408636098-0.532543783
└─ original_id ───────────────────────┘ └─ start_lr ─┘ └─ end_lr ─┘
```

The two numbers are fractions of the **parent's geodetic length** — the same
linear-reference scale Overture itself uses. Munich's `Tal` in the test fixture has
connectors at 0.35 and 0.70 and a speed change at 0.50, so it becomes four edges
covering `0.0–0.35`, `0.35–0.50`, `0.50–0.70` and `0.70–1.0`.

They are **provenance, not geometry** — the geometry column already holds the cut
shape. Keeping them in the id rather than as columns is deliberate: they are what
makes the id unique (matching the reference splitter's form), they let an edge be
traced back to a stretch of a specific Overture segment for diffing against a later
release, and nothing downstream reads them as values. Splitting the string is
enough on the rare occasion you want the numbers back.

Consecutive pieces always meet — one's end is the next one's start — and a
segment's pieces always span 0.0 to 1.0. The splitter emits them in ascending
order, and flattening preserves it, so a segment's edges are already in order
along it.

Two caveats. The fractions are relative to the *parent*, so they are not
comparable between segments: `0.5` is a different distance on a 20 m alley than on
a 2 km road. And they become meaningless once a layer is hand-edited — a redrawn
line no longer corresponds to a stretch of anything upstream — so an
export-for-editing round trip should treat `id` as opaque.

## The JSON residual

Everything a column doesn't carry goes into `other` verbatim, including fields
this code doesn't recognise, so a property Overture adds later survives instead of
vanishing on the first import that sees it. On Augsburg that is 8.65 MB across 58%
of edges; the other 42% are ordinary roads whose columns say everything.

What it holds, and why none of it can be a column:

| field | why |
|---|---|
| `access_restrictions`, `speed_limits` | the source of the speed columns; which mode a denial named, and any time/permit/vehicle scope, cannot be recovered from two numbers |
| `prohibited_transitions` | turn restrictions — not expressible in the routing schema at all |
| `destinations`, `routes` | signposting and route membership, inherently multi-valued |
| `road_flags` | is_bridge, is_tunnel and the rest: they do not affect routing, so none earns a column |
| `level_rules`, `width_rules` | no consumer yet; kept because they are cheap and irrecoverable |

Deliberately **not** in the residual, having been audited out:

* `bbox` — Overture's bounding box, fully derivable from the geometry (was 15 MB);
* `sources` — per-edge upstream provenance (was 19 MB, more than the rest of the
  layer). ODbL attribution is a dataset-level obligation, not something needing a
  copy per edge, and `original_id` already gives per-edge provenance;
* `names.rules` — variant, language and LR-scoped names (was 3 MB). Only the
  primary well-known name is wanted, and it has its own column;
* `start_lr` / `end_lr` — added by the splitter rather than read upstream, and
  already encoded in `id`;
* `subtype` — constant `road` after the reader's filter.

`_CONSUMED_FIELDS` is the list of Overture fields the columns derive from;
anything absent from it falls through to the residual. That default is what keeps
the layer lossless, and the price is that adding a column means adding its source
field there too, or the value is stored twice.
`test_every_overture_field_is_either_a_column_or_residual` holds the invariant.

## Deliberate limitations

* No slope. `impedance_slope` needs a DEM, which an upload does not carry, so it
  is zero and uploaded bicycle networks route as though flat.
* Turn restrictions are carried on the layer but discarded by the artifact,
  because the routing engine's edge/node schema cannot express them.
* `subtype != road` (rail, water) is filtered out at import.
* `CLASS_DEFAULT_MAXSPEED` and the surface coefficients come from
  data_preparation's `overture_street_network_europe.yaml`. A non-European city
  may want its own values — the Bengaluru extract states a limit on only 3% of
  edges, so those defaults carry nearly its whole car network.

## Open decisions

1. **Rebuild trigger.** `BundleArtifactStatus.stale` exists for the
   edit → stale → rebuild cycle, but nothing marks an artifact stale when a member
   layer changes and there is no endpoint to trigger a rebuild.
2. **Layer ownership on rebuild.** `_export_member_layers` uses the calling
   user_id, which is correct on import because `_ingest_layers` just created the
   layers for them. Rebuilding a *shared* bundle would need the bundle owner.
