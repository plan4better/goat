---
description: "Set fill and stroke color, opacity, stroke width, line patterns and arrows, point clustering, custom markers and point size, and copy styles between layers."
sidebar_position: 1
---

# Basic styling

**Layer styling allows you to customize the visual appearance of your data to create clear, appealing maps.** GOAT automatically assigns default styles based on your data type (points, lines, or polygons), but you can customize colors, strokes, opacity, and other visual properties.

<iframe width="100%" height="500" src="https://www.youtube.com/embed/R7nefHqPnBk?si=KWndAFlcb2uuC7CZ" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>

## How to style your layers

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Layers</code> panel, click your layer. Its settings panel opens on the right with the tabs <code>Style</code>, <code>Filter</code> and <code>Metadata</code>, and the <code>Style</code> tab selected. The styling options are in the <code>Style</code> section of this tab.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Choose the styling category you want to modify: <code>Fill Color</code> (point and polygon layers), <code>Stroke Color</code> (labelled <code>Color</code> for line layers), <code>Stroke Width</code>, <code>Line style</code> (line layers only), <code>Clustering</code>, <code>Custom Marker</code> and <code>Point Settings</code> (point layers only).</div>
</div>

### Fill color
Fill color defines the interior appearance of point and polygon features.

<div class="step">
  <div class="step-number">3</div>
  <div class="content">
    <p>
     On <code>Color</code> use the <strong>Color Picker to select your color</strong> or the <strong>Preset Colors to choose from the predefined color palette</strong>.
    </p>
  </div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Click the options icon <img src={require('/img/icons/options.png').default} alt="Options Icon" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> next to <code>Fill Color</code> to show its advanced options. Under <code>Opacity</code>, move the slider or enter a value between 0 (transparent) and 1 (opaque) to <strong>control transparency</strong>.</div>
</div>

:::info
<code>Opacity</code> applies to the fill only. <code>Stroke Color</code> has no opacity setting: outlines of points and polygons are always drawn fully opaque. Line layers have no fill, so their <code>Opacity</code> slider is in the advanced options of <code>Color</code>.
:::

### Stroke color
Stroke color applies to the outlines and edges of map features. It helps distinguish features and enhance their visibility.

<div class="step">
  <div class="step-number">5</div>
  <div class="content">  On <code>Color</code> use the <strong>Color Picker</strong> or the <strong>Preset Colors</strong> to <strong>customize stroke appearance</strong>.</div>
</div>

### Stroke width

<div class="step">
  <div class="step-number">6</div>
  <div class="content">  On <code>Stroke Width</code> move the slider to <strong>adjust the thickness</strong> of lines and feature outlines.</div>
</div>

### Line style

The **Line style** section is available for **line layers only** and controls the pattern and decoration of lines.

**Pattern:**

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Under <code>Pattern</code>, choose how the line is drawn: <code>Solid</code>, <code>Dashed</code>, <code>Dotted</code>, or <code>Dash-dot</code>. When a non-solid pattern is selected, a <code>Density</code> dropdown appears with options <code>Tight</code>, <code>Normal</code>, or <code>Loose</code>.</div>
</div>

**Arrows:**

<div class="step">
  <div class="step-number">8</div>
  <div class="content">
  Under <code>Arrows</code>, choose the arrowhead direction: <code>None</code>, <code>Forward</code>, <code>Backward</code>, or <code>Both</code>. When any direction is selected, additional controls appear:
    <ul>
      <li><code>Placement</code>: where the arrows are placed (<code>Repeat along line</code>, <code>Start of line</code>, <code>End of line</code>, <code>Both ends</code>, or <code>Center (one per line)</code>).</li>
      <li><code>Arrow size</code>: slider to control the arrowhead size.</li>
      <li><code>Arrow spacing</code>: slider to control the distance between repeated arrows (only visible when Placement is <code>Repeat along line</code>).</li>
      <li><code>Allow overlap</code>: checkbox to prevent arrows from being hidden when they overlap.</li>
    </ul>
  </div>
</div>

**Advanced Options** (expand to access):

<div class="step">
  <div class="step-number">9</div>
  <div class="content">
  Expand <code>Advanced Options</code> to configure:
    <ul>
      <li><code>Cap</code>: how line endpoints are rendered (<code>Butt</code>, <code>Round</code>, or <code>Square</code>).</li>
      <li><code>Join</code>: how corners between line segments look (<code>Bevel</code>, <code>Round</code>, or <code>Miter</code>).</li>
      <li><code>Offset</code>: shifts the line visually left or right of its actual geometry. Useful for parallel roads or directional lanes. Note: this is a visual shift only. Hit-testing and snapping still use the original geometry.</li>
    </ul>
  </div>
