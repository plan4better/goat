---
name: style-a-map
description: Style a layer on a project's Map page from its data, change a style that exists (colors, classes and categories, sizes, icons, labels, popups, legend texts, heatmaps and clusters, heights, zoom ranges, raster colors), or change the map itself (show, hide, rename, order, group and filter layers, the basemap, the view). For example "color the districts by population density", "show the five most common shop types and the rest in grey", "label the stations with their name from zoom 13" or "hide the land use and show only the stations with more than three lines".
---

# Style a map

You work on the Map page of the open project. style_update changes a layer's
style: how its data is drawn, never the data. map_update changes the map
itself: which layers show, their names, order, groups and filters, the
basemap, the 3D scene and the view (Changing the map). On a page without these
tools (Workflows, layouts, dashboards, the catalog, home), tell the user to
open the project's Map page.

Layers 12 (polygons), 13 (points), 14 (lines) and their fields are invented:
use your layer's ids and fields.

## How to work

An open request ("improve this", "make it look better", "can we style this")
names no change: read the style and the data, then make the ONE improvement
that helps this data most (a classification on the field that carries the
layer's meaning, readable sizes and outlines on this basemap, labels from a
sensible zoom), in place and in one call. Say in at most three short sentences
what changed and why (step 8), with at most one further idea. Never offer
options unless the user asks for them.

1. **Find the layer.** project_get_layers lists each layer's
   `layer_project_id`, `type`, `geometry_type` and `style` (its `id`,
   `summary` and `others`), and under `map` the basemap's `tone` and
   `imagery`. A table has no style. For a raster, load rasters.md. A request
   that only changes the map (hide, order, filter, basemap, view) goes on in
   Changing the map.
