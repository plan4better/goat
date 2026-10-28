# GOAT Style 1.0: specification

GOAT Style is the format of GOAT layer styles and of the map document. goatlib's `style` package implements it, and
the code, tests and READMEs cite its sections as "spec N": "spec 4.2" is section 4.2 below.

## Examples in this document

The JSON examples are written against the sample datasets below; the comment above an example
(`<!-- check: districts -->`) names its dataset. Examples meant to fail list the codes they must produce
(`<!-- expect: ... -->`). MapLibre output examples follow MapLibre's style spec. Codes that need stored state or a
deployment (`damaged`, `not_supported_yet`, `too_many_features_for_render`, `classes_stale`) are listed without an
example; the goatlib validator produces them.

The sample datasets:

| Dataset | Geometry | Fields |
|---|---|---|
| `districts` | polygon | `name`, `population`, `area_km2`, `density`, `land_use` |
| `schools` | point | `name`, `type`, `status`, `pupils` |
| `facilities` | point | `name`, `type`, `visitors`, `photo_url` |
| `counters` | point | `name`, `year`, `mode`, `bearing`, `vehicles` |
| `routes` | line | `name`, `status`, `oneway` (boolean), `traffic`, `road_class` |
| `elevation` | raster, 1 band | elevation in m, no data -9999 |
| `landcover` | raster, 1 band | class codes 1 to 6, no data 0, with a color table |
| `satellite` | raster, 4 bands | red, green, blue, near infrared (0 to 255), no data 0 |
| `wms` | map service (WMS) | service styles `default` and `grey`, a legend image |
| `tiles` | map service (XYZ) | no service styles, no legend image |

## 1. Conventions

- **Two documents**: the **layer style** (how one layer looks; stored as the dataset's default and per project layer,
  as named styles) and the **map document** (basemap, view, the layer tree, per-layer map state).
- **JSON** with `snake_case` keys and `"version": 1`. Unknown keys are an error on write and ignored on read
  (section 14).
- **Colors** are hex: `#rrggbb` or `#rrggbbaa`. **Sizes, widths and offsets** are screen pixels. **Opacity** is 0 to 1.
- **Zoom** levels are 0 to 24. `min_zoom` is inclusive, `max_zoom` exclusive. Zooms on classes and rules are whole
  numbers (3.5).
- **Limits** that come from MapLibre (bounds, which settings take zoom stops or attribute mappings) are listed per
  setting in goatlib's `style/data/maplibre_limits.json`, which the web's drift test keeps equal to MapLibre's style
  spec; that table, not the numbers in this text, is what goatlib enforces.
- **Fields** are referenced by their exact name, any characters allowed (`Einwohner 2020`, `Straße`). Display names,
  units, descriptions and number formats come from the dataset's field settings; the style overrides them only where
  it says so.
- **Placeholders**:
  - labels use `{field name}`, with `\{` and `\}` for literal braces;
  - popup text, URLs and HTML use Liquid, `{{ field }}`;
  - conditions use `{ "property": "field" }`.

  A `{{ field }}` in a label is reported as `template_syntax`, with the `{field}` form as the fix.
- **Icons** are `<library>:<name>` or `asset:<id>`, never URLs:
  - `goat:<name>` is GOAT's built-in library, the icons in `apps/web/public/assets/icons/maki`: Maki icons, Font
    Awesome shapes (`circle-solid`, `star-solid`, `caret-up-solid`, `arrow-up-solid` and more) and GOAT's own icons;
  - further libraries get their own prefix (`fa:`, `temaki:`) and an entry in the icon catalogue, which is published
    as data like the palettes; an unknown library or name is `unknown_icon`;
  - `emoji:<code>` is an emoji by its code points in lowercase hex joined by `-` (`emoji:1f525`, a skin tone
    `emoji:1f44b-1f3fd`), drawn from GOAT's emoji images (Noto Emoji); emoji keep their own colors;
  - `asset:<id>` is an uploaded icon. Uploads belong to a user or an organization, keep their own colors and are in
    no library;
  - later, brand kits (colors, palettes, icons) shared with an organization the way datasets are shared can join the
    same scheme with a prefix of their own; styles keep naming entries, so a kit needs no new format;
  - library icons are only ever added: an icon is never renamed or removed, a redesign keeps the name, and a different
    meaning gets a new name. Styles carry references, never embedded images, so a fix to an icon reaches every style;
  - an icon that cannot be found draws GOAT's default marker and the style shows `unknown_icon`; the map never breaks;
  - an upload never changes under its id: replacing an uploaded icon creates a new asset. Project exports include the
    uploads their styles use.
- **Palettes** are a catalogue id or an inline list of 2 to 12 colors:
  - catalogue ids are always namespaced: `d3:viridis`, `d3:magma`, `colorbrewer:OrRd`, `colorbrewer:YlGnBu`,
    `colorbrewer:Purples`, `colorbrewer:RdBu`, `colorbrewer:Set2`, `carto:Bold`, `goat:green`, `goat:elevation`,
    and `uber:<name>` for the palettes GOAT offers today;
  - the catalogue (id, name, kind, number of steps, color-blind safe) is published as data;
  - an inline list looks like `["#fef0d9", "#fc8d59", "#b30000"]`.
- **Numbers** in labels, legends and popups use one `format` object (section 18) and the viewer's locale. A map
  document may fix the locale for public maps and print.
- **Conditions** are CQL2-JSON. Rules compile to MapLibre and accept a subset (section 6); the map document's
  `filter` runs on the server and accepts what today's `layer_project.query` accepts.
- **Ids**: classifications, classes, rules and popup blocks may carry an `id` (a short string, unique in the
  document). The server assigns one when it is missing; edit operations and issue messages use it.

## 2. A layer style at a glance

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#c7e9b4", "opacity": 0.72 },
    "outline": { "color": "#ffffff", "width": 1.2 }
  }
}
```

| Key | What it holds |
|---|---|
| `version` | always 1 |
| `kind` | `vector` or `raster` |
| `geometry` | optional: `point`, `line` or `polygon`, checked against the dataset (`geometry_mismatch`) |
| `opacity` | opacity of the whole layer |
| `min_zoom`, `max_zoom` | the zooms at which the layer is drawn (vector and raster) |
| `symbol` | the base look, made of **parts** (section 3) |
| `classify` | classifications: one field split into classes, each class changing parts (section 5) |
| `rules` | conditions that change parts for matching features (section 6) |
| `order` | draw order of features (7.1) |
| `legend`, `time`, `popup` | legend (7.2), time slider (7.3), popup (7.4) |
| `render` | how points are drawn: features, heatmap, clusters, H3 (section 8); for rasters, how cells are colored (section 9) |
| `ext` | reserved for namespaced extensions (section 14) |

Tables without geometry have no layer style in 1.0.

## 3. Parts

A geometry has a fixed set of parts. Each part has its own keys.

| Part | Geometry | Keys |
|---|---|---|
| `fill` | polygon | `color`, `opacity`, `pattern`, `pattern_color`, `pattern_spacing`, `pattern_width` |
| `outline` | polygon, point | `color` (or `"fill"`: the fill color on polygons, the marker color on points), `width`, `opacity`; `dash` on polygons only |
| `line` | line | `color`, `width`, `opacity`, `dash`, `cap`, `join`, `offset`, `blur` |
| `casing` | line | `color`, `width` (extra on each side), `opacity` |
| `arrows` | line | `placement`, `direction`, `spacing`, `size`, `color` |
| `marker` | point | `shape`, `color`, `fill`, `size`, `opacity`, `icon`, `icon_color`, `rotation`, `anchor`, `offset`, `allow_overlap` |
| `label` | all | `text`, `format`, `formats`, `size`, `color`, `halo`, `font`, `placement`, `offset`, `max_width`, `lines`, `priority`, `allow_overlap` |

Every part also takes `min_zoom` and `max_zoom`.

**Absent and switched parts:**

- **In `symbol`:** an absent part is off, except the geometry's main part (`fill`, `line`, `marker`), which is drawn
  with its defaults when absent. `false` switches any part off.
- **In a class record or a rule:**
  - an absent part is unchanged;
  - `false` switches it off;
  - an object switches it on. Its keys are merged over the part's value so far (base, then earlier overrides), and
    keys that nothing set take their defaults from the reference.

### 3.1 Fill and outline (polygons)

> "Districts in light green at 70% with a 1 px white border."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#a1d99b", "opacity": 0.7 },
    "outline": { "color": "#ffffff", "width": 1, "opacity": 1, "dash": "solid" }
  }
}
```

`dash` takes `solid`, `dashed`, `dotted`, `dash_dot`. Dash lengths scale with the width in MapLibre, so a dashed 4 px
line has longer dashes than a dashed 1 px line.

> "Outline only, in the color each feature's class gives it."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "fill": false,
    "outline": { "color": "fill", "width": 2 }
  },
  "classify": [
    {
      "field": "land_use",
      "method": "categories",
      "classes": [
        { "values": ["residential"], "fill": { "color": "#e6ab02" } },
        { "values": ["green"], "fill": { "color": "#66a61e" } }
      ],
      "other": { "fill": { "color": "#9aa3ad" } }
    }
  ]
}
```

`outline.color: "fill"` takes the fill color each feature would have (from the base, its class and the rules), even
when the fill itself is switched off.

> "Planned areas hatched in red on a light red tint, protected areas cross-hatched in green."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#deebf7", "opacity": 0.6 }, "outline": { "color": "#636363", "width": 1 } },
  "classify": [
    {
      "id": "use",
      "field": "land_use",
      "method": "categories",
      "classes": [
        { "id": "mixed", "values": ["mixed"], "name": "Planned", "fill": { "color": "#fcbba1", "opacity": 0.4, "pattern": "hatch_45", "pattern_color": "#cb181d" } },
        { "id": "green", "values": ["green"], "name": "Protected", "fill": { "color": "#c7e9c0", "opacity": 0.4, "pattern": "cross", "pattern_color": "#238b45" } }
      ]
    }
  ]
}
```

- `pattern`: `none` (no pattern; a class uses it to switch off the base's pattern), `hatch_45` (diagonal lines),
  `hatch_135` (the other diagonal), `vertical`, `horizontal` (lines), `cross` (cross hatch), `grid`, `dots`. The
  pattern is drawn on top of the fill, in `pattern_color` (default: the fill color), at full opacity. For a hatch
  without a tint, set the fill `opacity` to 0.
- `pattern_spacing`: the distance between lines (or dots) in px, default 10; `pattern_width`: a line's width (or a
  dot's diameter) in px, default 2. Each look is an image of its own, so both switch at zoom stops and per class, but
  take no continuous mapping by attribute.
- Patterns can vary per feature, so classes and rules can set them.

### 3.2 Line, casing and arrows (lines)

> "Cycle routes in blue with a white edge, round ends, shifted 2 px so both directions show, arrows in the middle."

<!-- check: routes -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "line": { "color": "#2166ac", "width": 3, "opacity": 1, "cap": "round", "join": "round", "offset": 2 },
    "casing": { "color": "#ffffff", "width": 1.5, "opacity": 1 },
    "arrows": { "placement": "center", "direction": "forward", "size": 12 }
  }
}
```

- `cap`: `butt`, `round`, `square`. `join`: `miter`, `round`, `bevel`. `offset` shifts the line sideways (positive is
  right of the drawing direction, negative left).
- `casing.width` is the extra width on each side; the casing is drawn under the line and shifted with it.
- `arrows.placement`:
  - `repeat` places arrows along the line every `spacing` px (at least 1);
  - `center`, `start`, `end` and `both_ends` place one arrow per feature, at points the tile service computes from
    the whole line (section 16), not per tile piece.

  `direction`: `forward`, `backward`, `both`. Without `color` the arrows take the line color.

> "Square ends, sharp corners, a soft glow, red arrows at both ends pointing both ways."

<!-- check: routes -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "line": { "color": "#2166ac", "width": 4, "cap": "square", "join": "miter", "blur": 1.5 },
    "arrows": { "placement": "both_ends", "direction": "both", "size": 12, "color": "#d7301f" }
  }
}
```

> "Flat ends, beveled corners, one arrow at the end pointing back to the start."

<!-- check: routes -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "line": { "color": "#2166ac", "width": 4, "cap": "butt", "join": "bevel" },
    "arrows": { "placement": "end", "direction": "backward", "size": 14 }
  }
}
```

> "Arrows every 150 px along the line, one at the start."

<!-- check: routes -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "line": { "color": "#2166ac", "width": 3 },
    "arrows": { "placement": "repeat", "spacing": 150, "size": 10 }
  }
}
```

<!-- check: routes -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "line": { "color": "#2166ac", "width": 3 },
    "arrows": { "placement": "start", "size": 12 }
  }
}
```

### 3.3 Marker (points)

> "Schools as dark green circles of 8 px with a white outline."

<!-- check: schools -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8, "opacity": 0.9 },
    "outline": { "color": "#ffffff", "width": 1 }
  }
}
```

> "Facilities as a white icon on an orange circle."

<!-- check: facilities -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "marker": { "shape": "circle", "color": "#f28e2b", "size": 18, "icon": "goat:star-solid", "icon_color": "#ffffff" },
    "outline": { "color": "#ffffff", "width": 1.5 }
  }
}
```

> "Traffic counters as arrows on their own, pointing in the direction of travel, tip on the point."

<!-- check: counters -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "marker": {
      "shape": "icon",
      "icon": "goat:arrow-up-solid",
      "color": "#3a3541",
      "size": 16,
      "rotation": { "field": "bearing" },
      "anchor": "bottom",
      "allow_overlap": true
    }
  }
}
```

> "Stops as hollow green rings, 2 px wide."

<!-- check: schools -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "marker": { "shape": "circle", "color": "#1a6b4d", "size": 10, "fill": false },
    "outline": { "color": "fill", "width": 2 }
  }
}
```

> "A pin icon whose tip sits 2 px above the point, in the uploaded company logo."

<!-- check: facilities -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "icon", "icon": "asset:7f3a91c2", "size": 24, "anchor": "bottom", "offset": [0, -2] } }
}
```

- `shape`: a shape the icon sits in, a pin, or `icon`:
  - shapes: `circle` (with `icon`, the icon is drawn on it in `icon_color`), `square` (rounded corners, a fifth of its
    side), `diamond`, `hexagon`, `shield`;
  - pins, which point at their place with their tip: `pin`, `round_pin`, `needle`, `square_pin`, `tag_pin`, `flag`
    (its pole stands on the place). A pin is anchored at its tip unless `anchor` is set; the icon sits in its head;
  - `icon`: the icon alone, tinted with `color`; uploads and emoji keep their own colors.

  A marker with a shape is one image (its shape, stroke and icon), so overlapping points stack as whole markers; it
  draws where it collides unless `allow_overlap` is false. Classes and rules may set their own shape or pin; the icon
  alone is the whole layer's (`override_not_per_feature` otherwise, also for a shape on a class of an icon alone).
  The outlines live in the web client (`lib/style/markerShapes.ts`), each in a 24 by 24 box the marker's size fills.
- `fill: false` draws the marker hollow: a circle, shape or pin draws its outline only, and its icon if it has one.
  The outline is what shows, so a hollow marker usually has one, often in the marker color (`"color": "fill"`);
  without an outline only the icon and the label show. The icon on a hollow marker takes the marker color unless
  `icon_color` is set. `fill` is a switch, not a value by zoom or attribute; classes and rules may set it, and the icon
  alone ignores it. Default `true`.
- `size` is the circle diameter or the icon height in px.
- `rotation` is in degrees clockwise from north: the icon turns with the map.
- `anchor`: the point of the icon that sits on the feature: `center`, `top`, `bottom`, `left`, `right`, `top_left`,
  `top_right`, `bottom_left`, `bottom_right` (the panel offers `center` and `bottom`).
