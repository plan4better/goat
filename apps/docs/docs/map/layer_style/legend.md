---
description: "Show or hide a layer's legend, set its title and caption, and choose per classification whether it is in the legend, its heading, unit and number format; class names replace the values."
sidebar_position: 5
---

# Legend

**Legends help users understand the symbology and meaning of your map layers.** GOAT draws the legend of each layer from its style, under the layer's row in the <code>Layers</code> panel. You choose whether it shows, give it a title and a caption, and decide what it contains.

## How to manage a layer's legend

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Layers</code> panel, click your layer. Its settings panel opens on the right with the <code>Style</code> tab selected. The <code>Legend</code> section is near the bottom of this tab.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Use the <code>Show</code> switch to <strong>show or hide the legend</strong>: <code>In the layer list</code> or <code>Hidden</code>. Under <code>Display</code>, <code>Standard</code> shows the layer's colors, classes or symbols, and <code>Name only</code> shows the layer's name without entries, for example for a hillshade, an aerial photo or a long list of categories. With a <code>Title</code> of its own, <code>Name only</code> shows that title under the layer's name, in the layer list, a dashboard's <code>Layers</code> widget and a print layout.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Under <code>Title</code>, type the legend's title. Left empty, the legend uses the layer's name.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Click <code>Contents</code>. The editor opens with the legend as it will look at the top, and below it the settings of what it contains.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Under <code>Caption</code>, add a line <strong>explaining the layer's content</strong>, for example its source. The caption appears under the layer's name in the legend.</div>
</div>

## What the legend contains

A layer without classes shows one swatch. Each classification (see [By classes](./style/attribute_based_styling.md#by-classes)) adds a section with one entry per class. <code>Other</code> and <code>No data</code> follow when the data has such features: values that no class lists, or features without a value in the field. Two classifications of the same field with the same classes, for example a size and a color, share one section whose entries show both. A color or size [by attribute](./style/attribute_based_styling.md#by-attribute) shows as a ramp or as samples with the ends of its range, under the field's name. Rules show their name and a swatch of what they change; in a layer without classes, <code>Other features</code> follows them for everything no rule matches. The values of a yes/no field read <code>Yes</code> and <code>No</code>.

The legend lists what the map draws:

- A class hidden with the eye and a rule that hides features have no entry.
- A classification that changes only what a swatch does not show (a label, a symbol's rotation, offset or anchor, a line's offset, blur, cap or join, the outline's position, the base height of raised features or the arrows' size) has no section of its own. Its classes hidden with the eye still hide their features, on the map and in the legend.
- A layer drawn as <code>Heatmap</code> shows a ramp from <code>Low</code> to <code>High</code>, and one drawn as <code>H3 hexagons</code> the classes or the ramp of the hexagons. With <code>Points</code> set to <code>From zoom</code> and a zoom level, the legend changes to the classes of the points from that zoom on.
- A layer drawn as <code>Clusters</code> lists <code>Clusters</code> first, as long as the map still clusters at the current zoom, then the single points: their classes, or in a layer without classes <code>Single points</code>.
- Colors that change with the zoom follow the map. Symbol sizes do not: every symbol keeps one size in the legend, so the legend does not move while you zoom. Only classes by size are drawn at different sizes, in proportion to each other. A size that follows a field and grows with the zoom shows its samples at the sizes the map draws halfway between its first and last stop.
- A name too long for its row is cut. Hover it to read it in full.
- In the layer list and a dashboard's <code>Layers</code> widget, a section of more than 12 entries shows its first 10 and <code>Show N more</code>. A print layout lists every entry.
- The swatch beside a layer's name, for example in the layer list and the style panel, shows the layer's symbol. Where its color comes from classes, it shows up to four of the classes side by side, each in its own colors (a hollow marker on its outline), and a layer drawn as <code>Heatmap</code> or <code>H3 hexagons</code> shows them at the zoom levels where the map draws its points.

In <code>Contents</code>, each classification has these settings:

- <code>In legend</code>: off leaves the classification out of the legend.
- <code>Heading</code>: the title of its section. It defaults to the field's name. On the result of a tool, GOAT writes it when the tool runs, in the language you use GOAT in, and it stays as written when someone with another language opens the layer.
- <code>Unit</code>: a unit after number values, such as km². Names take no unit.
- <code>Numbers</code> (number fields): how the class bounds read, with <code>Decimals</code>, <code>Thousands</code>, <code>Abbreviate</code>, <code>Sign</code>, <code>Prefix</code> and <code>Suffix</code>. <code>As in the dataset</code> keeps the dataset's own format. Without <code>Decimals</code> of their own, the bounds keep that format, unless a class would read the same number on both ends: then they take as many decimals as tell its bounds apart.
- <code>Order</code> (with several classifications): the place of the classification. It is also the order in which they apply: where two set the same property, the later one wins.

For a raster, <code>Contents</code> also has <code>Unit</code>: a unit after the numbers in the legend, at the ends of a ramp, in class bounds and after category values, such as m or dB(A). A raster drawn as a ramp without classes or categories also has <code>Lowest label</code> and <code>Highest label</code>, which replace the end values of the ramp. For a raster with classes or categories, the <code>Contents</code> row shows how many it has, for example <code>5 classes</code>; for a ramp, what its ends read, for example <code>Color ramp, 32 to 119 m</code>. The unit can also be set in the raster's <code>Popup</code> section: it is one value for the legend and the popup.

While the legend settings differ from the dataset's style, the header of the editor shows <code>Reset to the dataset's style</code> (a circular arrow), which puts them back as the dataset's style has them.

## Which classes the legend lists

In a layer with classes, <code>Contents</code> has <code>Classes shown</code>. It decides which classes the legend lists, everywhere it shows: in the <code>Layers</code> panel, in the legend at the top of <code>Contents</code>, in print layouts, in dashboards and on public maps.

- <code>All</code>: every class.
- <code>Kept by the filter</code> (the default): only the classes that still have features under the layer's [filter](../filter.md). A layer without a filter lists every class. GOAT counts the classes again each time the filter changes.
- <code>In view</code>: only the classes drawn in the current map view. The legend updates once the map stops moving, not while you pan or zoom. In a print layout, the legend counts the classes in the extent of the map it is connected to; a legend without a connected map lists every class.

<code>Other</code> and <code>No data</code> follow the same rule, and a classification left without classes has no section. When no class is left at all, the legend says <code>None in view</code> or <code>None kept by the filter</code>. Color ramps, size samples and heights do not change. While the classes are being counted, the legend shows grey placeholder rows in their place, and a print waits for the count; if the count fails, the legend lists every class.

## Custom labels for classes

Each class is listed with its values or range, for example <code>2,800 to 3,600</code>. To show a label such as <code>Low</code>, <code>Medium</code> or <code>High</code> instead, name the class:

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Open the classification, for example by clicking the <code>Color</code> row of the <code>Fill</code> editor while it is set <code>By classes</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">In the class list, type the label in the name of the class. Its placeholder shows the default text; leave it empty to keep it.</div>
</div>

Changes show in the legend at once; there is nothing to apply. For a ramp [by attribute](./style/attribute_based_styling.md#by-attribute), <code>Legend title</code> in its editor names the ramp. A rule appears under its <code>Name</code>; switch off its <code>In legend</code> to leave it out.

## Best practices

- **Use clear, descriptive titles and captions** that explain what the layer represents.
- **Name the classes** when their values or ranges say little to the reader.
- **Hide the legend** of layers that don't need explanation, such as reference layers.
- **Leave rules out of the legend** when they only change the zooms of features. A rule that hides features has no legend entry.