</div>

### Clustering
Clustering groups nearby point features into a single marker with a count, keeping the map readable when many points overlap.

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Enable the <code>Clustering</code> toggle to activate clustering for your point layer.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Use the <code>Cluster radius</code> slider to control how close points need to be to merge into a cluster. A larger radius groups more points together.</div>
</div>

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Optionally, expand <code>Advanced Options</code> to further configure <code>Min cluster size</code>, <code>Max zoom to cluster</code>, <code>Cluster color</code>, and <code>Text color</code>.</div>
</div>

### Custom markers
For point layers, you can use custom markers instead of basic shapes.

<div class="step">
  <div class="step-number">10</div>
  <div class="content">In the styling menu, turn on the <code>Custom Marker</code> toggle to <strong>enable custom markers</strong></div>
</div>

<div class="step">
  <div class="step-number">11</div>
  <div class="content"> Click on <code>Select Marker</code> and <strong>browse the icon library</strong> or <strong>upload your own marker</strong> by clicking on the <code>Custom</code> tab and uploading your file (JPEG, PNG, or SVG format).</div>
</div>

<div class="step">
  <div class="step-number">12</div>
  <div class="content">Name your icon (this name will be used for searching). You can later click on <code>Manage icons</code> to <strong>rename or delete uploaded icons</strong></div>
</div>

<div class="step">
  <div class="step-number">13</div>
  <div class="content">On <code>Size</code> adjust the <strong>marker size</strong> using the slider</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <Video src={require('/img/map/styling/custom_marker.mp4').default} alt="Custom marker selection" style={{ maxHeight: "450px", maxWidth: "auto", objectFit: "cover"}}/>
</div>
<p></p>

:::info
You can only edit the color of icons from the library, not uploaded custom icons.
:::

### Point settings 

<div class="step">
  <div class="step-number">14</div>
  <div class="content">
  Under <code>Point Settings</code>, on <code>Size</code> <strong>adjust the radius</strong> using the slider or enter precise values in the text box for exact control.
  </div>
</div>

### Height {#height}

Polygons and H3 hexagons can stand in the map's [3D view](../../map_interface.md#3d-view) as volumes.

**Polygons.** In the polygon settings, <code>Height</code> sets how tall each polygon stands:

- <code>None</code>: flat, no height.
- <code>Fixed</code>: one height for every polygon, in metres.
- <code>By zoom</code>: the height grows as the map zooms in.
- <code>By attribute</code>: the height from a number field, such as height or levels. Fields named like `height`, `render_height`, `building_height`, `levels`, `building_levels`, `storeys` or `floors` are suggested first. For a field that counts levels, set <code>Unit</code> to <code>Storeys × 3 m</code>.
- <code>By classes</code>: one height per class of a field.

While <code>Height</code> is set, <code>Base height</code> lifts the volume off the ground, for example for a bridge or an upper floor. A raised layer has one opacity for the whole layer and draws no fill pattern; its outline stays on the ground and its labels sit on the roofs. Setting a height while the map is in 2D switches it to 3D.

**H3 hexagons.** <code>Height</code> turns the hexagons into columns as tall as their value. <code>Tallest</code> sets the height of the column with the highest value, and <code>Scale</code> chooses <code>Linear</code> or <code>Square root</code>.

The legend names the height under the layer's colors.

## Copy and paste style

The <code>Style</code> tab of a layer's settings panel has three quick-action icons at the top to manage styles across layers: **Copy Style**, **Paste Style**, and **Set as Default**. This lets you apply a consistent look across multiple layers without reconfiguring each one manually.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Layers</code> panel, click the layer whose style you want to copy. Its settings panel opens with the <code>Style</code> tab selected.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click the <code>Copy Style</code> icon at the top of the tab.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Click the target layer in the <code>Layers</code> panel and click <code>Paste Style</code> at the top of its <code>Style</code> tab to apply the copied style.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Optionally, click <code>Set as Default</code> to save the current style as the default for future uses of this dataset.</div>
</div>

:::tip Smart styling
Explore [attribute-based styling](./attribute_based_styling) for advanced visualization options based on your data values.
:::