- `offset` is `[x, y]` in px.
- `allow_overlap: true` draws icons even where they collide with other symbols. Circles never collide.
- `outline` on points draws around the circle. On `shape: icon` it is a halo around library icons, which needs SDF
  icons with a buffer (16). Uploaded icons get no outline (`outline_not_drawn`, info). Point outlines cannot be
  dashed (`dash_on_point_outline`).

<!-- check: schools -->
<!-- expect: dash_on_point_outline -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 }, "outline": { "color": "#ffffff", "width": 1, "dash": "dashed" } }
}
```

### 3.4 Label

> "District name inside each district, bold, with a white halo, from zoom 11."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#deebf7" },
    "outline": { "color": "#ffffff", "width": 1 },
    "label": {
      "text": "{name}",
      "size": 12,
      "color": "#3a3541",
      "font": { "weight": "bold" },
      "halo": { "color": "#ffffff", "width": 1.5 },
      "placement": "inside",
      "min_zoom": 11
    }
  }
}
```

> "Name in bold and the area as '2.9 km²' in a smaller grey line under it; larger districts win when labels collide."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#deebf7" },
    "label": {
      "text": "{name}\n{area_km2} km²",
      "format": { "decimals": 1 },
      "size": 12,
      "max_width": 120,
      "lines": [{ "font": { "weight": "bold" } }, { "size": 10, "color": "#6b7280" }],
      "halo": { "color": "#ffffff", "width": 1.5 },
      "placement": "inside",
      "priority": { "field": "area_km2", "top": "largest" },
      "allow_overlap": false
    }
  }
}
```

> "Counters labeled with the year and the vehicles, abbreviated, without a separator in the year."

<!-- check: counters -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "marker": { "shape": "circle", "color": "#283593", "size": 8 },
    "label": {
      "text": "{year}: {vehicles} vehicles",
      "format": { "abbreviate": true, "decimals": "auto" },
      "formats": { "year": { "thousands_separator": false, "decimals": 0 } },
      "placement": "auto",
      "offset": [0, 4]
    }
  }
}
```

- `text` is a template. Its grammar:
  - `{field name}` is replaced by the feature's value; everything else is literal;
  - `\n` breaks the line;
  - `\{` and `\}` are literal braces;
  - a plain field label is `"{name}"`.
- `format` applies to every number field in the template; `formats` overrides it per field. Text fields are never
  formatted. When neither is set, the field's own number format from the dataset applies.
- `placement` depends on the geometry:
  - points: `auto` (MapLibre tries positions around the marker), `above`, `center`;
  - lines: `line` (along the line, repeated) or `center` (one label per line, at a point from the tile service);
  - polygons: `inside` (one label per polygon, at a point inside it from the tile service).
- `offset` is `[x, y]` in px. `max_width` wraps lines longer than this many px.
- `lines` styles the lines of the template in order: `size`, `color`, `font`. Lines without an entry keep the label's
  style. The panel edits `lines` later; the format has it now.
- `priority`: `{ "field", "top": "largest" | "smallest" }` decides which label wins a collision.
- `font.weight`: `regular` or `bold`. Fonts come from GOAT's own glyphs (section 19, pending decision).

<!-- check: districts -->
<!-- expect: template_syntax -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#deebf7" }, "label": { "text": "{{ name }}" } }
}
```

> "School names above their circles; this layer has no popup."

<!-- check: schools -->
```json
{
  "version": 1,
  "kind": "vector",
  "geometry": "point",
  "symbol": {
    "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 },
    "label": { "text": "{name}", "size": 11, "placement": "above", "offset": [0, -2] }
  },
  "popup": { "enabled": false }
}
```

### 3.5 Zoom ranges

> "The layer from zoom 8; fill only from zoom 12 to 18, outline always, labels from zoom 13."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "min_zoom": 8,
  "symbol": {
    "fill": { "color": "#9ecae1", "min_zoom": 12, "max_zoom": 18 },
    "outline": { "color": "#3182bd", "width": 1 },
    "label": { "text": "{name}", "min_zoom": 13 }
  }
}
```

A feature's part is drawn at zoom z when z lies in all three ranges:

- **the layer range:** the top-level `min_zoom` and `max_zoom`;
- **the part range:** `min_zoom` and `max_zoom` on the part;
- **the feature range:** the last `min_zoom` and `max_zoom` set by a matching class or rule, in precedence order
  (6.1); default 0 to 24.

A class or rule can only narrow what the layer and part allow: a class with `min_zoom: 5` on a layer from zoom 8 shows
its features from zoom 8.

- Layer and part ranges compile to MapLibre layer `minzoom`/`maxzoom` and may be fractional.
- Feature ranges compile to filters. MapLibre evaluates those once per tile at the tile's whole zoom, so class and rule
  zooms must be whole numbers (`zoom_not_whole`).
- A part range inside a class record (`"label": { "min_zoom": 15 }`) is also a feature range of that part, and also
  whole.

<!-- check: routes -->
<!-- expect: zoom_not_whole -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "line": { "color": "#2166ac", "width": 3 } },
  "classify": [{ "field": "status", "method": "categories", "classes": [{ "values": ["planned"], "min_zoom": 12.5 }] }]
}
```

## 4. Values

A color or number is **fixed**, **by zoom** or **by attribute**. **By classes** is a classification that sets the
property (section 5). Which forms a property allows comes from MapLibre (4.5); others are `value_form_not_allowed`.

### 4.1 Fixed

`"color": "#2166ac"`, `"width": 3`, `"dash": "dashed"`.

### 4.2 By zoom

> "Routes 1 px at zoom 9, 3 px at 13, 10 px at 17, growing faster when zoomed in; darker when zoomed in."

<!-- check: routes -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "line": {
      "width": { "zoom": [[9, 1], [13, 3], [17, 10]], "interpolate": "exponential", "base": 1.6 },
      "color": { "zoom": [[10, "#9ecae1"], [14, "#2166ac"], [17, "#08306b"]], "interpolate": "linear" }
    }
  }
}
```

- `zoom`: at least two `[zoom, value]` stops in ascending zoom order (`zoom_stops`).
- `interpolate`: `linear` (default), `exponential` (with `base`, default 1.6, faster towards higher zooms), or `step`
  (the value switches at each stop). Colors interpolate too.
- Below the first stop the first value applies, above the last stop the last value.

> "Dotted outlines when zoomed out, dashed from 13, solid from 16."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#deebf7" },
    "outline": {
      "color": "#3182bd",
      "dash": { "zoom": [[10, "dotted"], [13, "dashed"], [16, "solid"]], "interpolate": "step" }
    }
  }
}
```

Choices (dash, line ends, corners, font, anchor, pattern) and icons only switch at stops: `interpolate` must be
`step` (`zoom_needs_step`).

> "Facilities as a white dot on an orange circle when zoomed out, a star from zoom 15."

<!-- check: facilities -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "marker": {
      "shape": "circle",
      "color": "#f28e2b",
      "size": { "zoom": [[11, 10], [15, 18]] },
      "icon": { "zoom": [[11, "goat:circle-solid"], [15, "goat:star-solid"]], "interpolate": "step" },
      "icon_color": "#ffffff"
    }
  }
}
```

<!-- check: facilities -->
<!-- expect: zoom_needs_step -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "icon", "color": "#f28e2b", "icon": { "zoom": [[11, "goat:circle-solid"], [15, "goat:star-solid"]] } } }
}
```

### 4.3 By attribute

> "Districts colored by density on a continuous ramp; outline width by population."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "fill": { "color": { "field": "density", "palette": "colorbrewer:YlGnBu" }, "opacity": 0.8 },
    "outline": { "color": "#ffffff", "width": { "field": "population", "range": [0.5, 4], "scale": "linear" } }
  }
}
```

> "School circles sized by pupils between 0 and 1,500 (by area, not radius), reversed palette by pupils; schools
> without a number in grey."

<!-- check: schools -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "marker": {
      "shape": "circle",
      "size": { "field": "pupils", "domain": [0, 1500], "range": [0, 24], "scale": "sqrt", "title": "Pupils" },
      "color": { "field": "pupils", "palette": "d3:viridis", "reverse": true, "no_data": "#bdbdbd" }
    }
  }
}
```

> "Route width by traffic, on a log scale because a few routes carry most of it."

<!-- check: routes -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "line": { "color": "#2166ac", "width": { "field": "traffic", "range": [1, 8], "scale": "log" } } }
}
```

- **Output:** colors take a `palette` (+ `reverse`); numbers take `range: [at domain start, at domain end]`. Both
  take a `scale`: `linear` (the default), `sqrt` or `log`; on a color it decides how the palette spreads over the
  values (`sqrt` and `log` give the low values more of it). Formulas are in 5.8.
- **`domain`** is the input range `[from, to]`:
  - when the author sets it, it is fixed;
  - when it is absent, the server computes it from the data (`computed.domain`, section 12) and keeps it current;
  - values outside the domain take the end values.
- **`sqrt`** makes areas proportional only when the domain and the range both start at 0, as in the schools example.
- **`no_data`** is the value for features where the field is missing or not a number (default: the property's base
  value, that is its default from the reference).
- **`title`** names the legend section (default: the field's display name).
- **Field values used as they are:** without `palette` or `range` the field's value is used directly: degrees for
  `rotation` (3.3), or hex colors from a text field.

### 4.4 By zoom, with attribute values in the stops

> "Circles sized by pupils, twice as large at zoom 16 as at zoom 11."

<!-- check: schools -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "marker": {
      "shape": "circle",
      "color": "#1a6b4d",
      "size": {
        "zoom": [
          [11, { "field": "pupils", "range": [3, 10], "scale": "sqrt" }],
          [16, { "field": "pupils", "range": [6, 20], "scale": "sqrt" }]
        ],
        "interpolate": "linear"
      }
    }
  }
}
```

This is the only nesting: zoom outside, attribute inside (MapLibre accepts `["zoom"]` only as the input of a top-level
`interpolate` or `step`). The opposite nesting is `zoom_nesting`.

### 4.5 What each property allows

Taken from MapLibre's style spec; goatlib's `style/data/maplibre_limits.json` holds the table it enforces. Fixed is
always allowed. **Per feature** means
classes and rules may set the property for some features; **per layer** properties hold one value for the whole layer
and may be set in one place only (6.1).

| Property | By zoom | By attribute | By classes and rules |
|---|---|---|---|
| fill `color`, `opacity`, `pattern_color`; line `color`, `width`, `opacity`, `offset`, `blur`; outline and casing `color`, `width`, `opacity` | blend | yes | per feature |
| marker `color`, `size`, `opacity`, `icon_color`, `rotation`; arrows `size`, `color` | blend | yes | per feature |
| label `size`, `color`, `halo.color`, `halo.width`, `max_width` | blend | yes | per feature |
| `dash`, `join`, fill `pattern`, `pattern_spacing`, `pattern_width`, marker `anchor`, marker `icon`, label `font.weight`, label `text` | steps | no | per feature |
| line `cap` | steps | no | per feature from MapLibre 6, per layer before |
| marker `offset`, label `offset` | blend | no | per feature (circles: per layer, see below) |
| arrows `spacing` | blend | no | per layer |
| layer `opacity`, heatmap `intensity`, raster settings | blend | no | per layer |
| marker `fill` | no | no | per feature |
| marker `shape`, `allow_overlap`; arrows `placement`, `direction`; label `placement`, `lines`, `priority`, `allow_overlap`, `format`, `formats` | no | no | per layer |

- MapLibre cannot move circles per feature (`circle-translate` takes no data), so a circle marker moves by the base
  `offset` only; offsets in classes and rules move icons and labels.

### 4.6 Opacity

The opacity a viewer sees is layer `opacity` x part `opacity` x the alpha of the color. A class or rule `opacity`
replaces the part's opacity (it does not multiply). In MapLibre:

- For fills and lines the layer opacity becomes `fill-layer-opacity` and `line-layer-opacity` (MapLibre 6), so
  overlapping lines of one layer do not get darker. These composite one MapLibre layer: a polygon's fill and outline
  still blend with each other.
- Circles, icons and labels have no layer opacity: the layer opacity is multiplied into each part, so overlaps get
  darker and an icon on a circle fades twice.
- An icon's outline is MapLibre's icon halo, which has no opacity: an outline that is off (opacity 0) draws no halo,
  any other opacity draws it fully.
- Hillshade has no opacity: the layer opacity goes into the alpha of the shadow, highlight and accent colors.

## 5. Classifications

A classification takes one field, splits the features into **classes**, and each class record changes parts. One
classification is one legend section.

- `target` names the property that `palette` (colors) or `range` (numbers) fills when classes are generated. Default:
  the geometry's main color (`fill.color`, `line.color`, `marker.color`).
- A target path is `part.key` or `part.key.subkey` (`label.halo.color`) and must be per feature (4.5).
- Class records may set other keys as well. Conflicts are computed on the keys the records actually set (5.7).

### 5.1 Categories

> "Facilities by type, each type its own color and icon, libraries and museums together as Culture; the rest as
> Other; facilities without a type hidden."

<!-- check: facilities -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#9aa3ad", "size": 16, "icon_color": "#ffffff" } },
  "classify": [
    {
      "id": "type",
      "title": "Facility type",
      "field": "type",
      "method": "categories",
      "classes": [
        { "values": ["library", "museum"], "name": "Culture", "marker": { "color": "#b07aa1", "icon": "goat:museum" } },
        { "values": ["park"], "name": "Park", "marker": { "color": "#59a14f", "icon": "goat:park" } },
        { "values": ["pool"], "name": "Pool", "marker": { "color": "#4e79a7", "icon": "goat:swimming" } },
        { "values": ["health"], "name": "Health", "marker": { "color": "#e15759", "icon": "goat:hospital" } },
        { "values": ["kindergarten"], "name": "Kindergarten", "marker": { "color": "#f28e2b", "icon": "goat:playground" } }
      ],
      "other": { "name": "Other", "marker": { "color": "#9aa3ad" } },
      "no_data": { "visible": false }
    }
  ]
}
```

- **Classes:** a class lists one or more `values`. A value may appear in one class only (`category_duplicate`). One class
  can change several parts at once (color and icon here).
- **The class list is authoritative:**
  - values in no class go to `other`, or keep the base look when there is no `other`;
  - `no_data` styles features without a value;
  - `count` is only used when the server generates the classes: the panel or the AI writes `count` and no `classes`,
    and the server writes the `count` most frequent values as classes.
- **Comparison:** values compare as text when the field is not a text or whole-number field (booleans, decimals):
  `["true"]`, `["2.5"]`.
- **Names:** `name` is the legend text. The default is the values joined with ", ".

> "One-way routes darker."

<!-- check: routes -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "line": { "color": "#6baed6", "width": 3 } },
  "classify": [
    { "field": "oneway", "method": "categories", "classes": [{ "values": ["true"], "name": "One-way", "line": { "color": "#08519c" } }] }
  ]
}
```

<!-- check: facilities -->
<!-- expect: category_duplicate -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#9aa3ad", "size": 12 } },
  "classify": [
    {
      "field": "type",
      "method": "categories",
      "classes": [
        { "values": ["library", "museum"], "marker": { "color": "#b07aa1" } },
        { "values": ["museum"], "marker": { "color": "#7f3c8d" } }
      ]
    }
  ]
}
```

### 5.2 Numeric classes, computed by the server

> "Districts in five quantile classes by density."

