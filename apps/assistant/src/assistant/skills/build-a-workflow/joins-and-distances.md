# Workflow recipes: joins and distances

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

