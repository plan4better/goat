---
description: "Create a first project, add layers, run a tool from the Toolbox, style the map with labels, popups and legend, and publish it as a public link or iframe."
sidebar_position: 3
---

# Quickstart Guide
Welcome to GOAT! This quickstart guide will help you get up and running in no time. Follow these steps to create a project, add data, run your first analysis, style your map and share your work.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="367" src="https://player.mediadelivery.net/play/753320/31ad707d-c1f2-4f21-8c47-1c610141f9d2" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## Create a new project


<div class="step">
  <div class="step-number">1</div>
  <div class="content">After signing in, you land on the <code>Home</code> page. Click <code>New project</code> and select <code>Blank project</code>. On your first visit, click <code>New project</code> in the <code>Set up your workspace</code> checklist instead. Alternatively, scroll down to <code>Start from a template</code>, click a template, then click <code>Use template</code> and follow the dialog.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Enter a <b>project name</b> and click <code>Create project</code>. The project opens in the map view.</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <Video src={require('/img/getting_started/new-project.mp4').default} alt="Workspace at GOAT" style={{ maxHeight: "auto", maxWidth: "75%", objectFit: "cover"}}/>
</div>

## Add data to your project
You've landed in the map view of your new project. Now it's time to add some data.

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Click <code>Add layer</code> at the top of the <code>Layers</code> panel on the left. In an empty project, the button sits in the middle of the panel. Under <code>New data</code>, choose <code>Upload dataset</code>, <code>Create layer</code> to start an empty layer, or <code>Fetch / Connect data</code> for a WMS, WMTS, WFS, XYZ or COG source. Under <code>Existing data</code>, choose <code>My datasets</code> or <code>Catalog</code> to add a dataset that is already in GOAT. For full details on each option, see [Layers](../map/layers).</div>
</div>

## Explore the analysis tools
Depending on the layers you have added, you can run different analyses from the toolbox.
<div class="step">
  <div class="step-number">4</div>
  <div class="content">Click the toolbox icon <img src={require('/img/icons/toolbox.png').default} alt="Toolbox" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> on the map, just to the right of the <code>Layers</code> panel. The <code>Toolbox</code> opens on the right.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">On the <code>Tools</code> tab, the tools are grouped into <code>Accessibility Indicators</code>, <code>Geoprocessing</code>, <code>Geoanalysis</code> and <code>Data Management</code>. Click the tool you want to use and complete its settings. For more detail, see [Toolbox](../category/toolbox).</div>
</div>

## Style your map
Once you have added the layers to your map and computed the analysis, you can customize their appearance to enhance visualization.

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Click a layer in the <code>Layers</code> panel. Its settings panel opens on the right with the <code>Style</code> tab selected. In the <code>Style</code> section, pick the color you want under <code>Fill Color</code> (<code>Color</code> for a line layer). To style by attribute, click the options icon <img src={require('/img/icons/options.png').default} alt="Options Icon" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> next to it and choose a field in <code>Color based on</code>.</div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">You can continue in the <code>Style</code> section: choose a <code>Palette</code> for the attribute-based colors, set the <code>Stroke Color</code>, or, for a point layer, switch on <code>Custom Marker</code> to use an icon as the marker.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">In the sections below, open <code>Labels</code> and choose a field in <code>Label by</code>, switch on the <code>Popup</code> and set up its content, and in <code>Legend</code> choose whether the layer is shown and add a <code>Caption</code>. For more detail, see [Layer Styling](../map/layer_style/style/styling).</div>
</div>

## Ready to share your work
Now that you have created your first project in GOAT, it's time to share it with others. You can publish it as a public link or iframe, or share it with colleagues on the <code>People</code> and <code>Teams</code> tabs of the <code>Share</code> dialog.

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Click <code>Share</code> in the upper-right corner of the map.</div>
</div>

<div class="step">
  <div class="step-number">10</div>
  <div class="content">Open the <code>Public</code> tab and click <code>Publish to web</code> to make your map public.</div>
</div>

<div class="step">
  <div class="step-number">11</div>
  <div class="content">Under <code>Address</code>, click <code>Copy link</code> to share a direct link. Under <code>Embed</code>, click <code>Copy</code> next to <code>Embed Code</code> to copy the iframe code for a website. For more detail, see [Public Sharing](../sharing/public).</div>
</div>