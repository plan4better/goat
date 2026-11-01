# Workflow recipes: catchment areas

## Catchment areas around places

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
  It is the second option of Missing inputs (SKILL.md, step 3): such a
  workflow is not run.
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
  residents per district: all census points summed per district (heatmap.md,
  Shares per district) with a second aggregate_points, the districts as its
  area layer.

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
two workflows: the first joins the start points to the districts
(joins-and-distances.md, Join attributes) and saves them, the next splits that saved layer by district as
above. Every part is a catchment of its own, so the run takes longer: say so.
The parts together answer for every start point, as one run would; with bands,
as cumulative bands.
