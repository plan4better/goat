---
description: "Create a point, line, polygon or table layer, draw and edit features on the map, edit attributes in the data table and add computed formula fields."
sidebar_position: 3
---

# Layer Editing

In GOAT, you can **create your own layers** and **edit features directly on the map**. This allows you to digitize new data, add attributes, and modify existing features without leaving the map view.

## Create Layer

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click on <code>+ Add layer</code> in the left panel and select <code>Create layer</code>. The dialog shows everything on one page: the layer's name, its geometry type and its fields.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Enter a <b>Layer name</b> and select the <b>Geometry type</b>: <code>Point</code>, <code>Line</code>, <code>Polygon</code>, or <code>Table</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Under <b>Fields</b>, the layer starts with a <code>name</code> field. Click <code>+ Add field</code> to add more fields. Type each field's name in the list on the left, and select a field to set its <code>Field type</code> on the right: <code>Text</code>, <code>Number</code>, <code>Date</code>, <code>Boolean</code>, <code>Serial</code> or <code>UUID</code>. A <code>Serial</code> or <code>UUID</code> field is filled in by GOAT for every feature you add (see <a href="../data/data_types">Field Types</a>); for a Serial field you can set the first number under <code>Start at</code>. To remove a field, point at it and click the <code>—</code> icon next to it. Click <code>Create layer</code> when done.</div>
</div>

## Edit Features

Once a layer is created, you can add and edit features directly on the map.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click the <img src={require('/img/icons/3dots.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>more options</code> icon next to your layer and select <code>Edit features</code> to <strong>enter edit mode</strong>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Use the <strong>editing toolbar</strong> at the bottom of the map: click <code>+</code> to <strong>add a new feature</strong> and click on the map to draw the geometry. The <b>Feature Attributes</b> panel opens on the right. <strong>Fill in the attribute values</strong> and click <code>Done</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">When you are ready, click <code>Save</code> in the bottom bar to <strong>save your changes</strong>, or <code>Discard</code> to cancel them. The bar also shows the number of <strong>pending changes</strong>.</div>
</div>

## View Data

**View Data** lets you see and edit your layer data as a table. Open it from the layer's <img src={require('/img/icons/3dots.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>more options</code> menu to manage fields, edit attribute values directly in the table, or enter edit mode to add and modify features on the map.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click the <img src={require('/img/icons/3dots.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>more options</code> icon next to your layer and select <code>View Data</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click <code>Edit fields</code> in the table toolbar to open the <b>Edit fields</b> dialog, then click <code>+ Add field</code>. A new field is added to the list. Select its <b>Field type</b> on the right (<code>Text</code>, <code>Number</code>, <code>Date</code>, <code>Boolean</code>, <code>Serial</code>, <code>UUID</code>, or <code>Formula</code>, a computed field, see <a href="#formula-fields">Formula fields</a> below). A new <code>Serial</code> or <code>UUID</code> field is filled in for all existing features when you save, and rename the field in the list. To remove a field, click the <code>—</code> icon next to it. Click <code>Save</code> when done.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Click <code>Edit features</code> in the table toolbar to enter edit mode. You can <strong>click directly on a cell</strong> in the table to edit attribute values inline, use the <strong>pointer</strong> on the map to select an existing feature and update its attributes in the <b>Feature attributes</b> panel, or use <code>+</code> to draw a new feature. Click <code>Save</code> or <code>Discard</code> when done.</div>
</div>

### Formula fields

A **Formula** field's value is calculated from an expression you write, similar to a formula column in a spreadsheet. The expression can reference your other fields (for example, divide population by area to get density) or combine text fields into one. The result is applied to every feature in the layer.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click <code>Edit fields</code> to open the <b>Edit fields</b> dialog and click <code>+ Add field</code>. With the new field selected, set its <code>Field type</code> on the right to <code>Formula</code> (and rename the field in the list).</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click <code>Add formula</code> to open the <b>Formula Builder</b>. Write an expression, referencing your other fields by name in double quotes (for example <code>"population"</code>). The <b>Build</b> tab lets you insert fields, operators, and functions, and the <b>Preview</b> tab shows a sample result. A green check confirms the expression is valid.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Click <code>Apply</code>, then <code>Save</code> in the Edit fields dialog. GOAT computes the values for all features and keeps them up to date automatically.</div>
</div>

**Examples:**

- <code>"population" / "area_km2"</code>: population density
- <code>round("population" / "area_km2", 1)</code>: density rounded to one decimal
- <code>concat_ws(', ', "city", "country")</code>: combine text fields (e.g. `Berlin, Germany`)
- <code>if("population" &gt; 100000, 'large', 'small')</code>: classify by a threshold

:::info
A formula's values update automatically when the fields it references change. A formula must produce a number, text, true/false, or date value. Formula fields are only available on existing layers.
:::
