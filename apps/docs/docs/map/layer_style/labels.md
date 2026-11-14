---
description: "Label map features with a field or a text of your own with field values, and set the number format, size, color, font, halo, placement, offset, priority and overlap of the labels."
sidebar_position: 3
---

# Labels

**Labels show text on your map features, taken from a field or from a text of your own.** This makes your maps easier to read by showing key information directly on the features.

## How to add a label

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Layers</code> panel, click your layer. Its settings panel opens on the right with the <code>Style</code> tab selected.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">In the <code>Polygons</code>, <code>Lines</code> or <code>Points</code> section, click <code>Label</code>. Its editor opens next to the panel. If the label is off, turn it on with the switch in the editor's header.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Click <code>Text</code> and choose the <strong>field</strong> whose values you want to show. <code>Preview</code> shows the label of the first feature.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Set the look of the text: <code>Size</code>, <code>Color</code>, <code>Font</code> (<code>Regular</code> or <code>Bold</code>), and a <code>Halo</code> color with its <code>Halo width</code>, an outline around the letters that keeps them readable on busy backgrounds.</div>
</div>

The row in the section then shows the field and the size, for example <code>Name · 12 px</code>.

## Text of your own

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click <code>Text</code> and choose <code>Custom text</code> at the top of the list.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Type the text under <code>Template</code>. Fields go in braces and are replaced by each feature's value, for example <code>{"{name}"}, {"{population}"} inhabitants</code> or <code>{"{area_km2}"} km²</code>. Click <code>Insert a field</code> to add a field at the end. A line break in the template starts a new line in the label.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">For a label of several lines, <code>Line styles</code> sets the <code>Size</code>, <code>Color</code> and <code>Bold</code> of each line.</div>
</div>

## Numbers

When the text shows a number field, <code>Numbers</code> opens the <code>Number format</code>: <code>Decimals</code>, <code>Thousands</code> (a thousands separator), <code>Abbreviate</code> (12.3k instead of 12,345), <code>Sign</code> (always + or -), <code>Prefix</code> and <code>Suffix</code>, such as € or km². It applies to every number in the label, and <code>As in the dataset</code> keeps the dataset's own format. When a template holds several number fields, each one can get its own format (<code>Numbers in</code> the field).

## Placement and overlap

- <code>Wrap at</code>: the width in px at which a long label wraps onto the next line.
- <code>Placement</code>: for points <code>Auto</code>, <code>Above</code> or <code>Center</code>; for lines <code>Along the line</code> or <code>Center</code>. Polygon labels sit inside the polygon, and on the roofs while the polygons have a [height](./style/styling.md#height) (<code>On the roof</code>).
- <code>Offset x</code> and <code>Offset y</code>: move the labels horizontally or vertically, in px.
- <code>Overlap</code>: off, labels that would collide are dropped, which keeps the map clean, especially at lower zoom levels. <code>Auto</code> placement first tries right, above, left and below. On, every label is drawn, even where they overlap.
- <code>Priority</code>: while overlap is off, which labels are kept first: <code>No priority</code>, or the larger or smaller values of a number field first, for example the cities with the most inhabitants.
- <code>Visible</code>: the zooms at which the labels show, for example only when zoomed in. See [Zoom visibility](./zoom.md).

:::tip
A label can differ per class, for example a larger size for main roads: give the class its own label as described in [Style one class](./style/attribute_based_styling.md#style-one-class). The size and color of labels can also change [by zoom](./style/attribute_based_styling.md#by-zoom).
:::

## Best practices

- Use **smaller fonts for dense layers** to reduce visual clutter.
- Add **halos with contrasting colors** (light halos on dark maps, dark halos on light maps) to improve text readability.
- Keep **overlap off for a cleaner map**, and set a priority so the most important labels stay when space is short.
- Show detailed labels **only from a zoom level on**, and test your labels at different zoom levels.
