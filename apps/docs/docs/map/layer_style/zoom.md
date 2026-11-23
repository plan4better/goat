---
description: "Set the zoom range, between 0 and 24, at which a layer appears on the map, narrow it per part, class or rule, and see the map's zoom on the scale, with suggested ranges per data type."
sidebar_position: 1
---

# Zoom visibility

**Zoom visibility controls the zoom range at which a layer appears on your map.** This helps you show the most relevant data at each zoom level and keeps the map fast and readable. Within the layer's range, each part of the symbol, each class and each rule can show at fewer zooms.

## Understanding zoom levels

GOAT uses zoom levels from **0 (world view) to 24 (street-level detail)**:

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

| Zoom Level | Typical use case              |
| ---------- | ----------------------------- |
| **0-8**    | Global to regional context    |
| **9-14**   | City to neighborhood analysis |
| **15-24**  | Street-level details          |
</div>

:::info Default settings
A new layer is visible at all zooms (<code>All zooms</code>) unless configured otherwise.
:::

## How to set the zoom range of a layer

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Layers</code> panel, click your layer. Its settings panel opens on the right with the <code>Style</code> tab selected.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">In the <code>Layer</code> section, click <code>Visible</code>. The row shows the current range, for example <code>All zooms</code>, <code>From zoom 8</code> or <code>Zoom 8 to 14</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Under <code>Zooms</code>, <strong>drag the two handles of the scale</strong> to set where the layer starts and stops showing. The range is written next to the scale, for example <code>8 to 14</code>. A handle at the end of the scale (0 or 24) means no limit on that side.</div>
</div>

The triangle under the scale marks the current zoom of the map, with its number. Click under the scale to zoom the map to that level, or drag the triangle to zoom it gradually: this way you can check at once how the layer looks at the edges of its range. The editor's subtitle also names the map's zoom, for example <code>Map at zoom 12.5</code>.

## Zoom ranges of parts, classes and rules

A layer's zoom range applies to everything it draws. Inside it, you can narrow the range further:

- **A part of the symbol**: every part's editor (such as <code>Fill</code>, <code>Outline</code> or <code>Label</code>) ends with its own <code>Visible</code> scale. For example, show the labels only from zoom 13 on, while the polygons show at all zooms. The <code>Visible</code> row of the <code>Layer</code> section lists the parts with a range of their own, such as <code>Label: From zoom 13</code>.
- **A class**: while you [style one class](./style/attribute_based_styling.md#style-one-class), the section shows the class's own <code>Visible</code> scale.
- **A rule**: a rule's <code>Zooms</code> show the matching features at fewer zooms, see [Rules](./style/attribute_based_styling.md#rules).

The scales of parts and classes shade the layer's own range. These ranges can only narrow the layer's: a class set to start at zoom 5 on a layer that starts at zoom 8 shows from zoom 8.

## Best practices

**Detailed features** (Buildings, [POIs](https://www.plan4better.de/en/glossary/point-of-interest)): Use higher zoom levels (14-24) to prevent clutter.

**Regional data** (Demographics, Boundaries): Use intermediate levels (8-16) for context.

**Background layers** (Roads, Water): Use the full range for consistent reference.

**Summary data** (Heat maps, Aggregated): Use lower levels (up to 14) for overview.

**Labels**: Show them from a higher zoom level than the features themselves, so they appear once there is room for them.

:::tip Pro Tip
Test your settings by zooming in and out to see how layers appear at different scales.
:::

:::info Related features
Explore other [Layer styling](../../category/style) options and combine them with [Filters](../filter) for advanced data presentation.
:::