2. **Read the fields** with project_get_fields. Never guess a field name.
3. **Read every field you consider** with project_field_statistics, once per
   field. A number field answers `min`, `max`, `mean` and the `breaks` of the
   `method` you pass (a style's method name); any other field its
   `distinct_count` and its most frequent `values`. Both answer `count` and
   `empty`, the features with and without a value: no other count is needed.
   To style a layer with a `filter`, pass as_drawn true. Never style by a
   field you have not read.
4. **Read the style** with style_get before you change it: its parts, the ids
   of its classifications and rules, its `issues`.
5. **Decide** the form, the palette and the classes (the sections below).
   What the user left open ("some icon", "nicer colors", "whatever you
   like"): choose one that fits the data and the basemap, and name it in your
   answer. Ask only when the user wants options or the choice changes what the
   map says (which field, which filter).
6. **Write** with style_update: every operation of the request in one call
   (each variant the user asked for in its own).
7. **Read the result**: `issues`, `not_saved`, `incomplete` (Writing the
   change) and `legend` (Reading the legend numbers). Its legend numbers are
   the class counts: never count classes with project_count_features or
   project_group_statistics, and do not read the style back after a call
   that returned without an error. Correct what they show.
8. **Answer** in at most three short sentences, about 50 words, in the user's
   language: what the layer shows now (the field, the form, the colors in
   words) and at most one thing worth knowing. The legend numbers are for you
   to judge the result, not for the answer: no class limits, counts or
   percentages unless the user asks, a number only when it changes what the
   user should do (a class holding almost everything). You read the style, not
   the picture: never say how the map looks. After a change, show no card (but
   the one that offers asked variants): a further idea is one sentence at
   most. An open request, for example: "I colored the stations by access time
   in four classes from light to dark red and made the markers a little
   smaller so the labels stay readable. The layer is hidden right now, so
   switch it on to see it."

## Reference files

Load a file with skills_load (name style-a-map, file its name) only when the
request needs it; a loaded file stays in the conversation.

- `rasters.md`: before you style a raster layer: an image and its bands, a
  color range, classes, categories, hillshade, band formulas such as a
  vegetation index.
- `looks-and-analyses.md`: when points should show as a heatmap, clusters or
  hexagons, when a request could mean a drawing mode or an analysis ("where is
  it dense", catchment areas, access), and before you style the result of a
  workflow.
- `popups.md`: popup blocks, HTML, layouts, hover, switching it off.

## Edit in place

Always change the style the layer draws, in place: `operations` alone,
whatever the size of the change. Another color, coloring by a field, a heatmap
in place of the points, a completely different look: each is an edit of the
active style, and the dock's undo button is the way back. Never create a style
to keep the old look, and never offer variants on your own.

Only the user's words change that (A new style or variants):

- **A new named style** when they ask for one: "as a new style", "keep the
  current one", "save this as ...", "add a second style".
- **Variants** when they ask for options: "give me two options", "show me
  alternatives", "let me choose between two looks".

## Writing the change

- The operations of one call apply in order, all or none. A path is a JSON
  pointer into the style as style_get shows it; a list item with an id is
  named by its id: `/classify/density/count`, `/rules/r1`, `/popup/blocks/b1`.
- `set` creates missing objects on the way: `/symbol/label/text` works on a
  style without a label. Change a part with one set per key by path
  (`/symbol/outline/color`); never reset the part first: `{}` resets its keys
  (an outline turns white). A key set under a part that is `false` turns it
  on.
- A new classification, class, rule or popup block is an `add` to its list
  (`/classify`, `/classify/density/classes`, `/rules`, `/popup/blocks`). The
  result's `added` gives its id by the operation's index, counting from 0. A
  classification gets its field's name as its id when that is free.
- Two classifications must not set the same property. To replace the
  coloring, `set` `/classify` to a list with the one classification you want.
  To change a classification that exists, `set` its `method`, `count` or
  `palette`.
- `remove` takes a key back to its default: without `/render` points are drawn
  as points again.
- Never write `computed`.
- style_get leaves computed values out and cuts a class list to its first 12
  (`cut` names the list). Read a part in full with `part`
  (`/classify/category`) before you change a class beyond the twelfth, and
  every part you keep before you replace a style with a whole `document`.
- In the result, an issue with `existing` true was there before your change.
  `not_saved` lists paths that kept their stored value because your value has
  an error there: correct them in one more call, or say what was not changed.
  `incomplete` says which later step did not happen (the content, the name,
  making it active): do not send the call again; read the style with
  style_get, send only what is missing, and tell the user what stayed open.
- A refused call saved nothing: change exactly what it names and send it once
  more.

<!-- layer: polygon -->
```json
{"layer_project_id": 12, "operations": [{"op": "set", "path": "/symbol/outline/color", "value": "auto"}, {"op": "set", "path": "/symbol/outline/width", "value": 0.5}]}
```

## Which form for which data

| The data or the wish | Write |
|---|---|
| one color for everything | the main part's color: `/symbol/fill/color`, `/symbol/line/color` or `/symbol/marker/color` |
| the layer more transparent | `/opacity` from 0 to 1 for the whole layer, `/symbol/fill/opacity` for the fill alone |
| tint the basemap, its streets and names showing through | `/blend` `multiply`, the layer below the basemap's labels (`set_layer`) |
| a glow on a dark basemap | `/blend` `plus-lighter` |
| one class or palette color see-through | its last two hex digits (`#3182bd80`: 50 %), which multiply with `opacity` (at 0.8: 40 %) |
| outline only, a part's or class's color not drawn | None: the color at 0 %, it keeps its hue (`#3182bd00`); with a None fill an `"auto"` outline keeps the layer's color |
| a text field with up to 12 values | `categories` with `count` = its `distinct_count`, a qualitative palette |
| a text field with many values | `categories` with `count` 5 to 8 (the most frequent) and `other` in grey; say what "Other" holds |
| a number, in ranges | a numeric method with `count` and a sequential palette; the server computes the classes |
| a number, as a smooth ramp | the value form `{"field", "palette"}` as the color |
| a number with a long tail (the last break is further from `max` than from the first break) | `quantile` classes, never `equal_interval`; as a ramp, `"scale": "log"` when every value is above 0 |
| a share or a rate (0 to 1, percent, per 1,000) | sequential classes, `equal_interval` or `manual` with round limits; `"format": {"percent": true}` for values from 0 to 1 |
| a count that grows with the area (residents per district) on polygons | never the fill color: large areas look important. Use a density or share field; without one, a circle per polygon sized by the count (Sizes), and say why |
| values around a midpoint (a change, a difference, a balance) | a diverging palette: a ramp with a `domain`, or `manual` classes, symmetric around the midpoint |
| a year stored as a number | classes like any number, with `"format": {"thousands_separator": false}` |
| a date field | no classes and no ramp (`field_type_mismatch`): offer the time slider (`/time` with `field` and `step` `year`, `month` or `day`), or ask for a number field |
| a yes/no field | `categories` with the values `"true"` and `"false"` as text: one strong color, one grey |
| a field empty for more than half the features | not one to style by: say so, offer another |
| a look for some features only, by several fields or empty values | a rule: an item of `/rules` with `when` and the parts it changes |
| many points as a surface, or counted per cell | `render` (looks-and-analyses.md) |

`blend` mixes polygons, lines, flat hexagons and images; everything else
draws normally (`blend_not_drawn`).

The most frequent categories, the rest in grey; a ramp for a long tail; a
diverging ramp around 0 for values from -12 to 9 (the domain takes the larger
side twice); a yes/no field; a rule for features without a value:

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/classify", "value": [{"field": "category", "method": "categories", "count": 5, "palette": "colorbrewer:Dark2", "other": {"name": "Other", "marker": {"color": "#9aa3ad"}}}]}]}
```

<!-- layer: polygon -->
```json
{"layer_project_id": 12, "operations": [{"op": "set", "path": "/symbol/fill/color", "value": {"field": "density", "palette": "colorbrewer:YlGnBu", "scale": "log"}}]}
```

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/symbol/marker/color", "value": {"field": "change", "palette": "colorbrewer:RdBu", "domain": [-12, 12], "no_data": "#9aa3ad"}}]}
```

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "add", "path": "/classify", "item": {"field": "active", "method": "categories", "classes": [{"values": ["true"], "name": "Active", "marker": {"color": "#1b9e77"}}, {"values": ["false"], "name": "Not active", "marker": {"color": "#9aa3ad"}}]}}]}
```

<!-- layer: polygon -->
```json
{"layer_project_id": 12, "operations": [{"op": "add", "path": "/rules", "item": {"name": "No year", "when": {"op": "isNull", "args": [{"property": "year"}]}, "fill": {"color": "#cfcfcf"}}}]}
```

## Palettes

- **Kind by meaning.** Sequential for low to high, diverging for two
  directions around a midpoint, qualitative for categories without an order.
  Another kind warns (`palette_kind_mismatch`).
- **Sequential:** `colorbrewer:YlOrRd`, `colorbrewer:YlGnBu`,
  `colorbrewer:Blues`, `colorbrewer:Greens`, `colorbrewer:Purples`,
  `d3:viridis`, `d3:cividis`, `d3:plasma`, `d3:magma`, `d3:inferno`.
- **Diverging:** `colorbrewer:RdBu`, `colorbrewer:PuOr`, `colorbrewer:BrBG`,
  `colorbrewer:PiYG`. Not `colorbrewer:RdYlGn` or `colorbrewer:Spectral`
  unless asked for red and green: many readers cannot tell them apart.
- **Qualitative:** `colorbrewer:Set2` (soft, for areas), `colorbrewer:Dark2`
  (strong, for points and lines), `carto:Bold` (saturated, for dark basemaps
  and imagery), `colorbrewer:Paired` (up to 12). Not `colorbrewer:Set1`: it
  holds a pure red and a pure green.
- Only the five `d3:` ramps are rated colorblind safe (`colorblind_safe`).
- **Which end is high.** High values take the end that stands out from the
  basemap: on a light basemap the dark end (ColorBrewer ramps as they are,
  `d3:` ramps with `"reverse": true`), on a dark one or imagery the light end
  (the other way round).
- Write `"auto"` on the symbol where the user names none, on any basemap: an
  `outline` or `casing` (a darker shade of what it follows), a label's
  `color` and `halo` (readable on the basemap), an `icon_color` and a
  cluster's number (on the marker). "A darker shade of its own (or each
  class's) color" is `"auto"`; never darker colors per class by hand.
- **Against the basemap.** Light: no pale fills. Dark: no dark fills; a fixed
  outline light. Imagery (`imagery`): strong, saturated colors, a
  `casing` under lines, an outline around markers. Polygon fills at `opacity`
  0.6 to 0.8 show the basemap. Say when the basemap decided a choice.
- **The user names colors.** One color is a hex value, "a blue ramp"
  `colorbrewer:Blues`, colors of their own an inline palette: 2 to 12 hex
  colors in place of the id, at least one per class (`palette_too_short`).
  Look any other name up with style_catalog (`kind` `palettes`, `query` or
  `palette_kind`); never write a palette id you have not seen here or there.
- Grey (`#9aa3ad`) is for "Other" and features without a value, never for a
  class.

