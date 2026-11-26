---
description: "Open a layer's style panel, keep several named styles per layer, and set the fill, outline, line, icon and size of points, lines and polygons, or draw points as a heatmap, clusters or H3 hexagons."
sidebar_position: 1
---

# Basic styling

**The style panel sets how a layer looks on the map.** GOAT gives every new layer a style that fits its data (points, lines, polygons or a raster). In the panel you change colors, widths and symbols, keep several styles per layer and switch between them. Every change shows on the map at once and is saved automatically.

## Open the style panel

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Layers</code> panel, click your layer. Its settings panel opens on the right with the tabs <code>Style</code>, <code>Filter</code> and <code>Metadata</code>, and the <code>Style</code> tab selected. A raster layer has the tabs <code>Style</code> and <code>Metadata</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">The header shows the layer's name, a dot in its main color and what it holds, for example <code>Points · 1,250 features</code>. Below it, the styles row shows the name of the active style (see <a href="#named-styles">Named styles</a>), whether your changes are saved, and the buttons <code>Undo (Ctrl+Z)</code> and <code>Redo (Ctrl+Shift+Z)</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Below the styles row are the sections of the panel. Click a row to open its editor next to the panel, and change the values there. The map follows each change.</div>
</div>

:::info Saving
There is no save button. A check mark in the styles row means <code>Saved</code>; while a change is on its way it says <code>Saving…</code>. Without a connection the panel says <code>Offline, changes are kept while this page is open</code> and saves once the connection is back. If someone else changed the same style in the meantime, the panel says <code>Someone changed this style meanwhile.</code> and offers <code>Apply my changes</code> or <code>Discard my changes</code>.
:::

## How the panel works

The sections of a vector layer, from top to bottom:

| Section | What it holds |
| ------- | ------------- |
| <code>General</code> | Point layers only: <code>Draw as</code>, see [How points are drawn](#how-points-are-drawn). |
| <code>Heatmap</code>, <code>Clusters</code> or <code>H3 hexagons</code> | The settings of the drawing chosen in <code>Draw as</code>. |
| <code>Polygons</code>, <code>Lines</code> or <code>Points</code> | The symbol: one row per part, such as <code>Fill</code>, <code>Outline</code> or <code>Label</code>. |
| <code>Rules</code> | Conditions on fields and what they change, see [Rules](./attribute_based_styling.md#rules). |
| <code>Layer</code> | <code>Opacity</code>, <code>Blend</code>, <code>Visible</code>, <code>Draw order</code>, <code>Position</code> and <code>Time</code>, see [Layer settings](#layer-settings). |
| <code>Legend</code> | See [Legend](../legend.md). |
| <code>Popup</code> | See [Popup](../popup.md). |

**Editors.** A row shows a summary of its part, such as a color swatch and a width. Clicking it opens the part's editor to the left of the panel. Some rows inside an editor open a further editor next to it, for example a color picker or the editor of a value that changes by zoom. Press `Esc` to close the last one. Before its swatches, the color picker offers <code>Auto</code> where GOAT can derive the color from the layer (an outline, a casing, a label's text and halo, an icon's color, a cluster's number), and for most colors <code>None</code>, which draws nothing and keeps the color's hue. A bar and the percent beside the color value make the color itself transparent, from 100% (opaque) down to 0% (<code>None</code>). A color's transparency and the part's <code>Opacity</code> are separate settings and multiply. The sliders of widths (line, outline, casing and the halo of labels) move by half a pixel. Number boxes take decimals as written in your language, for example <code>1.5</code>, or <code>1,5</code> in German.

**How a value is set.** To the right of many rows sits a small button with an icon and an arrow. It shows how the value is set and lets you change that: <code>Fixed</code> (one value everywhere), <code>By zoom</code>, <code>By attribute</code>, <code>Field values</code> or <code>By classes</code>. The menu lists only what the property allows. See [Attribute-based styling](./attribute_based_styling.md).

**Switching parts on and off.** Parts you can do without, such as <code>Outline</code>, <code>Casing</code>, <code>Arrows</code>, <code>Label</code> or <code>Icon</code>, have a switch in the header of their editor. A part that is off shows <code>None</code> in its row. The <code>Icon</code> switch and the points' <code>Fill</code> switch change the marker instead, and their rows show <code>None</code> too. Switching it on again brings back its last settings.

**Back to the dataset's style.** While a part differs from the dataset's default style, its editor header shows the button <code>Reset to the dataset's style</code> (a circular arrow). It puts that part back as the dataset's style has it, classes included. <code>Undo</code> takes it back.

**Zoom range of a part.** Each part's editor ends with <code>Visible</code>: the zooms at which this part is drawn, within the zooms of the layer. See [Zoom visibility](../zoom.md).

## Polygons

The <code>Polygons</code> section has the rows <code>Fill</code>, <code>Outline</code>, <code>Height</code>, <code>Marker</code> and <code>Label</code>.

- <code>Fill</code>: <code>Color</code>, <code>Opacity</code> and <code>Pattern</code>. <code>Pattern</code> opens the patterns: <code>None</code>, <code>Diagonal lines</code>, <code>Diagonal lines, other way</code>, <code>Vertical lines</code>, <code>Horizontal lines</code>, <code>Crosshatch</code>, <code>Grid</code> and <code>Dots</code>. With a pattern, set its <code>Line color</code> (<code>Dot color</code> for dots; <code>Same as fill</code> by default), <code>Spacing</code> and <code>Thickness</code> (<code>Dot size</code> for dots). The pattern is drawn over the fill color.
- <code>Outline</code>: <code>Color</code> (a color of its own, <code>Same as fill</code> or <code>Auto</code>, a darker shade of each polygon's fill color that follows it when the fill color changes), <code>Width</code>, <code>Opacity</code>, <code>Dash</code> (<code>Solid</code>, <code>Dashed</code>, <code>Dotted</code> or <code>Dash dot</code>) and <code>Position</code> (<code>On the edge</code>, <code>Inside</code> or <code>Outside</code>). <code>Inside</code> keeps each outline within its own polygon, so the outlines of neighboring polygons do not overlap. A new polygon layer has a 1 px outline in <code>Auto</code>.
- <code>Height</code>: raises the polygons in the 3D view, see [Height](#height).
- <code>Marker</code>: a marker on each polygon, at one point inside it, for example a school icon on the school grounds or a circle sized by the population on each district. See [Markers on polygons and lines](#markers-on-polygons-and-lines).
- <code>Label</code>: text on each polygon, see [Labels](../labels.md).

## Lines

The <code>Lines</code> section has the rows <code>Line</code>, <code>Casing</code>, <code>Arrows</code>, <code>Marker</code> and <code>Label</code>.

- <code>Line</code>: <code>Color</code>, <code>Width</code>, <code>Opacity</code>, <code>Dash</code> (<code>Solid</code>, <code>Dashed</code>, <code>Dotted</code> or <code>Dash dot</code>), <code>Ends</code> (<code>Flat</code>, <code>Round</code> or <code>Square</code>, which extends past the end by half the width), <code>Corners</code> (<code>Sharp</code>, <code>Round</code> or <code>Bevel</code>), <code>Offset</code> and <code>Blur</code>. <code>Offset</code> shifts the line sideways, so both directions of a road show. It moves the drawing only: clicking and snapping still use the line itself.
- <code>Casing</code>: a border along both sides of the line, as roads have on many maps: <code>Color</code> (a color of its own or <code>Auto</code>, a darker shade of the line color), <code>Width</code> (the extra width on each side of the line) and <code>Opacity</code>.
- <code>Arrows</code>: <code>Icon</code>, <code>Turn with the line</code>, <code>Direction</code> (<code>Forward</code>, in the drawing direction of the line, <code>Backward</code> or <code>Both ways</code>), <code>Size</code>, <code>Color</code> (a color of its own or <code>Same as line</code>), <code>Placement</code> (<code>Along the line</code>, <code>In the middle</code>, <code>At the start</code>, <code>At the end</code> or <code>At both ends</code>) and, along the line, <code>Spacing</code>. <code>Icon</code> opens the icon picker: GOAT's <code>Arrow</code> at its top, then <code>Symbols</code>, <code>Emoji</code> and your own icons (<code>Custom</code>), so any icon can repeat along a line, such as a symbol for a railway or a border. With <code>Turn with the line</code> on, the top of the icon points the way the arrow would; off, the icon stays upright, as a tree or a bus symbol should, and <code>Direction</code> is hidden. Picking GOAT's <code>Arrow</code> switches it on, picking any other icon switches it off; you can switch it either way afterwards. One icon applies to the whole layer. Uploaded icons and emoji keep their own colors, so they have no <code>Color</code> row. The legend shows the icon on the line.
- <code>Marker</code>: a marker in the middle of each line, see [Markers on polygons and lines](#markers-on-polygons-and-lines).
- <code>Label</code>: text along or on each line, see [Labels](../labels.md).

### Markers on polygons and lines {#markers-on-polygons-and-lines}

The <code>Marker</code> row of polygons and lines is off until you turn it on with the switch in the header of its editor. Each polygon gets one marker, at the point inside it where its label goes, and each line one in its middle. The editor has the rows of the points' marker: <code>Icon</code> with the shape (see [Icons and marker shapes](#icons-and-marker-shapes)), <code>Color</code>, <code>Icon color</code>, <code>Size</code>, <code>Opacity</code>, <code>Rotation</code>, <code>Offset x</code> and <code>Offset y</code>, <code>Anchor</code> for pins and icons alone, and <code>Overlap</code>. <code>Size</code> and <code>Color</code> can also change [by attribute](./attribute_based_styling.md#by-attribute) or [by classes](./attribute_based_styling.md#by-classes), for circles that grow with a number.

- The marker draws above the polygon or the line and below the labels. A polygon's label and a line's label at its middle take the label positions around the marker, as on points: <code>Automatic</code> moves them beside it, a fixed side keeps them on that side, <code>In the middle</code> puts them on it. See [Labels](../labels.md#position).
- The marker has no outline: the <code>Outline</code> of a polygon is its border.
- To show a marker on some features only, for example an icon on parks, select their class with the class picker at the top of the section and turn <code>Marker</code> on for it. If you turned the marker on and off again for all features, it stays off in every class, and its row reads <code>Off for all</code> while a class is selected; the class editor then offers <code>Allow per class</code>, which keeps the marker off for all features but lets classes turn it on. A marker never turned on needs no such step.
- In the legend, the swatch shows the polygon or the line with its marker. Markers whose size changes show on their own, as for points.

## Points

The <code>Points</code> section has the rows <code>Size</code>, <code>Fill</code>, <code>Outline</code>, <code>Icon</code> and <code>Label</code>.

- <code>Size</code>: the size of the marker in px, set with the slider right in the section.
- <code>Fill</code>: <code>Color</code> and <code>Opacity</code> of the marker, and for a plain circle <code>Offset x</code> and <code>Offset y</code>. With the switch in the header off, the markers are drawn hollow: only their outline and icon show. If they have neither, the row warns <code>Markers are invisible: turn on the outline or add an icon.</code>
- <code>Outline</code>: <code>Color</code> (a color of its own, <code>Same as fill</code> or <code>Auto</code>, a darker shade of the marker color), <code>Width</code> and <code>Opacity</code>.
- <code>Icon</code>: the symbol on the marker. The switch in the header takes the icon off, and the points are drawn as plain circles again; switched on, your last icon and shape come back.
- <code>Label</code>: text next to each point, see [Labels](../labels.md).

### Icons and marker shapes {#icons-and-marker-shapes}

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Points</code> section, click <code>Icon</code> and make sure the switch in the editor's header is on.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click the <code>Icon</code> row. The icon picker opens with the tabs <code>Symbols</code>, <code>Emoji</code> and <code>Custom</code>, each with its own search. Click an icon to use it.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">At the top of the picker, <code>Shape</code> sets the marker the icon sits on: <code>Circle</code>, <code>Square</code>, <code>Diamond</code>, <code>Hexagon</code>, <code>Shield</code>, one of the <code>Pins</code> (<code>Pin</code>, <code>Round pin</code>, <code>Needle</code>, <code>Square pin</code>, <code>Tag pin</code> or <code>Flag</code>), or <code>Icon alone</code> without a marker.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Back in the <code>Icon</code> editor, set <code>Icon color</code> (<code>Color</code> for an icon alone; on a marker, a new icon starts with <code>Auto</code>: white or dark, whichever reads on the marker's color), <code>Rotation</code>, <code>Offset x</code> and <code>Offset y</code>. For an icon alone or a pin, <code>Anchor</code> sets which point of the icon sits on the location: <code>Center</code>, <code>Bottom</code> (the tip, as for pins) or another side or corner. <code>Overlap</code> on draws the markers even where they overlap other symbols. Uploaded icons and emoji keep their own colors, so they have no color to set.</div>
</div>

To use your own icon, open the <code>Custom</code> tab and drop an image on it or click the upload field to choose one (SVG, PNG, JPEG, WebP, BMP or ICO, square, with a transparent background, up to 4 MB). It uploads at once, named after the file, and becomes the layer's icon. Your icons are listed under <code>Your icons</code>, where <code>Upload</code> adds another; click <code>Manage</code> to rename or delete them. Layers that use a deleted icon show no icon, so GOAT asks before deleting.

:::tip
To give each category its own icon, set the icon <code>By classes</code> of a field. See [Attribute-based styling](./attribute_based_styling.md).
:::

## How points are drawn {#how-points-are-drawn}

For a point layer, the <code>General</code> section sets <code>Draw as</code>:

| Option | What it draws |
| ------ | ------------- |
| <code>Points</code> | Each feature as its own symbol (the default). |
| <code>Heatmap</code> | The density of the points as a color surface. |
| <code>Clusters</code> | Nearby points merge into circles with a count. |
| <code>H3 hexagons</code> | The points counted or summed per hexagon, computed on the server. |

**Heatmap.** The <code>Heatmap</code> section has <code>Colors</code> (the palette and its colors), <code>Radius</code>, <code>Intensity</code> (a factor from 0.2 to 3, 1 by default), <code>Opacity</code> and <code>Weight</code>: <code>Each point counts once</code> or <code>By</code> a number field, with the field's <code>Range</code>. <code>Points</code> sets whether the single points show too: <code>Never, density only</code> while the switch in its editor is off, else from the zoom you set on its slider, 0 to 24. While they never show, the <code>Points</code>, <code>Rules</code> and <code>Popup</code> sections are hidden.

**Clusters.** The <code>Clusters</code> section has <code>Look</code> (<code>Circle</code>, or <code>Like the points</code>: each cluster shows the points' own marker, a size or color by a field at the middle of its range or palette; with icons or colors by category, those of the category most of its points have; the first 12 categories are counted, points of the others count as other values), <code>Count</code> (<code>In the middle</code>, or <code>Top right</code> on a small circle at the marker's upper right, ringed in white), <code>Value</code> (<code>Number of points</code>, or the sum, mean, minimum or maximum of a number field: the number shown and what the circles grow with), <code>Color</code> (the circles or the small circle), <code>Number color</code> (<code>Auto</code> for new clusters: white or dark, whichever reads on the circle), <code>Size</code> (circles only: the smallest and the largest circle; a cluster's circle grows with its number of points or its value; for a value of a field, its editor also has <code>Range</code>: the values the smallest and the largest circle stand for, starting at the field's range, for a sum up to ten times its highest value), <code>Merge distance</code> (how close points must be to merge, in pixels on the screen), <code>Until</code> (the zoom up to which points are clustered, set on a slider from 0 to 24) and <code>Smallest</code> (the fewest points a cluster takes, 2 to 20). The single points keep the look set in the <code>Points</code> section. A layer whose points draw an icon or a shape other than a plain circle starts its clusters like the points, with the count at the top right. Large numbers are shortened, for example 1.2 k for 1,234. Clusters are computed in the browser and work for layers with up to 100,000 features; for larger layers, use a heatmap or H3 hexagons.

**H3 hexagons.** The <code>H3 hexagons</code> section has <code>Size</code> (<code>Automatic</code>, with smaller hexagons as you zoom in, or a fixed resolution), <code>Value</code> (<code>Number of points</code>, or the sum or mean of a number field), <code>Colors</code>, <code>Opacity</code>, <code>Height</code>, <code>Outline</code> (its color and width) and <code>Points</code> (<code>Never, hexagons only</code> while the switch in its editor is off, else from the zoom you set on its slider, 0 to 24). Click <code>Colors</code> to choose the palette, to set <code>Classes</code> (<code>Continuous</code> or a classification method, with <code>Count</code>) and to edit the colors of a continuous palette. Hexagons have no outline until you click <code>Outline</code> and switch it on; it starts white and 1 px wide.

### Height {#height}

Polygons and H3 hexagons can stand in the map's [3D view](../../map_interface.md#3d-view) as volumes.

**Polygons.** In the <code>Polygons</code> section, click <code>Height</code>. The switch in the editor's header raises the polygons or lays them flat. In the editor, <code>Top</code> sets how tall each polygon stands; its button chooses how:

- <code>None</code>: flat, no height.
- <code>Fixed</code>: one height for every polygon, in metres.
- <code>By zoom</code>: the height grows as the map zooms in.
- <code>By attribute</code>: the height in proportion to a number field, such as density. The editor <code>Height by attribute</code> opens: choose the <code>Field</code>, the heights in metres at its lowest and highest values (<code>Smallest</code>, <code>Largest</code>) and the <code>Scale</code>, as described in [Attribute-based styling](./attribute_based_styling.md#by-attribute).
- <code>Field values</code>: the heights a number field holds, such as height or levels. Fields named like `height`, `render_height`, `building_height`, `levels`, `building_levels`, `storeys` or `floors` are listed first under <code>Suggested for height</code>. For a field that counts levels, set <code>Unit</code> to <code>Storeys × 3 m</code>.
- <code>By classes</code>: one height per class of a field.

While a height is set, <code>Bottom</code> sets the base height in the same ways but <code>None</code>: <code>Fixed</code>, <code>By zoom</code>, <code>By attribute</code>, <code>Field values</code> (such as a field `min_height`) or <code>By classes</code>. It lifts the volume off the ground, for example for a bridge or an upper floor. A raised layer has one opacity for the whole layer and draws no fill pattern; its outline stays on the ground and its labels sit on the roofs. Setting a height while the map is in 2D switches it to 3D; if you go back to 2D, the row says <code>Viewing in 2D.</code> with the link <code>Show in 3D</code>.

**H3 hexagons.** In the <code>H3 hexagons</code> section, click <code>Height</code> and switch it on: the hexagons become columns as tall as their value. <code>Tallest</code> sets the height of the column with the highest value, <code>Base height</code> lifts the columns, and <code>Scale</code> chooses <code>Linear</code> or <code>Square root</code>. Columns draw no outline.

The legend names the height under the layer's colors.

## Layer settings {#layer-settings}

The <code>Layer</code> section holds what applies to the whole layer:

- <code>Opacity</code>: the opacity of the whole layer.
- <code>Blend</code>: how the layer's colors mix with what is drawn below it, the basemap and the layers under it. <code>Normal</code> covers what is below. <code>Multiply</code> darkens, so the streets and names below stay visible; white in the layer changes nothing, so a white outline or casing disappears. <code>Screen</code> lightens and is meant for dark basemaps; black in the layer changes nothing. <code>Overlay</code> strengthens the contrast of what is below. <code>Color</code> takes the layer's hue and keeps the brightness below. <code>Luminosity</code> takes the layer's brightness and keeps the colors below, so an aerial image or a grey relief image above colored areas gives them light and shade. <code>Add</code> adds light, so the layer glows on a dark basemap or a darkened image, and where layers in <code>Add</code> overlap, their light adds up to white. <code>Opacity</code> sets how far the mix goes. With <code>Position</code> at <code>Below the basemap's labels</code>, the basemap's names stay untouched. With 3D <code>Terrain</code>, a blended layer mixes only with the areas, lines and images drawn directly below it: a layer of points, labels or heights in between ends that, and the layer then draws as with <code>Normal</code>. If a blended layer stops mixing with the basemap in 3D, set <code>Position</code> to <code>Below the basemap's labels</code> and keep point layers above the blended layer. Markers, labels and arrows draw normally. The row is not there for points drawn as <code>Points</code>, <code>Heatmap</code> or <code>Clusters</code>. For <code>H3 hexagons</code> with a height it cannot be changed and says <code>Columns draw without blending.</code>; for polygons with a height it says <code>Heights draw without blending; the outline blends.</code> On a dark basemap, <code>Multiply</code> adds the note <code>On a dark basemap, Multiply draws the colors very dark. Screen lightens instead.</code>, and on a light basemap, <code>Add</code> adds the note <code>On a light basemap this turns light colors white.</code>, unless the row already shows a note of its own.
- <code>Visible</code>: the zooms at which the layer is drawn, see [Zoom visibility](../zoom.md).
- <code>Draw order</code>: which features are drawn on top: <code>As in the data</code>, <code>First class on top</code> (with classes, see [Attribute-based styling](./attribute_based_styling.md)), or the smallest or largest values of a number field on top.
- <code>Position</code>: where the layer is drawn among the basemap's layers: <code>On top</code>, <code>Below the basemap's labels</code> or <code>Below the basemap's roads</code>. The position belongs to the layer in this project, not to the style, so it stays when you switch styles or basemaps.
- <code>Time</code>: adds a time slider under the layer's row in the <code>Layers</code> panel. The options name the field: a whole-number field such as `year` steps one value at a time (<code>One year at a time</code>), a date field by year, month or day (for example <code>date by month</code>). The slider shows the features of one step at a time and starts at the latest one. <code>Off</code> removes it.

## Named styles {#named-styles}

A layer can keep up to 10 named styles, for example one by population and one by building age. One of them is active: the map draws it and the panel edits it.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the styles row at the top of the <code>Style</code> tab, click the name of the active style. <code>Styles</code> opens next to the panel with the layer's styles; the active one is marked with a check.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click a style to make it the active one. Click <code>New style</code> to add one: it becomes active, ready for its name.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Double-click a style to rename it, or open its menu (<code>More options</code>, the three dots) for <code>Rename</code>, <code>Duplicate</code>, <code>Move up</code>, <code>Move down</code>, <code>Set as dataset default</code>, <code>Reset to the dataset's style</code> (for the active style, while it differs from the dataset's) and <code>Delete</code>. The last style of a layer cannot be deleted.</div>
</div>

**The dataset's default style.** A dataset has a default style of its own: a layer's first style in a project is a copy of it, and <code>Reset to the dataset's style</code> goes back to it. <code>Set as dataset default</code> makes a copy of a style the dataset's default. It is offered to project editors who may edit the dataset, and never for catalog layers. A style that matches the dataset's default says <code>Dataset default</code> in the list.

**Copy a style to another layer.** At the bottom of <code>Styles</code>, click <code>Copy style</code>. Then open the other layer and click <code>Paste style</code> there: the copied style replaces the active style of that layer, and <code>Undo</code> takes it back. Styles can be pasted on layers of the same kind and geometry only, for example from one polygon layer to another.

:::info Viewers of a published map
In a published project, viewers can switch between a layer's styles in its settings (<code>Style</code>). Their choice is not saved.
:::

## Raster layers and map services

A raster file has the sections <code>General</code>, a section for its colors, <code>Layer</code>, <code>Legend</code> and <code>Popup</code>.

- <code>General</code>: <code>Draw as</code> <code>Hillshade</code> (shaded relief from elevation), <code>Color range</code> (a palette over the cell values), <code>Categories</code> (one color per cell value) or <code>Image</code> (as stored). With several bands, choose the <code>Band</code> (for a hillshade, the band it shades, such as the terrain model beside a surface model in one file), or for an image the <code>Combination</code>: <code>True color</code>, <code>False color</code> or <code>Custom</code>. For a color range or a hillshade, <code>Band</code> also offers band math: <code>NDVI</code> (vegetation), <code>NDMI</code> (moisture) and <code>NDWI</code> (water) compute an index from two bands, which the rows under it name (<code>NIR</code>, <code>Red</code>, <code>Green</code>, <code>SWIR 1</code>). GOAT fills them in where the file marks or names its bands (<code>NIR</code> or <code>Red</code>, for example, or Sentinel-2's codes <code>B4</code> and <code>B8</code> in a file that also has <code>B8A</code> or <code>B12</code>), else you pick them, and a new index starts as a color range from -1 to 1 (the same for every image, so indices compare) in a palette centred on 0. <code>Formula</code> takes your own calculation from <code>b1</code>, <code>b2</code>, ... (the bands), numbers, <code>+ - * /</code> and brackets, such as <code>(b1 - b2) / (b1 + b2)</code>: the note under the box says what is wrong while you type, the formula applies when you leave the box or press Enter, and its range starts from its values. <code>Band</code> then shows the index with its bands (<code>NDVI (B8, B4)</code>) or the formula, and the popup names the value by it; picking a band from the menu replaces it. On a file of one band, <code>Band</code> offers the band and <code>Formula</code>; the indices need two bands. An image as stored uses the file's own color table (GOAT draws such a map from its cell values in the table's colors, so its popup can show the value of every cell, also where two values share a color; <code>Adjustments</code> change those colors as they change any image); without one, <code>True color</code> draws the bands the file marks as red, green and blue, else its first three bands.
- The colors, in a section named after what the layer draws (<code>Color range</code>, <code>Hillshade</code> or <code>Categories</code>): for a color range, <code>Colors</code> opens the colors editor, with a <code>Palette over a range</code> or <code>Colors at values</code>. A palette is <code>Continuous</code> or in <code>Classes</code> by a <code>Method</code>, as a vector layer's classes: <code>Equal intervals</code> split the range, <code>Quantiles</code>, <code>Natural breaks</code>, <code>Standard deviation</code> and <code>Geometric intervals</code> classify the band's values (GOAT computes them when it reads the file, a band formula's when the formula is set, so a method or number of classes shows at once; <code>Geometric intervals</code> need a band whose values all lie above 0), and <code>Manual breaks</code> start as equal classes whose bounds you type. For a continuous palette, its colors are listed at the bottom of the colors editor, under <code>Outside</code>, in the order they draw, as a class list (<code>Color</code> and <code>Value</code>): each row shows a color and the value where it sits on the range, with the legend's unit; click its swatch to change it, point at a row (or reach it with the keyboard) for its plus, which adds a copy of its color after it (up to 12 colors), and its bin, which removes its color (while more than two are left), drag a row to move it (or move it one place with Alt and the up or down arrow while one of its controls has the focus), and <code>Add a color</code> adds one at the end. The colors spread evenly over the range, and the histogram and the map follow. The first change turns the palette into your own colors (2 to 12; a reversed palette keeps the order it draws in); picking a palette again replaces them. Classes have no such list: their rows are the colors to edit, and <code>Palette</code> recolors them all. <code>Colors at values</code> keeps its own editor. <code>Classes</code> offers 3 to 13 classes for the computed methods and 2 to 13 for equal intervals and manual breaks. On a band of whole numbers (an 8 or 16 bit band, for example), the computed breaks are whole numbers too; breaks that would round to the same number are kept once, so there can be fewer classes. When a color range or categories color one band of an image, a line under <code>Band</code> says which of its channels (red, green or blue) the band is. <code>From the data</code> sets the range to the band's 2nd to 98th percentile. With classes, a range you type applies when you leave the box or press Enter; a continuous palette follows the digits as you type them. The band's histogram shows under it, with the ends of the range as solid lines and the class breaks as dashed lines, its lowest and highest value written as the range boxes write them. Drag an end or a break along the histogram, or click it and use the arrow keys (with Shift ten steps at a time): an end changes the range as typing it does, and a break turns the classes into <code>Manual breaks</code> and keeps the other breaks. A break stays a step inside the histogram's bars (with <code>Transparent</code>, inside the range); on a band of whole numbers the handles move by whole numbers. The classes are listed with their color, range, name and <code>Share</code> of the band's cells, each with an eye to hide it. <code>Outside</code> sets what the cells beyond the range, the first and last of your colors or the classes draw: <code>End colors</code> draws them in the first or last color, <code>Transparent</code> leaves them out (styles from before GOAT Style leave them out, as GOAT did then). With classes and <code>Transparent</code>, <code>Range</code> shows where the first class starts and the last class ends (at first the range, or the band's lowest and highest value), the histogram greys out the values beyond, and the legend and the class names read those ends; typing one of them (it applies when you leave the box or press Enter) turns computed classes into <code>Manual breaks</code> and keeps the breaks between them, while <code>Equal intervals</code> split the new range again. For categories, <code>Colors</code> sums up what they show (<code>All 238 categories</code>, <code>Top 10</code>) with their colors and opens their editor, as a vector layer's classes open theirs. Switching to <code>Categories</code> gives one class per value the band holds: a file with a color table gets every value in use in the table's colors, by value; a file without one gets every value (up to 256, a full 8-bit band), most common first, and a band with more values its 50 most common, the rest in one <code>Other values</code> row. In the editor, <code>Classes</code> shows all values or the 10, 20, 30 or 50 most common. <code>Order</code> sorts the classes most common first, by value or by name; drag a class to another's place to move it (or move it one place with Alt and the up or down arrow while one of its controls has the focus), the legend follows the order. Another number under <code>Classes</code> keeps an order by value or by name; classes in your own order are listed most common first again. Each class has its color, its name (click it to rename it, change its value or remove it), its share and an eye; the <code>Other values</code> row has the color and share of the values without a class, and its eye draws them or leaves them out. A list longer than 10 classes shows <code>Show N more</code> in the editor; the layer list's legend shows its first 10 entries and <code>Show N more</code> once it has more than 12. <code>Add class</code> lists the values that have no class yet, with their share; for a hillshade, its <code>Method</code>, <code>Light from</code>, <code>Light height</code>, <code>Strength</code>, the colors of <code>Shadow</code>, <code>Highlight</code> and <code>Accent</code>, and <code>Colors</code> under the shading. Flat terrain is raised before it is shaded, so lowland elevation data shows its relief too; <code>Strength</code> works on top of that, and when the terrain is raised, the note under it says by how much.
- <code>Layer</code>: <code>Opacity</code>, <code>Blend</code> (for an image, as for vector layers, see [Layer settings](#layer-settings); for a color range, categories, an image in its file's own colors and a hillshade it cannot be changed and says <code>Colors from values draw without blending.</code> or <code>Shading draws without blending.</code>), <code>Resampling</code> (<code>Smooth</code> or <code>Nearest</code>; categories and an image in its file's own colors always stay sharp, since cell values are never smoothed, so the row shows <code>Nearest</code> and cannot be changed), <code>Adjustments</code> for an image (<code>Brightness</code>, <code>Contrast</code>, <code>Saturation</code>, <code>Hue</code>), <code>No data</code> (cell values drawn transparent; pick one on the map; while the box is empty, the file's own no-data value applies, which the box shows), <code>Visible</code> and <code>Position</code>, as for vector layers (see [Layer settings](#layer-settings)); <code>Below the basemap's labels</code>, for example, keeps place names readable on top of elevation data. A raster layer added with a color range, categories or a hillshade starts <code>Below the basemap's labels</code>. When you switch <code>Draw as</code> from <code>Image</code> to one of them while the layer is <code>On top</code>, the layer stays where it is: the <code>Position</code> row says that the colors hide the basemap's place names and offers <code>Move below labels</code>, which you can take or leave. An image stays on top, and a duplicated layer draws where the original does.
- <code>Popup</code>: <code>Show on</code> <code>Off</code>, <code>On click</code>, <code>Only on hover</code> or <code>On click and on hover</code>; the two hover choices are hidden where the map has no values to read, for most images and where the server colors the cells (see [Popups of raster layers](../popup.md#popups-of-raster-layers)). With several bands, <code>Values</code> shows the <code>Styled values</code> or <code>All bands</code>. For a color range, categories or a hillshade, <code>Unit</code> sets the unit after the value; it is the legend's unit, so it changes in both places.

Color changes show on the map at once; another <code>Band</code>, a band formula or another <code>Resampling</code> loads the raster again, which can take a moment. The rows that need what GOAT reads from the file (<code>Draw as</code>, <code>Colors</code>, <code>No data</code>) wait until it has read the file; a file that cannot be read shows a notice at the top of <code>General</code>.

A map service (WMS, WMTS or XYZ) sends finished pictures: it is drawn as an image, in one of the styles the service offers (<code>Service style</code> in <code>General</code>, when there is a choice). Its <code>Layer</code> section has <code>Opacity</code>, <code>Blend</code>, <code>Resampling</code>, <code>Adjustments</code>, <code>Visible</code> and <code>Position</code>, and its legend shows the service's own legend image when it has one.

:::tip Smart styling
Explore [attribute-based styling](./attribute_based_styling.md) to style features by their data values, by zoom or with rules.
:::
