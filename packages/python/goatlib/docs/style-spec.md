# GOAT Style 1.0: specification

GOAT Style is the format of GOAT layer styles and of the map document. goatlib's `style` package implements it, and
the code, tests and READMEs cite its sections as "spec N": "spec 4.2" is section 4.2 below.

## Examples in this document

The JSON examples are written against the sample datasets below; the comment above an example
(`<!-- check: districts -->`) names its dataset. Examples meant to fail list the codes they must produce
(`<!-- expect: ... -->`). MapLibre output examples follow MapLibre's style spec. Codes that need stored state or a
deployment (`damaged`, `not_supported_yet`, `too_many_features_for_render`, `classes_stale`,
`scene_source_missing`, `buildings_with_extruded_layer`) are listed without an example; the goatlib validator produces
them.

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
- **JSON** with `snake_case` keys and `"version": "1.0.0"`. Unknown keys are an error on write and ignored on read
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
    `d3:cividis`, `d3:inferno`, `d3:plasma`, `goat:terrain`, `goat:hypsometric`, `goat:ndvi` and `uber:<name>`, as
    examples of the palettes GOAT offers today;
  - the catalogue (id, name, kind, number of steps, color-blind safe, and the `group` the palette picker shows it in:
    `science` for the perceptual, elevation and vegetation ramps) is published as data;
  - an inline list looks like `["#fef0d9", "#fc8d59", "#b30000"]`; the panel's list of a continuous palette's colors writes one
    on its first edit, in the order the colors draw (`reverse` folded in).
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
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#c7e9b4", "opacity": 0.72 },
    "outline": { "color": "#ffffff", "width": 1.2 }
  }
}
```

| Key | What it holds |
|---|---|
| `version` | the version of this specification the document needs, `"1.0.0"` (section 14) |
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
| `outline` | polygon, point | `color` (or `"fill"`: the fill color on polygons, the marker color on points; or `"auto"`: a darker shade of it), `width`, `opacity`; `dash` and `position` on polygons only |
| `line` | line | `color`, `width`, `opacity`, `dash`, `cap`, `join`, `offset`, `blur` |
| `casing` | line | `color` (or `"auto"`: a darker shade of the line color), `width` (extra on each side), `opacity` |
| `arrows` | line | `placement`, `direction`, `spacing`, `size`, `color`, `icon`, `turn_with_line` |
| `marker` | point; polygon and line, off by default (3.3) | `shape`, `color`, `fill`, `size`, `opacity`, `icon`, `icon_color`, `rotation`, `anchor`, `offset`, `allow_overlap` |
| `label` | all | `text`, `format`, `formats`, `size`, `color`, `halo`, `font`, `transform`, `letter_spacing`, `line_height`, `placement`, `offset`, `max_width`, `spacing`, `padding`, `lines`, `priority`, `allow_overlap` |
| `extrude` | polygon | `height`, `base`, `unit`: the polygon as a volume in 3D (3.6) |

Every part also takes `min_zoom` and `max_zoom`.

**Absent and switched parts:**

- **In `symbol`:** an absent part is off, except the geometry's main part (`fill`, `line`, `marker`), which is drawn
  with its defaults when absent. `false` switches any part off.
- **In a class record or a rule:**
  - an absent part is unchanged;
  - `false` switches it off;
  - an object switches on a part the symbol leaves out, and sets the keys of a part that is on. Its keys are merged
    over the part's value so far (base, then earlier overrides), and keys that nothing set take their defaults from
    the reference.
- **A part the symbol switches off (`false`) stays off in every record**: no class or rule switches it on again. Its
  keys still cascade where another part reads them (an outline in the fill color takes the fill color each feature
  would have, 3.1), and records keep them for when the part is switched on again. `marker.fill` (a hollow marker,
  3.3) is a key of the marker, not a part, and a class may set it either way.

### 3.1 Fill and outline (polygons)

> "Districts in light green at 70% with a 1 px white border."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#a1d99b", "opacity": 0.7 },
    "outline": { "color": "#ffffff", "width": 1, "opacity": 1, "dash": "solid" }
  }
}
```

`dash` takes `solid`, `dashed`, `dotted`, `dash_dot`. Dash lengths scale with the width in MapLibre, so a dashed 4 px
line has longer dashes than a dashed 1 px line.

> "District borders 3 px wide, drawn inside each district so the borders of neighbors do not overlap."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#deebf7", "opacity": 0.6 },
    "outline": { "color": "#3182bd", "width": 3, "position": "inside" }
  }
}
```

`position` says where the outline runs: `center` (the default: along the edge, half of its width on each side),
`inside` (all of its width inside the polygon, holes included) or `outside` (all of it outside). The line moves by half
its width, so it follows a width by zoom or per class. Positions switch at zoom stops and classes and rules may set
them. Polygons only: a point outline with a `position` is `position_on_point_outline`.

> "Outline only, in the color each feature's class gives it."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
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

> "Each district with a thin border in a darker shade of its own color."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#cccccc", "opacity": 0.8 },
    "outline": { "color": "auto", "width": 1 }
  },
  "classify": [
    { "field": "land_use", "method": "categories", "palette": "carto:Bold" }
  ]
}
```

`outline.color: "auto"` is a darker shade of the color `"fill"` would give, feature by feature: its red, green and blue
values each times 0.7, rounded to the nearest whole number (halves up), opaque, so it keeps the hue (`#7f3c8d` and
`#7f3c8dcc` give `#592a63`). goatlib's `shade` (`style/colors.py`) and the web client compute it the same way.
On points it is a darker shade of the marker color. A fill color by classes, zoom stops or a palette ramp is darkened
class by class and stop by stop when the style is compiled. A color read from a field as it is (`{ "field": ... }`
without a palette) cannot be darkened then, so the outline takes the data's color itself; where the data holds no
valid color, the outline is the shade of the fallback, as for any fixed color. New polygon layers get `"auto"`
(section 18).

> "Planned areas hatched in red on a light red tint, protected areas cross-hatched in green."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
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
  pattern is drawn on top of the fill, in `pattern_color` (default: the fill's hue), at full opacity. For a hatch
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
  "version": "1.0.0",
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
- `casing.color: "auto"` is a darker shade of the color each feature's line has (from the base, its class and the
  rules), worked out as the outline's `"auto"` (3.1).
- `arrows.placement`:
  - `repeat` places arrows along the line every `spacing` px (at least 1);
  - `center`, `start`, `end` and `both_ends` place one arrow per feature, at points the tile service computes from
    the whole line (section 16), not per tile piece.

  `direction`: `forward`, `backward`, `both`. Without `color` the arrows take the line's hue.
- `arrows.icon` is the icon drawn as the arrow: GOAT's arrow (`goat:arrow`) by default, or any icon a marker takes
  (a library icon, an emoji or an upload, section 1). It is one icon for the whole layer. Its top points the way the
  arrow points, along the line in its drawing direction (`forward`), against it (`backward`) or both ways, so an icon
  that points up (`goat:arrow-up-solid`) shows the direction. Library icons take
  `color`; uploads and emoji keep their own colors. `goat:arrow` is the arrows' own icon, in no library: a marker
  cannot take it (`unknown_icon`).
- `arrows.turn_with_line` (default `true`): the icon turns with the line as above, or, with `false`, stays upright on
  the screen, as a tree or a bus symbol should; an upright icon points nowhere, so `direction` changes nothing then.
  One value for the whole layer. The editor switches it off when the user picks another icon than GOAT's arrow and
  on again for the arrow; the user can switch it either way.

> "Tram routes with an upright tram symbol every 80 px along the line."

<!-- check: routes -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "line": { "color": "#4d4d4d", "width": 2 },
    "arrows": { "placement": "repeat", "spacing": 80, "size": 14, "icon": "goat:rail-light", "turn_with_line": false }
  }
}
```

> "Square ends, sharp corners, a soft glow, red arrows at both ends pointing both ways."

<!-- check: routes -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "line": { "color": "#2166ac", "width": 3 },
    "arrows": { "placement": "start", "size": 12 }
  }
}
```

### 3.3 Marker

> "Schools as dark green circles of 8 px with a white outline."

<!-- check: schools -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  without an outline only the icon and the label show. The icon on a hollow marker takes the marker's hue unless
  `icon_color` is set. `fill` is a switch, not a value by zoom or attribute; classes and rules may set it, and the icon
  alone ignores it. Default `true`.
- `size` is the circle diameter or the icon height in px.
- `rotation` is in degrees clockwise from north: the icon turns with the map.
- `anchor`: the point of the icon that sits on the feature: `center`, `top`, `bottom`, `left`, `right`, `top_left`,
  `top_right`, `bottom_left`, `bottom_right` (the panel offers all nine, for an icon alone and for pins).
- `offset` is `[x, y]` in px.
- `allow_overlap: true` draws icons even where they collide with other symbols. Circles never collide.
- `outline` on points draws around the circle. On `shape: icon` it is a halo around library icons, which needs SDF
  icons with a buffer (16). Uploaded icons get no outline (`outline_not_drawn`, info). Point outlines cannot be
  dashed (`dash_on_point_outline`) and take no `position` (`position_on_point_outline`).

<!-- check: schools -->
<!-- expect: dash_on_point_outline -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 }, "outline": { "color": "#ffffff", "width": 1, "dash": "dashed" } }
}
```

**Markers on polygons and lines.**

> "A park icon on every green district."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "fill": { "color": "#deebf7", "opacity": 0.6 }, "outline": { "color": "#ffffff", "width": 1 } },
  "classify": [
    {
      "field": "land_use",
      "method": "categories",
      "classes": [
        {
          "values": ["green"],
          "name": "Green",
          "fill": { "color": "#c7e9c0" },
          "marker": { "shape": "circle", "icon": "goat:park", "color": "#238b45", "size": 20 }
        }
      ]
    }
  ]
}
```

> "Each district with a circle sized by its population, the name beside it."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#f0f0f0" },
    "outline": { "color": "#bdbdbd", "width": 1 },
    "marker": {
      "color": "#08519c",
      "opacity": 0.8,
      "size": { "field": "population", "domain": [0, 30000], "range": [0, 40], "scale": "sqrt", "title": "Inhabitants" }
    },
    "label": { "text": "{name}", "size": 11 }
  }
}
```

> "A bus icon in the middle of each route."

<!-- check: routes -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "line": { "color": "#2166ac", "width": 3 },
    "marker": { "shape": "circle", "icon": "goat:bus", "color": "#2166ac", "size": 18 }
  }
}
```

- `marker` is a part of polygons and lines too. It is off there until a record sets it (the main parts stay `fill`
  and `line`), so a class or rule may switch it on for its own features: the park icon above shows on green
  districts only.
- One marker per feature: on a polygon at one point inside it, the point its label takes (the tile service's label
  anchor, section 15); on a line at its middle (the tile service's center point, as for arrows at the `center`). A
  polygon or a line cut by tile borders still gets one marker. At low zooms the tile service leaves out some anchors
  where its tiles are too full, as for labels; those markers show from a higher zoom.
- Every marker key works as on points: the shapes, the pins and the icon alone, `icon_color`, `fill`, `size` (by
  zoom, by attribute, per class), `opacity`, `rotation`, `anchor`, `offset`, `allow_overlap` and the part's zooms.
  The marker is always one image per look, a plain circle too, so it draws where it collides unless `allow_overlap`
  is false, and labels move away from it.
- No outline: `outline` is the polygon's border, so a marker on a polygon or a line draws without a stroke, and a
  hollow marker (`fill: false`) shows its icon only.
- It draws above the fill, its pattern, the outline, the line, its casing and arrows, and below the labels.
- An area's label and a line's label at its middle take the positions of a point's label around the marker (3.4):
  `auto` (the default on areas) beside it, under it first, then above it, left or right of it; a fixed side; or the
  middle (`inside` on areas, `center` on lines), on the marker. A label along the line (`line`) stays along the line.
- On raised polygons (3.6) the marker sits on the roof, as the label does.
- Clusters, heatmaps and H3 hexagons stay drawings of points (`render_not_for_geometry`).
- In the legend (7.2) the swatch is the area or the line with the marker in its middle; size samples and classes
  that set the marker's size show the markers alone, as for points.

### 3.4 Label

> "District name inside each district, bold, with a white halo, from zoom 11."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  - points: `auto` (MapLibre tries positions around the marker and takes one that is free), `center` (on the
    point), or a fixed side of the marker, named by where the label sits: `above`, `below`, `left`, `right`,
    `above_left`, `above_right`, `below_left`, `below_right`. A label at a fixed side keeps clear of the marker as
    `auto` does (half the marker size plus 2 px); it is never moved to another side, and on a collision it is
    dropped unless `allow_overlap` is on;
  - lines: `line` (along the line, repeated), or one label per line at its middle, a point from the tile service,
    placed there as a point's label: `auto`, `center` (on the middle) or a fixed side;
  - polygons: one label per polygon at a point inside it from the tile service, placed there as a point's label:
    `auto` (the default), `inside` (on that point) or a fixed side.

  The middle of an area is `inside`, of a point or a line `center`: each geometry has one word for it, and the other
  is `placement_not_for_geometry`, as is any placement of another geometry (`line` on points or polygons, `inside`
  on points or lines). The panel shows both as In the middle.

  Around the marker of an area or a line's middle (3.3) the positions work as on points: a fixed side keeps half
  the marker size plus 2 px from the point, the middle puts the label on the marker. Without a marker a fixed side
  keeps 2 px from the point, as on a point without a marker, while `auto` puts the label on the point, as `inside`
  and `center` do: with nothing to clear, an area's or a line's label names the feature from its middle. On a
  GeoJSON source a line has no center point: MapLibre puts the label at the middle of the line itself, where a fixed
  side moves it (upright, as the marker there) but `auto` cannot, so `auto` stays on the line's middle.
- `offset` is `[x, y]` in px. `max_width` wraps lines longer than this many px.
- `lines` styles the lines of the template in order: `size`, `color`, `font`. Lines without an entry keep the label's
  style. A line's `font` replaces the label's font for that line (a key it leaves out takes its default). The panel
  edits them in the label's Line styles editor.
- `priority`: `{ "field", "top": "largest" | "smallest" }` decides which label wins a collision.
- `font.weight`: `light`, `regular` (the default), `medium` or `bold`; `font.style`: `normal` (upright, the default)
  or `italic`. Every weight is drawn upright and italic, in Noto Sans (15, 16). Both switch at zoom stops; classes and
  rules may set them, and their `font` merges over the label's. The panel edits both keys as one Font choice of eight
  (the four weights under Upright and under Italic; an italic font is named in full, Regular italic as Italic), by
  zoom with the same stops for both.
- `transform`: `none` (as written, the default), `uppercase` or `lowercase`. It changes the whole text, the `k` and `M`
  of abbreviated numbers included. Switches at zoom stops; classes and rules may set it.
- `letter_spacing`: extra space between the letters in ems of the label size (0.1 is a tenth of the size); negative
  draws them closer. Default 0. Blends by zoom; classes and rules may set it; no mapping by attribute.
- `line_height`: the distance from one line of the label to the next in ems of the label size, default 1.2. One value
  for the whole layer (MapLibre takes none per feature), fixed or by zoom.
- `spacing`: how far apart a label along a line repeats, in px, at least 1, default 250. Only for `placement: line`.
  One value for the whole layer, fixed or by zoom.
- `padding`: the free space in px kept around each label, 0 or more, default 2. Labels whose boxes and this space
  would touch collide, so a larger value keeps labels further apart and draws fewer of them. One value for the whole
  layer, fixed or by zoom.
- Beside a marker (`placement: auto` and the fixed sides) the lines of a label line up on the marker's side:
  left aligned to the right of it (`right`, `above_right`, `below_right`), right aligned to the left of it; above
  and below it they are centered.

> "District names in capitals with wide letter spacing, and the population in a second line set close below."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#deebf7" },
    "label": {
      "text": "{name}\n{population}",
      "transform": "uppercase",
      "letter_spacing": 0.1,
      "line_height": 1.1,
      "placement": "inside"
    }
  }
}
```

<!-- check: districts -->
<!-- expect: template_syntax -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "fill": { "color": "#deebf7" }, "label": { "text": "{{ name }}" } }
}
```

