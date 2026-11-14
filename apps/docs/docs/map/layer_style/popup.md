---
description: "Show feature details in a popup on click or hover, built from field list, text, image, button, badge and divider blocks or custom HTML with field placeholders, and set its layout and size."
sidebar_position: 4
---

# Popup

**Popups display relevant information when users interact with map features.** This keeps your map clean while providing detailed information on demand. You choose when the popup shows, build its content from blocks or HTML, and set how it is presented.

## How to configure popups

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Layers</code> panel, click your layer. Its settings panel opens on the right with the <code>Style</code> tab selected. The <code>Popup</code> section is at the bottom of this tab.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Set <code>Show on</code>: <code>On click</code>, <code>Only on hover</code>, <code>On click and on hover</code> (a quick look on hover, kept open on click), or <code>Off</code> for no popup. Switching the popup off keeps its content: switch it on again and the content comes back.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Click <code>Content</code>. Its editor opens next to the panel. Under <code>Mode</code>, keep <code>Simple</code> to build the popup from blocks.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Click <code>Add block</code> and choose a block: <code>Text</code>, <code>Field list</code>, <code>Image</code>, <code>Button</code>, <code>Badge</code> or <code>Divider</code>. Click a block in the list to edit it in its own editor; the arrows next to it move it up or down, and the bin icon in the block editor's header (<code>Remove this block</code>) removes it.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">For a <code>Field list</code> block, choose <code>Table</code> or <code>List</code> as <code>Layout</code>, click <code>Add attribute</code> to choose the fields to show (or <code>Add all fields</code>), and optionally set <code>Show first</code> to the number of fields shown at once; the other fields show with a "See more" button.</div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">
  Click <code>Appearance</code> and set:
  <ul>
    <li><code>Layout</code>: <code>Popup</code> next to the feature, or <code>Pinned</code> in a corner of the map, chosen under <code>Anchor</code>.</li>
    <li><code>Width</code>: a fixed width in px, or empty for <code>Auto</code>.</li>
    <li><code>Max height</code>: a maximum height in px; longer content scrolls.</li>
    <li><code>Header</code>: <code>Standard</code>, <code>Compact</code> or <code>None</code>.</li>
    <li><code>Highlight</code>: marks the feature whose popup is open.</li>
  </ul>
  </div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Switch on <code>Preview</code> (<code>On the map</code>) to pin the popup of a sample feature on the map while you edit it.</div>
</div>

The <code>Content</code> row lists the blocks, and the <code>Appearance</code> row the layout and header. While the popup differs from the dataset's style, the headers of both editors show <code>Reset to the dataset's style</code> (a circular arrow).

## HTML mode

For full control over the popup design, switch from **Simple** to **HTML** mode. This lets you write custom HTML and CSS to create rich, branded popups, with images, styled cards, custom fonts and dynamic field values.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Content</code> editor, set <code>Mode</code> to <code>HTML</code>. The first time, GOAT converts your existing blocks into HTML.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click the <code>HTML</code> row, which shows the length of your code, to open the <code>Custom HTML</code> editor and write your markup. The editor shows a live preview next to your code and the appearance settings on the right. Click <code>Save</code> to apply your changes.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Use <code>{"{{field_name}}"}</code> placeholders to insert feature attribute values into your HTML. Type <code>{"{{"}</code> to get field suggestions, or pick a field under <code>Insert Field</code>.</div>
</div>

## Popups of raster layers

A raster file's popup shows the cell values under the pointer. Set <code>Show on</code> to <code>On click</code>, <code>Only on hover</code> or <code>Off</code>; for a file with several bands, <code>Values</code> shows the <code>Styled values</code> (the band the style uses) or <code>All bands</code>.

## Best practices

- **Choose relevant fields** that provide meaningful context to users.
- **Use clear, descriptive names** instead of technical field names.
- **Limit the number of fields** to avoid overwhelming users with information.
- **Use Show first** to keep popups compact when showing many attributes.
