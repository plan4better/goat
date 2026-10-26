# Workflow recipes

GOAT's common analysis chains, with real tool ids, inputs and settings. Read the
settings with workflow_describe_tool before you use them; the layer numbers (12,
13, 14, 15) stand for layer_project_ids from project_get_layers, and the field
names stand for fields read with project_get_fields.

## Who lives within N minutes of places

For the share or number of residents within N minutes of the nearest of many
places, the heatmap is recommended and catchment areas are the other way
(SKILL.md, step 1); an area, one or a few start points, or a departure window
by public transport takes catchment areas. Residents come from census points
with aggregate_points by default.

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

Catchment areas around the places, then the residents inside them:

```json
{
  "name": "Residents within 15 minutes of the supermarkets",
  "steps": [
    {"id": "shops", "kind": "dataset", "label": "Supermarkets", "layer": 12},
    {"id": "people", "kind": "dataset", "label": "Residents", "layer": 13},
    {"id": "walk", "kind": "tool", "tool": "catchment_area_v2", "label": "15 minutes on foot",
     "settings": {"routing_mode": "walking", "cost_type": "time", "max_cost": 15, "steps": 1}},
    {"id": "count", "kind": "tool", "tool": "aggregate_points", "label": "Residents in reach",
     "settings": {"area_type": "polygon",
                  "column_statistics": [{"operation": "sum", "field": "einwohner"}]}},
    {"id": "save", "kind": "export", "name": "Residents within 15 minutes"}
  ],
  "connections": [
    {"from": "shops", "to": "walk", "input": "starting_points"},
    {"from": "walk", "to": "count", "input": "area_layer_id"},
    {"from": "people", "to": "count", "input": "source_layer_id"},
    {"from": "count", "to": "save"}
  ]
}
```

- Residents as points (census points, addresses): aggregate_points, as above, with
  `source_layer_id` the points and `area_layer_id` the catchments, and
  `column_statistics` `[{"operation": "sum", "field": "<field>"}]`, or
  `[{"operation": "count"}]` to count the points.
- Residents only as polygons (a census grid, blocks, districts with a population
  total), when no points exist: aggregate_polygon with
  `weighted_by_intersecting_area` true, which counts a polygon cut by the
  catchment by the share of its area inside it. That spreads its residents evenly
  over its area, so the result is people, labelled as an estimate.
- Residents left open (no layer fits): the `people` step gets `layer` null and its
  label, and the statistic keeps its operation without a field,
  `[{"operation": "sum"}]`, for the user to complete after choosing the layer.
- Another mode: `routing_mode` `bicycle`, `pedelec`, `car` or `pt` (public
  transport; then `max_cost` is minutes, `pt_day` sets the day, and
  `pt_start_time` and `pt_end_time`, in seconds after midnight, set when people
  travel).
- A distance instead of a time: `cost_type` `distance` and `max_cost` in meters.
- Bands, such as 5, 10 and 15 minutes: one catchment with `steps` 3 and `max_cost`
  15, never one catchment per band: the steps after it then run once, and each
  ring keeps its band. Leave `step_sizes` out: they are the band edges
  (`[5, 10, 15]`), not the width of each band, and come from `steps`.
- Bands per district: connect the catchment to an intersection with the districts
  and the intersection to the aggregation as its area layer: one row per band,
  district and separate area; group_by the district (its name field as
  `intersection_<field>`), then_by the band, to read them, and share_of the
  residents per district (Shares per district).
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
  area, then_by the band (Bands per district).
- Never take the reached residents from cells or areas spread over the
  districts by area share (aggregate_polygon with
  `weighted_by_intersecting_area`) against census points per district: the two
  assignments differ, every district near a boundary is off, and some pass
  100 %.

## Public transport service of a place

For how well a place is served, recommend the ÖV-Güteklassen (oev_gueteklassen),
which rate each area by the departures and kind of its stops nearby: the share
of residents in each class, A (best) to F, and in none, and the districts with
the largest shares in F and in none. The districts are found as the heatmap's
reference area is (Who lives within N minutes).

