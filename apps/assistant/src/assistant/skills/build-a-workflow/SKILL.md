---
name: build-a-workflow
description: Build a new workflow, a chain of analysis steps in the project's Workflows mode, from what the user describes. For example "build a workflow that finds the areas within 15 minutes on foot of the schools and counts the residents there", a 15-minute city check, a heatmap of access, joining attributes from one layer to another, or counting things near places.
---

# Build a workflow

You build one new workflow in the open project, and run it when the user wants its
result (Running and explaining). You never change or delete a workflow that exists.
On a page without the workflow tools (the catalog, home, layouts, dashboards), tell
the user to open the project's Map or Workflows page to build it there.

## Steps

1. **Understand the goal.** What is reached from where, how (walking, bicycle,
   pedelec, car, public transport), how far (minutes or meters), in which place, and
   what the result should show. Ask, as your instructions say, only when the goal
   itself is unclear.
2. **Look for a template.** Call workflow_find_templates once, with the analysis in
   a few words. German and English words in one query are fine: it searches the
   whole query, then up to four of its words of three or more characters on their
   own. When it finds fewer than twenty, `other_templates` lists the other
   workflow templates the user can use as well, up to twenty in all. When no
   template holds those words, it lists the workflow templates the user can use
   instead, up to twenty. Its `note` says what the lists hold: their names and
   descriptions are often in another language than the query, and a hit can be
   weak, so judge from all of them whether one fits. A second call in the same
   answer returns the first call's result, so do not search again. When one
   fits, use it: templates are tested.
   Only workflow templates can be used. Find a project layer for each of its
   inputs with needs_binding as in steps 3 and 4, then call
   workflow_create_from_template with
   `bindings`: each input's `key`, as `inputs` of workflow_find_templates gives it,
   and the layer_project_id. A binding takes no filter: when the only layer with
   the data an input needs covers far more than the place (its `extent` or
   `feature_count`), build a draft with `filter.area` instead of using the
   template. An input with needs_binding that you leave
   unbound stays open for the user and comes back in `open_issues`. Then answer
   (step 7).
