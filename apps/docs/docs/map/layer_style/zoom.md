---
sidebar_position: 1
---
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';


# Zoom visibility

**The Zoom visibility feature controls the zoom range at which each layer appears on your map.** This helps you display the most relevant data at different zoom levels and optimize map performance.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/styling/zoom.webp').default} alt="Zoom visibility scale in GOAT" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

## Understanding zoom levels

GOAT uses zoom levels from **0 (world view) to 22 (street-level detail)**:

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

| Zoom Level | Typical use case              |
| ---------- | ----------------------------- |
| **0-8**    | Global to regional context    |
| **9-14**   | City to neighborhood analysis |
| **15-22**  | Street-level details          |
</div>

:::info Default settings
All layers are visible across zoom levels 1-22 unless configured otherwise.
:::

## How to set zoom visibility

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Select your layer and navigate to <code>Layer design</code> <img src={require('/img/icons/styling.png').default} alt="Styling Icon" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> and find the <code>Zoom visibility section</code></div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Set your range by <strong>dragging the handles on the scale or manually entering values.</strong></div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/styling/zoom_adjust.gif').default} alt="Adjusting zoom visibility settings" style={{ maxHeight: "400px", maxWidth: "400px", objectFit: "cover"}}/>
</div>

## Best practices

**Detailed features** (Buildings, POIs): Use higher zoom levels (14-22) to prevent clutter.

**Regional data** (Demographics, Boundaries): Use intermediate levels (8-16) for context.

**Background layers** (Roads, Water): Use full range (1-22) for consistent reference.

**Summary data** (Heat maps, Aggregated): Use lower levels (1-14) for overview.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/styling/zooming_out.gif').default} alt="Zoom visibility demonstration" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

<p></p>

:::tip Pro Tip
Test your settings by zooming in and out to see how layers appear at different scales.
:::

:::info Related features
Explore other [Layer styling](../../category/style) options and combine with [Filters](../filter) for advanced data presentation.
::: 
