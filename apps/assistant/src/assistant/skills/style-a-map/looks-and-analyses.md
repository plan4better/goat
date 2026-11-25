# A look or an analysis

Heatmaps, clusters and hexagons exist twice in GOAT, and a request means one
of the two.

## Which one a request means

- **A look** draws the points of a layer the project already has in another
  way. It is `render` in the layer's style: no data is created, nothing runs,
  and the dock's undo button takes it back.
  - "Show where the shops are dense": a heatmap.
  - "Group nearby stops into clusters": clusters.
  - "Show how many accidents there are per hexagon": hexagons.
- **An analysis** creates a new layer with a workflow. It takes time and
  credits, and the skill build-a-workflow builds it.
  - "Which areas reach a supermarket within 10 minutes on foot": catchment
    areas.
  - "How well can the residents reach the schools": an accessibility heatmap,
    which has the look's name and is a different thing: a result layer of
    cells with a score, computed along the street network.
  - "Count the residents per district": points aggregated into polygons.
- **The test.** A travel time, a network, a second layer, or numbers per area
  that the user wants to keep make it an analysis. Where the points of one
  layer lie makes it a look.
- **Unclear** ("a heatmap of the schools"): make the look, and say in one
  sentence that access to them is an analysis you can build. Never start a
  workflow for a look, and never ask a card about it.
- A look draws points only: on lines and polygons it is
  `render_not_for_geometry`.
- A look is an edit in place of the layer's style, like any other change:
  `set` `/render`, without a card. A change to a look that exists (the
  radius, the palette) sets that key. A look has no legend numbers.
- To draw the points as points again, `remove` `/render`.

Layer 13 holds points in the examples.

## Heatmap

`"type": "heatmap"` with `radius` (pixels, 26 when left out), `intensity` (0.2
to 3), `palette` and `points_from_zoom`, the zoom from which the single points
show again (14 or 15). `weight` counts each point by a number field
(`{"field"}`) when the points carry a quantity such as visitors; without it
every point counts once. The ramp starts transparent, so take a palette whose
high end stands out from the basemap: `colorbrewer:YlOrRd` on a light basemap,
`d3:magma` or `d3:inferno` on a dark one or on imagery.

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/render", "value": {"type": "heatmap", "radius": 30, "palette": "colorbrewer:YlOrRd", "points_from_zoom": 15}}]}
```

## Clusters

`"type": "cluster"` groups points that lie close on the screen:
`cluster_until_zoom` (clusters below it, single points from it, 14 when left
out), `radius` (50) and `min_points` (2). Its own `symbol` styles the clusters
over the field `count`: a marker sized by it and a label that shows it. The
single points keep the style's symbol and classes. Clusters work up to 100,000
features (`too_many_features_for_render`): above that use a heatmap or
hexagons.

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/render", "value": {"type": "cluster", "cluster_until_zoom": 14, "symbol": {"marker": {"shape": "circle", "color": "#283593", "size": {"field": "count", "range": [16, 40], "scale": "sqrt"}}, "outline": {"color": "#ffffff", "width": 2}, "label": {"text": "{count}", "color": "#ffffff", "size": 12}}}}]}
```

## Hexagons

`"type": "h3"` counts the points per hexagon cell: `resolution` (`auto`, or 5
to 10), `value` (`{"op": "count"}`, or `sum` or `mean` of a number `field`), a
sequential `palette`, and `classify` with `method` and `count` but without
`field` (the cell value is the input; without it the colors are a smooth
ramp). `opacity` is 0.85 when left out, and `points_from_zoom` shows the
points again. An installation that cannot draw hexagons answers
`not_supported_yet`: use a heatmap then.

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/render", "value": {"type": "h3", "resolution": "auto", "value": {"op": "count"}, "palette": "colorbrewer:YlOrRd", "classify": {"method": "quantile", "count": 5}, "points_from_zoom": 15}}]}
```

## Styling the result of a workflow

- A result layer exists only when its run has finished. Style a result only
  after its run has finished: when workflow_run answers `succeeded`, its saved
  layers carry their `layer_project_id`. While it answers `running`, say that
  the run is still going and style the result on the user's next message
  (workflow_last_run reads the run then).
- A result arrives with the look GOAT gives it: catchment areas colored by
  travel time, heatmaps with their ramp. Keep it unless the user asked for
  another look.
- When the request asked for a look as well ("catchment areas around the
  stations, lightest for the shortest time"): report the run's numbers first,
  as build-a-workflow says, then style the result as any layer: read its
  fields and their values, read its style, and edit it in place.
