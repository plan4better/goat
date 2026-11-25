# Popups

A popup is `/popup` of the style. Set it whole with one `set`; a block of a
popup that exists is `/popup/blocks/<id>`. Every field a popup names (an
attribute, a block's `field`, a `{{ name }}` in a text, a button or the HTML)
is checked against the dataset: `unknown_field` refuses the call. Never name a
field you have not read.

## The popup's keys

- `trigger`: `click` (default), `hover` or `click_and_hover`.
- `layout`: `popup` (next to the feature, default) or `pinned` (in a corner,
  `anchor` `top_left`, `top_right`, `bottom_left`, `bottom_right`); `width`
  and `max_height` in px.
- `header`: `standard` (the layer's name), `compact` or `none`.
- `"popup": false` switches the popup off; nothing can be set under it
  afterwards, so set `/popup` whole to switch it on again.

## Blocks

`blocks` are drawn top to bottom (`mode` `simple`, the default):

- `field_list`: `attributes`, each `{"field", "label", "type", "format"}`
  (`type` comes from the dataset; numbers take a `format`), `layout` `table`
  or `list`, `collapse_after` (then "See N more").
- `text`: `html`, a short text with `{{ name }}` values.
- `image`: `source` `field` with the `field` that holds an image URL, or
  `static` with a `url`; `sizing` `fit`, `fixed` (with `height`) or `aspect`
  (with `aspect` `16/9`).
- `button`: `label`, `url_template` with `{{ name }}` values (opens a new tab),
  `style` `link`, `outlined` or `filled`, `color`.
- `badge`: a `field` as a colored tag; `mode` `single` with `color`, or
  `per_value` with `palette` (value to color) and `labels` (value to text).
- `divider`: a line; `thickness`, `color`.

## Which fields for "a nice popup"

The name first, then what a person looks for, at most eight fields, each with
a readable `label` in the user's language. Numbers with a `format` (a year
with `"thousands_separator": false`). A URL as a `button`, an image URL as an
`image` block. Leave out ids, codes and technical columns. Read the fields
with project_get_fields first.

## HTML mode

Blocks by default. HTML only when the user asks for HTML or for a layout the
blocks cannot do. Then set `/popup` whole with `mode` `html` and `html`, a
Liquid template:

- `{{ name }}` writes a value (escaped), `{% if year %}...{% endif %}` a part
  for features that have the value, `{% for %}` a repetition, filters such as
  `{{ name | upcase }}`. Wrong syntax is `template_syntax`.
- The rendered HTML is sanitized: scripts, event handlers and embedded objects
  are removed.
- The classes `attr-table`, `attr-field`, `attr-value`, `attr-list`, `badge`,
  `btn-link`, `btn-outlined` and `btn-filled` look like the blocks.
- The blocks do not turn into a template, and a template does not convert back
  to blocks: write the whole template.

The name, the visitors, a note and a button to the website; the name as a
heading, the year only when it is known, and the photo; the popup off:

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/popup", "value": {"header": "compact", "blocks": [{"type": "field_list", "attributes": [{"field": "name", "label": "Name"}, {"field": "visitors", "label": "Visitors a year", "format": {"decimals": 0}}]}, {"type": "text", "html": "<p>{{ name }} is a {{ category }}.</p>"}, {"type": "button", "label": "Website", "url_template": "{{ website }}", "style": "outlined"}]}}]}
```

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/popup", "value": {"mode": "html", "html": "<h3>{{ name }}</h3>{% if year %}<p>Opened in {{ year }}</p>{% endif %}<img src=\"{{ photo_url }}\" alt=\"\">"}}]}
```

<!-- layer: point -->
```json
{"layer_project_id": 13, "operations": [{"op": "set", "path": "/popup", "value": false}]}
```