What the panel or the AI writes (the intent):

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#cccccc", "opacity": 0.8 }, "outline": { "color": "#ffffff", "width": 1 } },
  "classify": [
    { "title": "Inhabitants per km²", "field": "density", "method": "quantile", "count": 5, "palette": "colorbrewer:OrRd" }
  ]
}
```

What the server stores after computing the classes:

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#cccccc", "opacity": 0.8 }, "outline": { "color": "#ffffff", "width": 1 } },
  "classify": [
    {
      "id": "density",
      "title": "Inhabitants per km²",
      "field": "density",
      "method": "quantile",
      "count": 5,
      "palette": "colorbrewer:OrRd",
      "classes": [
        { "id": "c1", "to": 2800, "fill": { "color": "#fef0d9" } },
        { "id": "c2", "from": 2800, "to": 3600, "fill": { "color": "#fdcc8a" } },
        { "id": "c3", "from": 3600, "to": 4300, "fill": { "color": "#fc8d59" } },
        { "id": "c4", "from": 4300, "to": 6300, "fill": { "color": "#e34a33" } },
        { "id": "c5", "from": 6300, "fill": { "color": "#b30000" } }
      ],
      "computed": {
        "at": "2026-10-23T10:00:00Z",
        "data": "sample-v1",
        "scope": "dataset",
        "generated": {
          "target": "fill.color",
          "values": { "c1": "#fef0d9", "c2": "#fdcc8a", "c3": "#fc8d59", "c4": "#e34a33", "c5": "#b30000" }
        }
      }
    }
  ]
}
```

- **Methods:** `quantile`, `equal_interval`, `natural_breaks`, `std_dev`, `heads_and_tails`, `manual`, `categories`
  (formulas in 5.8).
- **Classes:** a class covers `from` (inclusive) to `to` (exclusive); the first has no `from`, the last no `to`. Classes
  are sorted, without gaps or overlaps (`classes_invalid`).
- **What the server writes for computed methods:** `classes` with `from` and `to`, plus `computed`:
  - `at`: when;
  - `data`: the data fingerprint;
  - `scope`: always `dataset`, the whole unfiltered dataset over all times.
- **When the data changes,** the classes are recomputed on the next read (section 12), and the `from` and `to` of
  each class are replaced by position. Everything else a class carries survives when `count` is unchanged: hand-picked
  colors, names, `visible`, zooms, part overrides. A new `count` rebuilds the classes from the palette.
- **Moving a break by hand** turns the method into `manual`, which is never recomputed.

> "Fill by density around its mean (standard deviations, on a diverging palette); outline width by population in
> natural breaks."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#cccccc" }, "outline": { "color": "#636363", "width": 1 } },
  "classify": [
    { "title": "Density", "field": "density", "method": "std_dev", "count": 4, "palette": "colorbrewer:RdBu", "reverse": true },
    { "title": "Population", "field": "population", "method": "natural_breaks", "count": 3, "target": "outline.width", "range": [0.5, 3] }
  ]
}
```

> "Population in head/tail breaks, on my own three colors."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#cccccc" } },
  "classify": [
    { "title": "Population", "field": "population", "method": "heads_and_tails", "count": 3, "palette": ["#fee8c8", "#fdbb84", "#e34a33"] }
  ]
}
```

### 5.3 Manual classes with names, a unit and a number format

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#cccccc", "opacity": 0.85 }, "outline": { "color": "fill", "width": 1 } },
  "classify": [
    {
      "title": "Population",
      "unit": "inhabitants",
      "format": { "decimals": 0, "thousands_separator": true },
      "field": "population",
      "method": "manual",
      "classes": [
        { "to": 10000, "name": "Small", "fill": { "color": "#fff7ec" } },
        { "from": 10000, "to": 15000, "name": "Medium", "fill": { "color": "#fdd49e" } },
        { "from": 15000, "to": 20000, "name": "Large", "fill": { "color": "#fc8d59" } },
        { "from": 20000, "name": "Very large", "fill": { "color": "#b30000" } }
      ]
    }
  ]
}
```

`format` here formats the class ranges in the legend ("10,000 to 15,000 inhabitants").

<!-- check: districts -->
<!-- expect: classes_invalid -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#cccccc" } },
  "classify": [
    {
      "field": "population",
      "method": "manual",
      "classes": [
        { "to": 15000, "fill": { "color": "#fff7ec" } },
        { "from": 10000, "to": 20000, "fill": { "color": "#fdd49e" } },
        { "from": 20000, "fill": { "color": "#b30000" } }
      ]
    }
  ]
}
```

### 5.4 Classes for any property

> "Outline width in four classes by population; outline dash by land use."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#deebf7" }, "outline": { "color": "#3182bd", "width": 1 } },
  "classify": [
    {
      "title": "Population",
      "field": "population",
      "method": "equal_interval",
      "count": 4,
      "target": "outline.width",
      "range": [0.5, 4],
      "classes": [
        { "to": 11000, "outline": { "width": 0.5 } },
        { "from": 11000, "to": 16000, "outline": { "width": 1.7 } },
        { "from": 16000, "to": 21000, "outline": { "width": 2.8 } },
        { "from": 21000, "outline": { "width": 4 } }
      ],
      "computed": { "at": "2026-10-23T10:00:00Z", "data": "sample-v1", "scope": "dataset" }
    },
    {
      "title": "Main land use",
      "field": "land_use",
      "method": "categories",
      "target": "outline.dash",
      "classes": [
        { "values": ["residential"], "name": "Residential", "outline": { "dash": "solid" } },
        { "values": ["mixed"], "name": "Mixed", "outline": { "dash": "dashed" } },
        { "values": ["green"], "name": "Green", "outline": { "dash": "dotted" } }
      ],
      "other": { "name": "Other", "outline": { "dash": "dash_dot" } }
    }
  ]
}
```

`target` can be any per-feature property (4.5). Numbers take `range`, colors `palette`, choices one value per class.

### 5.5 Class records change parts, visibility and zooms

> "Planned routes dashed and faded, without the white edge, and only from zoom 13."

<!-- check: routes -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "line": { "color": "#2166ac", "width": 3 },
    "casing": { "color": "#ffffff", "width": 1.5 }
  },
  "classify": [
    {
      "title": "Route status",
      "field": "status",
      "method": "categories",
      "classes": [
        { "values": ["existing"], "name": "Existing" },
        { "values": ["planned"], "name": "Planned", "min_zoom": 13, "line": { "dash": "dashed", "opacity": 0.6 }, "casing": false }
      ]
    }
  ]
}
```

- A class record stores only what differs (merge rules in 3 and 6.1).
- `visible: false` hides the class's features; `legend: false` leaves the class out of the legend.
- A class that changes nothing still gets its legend entry ("Existing").

### 5.6 Several classifications

> "Schools colored by type, planned schools outlined red, size by pupils, small schools on top."

<!-- check: schools -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "marker": { "shape": "circle", "color": "#999999", "size": { "field": "pupils", "range": [4, 18], "scale": "sqrt" } },
    "outline": { "color": "#ffffff", "width": 1 }
  },
  "classify": [
    {
      "title": "School type",
      "field": "type",
      "method": "categories",
      "classes": [
        { "values": ["primary"], "name": "Primary", "marker": { "color": "#1b9e77" } },
        { "values": ["secondary"], "name": "Secondary", "marker": { "color": "#d95f02" } }
      ],
      "other": { "name": "Other", "marker": { "color": "#7570b3" } }
    },
    {
      "title": "Status",
      "field": "status",
      "method": "categories",
      "target": "outline.color",
      "classes": [
        { "values": ["planned"], "name": "Planned", "outline": { "color": "#d7301f", "width": 2.5 } }
      ]
    }
  ],
  "order": { "field": "pupils", "top": "smallest" }
}
```

### 5.7 Two classifications that set the same key

A later classification wins for the features it covers. The validator compares the keys the class records set:

- **Full cover:** the later classification sets the key for every feature (it has an `other` that sets it, or covers
  every value or the whole number range). The earlier one has no visible effect for that key:
  `classify_target_conflict`, a warning.
- **Partial cover:** the earlier one still shows where the later one has no class: `classify_partial_overlap`, an
  info naming the overlap.

<!-- check: districts -->
<!-- expect: classify_target_conflict -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#cccccc" } },
  "classify": [
    { "field": "density", "method": "manual",
      "classes": [{ "to": 3600, "fill": { "color": "#fdcc8a" } }, { "from": 3600, "fill": { "color": "#e34a33" } }] },
    { "field": "land_use", "method": "categories",
      "classes": [{ "values": ["green"], "fill": { "color": "#66c2a5" } }, { "values": ["mixed"], "fill": { "color": "#fc8d62" } }],
      "other": { "fill": { "color": "#8da0cb" } } }
  ]
}
```

<!-- check: districts -->
<!-- expect: classify_partial_overlap -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#cccccc" } },
  "classify": [
    { "field": "density", "method": "manual",
      "classes": [{ "to": 3600, "fill": { "color": "#fdcc8a" } }, { "from": 3600, "fill": { "color": "#e34a33" } }] },
    { "field": "land_use", "method": "categories",
      "classes": [{ "values": ["green"], "name": "Green space", "fill": { "color": "#66c2a5" } }] }
  ]
}
```

The second example is fine on purpose (density colors, green spaces always green). The first wants the earlier
classification pointed at a free property (`"target": "outline.color"`) or removed. Combining two fields into one color
is a bivariate classification (not in 1.0).

### 5.8 Formulas

The Python implementation in goatlib is the reference. The compiler and the legend use the stored results, never a
formula of their own.

**Scales** (value forms by attribute, 4.3). Notation: input v, domain [d0, d1], output range [r0, r1].

| Scale | t | Output |
|---|---|---|
| `linear` | (v - d0) / (d1 - d0), clamped to 0 to 1 | r0 + t x (r1 - r0) |
| `sqrt` | (sqrt(v) - sqrt(d0)) / (sqrt(d1) - sqrt(d0)), clamped; v < 0 is no data | same |
| `log` | (ln v - ln d0) / (ln d1 - ln d0), clamped; v <= 0 is no data; d0 must be > 0 (`domain_invalid`) | same |

- A palette spreads its colors evenly over t = 0 to 1 and blends in Lab between them.
- A domain with d0 = d1 gives every feature the start value. A reversed domain (d0 > d1) is the same scale the other
  way round. A `sqrt` domain starting below 0 starts at 0; a `log` domain that does not start above 0 draws the start
  value until it is fixed.

**Classification methods.** Input: the non-null values of the field over the whole dataset (12).

| Method | Breaks |
|---|---|
| `quantile` | the k/count quantiles, k = 1 to count - 1 (linear interpolation, as numpy's default); equal breaks merge, so fewer classes can result (info `classes_merged`) |
| `equal_interval` | min + k x (max - min) / count, over the data's min and max (not the domain) |
| `natural_breaks` | Jenks (Fisher's exact optimization) on at most 10,000 values, sampled by feature id when there are more |
| `std_dev` | classes one standard deviation wide around the mean; an even count puts a break at the mean, an odd count centers the middle class on it (mean +- 0.5 sd); the outer classes are open |
| `heads_and_tails` | split at the mean, then repeat on the part above the mean while it holds under 40% of the values, up to count classes |
| `manual` | as written |

**Ranges over classes** (`range` with numeric classes): class i of n gets r0 + i x (r1 - r0) / (n - 1). Values are
rounded to 0.1, and to 0.01 for opacities.

## 6. Rules

A rule is a condition and the parts it changes, for what a classification cannot say (several fields, number
thresholds next to categories, empty values).

> "Arrows on one-way routes; quiet routes only when zoomed in; routes without a name in grey."

<!-- check: routes -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "line": { "color": "#2166ac", "width": 3 } },
  "rules": [
    {
      "id": "oneway",
      "name": "One-way",
      "when": { "op": "=", "args": [{ "property": "oneway" }, true] },
      "arrows": { "placement": "repeat", "spacing": 150, "size": 12 }
    },
    {
      "id": "quiet",
      "name": "Quiet routes",
      "legend": false,
      "when": { "op": "<", "args": [{ "property": "traffic" }, 1500] },
      "min_zoom": 14
    },
    {
      "id": "unnamed",
      "name": "Unnamed",
      "when": { "op": "isNull", "args": [{ "property": "name" }] },
      "line": { "color": "#9aa3ad" }
    }
  ]
}
```

> "Hide planned schools with fewer than 300 pupils unless they are primary or special schools."

<!-- check: schools -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 } },
  "rules": [
    {
      "name": "Small planned schools",
      "when": {
        "op": "and",
        "args": [
          { "op": "=", "args": [{ "property": "status" }, "planned"] },
          { "op": "<", "args": [{ "property": "pupils" }, 300] },
          { "op": "not", "args": [{ "op": "in", "args": [{ "property": "type" }, ["primary", "special"]] }] }
        ]
      },
      "visible": false
    }
  ]
}
```

> "Highlight every school whose name contains 'Gymnasium'."

<!-- check: schools -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 } },
  "rules": [
    { "name": "Gymnasium", "when": { "op": "like", "args": [{ "property": "name" }, "%Gymnasium%"] }, "marker": { "color": "#d95f02", "size": 12 } }
  ]
}
```

- **Operators in rules:** `and`, `or`, `not`, `=`, `<>`, `<`, `>`, `<=`, `>=`, `in` (a list), `like`, `isNull`. These
  compile to MapLibre filters and expressions.
- **Missing values:** an order comparison (`<`, `>`, `<=`, `>=`) is false for a feature without the value (or with a
  value of another type); `=` and `<>` compare as MapLibre does, so a missing value is unequal to everything. `not`
  negates the result: `not (traffic < 1500)` holds for routes without `traffic`. `isNull` tests for a missing value.
- **`like`** takes only contains (`%x%`), starts with (`x%`) and ends with (`%x`); other patterns and `_` are
  `like_pattern_unsupported`. Comparisons are case-sensitive.
- **Type checks:** a comparison must fit the field type: `operator_type_mismatch` for `<` or `>` on a text field, and
  for `=` or `<>` with a text literal on a number field.
- **What a rule takes:** `id`, `name`, `legend: false`, `when`, `visible`, `min_zoom`, `max_zoom` (whole numbers) and
  part overrides.
- **The map document's `filter`** is a different place: it runs on the server, like today's `layer_project.query`.

<!-- check: schools -->
<!-- expect: like_pattern_unsupported -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 } },
  "rules": [{ "when": { "op": "like", "args": [{ "property": "name" }, "Primary%school%"] }, "visible": false }]
}
```

<!-- check: schools -->
<!-- expect: operator_type_mismatch -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 } },
  "rules": [{ "when": { "op": "=", "args": [{ "property": "pupils" }, "300"] }, "visible": false }]
}
```

### 6.1 Precedence and merging

For every feature and every part key, the value comes from, in order (the last one that sets it wins):

1. the base (`symbol`), or the reference default where the base does not set it;
2. the classifications in list order: the class the feature falls in, else `other` (a value in no class), else
   `no_data` (no value), else nothing;
3. the rules in list order, when their condition holds.

- **Merging:** an override changes only the keys it names. `false` switches a part off, and an object switches it on
  again (section 3). `visible` and the feature zoom range follow the same "last one wins". A feature that matches no
  class keeps the base.
- **Example:** in 5.6 a planned primary school gets the green from "School type", the red outline and its width from
  "Status", and its size from the base.
- **Per-feature keys** (4.5) may be set anywhere: base, classes, rules.
- **Per-layer keys** hold one value for the whole MapLibre layer: marker `shape` and `allow_overlap`; arrows
  `placement`, `direction` and `spacing`; label `placement`, `lines`, `priority`, `allow_overlap`, `format` and
  `formats`.
  - They may be set in one place only: the base, or a single class or rule.
  - The one-way rule above can set the arrows' placement because nothing else sets it.
  - Setting a per-layer key in two places is `override_not_per_feature`.