## Classes

- **How many.** 5 by default, 3 or 4 for fewer than 30 features, never more
  than 7 (`too_many_classes`). An odd number for a diverging palette, so the
  middle class holds the midpoint. At most 12 categories
  (`too_many_categories`).
- **Which method.**

| Method | When |
|---|---|
| `quantile` | the default: the same number of features in every class, so it fits skewed data |
| `natural_breaks` | when quantile splits values that belong together, or many features share one value |
| `equal_interval` | only for evenly spread values (no long tail), or a fixed scale such as 0 to 100 percent |
| `std_dev` | distance from the mean, with a diverging palette; the midpoint is the mean, not 0 |
| `heads_and_tails` | a very long tail whose few largest values should stand out; can give fewer classes than `count` |
| `geometric_interval` | values above 0 that span several orders of magnitude |
| `manual` | round limits, limits the user names, or classes symmetric around a midpoint |

- **Write the method and the count, never the classes**, for every method but
  `manual`: the server computes `from` and `to` and takes the colors from
  `palette`. `categories` need `count` (the most frequent values) or `classes`
  with `values`: without both nothing is classified.
- **Round numbers are `manual` classes.** Take the breaks from
  project_field_statistics (its `breaks` are break points: 4 make 5 classes),
  round them (1,957 becomes 2,000) and write the classes: the first without
  `from`, the last without `to`, each `from` equal to the `to` before it. A
  manual class takes no color from `palette`: write a color on every class
  (style_catalog with `classes` 4 answers a palette's colors for 4 classes)
  and keep `palette` to say where they come from.
- A new `count` rebuilds the classes: colors and names set by hand on them are
  lost. A new `method` or `palette` keeps them.
- `fit` on a tool's classes is the tool's: never set it. A new `count`,
  `method` or `field` removes it; a change to one class keeps the classes as
  they are, `manual`.
- **Never color the classes of a computed method one by one**: set `palette`
  (with `reverse`), `count` or `method`. A class's own color only when the
  user names that class.
- **Coloring by a number**: project_field_statistics once with the `method`
  and `breaks` you plan, then one style_update. A computed method classes the
  whole dataset, so a filtered layer's legend comes out lopsided: write the
  breaks read with `as_drawn` true as `manual` classes, and say that the
  classes follow the features the filter keeps.

<!-- layer: polygon -->
```json
{"layer_project_id": 12, "operations": [{"op": "set", "path": "/classify", "value": [{"field": "density", "method": "manual", "palette": "colorbrewer:YlOrRd", "unit": "per km²", "classes": [{"to": 2000, "fill": {"color": "#ffffb2"}}, {"from": 2000, "to": 4000, "fill": {"color": "#fecc5c"}}, {"from": 4000, "to": 6000, "fill": {"color": "#fd8d3c"}}, {"from": 6000, "fill": {"color": "#e31a1c"}}]}]}]}
```

## Sizes

- A size by a number is a value form: `range` is the size at the lowest and at
  the highest value. Markers take `"scale": "sqrt"` and a range such as 4 to
  24; line widths a range such as 1 to 8.
- With sized markers, add `order` so small ones lie on top, and an
  `opacity` of 0.7 to 0.8 where they overlap. A polygon layer takes a `marker`
  too: one per polygon.
- Fixed sizes: points 6 to 10, a marker with an icon 16 to 20, lines 1.5 to 3;
  over imagery lines from 3 with a `casing`.
- Sizes in classes are a classification with `"target": "marker.size"` and
  `range`.

<!-- layer: polygon -->
```json
{"layer_project_id": 12, "operations": [{"op": "set", "path": "/symbol/marker", "value": {"color": "#08519c", "opacity": 0.8, "size": {"field": "population", "range": [4, 32], "scale": "sqrt"}}}, {"op": "set", "path": "/order", "value": {"field": "population", "top": "smallest"}}]}
```

<!-- layer: line -->
```json
{"layer_project_id": 14, "operations": [{"op": "set", "path": "/symbol/line/width", "value": {"field": "population", "range": [1, 8]}}, {"op": "set", "path": "/symbol/casing", "value": {"color": "auto", "width": 1.5}}]}
```

## Icons and emoji

- style_catalog with `kind` `icons` and no query lists every library icon by
  group: one call, then pick. Find emoji by `query`: one or two English words
  ("bus", "shop"), or the emoji itself when the user named one.
- An icon on a circle: `icon` on a marker with `shape` `circle`, drawn in
  `icon_color` on the marker's `color`, readable at 16 px or more. A size by
  zoom gets its icon where it reaches 16 (`icon` by zoom,
  `"interpolate": "step"`), a dot (`goat:circle-solid`) below, in classes
  too. The icon alone: `"shape": "icon"`, tinted with `color`.
- An emoji keeps its own colors: `color` and `icon_color` do not tint it. Use
  it with `"shape": "icon"`, and never to show a color by class.
- An icon per category: each class sets its `marker` `icon` and the base
  marker a neutral one, which "Other" and new values draw. At most 8 icons. Any
  part the classes set (an outline, a label) is set on the base too.

<!-- layer: point, classified -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/symbol/marker/size", "value": 18}, {"op": "set", "path": "/symbol/marker/icon", "value": "goat:marker"}, {"op": "set", "path": "/symbol/marker/icon_color", "value": "auto"}, {"op": "set", "path": "/classify/category/classes/c1/marker/icon", "value": "goat:school"}, {"op": "set", "path": "/classify/category/classes/c2/marker/icon", "value": "goat:shop"}, {"op": "set", "path": "/classify/category/classes/c3/marker/icon", "value": "goat:park"}]}
```

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/symbol/marker", "value": {"shape": "icon", "icon": "emoji:1f6b2", "size": 22}}]}
```

## Labels

- `text` is a template: `{name}`, or `"{name}\n{population}"` for two lines.
  Never `{{ name }}` (`template_syntax`). Numbers take `format`. Label by a
  text field that names the feature.
- `placement`: points `auto` or a side such as `above`; lines `line` (along
  the line); polygons `inside`.
- A layer with many features gets its labels from a zoom on: `min_zoom` 13 for
  dense points, 11 for districts.

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/symbol/label", "value": {"text": "{name}", "color": "auto", "halo": {"color": "auto"}, "placement": "above", "min_zoom": 13}}]}
```

## Popups

- Without `popup` a click shows every field. To choose the fields, set
  `/popup` with one `field_list` block: its `attributes` name each `field`,
  with a `label` in the user's language and a `format` for numbers.
- Load popups.md before you write a popup that is more than a list of fields.

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/popup", "value": {"blocks": [{"type": "field_list", "attributes": [{"field": "name", "label": "Name"}, {"field": "population", "label": "Residents", "format": {"decimals": 0}}]}]}}]}
```

## Legend texts

- The layer's legend heading is `/legend/title`; `"legend": false` hides the
  layer's legend.
- A classification's section has its own `title` (default: the field's name),
  a `unit` and a `format` for the class limits; a class's text is its `name`.
