---
description: "Configure the dashboard Layers widget: choose the layers it lists, allow legends and downloads, pick a tree or tab layout, zoom behavior and layer actions."
sidebar_position: 1
---

# Information

This section contains **widgets that provide information about your project** layers and components.

## Layers

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Drag and drop the <code>Layers</code> widget on a panel.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click on the <code>Layers</code> widget to open the <b>Layers - Settings</b> panel on the right.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Under <code>Info</code>, add a <code>Title</code> and optional <code>Description</code> for the widget.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">
  Under <code>Layers</code>, select which layers to show in the widget using the checkboxes. For each layer, click the ⋮ icon to access per-layer settings:
  <ul>
    <li><code>Show in legend</code>: toggle whether the layer's legend is shown</li>
    <li><code>Download</code>: allow viewers to download this layer's data</li>
  </ul>
  For groups, click the icon to <code>Change icon</code>, and click the ⓘ button to add or edit group info text (Markdown supported).
  Below a group with two or more layers, choose how the group is shown: <code>List</code> shows its layers as before, while <code>Chips</code>, <code>Slider</code> and <code>Dropdown</code> show <b>one layer of the group at a time</b>. Picking a layer turns it on and the other layers of the group off, and the legend of the shown layer appears below. Check <code>Play</code> to add a play button that steps through the layers. Viewers of the published dashboard always see exactly one layer of such a group.
  </div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">
  Under <code>Layout</code>, configure how the layer list is displayed:
  <ul>
    <li><code>Layout style</code>: <code>Tree</code> (hierarchical list) or <code>Tabs</code> (tabbed navigation)</li>
    <li><code>Visibility toggle</code>: icon style for the show/hide control (<code>Eye</code>, <code>Checkbox</code>, or <code>Switch</code>)</li>
    <li><code>Visibility position</code>: <code>Left</code> or <code>Right</code></li>
    <li><code>Show search bar</code>: add a search box above the layer list</li>
    <li>When <code>Layout style</code> is set to <code>Tabs</code>, additional options appear: <code>Show group name</code>, <code>Show group icons</code>, and <code>Show all toggle</code>. When <code>Show all toggle</code> is enabled, a <strong>Show all</strong> row appears above the layer list in each tab, allowing viewers to toggle all layers in the active tab on or off at once. The toggle uses the same style (Eye, Checkbox, or Switch) as the per-layer visibility control.</li>
    <li><code>Hide field names</code>: hide field name labels in the widget</li>
  </ul>
  </div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Under <code>Zoom Behavior</code>, set what happens when a layer is outside its zoom range: <code>Hide layers</code> or <code>Show greyed out</code>.</div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Under <code>Layer actions</code>, choose the <code>Action mode</code>: <code>Compact menu</code> (actions hidden behind a ⋮ icon) or <code>Direct actions</code> (actions shown inline), and select which actions viewers can perform per layer: <code>Style</code>, <code>View data</code>, <code>Properties</code>, <code>Zoom to</code>.</div>
</div>