<!-- check: routes -->
<!-- expect: override_not_per_feature -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "line": { "color": "#2166ac", "width": 3 }, "arrows": { "placement": "center", "size": 12 } },
  "rules": [{ "when": { "op": "=", "args": [{ "property": "oneway" }, true] }, "arrows": { "placement": "repeat", "spacing": 120 } }]
}
```

## 7. Order, legend, time, popup

> "Counters colored by vehicles; small counts on top; one year at a time with a slider; a popup with the name, the
> vehicles per day and the year; the counter whose popup is open is highlighted."

<!-- check: counters -->
```json
{
  "version": 1,
  "kind": "vector",
  "opacity": 0.9,
  "symbol": {
    "marker": { "shape": "circle", "size": 10, "color": { "field": "vehicles", "palette": "d3:magma", "reverse": true } },
    "outline": { "color": "#ffffff", "width": 1 }
  },
  "order": { "field": "vehicles", "top": "smallest" },
  "time": { "field": "year", "step": 1 },
  "legend": { "show": true, "title": "Traffic counters", "caption": "Source: city traffic department" },
  "popup": {
    "trigger": "click",
    "highlight_active_feature": true,
    "blocks": [
      {
        "id": "fields",
        "type": "field_list",
        "attributes": [
          { "field": "name" },
          { "field": "vehicles", "label": "Vehicles per day", "format": { "decimals": 0, "thousands_separator": true } },
          { "field": "year", "format": { "thousands_separator": false } }
        ]
      }
    ]
  }
}
```

### 7.1 Order

`order` decides which features are drawn on top:

- `{ "field", "top": "smallest" | "largest" }` sorts by a field;
- `{ "by": "classes" }` puts the classes of the first classification on top in list order, then `other`, then
  `no_data`. Features matched only by rules keep their class's position.

Order works within each MapLibre layer of the part: with a circle and an icon layer, every icon is above every circle.
For labels, label `priority` decides placement and order together.

### 7.2 Legend

`legend` takes `show` (default true), `title` (default: the layer name), `caption`, and for rasters `unit`,
`min_label`, `max_label`. `"legend": false` is short for `{ "show": false }`. Classifications, classes and rules take
`legend: false` to leave themselves out.

| Construct | Legend entry |
|---|---|
| layer without classifications | one swatch with the layer name |
| classification | a section titled `title` (default: the field's display name), one entry per class in list order, then `other`, then `no_data` |
| class | its `name` (default: the values joined with ", " or the range text), a swatch of the class's parts |
| rule | its `name`, a swatch of what it changes; rules that only hide features or set zooms need `legend: false` (or show a plain entry) |
| value form with `palette` | a color ramp with the domain's ends, formatted |
| value form with `range` (sizes, widths) | three samples at the start, middle and end of the domain |
| heatmap | a ramp "Low" to "High" |
| cluster | "Clusters" with a sample, then the base and classes for single points |
| H3 | the cell value (`count`, or the field with `sum` or `mean`) as classes or a ramp |
| raster `image` | none, or the file's color table |
| raster `continuous` | a ramp or classes with the domain and `unit`; `min_label` and `max_label` replace the end values |
| raster `categorical` | one entry per class |
| raster `terrain` | "Shaded relief", plus the ramp when it has a palette |
| map service | the service's legend image for the chosen `service_style`, when it has one |

- **Range text** uses the classification's `format` and `unit`: "under 2,800", "2,800 to 3,600", "6,300 and more".
- **Zoom:** swatches of zoom-dependent values use the current map zoom on screen and the print zoom in print.

> "No legend for this layer."

<!-- check: facilities -->
```json
{ "version": 1, "kind": "vector", "symbol": { "marker": { "shape": "circle", "color": "#f28e2b", "size": 8 } }, "legend": false, "popup": false }
```

`"popup": false` is short for `{ "enabled": false }`.

### 7.3 Time

`time: { "field", "step" }` adds a time slider to the layer.

- **Integer fields** (years): the slider moves in `step` units and shows the features whose value equals the slider
  value.
- **Date fields:** `step` is `year`, `month` or `day`. The slider shows the features whose date falls in the
  selected period.
- **Slider position:** it is map state (`time.value` in the map document). Without it, the slider starts at the
  latest value.
- **Computed values** (classes, domains) are computed over all times, so colors do not jump between steps.
- **Compiling:** the time filter reads `["global-state", "<layer id>:time"]`, and the slider sets that value. Moving
  the slider makes MapLibre re-read the layer's loaded tiles, so the slider updates while dragging at a limited rate.
  Later, the same mechanism can carry other runtime switches (a scenario, a threshold) without new style keys.

### 7.4 Popup

`popup` is GOAT's popup configuration as it is today (`layer_project.properties.popup`), with three changes:

- the block type `fieldList` is written `field_list`;
- an attribute names its field with `field` (not `name`);
- the number options are the one `format` object.

Without a `popup` key a layer opens a popup on click with one field list of all fields.

| Key | Values | Default |
|---|---|---|
| `enabled` | `true`, `false` | `true` |
| `trigger` | `click`, `hover`, `click_and_hover` | `click` |
| `mode` | `simple` (blocks) or `html` (a template) | `simple` |
| `blocks` | the blocks, top to bottom (simple mode) | one `field_list` with all fields |
| `html` | an HTML template with Liquid (html mode) | empty |
| `layout` | `popup` (next to the feature), `pinned` (in a corner), `modal`, `left_sidebar`, `right_sidebar` | `popup` |
| `anchor` | `top_left`, `top_right`, `bottom_left`, `bottom_right` (pinned) | `top_right` |
| `width`, `max_height` | pixels | automatic (320 wide, at most 420 high) |
| `header` | `standard` (layer name and icon), `compact`, `none` | `standard` |
| `highlight_active_feature` | marks the feature whose popup is open; with `hover` triggers also the feature under the pointer | `true` |

The panel offers `popup` and `pinned` as layouts, as today; `modal` and the sidebars stay valid for existing styles.
The highlight compiles to `feature-state` in each part's paint (section 16), so it costs no extra layer.

| Block `type` | Keys |
|---|---|
| `field_list` | `layout` (`table`, `list`), `attributes` (empty or missing: all fields in dataset order), `collapse_after` (1 to 50, then "See N more") |
| `text` | `html`: text with `{{ field }}` values |
| `image` | `source` (`field` or `static`), `field` or `url`, `sizing` (`fit`, `fixed`, `aspect`), `height` (40 to 400 px), `aspect` (`16/9`, `4/3`, `3/2`, `1/1`, `2/3`) |
| `button` | `label`, `url_template` with `{{ field }}` values (opens in a new tab), `style` (`link`, `outlined`, `filled`), `color` |
| `badge` | `field`; `mode` `single` with `color`, or `per_value` with `palette` (value to color) and `labels` (value to text); `full_width` |
| `divider` | `thickness` (1 to 8 px), `color` |

Every block takes an optional `id`. An attribute is `{ "field", "label", "type", "format" }`. `type` (`string`,
`number`, `boolean`) is optional and comes from the dataset when absent. Dates, areas and lengths are formatted from
the dataset's field settings.

> "Facilities: the type as a colored badge, name and visitors, the photo, a short note, then a button to the opening
> hours."

<!-- check: facilities -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#f28e2b", "size": 18, "icon": "goat:marker", "icon_color": "#ffffff" } },
  "popup": {
    "trigger": "click_and_hover",
    "blocks": [
      { "id": "kind", "type": "badge", "field": "type", "mode": "per_value", "palette": { "library": "#3969ac", "pool": "#11a5c9" }, "labels": { "pool": "Swimming pool" } },
      {
        "id": "facts",
        "type": "field_list",
        "layout": "list",
        "attributes": [
          { "field": "name", "label": "Name" },
          { "field": "visitors", "label": "Visitors", "type": "number", "format": { "abbreviate": true, "always_show_sign": false, "suffix": " a year" } }
        ],
        "collapse_after": 5
      },
      { "id": "photo", "type": "image", "source": "field", "field": "photo_url", "sizing": "aspect", "aspect": "16/9" },
      { "id": "note", "type": "text", "html": "<p>{{ name }} welcomes about {{ visitors }} visitors a year.</p>" },
      { "id": "line", "type": "divider", "thickness": 1, "color": "#e0e0e0" },
      { "id": "hours", "type": "button", "label": "Opening hours", "url_template": "https://www.example.org/facilities?name={{ name }}", "style": "filled", "color": "#2bb381" }
    ],
    "header": "compact"
  }
}
```

> "A popup written as HTML: the name as a heading, visitors only when known, and the photo."

<!-- check: facilities -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#f28e2b", "size": 10 } },
  "popup": {
    "mode": "html",
    "html": "<h3>{{ name | upcase }}</h3>{% if visitors %}<p>{{ visitors }} visitors a year</p>{% endif %}<img src=\"{{ photo_url }}\" alt=\"\">",
    "width": 300,
    "max_height": 360
  }
}
```

In `html` mode:

- **The template** is Liquid: `{{ field }}` values (escaped), `{% if %}`, `{% for %}`, and filters such as
  `{{ name | upcase }}`. Syntax errors are `template_syntax`.
- **Sanitizing:** the rendered HTML is sanitized, so scripts, event handlers and embedded objects are removed.
- **Classes:** `attr-table`, `attr-field`, `attr-value`, `attr-list`, `badge`, `btn-link`, `btn-outlined` and
  `btn-filled` look like the blocks.
- **Switching modes:** switching to `html` seeds the template once from the blocks; it does not convert back.

> "A small popup with the name while hovering, no header."

<!-- check: facilities -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#f28e2b", "size": 10 } },
  "popup": { "trigger": "hover", "blocks": [{ "type": "field_list", "attributes": [{ "field": "name" }] }], "header": "none" }
}
```

> "Districts: the popup in the right sidebar, as some projects use today; the district not highlighted."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#deebf7" }, "outline": { "color": "#3182bd", "width": 1 } },
  "popup": {
    "layout": "right_sidebar",
    "highlight_active_feature": false,
    "blocks": [{ "type": "field_list", "layout": "table", "attributes": [{ "field": "name" }, { "field": "population", "format": { "thousands_separator": true } }] }]
  }
}
```

> "Districts: pinned to the top left corner; the city logo on top, the land use as a full-width badge, the population
> with a prefix."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#deebf7" }, "outline": { "color": "#3182bd", "width": 1 } },
  "popup": {
    "layout": "pinned",
    "anchor": "top_left",
    "width": 360,
    "blocks": [
      { "type": "image", "source": "static", "url": "https://www.example.org/logo.png", "sizing": "fixed", "height": 48 },
      { "type": "badge", "field": "land_use", "mode": "single", "color": "#3182bd", "full_width": true },
      { "type": "field_list", "attributes": [{ "field": "name" }, { "field": "population", "format": { "prefix": "about ", "decimals": "auto", "abbreviate": true } }] }
    ]
  }
}
```

The validator checks every field a popup names against the dataset: attributes, the image and badge fields, and the
`{{ }}` and `{% %}` values in text, button URLs and the HTML template.

