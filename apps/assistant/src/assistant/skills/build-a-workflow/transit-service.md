# Workflow recipes: public transport service

## Public transport service of a place

For how well a place is served, recommend the ÖV-Güteklassen (oev_gueteklassen),
which rate each area by the departures and kind of its stops nearby: the share
of residents in each class, A (best) to F, and in none, and the districts with
the largest shares in F and in none. The districts are found as the heatmap's
reference area is (heatmap.md, Who lives within N minutes of places): a
project layer, else a layer from the catalog search, filtered to the place
with a `where` on its official code field, never with `filter.area`.

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
  walking time to the nearest stop (heatmap.md, Who lives within N minutes of
  places): proximity only, no frequency; departures per stop (trip_count):
  frequency only, not linked to residents; the travel time from each district
  to the centre: the reversed matrix (SKILL.md, Running and explaining), not
  the reach from one station.
- A yes or no only against a benchmark the user names: another place,
  another time window with the same classes (evenings, or `weekday`
  `sunday`), or a stated target. Without one, the numbers are the answer;
  offer the evening or Sunday comparison as a follow-up option.