- Write them in the user's language, with the unit, and with a title that says
  what is counted ("Residents per km²", not the field's name).

<!-- layer: polygon, classified -->
```json
{"layer_project_id": 12, "operations": [{"op": "set", "path": "/legend/title", "value": "Districts"}, {"op": "set", "path": "/classify/density/title", "value": "Residents per km²"}, {"op": "set", "path": "/classify/density/classes/c1/name", "value": "Low"}]}
```

## Heights and 3D

- Polygons only: `/symbol/extrude` draws each polygon as a volume. A field of
  heights in metres is `{"height": {"field"}}`; a field of floors takes
  `"unit": "storeys"` (3 m each); any other number is charted with a `range`
  in metres (`{"field", "range": [0, 300]}`).
- The heights show only when the map is tilted: after the style, switch the
  view with map_update, `set_view` with `mode` `3d` and a `pitch`.

<!-- layer: polygon -->
```json
{"layer_project_id": 12, "operations": [{"op": "set", "path": "/symbol/extrude", "value": {"height": {"field": "floors"}, "unit": "storeys"}}]}
```

<!-- call: map_update -->
```json
{"operations": [{"op": "set_view", "mode": "3d", "pitch": 50}]}
```

## Zoom ranges

- `min_zoom` is the first zoom a thing is drawn at, `max_zoom` the first it is
  not. On the style they bound the layer (`/min_zoom`), on a part that part
  (`/symbol/label/min_zoom`), on a class or a rule its features, there in
  whole numbers (`zoom_not_whole`).
- A value that grows with the zoom is the form
  `{"zoom": [[10, 1], [16, 4]]}`: 1 at zoom 10, 4 at zoom 16.

<!-- layer: line, classified -->
```json
{"layer_project_id": 14, "operations": [{"op": "set", "path": "/symbol/line/width", "value": {"zoom": [[10, 1], [16, 4]]}}, {"op": "set", "path": "/classify/category/classes/c3/min_zoom", "value": 13}]}
```

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/symbol/marker/size", "value": {"zoom": [[10, 8], [15, 18]]}}, {"op": "set", "path": "/symbol/marker/icon", "value": {"zoom": [[10, "goat:circle-solid"], [14, "goat:shop"]], "interpolate": "step"}}]}
```

## Reading the legend numbers

style_update and style_get answer `legend`: per classification `features` (the
features the layer's filter keeps), `without_value`, `other` (features with a
value in no class) and per class its `count` and its `share` of `features`,
from 0 to 1. A ramp, a `render` mode and a raster have no legend numbers, and
`legend_note` says when they could not be read: go on without them. Check them
after every change of a classification:

- **A class with a `share` above 0.6** (more than 60 percent of the features),
  **or two or more classes with `count` 0**: the method does not fit the data.
  Change it to `quantile`; from `quantile` (many features share one value) to
  `natural_breaks`, or to fewer classes; a filtered layer: manual classes from
  its numbers as drawn. `equal_interval` with the shares 0.9,
  0.09, 0.01, 0 and 0:

<!-- layer: polygon, classified -->
```json
{"layer_project_id": 12, "operations": [{"op": "set", "path": "/classify/density/method", "value": "quantile"}]}
```

- **`other` above a third of `features`**: too few categories. `features` 900
  and `other` 480: raise `count`, to 12 at most. When it is still above a
  third, the field has too many values to color: use a coarser field, or keep
  the classes and say what share "Other" holds.

- **`without_value` above half of `features`**: the wrong field for this look.
  The same holds for a label: project_field_statistics answers its `empty`;
  520 of 800 names empty means another field, or no labels. Below half, give
  the features without a value a grey `no_data` and say how many they are:

<!-- layer: polygon, classified -->
```json
{"layer_project_id": 12, "operations": [{"op": "set", "path": "/classify/density/no_data", "value": {"name": "No value", "fill": {"color": "#cfcfcf"}}}]}
```

- None of these: the classes are fine. Correct at most twice for one request,
  then answer with what the numbers say.

## A new style or variants

Only when the user asked for one in words (Edit in place).

- **A new named style**: `new_style` with a `name` (what it shows, in the
  user's language), `asked` (the user's words that asked for it, word for
  word) and `start`: `current` copies the style the layer draws, `empty` is a
  plain symbol. Send the operations that change it. The map draws it, and the
  style before stays in the layer's style list.
- **Variants**, as many as asked, three at most, that differ in something the
  user can name (the palette family, classes or a smooth ramp, labels):
  1. Create the first with `new_style`; it becomes active.
  2. Create each other one with `new_style` and `"make_active": false`. Its
     `start` `current` is now the first variant: send only the difference.
  3. Ask with ask_user: at most two short sentences, then one card with the
     question "Which style should the map show?" and one option per style:
     its value `use_style:<style_id>` (the `style_id` its call answered), its
     description what it shows and that the other style stays in the style
     list (you cannot delete a style), the active one recommended. Then end
     your answer.
  4. When the user has picked a style that is not the active one, make it
     active with map_update: one `set_layer` operation with the layer's
     `layer_project_id` and the picked id as `active_style_id`. Then tell them
     which style is active now and that the others are in the layer's style
     list.
- **The tenth style.** A layer takes 10 styles, the active one plus `others`.
  With 10, a new one is refused, and the refusal says how to ask in one card
  which style to replace: follow it.

<!-- layer: polygon -->
```json
{"layer_project_id": 12, "new_style": {"name": "Density in classes", "asked": "as a new style", "start": "current"}, "operations": [{"op": "set", "path": "/classify", "value": [{"field": "density", "method": "quantile", "count": 5, "palette": "colorbrewer:YlOrRd"}]}]}
```

## Changing the map

map_update changes the map. One call takes several operations, applied in
order. Take the ids from project_get_layers: a layer's `layer_project_id`, a
group's `id` (`groups`), a basemap's `id` (`map.basemaps`). The result lists
what was `applied` and, when an operation `failed`, why: send only what is
left in a new call.

| The wish | Operation |
|---|---|
| hide, show or rename a layer, draw another of its styles, put it under the basemap's labels or roads | `set_layer` |
| another order (the first item is drawn on top), into or out of a group | `move` |
| add, rename or hide a group, remove an empty one | `add_group`, `rename_group`, `set_group`, `remove_group` |
| only some features of a layer | `filter` |
| another basemap; terrain, 3D buildings, sky, fog | `set_basemap`; `set_scene` (the scene is `map.scene`) |
| go somewhere, frame a layer, 2D or 3D | `set_view` |
| a layer out of the project | `remove_layer`, after a card |

- **Hide, do not remove.** "I do not want to see the roads", "take it off the
  map": `visible` false. Remove only when the user says remove or delete.
  Then simply call `remove_layer`: without the user's pick the call changes
  nothing and answers `confirm`, per layer the card option's `value`
  (`remove_layer:<layer_project_id>`) and `facts` (what goes with the layer,
  where it is used). Ask with ask_user after at most two
  short sentences that give the facts, one option with that value and one
  that keeps the layer; end your answer, and send the call again after the
  pick. A removed layer does not come back with the dock's undo button.
- **Filters.** project_get_layers shows a layer's `filter` as numbered `rows`
  in words, with `match` (`all` or `any`). Read the field's values first
  (project_field_statistics), then send one `filter` operation per layer with
  row operations: `add` conditions, `replace` or `remove` a row by its
  number, `set_match`, `clear`. "Also leave out the parks" adds a row. A
  change numbers the rows anew: read project_get_layers again before the
  next change. A row that reads "custom" is an expression you cannot read:
  leave it, or remove it when the user asks. A switched-off row (`on` false)
  stays. Say how many features the filter keeps now (`count_before`,
  `count_after`).
- **Areas.** A filter's `area`, beside `rows`, keeps what lies inside a
  place (`outside`: outside it): `regions` (a place name: its id from
  catalog_find_region first), `features_of` (features of another polygon
  layer, picked by a `filter`: "only inside these districts"), `view` ("only
  what I see"). `add` keeps the area there is, switched off if it was;
  without it the new area replaces it, switched on. Never guess coordinates;
  a shape is the user's to draw. `"area": "clear"` removes the area, the row
  `clear` keeps it.
- **Groups.** A group this call adds has no id yet: later operations name it
  `"new:<index>"`, the index of its `add_group` in `operations`, from 0.
- **The view.** `set_view` takes `center` and `zoom`, or
  `fit_layer_project_id` to frame a layer, and `mode` (`2d`, `3d`) with a
  `pitch`. The view is the user's own: nothing is saved, the dock's undo
  button does not take it back, and the page shows a way back. Change it when
  the user asks to go somewhere or to see something, or when your change
  would not show otherwise (heights need 3D). Never move the view in place of
  something you could not do.

<!-- call: map_update -->
```json
{"operations": [{"op": "set_layer", "layer_project_id": 12, "visible": false}, {"op": "set_basemap", "basemap_id": "dark"}, {"op": "set_view", "fit_layer_project_id": 13}]}
```

<!-- call: map_update -->
```json
{"operations": [{"op": "add_group", "name": "Public transport"}, {"op": "move", "item": {"type": "layer", "id": 13}, "group_id": "new:0"}, {"op": "move", "item": {"type": "layer", "id": 14}, "group_id": "new:0", "after": {"type": "layer", "id": 13}}]}
```

<!-- call: map_update -->
```json
{"operations": [{"op": "filter", "layer_project_id": 13, "rows": [{"do": "add", "conditions": [{"field": "category", "op": "!=", "value": "park"}]}], "area": {"regions": ["DE212"]}}]}
```

<!-- call: map_update -->
```json
{"operations": [{"op": "filter", "layer_project_id": 12, "rows": [{"do": "replace", "row": 1, "condition": {"field": "population", "op": ">=", "value": 5000}}, {"do": "remove", "row": 3}]}]}
```

<!-- call: map_update -->
```json
{"operations": [{"op": "filter", "layer_project_id": 14, "area": {"features_of": {"layer_project_id": 12, "filter": {"conditions": [{"field": "name", "op": "in", "value": ["North", "Harbour"]}]}}}}, {"op": "filter", "layer_project_id": 15, "area": {"view": true}}]}
```

<!-- call: map_update -->
```json
{"operations": [{"op": "remove_layer", "layer_project_id": 12}]}
```

<!-- call: ask_user -->
```json
{"questions": [{"question": "Remove the layer Districts from the project?", "header": "Remove", "options": [{"label": "Remove it", "description": "With its 2 styles and its filter.", "value": "remove_layer:12"}, {"label": "Keep it", "description": "It stays; I can hide it.", "value": "keep"}]}]}
```

## What you cannot do

Say so in one sentence, with how the user can do it, and do the rest of the
request. No card for these, and no change in their place.

- Switch a filter row or an area on or off: the layer's Filter tab.
- Draw a shape for a filter's area: the Filter tab, under Area.
- Change the dataset's default style: a style here belongs to the layer in
  this project.
- Upload data, or edit features and their values.

## Mistakes the check answers with a fix

An error your change adds refuses the call; a warning is saved and comes back
in `issues`. Fix both before you answer; an issue of level info may stay.

- `field_type_mismatch`: a ramp or a numeric method on a text or date field.
  Use `categories`.
- `unknown_palette`, `unknown_icon`, `unknown_field`: an id or a name that
  does not exist (a palette without its namespace, such as "Blues"). Look it
  up; never guess a second time.
- "The server computes the classes of this classification": you wrote `from`,
  `to` or `values`. Send `method` and `count`, or make the method `manual`.
- `classify_target_conflict`: two classifications set the same property.
  Remove the earlier one, or point it at another property with the operation
  `retarget` (`target` `outline.color`).
- `zoom_not_whole`: the operation `round` on the zoom's path fixes it.
- `zoom_needs_step`: a choice or an icon by zoom needs `"interpolate": "step"`.
- `override_not_per_feature`: a key that holds one value for the whole layer
  (a label's `placement`, a marker with `shape` `icon`) set in a second place.
  Set it on the base symbol only.
- `unknown_category`: a class for a value no feature has. Take the values from
  project_field_statistics.

## House examples

Styles judged good go here, each with a line on its data and look and its
essential part. None yet: follow the rules above.
