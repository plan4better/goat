---
description: "Compute travel time or distance for every origin-destination pair of two point layers, by routing mode or flight distance, as a table of travel costs."
sidebar_position: 10
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Travel Cost Matrix

The Travel Cost Matrix tool **computes [travel time](https://www.plan4better.de/en/glossary/travel-time) or distance between a set of origins and a set of destinations**, producing a table that can be used for [accessibility analysis](https://www.plan4better.de/en/glossary/accessibility-analysis), [location planning](https://www.plan4better.de/en/glossary/site-selection), and spatial modeling.

## 1. Explanation

The Travel Cost Matrix calculates the **travel cost (time or distance) between every [origin–destination pair](https://www.plan4better.de/en/glossary/origin-destination-matrix)** in two input layers, for a selected routing mode. The output is a table where each row represents one O-D connection and includes the origin identifier, destination identifier, and the computed travel cost.

The Travel Cost Matrix is designed for **batch computation across many origins and destinations at once**. This makes it the right tool when you need the raw cost data to feed into further analyses, such as location scoring, supply-demand matching, or custom accessibility indices.

## 2. Example use cases

- Computing walking times from all residential buildings to the nearest schools to identify [underserved areas](https://www.plan4better.de/en/glossary/deficit-area).
- Calculating car travel times between a set of warehouses (origins) and retail stores (destinations) for logistics optimization.
- Building an input matrix for a custom accessibility score that weights travel time by destination attractiveness.
- Assessing how many destinations are reachable within a given travel time threshold from each origin.
- Comparing travel cost differences between two transport modes (e.g., cycling vs. public transport) for a set of O-D pairs.

## 3. How to use the tool?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click on <code>Toolbox</code> <img src={require('/img/icons/toolbox.png').default} alt="Toolbox" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> and under <code>Accessibility Indicators</code>, click on <code>Travel Cost Matrix</code>.</div>
</div>

### Routing

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Select the <code>Transport mode</code> to use for travel cost computation.</div>
</div>

### Configuration

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Configure the options for your selected <code>Transport mode</code>. The available fields depend on the mode:</div>
</div>

<Tabs>
<TabItem value="active-car" label="Walk / Bicycle / Pedelec / Car" default className="tabItemBox">

- Under <code>Calculate by</code>, select <code>Time (min)</code> or <code>Distance (m)</code>.
- If calculating by <code>Time (min)</code>, set the <code>Travel speed (km/h)</code>.
- Optionally, enable <code>Advanced options</code> to set a maximum cost limit: <code>Limit - Time (min)</code> when calculating by time, or <code>Limit - Distance (m)</code> when calculating by distance.

</TabItem>
<TabItem value="flight" label="Flight Distance" className="tabItemBox">

**Computes the straight-line geodesic distance between every origin–destination pair.** No routing network is used. There are no configuration fields for this mode, so simply select it and proceed to the Input section.

</TabItem>
<TabItem value="pt" label="Public Transport (PT)" className="tabItemBox">

- Select the <code>Choose PT Modes</code> to analyze: Bus, Tram, Rail, Subway, Ferry, Cable Car, Gondola, and/or Funicular.
- Select the <code>Day</code> (<code>Weekday</code>, <code>Saturday</code>, or <code>Sunday</code>) and set the <code>Start Time</code> and <code>End Time</code> for the analysis time window.
- Set the <code>Travel time limit (min)</code>: the maximum journey duration to consider.
- Optionally, enable <code>Advanced options</code> to configure <code>Max. transfers</code>, <code>Access Mode</code>, and <code>Egress Mode</code>.

</TabItem>
</Tabs>

### Input

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Under <b>Origins</b>, select your <code>Origins layer</code> (a point layer where each feature is a starting location) and set the <code>Origins label</code>: the column used to identify origins in the result matrix.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Under <b>Destinations</b>, select your <code>Destinations layer</code> (a point layer where each feature is a target location) and set the <code>Destinations label</code>: the column used to identify destinations in the result matrix.</div>
</div>

### Result layer

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Set the <code>Destinations layer name</code> for the output destinations point layer.</div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Set the <code>Matrix layer name</code> for the output table layer.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Click on <code>Run</code>.</div>
</div>

:::tip Hint

Calculation time scales with the number of O-D pairs. Check the [status bar](../../workspace/workspace_interface.md#user-controls) for progress.

:::

### Results

Once the calculation finishes, a **table layer** is added to the map panel. Each row represents one origin–destination pair that falls within the specified travel cost threshold. The `origin` and `destination` columns contain the values from your selected label columns.

| Column | Description |
|--------|-------------|
| `origin` | Identifier of the origin feature (from your selected Origins label) |
| `destination` | Identifier of the destination feature (from your selected Destinations label) |
| `travel_cost` | Travel time (minutes) or distance (meters), depending on the selected measure type |

O-D pairs that exceed the maximum travel cost are excluded from the output.

A **Destinations** point layer is also added, containing all original destination attributes enriched with a computed **travel_cost** value for each point, the **average cost from the origins that reach** that destination. This makes the layer easy to map and style, showing how reachable each destination is from the origins on average.

:::tip Tip
Want to use this matrix for further analysis? Connect the result table as input to other tools in a [Workflow](../../map/layers.md) or export it as CSV for use in external tools.
:::

## 4. Technical details

Travel costs are computed using the **same routing engine as the Catchment Area tool**, ensuring consistent results across all accessibility analyses in GOAT. For each origin, the routing algorithm explores the network up to the specified maximum cost and records the cost to each reachable destination.

### Computational considerations

- The number of calculations scales as **O × D** (number of origins × number of destinations). Large datasets with many origins and destinations will take longer to process.
- Using a realistic **maximum travel cost** limit significantly reduces computation time and output size.
- For **Public Transport**, the engine evaluates every departure minute within the specified time window and keeps the **fastest** trip to each destination (it is not an average over the window).

### Unbounded calculation limits

When no maximum travel cost is set, the following limits apply based on the bounding-box diagonal of all origin–destination pairs (the straight-line distance across the smallest rectangle that contains all your origin and destination points; in other words, how far apart your two most distant points are):

| Routing mode | Maximum O-D extent (bounding-box diagonal) |
|---|---|
| Walk | 100 km |
| Bicycle | 100 km |
| Pedelec | 100 km |
| Car | 300 km |
| Public Transport | 300 km |
| Flight Distance | No limit |

### Output geometry

The Travel Cost Matrix produces a **table (non-spatial) layer**. To visualize the connections on the map, use the [Origin-Destination](../geoanalysis/origin_destination.md) tool, which can take an O-D table and a geometry layer to draw flow lines.

:::tip Hint

For further insights into the routing algorithm, visit [Routing](../../category/routing).

:::