```json
{
  "name": "Residents per public transport quality class",
  "steps": [
    {"id": "districts", "kind": "dataset", "label": "Districts", "layer": 15},
    {"id": "people", "kind": "dataset", "label": "Residents", "layer": 13, "filter": {"area": "DE212"}},
    {"id": "classes", "kind": "tool", "tool": "oev_gueteklassen", "label": "Quality classes, weekdays 7 to 9",
     "settings": {"weekday": "weekday", "from_time": 25200, "to_time": 32400}},
    {"id": "split", "kind": "tool", "tool": "union", "label": "Classes per district"},
    {"id": "count", "kind": "tool", "tool": "aggregate_points", "label": "Residents per class and district",
     "settings": {"area_type": "polygon",
                  "column_statistics": [{"operation": "sum", "field": "einwohner"}]}},
    {"id": "save", "kind": "export", "name": "Residents per quality class and district"}
  ],
  "connections": [
    {"from": "districts", "to": "classes", "input": "reference_area_layer_id"},
    {"from": "classes", "to": "split", "input": "input_layer_id"},
    {"from": "districts", "to": "split", "input": "overlay_layer_id"},
    {"from": "split", "to": "count", "input": "area_layer_id"},
    {"from": "people", "to": "count", "input": "source_layer_id"},
    {"from": "count", "to": "save"}
  ]
}
```

- The classes come out as pieces with `pt_class` (1 for A) and
  `pt_class_label`. They never overlap: a worse class has the better ones cut
  out, so each census point lies in one piece and counts once. union keeps
  the district's fields under their own names, and a district's area in no
  class becomes pieces with an empty `pt_class_label`. Residents, never km²
  per class.
- Read it with project_group_statistics: the sum of `einwohner_sum`, group_by
  `pt_class_label`, share_of the same saved layer without a filter; the row
  without group is the residents in no class. Per district: group_by its name
  field, then_by `pt_class_label`, share_of the same layer group_by the name
  field; the rows without then are no class, a row without group the class
  pieces beyond the districts.
- Weekdays 7 to 9 are the tool's defaults (`from_time` and `to_time` in
  seconds after midnight): state the window. Only stops inside the reference
  area are rated, so classes along its border can come out a little low.
- The card offers the other measures too, each with what it leaves out: the
  walking time to the nearest stop (Who lives within N minutes): proximity
  only, no frequency; departures per stop (trip_count): frequency only, not
  linked to residents; the travel time from each district to the centre: the
  reversed matrix (SKILL.md, Running and explaining), not the reach from one
  station.
- A yes or no only against a benchmark the user names: another place,
  another time window with the same classes (evenings, or `weekday`
  `sunday`), or a stated target. Without one, the numbers are the answer;
  offer the evening or Sunday comparison as a follow-up option.

## Start points over the limit

When catchment areas are the method: a catchment takes at most 1,000 start
points in one run (100 for public transport), and workflow_check_draft reports
`too_many_starting_points` above that. When the question needs every start
point, run the catchment in parts and combine them:

- one dataset step per part, all on the same layer, each with a `filter.where`
  that keeps at most the limit (1,000; 100 for public transport): a district
  field (`{"field": "district", "op": "=", "value": "North"}`) or a range of a
  numeric field from project_get_fields, two conditions in one `where` (`>=` the
  part's first value, `<` the next part's). Take the bounds from the values the
  layer holds, not from a fixed range: project_field_statistics on that field,
  with the step's `where` conditions as its filter (it takes no region), and
  `method` `quantile` with `breaks` one fewer than the parts (7 gives 8 parts
  of about equal count). The check counts each part with its own filter;
- one catchment_area_v2 per part, all with the same settings;
- merge steps that join the catchments (each merge takes two layers, as
  workflow_tools lists its inputs, so chain merges for more parts), then one
  dissolve that makes them one area, so a resident inside two catchments counts
  once;
- the steps after it (aggregate_points, difference) read the dissolved area.

With bands (`steps` above 1), the rings of separate parts overlap, so each
part's catchment sets `steps_style` `cumulative` (with `show_advanced` true):
every band is then the whole area reached up to it, and a dissolve by the band
field (`dissolve_fields` `["cost_step"]`) is exact, while a dissolve without
fields merges the bands too. Report those bands as "within N minutes", not as
rings.

A draft holds at most 30 steps, and each part costs a dataset step, a catchment
and a merge, so one workflow takes at most 8 parts: about 8,000 start points on
foot, by bicycle or by car, 800 by public transport. Above that, offer
narrowing to part of the start points and say why: one workflow holds at most 8
parts. When the layer has no field to split by, and the parts still fit, use
two workflows: the first joins the start points to the districts (Join
attributes) and saves them, the next splits that saved layer by district as
above. Every part is a catchment of its own, so the run takes longer: say so.
The parts together answer for every start point, as one run would; with bands,
as cumulative bands.

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