<!-- check: facilities -->
<!-- expect: unknown_field -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#f28e2b", "size": 10 } },
  "popup": { "blocks": [{ "type": "button", "label": "Website", "url_template": "{{ website }}", "style": "link" }] }
}
```

## 8. How points are drawn: `render`

`render.type`: `features` (default), `heatmap`, `cluster`, `h3`. Heatmaps and H3 can hand over to the point symbol at
`points_from_zoom`: below it the render type is drawn, from it on the base symbol, classifications and rules.

### 8.1 Heatmap

> "Visitors as a heatmap at city scale, individual facilities from zoom 15."

<!-- check: facilities -->
```json
{
  "version": 1,
  "kind": "vector",
  "render": {
    "type": "heatmap",
    "radius": { "zoom": [[10, 15], [14, 40]], "interpolate": "linear" },
    "intensity": 1,
    "weight": { "field": "visitors", "domain": [0, 50000] },
    "palette": "d3:magma",
    "points_from_zoom": 15
  },
  "symbol": { "marker": { "shape": "circle", "color": "#3f007d", "size": 6 } }
}
```

- `radius` (px, at least 1), `intensity` (0.2 to 3), `opacity`, `weight` (fixed, at least 0, or by attribute over a domain), `palette`
  (+ `reverse`). The ramp starts transparent at density 0.
- A weight by attribute maps the domain to weights 0 to 1; a domain of one value weighs every feature with a value 1
  (a weight of 0 everywhere would draw nothing).
- Heatmaps draw from the layer's vector tiles; there is no feature limit.

### 8.2 Clusters

Clusters are computed **in the browser** from the layer's features, with MapLibre's GeoJSON clustering. Vector tiles
cannot be clustered without cutting clusters at tile borders, so the browser loads the points themselves:

- **What the browser loads:** id, coordinates and only the fields the style uses.
- **Limit:** layers up to 100,000 features (today's limit, a starting value until measured). Above it the validator
  answers `too_many_features_for_render` and the panel offers H3 or a heatmap.
- **How the points are read** (GeoJSON from the features API as today, or a columnar format) is an implementation
  topic, not part of the style.

> "Schools in clusters with their count, single schools from zoom 14."

<!-- check: schools -->
```json
{
  "version": 1,
  "kind": "vector",
  "render": {
    "type": "cluster",
    "radius": 50,
    "cluster_until_zoom": 14,
    "min_points": 3,
    "symbol": {
      "marker": { "shape": "circle", "color": "#283593", "size": { "field": "count", "range": [16, 40], "scale": "sqrt" } },
      "outline": { "color": "#ffffff", "width": 2 },
      "label": { "text": "{count}", "color": "#ffffff", "size": 12 }
    }
  },
  "symbol": { "marker": { "shape": "circle", "color": "#283593", "size": 8 } }
}
```

- `radius` (px, default 50), `cluster_until_zoom` (exclusive: clusters below it, single points from it; default 14),
  `min_points` (default 2).
- The cluster `symbol` styles the cluster points over the derived field `count`; single points use the base symbol,
  classifications and rules. Cluster labels sit on the cluster (`placement` is fixed).

### 8.3 H3 hexagons

H3 is computed **on the server**. geoapi serves hexagon tiles on request, like its other derived tile layers: for each
tile it groups the points of the cells the tile touches by H3 cell (DuckDB's h3 extension, which goatlib already uses)
and returns the hexagons with their value. Cells are global, so there are no seams at tile borders, values are exact,
and there is no feature limit.

> "Pupils per H3 hexagon in quantile classes, schools as points from zoom 15."

<!-- check: schools -->
```json
{
  "version": 1,
  "kind": "vector",
  "render": {
    "type": "h3",
    "resolution": "auto",
    "value": { "op": "sum", "field": "pupils" },
    "palette": "colorbrewer:OrRd",
    "classify": { "method": "quantile", "count": 5 },
    "opacity": 0.85,
    "outline": { "color": "#ffffff", "width": 1 },
    "points_from_zoom": 15
  },
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 7 } }
}
```

> "Average visitors per hexagon at a fixed resolution, continuous colors."

<!-- check: facilities -->
```json
{
  "version": 1,
  "kind": "vector",
  "render": { "type": "h3", "resolution": 8, "value": { "op": "mean", "field": "visitors" }, "palette": "d3:viridis" },
  "symbol": { "marker": { "shape": "circle", "color": "#f28e2b", "size": 8 } }
}
```

- `resolution`: `auto` (the server picks 7 up to zoom 11, 8 up to 13, 9 up to 15, then 10) or 5 to 10.
- `value`: `{ "op": "count" }` or `{ "op": "sum" | "mean", "field" }` on a number field.
- `classify`: the classification shape of 5.2 without `field` (the cell value is the input). Without it the colors are
  continuous over the value's domain.
- Computed values differ per resolution: the server stores them in `computed` keyed by resolution (section 12).
- `opacity` is the hexagons' part opacity; `outline` draws the cell borders.

## 9. Raster styles

<!-- check: elevation -->
```json
{
  "version": 1,
  "kind": "raster",
  "opacity": 0.8,
  "resampling": "linear",
  "render": { "type": "terrain", "method": "standard", "direction": 315, "altitude": 45, "exaggeration": 0.5 },
  "legend": { "show": true, "title": "Elevation", "unit": "m" }
}
```

**Top-level keys:**

- `version`, `kind: "raster"`, `opacity`, `min_zoom`, `max_zoom`, `resampling` (`linear` or `nearest`; default `linear`,
  `nearest` for categorical rasters), `render`, `legend`, `popup`;
- for `image` also the adjustments `brightness`, `contrast`, `saturation` (-1 to 1, default 0) and `hue` (degrees).

**Render types:** `image`, `continuous`, `categorical`, `terrain`. Every type takes:

- `no_data: { "values": [...] }`, cells with these values are transparent. The default is the file's own no-data
  value from the raster metadata, so most styles leave it out.
- `band`, except `image`.

The raster tile service (geoapi) colors the cells for every render type, band formulas included, and serves colored
tiles, so screen and print look the same; coloring in the browser (MapLibre `color-relief`) is a later optimization.
The style does not depend on where the cells are colored. Map services (9.8) are drawn as the service sends them; their
adjustments are MapLibre paint properties, applied in the browser on screen and in print.

### 9.1 Image

> "The satellite image as true color, a bit brighter and more saturated."

<!-- check: satellite -->
```json
{
  "version": 1,
  "kind": "raster",
  "render": { "type": "image", "bands": [1, 2, 3] },
  "brightness": 0.1,
  "contrast": 0.05,
  "saturation": 0.2,
  "hue": 0
}
```

> "False color: near infrared as red, so plants show red."

<!-- check: satellite -->
```json
{ "version": 1, "kind": "raster", "render": { "type": "image", "bands": [4, 1, 2] } }
```

> "Land cover in the file's own colors."

<!-- check: landcover -->
```json
{ "version": 1, "kind": "raster", "resampling": "nearest", "render": { "type": "image" } }
```

- `bands` maps three bands to red, green and blue (rasters with three or more bands). A single-band raster without a
  color table is drawn in grey from its lowest to its highest value.
- `brightness` b compiles to MapLibre as `raster-brightness-min = max(0, b)` and `raster-brightness-max = min(1, 1 + b)`;
  `contrast`, `saturation` and `hue` map one to one to `raster-contrast`, `raster-saturation`, `raster-hue-rotate`.

### 9.2 Color range

> "Elevation from 200 to 450 m on the elevation palette, values outside transparent."

<!-- check: elevation -->
```json
{
  "version": 1,
  "kind": "raster",
  "opacity": 0.7,
  "render": { "type": "continuous", "band": 1, "palette": "goat:elevation", "domain": [200, 450], "outside": "hide" },
  "legend": { "unit": "m" }
}
```

> "My own colors at my own values (today's color map)."

<!-- check: elevation -->
```json
{
  "version": 1,
  "kind": "raster",
  "render": {
    "type": "continuous",
    "stops": [
      { "value": 180, "color": "#1a9850" },
      { "value": 260, "color": "#d9ef8b" },
      { "value": 340, "color": "#fdae61" },
      { "value": 440, "color": "#a50026" }
    ],
    "interpolate": "linear",
    "outside": "clamp"
  }
}
```

- Either `palette` (+ `reverse`) over `domain: [from, to]` (default: the band's minimum and maximum), or `stops`
  (value and color, ascending).
- `outside`: `clamp` (values beyond take the end colors, default) or `hide`.
- `interpolate` (stops only): `linear`, or `nearest` (each cell takes the color of the closest stop, today's
  `interpolate: false`).

> "Elevation as a ramp, the legend ends labelled Low and High."

<!-- check: elevation -->
```json
{
  "version": 1,
  "kind": "raster",
  "render": { "type": "continuous", "palette": "goat:elevation" },
  "legend": { "title": "Elevation", "unit": "m", "min_label": "Low", "max_label": "High" }
}
```

### 9.3 Bands and band formulas

> "Color the near infrared band."

<!-- check: satellite -->
```json
{ "version": 1, "kind": "raster", "render": { "type": "continuous", "band": 4, "palette": "d3:viridis", "domain": [10, 230] } }
```

> "Vegetation index (NDVI) in five equal classes."

<!-- check: satellite -->
```json
{
  "version": 1,
  "kind": "raster",
  "render": {
    "type": "continuous",
    "band": { "name": "NDVI", "expression": "(b4 - b1) / (b4 + b1)" },
    "palette": "goat:green",
    "domain": [-0.4, 0.7],
    "classify": { "method": "equal_interval", "count": 5 }
  },
  "legend": { "title": "Vegetation (NDVI)" }
}
```

`band` is a band number (from 1) or a formula: `b1` to `b8`, numbers, `+ - * /` and brackets. The dataset can name
common formulas (NDVI) so the panel offers them.

### 9.4 Classes on a raster

The classification shape is the one of 5.2 without `field` (the band is the input) and with a `color` per class
instead of part records. The server fills `from`, `to` and missing colors (from the render's `palette`); what the author
sets on a class by position survives a recompute (section 12).

> "Elevation in quantile classes, my own color for the second class, the lowest named 'Valley floor', the highest
> hidden."

<!-- check: elevation -->
```json
{
  "version": 1,
  "kind": "raster",
  "render": {
    "type": "continuous",
    "palette": "goat:elevation",
    "domain": [181, 440],
    "classify": {
      "method": "quantile",
      "count": 5,
      "classes": [{ "name": "Valley floor" }, { "color": "#2bb381" }, {}, {}, { "visible": false }]
    }
  }
}
```

> "Manual breaks at 240, 275, 300 and 340 m."

<!-- check: elevation -->
```json
{
  "version": 1,
  "kind": "raster",
  "render": {
    "type": "continuous",
    "palette": "goat:elevation",
    "domain": [181, 440],
    "classify": {
      "method": "manual",
      "classes": [{ "to": 240 }, { "from": 240, "to": 275 }, { "from": 275, "to": 300 }, { "from": 300, "to": 340 }, { "from": 340 }]
    }
  }
}
```

Quantiles and natural breaks come from a sample of the band's values (its overviews), computed with the same class
break statistics as a vector field's when the style is checked (section 12).

### 9.5 Categories

> "Land cover classes with my names and colors, wetland hidden, values without a class in grey."

<!-- check: landcover -->
```json
{
  "version": 1,
  "kind": "raster",
  "opacity": 0.75,
  "resampling": "nearest",
  "render": {
    "type": "categorical",
    "band": 1,
    "classes": [
      { "value": 1, "name": "Water", "color": "#4a90c2" },
      { "value": 2, "name": "Built-up", "color": "#c0504d" },
      { "value": 3, "name": "Forest", "color": "#2e7d32" },
      { "value": 4, "name": "Farmland", "color": "#e6c35c" },
      { "value": 5, "name": "Grassland", "color": "#9ccc65" },
      { "value": 6, "name": "Wetland", "color": "#7a87c6", "visible": false }
    ],
    "other_color": "#cccccc"
  },
  "legend": { "title": "Land cover" }
}
```

### 9.6 Hillshade

> "Soft shading from several lights."

<!-- check: elevation -->
```json
{
  "version": 1,
  "kind": "raster",
  "opacity": 0.6,
  "render": { "type": "terrain", "method": "multidirectional", "direction": 315, "altitude": 45, "exaggeration": 0.6, "shadow_color": "#2d3a4a", "highlight_color": "#ffffff" }
}
```

> "Shaded relief in elevation colors, in classes, steep slopes accented."

<!-- check: elevation -->
```json
{
  "version": 1,
  "kind": "raster",
  "render": {
    "type": "terrain",
    "method": "standard",
    "direction": 315,
    "altitude": 45,
    "exaggeration": 0.5,
    "accent_color": "#000000",
    "palette": "goat:elevation",
    "domain": [181, 440],
    "classify": { "method": "equal_interval", "count": 6 }
  }
}
```

- `method`: `standard` (one light, `accent_color` for steep slopes), `multidirectional`, `combined`, `igor`, `basic`.
- `direction` (degrees the light comes from, 0 to 359), `altitude` (degrees above the horizon), `exaggeration` (0 to 1).
- With `palette` the shading lies over a color range (`domain`, `classify`, `outside` as in 9.2 and 9.4).
- The layer `opacity` goes into the alpha of the shadow, highlight and accent colors (MapLibre's hillshade has no
  opacity).

The other methods:

<!-- check: elevation -->
```json
{ "version": 1, "kind": "raster", "render": { "type": "terrain", "method": "combined", "exaggeration": 0.5 } }
```

<!-- check: elevation -->
```json
{ "version": 1, "kind": "raster", "render": { "type": "terrain", "method": "igor", "exaggeration": 0.7 } }
```

<!-- check: elevation -->
```json
{ "version": 1, "kind": "raster", "render": { "type": "terrain", "method": "basic", "shadow_color": "#000000" } }
```

### 9.7 Popup and zooms on rasters

> "Show the values of all bands on click; draw the image from zoom 10."

<!-- check: satellite -->
```json
{
  "version": 1,
  "kind": "raster",
  "min_zoom": 10,
  "render": { "type": "image", "bands": [1, 2, 3] },
  "popup": { "trigger": "click", "bands": "all" }
}
```

> "The elevation under the pointer while hovering."

<!-- check: elevation -->
```json
{
  "version": 1,
  "kind": "raster",
  "render": { "type": "continuous", "palette": "goat:elevation", "domain": [181, 440] },
  "popup": { "trigger": "hover", "bands": "styled" },
  "legend": { "unit": "m" }
}
```

A raster popup takes `enabled`, `trigger` (`click` or `hover`) and `bands`: `styled` (the band or formula the style
uses) or `all`. The values come from the raster service's point query.

### 9.8 Map services (WMS, WMTS, XYZ)

> "The state's aerial photo from its WMS, in the service's grey style, a bit lighter, from zoom 12."

<!-- check: wms -->
```json
{
  "version": 1,
  "kind": "raster",
  "opacity": 0.9,
  "min_zoom": 12,
  "render": { "type": "image", "service_style": "grey" },
  "brightness": 0.1,
  "contrast": 0.1,
  "legend": { "title": "Aerial photo 2024" }
}
```

> "An XYZ tile layer, faded and without a legend."

<!-- check: tiles -->
```json
{ "version": 1, "kind": "raster", "opacity": 0.5, "saturation": -0.6, "render": { "type": "image" }, "legend": false }
```

> "Color the WMS layer by elevation." A service sends finished pictures, so there is no band to color.

<!-- check: wms -->
<!-- expect: render_not_for_source -->
```json
{ "version": 1, "kind": "raster", "render": { "type": "continuous", "palette": "goat:elevation" } }
```

- **A map service layer** has a raster style with `render.type: "image"`. `opacity`, the zooms, `resampling` and the
  adjustments of 9.1 apply.
- **`render.service_style`** picks one of the styles the service offers (WMS `STYLES`, WMTS `Style`), from its
  capabilities; it becomes part of the tile URL. Default: the service's first style. XYZ layers have none.
- **Legend:** the service's legend image for that style (WMS `GetLegendGraphic`, WMTS `LegendURL`) when it has one.
  `title` and `caption` apply; `"legend": false` hides it.
- **Not for services** (`render_not_for_source`): `bands`, `no_data`, and the `continuous`, `categorical` and
  `terrain` renders.
- **Popup:** the service's feature info (WMS `GetFeatureInfo`) for layers the service marks as queryable, with
  `enabled` and `trigger`. Later (`not_supported_yet`, section 19); the default is no popup.
- **Where the pictures come from is not style:** `url`, `layers`, `srs`, `dpi`, `tile_size`, the service version and
  the legend URLs read from the capabilities stay in the layer's service configuration.

## 10. Named styles and the map document

**Named styles** belong to the project layer: it stores up to 10 named styles (id, name, document), one of them
active. The dataset's default style is one more style document stored on the dataset. Viewers of public maps and
dashboards can switch between named styles; their choice is view state (URL or browser), not saved.

The **map document** holds map state only: the basemap, the view, the layer tree, and per layer which named style is
active, its visibility, filter, time position and legend state. "Set as the dataset's default" and the catalog never
carry a project's map state.

<!-- check: map -->
```json
{
  "version": 1,
  "basemap": { "id": "light" },
  "view": { "center": [11.57, 48.14], "zoom": 12, "pitch": 0, "bearing": 0 },
  "locale": "de-DE",
  "layers": [
    {
      "type": "group",
      "name": "Mobility",
      "visible": true,
      "children": [
        { "type": "layer", "id": 413, "visible": true, "legend": { "expanded": false } },
        { "type": "layer", "id": 410, "visible": true, "time": { "value": 2024 } }
      ]
    },
    {
      "type": "layer",
      "id": 414,
      "visible": true,
      "style": "s1",
      "position": "below_labels",
      "filter": { "op": "<>", "args": [{ "property": "land_use" }, "green"] },
      "legend": { "expanded": true }
    }
  ]
}
```

- **Group entry:** `id` (the layer group, so a group can be shown, hidden or moved), `name`, `visible`, `expanded`
  (whether the layer tree shows it open; default true), `children`.
- **Layer entry:** `id` (project layer), `visible`, `style` (the active named style; default: the first), `position`,
  `filter` (CQL2, applied on the server, shared by all named styles), `time.value`, `legend.expanded`.
- **Order** is the list order, top first; groups nest. A layer is visible when it and all its groups are visible.
- **`position`** places the layer relative to the basemap: `top` (default), `below_labels` or `below_roads`. Every
  basemap names which of its layers start those groups, so switching the basemap keeps the placement. It compiles to
  MapLibre's `beforeId`.
- **`locale`** (optional) fixes the number and date locale for public maps, dashboards and print; otherwise the
  viewer's language is used.
- **`view`**: `center`, `zoom`, `pitch`, `bearing`, and optional `bounds` (the area the map may not leave).

## 11. Validation

Every write is checked: structure first, then against the data. Each issue has:

- `level`: `error` (blocks the write), `warning`, `info`, or `damaged` (a stored style that a later data change broke);
- `code`;
- `path`: a JSON pointer, which may use ids (`/classify/density/classes/2`);
- `message`;
- where possible a `fix` and `allowed` (the valid choices, at most 20).

```json
{
  "level": "warning",
  "code": "classify_target_conflict",
  "path": "/classify/0",
  "message": "Fill color is also set by the classification on \"land_use\", which comes later and covers every feature. This classification has no visible effect.",
  "fix": { "op": "retarget", "path": "/classify/0", "target": "outline.color" }
}
```

**Errors block only what they are about:**

- A change to a path with an error is not stored: that path keeps its current value, the rest of the write is stored,
  and the reply carries the error (13.1).
- A stored style that a data change broke (a field renamed, deleted or retyped) gets `damaged` issues. It still
  renders: the broken property takes its base value or `no_data`, and the layer shows a notice.
- Writes that do not touch the broken paths go through, so the user can still change the opacity.

**Fix operations** (closed list):

| `op` | Arguments | Does |
|---|---|---|
| `set` | `path`, `value` | sets a value |
| `remove` | `path` | removes a key or list item |
| `retarget` | `path`, `target` | points a classification at another property |
| `use_field` | `path`, `field` | replaces a field reference |
| `round` | `path` | rounds a class or rule zoom to a whole number |

**Codes:**

| Code | Level | When |
|---|---|---|
| `unknown_key` | error | a key the reference does not have |
| `missing_required` | error | a required key is missing |
| `invalid_value` | error | wrong type, value not allowed, or out of range |
| `unknown_version`, `newer_version` | error | `version` is not an integer this server knows, or newer |
| `geometry_mismatch` | error | `geometry` differs from the dataset |
| `part_not_for_geometry` | error | a part the geometry does not have (`line` on polygons) |
| `value_form_not_allowed` | error | a value form the property does not allow (4.5): by attribute on `dash`, an icon following a number field |
| `zoom_stops` | error | fewer than two stops, or stops not ascending |
| `zoom_needs_step` | error | a choice, icon or pattern by zoom without `"interpolate": "step"` |
| `zoom_nesting` | error | zoom stops inside an attribute mapping (4.4) |
| `zoom_not_whole` | error | a class or rule zoom that is not a whole number |
| `zoom_range_invalid` | error | `min_zoom` not below `max_zoom` |
| `override_not_per_feature` | error | a per-layer key set in more than one place (6.1) |
| `dash_on_point_outline` | error | `dash` on a point outline (circle strokes cannot be dashed) |
| `template_syntax` | error | a label placeholder that is not `{field}` (for example `{{ field }}`), or an unbalanced brace |
| `like_pattern_unsupported` | error | a `like` pattern other than contains, starts with, ends with |
| `unknown_field` | error, damaged | a field the dataset does not have: classifications, value forms, rules, labels, order, time, priority, popup |
| `field_type_mismatch` | error, damaged | a numeric method, range or palette mapping on a text field; a time field that is not an integer or date |
| `operator_type_mismatch` | error | a comparison whose value does not fit the field's type |
| `unknown_icon`, `unknown_palette`, `unknown_pattern` | error | an icon, palette or pattern that does not exist |
| `palette_too_short` | error | an inline palette with fewer colors than classes it must color |
| `classes_invalid` | error | numeric classes unsorted, overlapping, with gaps, or `from` not below `to` |
| `category_duplicate` | error | one value in two classes |
| `range_invalid`, `domain_invalid`, `stops_order` | error | a range or domain from high to low, stops not ascending |
| `render_not_for_geometry` | error | `heatmap`, `cluster` or `h3` on lines or polygons |
| `render_type_mismatch` | error | a raster render type that does not fit the raster (hillshade on land cover codes) |
| `render_not_for_source` | error | what the layer's source cannot do: a render other than `image`, `bands` or `no_data` on a map service; `service_style` on a layer that is not one |
| `unknown_band`, `invalid_band_expression` | error | a band the raster does not have, a formula with other symbols |
| `too_many_features_for_render` | error | `cluster` on a layer above the feature limit (8.2) |
| `not_supported_yet` | error | a construct this deployment cannot render yet (section 19) |
| `classify_target_conflict` | warning | a later classification covers every feature and sets the same keys (5.7) |
| `classify_partial_overlap` | info | a later classification sets the same keys for some features |
| `classes_merged` | info | equal breaks merged, so a classification has fewer classes than its count |
| `no_values` | info | a computed classification or value form whose field has no values (an empty dataset, or every value empty) |
| `classes_stale` | warning | stored classes from an older data fingerprint that could not be recomputed |
| `too_many_classes`, `too_many_categories` | warning | more than 7 numeric classes or 12 categories |
| `unknown_category` | warning | a category or raster class for a value no feature or cell has |
| `domain_outside_data` | warning | a domain that misses the data |
| `nothing_drawn` | warning | every part off, or every class hidden |
| `palette_kind_mismatch` | warning, info | a palette for categories on ordered classes, or the other way round |
| `mixed_icon_kinds` | info | library and uploaded icons in one marker: compiles to two layers, icons of the two kinds do not sort together |
| `unclassified_values`, `low_opacity` | info | raster values without a class, a layer under 15% opacity |
| `unknown_layer`, `unknown_style`, `duplicate_layer`, `unknown_position` | error | map document: a layer or named style that does not exist, a layer twice, a position the basemap does not have |

Examples that fail:

<!-- check: districts -->
<!-- expect: unknown_field, part_not_for_geometry, zoom_stops -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "fill": { "color": { "field": "inhabitants", "palette": "d3:viridis" } },
    "line": { "color": "#000000" },
    "outline": { "width": { "zoom": [[14, 1], [10, 3]] } }
  }
}
```

