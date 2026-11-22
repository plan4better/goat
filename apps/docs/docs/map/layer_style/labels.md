---
description: "Label map features with a field or a text of your own with field values, and set the number format, size, color and halo of the labels, their text style (font, case, letter spacing, line height, wrap width) and their position (placement, offset, repeat distance, priority, overlap, space around)."
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
  <div class="content">Set the <code>Size</code> and the <code>Color</code> of the text. The three rows under them, <code>Halo</code>, <code>Text style</code> and <code>Position</code>, each sum up their settings; click one to open its settings next to the editor.</div>
</div>

The row in the section then shows the field and the size, for example <code>Name · 12 px</code>.

## Text of your own

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click <code>Text</code> and choose <code>Custom text</code> at the top of the list.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Type the text under <code>Template</code>. Fields go in braces and are replaced by each feature's value, for example <code>{"{name}"}, {"{population}"} inhabitants</code> or <code>{"{area_km2}"} km²</code>. Click <code>Insert a field</code> to add a field at the end. A line break in the template starts a new line in the label. The template is applied when you leave the box or press <code>Ctrl+Enter</code> (<code>Cmd+Enter</code> on a Mac); a template that cannot be read stays in the box with a note saying why.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">For a label of several lines, <code>Line styles</code> sets the <code>Size</code>, <code>Color</code> and <code>Font</code> of each line, from the same fonts as the label's <code>Font</code>. A line without a font of its own shows the label's.</div>
</div>

## Halo

<code>Halo</code> shows the halo's color and width, for example <code>1.5 px</code>, or <code>None</code>. Click it to set its <code>Color</code> and <code>Width</code>: an outline around the letters that keeps them readable on busy backgrounds.

## Text style

<code>Text style</code> names the font first, then what differs from plain text, for example <code>Regular, uppercase, letter spacing 24%</code>. When the text is cut, point at the row or move to it with the keyboard to read all of it. Click it to set:

- <code>Font</code>: one of eight fonts, the weights <code>Regular</code>, <code>Bold</code>, <code>Medium</code> and <code>Light</code>, each under <code>Upright</code> and under <code>Italic</code>. The field names the whole font, for example <code>Bold italic</code>; the regular weight in italic is <code>Italic</code>. <code>By zoom</code>, each stop is one of the eight; <code>By classes</code>, each class picks one.
- <code>Case</code>: the text <code>As written</code>, in <code>Uppercase</code> or in <code>Lowercase</code>.
- <code>Letter spacing</code>: spreads the letters apart, or draws them closer below 0%, in percent of the text size.
- <code>Line height</code>: the distance from one line of the label to the next, 120% of the text size by default.
- <code>Wrap at</code>: the width in px at which a long label wraps onto the next line.

## Numbers

When the text shows a number field, <code>Numbers</code> opens the <code>Number format</code>: <code>Decimals</code>, <code>Thousands</code> (a thousands separator), <code>Abbreviate</code> (12.3k instead of 12,345), <code>Sign</code> (always + or -), <code>Percent</code> (a share of 1 as a percent: 0.73 reads 73%), <code>Prefix</code> and <code>Suffix</code>, such as € or km². It applies to every number in the label, and <code>As in the dataset</code> keeps the dataset's own format. When a template holds several number fields, each one can get its own format (<code>Numbers in</code> the field).

## Position

<code>Position</code> names where the labels sit, with a small grid that shows the side, for example <code>Automatic</code> or <code>Along the line</code>. Click it to set:

- <code>Placement</code>: for points <code>Automatic</code>, <code>In the middle</code> or a fixed side: <code>Above</code>, <code>Below</code>, <code>Left</code>, <code>Right</code>, <code>Above left</code>, <code>Above right</code>, <code>Below left</code> or <code>Below right</code>. A small grid beside each choice shows the side. <code>Automatic</code> picks a free side for each label; a fixed side keeps every label on that side, clear of the marker, and drops a label that would collide instead of moving it. Beside the point the lines of a label line up on the point's side. Polygons take the same choices around their [marker](./style/styling.md#markers-on-polygons-and-lines), which sits at one point inside each polygon: <code>Automatic</code> puts the label beside the marker, or in the middle of the polygon while it has no marker. For lines <code>Along the line</code>, or one label at the middle of each line with the same choices around the line's marker. Without a marker, a fixed side keeps the label just beside the middle point of the polygon or line. While the polygons have a [height](./style/styling.md#height), their labels sit on the roofs (<code>On the roof</code>).
- <code>Offset x</code> and <code>Offset y</code>: move the labels horizontally or vertically, in px.
- <code>Repeat distance</code>: for labels <code>Along the line</code>, how far apart the label repeats along the line, 250 px by default.
- <code>Overlap</code>: off, labels that would collide are dropped, which keeps the map clean, especially at lower zoom levels. <code>Automatic</code> placement first tries below, then above, left and right. On, every label is drawn, even where they overlap.
- <code>Priority</code>: while overlap is off, which labels are kept first: <code>No priority</code>, or the larger or smaller values of a number field first, for example the cities with the most inhabitants.
- <code>Space around</code>: the free space in px kept around each label, 2 px by default. Other labels keep this far away, so more space shows fewer labels.

Under <code>Position</code>, <code>Visible</code> sets the zooms at which the labels show, for example only when zoomed in. See [Zoom visibility](./zoom.md).

:::tip
A label can differ per class, for example a larger size for main roads: give the class its own label as described in [Style one class](./style/attribute_based_styling.md#style-one-class). The size and color of labels can also change [by zoom](./style/attribute_based_styling.md#by-zoom). While you style a class, <code>Halo</code>, <code>Text style</code> and <code>Position</code> show the class's values, with a dot when the class sets one of them itself. <code>Line height</code>, <code>Placement</code>, <code>Repeat distance</code>, <code>Priority</code>, <code>Overlap</code> and <code>Space around</code> hold for the whole layer: a class cannot change them.
:::

## Best practices

- Use **smaller fonts for dense layers** to reduce visual clutter.
- Add **halos with contrasting colors** (light halos on dark maps, dark halos on light maps) to improve text readability.
- Keep **overlap off for a cleaner map**, and set a priority so the most important labels stay when space is short.
- Show detailed labels **only from a zoom level on**, and test your labels at different zoom levels.