3. **Find the data.** project_get_layers lists the project's layers. For a
   dataset no project layer holds, look in the user's own datasets with core_find
   (kind dataset) and search the catalog for it once: find the place with
   catalog_find_region, then one catalog_search with its nuts and the topic's
   German and English words in q, separated by commas (`toilette,wc,toilet`).
   These searches decide: do not search for that dataset again with other words.
   For each dataset the workflow needs:
   - exactly one layer fits: use it;
   - several fit, or none fits but the searches found fitting datasets of the
     user's own or in the catalog: it is unclear;
   - nothing fits anywhere: leave the step open (layer null), labelled for what is
     missing. The user chooses its layer in the editor, so it needs no card.

   Before recommending a dataset for a role, check that it has what the role
   needs: the field (a population total), the place (its extent or feature
   count covers the area), the transport modes (all stops, not one operator's
   buses), and the date or time window the question asks about. Read its
   columns, values or extent first (project_get_fields,
   project_sample_features, and the `extent` and `feature_count` from
   project_get_layers for a project layer; catalog_get_record for a catalog
   dataset). An option you have not checked is not recommended. For one of the
   user's own result layers, check how it was made before you reuse it. Its
   area comes from its `extent` and `feature_count` (project_get_layers,
   project_count_features) and from the datasets its workflow starts from
   (`inputs` in project_get_workflows); the time window, modes and budgets
   come from the steps of that workflow's last run (workflow_last_run, whose
   saved layers name the layer): each lists the settings the run was sent and
   those it left at the tool's default, and a setting neither lists is not
   used by that step or not known (workflow_describe_tool gives it). Its
   description comes from core_find.
   workflow_last_run reads only the open project's workflows and sees only
   runs of the last three days, so for a layer made in another project, or an
   older one, no run is found: then judge from the extent, the count and the
   description. Recommend it only when that method fits the question. A layer
   shared with the user that covers another place is not their own data and
   does not fit; a card labels shared layers as shared, never as the user's
   own.

   A bundle splits one theme into members, such as one member per bus type
   (city buses and express buses) or per transit mode. catalog_get_record
   lists a catalog bundle's members (`goat:items`), and project_get_layers
   lists them as layers once the bundle is added; core_find finds the user's
   own bundles. Use every member the question covers unless the user says
   otherwise, and name the members you used in the answer. Never describe a
   subset as the whole: "buses" only when every bus member is in.

   Three roles come up often:
   - residents: census points with `aggregate_points` are the default. Never
     spread an area's population by its area share when points exist. Square
     metres are an area result, labelled as area, never as people; residents
     spread by area share (only when no points exist) are people, labelled as
     an estimate;
   - public transport origins: stops when the question is about stops, not
     polygon centroids, since a centroid can lie in water, in fields or in a
     harbour, off the network, and by public transport one origin off the
     network fails a whole travel-time matrix. For the travel time from areas
     (districts, the surroundings) to a centre by public transport, recommend
     the reversed matrix: the centre as origin, the area centroids as
     destinations (Running and explaining);
   - a centre or a station as start point, in any mode: a district's centre
     is its main centre (its town hall, main station or the centre's stop),
     never the centroid of its polygon. A large station's platform points
     can lie on a piece of the footway network that does not reach the
     street: start from the street stops or entrances around it.

   Ask about all unclear datasets in one ask_user card, one question per dataset,
   as soon as the candidates are clear. Do not read each candidate's record with
   catalog_get_record before asking: read one only for the dataset you recommend
   or will use, or when the fields decide which candidate fits. The card's
   options, at most four: the fitting project layers (value: the layer_project_id
   as text), fitting catalog datasets and the user's own fitting datasets from
   core_find (description: "Adds it to the project"), and "Leave it open" (no
   value). Every option that uses data not yet in the open project lists it in
   `adds`, a layer of another project too (its dataset's id from core_find);
   `value` is a short key then. The data a step needs rides on the `adds` of
   the card that decides that step, never on a second card that only asks to
   add it: an option that names data without `adds` makes one necessary.
   Recommend the best fit. In any card, recommend the option that answers the
   whole question: both time windows, all the modes, the whole area (and
   service level, not only distance, when the question asks how well a place
   is served). Departures "on a day" count the whole day, "which areas" needs
   named areas, and every kind the question names is in (both kinds of shops
   it asks about, not one). A narrower option (one time window, some of the
   modes, part of the area or of the start points) may be offered, never
   recommended; when the user picks it, the answer says what was left out.
   Then end your answer.
4. **After the answer.** Add each catalog dataset the user picked with
   project_add_catalog_layer and its catalog id, and each of the user's own
   datasets they picked with project_add_dataset and its id from core_find; use
   the layer_project_ids they return (a bundle adds several layers). A dataset
   the user only named in their text, or wrote into the card's free-text field,
   is not picked: ask with the card. "Leave it open" means layer null. A catalog
   dataset's data is copied in the background; until then the check does not
   judge its fields, and
   project_get_fields may not read them either: take them from the columns
   catalog_get_record lists for that dataset, for a bundle the `columns` of the
   member you use. It lists at most 60 columns of a layer. When the field you need
   is not listed and the list may be cut (`columns_truncated` on a member, or 60
   columns listed), leave that dataset step open, labelled with the dataset's
   name, so the user chooses the layer once its copy is ready. When the list is
   complete, the dataset has no such field: tell the user, or offer another
   dataset.
5. **Pick the tools.** workflow_tools lists the tools and their layer inputs. Read
   the settings of the ones you use with one workflow_describe_tool call. Use only
   the tools, inputs and settings these list. A step they do not list, such as a
   custom SQL step, does not go into your draft; the user can add it in the editor
   later. recipes.md has the common chains: load it with skills_load (name
   build-a-workflow, file recipes.md).
6. **Write, check, fix.** Write the draft, check it with workflow_check_draft, fix
   every issue you can (Reading issues) and check again, at most three times. Then
   create it with workflow_create. The same draft created again returns the first
   result; a changed draft would be a second workflow.
7. **Answer** in a few sentences: what the workflow does, each step left open and
   what the user chooses there (the open issues), what the result's notes say
   (an area stored as a box, layers a template added), and, unless you run it (Running and
   explaining), that the user starts it with Run. The workflow card opens it.

## Running and explaining

- Run when the user asked for a result ("berechne", "how many", "how well"): build,
  then call workflow_run with the workflow's id. Asked only for a workflow, build it
  and offer to run it in one line.
- workflow_run runs a workflow you created in this conversation at once. Any other
  (the user's, one from an earlier conversation, one they ran by hand) it refuses
  until the user picked Run in your card: ask with ask_user, options Run (value
  `run:<workflow id>`, recommended) and Not now, and end your answer.
- Its summary has a `note`: do what it says.
- `succeeded`: read each saved layer by its `layer_project_id` before you answer.
  Shares and totals come from project_group_statistics: per group (per district
  and band: group_by the district's name field, then_by the band field), without
  group_by for one total, and `share_of` with its own filter for the denominator
  (the residents in reach over all residents). The server computes them. Never
  divide yourself, and never add up rows yourself. Read what an output means from
  the tool's description (rings or cumulative areas, cut pieces, upper
  estimates). Give the numbers (a small table when there are few rows), what
  stands out, and the method's caveats: mode and speed, the data sources and how
  complete they are. Show the saved layers as cards (core_show_items).
- A share's numerator and denominator count the same population from the same
  source and year: census points with census points, a registry with the same
  registry. The tool notes when they come from different layers: a reason to
  check their sources, not an error. A sum of census points in reach over all
  census points is right; a census numerator over a registry denominator is
  not: take the denominator from the numerator's source, or say that the bases
  differ.
- A question that asks which areas or places gets them named (districts or
  statistical areas, with their values): grid cells alone do not answer it,
  so aggregate the cells to named areas. Areas (cells, statistical areas,
  gaps) counted or summed per district: give each area one district, by its
  centroid (recipes.md), or say that areas on a boundary count in both.
- A catchment far below its nominal size (well under 1 km² for 15 minutes on
  foot) most likely started on a piece of the network that does not reach
  the street, such as a station's platforms. Build it again from the street
  stops or entrances around it, run it, and say why.
- State the method as it ran: quote the time window, modes, speeds and
  distances from the run summary, not from your draft or a card. Each tool
  step lists the settings the run was sent (`settings`) and those it left at
  the tool's default (`defaults`); a setting neither lists is not used by that
  step or not known (workflow_describe_tool gives it). A catchment is a
  walking, cycling or travel time (or a distance) along the network, never a
  straight-line distance; only a buffer is a straight line.
- Report the numbers first: after a run, its numbers (or what failed and why)
  come before anything else, and ask_user refuses a card while a finished run
  has no text after it. Then at most one follow-up card, only for a real
  decision the question leaves open, and no clean-up cards. Never ask for
  permission to check a result, add data or highlight something: check and
  highlight without asking, and add data through the `adds` of the card that
  decides it. When the user asked for a result, never ask whether to run a
  workflow you created in this conversation: run it. The Run card for any other
  workflow is not that question: it is the permission workflow_run needs.
- A filter on a tool's result (stops with at least 6 departures an hour): run the
  workflow that makes the result, then use its saved layer as a dataset step with
  a filter in the next workflow.
- `failed`: name the failing step and its error in plain words and what to change in
  the editor. You cannot change the workflow; build a corrected new one only when the
  user asks. `refused`: the same, from its issues; nothing ran.
- A travel-time matrix (travel_cost_matrix) by public transport fails as a whole
  when one origin lies off the network (start points disconnected from the
  street network), and the error does not say which; by walking, bicycle or car
  that origin only leaves an empty row. A destination off the network becomes
  an empty cell. So from areas to a centre by public transport, and after such
  a failure, recommend the reversed matrix: swap origins and destinations, with
  the centre as origin and the area centroids as destinations. Name the areas
  whose cells stay empty and never call them unreachable, and say that the trip
  is measured outward from the centre, with the departure window at the
  centre. The network still connects the rest of the place: never conclude
  that it does not.
- `running`: the wait ended first. Say the run is still going and that you can read
  it later; read it then with workflow_last_run. Use workflow_last_run as well when
  the user asks about a run they started.

## The draft

```json
{
  "name": "Schools: residents within 15 minutes on foot",
  "steps": [
    {"id": "schools", "kind": "dataset", "label": "Schools", "layer": 12,
     "filter": {"area": "DE212", "where": [{"field": "schulart", "op": "=", "value": "Grundschule"}]}},
    {"id": "residents", "kind": "dataset", "label": "Census points", "layer": 13,
     "filter": {"area": "DE212"}},
    {"id": "walk", "kind": "tool", "tool": "catchment_area_v2", "label": "15 minutes on foot",
     "settings": {"routing_mode": "walking", "cost_type": "time", "max_cost": 15, "steps": 1}},
    {"id": "count", "kind": "tool", "tool": "aggregate_points", "label": "Residents",
     "settings": {"area_type": "polygon",
                  "column_statistics": [{"operation": "sum", "field": "einwohner"}]}},
    {"id": "save", "kind": "export", "name": "Residents within 15 minutes of schools"}
  ],
  "connections": [
    {"from": "schools", "to": "walk", "input": "starting_points"},
    {"from": "walk", "to": "count", "input": "area_layer_id"},
    {"from": "residents", "to": "count", "input": "source_layer_id"},
    {"from": "count", "to": "save"}
  ],
  "variables": [],
  "notes": [
    {"id": "about", "near": ["count", "save"],
     "text": "How many residents live within 15 minutes on foot of a primary school.\n\n- Residents within 15 minutes of schools: one row per separate area of the walk; their sum is the residents within 15 minutes on foot of any primary school"}
  ]
}
```

- Step kinds: dataset, tool, export. Step ids: letters, digits, `-` and `_`, unique.
- dataset: `layer` is a layer_project_id from project_get_layers, or null for a step
  left open; an open step needs a `label` naming what is missing and takes no
  filter. `filter.area` is a nuts_id from catalog_find_region and keeps the
  features inside that region: use it when a dataset covers more than the place
  asked about, project layers included. project_get_layers shows a layer's
  `extent` (west, south, east, north) and its `feature_count` when known: a
  layer whose extent or feature count is far larger than the place gets
  `filter.area`. A layer of a whole country (census points, stops) always
  does, or gets a `where` on an official area code field: unfiltered, the
  run reads the whole country and can fail on distance or memory.
  `filter.where` keeps the features matching every condition, each
  `{field, op, value}` with op one of `=`, `!=`, `<`, `<=`, `>`, `>=`, `in`
  (a list) or `contains` (text), on fields from project_get_fields, which
  you read only for the layers the workflow uses. A layer's own filter on
  the map is not part of the workflow: restate it in `where` when it matters.
- tool: `tool` is an id from workflow_tools; `settings` by name, as
  workflow_describe_tool lists them; leave out settings whose default fits. A
  layer reaches a tool only through a connection: never name one of the tool's
  layer inputs in `settings`; a draft that does is refused.
- export: `name` is the name the result is saved as. Every result the user wants
  to keep ends in an export.
- connections: `from`, `to`, and `input`, the tool's layer input (layer_inputs); no
  input into an export; one connection per input.
- notes: give every workflow you create one short note of at most three short
  lines: what it answers and how to read its results, e.g. which result holds
  the answer or what the bands mean. State only what the steps fix: one row
  only after a dissolve (one per band when it dissolves by the band field),
  while a catchment alone can hold several rows per band, one per separate
  area; a field a join added as `join_<field>`; classes and scales only as
  the tool's description defines them. Never put data values or personal
  data in a note, nor counts that come from the data (rows, classes or
  features). Shorten an over-long note yourself; never ask the user about a
  note.
  `text` is plain text in the language of the user's message, no HTML: a blank
  line starts a new paragraph, lines starting with `- ` form a list. `near` lists
  the ids of the steps it explains, and the note is placed above them; empty, it
  sits beside the whole workflow. `color`: yellow (default), blue, green, red or
  grey. A note's `id` is unique among the steps and notes; at most 5 notes.
- The workflow's `name`, the step labels and the export names are in the
  language of the user's message, as your answer is, also when the project's
  layers are named in another language; the names of layers stay as they are.
- A setting with `visible_when` counts only when its condition holds: set the
  settings it depends on. Names starting with `_` in a condition are facts the
  editor knows, such as that the project has a street network. A setting shown
  only with `show_advanced = true` needs `show_advanced: true` too.
- `default_hint` is the value the form fills in from other settings (`5 if
  routing_mode = "walking", else 15 if ...`). A run that leaves the setting
  out takes what the tool resolves, not always that value: a travel cost
  matrix's `max_cost` (walking, bicycle, pedelec or car) left out is
  unbounded. When the step relies on a number it gives, set that number (or
  the user's) explicitly, so the step shows it and the run uses it; a field
  list (`every field of ...`) stays left out.
- A field setting (`reads_layer`) takes a field of the layer connected to that
  input: from project_get_fields for a dataset (catalog_get_record for one still
  being copied, step 4), or a field the step before produces. Never guess a field
  name. While that layer is still to be chosen (a step left open, or a step that
  reads from one), leave the field out: the check cannot read the fields of an
  open layer, so a guessed name passes now and fails once the user picks a layer
  with other field names, while a field left out stays open for the user.
- Statistics (`column_statistics`, `field_statistics`): set every item's
  `operation`, which never depends on the layer; an empty `column_statistics`
  stops workflow_create. Its `field` follows the rule above, for example
  `[{"operation": "sum"}]` while the layer is open; `count` needs no field.
- Heatmaps take up to three opportunity layers on `opportunity_layer_1_id`,
  `opportunity_layer_2_id` and `opportunity_layer_3_id`; the settings of each
  (`per_opportunity`) are written as `opportunity_<N>_<name>`, for example
  `opportunity_1_max_cost`.
- Never invent a tool, an input, a setting, a value or a layer.

## Reading issues

workflow_check_draft answers with the `issues`, how many of them stop
workflow_create (`blocking`) and how many the user resolves by choosing the layers
of the steps left open (`open`). workflow_create is refused while one blocks. Each
issue names its steps by your ids (`steps`), and a one-step issue's message starts
with the step's name.

- `layer_not_chosen`: a dataset step without a layer. Fine when you left it open on
  purpose; otherwise choose its layer.
- `input_not_connected`, `opportunity_not_connected`: connect a step to that input.
- `connection_to_unknown_input`: use an input from layer_inputs.
- `setting_required`: fill it from the user's request, or ask.
- `setting_invalid`: the value does not fit; read the setting again with
  workflow_describe_tool. On a step that reads from a step left open it can be a
  field left out on purpose, which stays open.
- `field_not_in_layer`, `filter_field_not_in_layer`: use a field the layer has
  (project_get_fields).
- `field_maybe_missing`: a warning; the step before may not produce that field:
  compare with what that step outputs.
- `field_renamed_by_join`: a join names each field it adds `join_<field>`; use
  the name the message gives.
- `too_many_destinations`: the heatmap's opportunity layers without a filter have
  more features than it takes. Give their dataset steps `filter.area` for the
  place asked about, or a `where`, and check again. When an If step may skip the
  heatmap, it is a warning and does not stop workflow_create.
- `too_many_starting_points`: a catchment gets more start points than one run
  takes (at most 1,000; 100 for public transport). When the question is only
  about part of them (a district, a stop type the user named), narrow the
  dataset step's filter to that part and say so. When the question needs them
  all, run the catchment in parts: one dataset step per part, each with a filter
  that keeps at most the limit (a district, or a range of a numeric field), each
  with its own catchment, then the catchments merged (merge) and dissolved into
  one area (dissolve) before the next step. A draft holds at most 30 steps, so
  one workflow takes at most 8 parts: about 8,000 start points on foot, by
  bicycle or by car, 800 by public transport. Above that, offer narrowing and
  say why (one workflow holds at most 8 parts); when no field splits the layer,
  two workflows split it by district within those 8 parts. With bands, each
  part's catchment gives cumulative bands (recipes.md, Start points over the
  limit). When the parts fit, offer the run in parts in a card,
  recommended, and say that it runs longer; narrowing to part of the start
  points stays an option the user picks, offered as such. Runs in parts are
  combined this way: never say that runs in parts cannot be combined. Never
  present a narrowed run as the whole city.
- `too_many_matrix_pairs`: a travel cost matrix gets more origin and destination
  pairs than one run takes (at most 10,000); its message says how to use fewer,
  or a heatmap instead.
- `more_than_one_note`: a warning; keep one note unless the user asked for more.
- `catchment_bands_split`: a warning; replace those catchments with the one its message
  names (the largest budget, one band per budget) and connect the steps after it once.
- `export_name_missing`: give the export a name.
- `loop`: a step reads from itself through others; remove a connection.
- `layer_not_readable`: the user cannot read that layer; choose another or leave
  the step open.
- `step_not_connected`: a warning; connect the step or leave it out.
- An error instead of a result (a value the check refuses, a tool workflow_tools
  does not list, a layer input in `settings`, a layer the user cannot read or that
  is not in the project) comes again for the same draft: change the draft.
- A check that could not run says so (`checked` false). The same draft stays
  unchecked in this answer, so do not check it again: go on with workflow_create,
  which checks again and refuses while no check can run. That refusal may be tried
  once more.