<!-- check: routes -->
<!-- expect: field_type_mismatch, operator_type_mismatch -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "line": { "color": "#2166ac" } },
  "classify": [{ "field": "status", "method": "quantile", "count": 5, "palette": "d3:viridis" }],
  "rules": [{ "when": { "op": ">", "args": [{ "property": "name" }, "M"] }, "visible": false }]
}
```

<!-- check: satellite -->
<!-- expect: unknown_band, render_type_mismatch -->
```json
{ "version": 1, "kind": "raster", "render": { "type": "terrain", "band": 7 } }
```

<!-- check: schools -->
<!-- expect: dash_on_point_outline -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 }, "outline": { "color": "#ffffff", "width": 1, "dash": "dashed" } }
}
```

<!-- check: districts -->
<!-- expect: template_syntax -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": { "fill": { "color": "#deebf7" }, "label": { "text": "{{ name }}" } }
}
```

## 12. Computed values

Some values depend on the data. The author writes the intent; the server writes what it computed into `computed`, next
to the intent, with the data it came from.

| Intent | Computed | Stored in |
|---|---|---|
| numeric classification with a method (`quantile`, `equal_interval`, `natural_breaks`, `std_dev`, `heads_and_tails`) and `count` | class `from` and `to`, colors from the palette, sizes from the range | the classification's `classes` + `computed` |
| categories with `count` (top N) | the N most frequent values as classes, the rest in `other` | `classes` + `computed` |
| value form without `domain` | the field's minimum and maximum (over the values a `sqrt` scale can map, from 0, or a `log` scale, above 0) | `computed.domain` on the value form |
| H3 `classify` or continuous H3 colors | breaks or domain per resolution | `render.computed`, keyed by resolution |
| raster classes with a method | breaks from the band histogram | `render.classify.classes` + `computed` |

- **`computed`** holds `at`, `data` (the data fingerprint) and `scope`, and on a classification `generated`: the
  target and the value the server wrote per class id.
- **Fingerprint:** an opaque string the server writes, telling which data the values were computed from:
  - a DuckLake layer: the snapshot of the layer's last data change (`ducklake:455812`). core tracks it per layer from
    DuckLake's change log (inserts and deletes, also inlined ones, and schema changes; not compaction), so every
    import, edit, workflow run or column change that writes the layer moves it, whoever writes;
  - a promoted catalog layer: its catalog version (one immutable file per version, so it never goes stale);
  - a raster: the file's checksum.
- **Stale:** the layer's last data change is newer than the stored fingerprint.
- **A recompute that gives the same values** updates `computed.at` and `computed.data` in place, without a new
  revision or history entry. Saves (13.1) and the published-map comparison (13.2) ignore those two keys, so an
  unchanged result never looks like a change.
- **Scope:** always the whole dataset, unfiltered and over all times. Project filters and the time slider do not
  change the classes, so colors mean the same everywhere.
- **Recompute:** once per data change, when the fingerprint of `computed` differs from the layer's current one.
  - Loading a map never computes: it returns the stored styles and marks the changed ones `stale` (13.2).
  - Reading that one style (the map asks for it right after the load, the style panel when it opens) recomputes it,
    or waits for a recompute already running, and stores the result as a server write (source `recompute`, 13.1).
    Any reader may cause it; it changes only computed values, which are the server's paths, so an open editor merges
    it without a conflict.
  - Nothing rewrites stored styles in bulk on import.
  - `classes_stale` only appears when a recompute fails.
- **Published maps** keep the computed values they were published with (13.2).
- **What survives a recompute:**
  - `from` and `to` are replaced position by position.
  - Everything else a class carries stays when `count` is unchanged: colors and names picked by hand, `visible`,
    zooms, part overrides.
  - A new `count` rebuilds numeric classes from the palette.
  - A class value still equal to what the server wrote (`computed.generated`) follows the palette, `reverse` and
    `range`, so changing them recolors the classes; a value changed by hand stays. A new `target` removes what the
    server wrote for the old one.
  - Categories keep a class while one of its values is still among the N most frequent; the other classes go, and the
    new values become classes with the palette colors no class uses yet. `other` and `no_data` stay the author's.
  - Moving a break by hand turns the method into `manual`, which is never recomputed.
  - An author's `domain` on a value form is a fixed clamp and is never replaced.
  - Empty data still writes `computed`; classes and domains stay as they were, and `no_values` says why.
  - What is no longer computed (a classification turned `manual`, categories without `count`, a value form with an
    author's `domain`) loses its `computed`.
  - A classification or value form with an error of its own is not computed; validation reports the error.

## 13. Who does what

| Step | Who |
|---|---|
| Author | the panel, or the AI tool (whole document or edit operations by id) |
| Check while editing | every save is the check: its reply carries the issues (13.1); one validator, in Python |
| Store | core: the document and its revision, written with one conditional write (13.1) |
| Merge concurrent edits | core, with goatlib's diff and apply; the browser applies the same rules to edits made while a save was in flight (13.1) |
| Upgrade an older version | goatlib, on read (section 14) |
| Validate structure | goatlib Pydantic models |
| Validate against the data | goatlib with the dataset's field metadata, the icon list, the palette catalogue and raster band metadata |
| Compute (section 12) | goatlib functions over the layer's data in DuckLake; raster histograms in the raster service on import |
| Respond | core returns the stored document, with `computed` filled, and the issues; the client replaces its copy and keeps edits made meanwhile (13.1) |
| Compile to MapLibre | one TypeScript compiler in `apps/web`, used by the map, print, thumbnails and the catalog preview |
| Render, legend, popup | `apps/web` |
| Migrate today's styles | one converter in goatlib, run once after a dry run on a copy of the database (section 17) |

### 13.1 Editing and saving

This covers style documents: named styles and the dataset's default style.

**The browser keeps its own copy.** The panel edits it, the compiler redraws the map from it at once, and nothing waits
for the server. The panel never writes an error: a choice that is not complete yet (a field not picked) stays in the
panel until it is.

**Saving.** About 1 s after the last change, the browser sends its whole copy with the revision it is based on:
`{ "base_rev": 41, "document": { ... } }`.

- One save is in flight at a time; changes made meanwhile go into the next one.
- A save is a whole document (a few KB), so sending it again is harmless: a document equal to the stored one is not
  written again, and the reply carries the current revision. No request ids are needed.

**The server** (core):

1. If `base_rev` is the current revision, the incoming document is the candidate. Otherwise the server reads the base
   revision's document, upgrades it like any read (section 14), takes what the author changed (the diff from the base
   to the incoming document) and applies it onto the current document. The result is the candidate.
2. Validates the candidate (section 11) and fills `computed` (section 12).
3. Stores it with one conditional write: `UPDATE ... SET document = :candidate, revision = revision + 1 WHERE id = :id
   AND revision = :read`. core runs each statement on its own (autocommit), so this single statement is what makes a
   save atomic. If another write got in first, the server reads again and repeats from step 1, at most 3 times, then
   answers with a retryable error.
4. Replies with the stored document, its revision and the issues.

**Diff and merge rules** (the same in goatlib and `apps/web`, kept equal by one set of shared test cases):

- Objects merge key by key. A changed value replaces the stored one, so on the same path the last write wins.
- Lists whose items carry ids (classifications, classes, rules, popup blocks) merge item by item: items are added,
  removed and changed by id, and an item the author moved goes after the item it follows in the author's list. An item
  one side removed stays removed, even when the other side changed it.
- Every other list (zoom stops, palettes, category values, number lists) is one value.
- What the server computes is never part of a diff: every `computed` object, the issues, and the class bounds and
  values of a computed classification (`from` and `to` under a method other than `manual`, `values` under a category
  `count`). The server computes them again after the merge.
- Two valid documents can merge into an invalid one: one side switches the classification field while the other edits
  the old classes. For every changed path with an error, the server keeps the current value there, stores the rest and
  returns the error; the panel shows what was not saved. This is the rule of section 11 (errors block only what they
  are about) applied to a merge.

**The reply in the browser:**

- No edits since the save was sent: the reply replaces the browser's copy.
- Edits made while the save was in flight: the browser takes them (the diff from what it sent to its copy), applies
  them on top of the reply and sends them next. Sending its old copy instead would undo a newer change made elsewhere.

**Revisions kept.** A merge needs the base revision's document, so core keeps the last 20 revisions of each style. A
save based on an older revision is answered with `409` (`base_too_old`), and the browser asks whether to apply its
changes to the current style or discard them. Version history, when it comes, replaces this store.

**Failures:**

| What happens | The browser |
|---|---|
| no answer (offline, timeout, connection dropped) | keeps its copy and retries with it after 1, 2, 4 and 8 s, then every 30 s, and at once when it is back online |
| `5xx`, `429`, the retryable error of step 3 | the same |
| `401` | keeps its copy, renews the session and retries; after a new sign-in, the save goes out |
| `403` | takes the server's document and shows that the layer can no longer be edited |
| `404` | drops its copy and shows that the layer was deleted |
| `409` (`base_too_old`) | asks: apply the changes to the current style, or discard them |

- **Leaving the page:** while a save is pending, the browser warns on `beforeunload` and sends it with
  `fetch(..., { keepalive: true })` on `pagehide`. A plain request sent there is often never sent.
- **Status line** in the style panel, no dialogs: "Saved", "Saving…", "Not saved yet, retrying", "Offline, changes are
  kept while this page is open".
- **Later:** keeping unsent changes in the browser's storage (IndexedDB) across a closed tab or a crash. Until then a
  closed tab loses what was not saved: about one second of edits, or everything since going offline.
- Other people see a stored change when their map loads the style again.

**The AI** writes a whole document, or operations from section 11's list that core applies to the current document.
Both go through steps 2 to 4. A check without storing (`dry_run: true`) returns the same issues, so the AI can fix its
document before writing it.

**Not used:** CRDTs (the server could not refuse an invalid edit, and the stored style would stop being plain JSON) and
WebSockets (live multiplayer can come later without changing the document or these rules).

### 13.2 Loading a map

- **One request** returns the map document, the active style of every layer (document and revision) and the names of
  the other named styles. A style is about 1 KB, so a project with 200 layers loads about 200 KB before compression.
  Class breaks are inside the documents, so drawing needs nothing more. The response carries an ETag; a reload without
  changes is answered with `304`.
- **A layer whose data changed** since its classes were computed is marked `stale`. The map draws it with the stored
  classes at once and asks for that style alone, which recomputes it (section 12): one more request per changed layer,
  only the first time after the change.
- **Another named style** is loaded with one request when someone switches to it.
- Print, thumbnails and the dataset preview use the same request.

**Published maps** are a snapshot taken when publishing: the map document and every named style, computed values
included. Viewers load it with one request, and it never computes.

- When the data changes, a published map keeps its classes until it is published again. The legend still matches the
  map (each value falls into the stored classes), and colors stay comparable over time.
- When a recompute changes the classes, the project's style differs from the snapshot, so the project shows that it
  has unpublished changes, with the reason: classes were recomputed for new data. The comparison ignores
  `computed.at` and `computed.data` (section 12).
- A category that is new in the data shows as `other` on the published map until then.
- Later, if needed: an option per published map to keep its classes current.

## 14. Versions

- `version` is an integer and changes only for a breaking change. Adding an optional key keeps the version.
- **On write:** unknown keys are an error (`unknown_key`), a newer version is refused (`newer_version`).
- **On read:** older versions are upgraded by goatlib (one function per step, `1 -> 2`, `2 -> 3`). A client that meets
  unknown keys draws what it knows and does not write the document back without the server.
- **Values outside the bounds:** a stored document may hold a value outside the bounds goatlib takes from MapLibre
  (written before goatlib took them). The upgrade brings it inside and notes it: a `direction` goes round the circle
  (360 is 0), any other value takes the nearest bound (arrows `spacing` 0 is 1, `exaggeration` 1.5 is 1).
- **Version 0** is today's GOAT style (the documents without `version`). The converter of section 17 is the upgrade
  step `0 -> 1`, so anything that still arrives in the old shape is read like any older version: catalog style assets
  until the harvester writes version 1, and project exports made before the release.
- **`ext`:** a reserved object for namespaced keys (`"ext": { "goat:experiment": { ... } }`). It passes through
  unchanged and is never interpreted by the compiler unless a later version adopts the key.

## 15. What the style needs from the servers

| Feature | Service | Used for |
|---|---|---|
| vector tiles with feature ids | geoapi (exists) | every vector part; `feature-state` highlight |
| decoration points: start, end, both ends, center of each line, with bearing | geoapi (exists) | arrows `center`, `start`, `end`, `both_ends`; line labels at the center |
| label anchors: one point per polygon (`ST_PointOnSurface`) | geoapi (exists) | polygon labels (`inside`) |
| H3 hexagon tiles with count, sum, mean per cell | geoapi (new) | `render: h3` |
| the layer's points (id, coordinates, the fields the style uses) | features API (exists as GeoJSON) | `render: cluster` in the browser |
| classification and domain computation | goatlib (natural breaks and head/tail breaks are new) | section 12 |
| colored raster tiles, band formulas, band statistics, point values | geoapi's raster tile service | section 9 |
| map service pictures, service styles, legend images | the service itself; the web reads its capabilities when the layer is added (exists) | 9.8 |
| sprites: library icons as SDF, uploads as bitmaps | web, from GOAT's icon library | markers, arrows |
| pattern tiles, drawn on demand from the image's name | web, `lib/style/render/patternImages.ts` | fill patterns |
| fonts | GOAT serves its own fonts (a glyph URL or MapLibre `font-faces`) for every basemap, instead of relying on each basemap's glyph server; until then see `font.weight` in section 16 | labels |

The decoration points and label anchors must carry the fields the style needs on them (label text, the fields of
classes and rules that filter or change arrows and labels). Today they carry only `bearing` and the row id; geoapi
adds the requested columns.

## 16. Compiling to MapLibre

One TypeScript compiler turns a layer style plus its map document entry into MapLibre sources and layers. These rules
are part of the format: an output that breaks one of them draws something else than the document says.

| Construct | MapLibre output |
|---|---|
| polygon `fill` | `fill` layer; with `pattern`, a second `fill` layer with `fill-pattern` above the color fill: one image per look, named `goat-pattern:<kind>|<spacing>|<width>|<color>` per feature and zoom stop and drawn when the map first needs it |
| polygon `outline` | `line` layer (`fill-outline-color` is always 1 px) |
| `line` | `line` layer; dashes as `line-dasharray` in line widths: `solid` [1, 0], `dashed` [2, 2], `dotted` [0.5, 2], `dash_dot` [3, 2, 0.5, 2] |
| `casing` | `line` layer below the line, with the **same filter, zoom range and layout**, so MapLibre tessellates the geometry once. Width = line width + 2 x casing width at every zoom stop. A class with `casing: false` gets casing opacity 0 instead of a different filter |
| `arrows: repeat` | `symbol` layer on the line source, `symbol-placement: line`, `symbol-spacing`; GOAT's arrow icon `goat:arrow` (pointing north) as SDF, `icon-rotate: 90` to follow the line; `icon-rotation-alignment: map`; `backward` adds 180; `both` adds a second layer |
| `arrows`: `center`, `start`, `end`, `both_ends` | `symbol` layer on geoapi's decoration points (`default_decoration`), `icon-rotate` from `bearing` (+180 for `backward`), `icon-rotation-alignment: map` |
| `marker` circle | `circle` layer, `circle-radius` = size / 2; `outline` = `circle-stroke-*`; `fill: false` = `circle-opacity` 0, the stroke stays. Circles never collide |
| `marker` with a shape | one image per look (shape, fill, stroke, icon) in a `symbol` layer; `fill: false` leaves the shape's inside clear (the image name's fill part is empty) |
| `marker` icon | `symbol` layer, `icon-size` = size / (image height / pixelRatio); library icons are SDF and take `icon-color`; uploaded icons go into a second layer (`mixed_icon_kinds`); `rotation` = `icon-rotate` with `icon-rotation-alignment: map`; `outline` = `icon-halo-*` (library icons only) |
| icon on a circle | `circle` layer + `symbol` layer above; the icon size follows the circle size expression |
| `label` on points | `symbol` layer; `auto` = `text-variable-anchor-offset`; `offset` px / size = `text-offset` in ems, per zoom stop when the size varies |
| `label` on polygons | `symbol` layer on geoapi's label anchors (`default_anchor`) |
| `label` on lines | `line`: `symbol-placement: line`; `center`: the decoration center points |
| label text | `concat` of literal text and one formatted value per placeholder; `lines` become `format` sections; `max_width` px / size = `text-max-width` in ems |
| numbers | `number-format` with `locale` from `["global-state", "locale"]`; `decimals: 0` rounds first (MapLibre ignores a 0); `thousands_separator: false` uses `to-string` of the rounded value; `abbreviate` and `always_show_sign` are `case` expressions. The map compiles without field types, so there a placeholder is formatted as a number when its value is one (`["typeof", ["get", f]]`) and as text otherwise; with field types (the style panel), by the field's type |
| `font.weight` | `text-font` stack (fonts: section 15); until GOAT serves its own fonts, `Noto Sans Regular` and `Noto Sans Bold`, the stacks both default glyph servers (OpenFreeMap, basemap.de) have |
| value by zoom | `interpolate` or `step` on `["zoom"]` at the top level; derived values (casing width, opacity products) are computed at every stop of the union of stop zooms |
| value by attribute | `interpolate` over `["to-number", ["get", f]]` inside `case` with `has`, falling back to `no_data`; `sqrt` and `log` scales transform the input and the domain |
| categories | `match`; labels in the field's type for strings and integers, otherwise on `["to-string", ["get", f]]`; `other` is the fallback, `no_data` a `case` with `has` |
| numeric classes | `step` over the guarded value; `no_data` a `case` with `has` |
| rules | `case` branches, later rules first; `visible: false` goes into the filter |
| class and rule zooms | the filter, `["zoom"]` compared with whole numbers |
| layer and part zooms | the layer's `minzoom` and `maxzoom` |
| layer `opacity` | `fill-layer-opacity`, `line-layer-opacity` (MapLibre 6), otherwise multiplied into each part (4.6) |
| `order` | `*-sort-key`: circles draw higher keys on top, so `largest` = value; symbols place lower keys first, so `largest` = negated value |
| `time` | the filter compares the field with `["global-state", "<layer id>:time"]`; a `step` on a date field compares its text cut to the year, month or day, and without field types (the map) a `step` always does |
| highlight | each part's paint reads `["feature-state", "active"]` (and `"hover"`): color, width, halo, opacity; sizes of icons and labels cannot change |
| heatmap | `heatmap` layer; `heatmap-color` over `heatmap-density`, transparent at 0; `points_from_zoom` = the heatmap's `maxzoom` and the point layers' `minzoom` |
| cluster | GeoJSON source with `cluster`, `clusterRadius`, `clusterMinPoints`, `clusterMaxZoom` = `cluster_until_zoom` - 1 (MapLibre's is inclusive); cluster layers filter on `["has", "point_count"]`; `count` = `point_count` |
| H3 | vector source of geoapi's H3 tiles; `fill` + `line` layers over the cell value |
| raster | `raster` source of the raster service's colored tiles and a `raster` layer (adjustments as in 9.1); terrain: `hillshade` on a terrarium DEM source, the layer opacity in the alpha of its colors |
| map service | `raster` source with the service's tile URL (WMS `GetMap` with `{bbox-epsg-3857}` and `STYLES` = `service_style`; WMTS with `Style`; XYZ as given) and a `raster` layer with `raster-opacity`, the adjustments as in 9.1 and `raster-resampling` |

> "Cycle routes with a white edge, width by zoom, shifted 2 px, an arrow in the middle; planned routes dashed, faded,
> without the edge and only from zoom 13."

<!-- check: routes -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "line": { "color": "#2166ac", "width": { "zoom": [[10, 2], [16, 6]] }, "cap": "round", "join": "round", "offset": 2 },
    "casing": { "color": "#ffffff", "width": 1.5 },
    "arrows": { "placement": "center", "size": 12 }
  },
  "classify": [
    {
      "field": "status",
      "method": "categories",
      "classes": [
        { "values": ["existing"], "name": "Existing" },
        { "values": ["planned"], "name": "Planned", "min_zoom": 13, "line": { "dash": "dashed", "opacity": 0.6 }, "casing": false }
      ]
    }
  ]
}
```