> "School names above their circles; this layer has no popup."

<!-- check: schools -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "geometry": "point",
  "symbol": {
    "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 },
    "label": { "text": "{name}", "size": 11, "placement": "above", "offset": [0, -2] }
  },
  "popup": { "enabled": false }
}
```

> "School names always to the right of their circles, never moved to another side."

<!-- check: schools -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 },
    "label": { "text": "{name}", "size": 11, "placement": "right" }
  }
}
```

> "Route names in italic along the routes, repeated every 400 px, with more room around each name."

<!-- check: routes -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "line": { "color": "#2166ac", "width": 2 },
    "label": {
      "text": "{name}",
      "font": { "style": "italic" },
      "placement": "line",
      "spacing": 400,
      "padding": 8
    }
  }
}
```

> "Route names in medium italic, bold italic from zoom 14."

<!-- check: routes -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "line": { "color": "#2166ac" },
    "label": {
      "text": "{name}",
      "font": {
        "weight": { "zoom": [[10, "medium"], [14, "bold"]], "interpolate": "step" },
        "style": "italic"
      }
    }
  }
}
```

### 3.5 Zoom ranges

> "The layer from zoom 8; fill only from zoom 12 to 18, outline always, labels from zoom 13."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "line": { "color": "#2166ac", "width": 3 } },
  "classify": [{ "field": "status", "method": "categories", "classes": [{ "values": ["planned"], "min_zoom": 12.5 }] }]
}
```

### 3.6 Height (polygons in 3D)

The part `extrude` draws each polygon as a volume from `base` up to `height`, in metres above the ground. The UI calls
it "Height". Like every part it is off while absent and `false` switches it off.

> "Districts as volumes, taller where more people live; green areas flat; names on the roofs."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#d9d9d9", "opacity": 0.9 },
    "outline": { "color": "#636363", "width": 1 },
    "extrude": { "height": { "field": "density", "range": [0, 300] } },
    "label": { "text": "{name}" }
  },
  "classify": [
    {
      "id": "use",
      "field": "land_use",
      "method": "categories",
      "classes": [{ "id": "green", "values": ["green"], "name": "Green", "extrude": false }]
    }
  ]
}
```

- `height`: metres, 0 to 5000; fixed, by zoom, by attribute (`{ "field", "range" }`, or a raw field `{ "field" }`
  whose values are the heights), classes and rules. Default 10 when the part is on without a height. A feature without
  a value stands at 0.
- `base`: where the volume starts, metres, 0 to 5000, the same forms; default 0. A fixed base above a fixed height is
  `base_above_height`; for values from the data the compiler takes the smaller of the two as the base.
- `unit`: `m` (default) or `storeys`. With `storeys`, a raw field's values count storeys of 3 m
  (`"height": { "field": "levels" }, "unit": "storeys"`). Fixed values, zoom stops and attribute ranges are always
  metres. `unit` is per layer.
- A class or rule with `extrude: false` draws its features flat (height 0) in the same layer. A classification can
  target `extrude.height` or `extrude.base`; generated classes take their numbers from `range` (default 0 to 50 m for
  the height, 0 to 10 m for the base).
- MapLibre draws a volume with one opacity for the whole layer, so while `extrude` is on `fill.opacity` is fixed or by
  zoom: in a class, in a rule, by attribute or as a classification target it is `override_not_per_feature`. A fill
  pattern is not drawn on volumes (`extrude_drops_pattern`).
- The outline stays a line on the ground. Polygon labels (placed at an anchor point inside each polygon) sit on the
  roof; there is no key for it.
- Volumes are drawn whatever the view: at pitch 0 they read as flat roofs. Tilting the map is the map document's
  `view.mode` (10.1), not the layer's.
- Shadows: MapLibre does not cast shadows from volumes yet. It is adding `fill-extrusion-shadow-opacity` and
  `fill-extrusion-shadow-color` (style-spec PR #1870, GL JS issue #8830), with the direction taken from the root
  light that the scene's `light` (10.2) already sets. GOAT will turn them on once GL JS ships them. Sun position
  returns with shadows.

<!-- check: districts -->
<!-- expect: base_above_height, extrude_drops_pattern -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": {
    "fill": { "color": "#fdb462", "pattern": "hatch_45" },
    "extrude": { "height": 20, "base": 30 }
  }
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
  "version": "1.0.0",
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
- A marker drawn as one image (a shape, a pin, a circle with an icon, any marker on a polygon or a line, 3.3) and a
  fill pattern (3.1) carry their colors in the image, and the map picks an image once per whole zoom. Their colors by
  zoom therefore change in whole zoom steps: between two stops, the color the stops blend to at each whole zoom, kept
  up to the next one (at zoom 12.5, the color at 12). The same holds for the stroke width of a marker image. Circles,
  icons alone, fills and lines blend at every zoom.

> "Dotted outlines when zoomed out, dashed from 13, solid from 16."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "marker": { "shape": "icon", "color": "#f28e2b", "icon": { "zoom": [[11, "goat:circle-solid"], [15, "goat:star-solid"]] } } }
}
```

### 4.3 By attribute

> "Districts colored by density on a continuous ramp; outline width by population."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
- **`no_data`** is the value for features where the field is missing (left out or null) or not a number (default: the property's base
  value, that is its default from the reference).
- **`title`** names the legend section (default: the field's display name).
- **Field values used as they are:** without `palette` or `range` the field's value is used directly: degrees for
  `rotation` (3.3), or hex colors from a text field.

### 4.4 By zoom, with attribute values in the stops

> "Circles sized by pupils, twice as large at zoom 16 as at zoom 11."

<!-- check: schools -->
```json
{
  "version": "1.0.0",
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

Between two stops each feature's value is blended from the values the two stops give it, by the stops' curve: sizes
and colors alike. A color on a marker image or a pattern does so in whole zoom steps, as a color by zoom does (4.2).

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
| `dash`, `join`, outline `position`, fill `pattern`, `pattern_spacing`, `pattern_width`, marker `anchor`, marker `icon`, label `font.weight`, `font.style`, label `transform`, label `text` | steps | no | per feature |
| line `cap` | steps | no | per feature from MapLibre 6, per layer before |
| marker `offset`, label `offset`, label `letter_spacing` | blend | no | per feature (circles: per layer, see below) |
| arrows `spacing`, label `line_height`, `spacing`, `padding` | blend | no | per layer |
| layer `opacity`, heatmap `intensity`, raster settings | blend | no | per layer |
| marker `fill` | no | no | per feature |
| extrude `height`, `base` | blend | yes | per feature |
| extrude `unit`; fill `opacity` while `extrude` is on (3.6) | no (opacity: blend) | no | per layer |
| marker `shape`, `allow_overlap`; arrows `placement`, `direction`, `icon`, `turn_with_line`; label `placement`, `lines`, `priority`, `allow_overlap`, `format`, `formats` | no | no | per layer |

- MapLibre cannot move circles per feature (`circle-translate` takes no data), so a circle marker moves by the base
  `offset` only; offsets in classes and rules move icons and labels.

### 4.6 Opacity

The opacity a viewer sees is layer `opacity` x part `opacity` x the color's own alpha, honored everywhere; a class or
rule `opacity` replaces the part's. A color at alpha 0 is "None": it draws nothing and keeps its hue (`#cc615c00`). A
color that is not set and follows another (a pattern, arrows, a hollow marker's icon) and an `"auto"` edge (3.1) take
that hue opaque; `"fill"` copies the alpha. One fixed None color gives its part no MapLibre layer and no clicks (16); a
class, rule or zoom stop at None keeps its features on the layer (clicks, highlight). In MapLibre:

- Fills and lines take the layer opacity as `fill-layer-opacity` and `line-layer-opacity` (MapLibre 6): overlaps of one
  layer do not darken, a polygon's fill and outline still blend; circles, icons and labels multiply it in.
- An icon's outline is MapLibre's icon halo, without opacity: an outline at opacity 0 draws no halo, any other fully.
- Hillshade: the layer opacity multiplies its colors' alpha. Extrusion: MapLibre drops the color's alpha: a fixed fill's
  goes into the volumes' opacity, a varying one is lost; a None class or rule is not drawn and takes no clicks.

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
  "version": "1.0.0",
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
  `["true"]`, `["2.5"]`. A class value that writes a number in another spelling than the one the map reads (`"3.0"`,
  `"0.50"`, `"1e-05"`) also matches the number's own spelling (`to-string`: JavaScript's text of the number), unless
  a class of the classification lists that spelling itself; a text field holding `"3.0"` still matches `"3.0"`.
- **Names:** `name` is the legend text. The default is the values joined with ", ".

> "One-way routes darker."

<!-- check: routes -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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

- **Methods:** `quantile`, `equal_interval`, `natural_breaks`, `std_dev`, `heads_and_tails`, `geometric_interval`,
  `manual`, `categories` (formulas in 5.8).
- **Classes:** a class covers `from` (inclusive) to `to` (exclusive); the first has no `from`, the last no `to` (on a
  raster with `outside: "hide"` they may have them: where the drawing stops, 9.4). Classes are sorted, without gaps or
  overlaps (`classes_invalid`).
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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

- A palette spreads its colors evenly over t = 0 to 1 and blends in Lab between them, their alphas linearly.
- A domain with d0 = d1 gives every feature the start value. A reversed domain (d0 > d1) is the same scale the other
  way round. A `sqrt` domain starting below 0 starts at 0; a `log` domain that does not start above 0 draws the start
  value until it is fixed.

**Classification methods.** Input: the non-null values of the field over the whole dataset (12).

| Method | Breaks |
|---|---|
| `quantile` | the k/count quantiles, k = 1 to count - 1 (linear interpolation, as numpy's default); where many values are the same, breaks fall together or onto the minimum or maximum and merge, so fewer classes can result (info `classes_merged`) |
| `equal_interval` | min + k x (max - min) / count, over the data's min and max (not the domain) |
| `natural_breaks` | Jenks (Fisher's exact optimization) on at most 10,000 values, sampled by feature id when there are more |
| `std_dev` | classes one standard deviation wide around the mean; an even count puts a break at the mean, an odd count centers the middle class on it (mean +- 0.5 sd); the outer classes are open |
| `heads_and_tails` | split at the mean, then repeat on the part above the mean while it holds under 40% of the values, up to count classes |
| `geometric_interval` | min x (max / min)^(k / count), k = 1 to count - 1 (computed in log space): each class is wider than the one before by the same factor; needs every value above 0, so with a value at or below 0 there are no breaks and one class (info `classes_merged` says why; the editors of a field and of a raster band do not offer the method there, the H3 editor offers it always) |
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  negates the result: `not (traffic < 1500)` holds for routes without `traffic`. `isNull` tests for a missing value: a property left out or holding null (0, an empty text and false are values).
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
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 } },
  "rules": [{ "when": { "op": "like", "args": [{ "property": "name" }, "Primary%school%"] }, "visible": false }]
}
```

<!-- check: schools -->
<!-- expect: operator_type_mismatch -->
```json
{
  "version": "1.0.0",
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

- **Merging:** an override changes only the keys it names. `false` switches a part off, and an object switches on a
  part the base leaves out; a part the base switches off stays off (section 3). `visible` and the feature zoom range follow the same "last one wins". A feature that matches no
  class keeps the base.
- **Example:** in 5.6 a planned primary school gets the green from "School type", the red outline and its width from
  "Status", and its size from the base.
- **Per-feature keys** (4.5) may be set anywhere: base, classes, rules.
- **Per-layer keys** hold one value for the whole MapLibre layer: marker `shape` and `allow_overlap`; arrows
  `placement`, `direction`, `spacing`, `icon` and `turn_with_line`; label `placement`, `line_height`, `spacing`, `padding`, `lines`,
  `priority`, `allow_overlap`, `format` and `formats`.
  - They may be set in one place only: the base, or a single class or rule.
  - The one-way rule above can set the arrows' placement because nothing else sets it.
  - Setting a per-layer key in two places is `override_not_per_feature`.

<!-- check: routes -->
<!-- expect: override_not_per_feature -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
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

`legend` takes `show` (default true), `title` (default: the layer name), `caption`, `display`, for vector layers
`classes`, and for rasters `unit`, `min_label`, `max_label`. `"legend": false` is short for `{ "show": false }`.
`display` is `standard` (default: the entries below) or `name_only`: the layer shows in the legend with its name (and
the swatch of its look where the layer list has one) and no entries, for a hillshade, an aerial photo or a long
category list. A `title` set with `name_only` shows under the layer's name as the legend's heading.
Classifications, classes and rules take `legend: false` to leave themselves out.

`classes` says which classes of the classifications the legend lists, wherever it shows (the layer list, the style
panel, print layouts, dashboards and published maps):

- `all`: every class.
- `filter` (default): the classes that still have features under the layer's filter (the map document's `filter`,
  section 10); a layer without a filter lists every class. The web asks the server to count them once per filter
  change, never per tile, and nothing is stored in the document (`computed` stays unfiltered, section 12).
- `view`: the classes drawn in the map's current view, counted in the browser from the features the map has drawn
  after each move (not during it), with no server request. In print, the view is the print map's extent; a print
  legend without a map lists every class.

It applies to the entries of classifications alone: classes, `other` and `no_data`. A class with no features is left
out the way a class hidden with the eye is, and a classification left with no entries leaves no section. `other` and
`no_data` are listed as before (when the data holds such features) and left out too when the count finds none of
them. Until the counts arrive, the legend lists every class. Ramps, size samples, heights, heatmaps, H3 hexagons,
rasters and map services do not change.

| Construct | Legend entry |
|---|---|
| layer without classifications | one swatch with the layer name |
| classification | a section titled `title` (default: the field's display name; classifications of one field with the same classes, categories or numeric bounds, are one section whose entries show all they set), one entry per class in list order, then `other`, then `no_data` (these two when the data holds such features, `computed.other` and `computed.no_data`, with the look the style gives them or the base look; while not computed, when the style has a record; never when hidden or left out); none while it has no classes (not computed yet, or the field has no values) |
| class | its `name` (default: the values joined with ", ", numbers with the unit and the values of a yes/no field as "Yes" and "No", or the range text; a name cut off shows in full on hover), a swatch of the class's parts in a fixed box; classes that set a size are drawn at sizes in the ratio they have to each other (the largest at most 28 px for markers, 12 px for lines, 6 px for outlines); a class of the height alone a bar and its height in metres; classes of the outline's color alone a ring |
| rule | its `name`, a swatch of what it changes; a rule that hides its features has no entry; rules that only set zooms need `legend: false` (or show a plain entry); in a layer without classes the features no rule matches follow as "Other features" |
| value form with `palette` | a color ramp with the domain's ends, formatted |
| value form with `range` (sizes, widths) | three samples at the start, middle and end of the domain, under the field's name |
| marker on polygons and lines (3.3) | the swatch draws the area or the line with the marker in its middle; size samples and classes that set the marker's size draw the markers alone, as for points |
| heatmap | a ramp "Low" to "High"; nothing of the points (classes, rules) while they are not drawn, and only the points from `points_from_zoom` on |
| cluster | "Clusters" with a sample while the map clusters (below `cluster_until_zoom`): the cluster symbol, or the points' base marker for `look: points`, with a badge for `count: badge`; with a `value` from a field, the entry names it ("Clusters · Sum of pupils") and a size or color by it shows its samples or ramp, in the cluster symbol's other values; then the base and classes for single points, a base swatch on its own as "Single points" |
| H3 | the cell value (`count`, or the field with `sum` or `mean`) as classes or a ramp; one hexagon swatch while the values are not computed; an `"auto"` outline drawn on the swatches in the shade of each (flat hexagons only); the points as for a heatmap |
| `extrude` (3.6, 8.3) | one line after the color entries: "Height" with the fixed height, the top of a by-zoom height, the field (with its range, or "levels x 3 m" for storeys), the number of classes, or for H3 the cell value |
| raster `image` | none, or the file's color table |
| raster `continuous` | a ramp with the domain and `unit`, or classes with the `unit`, an open first or last class closed by the band's minimum and maximum (with `outside: "hide"`, by where the drawing stops: the class's own `from` or `to`, else the domain, 9.4); `min_label` and `max_label` replace the end values |
| raster `categorical` | one entry per class (its value with the `unit`, or its `name`), then Other in `other_color` where one is set (the legend cannot know whether any cell has another value) |
| raster `hillshade` | none, or the ramp when it has a palette |
| map service | the service's legend image for the chosen `service_style`, when it has one |

