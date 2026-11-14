---
description: "Style colors, sizes, widths and icons by a data field, by zoom or by classes with palettes and classification methods such as quantiles or manual breaks, style one class on its own and change matching features with rules."
sidebar_position: 2
---

# Attribute-based styling

**You can style a layer by its data to show differences and trends at a glance.** Almost every color, size, width and icon in the style panel can follow a field, change with the zoom, or take one value per class of a field. Rules change the features that match a condition.

## How a value is set

To the right of a property in the style panel sits a small button with an icon and an arrow. It shows how the value is set. Click it to choose another way:

| Option | What it does |
| ------ | ------------ |
| <code>Fixed</code> | One value everywhere. |
| <code>By zoom</code> | The value changes as the map zooms in and out, or switches at the zoom levels you set. See [By zoom](#by-zoom). |
| <code>By attribute</code> | A color ramp over a number field, or a size in proportion to a number field. See [By attribute](#by-attribute). |
| <code>Field values</code> | Uses the field's value as it is: a text field that holds colors such as `#2166ac`, or a number field for the <code>Rotation</code> of icons or a <code>Height</code>. |
| <code>By classes</code> | One value per category or range of a field. See [By classes](#by-classes). |

The menu lists only the options the property allows. <code>Field values</code> appears for colors only when the layer has a text field that holds colors. While you [style one class](#style-one-class), the menu adds <code>Reset</code>, which gives the class the value of all features again.

When you choose an option, its editor opens next to the panel. Afterwards the row shows a summary, such as a color ramp, <code>By zoom · 3 stops</code> or the field's name; click the row to open the editor again.

## By attribute

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Open a part of the symbol, for example <code>Fill</code> in the <code>Polygons</code> section, click the button next to <code>Color</code> and choose <code>By attribute</code>. The editor <code>Color by attribute</code> opens.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Under <code>Field</code>, choose the <strong>number field</strong> to style by. The list shows each field's range of values.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">For a color, click <code>Palette</code> and choose a palette (see <a href="#color-palettes">Color palettes</a>). For a size or width, set the <code>Smallest</code> and <code>Largest</code> value it takes.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Under <code>Scale</code>, choose how values map to the colors or sizes: <code>Linear</code> (values map evenly), <code>Square root</code> (sizes grow by area, the usual choice for circles; for colors, more of the palette for the low values) or <code>Logarithmic</code> (for values that span orders of magnitude).</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Set <code>No data</code>: the color or value of features without a value in the field. <code>Legend title</code> names the ramp in the legend; it defaults to the field's name.</div>
</div>

<code>Values</code> shows the range the server computed from the field, for example <code>2 to 97 along the palette</code>. The server computes it again when the data changes. To keep the range fixed, switch on <code>Fixed range</code> and type it under <code>Range</code>; values outside it take the end values.

## By classes

By classes splits the values of one field into classes and gives each class its own value: a color, size, width, pattern or icon.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click the button next to a property, for example <code>Color</code> in the <code>Fill</code> editor, and choose <code>By classes</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Choose the field in the list that opens. Text, number and true/false fields can be used. The classification editor opens, for example <code>Fill color by classes</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Under <code>Method</code>, choose how the classes are formed (see <a href="#data-classification-methods">Data classification methods</a>) and under <code>Classes</code> how many.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">For colors, choose a <code>Palette</code>; for sizes and widths, a <code>Range</code>. For a number field, a histogram shows the values and the class breaks.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Adjust the classes in the class list (see <a href="#the-class-list">The class list</a>).</div>
</div>

Other settings of the classification editor:

- <code>Field</code>: the field the classes are made of. You can change it here.
- <code>Sets</code>: the property the classes set, such as <code>Fill color</code>, <code>Outline width</code> or <code>Icon</code>. A property set by another classification says <code>also set by</code> that field.
- The bin icon in the editor's header (<code>Remove classification</code>) removes the classes; the property takes one value again.

The server computes the classes: while it does, the editor says <code>Computing classes…</code>, and afterwards how many features they were computed from. The classes are computed again when the data changes, except classes you set by hand.

### The class list

Each class has a row with:

- its value: a color swatch, a number, a pattern or an icon. Click it to change it.
- for <code>Manual breaks</code>, its lower bound, from the second class on.
- its name. It defaults to the class's values or range, for example <code>2,800 to 3,600</code>; type a name to show it in the legend instead, such as <code>Low</code> or <code>High</code>.
- the number of features in it.
- an eye button to hide or show the class (<code>Hide this class</code>, <code>Show this class</code>).
- a pencil button, <code>Style this class</code>, which opens the class in the panel: see [Style one class](#style-one-class).

At the end of the list, <code>Other</code> covers values in no class and <code>No data</code> covers features without a value in the field.

**Categories you pick yourself.** With the method <code>Categories</code>, click a class's name to open its values: tick the values that belong in this class, search them, or remove the class. <code>Add class</code> starts a new class (<code>Pick values</code>). As soon as you change the classes by hand, <code>Classes</code> says <code>Picked by hand</code>: new data keeps these classes, and values in no class are drawn as <code>Other</code>.

### Data classification methods {#data-classification-methods}

| Method | How it forms the classes | Use it for |
| ------ | ------------------------ | ---------- |
| <code>Categories</code> | One class per value. | Text and true/false fields, or numbers that are codes. The only method for text and true/false fields. |
| <code>Quantiles</code> | About the same number of features in each class ([Quantile](https://www.plan4better.de/en/glossary/quantile-classification)). | Ranking features; creates uneven value ranges. |
| <code>Equal intervals</code> | Classes of the same width ([Equal Interval](https://www.plan4better.de/en/glossary/equal-interval-classification)). | Evenly spread values; with skewed data some classes may be empty. |
| <code>Natural breaks</code> | Breaks where the values jump (Jenks). | Values that form groups. |
| <code>Standard deviation</code> | Classes around the mean ([Standard Deviation](https://www.plan4better.de/en/glossary/standard-deviation-classification)). | Showing how far features lie from the average; works best with normally distributed data. |
| <code>Head/tail breaks</code> | For values where a few are very large. | Skewed data where the extremes matter. |
| <code>Manual breaks</code> | You type the lower bound of each class. | Thresholds of your own, the same across maps. |

<code>Classes</code> sets how many: from <code>3 classes</code> to <code>9 classes</code> for numbers (5 by default), and <code>All values</code> or the most frequent ones (<code>Top 3</code> to <code>Top 12</code>) for categories.

### Several classifications

A layer can have several classifications, for example the fill color by land use and the outline width by area. They apply in order; where two set the same property, the later one wins. Change their order in the legend's <code>Contents</code> under <code>Order</code> (see [Legend](../legend.md)).

## Style one class {#style-one-class}

A class can get its own fill, outline, icon, label or zoom range with the same controls as the whole layer.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the header of the <code>Polygons</code>, <code>Lines</code> or <code>Points</code> section, click <code>All features</code> (it appears once the layer has classes). The menu <code>Style one class</code> lists the classes of all classifications.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Pick a class. The section says <code>Editing … only. A dot marks what differs from all features.</code> and adds <code>Visible</code>, the class's own zoom range.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Change the rows as usual: the changes apply to this class only. To give a property the value of all features again, choose <code>Reset</code> in its button's menu.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Click <code>All features</code> to go back to editing the whole layer.</div>
</div>

## By zoom

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click the button next to a property and choose <code>By zoom</code>. The editor opens with a chart: the zoom levels from left to right, the value at each stop, and a pointer at the current zoom of the map. Zooms at which the layer is hidden are shaded.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click a stop to select it, click anywhere else in the chart to add one, and drag a stop to move it. For the selected stop, set its zoom under <code>Stop</code> and its <code>Value</code>; with more than two stops, the bin icon next to <code>Stop</code> removes it.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Under <code>Transition</code>, choose how the value changes between stops: <code>Linear</code>, <code>Smooth</code> (slow at first, faster towards the next stop) or <code>Steps</code> (jumps to the next value at each stop). Values such as a dash or an icon always switch at each stop.</div>
</div>

## Color palettes {#color-palettes}

The palette picker opens from <code>Palette</code> or <code>Colors</code>. It shows GOAT's palettes by kind (<code>All</code>, <code>Sequential</code>, <code>Diverging</code> and <code>Categories</code>), the palettes <code>In use</code> in this style, and your own (<code>Yours</code>). <code>Reverse</code> turns the colors around.

| Kind | Example | Description |
| :--: | ------- | ----------- |
| <code>Sequential</code> | <img src={require('/img/map/styling/sequential_palette.png').default} alt="Sequential palettes"/> | **For values in an order**, such as rising or falling numbers: the colors run from one end to the other. |
| <code>Diverging</code> |   | **For values around a midpoint**, such as positive and negative values. |
| <code>Categories</code> | <img src={require('/img/map/styling/qualitative_palette.png').default} alt="Palettes for categories"/> | **For distinct categories** without an order or ranking. |

To make your own palette, click <code>Make my own palette</code>. Click a color to change it, drag colors to reorder them, add or remove colors, and click <code>Apply</code>.

## Rules {#rules}

A rule is a condition on any fields and what it changes for the features that match, for what a classification cannot say: several fields at once, a threshold next to categories, or empty values. Rules apply after the classifications, in list order: where two rules change the same property, the lower one in the list wins.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Rules</code> section, click <code>Add a rule</code> (the plus).</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Under <code>When</code>, click <code>Add a condition</code> and choose a field. The condition's editor opens next to the rule: choose the comparison under <code>Condition</code> and set the value as in the <a href="../../filter#filter-by-attribute">filter</a>, from the list of the field's values with how often each occurs or with the slider over the histogram. Each condition then shows as a sentence in its row: click the row to change it, or point at it and click the bin icon to remove it (a rule keeps one condition at least). From two conditions on, the menu next to <code>When</code> sets whether features meet every condition (<code>Match all</code>) or at least one (<code>Match any</code>).</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Click <code>Add rule</code>. The rule's editor opens.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Give it a <code>Name</code> (it defaults to the condition as a sentence) and choose under <code>Then</code> what it does: <code>Show</code> off hides the matching features, <code>Zooms</code> shows them at fewer zooms, <code>In legend</code> off leaves the rule out of the legend, and <code>Style the matching features</code> opens the rule in the symbol section to give them their own fill, outline, icon or label, as for <a href="#style-one-class">one class</a>.</div>
</div>

The rows of the <code>Rules</code> section show each rule's name and what it changes. The arrows move a rule up or down; the bin icon in the rule editor's header (<code>Remove rule</code>) removes it. A condition that the rows cannot show opens as CQL2 text (<code>Edit as CQL2</code>).

:::tip HINT
To use your styling for this dataset in other projects too, make it the dataset's default style: see [Named styles](./styling.md#named-styles).
:::