compiles to:

<!-- check: maplibre -->
```json
[
  {
    "id": "413-casing",
    "type": "line",
    "source": "s413",
    "source-layer": "default",
    "filter": ["any", ["!=", ["get", "status"], "planned"], [">=", ["zoom"], 13]],
    "layout": { "line-cap": "round", "line-join": "round" },
    "paint": {
      "line-color": "#ffffff",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 16, 9],
      "line-offset": 2,
      "line-opacity": ["match", ["get", "status"], "planned", 0, 1]
    }
  },
  {
    "id": "413-line",
    "type": "line",
    "source": "s413",
    "source-layer": "default",
    "filter": ["any", ["!=", ["get", "status"], "planned"], [">=", ["zoom"], 13]],
    "layout": { "line-cap": "round", "line-join": "round" },
    "paint": {
      "line-color": "#2166ac",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 16, 6],
      "line-offset": 2,
      "line-opacity": ["match", ["get", "status"], "planned", 0.6, 1],
      "line-dasharray": ["match", ["get", "status"], "planned", ["literal", [2, 2]], ["literal", [1, 0]]]
    }
  },
  {
    "id": "413-arrows",
    "type": "symbol",
    "source": "s413",
    "source-layer": "default_decoration",
    "filter": ["any", ["!=", ["get", "status"], "planned"], [">=", ["zoom"], 13]],
    "layout": {
      "icon-image": "goat:arrow",
      "icon-size": 0.5,
      "icon-rotate": ["get", "bearing"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true
    },
    "paint": { "icon-color": "#2166ac" }
  }
]
```

> "Districts in five quantile classes by density; the name and the area with one decimal on two lines, bold, from
> zoom 11."

<!-- check: districts -->
```json
{
  "version": 1,
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#cccccc", "opacity": 0.8 },
    "outline": { "color": "#ffffff", "width": 1 },
    "label": {
      "text": "{name}\n{area_km2} km²",
      "format": { "decimals": 1 },
      "size": 12,
      "color": "#3a3541",
      "font": { "weight": "bold" },
      "halo": { "color": "#ffffff", "width": 1.5 },
      "min_zoom": 11
    }
  },
  "classify": [
    {
      "field": "density",
      "method": "quantile",
      "count": 5,
      "palette": "colorbrewer:OrRd",
      "classes": [
        { "to": 2800, "fill": { "color": "#fef0d9" } },
        { "from": 2800, "to": 3600, "fill": { "color": "#fdcc8a" } },
        { "from": 3600, "to": 4300, "fill": { "color": "#fc8d59" } },
        { "from": 4300, "to": 6300, "fill": { "color": "#e34a33" } },
        { "from": 6300, "fill": { "color": "#b30000" } }
      ],
      "computed": { "at": "2026-10-23T10:00:00Z", "data": "snapshot-1841", "scope": "dataset" }
    }
  ]
}
```

compiles to:

<!-- check: maplibre -->
```json
[
  {
    "id": "414-fill",
    "type": "fill",
    "source": "s414",
    "source-layer": "default",
    "paint": {
      "fill-color": ["case", ["has", "density"], ["step", ["to-number", ["get", "density"], 0], "#fef0d9", 2800, "#fdcc8a", 3600, "#fc8d59", 4300, "#e34a33", 6300, "#b30000"], "#cccccc"],
      "fill-opacity": 0.8
    }
  },
  {
    "id": "414-outline",
    "type": "line",
    "source": "s414",
    "source-layer": "default",
    "paint": { "line-color": "#ffffff", "line-width": 1 }
  },
  {
    "id": "414-label",
    "type": "symbol",
    "source": "s414",
    "source-layer": "default_anchor",
    "minzoom": 11,
    "layout": {
      "text-field": [
        "concat",
        ["to-string", ["get", "name"]],
        "\n",
        ["case", ["has", "area_km2"], ["number-format", ["to-number", ["get", "area_km2"], 0], { "locale": ["global-state", "locale"], "min-fraction-digits": 1, "max-fraction-digits": 1 }], ""],
        " km²"
      ],
      "text-size": 12,
      "text-font": ["Noto Sans Bold"]
    },
    "paint": { "text-color": "#3a3541", "text-halo-color": "#ffffff", "text-halo-width": 1.5 }
  }
]
```

The real compiler is tested with golden files: document in, MapLibre layers out, validated with the style-spec
validator and rendered once.

## 17. From today's GOAT styles

Every stored style (project layers, dataset defaults, published maps, workflow `outputStyle`, locked print
styles) is converted once by a goatlib converter, the upgrade step from version 0 (section 14), and goatlib's style
generators (`goatlib/tools/style.py`) write the new format. Catalog style assets are upgraded when read (section 14)
until the harvester writes version 1. The converter runs as a dry
run on a copy of the database first; every style that does not validate is reported, not silently simplified. The old shape is
not kept.

