---
description: "Build a dashboard by adding panels on any side of the map, setting their style, appearance, position and width, and dragging widgets into them from the sidebar."
sidebar_position: 1
---


# Dashboard Interface

Switching to Dashboard mode opens the Dashboard Interface, where **you can design dashboards by arranging panels and widgets, and customize your workspace layout.**

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/builder/builder_interface.webp').default} alt="Dashboard Interface Overview in GOAT" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

:::info Saving
GOAT saves your changes to the dashboard as you make them. If the dashboard was saved somewhere else in the meantime, for example by someone else or in another tab, your changes don't replace that version. A notice at the top says <code>This dashboard was changed elsewhere</code>, with who changed it and when, and nothing is saved until you choose: click <code>Reload</code> to load the saved version, or <code>Keep mine</code> to save your version over it.
:::

## Map controls

The following controls are available on the dashboard map. Their position can be configured in [Settings](./settings).

- **Location search**: search for an address or place and pan the map to it
- **Zoom controls**: zoom in and out buttons
- **Basemaps**: switch between available basemaps. See [Basemaps](../map/basemaps)
- **Measurements**: measure distances, areas, and routes directly on the map. See [Measurements](../map/measurements)

## Panels

Panels are the main areas where you organize your widgets. You can add, arrange, and style panels to create your dashboard layout.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">You can click on the <code>+</code> button, <b>to add a new panel </b> to any side of the map.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click the <code>panel</code> to <b>open settings</b> and edit its appearance.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">You can also click the <code>arrow</code> on the side of a panel to expand it to full height/width.</div>
</div>


<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <Video src={require('/img/builder/new_panel.mp4').default} alt="Panel options and appearance" style={{ maxHeight: "auto", maxWidth: "80%", objectFit: "cover"}}/>
</div>

<p></p>

Under **Options** you can set:
- <code>Panel style</code>: `Default`, `Rounded`, or `Floating`
- <code>Collapsible panel</code>: enable to let viewers collapse the panel in Viewer mode

Under **Appearance** you can change:
- <code>Background color</code>: set the panel background color
- <code>Opacity</code> (0 = transparent, 1 = opaque)
- <code>Background blur</code>
- <code>Shadow</code>

Under **Position** you can set:
- <code>Align items</code>: Start, Center, or End
- <code>Spacing</code>: distance between widgets
- <code>Padding</code>: inner spacing around the panel content

Under **Size** you can set:
- <code>Width (px)</code>: fixed width of the panel in pixels

To delete a panel, click <code>Delete Panel</code> at the bottom of the settings.

## Widgets

**Widgets are the building blocks of your dashboard**. They let you display data, statistics, charts, and project elements, like text or images. Each widget is highly customizable: you can adjust its content, appearance, and behavior to fit your needs, whether you want to highlight key numbers, visualize trends, or add context with text and graphics.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/builder/widgets.webp').default} alt="Dashboard Interface Overview in GOAT" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

<p></p>

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Simply <b>drag and drop</b> <code>widgets</code> from the right sidebar to any panel on your dashboard.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click on the <code>widget</code> to <b>customize its settings</b>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content"><b>To rearrange the widget </b> you can click on it and drag it from the <code>dotted icon</code>.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">You can click on the <code>delete icon</code> to <b>remove the widget</b> from your dashboard.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Change the <code>Title</code>, which will appear on the top of the widget, and the <code>Description</code>, which will appear on the bottom of the widget.</div>
</div>

For more details, see [Widgets](../category/widgets).

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <Video src={require('/img/builder/widget_drag.mp4').default} alt="recent datasets" style={{ maxHeight: "400px", maxWidth: "auto", objectFit: "cover"}}/>
</div> 


## Settings

In the settings you can configure the **Map** controls, **Branding**, **Social sharing**, **General** options, and **Interactions** for your dashboard. See [Settings](./settings) for more details.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/builder/interface_settings.webp').default} alt="Dragging a widget to the panel" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