## Join attributes

join keeps the features of `target_layer_id` and adds fields of `join_layer_id`,
by location or by a shared field.

```json
{
  "name": "Schools with their district",
  "steps": [
    {"id": "schools", "kind": "dataset", "label": "Schools", "layer": 12},
    {"id": "districts", "kind": "dataset", "label": "Districts", "layer": 15},
    {"id": "join", "kind": "tool", "tool": "join", "label": "District of each school",
     "settings": {"use_spatial_relationship": true, "use_attribute_relationship": false,
                  "spatial_relationship": "intersects", "join_type": "inner",
                  "join_operation": "one_to_one", "add_join_fields": true, "join_fields": ["name"]}},
    {"id": "save", "kind": "export", "name": "Schools with district"}
  ],
  "connections": [
    {"from": "schools", "to": "join", "input": "target_layer_id"},
    {"from": "districts", "to": "join", "input": "join_layer_id"},
    {"from": "join", "to": "save"}
  ]
}
```

- By a shared field: `use_attribute_relationship` true and
  `attribute_relationships` `[{"target_field": "<field>", "join_field": "<field>"}]`.
  A join on names misses areas that were merged or renamed: after the run,
  count the rows that found no partner (an inner one-to-one join: the
  target's project_count_features against the result's rows; a left join:
  the rows whose `join_` fields are empty, or whose `match_count` is 0) and
  say so, since a missing value is not a zero.
- `join_fields` are fields of the join layer (project_get_fields).

## Counting within a distance

Buffers around places, then what lies inside them.

```json
{
  "name": "Bus stops within 500 m of the schools",
  "steps": [
    {"id": "schools", "kind": "dataset", "label": "Schools", "layer": 12},
    {"id": "stops", "kind": "dataset", "label": "Bus stops", "layer": 13},
    {"id": "ring", "kind": "tool", "tool": "buffer", "label": "500 m around the schools",
     "settings": {"distance_type": "constant", "distances": [500], "units": "meters"}},
    {"id": "count", "kind": "tool", "tool": "aggregate_points", "label": "Stops per school",
     "settings": {"area_type": "polygon", "column_statistics": [{"operation": "count"}]}},
    {"id": "save", "kind": "export", "name": "Bus stops within 500 m"}
  ],
  "connections": [
    {"from": "schools", "to": "ring", "input": "input_layer_id"},
    {"from": "ring", "to": "count", "input": "area_layer_id"},
    {"from": "stops", "to": "count", "input": "source_layer_id"},
    {"from": "count", "to": "save"}
  ]
}
```

Polygons inside the buffers (green spaces, buildings): aggregate_polygon with
`source_layer_id` the polygons. For an area, such as the green space around each
school, `weighted_by_intersecting_area` counts a polygon cut by the buffer by the
share of its area inside it, and the sum of a field holding each polygon's area in
m² (project_get_fields) is the area inside. Label it as area.

```json
{
  "name": "Green space within 500 m of the schools",
  "steps": [
    {"id": "schools", "kind": "dataset", "label": "Schools", "layer": 12},
    {"id": "green", "kind": "dataset", "label": "Green spaces", "layer": 14},
    {"id": "ring", "kind": "tool", "tool": "buffer", "label": "500 m around the schools",
     "settings": {"distance_type": "constant", "distances": [500], "units": "meters"}},
    {"id": "area", "kind": "tool", "tool": "aggregate_polygon", "label": "Green space area (m²)",
     "settings": {"area_type": "polygon", "weighted_by_intersecting_area": true,
                  "column_statistics": [{"operation": "sum", "field": "flaeche_m2",
                                         "result_name": "green_area_m2"}]}},
    {"id": "save", "kind": "export", "name": "Green space area within 500 m"}
  ],
  "connections": [
    {"from": "schools", "to": "ring", "input": "input_layer_id"},
    {"from": "ring", "to": "area", "input": "area_layer_id"},
    {"from": "green", "to": "area", "input": "source_layer_id"},
    {"from": "area", "to": "save"}
  ]
}
```

- A walking distance instead of a straight line: catchment_area_v2 with
  `cost_type` `distance` and `max_cost` in meters, in place of buffer.