- **Range text** uses the classification's `format` and `unit`: "under 2,800", "2,800 to 3,600", "6,300 and more";
  the unit goes with the last number: "under 49.4 m", "49.4 to 101.6 m", "101.6 m and more".
- **Only what a swatch draws:** a classification shows in the legend when it sets what a swatch draws: the color,
  size, opacity, width, dash, shape, icon, icon color, hollow fill or pattern of a part, the arrows' color or the
  height. One that sets only a label's text, color or font, a marker's rotation, offset or anchor, a line's offset,
  blur, cap or join, the outline's position, the base of raised features or the arrows' size has no section, joins no
  section of its field and is not counted for `classes`; its classes hidden with the eye still hide their features, on
  the map and so in the legend.
- **Zoom:** swatches of zoom-dependent values use the current map zoom on screen and the print zoom in print; a size or width by zoom is read at the middle of its stops, so symbols do not grow and shrink while the map zooms. A color the map draws in an image (a marker image or a pattern, 4.2) is read at the whole zoom at or below that zoom, the one the map draws it at; ramps of colors by attribute in zoom stops (4.4) too.

> "No legend for this layer."

<!-- check: facilities -->
```json
{ "version": "1.0.0", "kind": "vector", "symbol": { "marker": { "shape": "circle", "color": "#f28e2b", "size": 8 } }, "legend": false, "popup": false }
```

`"popup": false` is short for `{ "enabled": false }`.

> "Schools by type; the legend lists only the types on screen."

<!-- check: schools -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#9aa3ad", "size": 8 } },
  "classify": [
    {
      "id": "type",
      "field": "type",
      "method": "categories",
      "classes": [
        { "values": ["primary"], "name": "Primary", "marker": { "color": "#4e79a7" } },
        { "values": ["secondary"], "name": "Secondary", "marker": { "color": "#f28e2b" } }
      ],
      "other": { "name": "Other", "marker": { "color": "#bab0ac" } }
    }
  ],
  "legend": { "classes": "view" }
}
```

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
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#f28e2b", "size": 10 } },
  "popup": { "trigger": "hover", "blocks": [{ "type": "field_list", "attributes": [{ "field": "name" }] }], "header": "none" }
}
```

> "Districts: the popup in the right sidebar, as some projects use today; the district not highlighted."