| Today | GOAT Style | Conversion | Lossy |
|---|---|---|---|
| points: `color`, `opacity`, `filled: false` | `marker.color`, `marker.opacity`, `marker.fill: false` (outline kept) | RGB array to hex | no |
| polygons: `color`, `opacity`, `filled`, `stroked` | `fill.color`, `fill.opacity`, `fill: false`, `outline: false` | RGB to hex | no |
| lines: `stroke_color`, `opacity` | `line.color`, `line.opacity` | RGB to hex | no |
| `stroke_color`, `stroke_width` on points and polygons | `outline.color`, `outline.width` | RGB to hex | no |
| `X_field` + `X_scale: ordinal` + `X_range.color_map` | `classify` with `method: categories`, one class per entry, `target` = X | values lists kept | no |
| `X_scale`: `quantile`, `equal_interval`, `standard_deviation`, `heads_and_tails` + `X_scale_breaks` | `classify` with the method (`std_dev` for `standard_deviation`), `count`, `palette`, classes from the stored breaks, `computed` with an unknown fingerprint (recomputed on first read) | | no |
| `X_scale: custom_breaks` | `classify` with `method: manual` | | no |
| `X_range` palette: ColorBrewer (both casings), Uber, inline custom | `palette`: `colorbrewer:<name>`, `uber:<name>`, inline list | names normalized | no |
| `X_range.reversed` | `reverse` | | no |
| `X_range.color_legends` | class `name` | | no |
| `X_no_data` | the classification's `no_data` | | no |
| `radius`, `radius_field`, `radius_range`, `radius_scale` | `marker.size` (fixed, by attribute or classes) | **size = 2 x radius** (diameter) | no |
| `marker_size` (custom marker) | `marker.size` | **size = marker_size x 200 / 200 image px**, checked in the dry run | no |
| `X_ordinal_map` (size by category) | classification with `target` = the size key | | no |
| `X_scale: exponential` (sizes) | `scale: log` | | **yes**: approximation |
| `marker`, `marker_field`, `marker_mapping` | `marker.icon`, classes with `marker.icon` | URLs to `goat:` or `asset:` | no |
| `marker_anchor` (9 anchors) | `marker.anchor` (the same nine, `top-left` written `top_left`) | | no |
| `marker_offset` | `marker.offset` | **px = offset x marker_size / 200** (MapLibre scales icon offsets by the icon size) | no |
| `marker_allow_overlap` | `marker.allow_overlap` | | no |
| `stroke_pattern`, `stroke_dash_density` | `dash` | density dropped | **yes** |
| `stroke_cap`, `stroke_join`, `stroke_offset` | `line.cap`, `line.join`, `line.offset` | | no |
| `decoration_*` (arrows): placement `start_and_end` | `arrows.placement: both_ends` | | no |
| `decoration_allow_overlap` | dropped: arrows always overlap | | **yes** |
| `text_label`: `field`, `size`, `color`, `outline_color`, `outline_width` | `label.text: "{field}"`, `size`, `color`, `halo` | RGB to hex | no |
| `text_label.offset` (ems) | `label.offset` (px) | **px = ems x size** | no |
| `text_label.anchor` (9 anchors) | `label.placement`: `auto`, `above`, `center` | | **yes** |
| `text_label.alignment`, `font_family`, `background`, `background_color` | dropped (alignment and backgrounds later; fonts are GOAT's) | | **yes** |
| `min_zoom`, `max_zoom` | top-level `min_zoom`, `max_zoom` | | no |
| `visibility` | map document layer entry `visible` | | no |
| `legend.show`, `legend.caption` | `legend.show`, `legend.caption` | | no |
| `legend.collapsed` | map document `legend.expanded` | inverted | no |
| `cluster` (`radius`, `min_points`, `max_zoom`, `color`, `text_color`) | `render: { "type": "cluster" }` with `cluster_until_zoom` = `max_zoom` + 1 (today's value is inclusive), cluster `symbol` colors | | no |
| `popup` | `popup`: `fieldList` to `field_list`, attribute `name` to `field`, `format_config` to `format`, the legacy `format` preset to the matching `format`, `position` and `show_layer_header` to `layout` and `header`, block ids kept | | no |
| `interaction` (legacy popup) | the popup GOAT seeds from it today | | no |
| raster `opacity`, `style.opacity` | top-level `opacity` (the product) | | no |
| raster `resampling` | `resampling` | | no |
| raster `style_type: image`, `brightness_min`, `brightness_max`, `contrast`, `saturation`, `hue` | `render.type: image` and adjustments | **brightness = brightness_min if > 0, else brightness_max - 1** | **yes** when both are set |
| raster `color_range` (`color_map`, `interpolate`, `min_value`, `max_value`, `no_data_color`, `min_label`, `max_label`) | `render.type: continuous` with `stops`, `interpolate` (`false` to `nearest`), `legend.min_label`, `legend.max_label` | `no_data_color` dropped (no-data is transparent) | **yes** for `no_data_color` |
| raster `categories` (`categories`, `default_color`) | `render.type: categorical`, `classes`, `other_color` | | no |
| raster `hillshade` (`azimuth`, `altitude`, `z_factor`) | `render.type: terrain` (`direction`, `altitude`, `exaggeration`) | **exaggeration = min(1, z_factor / 2)**, checked visually in the dry run; azimuth 360 is direction 0 | **yes** above 2 |
| WMS, WMTS, XYZ layers: `opacity`, `min_zoom`, `max_zoom`, `resampling`, `legend` | a map service style (9.8) with the same keys and `render.type: image`; `service_style` left out (the first style, as drawn today); `visibility` to the map document; the service keys (`url`, `layers`, `srs`, `dpi`, `legend_urls`, `tile_size`) stay on the layer | | no |

Where a key is absent, the converter writes what today's renderer draws, not the web form's defaults: the
renderer reads the stored properties as they are. So an absent `filled` or `stroked` is off, an absent `opacity` is 1,
an absent `stroke_width` is 1, an absent `marker_size` is 100, an absent label size is 14, and an absent resampling
is `nearest`. An empty zoom range (minimum not below maximum) drew nothing: it becomes `visible: false` in the map
document. A `transparent` no-data color becomes `#00000000` on the classified key only.

## 18. Reference

The tables below are the contract. The goatlib Pydantic models (`style/models/`) are its source of truth: the JSON
Schema and the web's types and defaults are generated from them, and these tables follow them. The defaults are published in the JSON Schema as `x-defaults` (goatlib
`style/defaults.py`), except those that depend on the document: the pattern color is the fill color, arrows take the
line color, the marker icon is `goat:marker` when the shape is `icon`, the icon color is the marker color on a hollow marker (`fill: false`), the label placement follows the geometry. "Forms" lists the value forms allowed (F fixed,
Z by zoom, A by attribute, C by classes; section 4.5).

### 18.1 Layer style

| Key | Type | Required | Default |
|---|---|---|---|
| `version` | integer | yes | |
| `kind` | `vector`, `raster` | yes | |
| `geometry` | `point`, `line`, `polygon` | no | the dataset's |
| `opacity` | number 0 to 1 (F, Z) | no | 1 |
| `min_zoom`, `max_zoom` | number 0 to 24 | no | 0, 24 |
| `symbol` | object of parts (18.2) | no | the main part with defaults |
| `classify` | list of classifications (18.4) | no | none |
| `rules` | list of rules (18.6) | no | none |
| `order` | `{ field, top }` or `{ by: "classes" }` | no | data order |
| `legend` | object (7.2) or `false` | no | shown |
| `time` | `{ field, step }` | no | none |
| `popup` | object (7.4) or `false` | no | click, all fields |
| `render` | object (18.7, 18.8) | no | `features` |
| `ext` | object | no | |

### 18.2 Parts

| Part.key | Type | Forms | Default |
|---|---|---|---|
| `fill.color` | color | F Z A C | `#2bb381` |
| `fill.opacity` | 0 to 1 | F Z A C | 1 |
| `fill.pattern` | `none`, `hatch_45`, `hatch_135`, `vertical`, `horizontal`, `cross`, `grid`, `dots` | F Z(step) C | `none` |
| `fill.pattern_color` | color | F Z A C | the fill color |
| `fill.pattern_spacing` | px | F Z(step) C | 10 |
| `fill.pattern_width` | px | F Z(step) C | 2 |
| `outline.color` | color or `"fill"` | F Z A C | `#ffffff` |
| `outline.width` | px | F Z A C | 1 |
| `outline.opacity` | 0 to 1 | F Z A C | 1 |
| `outline.dash` | `solid`, `dashed`, `dotted`, `dash_dot` (polygons) | F Z(step) C | `solid` |
| `line.color` | color | F Z A C | `#2166ac` |
| `line.width` | px | F Z A C | 2 |
| `line.opacity` | 0 to 1 | F Z A C | 1 |
| `line.dash` | as outline | F Z(step) C | `solid` |
| `line.cap` | `butt`, `round`, `square` | F Z(step) C (C needs MapLibre 6) | `butt` |
| `line.join` | `miter`, `round`, `bevel` | F Z(step) C | `round` |
| `line.offset` | px | F Z A C | 0 |
| `line.blur` | px | F Z A C | 0 |
| `casing.color` | color | F Z A C | `#ffffff` |
| `casing.width` | px on each side | F Z A C | 1 |
| `casing.opacity` | 0 to 1 | F Z A C | 1 |
| `arrows.placement` | `repeat`, `center`, `start`, `end`, `both_ends` | F (per layer) | `repeat` |
| `arrows.direction` | `forward`, `backward`, `both` | F (per layer) | `forward` |
| `arrows.spacing` | px | F Z (per layer) | 100 |
| `arrows.size` | px | F Z A C | 10 |
| `arrows.color` | color | F Z A C | the line color |
| `marker.shape` | `circle`, `square`, `diamond`, `hexagon`, `shield`, `pin`, `round_pin`, `needle`, `square_pin`, `tag_pin`, `flag`, `icon` | F C (`icon` per layer) | `circle` |
| `marker.color` | color | F Z A C | `#2bb381` |
| `marker.fill` | boolean: `false` draws the marker hollow (3.3) | F C | true |
| `marker.size` | px (circle diameter or icon height) | F Z A C | 8 |
| `marker.opacity` | 0 to 1 | F Z A C | 1 |
| `marker.icon` | icon reference | F Z(step) C | none (`goat:marker` with `shape: icon`) |
| `marker.icon_color` | color | F Z A C | `#ffffff` (the marker color with `fill: false`) |
| `marker.rotation` | degrees clockwise from north | F Z A C | 0 |
| `marker.anchor` | `center`, `top`, `bottom`, `left`, `right`, `top_left`, `top_right`, `bottom_left`, `bottom_right` | F Z(step) C | `center` |
| `marker.offset` | `[x, y]` px | F Z C | `[0, 0]` |
| `marker.allow_overlap` | boolean | F (per layer) | false |
| `label.text` | template | F C (classes and rules may change it) | none |
| `label.format` | format object (18.3) | F (per layer) | the field settings |
| `label.formats` | `{ field: format }` | F (per layer) | none |
| `label.size` | px | F Z A C | 12 |
| `label.color` | color | F Z A C | `#3a3541` |
| `label.halo.color`, `label.halo.width` | color, px | F Z A C | `#ffffff`, 1.5 |
| `label.font.weight` | `regular`, `bold` | F Z(step) C | `regular` |
| `label.placement` | points `auto`, `above`, `center`; lines `line`, `center`; polygons `inside` | F (per layer) | `auto`, `line`, `inside` |
| `label.offset` | `[x, y]` px | F Z C | `[0, 0]` |
| `label.max_width` | px | F Z A C | 120 |
| `label.lines` | list of `{ size, color, font }` per line | F (per layer) | none |
| `label.priority` | `{ field, top }` | F (per layer) | none |
| `label.allow_overlap` | boolean | F (per layer) | false |
| every part `.min_zoom`, `.max_zoom` | number 0 to 24 | F | the layer's |

### 18.3 Value forms and format

| Form | Keys |
|---|---|
| by zoom | `zoom: [[z, value], ...]` (at least 2, ascending), `interpolate` (`linear` default, `exponential`, `step`), `base` (exponential only, default 1.6) |
| by attribute, colors | `field`, `palette` (catalogue id or inline list), `reverse`, `domain`, `no_data`, `title` |
| by attribute, numbers | `field`, `range: [min, max]`, `scale` (`linear` default, `sqrt`, `log`), `domain`, `no_data`, `title` |
| raw field value | `{ "field" }` alone: the value as it is (degrees, hex colors) |
| format | `decimals` (`auto` default, or 0 to 10), `thousands_separator` (default true), `abbreviate` (default false), `always_show_sign` (default false), `prefix`, `suffix` |

### 18.4 Classification

| Key | Type | Required | Default |
|---|---|---|---|
| `id` | string | no | assigned |
| `title` | string | no | the field's display name |
| `field` | field name | yes (vectors) | |
| `method` | `categories`, `quantile`, `equal_interval`, `natural_breaks`, `std_dev`, `heads_and_tails`, `manual` | yes | |
| `count` | integer 1 to 100 (top N for categories, classes otherwise) | no | categories: the classes as written; 5 |
| `target` | property path, for example `outline.width` | no | the main color |
| `palette`, `reverse` | palette, boolean | no | `goat:green` for numeric, `colorbrewer:Set2` for categories |
| `range` | `[min, max]` for number targets | no | the target's default range |
| `unit`, `format` | string, format object | no | the field settings |
| `legend` | `false` | no | shown |
| `classes` | list of class records (18.5) | no | computed |
| `other`, `no_data` | class record | no | none |
| `computed` | `{ at, data, scope, generated }` | server | |

### 18.5 Class record

`id`, `values` (categories) or `from`/`to` (numeric), `name`, `legend: false`, `visible`, `min_zoom`, `max_zoom`
(whole numbers), and part overrides (per-feature keys, part on/off). Raster and H3 classes take `color` instead of
part overrides.

### 18.6 Rule

`id`, `name`, `legend: false`, `when` (CQL2: `=`, `<>`, `<`, `>`, `<=`, `>=`, `in`, `and`, `or`, `not`, `isNull`,
`like` with contains, starts with, ends with), `visible`, `min_zoom`, `max_zoom` (whole numbers), part overrides.

### 18.7 Vector `render`

| Type | Keys and defaults |
|---|---|
| `features` | none |
| `heatmap` | `radius` (F Z, 26), `intensity` (F Z, 1), `opacity` (F Z, 1), `weight` (F A, 1), `palette` (`d3:magma`), `reverse`, `points_from_zoom` (none) |
| `cluster` | `radius` (50), `cluster_until_zoom` (14), `min_points` (2), `symbol` (parts over `count`) |
| `h3` | `resolution` (`auto`), `value` (`{ "op": "count" }`), `palette` (`colorbrewer:OrRd`), `reverse`, `classify` (shape of 18.4 without `field`), `opacity` (0.85), `outline`, `points_from_zoom` (none), `computed` (server, per resolution) |

### 18.8 Raster

| Key | Values and defaults |
|---|---|
| top level | `opacity` (1), `min_zoom`, `max_zoom`, `resampling` (`linear`), `brightness`, `contrast`, `saturation` (0), `hue` (0), `legend`, `popup` |
| `image` | `bands` (`[1, 2, 3]` for 3+ bands), `no_data`; on a map service only `service_style` (the service's first style) |
| `continuous` | `band` (1), `palette` (`goat:elevation`) + `reverse` + `domain` (band min and max), or `stops`; `interpolate` (`linear`, `nearest`); `outside` (`clamp`); `classify`; `no_data` |
| `categorical` | `band` (1), `classes` (`value`, `name`, `color`, `visible`), `other_color` (transparent), `no_data` |
| `terrain` | `band` (1), `method` (`standard`), `direction` (315), `altitude` (45), `exaggeration` (0.5), `shadow_color` (`#000000`), `highlight_color` (`#ffffff`), `accent_color` (`#000000`), optional `palette`, `domain`, `classify`, `outside`; `no_data` |

## 19. Scope

The format includes everything in this document. A deployment answers `not_supported_yet` for
what it cannot render yet, so the AI and the panel never offer it:

| First release | Later (in the format, `not_supported_yet` until built) |
|---|---|
| vector parts, value forms, classifications, rules, order, legend, time, popup, named styles, map document | H3 (geoapi H3 tiles) |
| heatmap, clusters, map services (9.8) | raster band formulas and values computed from a band's histogram (raster service) |
| raster `image`, `continuous`, `categorical`, `terrain` (9) | map service popups (`GetFeatureInfo`) |

GOAT's services draw H3 and the raster service's constructs; map service popups answer `not_supported_yet`.

**Not in 1.0, on purpose:**

- `extrude` (3D), and with it light, terrain and label heights: one later package;
- a highlight color and width (the active feature uses GOAT's highlight);
- `font.italic`, label backgrounds, text alignment;
- dash patterns as lists, line patterns, double lines, line gradients;
- bivariate classifications (two fields into one color);
- the time dimension of WMS layers;
- non-spatial tables (no layer style).

## 20. For AI authors

| The user wants | Write |
|---|---|
| one color for everything | `symbol.<main part>.color` |
| a color per category of a text field | a classification with `method: categories` (not a value form) |
| colors in ranges of a number | a classification with a numeric method, `count` and `palette`; leave `classes` to the server |
| a smooth color ramp over a number | a value form `{ "field", "palette" }` |
| sizes by a number | a value form `{ "field", "range", "scale": "sqrt" }` |
| something only for some features, with several fields or empty values | a rule |
| one category to look different, everything else unchanged | a classification with one class, no `other` |
| different looks when zooming | a value form by zoom, or `min_zoom` and `max_zoom` on a part |
| features hidden below a zoom | `min_zoom` on the class or rule (whole number) |
| labels | `label.text` with `{field}`; numbers through `format` |
| many points as a surface | `render: heatmap`; as counts per area, `render: h3` |

Common mistakes the validator answers with a fix:

- a value form `{ "field", "palette" }` on a text field (`field_type_mismatch`, fix: a categories classification);
- `{{ field }}` in a label (`template_syntax`);
- a palette id without namespace (`unknown_palette`, `allowed` lists the catalogue);
- writing `classes` with invented breaks for a computed method (the server replaces them; write the method and
  `count` only);
- a fractional class zoom (`zoom_not_whole`, fix `round`).
