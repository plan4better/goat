# Workflow recipes: heatmaps

## Who lives within N minutes of places

For the share or number of residents within N minutes of the nearest of many
places, the heatmap is recommended and catchment areas are the other way
(SKILL.md, step 1; catchments.md); an area, one or a few start points, or a
departure window by public transport takes catchment areas. Residents come from
census points with aggregate_points by default.

The heatmap gives each cell of the place the minutes to the nearest place,
then the residents are summed per cell:

```json
{
  "name": "Residents within 5 minutes on foot of a stop",
  "steps": [
    {"id": "stops", "kind": "dataset", "label": "Stops", "layer": 12, "filter": {"area": "DE21"}},
    {"id": "people", "kind": "dataset", "label": "Residents", "layer": 13, "filter": {"area": "DE212"}},
    {"id": "place", "kind": "dataset", "label": "Municipal boundary", "layer": 14,
     "filter": {"where": [{"field": "ags", "op": "=", "value": "09162000"}]}},
    {"id": "heat", "kind": "tool", "tool": "heatmap_closest_average", "label": "Walking time to the nearest stop",
     "settings": {"routing_mode": "walking", "show_advanced": true, "opportunity_1_n_destinations": 1}},
    {"id": "count", "kind": "tool", "tool": "aggregate_points", "label": "Residents per cell",
     "settings": {"area_type": "polygon",
                  "column_statistics": [{"operation": "sum", "field": "einwohner"}]}},
    {"id": "save", "kind": "export", "name": "Residents per cell and walking time to a stop"}
  ],
  "connections": [
    {"from": "stops", "to": "heat", "input": "opportunity_layer_1_id"},
    {"from": "place", "to": "heat", "input": "reference_area_layer_id"},
    {"from": "heat", "to": "count", "input": "area_layer_id"},
    {"from": "people", "to": "count", "input": "source_layer_id"},
    {"from": "count", "to": "save"}
  ]
}
```

- The reference area (`reference_area_layer_id`, with `show_advanced` true) is
  a polygon of the place: a project layer of its boundary or its districts,
  else the country's municipalities or districts from the catalog search
  (SKILL.md, step 3). Filter such a layer to the place with a `where` on its
  official code field, never with `filter.area`, which keeps every neighbour
  touching its border too. On foot, by bicycle, pedelec or car the run then has
  no budget (leave `opportunity_1_max_cost` out): it computes only the place's
  hexagons, each with its real minutes, and keeps only the destinations within
  its reach: 45 minutes at the mode's speed in a straight line around it (by
  car 90 minutes at 50 km/h). Only those count toward the 50,000 a run takes,
  and the check leaves that count to the run. The destinations keep their margin (SKILL.md, The draft, dataset).
  The residents keep the place (`filter.area`): the hexagons on its border
  reach past it. By public transport the reference area only cuts the result;
  the budget and the destination limit stay.
- A part of the place far from the rest (an island or an exclave many
  kilometres off) does not belong in the reference area: it widens the area a
  run on foot or by bicycle must cover, and can stop the run. A reference area
  whose `extent` (project_get_layers) is much wider than the place shows such a
  part. Leave such a part out of the reference area: on a layer that holds it as
  a feature of its own (the place's quarters or statistical areas, when the
  boundary or a district holds it together with the rest), a `where` with `!=`
  on its code or name field drops it. Say in the answer which part was left out;
  per district (Shares per district), say too that its residents stay in its
  district's total.
- The heatmap writes one row per hexagon of the reference area (per hexagon
  reached within `opportunity_1_max_cost` without one), with
  `total_accessibility`, the minutes to the nearest place, in whole minutes,
  empty where none is reached. A hexagon is about 1.3 ha on foot, 9 ha by
  bicycle, pedelec or public transport and 63 ha by car, and counts as reached
  when one street in it is. aggregate_points with `area_type` `polygon` and the
  heatmap as `area_layer_id` sums the census points into the hexagon each lies
  in and keeps `total_accessibility`; `area_type` `h3_grid` does not: its
  `h3_<resolution>` is text and does not join the heatmap's `h3_index`.
- Read it with project_group_statistics: the sum of `einwohner_sum` (the
  residents per hexagon) over the saved layer, filtered `total_accessibility`
  `<=` the limit, with `share_of` the same saved layer without a filter: its
  hexagons hold all the place's residents, reached or not. One run answers
  every limit, each holding the hexagons under it plus half a minute.
- Without a polygon of the place, the heatmap runs without a reference area:
  `share_of` the census points of the place, filtered as the residents step is
  (share_of takes no region: filter both with a `where` on an area code field
  when the census layer has one), and `opportunity_1_max_cost` set to the
  largest limit, or to the one limit, which then holds no half minute.
- Places in several layers (bus, tram and rail stops): merge them into one
  layer (merge) first. Given several opportunity layers, the heatmap averages
  their times; it never takes the nearest of them all.

## Shares per district

The share of residents in reach per district (or other named areas) counts the
census points by the district they lie in, for both: all of them, and those in
the reached cells or areas. The districts are the heatmap's reference area,
its cells are cut by the districts (intersection) and the residents summed per
piece; all residents are summed per district:

```json
{
  "name": "Residents within 10 minutes on foot of a supermarket, per district",
  "steps": [
    {"id": "shops", "kind": "dataset", "label": "Supermarkets", "layer": 12, "filter": {"area": "DE21"}},
    {"id": "people", "kind": "dataset", "label": "Residents", "layer": 13, "filter": {"area": "DE212"}},
    {"id": "districts", "kind": "dataset", "label": "Districts", "layer": 15},
    {"id": "heat", "kind": "tool", "tool": "heatmap_closest_average", "label": "Walking time to the nearest supermarket",
     "settings": {"routing_mode": "walking", "show_advanced": true, "opportunity_1_n_destinations": 1}},
    {"id": "cut", "kind": "tool", "tool": "intersection", "label": "Cells per district"},
    {"id": "reached", "kind": "tool", "tool": "aggregate_points", "label": "Residents per cell and district",
     "settings": {"area_type": "polygon",
                  "column_statistics": [{"operation": "sum", "field": "einwohner"}]}},
    {"id": "all", "kind": "tool", "tool": "aggregate_points", "label": "Residents per district",
     "settings": {"area_type": "polygon",
                  "column_statistics": [{"operation": "sum", "field": "einwohner"}]}},
    {"id": "save_reached", "kind": "export", "name": "Residents per district and walking time"},
    {"id": "save_all", "kind": "export", "name": "Residents per district"}
  ],
  "connections": [
    {"from": "shops", "to": "heat", "input": "opportunity_layer_1_id"},
    {"from": "districts", "to": "heat", "input": "reference_area_layer_id"},
    {"from": "heat", "to": "cut", "input": "input_layer_id"},
    {"from": "districts", "to": "cut", "input": "overlay_layer_id"},
    {"from": "cut", "to": "reached", "input": "area_layer_id"},
    {"from": "people", "to": "reached", "input": "source_layer_id"},
    {"from": "districts", "to": "all", "input": "area_layer_id"},
    {"from": "people", "to": "all", "input": "source_layer_id"},
    {"from": "reached", "to": "save_reached"},
    {"from": "all", "to": "save_all"}
  ]
}
```

- Read it with project_group_statistics on the first saved layer: the sum of
  `einwohner_sum`, group_by the district's name field as the intersection
  writes it, `intersection_<field>`, and `share_of` the second saved layer, the
  sum of `einwohner_sum`, group_by the name field itself. One run answers
  every limit: filter `total_accessibility` `<=` each limit on the first, as in
  the heatmap recipe.
- Catchment areas: the catchment in place of the heatmap, without the reference
  area, then_by the band (catchments.md, Bands per district).
- Never take the reached residents from cells or areas spread over the
  districts by area share (aggregate_polygon with
  `weighted_by_intersecting_area`) against census points per district: the two
  assignments differ, every district near a boundary is off, and some pass
  100 %.
- Areas counted or summed per district (cells, statistical areas, gaps): an area
  on a district boundary lies in both. Count each area once, in the district
  its centroid lies in: centroid on the areas, then aggregate_points with those
  points as `source_layer_id` and the districts as `area_layer_id`; each point
  keeps its area's fields, so `column_statistics` counts the areas or sums one
  of their fields. A centroid can fall outside a concave area, which then
  counts in its neighbour; say so when it matters. Otherwise say that areas on
  a boundary count in both. Square
  metres per district from the intersection's pieces need neither: each piece
  lies in one district. Residents per district never go through cells: count
  the census points themselves (Shares per district).

## Access everywhere: a heatmap

heatmap_closest_average gives each grid cell the average travel time to its
nearest destinations; heatmap_gravity weighs destinations by how far and how large
they are. A 15-minute city check is a heatmap_closest_average with one opportunity
per kind of destination (up to three), each with `max_cost` 15.

```json
{
  "name": "Everyday needs within 15 minutes on foot",
  "steps": [
    {"id": "shops", "kind": "dataset", "label": "Supermarkets", "layer": 12},
    {"id": "schools", "kind": "dataset", "label": "Schools", "layer": 14},
    {"id": "heat", "kind": "tool", "tool": "heatmap_closest_average", "label": "Walking time to everyday needs",
     "settings": {"routing_mode": "walking",
                  "opportunity_1_max_cost": 15, "opportunity_1_n_destinations": 1,
                  "opportunity_2_max_cost": 15, "opportunity_2_n_destinations": 1}},
    {"id": "save", "kind": "export", "name": "Walking time to everyday needs"}
  ],
  "connections": [
    {"from": "shops", "to": "heat", "input": "opportunity_layer_1_id"},
    {"from": "schools", "to": "heat", "input": "opportunity_layer_2_id"},
    {"from": "heat", "to": "save"}
  ]
}
```

- heatmap_gravity takes per opportunity `max_cost`, `sensitivity` and
  `potential_type` (`constant`, `field` or `expression`, with
  `potential_constant`, `potential_field`, a field of that opportunity's layer, or
  `potential_expression`), and `decay` for the whole heatmap.
