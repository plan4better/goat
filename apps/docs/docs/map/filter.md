---
description: "Filter a layer or table by attribute, by an area on the map or by both, combine conditions with Match all or Match any, and save the result as a new layer."
sidebar_position: 5
---

# Filter

**The filter limits which features of a layer are shown on the map**: by attribute (e.g., supermarkets with specific names), by area (e.g., points inside a district) or by both. **It lets you focus on the relevant data without altering the original data.** It works with **point, line and polygon layers** and with **tables**, on fields that hold text, numbers, dates or true/false values.

## The Filter tab

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Layers</code> panel, click your layer. Its settings panel opens on the right with the tabs <code>Style</code>, <code>Filter</code> and <code>Metadata</code>. Select the <code>Filter</code> tab. For a table, the panel has only the tabs <code>Filter</code> and <code>Metadata</code> and opens on <code>Filter</code>.</div>
</div>

The tab has four parts, from top to bottom:

| Part | What it does |
| ---- | ------------ |
| Result line | Shows how many features pass the filter, for example <code>120 of 3,400 features</code>, with a bar for their share. Without a filter it reads <code>All 3,400 features</code>. <code>Clear</code> next to it removes the whole filter. |
| <code>Area</code> | Limits the layer to an area on the map. It reads <code>Whole layer</code> as long as no area is set. |
| <code>Conditions</code> | The attribute conditions, one row per condition, and the button <code>Add a condition</code>. |
| <code>Save as new layer</code> | Saves the filtered features as a new layer. The button sits under the count of the filtered features. |

:::info Changes apply at once
The filter has no button to apply it. Every change is applied and saved right away, and the map and the result line update. A layer with a filter shows a filter icon in the <code>Layers</code> panel. Click the icon to open the layer's <code>Filter</code> tab.
:::

## Filter by attribute

A condition compares one field of the layer with a value, for example **Name is Aldi** or **Population is greater than 10,000**.

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Under <code>Conditions</code>, click <code>Add a condition</code> and choose the field to filter by. Use <code>Search fields</code> to find a field in a long list.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">The editor of the new condition opens next to the panel. Under <code>Condition</code>, choose how the field is compared. The comparisons on offer depend on the type of the field.</div>
</div>

| Text | Number | Date | True/false |
| ---- | ------ | ---- | ---------- |
| is | is | is on | is true |
| is not | is not | is not on | is false |
| is one of | is one of | is before | is empty |
| is none of | is none of | is after | is not empty |
| contains | is less than | is between | |
| does not contain | is greater than | is not between | |
| starts with | is at most | in the last | |
| ends with | is at least | not in the last | |
| is empty | is between | is empty | |
| is not empty | is not between | is not empty | |
| | is empty | | |
| | is not empty | | |

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Set the value. How you do that depends on the comparison.</div>
</div>

| Comparison | How to set the value |
| ---------- | -------------------- |
| is, is not (text and numbers) | Pick one value from the list of the values in the field. The list shows how often each value occurs, the most frequent first. Use <code>Search values</code> to find a value. A value that is not in the list can be typed and taken with <code>Use "…"</code>. |
| is one of, is none of | Pick several values from the same list. The picked values stay on top and the list counts them, for example <code>3 of 100 picked</code>. |
| is less than, is greater than, is at most, is at least | Drag the slider over the histogram of the field's values or type the number into <code>Value</code>. The bars of the values that pass the condition are highlighted. |
| is between, is not between (numbers) | Drag the two handles of the slider or type the limits into <code>Value</code> and <code>Up to</code>. |
| contains, does not contain, starts with, ends with | Type the text into <code>Value</code>. |
| is on, is not on | Choose a date in <code>Value</code>. |
| is before, is after | Choose a date in <code>Value</code>. For a field with date and time, also set the time. |
| is between, is not between (dates) | Choose the two dates in <code>Value</code> and <code>Up to</code>. For a field with date and time, also set the times. |
| in the last, not in the last | Type a whole number into <code>Days</code>. |
| is empty, is not empty, is true, is false | No value is needed. |

<div class="step">
  <div class="step-number">5</div>
  <div class="content">As soon as the condition is complete, the map shows only the features that pass it and the condition appears as a sentence in its row. A condition that still lacks a value has a dashed outline and the note <code>Not applied until the condition is complete.</code></div>
</div>

:::tip Hint
- Comparisons that exclude a value ("is not", "is none of", "does not contain", "is not between", "is not on", "not in the last") keep the features that have no value in the field. Add the condition "is not empty" on the same field to leave those out as well.
- The characters `%` and `_` cannot be searched for with "contains", "does not contain", "starts with" and "ends with".
- "in the last" and "not in the last" count the days back from today, wherever the filter is used: on the map, in the data table, in exports, in tools and in workflows, and in shared projects. "in the last 7 days" keeps today and the 7 days before it, counted in whole days of Coordinated Universal Time (UTC). A filter saved with an older version of GOAT keeps the date it was saved with until it is changed and saved again.
- A time you set for a field with date and time is the time in your browser's time zone. The condition shows it in your time zone too, so someone in another time zone sees the same moment in theirs.
:::

### Combine conditions

Repeat steps 2 to 5 for every further condition. A filter applies up to 20 conditions. Conditions that are switched off do not count.

As soon as there are two or more conditions, a menu appears next to <code>Conditions</code>. It decides how the conditions work together:

- <code>Match all</code>: Features meet every condition.
- <code>Match any</code>: Features meet at least one condition.

### Change, switch off or remove a condition

- **Change**: Click the row to open its editor again. To filter by another field, click the field name at the top of the editor.
- **Switch off**: Use the switch at the end of the row. The condition stays in the list but is not applied, and its row is dimmed. Switch it on again to apply it. While 20 conditions are applied, a switched-off condition cannot be switched on.
- **Remove**: Point at the row and click the bin icon, or select the row and press the Delete key.
- **Remove everything**: <code>Clear</code> next to the result line removes all conditions and the area.

:::tip Hint
The [data table](./layer_editing#view-data) of a layer can filter by column. A column filter is part of the same layer filter, so it also appears as a condition in the <code>Filter</code> tab.
:::

## Filter by area

An area keeps the features that lie inside it or touch it, or the ones outside it. The area and the conditions always work together: a feature has to pass the area and the conditions, also with <code>Match any</code>.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Under <code>Area</code>, click the row <code>Whole layer</code>. The area picker opens next to the panel.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click <code>Add to area</code> and choose what the area is made of.</div>
</div>

| Option | What it adds |
| ------ | ------------ |
| <code>Current map view</code> | The part of the map that is visible right now. |
| <code>Draw polygon</code> | A polygon you draw on the map. |
| <code>Draw circle</code> | A circle you draw on the map: click its centre, then a point of its edge. |
| <code>Regions</code> | Administrative regions. Type at least two characters into <code>Search regions</code> and tick the regions you need. |
| <code>Features of a layer</code> | Features of another polygon layer of the project, for example districts. Choose the layer, then tick the features. The list offers the features the layer shows on the map: when that layer has a filter of its own, only the features it keeps. It shows 50 at a time; scroll down for more, or use <code>Search features</code>. |

While you draw, the panel shows <code>Draw the shape on the map</code>. The finished shape joins the area. <code>Cancel</code> or the Escape key stops drawing without adding a shape.

To change a drawn polygon later, click its pen icon (<code>Edit the shape on the map</code>) in the area. Drag the corners, or click between two corners to add one; select a corner and press Delete to remove it. <code>Done</code> or Enter keeps the change, <code>Cancel</code> or Escape keeps the old shape.

A drawn circle keeps its centre and radius. To move or resize it on the map, click its pen icon (<code>Move or resize the circle on the map</code>): drag the centre to move the circle, or the point on its edge to change the radius, then click <code>Done</code> or press Enter. The circle's <code>Radius</code> can also be set under its row in the area picker, with the slider or by typing it; it is shown in m below 1 km and in km from 1 km. A circle saved by an older version of GOAT keeps its shape but cannot be moved or resized: remove it and draw it again to change it.

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Add further pieces with <code>Add to area</code> if needed. The pieces add up to one area: a feature passes when it lies in any of them.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Choose <code>Inside</code> to keep the features in the area, or <code>Outside</code> to keep the ones that do not touch it. A new area starts with <code>Inside</code>.</div>
</div>

The row under <code>Area</code> names what the area is made of, for example <code>Map view</code>, <code>2 shapes</code>, <code>3 regions</code> or <code>12 features of Districts</code> (the layer they are from), and the outline of the area is drawn on the map while the <code>Filter</code> tab is open: <code>Outlined on the map</code> under the row says so.

### Change, switch off or remove the area

- **Remove a piece**: Open the area picker and click the X next to the piece. For regions and features of a layer, click the piece to open its list and untick single entries.
- **Update the map view**: An area with the piece <code>Map view</code> keeps the view it was added with. After you move the map, a refresh icon appears on the area row (<code>The map has moved. Use the current view</code>). Click it to use the view the map shows now.
- **Switch off**: Use the switch at the end of the area row. The area is kept but not applied.
- **Remove**: Click the bin icon on the area row or in the area picker. <code>Clear</code> removes the area together with all conditions.

## Limits

| What | Limit |
| ---- | ----- |
| Conditions in one filter | 20 |
| Values in one condition ("is one of", "is none of") | 100 |
| Drawn shapes in one area (polygons and circles) | 3 |
| Regions and features of a layer in one area, together | 200 |
| Points in the outline of one area | 2,000 |
| Characters of the whole filter, as a map request carries it | 60,000 |

An outline that fits is added as it is. One that would take the filter over a limit is only added simplified, and only when you agree: the panel says how many points it has, how many the simplified outline keeps and how far its edges move (<code>Add simplified</code> or <code>Cancel</code>). An outline that does not fit even simplified, such as one made of very many islands, is not added (<code>Not added: the outline does not fit into the filter, even simplified.</code>).

## Custom filter

A filter that was written outside this tab can hold parts the tab has no row for. Such a part appears as a row named <code>Custom filter</code>. It keeps filtering and can be switched off or removed, but not edited.

## Save as new layer

Click <code>Save as new layer</code> under the count at the top of the <code>Filter</code> tab, give the layer a name and click <code>Save layer</code> to **save the filtered features as a new layer**. The name suggested is the original layer's with the addition "(filtered)". GOAT starts a job that creates the layer and adds it to the project with the same style. This allows you to work with the filtered data independently of the original layer.

The new layer holds what the map shows: conditions and areas that are switched off or not complete are left out. The button shows once a filter is applied.

:::info
Changing a filter and saving it as a new layer need edit rights on the project. Without them, the <code>Filter</code> tab shows the filter as text only.
:::