<!-- check: districts -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
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
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#f28e2b", "size": 10 } },
  "popup": { "blocks": [{ "type": "button", "label": "Website", "url_template": "{{ website }}", "style": "link" }] }
}
```

A raster file's popup takes the same keys but `highlight_active_feature`, plus `bands`, and the same blocks over the
fields of the cell under the pointer: `value` (the band or formula the style colors), `class` (its class or category)
and `band_1` to `band_<n>` (every band); section 9.7.

## 8. How points are drawn: `render`

`render.type`: `features` (default), `heatmap`, `cluster`, `h3`. Heatmaps and H3 can hand over to the point symbol at
`points_from_zoom`: below it the render type is drawn, from it on the base symbol, classifications and rules.

### 8.1 Heatmap

> "Visitors as a heatmap at city scale, individual facilities from zoom 15."

<!-- check: facilities -->
```json
{
  "version": "1.0.0",
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

- **What the browser loads:** id, coordinates and only the fields the style uses. A popup (on click or on hover) and
  click to filter read the point's own fields from the features API by its id, once per point while its data is
  unchanged.
- **Limit:** layers up to 100,000 features (today's limit, a starting value until measured). Above it the validator
  answers `too_many_features_for_render` and the panel offers H3 or a heatmap.
- **How the points are read** (GeoJSON from the features API as today, or a columnar format) is an implementation
  topic, not part of the style.

> "Schools in clusters with their count, single schools from zoom 14."

<!-- check: schools -->
```json
{
  "version": "1.0.0",
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
- The cluster `symbol` styles the cluster points over the derived fields `count` and `value`; single points use the
  base symbol, classifications and rules. Cluster labels sit on the cluster (`placement` is fixed) and have no halo
  unless the cluster symbol sets one. Cluster numbers, on the label and on the badge, are whole numbers shortened as
  `format.abbreviate` shortens them ("1.2 k", "3.4 M", in the viewer's language) unless the cluster label sets a
  `format`.
- `value` (default `{ "op": "count" }`): what `value` is, the number of points or the `sum`, `mean`, `min` or `max` of
  a number field (`field`) over a cluster's points, computed in the browser with the clusters (the mean is the sum over
  the points with a value; a point whose field is left out or null has none). Clusters without a point with a value show no number and take a size or color's no-data
  value. A size or color by a value from a field needs a `domain`: nothing computes the range of values the browser
  makes (`missing_required` otherwise). The panel starts it at the field's range, for a sum up to ten times its highest
  value. The field must exist and be a number field (`unknown_field`, `field_type_mismatch`).
- `look` (default `circle`): `circle` draws the cluster symbol's marker, a circle sized by the count unless it says
  otherwise; `points` draws each cluster with the points' own marker and outline (shape, icon, color, size), not sized
  by the count. A cluster has no attribute values: a value by attribute is the middle of its range or its palette, else
  its `no_data`. Where a categories classification sets the icon (or else the color), a cluster shows the icon and
  color of the category most of its points have, the first class on a tie, and the base marker's where more of them
  are in no class (Other, No data). Clusters count the first 12 classes that set an icon or a color, in list order; the
  points of the other classes count as in no class.
- `count` (default `center`): `center` puts the cluster symbol's label on the cluster; `badge` draws the count on a
  small filled circle at the upper right of the cluster's marker, whatever its size: in the cluster symbol's marker
  color, ringed in its outline (a white ring of 1.5 px where it has none, so the badge stands off a marker of its own
  color), the number its label shows (the count unless it shows the value) in its label color (white where it sets
  none).

> "Schools with an icon by type, clustered as their icons with the count on a badge, as GOAT has drawn marker
> clusters."

<!-- check: schools -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "render": {
    "type": "cluster",
    "look": "points",
    "count": "badge",
    "symbol": { "marker": { "color": "#283593" }, "label": { "text": "{count}", "color": "#ffffff" } }
  },
  "symbol": { "marker": { "shape": "icon", "icon": "goat:building", "color": "#5a1846", "size": 24 } },
  "classify": [
    {
      "id": "type",
      "field": "type",
      "method": "categories",
      "classes": [
        { "values": ["primary"], "name": "Primary", "marker": { "icon": "goat:school" } },
        { "values": ["secondary"], "name": "Secondary", "marker": { "icon": "goat:home" } }
      ]
    }
  ]
}
```

> "Schools clustered in circles sized by their pupils, the number of pupils on each."

<!-- check: schools -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "render": {
    "type": "cluster",
    "value": { "op": "sum", "field": "pupils" },
    "symbol": {
      "marker": { "shape": "circle", "color": "#2166ac", "size": { "field": "value", "range": [16, 48], "scale": "sqrt", "domain": [0, 5000] } },
      "label": { "text": "{value}", "color": "#ffffff" }
    }
  },
  "symbol": { "marker": { "shape": "circle", "color": "#2166ac", "size": 8 } }
}
```

### 8.3 H3 hexagons

H3 is computed **on the server**. geoapi serves hexagon tiles on request, like its other derived tile layers: for each
tile it groups the points of the cells the tile touches by H3 cell (DuckDB's h3 extension, which goatlib already uses)
and returns the hexagons with their value. Cells are global, so there are no seams at tile borders, values are exact,
and there is no feature limit.

> "Pupils per H3 hexagon in quantile classes, schools as points from zoom 15."

<!-- check: schools -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
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
- `opacity` is the hexagons' part opacity; `outline` draws the cell borders, with `color` `"auto"` in a darker shade
  of each hexagon's color (3.1, 18.10).

**Columns.** `extrude` raises each hexagon into a column as tall as its value.

> "Pupils per hexagon as columns up to 1500 m."

<!-- check: schools -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "render": {
    "type": "h3",
    "resolution": "auto",
    "value": { "op": "sum", "field": "pupils" },
    "palette": "colorbrewer:OrRd",
    "extrude": { "tallest": 1500, "scale": "sqrt" }
  },
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 7 } }
}
```

- `tallest`: metres, 0 to 200000, fixed or by zoom; default 1000. `base`: metres, 0 to 200000, fixed or by zoom;
  default 0. `scale`: `linear` or `sqrt` (default). Columns chart a value, they are not real heights, so they go far
  above the 5000 m of polygon heights (3.6): hexagons drawn at country zoom are about 20 km wide, and a column a few
  times its width reads as one.
- The cell value that colors a hexagon sets its height: scaled with `scale` (5.8) over the server's computed minimum and
  maximum of that resolution (section 12) to 0 to `tallest`, on top of `base`. Without computed values (or where the
  minimum equals the maximum) every column stands at half of `tallest`. With manual classes the server still computes
  the range for the heights.
- While extruded the outline is not drawn; `opacity` stays one value for the layer.
- `extrude` absent: flat hexagons. `extrude` on any other `render` is `unknown_key`.

## 9. Raster styles

<!-- check: elevation -->
```json
{
  "version": "1.0.0",
  "kind": "raster",
  "opacity": 0.8,
  "resampling": "linear",
  "render": { "type": "hillshade", "method": "standard", "direction": 315, "altitude": 45, "exaggeration": 0.5 },
  "legend": { "show": true, "title": "Elevation", "unit": "m" }
}
```

**Top-level keys:**

- `version`, `kind: "raster"`, `opacity`, `min_zoom`, `max_zoom`, `resampling` (`linear` or `nearest`; default `nearest`
  for continuous, categorical and hillshade colors, `linear` for images and shading; codes never blend, so
  `categorical` and an image drawn with its file's color table draw `nearest` whatever it says), `render`, `legend`,
  `popup`;
- for `image` also the adjustments `brightness`, `contrast`, `saturation` (-1 to 1, default 0) and `hue` (degrees).

**Render types:** `image`, `continuous`, `categorical`, `hillshade`. Every type takes:

- `no_data: { "values": [...] }`, cells with these values are transparent. The default is the file's own no-data
  value from the raster metadata, so most styles leave it out.
- `band`, except `image`.

The raster service (geoapi) reads the cells and MapLibre colors them: `continuous`, `categorical` with classes and
`hillshade` draw value tiles, so a color edit loads no tiles and a new band, formula or `resampling` does; so does an
image drawn with its file's color table (9.1). The service colors other images, colors over float cells of an unknown
range, and colorings past 4096 stops whose token fits in a URL (else not supported). Screen and print look the same.
Map services (9.8) draw as sent, adjustments as MapLibre paint.

### 9.1 Image

> "The satellite image as true color, a bit brighter and more saturated."

<!-- check: satellite -->
```json
{
  "version": "1.0.0",
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
{ "version": "1.0.0", "kind": "raster", "render": { "type": "image", "bands": [4, 1, 2] } }
```

> "Land cover in the file's own colors."

<!-- check: landcover -->
```json
{ "version": "1.0.0", "kind": "raster", "resampling": "nearest", "render": { "type": "image" } }
```

- `bands` maps three bands to red, green and blue (rasters with three or more bands). Without `bands` an image draws
  the file's color table; else the bands the file marks red, green and blue (its color interpretation), in that order,
  where it marks all three; else its first three bands of values (an alpha band holds none). A single-band raster
  without a color table is drawn in grey from its lowest to its highest value.
- **An image drawn with its file's color table** (no `bands`, values not scaled, a table of at most 256 entries) is
  drawn from the value tiles of the band the table colors, read `nearest`: each entry's code in its color (an entry
  drawn partly transparent with its alpha), codes without an entry, entries drawn fully transparent, the file's and
  the style's no data transparent. It draws the picture the service would, and the map holds every cell's code (9.7),
  also where entries share a color. The adjustments go onto the table's colors with the formulas of MapLibre's raster
  layer (hue, saturation, contrast, brightness), so it looks as the image would; adjustments that vary by zoom cannot
  be colors of codes, so such a style draws the service's colored tiles, as other images do.
- `brightness` b compiles to MapLibre as `raster-brightness-min = max(0, b)` and `raster-brightness-max = min(1, 1 + b)`;
  `contrast`, `saturation` and `hue` map one to one to `raster-contrast`, `raster-saturation`, `raster-hue-rotate`.

### 9.2 Color range

> "Elevation from 200 to 450 m on the elevation palette, values outside transparent."

<!-- check: elevation -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
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
- `outside`: `clamp` (values beyond take the end colors, default) or `hide`. It applies to classes too (9.4).
- `interpolate` (stops only): `linear`, or `nearest` (each cell takes the color of the closest stop, today's
  `interpolate: false`).

> "Elevation as a ramp, the legend ends labelled Low and High."

<!-- check: elevation -->
```json
{
  "version": "1.0.0",
  "kind": "raster",
  "render": { "type": "continuous", "palette": "goat:elevation" },
  "legend": { "title": "Elevation", "unit": "m", "min_label": "Low", "max_label": "High" }
}
```

### 9.3 Bands and band formulas

> "Color the near infrared band."

<!-- check: satellite -->
```json
{ "version": "1.0.0", "kind": "raster", "render": { "type": "continuous", "band": 4, "palette": "d3:viridis", "domain": [10, 230] } }
```

> "Vegetation index (NDVI) in five equal classes."

<!-- check: satellite -->
```json
{
  "version": "1.0.0",
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

`band` is a band number (from 1) or a formula: its `name` (the popup's label for the value) and its `expression` of
`b1`, `b2`, ... (bands of values of the file), numbers, `+ - * /`, unary minus and brackets, at most 500 characters
long. The panel offers NDVI, NDMI and NDWI:
a normalized difference `(a - b) / (a + b)` of two bands under that name, which the panel shows with its bands; the
name tells the three apart, as their expressions share one shape.

### 9.4 Classes on a raster

The classification shape is the one of 5.2 without `field` (the band is the input) and with a `color` per class
instead of part records. The server fills `from`, `to` and missing colors (from the render's `palette`); what the author
sets on a class by position survives a recompute (section 12).

> "Elevation in quantile classes, my own color for the second class, the lowest named 'Valley floor', the highest
> hidden."

<!-- check: elevation -->
```json
{
  "version": "1.0.0",
  "kind": "raster",
  "render": {
    "type": "continuous",
    "palette": "goat:elevation",
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
  "version": "1.0.0",
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

Quantiles, natural breaks, standard deviation, geometric intervals and heads and tails classes come from a sample of
the whole band's values (its overviews), computed with the same class break statistics as a vector field's when the
style is checked (section 12). `domain` does not narrow them: they classify every value of the band, so the breaks an
editor offers for a method and count are the classes the style keeps. Equal intervals split `domain` when it is set,
else the band's range. Geometric intervals need every value of the band above 0.

**Whole numbers.** On a band that holds whole numbers as it is read (an integer data type, neither scaled nor offset;
not a formula, though a formula of one band alone, `b2`, is that band), every computed method's breaks are whole
numbers, equal intervals included: each break is rounded half up (from its twelve significant digits), and breaks that
round together, or onto the band's minimum or maximum, are kept once, so fewer classes result (info `classes_merged`).
Class names and the legend then read "28 to 84". Manual breaks stay as written.

**Values outside the classes** follow `outside` (9.2). With `clamp` (default) the first and last class are open: the
cells below and above take their colors, whatever `from` or `to` they carry. With `hide` the first class starts at its
own `from`, else at the start of `domain` (else of the computed one, else of the band's range), and the last class ends
at its own `to`, else at the end of that range, that end included; the cells beyond are transparent, and the class
names and the legend read those ends. An editor lets the author type the two outer ends while `hide` is set: for a
computed method a typed end makes the classes `manual`, the inner breaks stay; equal intervals split the typed range
again, as it is their `domain`.

> "Elevation in my own classes from 250 to 400 m, the cells below and above not drawn."

<!-- check: elevation -->
```json
{
  "version": "1.0.0",
  "kind": "raster",
  "render": {
    "type": "continuous",
    "palette": "goat:elevation",
    "outside": "hide",
    "classify": {
      "method": "manual",
      "classes": [{ "from": 250, "to": 275 }, { "from": 275, "to": 300 }, { "from": 300, "to": 340 }, { "from": 340, "to": 400 }]
    }
  }
}
```

### 9.5 Categories

Categories never blend codes: they draw `nearest` whatever `resampling` says, from value tiles read `nearest` and from
the service's colored tiles, whose cells it always reads nearest. Categories without classes draw the file as stored:
with a color table, as an image drawn with it (9.1), without the adjustments.

> "Land cover classes with my names and colors, wetland hidden, values without a class in grey."

<!-- check: landcover -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
  "kind": "raster",
  "opacity": 0.6,
  "render": { "type": "hillshade", "method": "multidirectional", "direction": 315, "altitude": 45, "exaggeration": 0.6, "shadow_color": "#2d3a4a", "highlight_color": "#ffffff" }
}
```

> "Shaded relief in elevation colors, in classes, steep slopes accented."

<!-- check: elevation -->
```json
{
  "version": "1.0.0",
  "kind": "raster",
  "render": {
    "type": "hillshade",
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

- `band` (default 1): any band of values, so a file holding a surface and a terrain model shades either; codes with a
  color table are no elevation (`render_type_mismatch`).
- `method`: `standard` (one light, `accent_color` for steep slopes), `multidirectional`, `combined`, `igor`, `basic`.
- `direction` (degrees the light comes from, 0 to 359), `altitude` (degrees above the horizon), `exaggeration` (0 to 1).
- With `palette` the shading lies over a color range (`domain`, `classify`, `outside` as in 9.2 and 9.4).
- The layer `opacity` is multiplied into the alpha of the shadow, highlight and accent colors (MapLibre's has none).
- A low relief is raised before it is shaded (16, raster row), at any `exaggeration`, which acts on top of it.

The other methods:

<!-- check: elevation -->
```json
{ "version": "1.0.0", "kind": "raster", "render": { "type": "hillshade", "method": "combined", "exaggeration": 0.5 } }
```

<!-- check: elevation -->
```json
{ "version": "1.0.0", "kind": "raster", "render": { "type": "hillshade", "method": "igor", "exaggeration": 0.7 } }
```

<!-- check: elevation -->
```json
{ "version": "1.0.0", "kind": "raster", "render": { "type": "hillshade", "method": "basic", "shadow_color": "#000000" } }
```

### 9.7 Popup and zooms on rasters

> "Show the values of all bands on click; draw the image from zoom 10."

<!-- check: satellite -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
  "kind": "raster",
  "render": { "type": "continuous", "palette": "goat:elevation", "domain": [181, 440] },
  "popup": { "trigger": "hover", "bands": "styled" },
  "legend": { "unit": "m" }
}
```

A raster popup is the popup of 7.4 over the cell under the pointer, with every key but `highlight_active_feature`
(`unknown_key`: there is no feature to mark), and `bands`:

- **Fields:** `value`, the band or band formula the style colors; `class`, the name of its class (9.4) or category
  (9.5), "Other" for a value in no category when `other_color` is set, left out otherwise and for a ramp without
  classes; `band_1` to `band_<n>`, every band of values of the file (an alpha band, the image's transparency, has no
  field). Blocks and templates name them as fields (7.4), and the validator checks them against the file (`band_9` on
  a 3-band file is `unknown_field`).
- **Without `blocks` or `html`** the popup shows `value` with the legend's `unit`, the cell's color as the map draws
  it beside the value, and `class` as a row labelled "Class" ("Category" for categories) only where the class has a
  name of its own (written in the style), not its range or its code, which the value says; an image draws bands, not
  one value, so its `class` is empty, and so is its `value` but for an image drawn with its color table, whose `value`
  is the code of the band the table colors. An image shows the bands it draws, with the pixel's color where its pixels
  are its values: three bands in one row, named by the bands' names where the file names them all, else "Red, Green,
  Blue" where the file marks them so, else "Color". `bands: "all"` adds every band's value; `styled`, the default,
  does not.
- **Without a `popup` key** a color scale (`continuous`, `categorical`, `hillshade`) opens a popup on click and an
  image none; map services have none (9.8). goatlib's list (`RASTER_POPUP_ON_BY_DEFAULT`) is published in the JSON
  Schema as `x-raster-popup-on`, which the web reads.
- **Where the values come from:** hover reads `value` from the value tiles the map has loaded (9), so it sends no
  request and shows what the map draws. A click shows that value at once, then the exact value and every band from
  the raster service's point query; `band_<n>` is known on click only. An image whose pixels are its values hovers
  the same way, reading the bands it draws from the pixels of the colored tiles the map has loaded: unsigned 8 bit
  bands without a scale or offset, drawn as they are (the three it draws by default without a color table, 9.1, or
  three chosen in `bands`). An image drawn with its file's color table is drawn from value tiles (9.1), so it hovers
  each cell's code, as `value` and `band_<n>`, on every color, also where entries of the table share one; the default
  content shows the code with its entry's color. A code the table has no entry for draws nothing and opens no popup.
  Other images, and a color scale the raster service colors (9), have no values on the map: they never open on hover,
  and a click shows the exact values from the point query only.
- **Pointer:** while the popup is on, whatever opens it, the pointer shows over what it shows: a cell with a value, or a
  pixel the map paints of an image. A hover popup hides while the map moves and reads afresh on the next pointer
  move.
- **Only over drawn cells:** a cell the map does not draw opens no popup and shows no pointer, on hover and on click,
  as a feature its style hides: the style's no data, a value in a hidden class or category, a value in no category
  without `other_color`, and a value beyond the `domain`, the stops or the classes of a color range with
  `outside: "hide"` (9.4). A hillshade draws its shading under any color, so its cells always count.
- **Class names:** a class without a `name` is named by its range as the legend writes it (7.2); an open first or last
  class is closed by the band's minimum and maximum, as classes draw the cells below and above the color range in
  those classes, or with `outside: "hide"` by where the drawing stops (9.4). The band's minimum and maximum come from
  an overview, so a few cells lie beyond them: the popup names such a cell's open class from the cell's own value
  ("-41 to 49.4 m" for a cell of -41 m), while the legend and the panel keep the band's ends. Without a known minimum
  or maximum the open end reads by its bound alone ("under 49.4 m").

> "Elevation on click and while hovering: the height with one decimal and its unit, in a compact popup."

<!-- check: elevation -->
```json
{
  "version": "1.0.0",
  "kind": "raster",
  "render": { "type": "continuous", "palette": "goat:elevation", "domain": [181, 440] },
  "popup": {
    "trigger": "click_and_hover",
    "header": "compact",
    "blocks": [{ "type": "field_list", "attributes": [{ "field": "value", "label": "Elevation", "format": { "decimals": 1, "suffix": " m" } }] }]
  }
}
```

### 9.8 Map services (WMS, WMTS, XYZ)

> "The state's aerial photo from its WMS, in the service's grey style, a bit lighter, from zoom 12."

<!-- check: wms -->
```json
{
  "version": "1.0.0",
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
{ "version": "1.0.0", "kind": "raster", "opacity": 0.5, "saturation": -0.6, "render": { "type": "image" }, "legend": false }
```

> "Color the WMS layer by elevation." A service sends finished pictures, so there is no band to color.

<!-- check: wms -->
<!-- expect: render_not_for_source -->
```json
{ "version": "1.0.0", "kind": "raster", "render": { "type": "continuous", "palette": "goat:elevation" } }
```

- **A map service layer** has a raster style with `render.type: "image"`. `opacity`, the zooms, `resampling` and the
  adjustments of 9.1 apply.
- **`render.service_style`** picks one of the styles the service offers (WMS `STYLES`, WMTS `Style`), from its
  capabilities; it becomes part of the tile URL. Default: the service's first style. XYZ layers have none.
- **Legend:** the service's legend image for that style (WMS `GetLegendGraphic`, WMTS `LegendURL`) when it has one.
  `title` and `caption` apply; `"legend": false` hides it.
- **Not for services** (`render_not_for_source`): `bands`, `no_data`, and the `continuous`, `categorical` and
  `hillshade` renders.
- **Popup:** the service's feature info (WMS `GetFeatureInfo`) for layers the service marks as queryable, with
  `enabled` and `trigger` only (other popup keys are `render_not_for_source`). Later (`not_supported_yet`, section
  19); the default is no popup.
- **Where the pictures come from is not style:** `url`, `layers`, `srs`, `dpi`, `tile_size`, the service version and
  the legend URLs read from the capabilities stay in the layer's service configuration.

## 10. Named styles and the map document

**Named styles** belong to the project layer: it stores up to 10 named styles (id, name, document), one of them
active. The dataset's default style is one more style document stored on the dataset. Viewers of public maps and
dashboards can switch between named styles; their choice is view state (URL or browser), not saved.

The **map document** holds map state only: the basemap, the view, the layer tree, and per layer which named style is
active, its visibility, filter, time position and legend state. "Set as the dataset's default" and the catalog never
carry a project's map state.

**Sizes.** A style document is at most 1 MB (1,000,000 bytes) as compact UTF-8 JSON; a project layer's time position
and a project's scene are at most 64,000 bytes each. core refuses a larger one before anything reads it, stores
nothing and answers 422 with the code `document_too_large` (on a style save, a dataset default write and a check),
`time_value_too_large` or `scene_too_large`. The limit bounds every list of the document as well.

<!-- check: map -->
```json
{
  "version": "1.0.0",
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
  MapLibre's `beforeId`. A raster layer added to a project through core (the panel, the API) whose dataset default
  draws a color range, categories or a hillshade (`continuous`, `categorical`, `hillshade`) starts at `below_labels`,
  so its colors do not hide the place names; images stay on top, and a duplicate of a layer draws where the original
  does. The style panel never moves a layer: when the user switches Draw as from an image to one of these while the
  layer is at `top`, its Position row says that the colors hide the place names and offers the move to
  `below_labels`, until the layer is placed, is no longer at `top` or draws an image again.
- **`locale`** (optional) fixes the number and date locale for public maps, dashboards and print; otherwise the
  viewer's language is used.
- **`view`**: `center`, `zoom`, `pitch`, `bearing`, optional `bounds` (the area the map may not leave), and the 3D
  keys `mode` and `projection` (10.1).
- **`scene`** (optional): the 3D look of the whole map: terrain, basemap buildings, sky, fog, globe glow and light
  (10.2).

### 10.1 The view in 3D

| Key | Values | Missing means |
|---|---|---|
| `pitch` | degrees, 0 to 85 (GOAT's limit inside MapLibre's wider range) | 0 |
| `bearing` | degrees, any number; core stores it from 0 up to (not including) 360 | 0 |
| `mode` | `2d`, `3d` | `3d` when `pitch` is above 0, else `2d` |
| `projection` | `mercator`, `globe` | `mercator` |

- In `2d` the map neither tilts nor rotates. In `3d` it tilts up to 85 degrees and rotates, and the scene (10.2)
  applies. Because a missing `mode` follows the pitch, every view stored before 3D keeps its look.
- `globe` is MapLibre's globe: a sphere when zoomed out that flattens between zoom 8 and 9 and is the flat map from
  zoom 9. It applies in 2D and 3D.
- The view is stored per user (each editor opens the project where they left it); a published map carries the
  publisher's view.

### 10.2 Scene

> "The Alps in 3D in a low evening light from the west, terrain a little steeper, the basemap's buildings, a custom sky."

<!-- check: map -->
```json
{
  "version": "1.0.0",
  "basemap": { "id": "light" },
  "view": { "center": [11.09, 47.49], "zoom": 13, "pitch": 60, "bearing": 30, "mode": "3d", "projection": "globe" },
  "layers": [],
  "scene": {
    "terrain": { "exaggeration": 1.5 },
    "buildings": true,
    "sky": { "color": "#79B8EC", "horizon_blend": { "zoom": [[10, 0.8], [16, 0.4]] } },
    "light": { "direction": 285, "altitude": 15, "intensity": 0.5 }
  }
}
```

Every key is optional, and a missing key is automatic: its value comes from the auto table (18.9) for the basemap's
tone, `light` or `dark` (the dark basemap, and solid or custom basemaps with a dark background, are dark; imagery
follows the app theme). Colors and numbers are fixed or by zoom (4.1, 4.2), never by attribute: they hold for the
whole map.

| Key | Values | Missing means |
|---|---|---|
| `terrain` | `false`, or `{ "exaggeration"? }` | on when the deployment has a terrain source |
| `terrain.exaggeration` | 1 to 3, fixed | 1 |
| `buildings` | boolean, or `{ "on"?, "opacity"? }` | on, unless a drawn layer extrudes (3.6, 8.3) |
| `buildings.on` | boolean, the same as `buildings: true` or `false` | on, unless a drawn layer extrudes |
| `buildings.opacity` | 0 to 1, fixed | 0.6 |
| `sky.color`, `sky.horizon_color` | color | auto |
| `sky.horizon_blend` | 0 to 1 (sky to horizon) | auto |
| `fog` | `{ "color"?, "horizon_blend"?, "ground_blend"? }` | no fog |
| `fog.color` | color | auto |
| `fog.horizon_blend`, `fog.ground_blend` | 0 to 1 (horizon to fog, fog to ground) | auto |
| `glow.strength` | 0 to 1 (the glow around the globe) | auto |
| `glow.color` | color (the halo around the globe) | auto |
| `light.direction` | compass degrees the light comes from, 0 up to (not including) 360, fixed | with the camera |
| `light.altitude` | degrees above the horizon, 0 to 90, fixed | with the camera |
| `light.intensity` | 0 to 1 | auto |
| `light.color` | color | auto |

- **Where it applies.** Terrain, buildings, sky, fog and light apply in 3D; sky and light also on the globe. `terrain`
  and `buildings` are kept in 2D for the next switch to 3D. Rasters drape over the terrain.
- **Terrain** is the deployment's elevation source (Terrarium tiles) with a hillshade over it, except over imagery
  basemaps, which carry their own shading. On the globe the relief shows as shading only; once the map is flat the
  raised terrain rises (zoom 9 to 10, in ten steps) and stands at full `exaggeration` from zoom 10, so points, labels
  and volumes draw correctly on the zoomed-out globe. **Buildings** are the basemap's own 3D buildings, or an extrusion of its
  OpenMapTiles `building` layer, or the deployment's building overlay source on basemaps without heights. Their
  `opacity` lets flat layers on the ground show through them; a layer's own `extrude` keeps its own opacity.
- **Sky and fog.** The automatic sky meets the map without a seam: its horizon colour, and a set fog's missing
  colour, come from the colour of the ground the basemap draws (a vector style's `background` layer, else its lowest
  fill; a solid basemap's colour), leaning towards the tone's sky and horizon colours; over imagery they are one
  neutral blue-grey haze. Where no ground colour is known the auto table's colours apply. A missing `fog` draws no
  fog; a set one shows on terrain, and on the globe it comes in over 1.5 zooms after the globe has handed over to the
  flat map (MapLibre draws no fog on the globe).
- **Light.** One light lights the volumes, the terrain, every hillshade on the map and the globe: it comes from
  `direction` at `altitude`. A missing `light` stands with the viewer instead (MapLibre's viewport light, from 210
  degrees of the view): volumes are lit from the camera's side and the globe's face stays evenly lit, since
  MapLibre's globe atmosphere scatters a sun that stands in front of the planet into a white haze; it stands straight
  behind the planet up to zoom 5 and 30 degrees from straight above from zoom 10. A set light does the same on the
  zoomed-out globe (below zoom 9, where the atmosphere shows), its sun behind the planet toward `direction`, so the
  rim is brighter on that side.
  Sun position returns with shadows (3.6).
- **Globe glow.** Around the zoomed-out globe GOAT draws a halo behind the map: a thin lighter edge in `glow.color`,
  then the colour fading out over a quarter of the globe's radius, as strong as `glow.strength` at the map's zoom (0:
  none). `glow.color` is GOAT's own; MapLibre has no such property. MapLibre's own atmosphere follows the same
  strength: a hairline rim under the automatic light, a crescent on the sun's side under a set light. The automatic
  strength is 1: the glow shows only while the globe draws, and fades with its handover to the flat map.
- **Auto in the UI** means none of `sky`, `fog`, `glow`, `light` is set. A document with only some of them is valid:
  the others stay automatic. Turning Auto off writes nothing; a section's first edit writes it whole from the values
  shown, the light as the automatic light stands on the map for the camera then (direction: 210 plus the map's
  bearing).
- **Warnings:** `fog_without_terrain` (fog shows only over terrain), `buildings_with_extruded_layer` (buildings
  switched on, `true` or `{ "on": true }`, while a drawn layer extrudes, so basemap buildings stand inside it),
  `scene_source_missing` (terrain or buildings the deployment has no source for; only when the caller knows the
  deployment's sources).
- The scene belongs to the project (one for all editors); publishing freezes it into the published map document.

<!-- check: map -->
<!-- expect: fog_without_terrain -->
```json
{
  "version": "1.0.0",
  "basemap": { "id": "light" },
  "layers": [],
  "scene": {
    "terrain": false,
    "fog": { "color": "#E9F1F7" }
  }
}
```

## 11. Validation

Every write is checked: structure first, then against the data. Each issue has:

- `level`: `error` (blocks the write), `warning`, `info`, or `damaged` (a stored style that a later data change broke);
- `code`;
- `path`: a JSON pointer, which may use ids (`/classify/density/classes/2`);
- `message` (English) and, for an editor that words the issue in its own language, `params`: the facts it names;
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
| `unknown_version`, `newer_version`, `newer_patch` | error, `newer_patch` warning | `version` is not three numbers, needs a newer major or minor, or only a newer patch, which is read (14) |
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
| `position_on_point_outline` | error | `position` on a point outline (only polygon outlines run inside or outside their edge) |
| `placement_not_for_geometry` | error | a label `placement` of another geometry (`line` on points or polygons, `inside` on points or lines, `center` on polygons, 3.4) |
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
| `render_not_for_source` | error | what the layer's source cannot do: a render other than `image`, `bands`, `no_data` or a popup key other than `enabled` and `trigger` on a map service; `service_style` on a layer that is not one |
| `unknown_band`, `invalid_band_expression` | error | a band the raster does not have, a formula with other symbols |
| `too_many_features_for_render` | error | `cluster` on a layer above the feature limit (8.2) |
| `not_supported_yet` | error | a construct this deployment cannot render yet (section 19) |
| `classify_target_conflict` | warning | a later classification covers every feature and sets the same keys (5.7) |
| `classify_partial_overlap` | info | a later classification sets the same keys for some features |
| `classes_merged` | info | a classification has fewer classes than its count, with why: geometric intervals over values at or below 0 (`case` `not_above_zero`), every value the same (`one_value`), a quantile over repeated values (`repeated_values`), or a class that would be empty or hold one value joined to the next (`joined`); `params` `asked` and `made` |
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
| `base_above_height` | error | a fixed `extrude.base` above a fixed `extrude.height` |
| `extrude_drops_pattern` | warning | a fill pattern on a layer with `extrude` on: extruded polygons draw no pattern |
| `fog_without_terrain`, `buildings_with_extruded_layer`, `scene_source_missing` | warning | map document `scene`: fog while terrain is off or has no source, basemap buildings while a layer draws its own heights, terrain or buildings the installation has no source for |

Examples that fail:

<!-- check: districts -->
<!-- expect: unknown_field, part_not_for_geometry, zoom_stops -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "line": { "color": "#2166ac" } },
  "classify": [{ "field": "status", "method": "quantile", "count": 5, "palette": "d3:viridis" }],
  "rules": [{ "when": { "op": ">", "args": [{ "property": "name" }, "M"] }, "visible": false }]
}
```

<!-- check: satellite -->
<!-- expect: unknown_band -->
```json
{ "version": "1.0.0", "kind": "raster", "render": { "type": "hillshade", "band": 7 } }
```

<!-- check: schools -->
<!-- expect: dash_on_point_outline -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 }, "outline": { "color": "#ffffff", "width": 1, "dash": "dashed" } }
}
```

<!-- check: schools -->
<!-- expect: position_on_point_outline -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "marker": { "shape": "circle", "color": "#1a6b4d", "size": 8 }, "outline": { "color": "#ffffff", "width": 2, "position": "outside" } }
}
```

<!-- check: routes -->
<!-- expect: placement_not_for_geometry -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "line": { "color": "#2166ac" }, "label": { "text": "{name}", "placement": "inside" } }
}
```

<!-- check: districts -->
<!-- expect: template_syntax -->
```json
{
  "version": "1.0.0",
  "kind": "vector",
  "symbol": { "fill": { "color": "#deebf7" }, "label": { "text": "{{ name }}" } }
}
```

## 12. Computed values

Some values depend on the data. The author writes the intent; the server writes what it computed into `computed`, next
to the intent, with the data it came from.

| Intent | Computed | Stored in |
|---|---|---|
| numeric classification with a method (`quantile`, `equal_interval`, `natural_breaks`, `std_dev`, `heads_and_tails`, `geometric_interval`) and `count` | class `from` and `to`, colors from the palette, sizes from the range | the classification's `classes` + `computed` |
| categories with `count` (top N) | the N most frequent values as classes, the rest in `other` | `classes` + `computed` |
| value form without `domain` | the field's minimum and maximum (over the values a `sqrt` scale can map, from 0, or a `log` scale, above 0) | `computed.domain` on the value form |
| H3 `classify` or continuous H3 colors | breaks or domain per resolution | `render.computed`, keyed by resolution |
| raster `continuous` or `hillshade` palette without `domain`; raster classes with a method | the minimum and maximum, and class breaks, of the band or band formula, from a sample of its values (the file's overviews) | `render.computed`; `render.classify.classes` + `computed` |

- **`computed`** holds `at`, `data` (the data fingerprint) and `scope`, on every classification of a field `no_data` and `other` (whether the data has features without a value in the field and, for categories, values no class lists: the legend lists "No data" and "Other" when it has, 7.2; a classification whose classes are the author's is held against the data for these alone; a style that lacks them, one computed before they were recorded or converted from the old format, is not stale for that and gets them with its next computation or when its panel opens, its classes untouched; `no_data: null` says the server looked and could not tell), and on a classification `generated`: the
  target and the value the server wrote per class id.
- **Fingerprint:** an opaque string the server writes, telling which data the values were computed from:
  - a DuckLake layer: the snapshot of the layer's last data change (`ducklake:455812`). core tracks it per layer from
    DuckLake's change log (inserts and deletes, also inlined ones, and schema changes; not compaction), so every
    import, edit, workflow run or column change that writes the layer moves it, whoever writes;
  - a promoted catalog layer: its catalog version (one immutable file per version, so it never goes stale);
    `catalog:unversioned` for an item published without a version, whose promoted copy never changes either;
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
| Compute (section 12) | goatlib functions over the layer's data in DuckLake, and over a sample of a raster's band values (processes, when the style is checked) |
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
- A save is a whole document (a few KB, at most 1 MB: section 10), so sending it again is harmless: a document equal
  to the stored one is not written again, and the reply carries the current revision. No request ids are needed.

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

**The AI** applies edit operations (section 20) with goatlib to the stored document and saves the whole result,
which goes through steps 1 to 4 like any save. A check without storing is the check route (`POST .../style/{id}/check`),
which returns the issues of the document it is given, so the AI can correct its edits before saving them.

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

- `version` is three numbers, `"1.0.0"`, one version for layer styles and the map document (the integer `1` of earlier
  documents is 1.0.0). A major breaks documents and comes with an upgrade step, a minor adds optional keys or values,
  a patch corrects how something is drawn without new keys.
- **On write:** goatlib writes the lowest version the document needs, the highest version that added a key it uses
  (section 21), so a document that uses nothing newer stays readable by older servers. Unknown keys are an error
  (`unknown_key`). A newer major or minor is refused on write and on project import (`newer_version`: it names the
  version needed and the newest this server reads, so GOAT needs an update); a newer patch only warns (`newer_patch`).
- **On read:** older majors are upgraded by goatlib (one function per step, `1 -> 2`, `2 -> 3`). A client that meets
  unknown keys draws what it knows and does not write the document back without the server.
- **Values outside the bounds:** a stored document may hold a value outside the bounds goatlib takes from MapLibre
  (written before goatlib took them). The upgrade brings it inside and notes it: a `direction` goes round the circle
  (360 is 0), any other value takes the nearest bound (arrows `spacing` 0 is 1, `exaggeration` 1.5 is 1).
- **Version 0** is today's GOAT style (the documents without `version`). The converter of section 17 is the upgrade
  step `0 -> 1`, so anything that still arrives in the old shape is read like any older version: catalog style assets
  until the harvester writes GOAT Style, and project exports made before the release.
- **`ext`:** a reserved object for namespaced keys (`"ext": { "goat:experiment": { ... } }`). It passes through
  unchanged and is never interpreted by the compiler unless a later version adopts the key.
- **Renames:** a minor adds the new key and still reads the old one, which is deprecated from then on; the next major
  removes the old key with an upgrade step, and the GOAT release that brings a major migrates stored documents at once.
- **What needs a minor:** a new key, choice value, catalogue palette or library icon (each counts as a key), or a
  wider value form or bound of an existing key; each gets its version in goatlib's `SINCE` (section 21). goatlib's
  `used_keys` reports keys and values but not value forms or bounds yet: it learns them with the first widened one.

## 15. What the style needs from the servers

| Feature | Service | Used for |
|---|---|---|
| vector tiles with feature ids | geoapi (exists) | every vector part; `feature-state` highlight |
| decoration points: start, end, both ends, center of each line, with bearing | geoapi (exists) | arrows `center`, `start`, `end`, `both_ends`; line labels at the center; markers on lines |
| label anchors: one point per polygon (`ST_PointOnSurface`) | geoapi (exists) | polygon labels (`inside`); markers on polygons |
| H3 hexagon tiles with count, sum, mean per cell | geoapi (new) | `render: h3` |
| the layer's points (id, coordinates, the fields the style uses) | features API (exists as GeoJSON) | `render: cluster` in the browser |
| classification and domain computation | goatlib (natural breaks and head/tail breaks are new) | section 12 |
| counts of a classification's values under a filter: unique values, a histogram over the class bounds, features without a value | processes (exist) | `legend.classes: filter` (7.2) |
| raster value tiles and their description, colored tiles for images, band formulas, band statistics, point values | geoapi's raster service | section 9 |
| map service pictures, service styles, legend images | the service itself; the web reads its capabilities when the layer is added (exists) | 9.8 |
| sprites: library icons as SDF, uploads as bitmaps | web, from GOAT's icon library | markers, arrows |
| pattern tiles, drawn on demand from the image's name | web, `lib/style/render/patternImages.ts` | fill patterns |
| fonts: Noto Sans Regular, Bold and Italic from the basemap's glyph server; Light, Light Italic, Medium, Medium Italic and Bold Italic as glyph ranges from the web app (`/glyphs`), to which every map routes requests for these five stacks whatever its style's glyph URL (`apps/web/lib/utils/map/glyphs.ts`, built by `apps/web/scripts/build-glyphs.mjs`) | web (exists) | labels (`font.weight`, `font.style`) |

The decoration points and label anchors carry the fields the style needs on them (label text, the fields of classes
and rules that filter or change arrows, markers and labels): a label anchor carries its polygon's attributes, a
decoration point those of its line's tile, with `bearing` and `_decoration`, the kind of point (`start`, `end` or
`center`). One request asks for several kinds (`decoration=end,center`: arrows at the end and a marker in the
middle), and each layer drawn on them keeps its own kind. Tiles with decoration points are made from the table, not
from stored tiles, so a line layer with a marker, arrows at points or labels at the center draws from the database.

## 16. Compiling to MapLibre

One TypeScript compiler turns a layer style plus its map document entry into MapLibre sources and layers. These rules
are part of the format: an output that breaks one of them draws something else than the document says.

| Construct | MapLibre output |
|---|---|
| polygon `fill` | `fill` layer; with `pattern`, a second `fill` layer with `fill-pattern` above the color fill: one image per look, named `goat-pattern:<kind>|<spacing>|<width>|<color>` per feature, at each zoom stop and at each whole zoom between two stops of its color (4.2), and drawn when the map first needs it. A part whose color is one fixed color at alpha 0 (4.6) gets no layer, here and for every part below: without a fill layer the active feature shows on the outline, or on GOAT's highlight edge, as with the fill off, and the pattern still draws (a pattern color that is not set is the fill's hue, opaque; only a pattern color of its own at alpha 0 drops it); a marker whose color is None loses its layer, and its highlight ring, only where nothing else of it shows: no outline, and no icon or a library icon whose color is None (a marker hollow by `fill: false` keeps its layer). A class, rule or zoom stop at alpha 0 draws nothing through the alpha and keeps its features on the layer, so they still take clicks and the highlight |
| polygon `outline` | `line` layer (`fill-outline-color` is always 1 px); `color` `"fill"` is the fill's `fill-color` expression, `"auto"` the same expression with each color in it darkened (3.1), so no color arithmetic runs in MapLibre (a color read from a field stays as it is, its fallback darkened, 18.10); `position` `inside` is `line-offset` of half the width, `outside` of minus half the width, at every zoom stop and per class: MapLibre insets a polygon's rings by a positive offset, as vector tiles wind outer rings clockwise and holes counterclockwise in tile coordinates and MapLibre's GeoJSON tiler rewinds rings that way |
| `line` | `line` layer; dashes as `line-dasharray` in line widths: `solid` [1, 0], `dashed` [2, 2], `dotted` [0.5, 2], `dash_dot` [3, 2, 0.5, 2] |
| `casing` | `line` layer below the line, with the **same filter, zoom range and layout**, so MapLibre tessellates the geometry once. Width = line width + 2 x casing width at every zoom stop. `color` `"auto"` is the line's `line-color` expression with each color in it darkened (a color read from a field stays as it is, its fallback darkened, 18.10). A class with `casing: false` gets casing opacity 0 instead of a different filter |
| `arrows: repeat` | `symbol` layer on the line source, `symbol-placement: line`, `symbol-spacing`; the `icon` (GOAT's arrow `goat:arrow` by default, pointing north), `icon-rotate: 90` to follow the line; `icon-rotation-alignment: map`; `backward` adds 180; `both` adds a second layer; no `icon-keep-upright`, which would turn arrows on lines drawn westward round |
| `arrows`: `center`, `start`, `end`, `both_ends` | `symbol` layer on geoapi's decoration points (`default_decoration`), `icon-rotate` from `bearing` (+180 for `backward`), `icon-rotation-alignment: map` |
| `arrows.turn_with_line: false` | `icon-rotation-alignment: viewport`, `icon-rotate: 0`, one layer whatever the `direction` |
| `arrows.icon` | `icon-image`, `icon-size` = size / (image height / pixelRatio); GOAT's arrow and library icons are SDF and take `icon-color` (the arrows' color, else the line's); uploads and emoji are drawn as they are, without `icon-color` |
| `marker` circle | `circle` layer, `circle-radius` = size / 2; `outline` = `circle-stroke-*`; `fill: false` = `circle-opacity` 0, the stroke stays. Circles never collide |
| `marker` with a shape | one image per look (shape, fill, stroke, icon) in a `symbol` layer, its name a `step` on `["zoom"]` with a stop at each whole zoom between two stops of a color or the stroke width by zoom (4.2); `fill: false` leaves the shape's inside clear (the image name's fill part is empty) |
| `marker` icon | `symbol` layer, `icon-size` = size / (image height / pixelRatio); library icons are SDF and take `icon-color`; uploaded icons go into a second layer (`mixed_icon_kinds`); `rotation` = `icon-rotate` with `icon-rotation-alignment: map`; `outline` = `icon-halo-*` (library icons only) |
| icon on a circle | `circle` layer + `symbol` layer above; the icon size follows the circle size expression |
| `marker` on polygons and lines | the marker image `symbol` layer (a plain circle too, or the icon alone) on geoapi's label anchors (`default_anchor`, the tiles asked with `label=true`) or the lines' center decoration points (`default_decoration`); on a GeoJSON source on the polygon itself (MapLibre places one symbol inside it) or on the line with `symbol-placement: line-center`; no stroke and no highlight ring (the polygon or the line highlights); on raised polygons `symbol-height-offset` = the height |
| decoration points of several kinds | the tile URL asks for every kind the layers use (`decoration=start,end,center`); a layer drawn on some of them filters on `_decoration` |
| `label` on points | `symbol` layer; `auto` = `text-variable-anchor-offset` with `text-justify: auto`; a fixed side = `text-anchor` on the opposite side (`above` = `bottom`, `below` = `top`, `left` = `right`, `right` = `left`, `above_left` = `bottom-right`, `above_right` = `bottom-left`, `below_left` = `top-right`, `below_right` = `top-left`) with `text-offset` half the marker size plus 2 px toward that side (on both axes at a corner), and `text-justify: auto` at a side with a left or right; `offset` px / size = `text-offset` in ems, added to the clearance, per zoom stop when the size varies |
| `label` on polygons | `symbol` layer on geoapi's label anchors (`default_anchor`), placed as on points: `auto` with a marker `text-variable-anchor-offset` around it, without one on the anchor; a side `text-anchor` and `text-offset`; `inside` on the anchor |
| `label` on lines | `line`: `symbol-placement: line`, `spacing` = `symbol-spacing`; `auto`, `center` and the sides: the decoration center points, placed as on points (`text-variable-anchor-offset` for `auto` with a marker, `text-anchor` and `text-offset` for a side); on a GeoJSON source `symbol-placement: line-center`, a side with `text-rotation-alignment: viewport` |
| label text | `concat` of literal text and one formatted value per placeholder; `lines` become `format` sections; `max_width` px / size = `text-max-width` in ems; `transform` = `text-transform`, `letter_spacing` = `text-letter-spacing`, `line_height` = `text-line-height` (both in ems already), `padding` = `text-padding` |
| numbers | `number-format` with `locale` from `["global-state", "locale"]`; `decimals: 0` rounds first (MapLibre ignores a 0); `thousands_separator: false` uses `to-string` of the rounded value; `abbreviate` and `always_show_sign` are `case` expressions; `percent` formats the value times 100, with no decimals when `decimals` is `auto`, and adds a plain percent sign (with a number of decimals and `thousands_separator: false`, the whole part is written with `to-string` and the decimals with `number-format`). The map compiles without field types, so there a placeholder is formatted as a number when its value is one (`["typeof", ["get", f]]`) and as text otherwise; with field types (the style panel), by the field's type |
| `font.weight`, `font.style` | `text-font`, one Noto Sans stack per weight and style (fonts: section 15): `Noto Sans Light`, `Regular`, `Medium`, `Bold`, and `Noto Sans Light Italic`, `Italic`, `Medium Italic`, `Bold Italic`; a single font each, as a static glyph host serves no combined stack; both by zoom, per class and per line (a line's `font` as a `format` section's `text-font`) |
| value by zoom | `interpolate` or `step` on `["zoom"]` at the top level; derived values (casing width, opacity products) are computed at every stop of the union of stop zooms |
| value by attribute | `interpolate` over `["to-number", ["get", f]]` inside `case` on `["!=", ["get", f], null]` (a property left out and one holding null are both no value), falling back to `no_data`; `sqrt` and `log` scales transform the input and the domain |
| categories | `match`; labels in the field's type for strings and integers, otherwise on `["to-string", ["get", f]]`, a label that writes a number also in its `to-string` spelling when no class lists it (no label twice); `other` is the fallback, `no_data` a `case` on the same value test |
| numeric classes | `step` over the guarded value; `no_data` a `case` on the same value test |
| rules | `case` branches, later rules first; `visible: false` goes into the filter |
| class and rule zooms | the filter, `["zoom"]` compared with whole numbers |
| layer and part zooms | the layer's `minzoom` and `maxzoom` |
| layer `opacity` | `fill-layer-opacity`, `line-layer-opacity` (MapLibre 6), otherwise multiplied into each part (4.6) |
| `order` | `*-sort-key`: circles draw higher keys on top, so `largest` = value; symbols place lower keys first, so `largest` = negated value |
| `time` | the filter compares the field with `["global-state", "<layer id>:time"]`; a `step` on a date field compares its text cut to the year, month or day, and without field types (the map) a `step` always does |
| highlight | each part's paint reads `["feature-state", "active"]` (and `"hover"`): color, width, halo, opacity; sizes of icons and labels cannot change |
| heatmap | `heatmap` layer; `heatmap-color` over `heatmap-density`, transparent at 0; `points_from_zoom` = the heatmap's `maxzoom` and the point layers' `minzoom` |
| cluster | GeoJSON source with `cluster`, `clusterRadius`, `clusterMinPoints`, `clusterMaxZoom` = `cluster_until_zoom` - 1 (MapLibre's is inclusive); cluster layers filter on `["has", "point_count"]`; `count` = `point_count`; `look: points` compiles the base marker for the clusters, with `clusterProperties` counting the points of each category and a `let`/`max`/`case` choosing the icon and color; `count: badge` is one symbol layer: a circle marker image per number of digits and the count, moved to the marker box's upper right corner by `icon-offset` (px) and `text-offset` (ems of its fixed size), per feature and zoom; a `value` from a field adds `clusterProperties` accumulating the field (`+` for the sum and the mean, a `min` or `max` reduce over `accumulated`) and counting the points with a value, the mean dividing the two |
| H3 | vector source of geoapi's H3 tiles; `fill` + `line` layers over the cell value (an `outline.color` of `"auto"` is the `fill-color` expression with each color in it darkened, 18.10); with `extrude`, one `fill-extrusion` layer instead (no outline), height `base` + scaled value x `tallest`, one expression per computed resolution chosen with `match` on the tile's resolution |
| polygon `extrude` | the fill becomes one `fill-extrusion` layer with the fill layer's id: color from the fill cascade, `fill-extrusion-height` from the `extrude.height` cascade (raw storeys x 3, `false` and missing values 0), `fill-extrusion-base` = `["min", base, height]`, `fill-extrusion-opacity` = fill opacity x layer opacity x the alpha of a fixed fill color (MapLibre ignores `fill-extrusion-color`'s alpha, so a fill color that varies draws its volumes without it, and a class or rule whose fill is a fixed None leaves the layer through its filter, 4.6); no pattern layer, no sort key; point-placed labels get `symbol-height-offset` = the height |
| map document `scene` and `view` | not layers: root `projection` (`globe` as a zoom expression from `vertical-perspective` at 8 to `mercator` at 9), `terrain` (a `raster-dem` source of the deployment's Terrarium tiles), `sky` and `light` (a set light's position from `global-state`; a missing one is a `viewport` light), a terrain hillshade layer and the building layer `goat-buildings` (`buildings.opacity` is its `fill-extrusion-opacity` and that of the basemap's own 3D building layers); every hillshade's illumination reads the light from `global-state`. `maxPitch` 85 in 3D, 0 in 2D |
| raster | `continuous`, `categorical` with classes and `hillshade`: a `raster-dem` source of the raster service's value tiles, `encoding: "custom"` with the factors of their description; the colors a `color-relief` layer (`color-relief-color` is an `interpolate` over `["elevation"]` with the coloring's stops, transparent at no data; `color-relief-opacity`; `resampling`); a hillshade a `hillshade` layer on the same source, above the colors, the layer opacity multiplied into the alpha of its colors. A hillshade's source raises a low relief: its four factors times k, the largest power of two that keeps the band's range (the description's `range`, its minimum to maximum) within 1000, at most 16, and 1 for an unknown range; the colors' stop values on that source times k too. MapLibre keeps the slopes in 8 bits before `hillshade-exaggeration` acts, so without it the slopes of flat terrain are lost; a power of two keeps every decoded value exact, the tile addresses and the values read for popups keep the file's encoding. An image drawn with its file's color table (9.1): the value tiles of the table's band read `nearest` under a `color-relief` layer whose stops are the table's colors with the adjustments applied, `resampling: nearest`, the layer opacity as `color-relief-opacity`; it waits for the colored tiles' description, whose band facts give the table, then for the values'. Other images, colors over float cells of an unknown range (the codes cannot place them), and colors needing more than 4096 stops whose token fits in a URL (longer ones are reported as not supported): a `raster` source of the service's colored tiles with the coloring as a token in the URL, and a `raster` layer (adjustments as in 9.1) |
| map service | `raster` source with the service's tile URL (WMS `GetMap` with `{bbox-epsg-3857}` and `STYLES` = `service_style`; WMTS with `Style`; XYZ as given) and a `raster` layer with `raster-opacity`, the adjustments as in 9.1 and `raster-resampling` |

> "Cycle routes with a white edge, width by zoom, shifted 2 px, an arrow in the middle; planned routes dashed, faded,
> without the edge and only from zoom 13."

<!-- check: routes -->
```json
{
  "version": "1.0.0",
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
  "version": "1.0.0",
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
      "fill-color": ["case", ["!=", ["get", "density"], null], ["step", ["to-number", ["get", "density"], 0], "#fef0d9", 2800, "#fdcc8a", 3600, "#fc8d59", 4300, "#e34a33", 6300, "#b30000"], "#cccccc"],
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
        ["case", ["!=", ["get", "area_km2"], null], ["number-format", ["to-number", ["get", "area_km2"], 0], { "locale": ["global-state", "locale"], "min-fraction-digits": 1, "max-fraction-digits": 1 }], ""],
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
until the harvester writes GOAT Style. The converter runs as a dry
run on a copy of the database first; every style that does not validate is reported, not silently simplified. The old shape is
not kept.

| Today | GOAT Style | Conversion | Lossy |
|---|---|---|---|
| points: `color`, `opacity`, `filled: false` | `marker.color`, `marker.opacity`, `marker.fill: false` (outline kept) | RGB array to hex; an absent `color` is `#aaaaaa`, the grey today's renderer draws (also on a filled custom marker) | no |
| polygons: `color`, `opacity`, `filled`, `stroked` | `fill.color`, `fill.opacity`, `fill: false`, `outline: false` | RGB to hex; an absent `color` is `#aaaaaa` | no |
| lines: `stroke_color`, `opacity` | `line.color`, `line.opacity` | RGB to hex; an absent `stroke_color` is `#aaaaaa` | no |
| `stroke_color`, `stroke_width` on points and polygons | `outline.color`, `outline.width` | RGB to hex; an absent `stroke_color` is `#aaaaaa` | no |
| `X_field` + `X_scale: ordinal` + `X_range.color_map` | `classify` with `method: categories`, one class per entry, `target` = X | values lists kept | no |
| `X_scale`: `quantile`, `equal_interval`, `standard_deviation`, `heads_and_tails` + `X_scale_breaks` | `classify` with the method (`std_dev` for `standard_deviation`), `count`, `palette`, classes from the stored breaks, `computed` with an unknown fingerprint (recomputed on first read) | | no |
| `X_scale: custom_breaks` | `classify` with `method: manual` | | no |
| `X_range` palette: ColorBrewer (both casings), Uber, inline custom | `palette`: `colorbrewer:<name>`, `uber:<name>`, inline list | names normalized | no |
| `X_range.reversed` | `reverse` | | no |
| `X_range.color_legends` | class `name` | | no |
| `X_no_data` | the classification's `no_data` | | no |
| `radius`, `radius_field`, `radius_range`, `radius_scale` | `marker.size` (fixed, or classes over the stored breaks) | **size = 2 x radius** (diameter) | no; a size by field without breaks drew one size and stays one size, reported |
| `marker_size` (custom marker) | `marker.size` | **size = marker_size x 200 / 200 image px**, checked in the dry run | no |
| `X_ordinal_map` (size by category) | classification with `target` = the size key | | no |
| `marker`, `marker_field`, `marker_mapping` | `marker.icon`, classes with `marker.icon` | URLs to `goat:` or `asset:`; a library icon is `goat:<name>` whether or not its stored marker has `source`, and takes the marker color like every library icon | no, with one exception: today's renderer tints only library icons stored with `source: library` and draws one stored without `source` in the icon's own black, so such an icon changes from black to the marker color, not reported per style |
| `marker_anchor` (9 anchors) | `marker.anchor` (the same nine, `top-left` written `top_left`) | | no |
| `marker_offset` | `marker.offset` | **px = offset x marker_size / 200** (MapLibre scales icon offsets by the icon size) | no |
| `marker_allow_overlap` | `marker.allow_overlap` | | no |
| `stroke_pattern`, `stroke_dash_density` | `dash` | density dropped | **yes** |
| `stroke_cap`, `stroke_join`, `stroke_offset` | `line.cap`, `line.join`, `line.offset` | | no |
| `decoration_*` (arrows): placement `start_and_end` | `arrows.placement: both_ends` | | no |
| `decoration_allow_overlap` | dropped: arrows always overlap | | **yes** |
| `text_label`: `field`, `size`, `color`, `outline_color`, `outline_width` | `label.text: "{field}"`, `size`, `color`, `halo`; on points and polygons also `label.max_width` | RGB to hex; **max_width = 10 x size px** (today's renderer sets no wrap width, so MapLibre's 10 em applies; labels along a line never wrap and get none) | no |
| `text_label.offset` (ems) | `label.offset` (px) | **px = ems x size** | no |
| `text_label.anchor` on points (9 anchors) | `label.placement`, by the side the label sits on: `top` to `below`, `bottom` to `above`, `left` to `right`, `right` to `left`, `top-left` to `below_right`, `top-right` to `below_left`, `bottom-left` to `above_right`, `bottom-right` to `above_left`, `center` to `center`; an absent anchor is `top` (`below`) | today's renderer puts the anchor on the point itself; GOAT Style keeps the label clear of the marker, so a converted label sits half the marker size plus 2 px further out, and an offset that cleared the marker by hand adds to that | no |
| `text_label.anchor` on lines | `label.placement: line` with the side kept in `label.offset`: `bottom` (text above the line) moves it up, `top` (below the line, also an absent anchor) moves it down, `center` keeps it on the line | **offset y = 0.6 x size px** (half of MapLibre's default line height, 1.2 em, which today's renderer keeps), added to the converted `text_label.offset` | **yes** only for the left or right part of an anchor (a shift along the line) |
| `text_label.anchor` on polygons | `label.placement: inside`, centered on the tile service's point inside the polygon | the anchor is dropped: a label that sat above or below that point moves by half a line at most | **yes**, not reported per style |
| `text_label.font_family` | `label.font.weight: bold` when the first font is a Bold one (Open Sans Bold), else nothing (regular) | today's renderer never drew the choice, so these labels turn bold for the first time | no |
| `text_label.alignment`, `background`, `background_color` | dropped (alignment and backgrounds later) | | **yes** |
| `min_zoom`, `max_zoom` | top-level `min_zoom`, `max_zoom` | a `max_zoom` of 0 is no upper limit (today's renderer reads it as 24) and is left out | no |
| `visibility` | map document layer entry `visible` | | no |
| `legend.show`, `legend.caption` | `legend.show`, `legend.caption` | | no |
| `legend.collapsed` | map document `legend.expanded` | inverted | no |
| `cluster` (`radius`, `min_points`, `max_zoom`, `color`, `text_color`) | `render: { "type": "cluster" }` with `cluster_until_zoom` = `max_zoom` + 1 (today's value is inclusive), `min_points` (3 when absent, as today), cluster `symbol` colors; on a layer with a custom marker also `look: points` and `count: badge` (the marker with the count on a badge in the cluster colors, as today) | | no |
| `popup` | `popup`: `fieldList` to `field_list`, attribute `name` to `field`, `format_config` to `format`, the legacy `format` preset to the matching `format` (below), `position` and `show_layer_header` to `layout` and `header`, block ids kept | a `format_config` with any key wins over the preset, as today; a stored `position` or `show_layer_header` wins over `layout` or `header` (today's renderer reads the older keys first): `position: fixed` is `pinned`, any other `position` is `popup`, `show_layer_header` true is `standard`, false is `none` | **yes**, reported, for the presets marked below |
| `interaction` (legacy popup) | the popup GOAT seeds from it today: field lists (presets as for `popup`) and images, with a field list of all fields first when the content has none | | **yes**, reported, for the presets marked below |
| raster `opacity`, `style.opacity` | top-level `opacity` (the product) | | no |
| raster `resampling` | `resampling` | | no |
| raster `style_type: image`, `brightness_min`, `brightness_max`, `contrast`, `saturation`, `hue` | `render.type: image` and adjustments | **brightness = brightness_min if > 0, else brightness_max - 1** | **yes** when both are set |
| raster `color_range` (`color_map`, `interpolate`, `min_value`, `max_value`, `no_data_color`, `min_label`, `max_label`) | `render.type: continuous` with `stops`, `interpolate` (`false` to `nearest`), `outside: hide`, `legend.min_label`, `legend.max_label` | today's renderer draws the cells outside the color map (or outside `min_value` and `max_value`) transparent: `outside: hide`. `min_value` and `max_value` are not kept, the stops' ends bound the colors. `no_data_color` dropped: today's renderer draws no-data transparent whatever its color | **yes**, reported, for a `min_value` or `max_value` other than the color map's end value, and for a `no_data_color` (a stored choice only, never drawn) |
| raster `categories` (`categories`, `default_color`) | `render.type: categorical`, `classes`, `other_color` | | no |
| raster `hillshade` (`azimuth`, `altitude`, `z_factor`) | `render.type: hillshade` (`direction`, `altitude`, `exaggeration`) | **exaggeration = min(1, z_factor / 2)**, checked visually in the dry run; azimuth 360 is direction 0. Today's renderer draws a grey ramp of the elevation times `z_factor` and never reads `azimuth` or `altitude`, so a converted hillshade looks different: shaded, lit from `direction` | **yes** above 2 |
| WMS, WMTS, XYZ layers: `opacity`, `min_zoom`, `max_zoom`, `resampling`, `legend` | a map service style (9.8) with the same keys and `render.type: image`; `service_style` left out (the first style, as drawn today); `visibility` to the map document; the service keys (`url`, `layers`, `srs`, `dpi`, `legend_urls`, `tile_size`) stay on the layer | | no |

Where a key is absent, the converter writes what today's renderer draws, not the web form's defaults: the
renderer reads the stored properties as they are. So an absent `filled` or `stroked` is off, an absent `opacity` is 1,
an absent `stroke_width` is 1, an absent `marker_size` is 100, an absent label size is 14, an absent `color` or
`stroke_color` is `#aaaaaa` (also when it is unreadable, reported, and when a classification is left out), a label
wraps at 10 x its size, an absent cluster `min_points` is 3, a `max_zoom` of 0 is no upper limit, and an absent
resampling is `nearest`. An empty zoom range (minimum not below maximum) drew nothing: it becomes `visible: false` in the map
document. A `transparent` no-data color becomes `#00000000` on the classified key only.

The legacy popup `format` presets (today's `Intl.NumberFormat` options, in the reader's language) become these
formats; each writes `thousands_separator`, and `decimals` where the preset fixes them (left out otherwise, so whole
numbers keep none). An unknown preset is left out, reported. The attribute's own `prefix` goes before a currency
sign, as today.

| Preset | `format` | Lossy |
|---|---|---|
| `integer` | `decimals: 0`, `thousands_separator: false` | no |
| `grouping` | `decimals: 0`, `thousands_separator: true` | no |
| `grouping_2d`, `decimal_2` | `decimals: 2`, `thousands_separator: true` | no |
| `decimal_3` | `decimals: 3`, `thousands_separator: true` | no |
| `compact_1d` | `abbreviate: true`, `decimals: 1`, `thousands_separator: true` | no |
| `percent`, `percent_1d`, `percent_2d` | `percent: true`, `decimals` 0, 1 or 2, `thousands_separator: true` | no |
| `none`, `decimal_max` | `thousands_separator: true` | **yes**: today's showed up to three decimals |
| `signed_2d` | `decimals: 2`, `thousands_separator: true`, `always_show_sign: true` | **yes**: today's showed a plus sign on zero |
| `compact` | `abbreviate: true`, `thousands_separator: true` | **yes**: today's rounded short numbers to two digits (12K), `abbreviate` keeps one decimal |
| `currency_usd`, `currency_eur` | `decimals: 2`, `thousands_separator: true`, `prefix: "$"` or `"€"` | **yes**: today's placed the sign by the reader's language (after the number in German) |

## 18. Reference

The tables below are the contract. The goatlib Pydantic models (`style/models/`) are its source of truth: the JSON
Schema and the web's types and defaults are generated from them, and these tables follow them. The defaults are published in the JSON Schema as `x-defaults` (goatlib
`style/defaults.py`), except those that depend on the document: the pattern color is the fill's hue, arrows take the
line's hue (both opaque, 4.6), the marker icon is `goat:marker` when the shape is `icon`, the icon color is the marker's hue on a hollow marker (`fill: false`), the label placement follows the geometry. "Forms" lists the value forms allowed (F fixed,
Z by zoom, A by attribute, C by classes; section 4.5).

These defaults say what an absent key means. A new layer without a style of its own starts from a document instead
(goatlib's `default_style`): one color of the palette `carto:Bold`, picked by the layer id, so the same layer always
gets the same color; a point as a circle marker of size 10, a line 2 px wide, a polygon as a fill at opacity 0.8 with
`"outline": { "color": "auto", "width": 1 }` (3.1); a raster as an image.

### 18.1 Layer style

| Key | Type | Required | Default |
|---|---|---|---|
| `version` | three numbers, `"1.0.0"` | yes | |
| `kind` | `vector`, `raster` | yes | |
| `geometry` | `point`, `line`, `polygon` | no | the dataset's |
| `opacity` | number 0 to 1 (F, Z) | no | 1 |
| `min_zoom`, `max_zoom` | number 0 to 24 | no | 0, 24 |
| `symbol` | object of parts (18.2) | no | the main part with defaults |
| `classify` | list of classifications (18.4) | no | none |
| `rules` | list of rules (18.6) | no | none |
| `order` | `{ field, top }` or `{ by: "classes" }` | no | data order |
| `legend` | object (7.2) or `false` | no | shown, `classes`: `filter` |
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
| `fill.pattern_color` | color | F Z A C | the fill's hue |
| `fill.pattern_spacing` | px | F Z(step) C | 10 |
| `fill.pattern_width` | px | F Z(step) C | 2 |
| `outline.color` | color, `"fill"` or `"auto"` (3.1) | F Z A C | `#ffffff` |
| `outline.width` | px | F Z A C | 1 |
| `outline.opacity` | 0 to 1 | F Z A C | 1 |
| `outline.dash` | `solid`, `dashed`, `dotted`, `dash_dot` (polygons) | F Z(step) C | `solid` |
| `outline.position` | `center`, `inside`, `outside` (polygons) | F Z(step) C | `center` |
| `line.color` | color | F Z A C | `#2166ac` |
| `line.width` | px | F Z A C | 2 |
| `line.opacity` | 0 to 1 | F Z A C | 1 |
| `line.dash` | as outline | F Z(step) C | `solid` |
| `line.cap` | `butt`, `round`, `square` | F Z(step) C (C needs MapLibre 6) | `butt` |
| `line.join` | `miter`, `round`, `bevel` | F Z(step) C | `round` |
| `line.offset` | px | F Z A C | 0 |
| `line.blur` | px | F Z A C | 0 |
| `casing.color` | color or `"auto"` (3.2) | F Z A C | `#ffffff` |
| `casing.width` | px on each side | F Z A C | 1 |
| `casing.opacity` | 0 to 1 | F Z A C | 1 |
| `arrows.placement` | `repeat`, `center`, `start`, `end`, `both_ends` | F (per layer) | `repeat` |
| `arrows.direction` | `forward`, `backward`, `both` | F (per layer) | `forward` |
| `arrows.spacing` | px | F Z (per layer) | 100 |
| `arrows.size` | px | F Z A C | 10 |
| `arrows.color` | color | F Z A C | the line's hue |
| `arrows.icon` | icon reference, or `goat:arrow` | F (per layer) | `goat:arrow` |
| `arrows.turn_with_line` | boolean | F (per layer) | `true` |
| `marker.shape` | `circle`, `square`, `diamond`, `hexagon`, `shield`, `pin`, `round_pin`, `needle`, `square_pin`, `tag_pin`, `flag`, `icon` | F C (`icon` per layer) | `circle` |
| `marker.color` | color | F Z A C | `#2bb381` |
| `marker.fill` | boolean: `false` draws the marker hollow (3.3) | F C | true |
| `marker.size` | px (circle diameter or icon height) | F Z A C | 8 |
| `marker.opacity` | 0 to 1 | F Z A C | 1 |
| `marker.icon` | icon reference | F Z(step) C | none (`goat:marker` with `shape: icon`) |
| `marker.icon_color` | color or `"auto"` (on-color, 18.10) | F Z A C | `#ffffff` (the marker's hue with `fill: false`) |
| `marker.rotation` | degrees clockwise from north | F Z A C | 0 |
| `marker.anchor` | `center`, `top`, `bottom`, `left`, `right`, `top_left`, `top_right`, `bottom_left`, `bottom_right` | F Z(step) C | `center` |
| `marker.offset` | `[x, y]` px | F Z C | `[0, 0]` |
| `marker.allow_overlap` | boolean | F (per layer) | false |
| `label.text` | template | F C (classes and rules may change it) | none |
| `label.format` | format object (18.3) | F (per layer) | the field settings |
| `label.formats` | `{ field: format }` | F (per layer) | none |
| `label.size` | px | F Z A C | 12 |
| `label.color` | color or `"auto"` (label text, 18.10) | F Z A C | `#3a3541` |
| `label.halo.color`, `label.halo.width` | color or `"auto"` (label halo, 18.10), px | F Z A C | `#ffffff`, 1.5 |
| `label.font.weight` | `light`, `regular`, `medium`, `bold` | F Z(step) C | `regular` |
| `label.font.style` | `normal`, `italic` | F Z(step) C | `normal` |
| `label.placement` | points `auto`, `center`, `above`, `below`, `left`, `right`, `above_left`, `above_right`, `below_left`, `below_right`; lines `line`, `auto`, `center` and the eight sides; polygons `auto`, `inside` and the eight sides | F (per layer) | points `auto`, lines `line`, polygons `auto` |
| `label.offset` | `[x, y]` px | F Z C | `[0, 0]` |
| `label.max_width` | px | F Z A C | 120 |
| `label.transform` | `none`, `uppercase`, `lowercase` | F Z(step) C | `none` |
| `label.letter_spacing` | ems of the label size | F Z C | 0 |
| `label.line_height` | ems of the label size, 0 or more | F Z (per layer) | 1.2 |
| `label.spacing` | px between repeats along a line, 1 or more (`placement: line`) | F Z (per layer) | 250 |
| `label.padding` | px kept free around each label, 0 or more | F Z (per layer) | 2 |
| `label.lines` | list of `{ size, color, font }` per line | F (per layer) | none |
| `label.priority` | `{ field, top }` | F (per layer) | none |
| `label.allow_overlap` | boolean | F (per layer) | false |
| `extrude.height` | metres 0 to 5000 | F Z A C | 10 |
| `extrude.base` | metres 0 to 5000 | F Z A C | 0 |
| `extrude.unit` | `m`, `storeys` | F (per layer) | `m` |
| every part `.min_zoom`, `.max_zoom` | number 0 to 24 | F | the layer's |

### 18.3 Value forms and format

| Form | Keys |
|---|---|
| by zoom | `zoom: [[z, value], ...]` (at least 2, ascending), `interpolate` (`linear` default, `exponential`, `step`), `base` (exponential only, default 1.6) |
| by attribute, colors | `field`, `palette` (catalogue id or inline list), `reverse`, `domain`, `no_data`, `title` |
| by attribute, numbers | `field`, `range: [min, max]`, `scale` (`linear` default, `sqrt`, `log`), `domain`, `no_data`, `title` |
| raw field value | `{ "field" }` alone: the value as it is (degrees, hex colors) |
| format | `decimals` (`auto` default, or 0 to 10), `thousands_separator` (default true), `abbreviate` (default false), `always_show_sign` (default false), `percent` (default false: the value as a percent of 1, 0.73 reads 73 % with the reader's language's percent sign in the popup, the legend and the panel, while a map label appends a plain "%" (section 16); `decimals` count after the percent, `auto` meaning none, `abbreviate` does not apply), `prefix`, `suffix` |

### 18.4 Classification

| Key | Type | Required | Default |
|---|---|---|---|
| `id` | string | no | assigned |
| `title` | string | no | the field's display name |
| `field` | field name | yes (vectors) | |
| `method` | `categories`, `quantile`, `equal_interval`, `natural_breaks`, `std_dev`, `heads_and_tails`, `geometric_interval`, `manual` | yes | |
| `count` | integer 1 to 256 (top N for categories, classes otherwise) | no | categories: the classes as written; 5 |
| `target` | property path, for example `outline.width` | no | the main color |
| `palette`, `reverse` | palette, boolean | no | `goat:green` for numeric, `colorbrewer:Set2` for categories |
| `range` | `[min, max]` for number targets | no | the target's default range |
| `unit`, `format` | string, format object | no | the field settings |
| `legend` | `false` | no | shown |
| `classes` | list of class records (18.5) | no | computed |
| `other`, `no_data` | class record | no | none |
| `computed` | `{ at, data, scope, no_data, other, generated }` | server | |

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
| `cluster` | `look` (`circle`, `points`; `circle`), `count` (`center`, `badge`; `center`), `value` (`{ "op": "count" }`; `sum`, `mean`, `min`, `max` with `field`), `radius` (50), `cluster_until_zoom` (14), `min_points` (2), `symbol` (parts over `count`) |
| `h3` | `resolution` (`auto`), `value` (`{ "op": "count" }`), `palette` (`colorbrewer:OrRd`), `reverse`, `classify` (shape of 18.4 without `field`), `opacity` (0.85), `outline` (`color` `#ffffff` or `"auto"`, `width` 1), `points_from_zoom` (none), `extrude` (`tallest` F Z 1000, `base` F Z 0, `scale` `sqrt`; absent: flat), `computed` (server, per resolution) |

### 18.8 Raster

| Key | Values and defaults |
|---|---|
| top level | `opacity` (1), `min_zoom`, `max_zoom`, `resampling` (`nearest` for continuous, categorical and hillshade colors, `linear` for images and hillshade alone; categorical and an image drawn with its file's color table always `nearest`), `brightness`, `contrast`, `saturation` (0), `hue` (0), `legend`, `popup` (on click for `continuous`, `categorical` and `hillshade`, none for `image`) |
| `image` | `bands` (`[1, 2, 3]` for 3+ bands), `no_data`; on a map service only `service_style` (the service's first style) |
| `continuous` | `band` (1), `palette` (`goat:elevation`) + `reverse` + `domain` (band min and max), or `stops`; `interpolate` (`linear`, `nearest`); `outside` (`clamp`); `classify`; `no_data` |
| `categorical` | `band` (1), `classes` (`value`, `name`, `color`, `visible`), `other_color` (transparent), `no_data` |
| `hillshade` | `band` (1), `method` (`standard`), `direction` (315), `altitude` (45), `exaggeration` (0.5), `shadow_color` (`#000000`), `highlight_color` (`#ffffff`), `accent_color` (`#000000`), optional `palette`, `domain`, `classify`, `outside`; `no_data` |

### 18.9 Map document `view` and `scene`

| Key | Type | Forms | Default |
|---|---|---|---|
| `view.pitch` | degrees 0 to 85 | F | 0 |
| `view.bearing` | degrees | F | 0 |
| `view.mode` | `2d`, `3d` | F | `3d` when `pitch` > 0, else `2d` |
| `view.projection` | `mercator`, `globe` | F | `mercator` |
| `scene.terrain` | `false` or object | F | on with a terrain source |
| `scene.terrain.exaggeration` | 1 to 3 | F | 1 |
| `scene.buildings` | boolean or object | F | on, unless a drawn layer extrudes |
| `scene.buildings.on` | boolean | F | on, unless a drawn layer extrudes |
| `scene.buildings.opacity` | 0 to 1 | F | 0.6 |
| `scene.sky.*`, `scene.fog.*`, `scene.glow.*`, `scene.light.intensity`, `scene.light.color` | color or 0 to 1 | F Z | auto table |
| `scene.fog` | object | F | no fog |
| `scene.light.direction`, `scene.light.altitude` | degrees: 0 up to 360, 0 to 90 | F | with the camera (10.2) |

The auto table, by the basemap's tone (published in the JSON Schema as `x-scene-auto`, with `x-scene-defaults`;
goatlib `style/scene.py`):

| Key | light | dark |
|---|---|---|
| `sky.color` | `#79B8EC` | `#1D4877` |
| `sky.horizon_color` | `#DFEEFA` | `#3B6A99` |
| `sky.horizon_blend` | 0.6 | 0.7 |
| `fog.color` | `#E9F1F7` | `#1B2633` |
| `fog.horizon_blend` | 0.5 | 0.5 |
| `fog.ground_blend` | 0.6 | 0.6 |
| `glow.strength` | 1 | 1 |
| `glow.color` | `#6EA5F5` | `#6EA5F5` |
| `light.intensity` | 0.45 | 0.35 |
| `light.color` | `#FFFFFF` | `#FFFFFF` |

The table's fog values are where a set fog starts: a missing `fog` draws none. `sky.horizon_color` and `fog.color`
give way to the basemap's ground colour where the map knows it (10.2), and a missing light's direction and height
stand with the camera.

### 18.10 Color keys

Every key that holds a color, a list of colors or a palette, and what the value `"auto"` means on it. The table is
goatlib's `style/data/color_keys.json`: a test walks the JSON Schema and fails for a color key it does not name, and
the web compiler's derived colors are tested against it. Names:

- part keys (`fill.color`) hold in the symbol, class records, `other`, `no_data` and rules alike;
- `cluster.symbol.*` are the cluster symbol's (8.2); `heatmap.*` and `h3.*` the render's (8.1, 8.3);
- `continuous.*`, `categorical.*` and `hillshade.*` are the raster render's (9); `popup.*` the popup blocks' (7.4);
- `by_attribute.palette` and `by_attribute.no_data` belong to any color by attribute (4.3); `scene.*` to the map
  document (10.2); lists drop their brackets (`label.lines.color` is the color of each of `label.lines`).

The rules:

- **shade**: a darker shade of the color it follows, feature by feature (3.1). Where that color is read from a field
  as it is (`{ "field": ... }` without a palette), the compiler cannot darken the data's color, so it draws that color
  itself; where the data holds no valid color, it draws the shade of the read's fallback, as for any fixed color.
- **label text** and **label halo**: the label's two colors chosen together for the basemap's tone, from the color of
  the feature the label belongs to (the polygon's fill, the line's color, the marker's color, without its alpha, class
  by class, rule by rule, zoom stop by zoom stop and palette stop by palette stop). On a light basemap the text is the
  feature's color darkened as the shade darkens it until it contrasts with white by at least 4.5 to 1 (WCAG), in a
  `#ffffff` halo; on a dark basemap the text is `#ffffff` in a halo of that darkened color. A text Auto beside a halo
  the map draws (a color the style sets, or the default `#ffffff` where the key is absent), read without the halo's
  alpha, is the table's text where it contrasts with that halo by at least 4.5 to 1; else the feature's color darkened
  as the shade darkens it until it contrasts with the halo by at least 4.5 to 1, where that is reached; else the one
  of `#ffffff` and `#3a3541` with the higher contrast against the halo, `#000000` where neither reaches 4.5 to 1.
  Where a record's halo has width 0 (by zoom: where its width stays 0 up to the next stop), or its color is at alpha 0
  (None) or read from a field as it is, the text there follows the table. A halo Auto beside a set or absent text is
  the one of `#ffffff` and `#3a3541` with the higher contrast against it, `#000000` where neither reaches 4.5 to 1, so
  the floor holds for every text. A set color is never changed. The built-in dark and satellite basemaps are dark, a
  solid or custom vector basemap by its background color (dark below a relative luminance of 0.35), every other
  basemap is light (a custom image too). Where the feature's color is read from a field as it is, every feature of
  that read gets `#3a3541` text in a `#ffffff` halo on a light basemap and `#ffffff` text in a `#3a3541` halo on a
  dark one; beside a halo the map draws, that text stands where it reaches 4.5 to 1 against the halo, else the last
  step above applies. Lines of a label (`label.lines`) without their own color take the text's.
- **on-color**: `#ffffff` where the relative luminance of the color underneath is below 0.5, else GOAT's dark text
  color `#3a3541`: an icon on its marker (on a hollow marker the icon takes the marker's hue, as when `icon_color` is
  absent) and a cluster's number on the cluster's marker; `#ffffff` for every feature where that color is read from a
  field as it is. On a cluster, the halo contrasts with the number as it is drawn, and a number Auto beside a halo the
  cluster draws is read on it as a label's text is, with the on-color in place of the table's text (a cluster label
  without a halo of its own and a badge draw none).
- A color chosen among a few (on-color, a halo against its text) switches where its answer flips as the color it looks
  at blends over a palette or over the zoom, never blending through grey; a marker image looks at the marker's color
  of its whole zoom, a badge at the color of its zoom stop.
- A text read on a halo follows the colors it is chosen from as they blend, within these limits:
  - Where the feature's color blends over a palette or over the zoom beside one halo color, the text blends from one
    stop's text to the next where both are lighter than the halo or both darker, and steps where they lie on either
    side of it, so it never blends through the halo's own color. Between stops the blend is not checked: its contrast
    with the halo can come out slightly below 4.5 to 1. Feature colors that change by zoom per class, rule or palette
    step at five points of each stretch instead (as below), so beside one halo color the floor holds there and only
    the tint lags.
  - Where the feature's color is one color and the halo changes by zoom or over a field, or both change by zoom alone,
    the text is worked out for every zoom or value and switches exactly where it changes.
  - Where the halo changes by zoom or over a field and the feature's colors vary by class, rule or palette, the text
    is worked out at five points of each stretch between two of the halo's stops (its two ends and three between) and
    each answer is held from halfway to the point before until halfway to the next. It steps there and never blends to
    the halo's own color, but between those points the halo moves on while the text stays: its contrast with the halo
    can dip below 4.5 to 1, and below 3 to 1 where the halo turns from light to dark (or back) within the stretch,
    down to about 2.8 to 1 in the cases tested.

"Not yet" marks a rule this version refuses: `"auto"` there, like on a key without a rule, is `invalid_value` (a
palette named `"auto"` is `unknown_palette`). `"fill"` stays a word of `outline.color` alone (3.1).

| Key | `"auto"` | Accepted | Follows |
|---|---|---|---|
| `fill.color` | not offered | | |
| `fill.pattern_color` | not offered | | |
| `outline.color` | shade | yes | the fill on polygons, the marker on points |
| `line.color` | not offered | | |
| `casing.color` | shade | yes | the line |
| `arrows.color` | not offered | | |
| `marker.color` | not offered | | |
| `marker.icon_color` | on-color | yes | the marker |
| `label.color` | label text | yes | the main part and the basemap |
| `label.halo.color` | label halo | yes | the main part and the basemap |
| `label.lines.color` | not offered | | |
| `cluster.symbol.marker.color` | not offered | | |
| `cluster.symbol.marker.icon_color` | on-color | yes | the cluster marker |
| `cluster.symbol.outline.color` | shade | yes | the cluster marker |
| `cluster.symbol.label.color` | on-color | yes | the cluster marker |
| `cluster.symbol.label.halo.color` | label halo | yes | the cluster's number |
| `cluster.symbol.label.lines.color` | not offered | | |
| `by_attribute.palette` | not offered | | |
| `by_attribute.no_data` | not offered | | |
| `classify.palette` | not offered | | |
| `heatmap.palette` | not offered | | |
| `h3.palette` | not offered | | |
| `h3.classify.palette` | not offered | | |
| `h3.classify.classes.color` | not offered | | |
| `h3.outline.color` | shade | yes | each hexagon |
| `continuous.palette` | not offered | | |
| `continuous.stops.color` | not offered | | |
| `continuous.classify.palette` | not offered | | |
| `continuous.classify.classes.color` | not offered | | |
| `categorical.classes.color` | not offered | | |
| `categorical.other_color` | not offered | | |
| `hillshade.palette` | not offered | | |
| `hillshade.classify.palette` | not offered | | |
| `hillshade.classify.classes.color` | not offered | | |
| `hillshade.shadow_color` | not offered | | |
| `hillshade.highlight_color` | not offered | | |
| `hillshade.accent_color` | not offered | | |
| `popup.button.color` | not offered | | |
| `popup.badge.color` | not offered | | |
| `popup.badge.palette` | not offered | | |
| `popup.divider.color` | not offered | | |
| `scene.sky.color` | not offered | | |
| `scene.sky.horizon_color` | not offered | | |
| `scene.fog.color` | not offered | | |
| `scene.glow.color` | not offered | | |
| `scene.light.color` | not offered | | |

A layer's own colors (fill, line, marker) have no Auto; the scene's colors are automatic when absent (18.9). One
place of the schema holds colors without being a color key: `computed.generated.values`, the values the server wrote
into a classification's classes (12). The `no_data` of a color read from a field (`{ "field": ... }`) is not drawn
and takes any value except the words `"auto"` and `"fill"`.

## 19. Scope

The format includes everything in this document. A deployment answers `not_supported_yet` for
what it cannot render yet, so the AI and the panel never offer it:

| First release | Later (in the format, `not_supported_yet` until built) |
|---|---|
| vector parts, value forms, classifications, rules, order, legend, time, popup, named styles, map document | H3 (geoapi H3 tiles) |
| heatmap, clusters, map services (9.8) | raster band formulas, ranges and class breaks computed from a band's values, value tiles, colored tiles for images and point values (raster service) |
| raster `image`, `continuous`, `categorical`, `hillshade` (9) | map service popups (WMS `GetFeatureInfo`, ArcGIS identify, OGC API Features through the connections gateway) |
| 3D: polygon `extrude` (3.6), H3 columns (8.3), `view.mode` and `view.projection` (10.1), `scene` (10.2) | |

GOAT's services draw H3 and the raster service's constructs; map service popups answer `not_supported_yet`.

3D covers what MapLibre draws natively: tilt and rotation, terrain, basemap buildings, volumes from polygons and H3
hexagons, sky, fog, the globe's glow and one light. Not in it: 3D models (glTF, 3D Tiles), extruded points and lines,
a user's elevation layer as the terrain, terrain exaggeration by zoom, and cast shadows (3.6: they follow once MapLibre
ships them).

**Not in 1.0, on purpose:**

- a highlight color and width (the active feature uses GOAT's highlight);
- label backgrounds, text alignment, font families other than Noto Sans, and weights other than Light, Regular, Medium
  and Bold;
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
| buildings or areas as volumes | `symbol.extrude.height` (a number field: `{ "field" }`, with `unit: "storeys"` for levels) |
| a 3D view of the map | the map document's `view.mode: "3d"` and a `pitch`; leave `scene` out unless asked (automatic) |

Common mistakes the validator answers with a fix:

- a value form `{ "field", "palette" }` on a text field (`field_type_mismatch`, fix: a categories classification);
- `{{ field }}` in a label (`template_syntax`);
- a palette id without namespace (`unknown_palette`, `allowed` lists the catalogue);
- writing `classes` with invented breaks for a computed method (the server replaces them; write the method and
  `count` only);
- a fractional class zoom (`zoom_not_whole`, fix `round`).

**Edit operations.** The AI changes a stored style with a list of operations, which goatlib applies in order, all or
none, before the whole result is saved (13.1). A path is a JSON pointer in which a list item with an id is named by
its id (`/classify/density/palette`).

| `op` | Arguments | Does |
|---|---|---|
| `set` | `path`, `value` | sets a value, creating missing objects on the way; a list item must exist (`add` adds one) |
| `remove` | `path` | removes a key or list item |
| `add` | `path`, `item`, `after` | adds an item to an id list (`classify`, a classification's `classes`, `rules`, `popup.blocks`, `render.classify.classes`), after the item `after` names, or last |
| `move` | `path`, `after` | moves an item of an id list after the item `after` names, or first |
| `retarget` | `path`, `target` | points a classification at another property, as the fix does (section 11) |
| `use_field` | `path`, `field` | replaces a field reference, as the fix does |
| `round` | `path` | rounds a class or rule zoom to a whole number, as the fix does |

An added item without an id gets the one the server would give it: a classification its field name when that is free,
otherwise `k1`, `k2`; classes `c1`, rules `r1`, blocks `b1`. An id the item brings is kept when it is free and is a
lowercase letter followed by up to 31 lowercase letters, digits or `_`. A later operation of the same call can name the
new item by its id. `version` and `kind` are not edited. Computed values are never written: an operation on a path under
`computed`, with a value that contains `computed`, or whose path ends on a class bound or value the server computes
(5.2) is refused. Bounds written inside a whole class or class list of such a classification are replaced by the server.
`use_field` replaces a field reference that is there; a key that is not there is refused.

## 21. Changelog

The version of this specification is not tied to GOAT releases. A GOAT release reads every version up to the one it
ships; the table tells people which release first reads each version. A server that refuses a newer document cannot
know that release: its message names the two versions and says that GOAT needs an update (14).

| Spec version | GOAT release | Added |
|---|---|---|
| 1.0.0 | the first release with GOAT Style | everything in this document |

Minor and patch versions start after the first release; until then every key belongs to 1.0.0. goatlib keeps the keys
of 1.0.0, catalogue palettes and library icons included, in `style/data/keys-1.0.0.json` and the version of each later
key in `SINCE` (`style/version.py`), and a test fails for a key of the schema in neither.
