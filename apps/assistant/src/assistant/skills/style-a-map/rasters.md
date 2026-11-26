# Rasters

A raster layer (`type` `raster` in project_get_layers) has a style of `kind`
`raster`. How its cells are colored is `render`, and its `type` is one of
`image`, `continuous`, `categorical` and `hillshade`. Layer 15 is a raster in
the examples.

## What you can read

- style_get shows the style and its `issues`. The project tools that read
  fields and values do not read rasters, and a raster has no legend numbers.
- So you do not know the cell values: leave `domain` out and the server takes
  the band's lowest and highest value. Set it only when the user gives the
  range.
- You do not know what a band holds either. When a request needs bands the
  user did not name (near infrared, red), ask which band is which; never
  guess a band number. A band the raster does not have is `unknown_band`, and
  its message says how many bands there are.
- A map service (WMS, WMTS, XYZ) sends finished pictures: only `image` works
  there, and anything else is `render_not_for_source`.

## Changing the render

- To change the `type`, set `/render` whole: the keys of one type are unknown
  to another.
- To adjust what is there (the palette, the domain, the exaggeration), set the
  one key, in place.
- Both are edits in place of the layer's style, as for any layer.

## Image

The picture as stored. `bands` names three bands as red, green and blue:
`[1, 2, 3]` is true color for a file whose first three bands are red, green
and blue; `[4, 1, 2]` shows near infrared as red when it is band 4. The
adjustments `brightness`, `contrast` and `saturation` (-1 to 1) and `hue`
(degrees) sit beside `render` and work with `image` only (`unknown_key` with
any other type).
`blend` beside `render` mixes an image or a map service with the map below:
`multiply` lets the map show through its white. A color range, classes,
categories, an image in its file's color table and a hillshade draw without
it.

<!-- layer: raster -->
```json
{"layer_project_id": 15, "operations": [{"op": "set", "path": "/render", "value": {"type": "image", "bands": [4, 1, 2]}}, {"op": "set", "path": "/brightness", "value": 0.1}]}
```

## Color range

`continuous` colors one band from low to high: `band` (1 when left out),
`palette`, `reverse`, `domain`, and `outside`, which is `clamp` (values beyond
the domain take the end colors) or `hide`. Palettes: `goat:elevation`,
`goat:terrain` and `goat:hypsometric` for heights, `goat:ndvi` and
`goat:green` for vegetation, `d3:viridis` for any other quantity. The legend
takes a `title`, a `unit`, and `min_label` and `max_label` in place of the end
values.

<!-- layer: raster -->
```json
{"layer_project_id": 15, "operations": [{"op": "set", "path": "/render", "value": {"type": "continuous", "band": 1, "palette": "goat:elevation"}}, {"op": "set", "path": "/legend", "value": {"title": "Elevation", "unit": "m"}}]}
```

## Classes

A color range in steps: `classify` inside `render`, with `method` and `count`
as for a vector layer but without `field` (the band is the input). The server
computes the limits and takes the colors from the `palette`. With `manual`,
write the classes yourself, each with its `from`, `to` and `color`.

<!-- layer: raster -->
```json
{"layer_project_id": 15, "operations": [{"op": "set", "path": "/render", "value": {"type": "continuous", "palette": "goat:elevation", "classify": {"method": "quantile", "count": 5}}}]}
```

## Categories

`categorical` is for codes (land cover, zones): one class per `value` with a
`name` and a `color`; `"visible": false` hides a class, and `other_color`
colors the values without a class. It needs whole-number codes: on a band of
decimals it is `render_type_mismatch`, as a color range is on codes with a
color table. Ask the user what the codes mean when the style does not name
them; never invent a meaning.

<!-- layer: raster, codes -->
```json
{"layer_project_id": 15, "operations": [{"op": "set", "path": "/render", "value": {"type": "categorical", "band": 1, "classes": [{"value": 1, "name": "Water", "color": "#4a90c2"}, {"value": 2, "name": "Forest", "color": "#2e7d32"}, {"value": 3, "name": "Built-up", "color": "#c0504d"}], "other_color": "#cccccc"}}]}
```

## Hillshade

`hillshade` shades a band of heights: `method` (`standard`,
`multidirectional`, `combined`, `igor`, `basic`), `direction` (degrees the
light comes from, 315 when left out), `altitude` (45) and `exaggeration` (0 to
1, 0.5). With a `palette` the shading lies over a color range: that is "a
hillshade with colors", and `domain`, `classify` and `outside` work as in a
color range. It needs heights: on codes with a color table it is
`render_type_mismatch`.

<!-- layer: raster -->
```json
{"layer_project_id": 15, "operations": [{"op": "set", "path": "/render", "value": {"type": "hillshade", "method": "standard", "exaggeration": 0.5, "palette": "goat:elevation"}}]}
```

## Band formulas

`band` is a band number or a formula: an object with a `name` (the popup's
label for the value) and an `expression` of `b1`, `b2` and so on, numbers,
`+ - * /` and brackets. Any other symbol is `invalid_band_expression`.

A worked formula, the vegetation index NDVI: (near infrared - red) divided by
(near infrared + red). With near infrared in band 4 and red in band 1 that is
`(b4 - b1) / (b4 + b1)`. Its values run from -1 to 1: water and bare ground
are near 0 or below, dense plants near 0.9, so the domain is given. The same
shape gives other indices: a water index is (green - near infrared) divided by
(green + near infrared).

<!-- layer: raster -->
```json
{"layer_project_id": 15, "operations": [{"op": "set", "path": "/render", "value": {"type": "continuous", "band": {"name": "NDVI", "expression": "(b4 - b1) / (b4 + b1)"}, "palette": "goat:ndvi", "domain": [-0.2, 0.9]}}, {"op": "set", "path": "/legend", "value": {"title": "Vegetation (NDVI)"}}]}
```

## Popup

A color range, categories and a hillshade open a popup on click with the
cell's value; an image opens none. `"popup": {"bands": "all"}` adds every
band's value, and `"popup": false` switches it off.
