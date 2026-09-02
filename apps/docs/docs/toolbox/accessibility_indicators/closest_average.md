---
sidebar_position: 3
---

import MathJax from 'react-mathjax';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Heatmap - Closest Average
The Heatmap - Closest Average indicator **produces a color-coded map visualizing the average travel cost (time or distance) to points (such as amenities) or polygons (such as parks) from surrounding areas**.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/-nBXd-LAqZA?si=3dUu-gFsVM1KjS4e&amp;start=46" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## 1. Explanation

The heatmap displays a color-coded hexagonal grid showing **average travel costs to destinations (opportunities)** using real-world transport networks. You can specify the **routing type**, **cost type (time or distance)**, **opportunity layer**, **number of destinations** and **travel cost limit** to produce the visualization.

- The opportunity layer contains point or polygon based destinations (POIs, transit stations, schools, amenities, parks, or custom data) **that you want to analyze accessibility to**. You can use multiple opportunity layers and they will be combined to produce a unified heatmap.

- Setting <code>Number of destinations</code> limits the calculation of average travel costs to upto the *n* nearest opportunities. This allows you to produce a more targeted accessibility analysis.

:::tip

**Key difference:** Heatmaps show *access* from many origins to specific destinations, while catchment areas show *reach* from specific origins to many destinations.

:::

:::info

Heatmap computation is available across **over 30 European countries** for `Walk`, `Bicycle`, `Pedelec`, and `Car`. For `Public Transport`, Germany, Switzerland, and the Haut-Rhin region of France are supported. If you need analyses beyond these regions, feel free to [contact us](https://plan4better.de/en/contact/).

:::

## 2. Example use cases

 - Do residents in certain areas have longer average travel times to amenities than others?

 - How does the average travel time to amenities vary across different modes of transport?

 - How does the average travel time vary across different types of amenities?
 
 - If standards require that a minimum number of amenities be accessible within a certain travel time, which areas meet these standards?

## 3. How to use the indicator?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click on <code>Toolbox</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> .</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Under the <code>Accessibility Indicators</code> menu, click on <code>Heatmap Closest Average</code>.</div>
</div>

### Routing & Configuration

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Pick the <code>Transport mode</code> you would like to use for the heatmap.</div>
</div>

| Mode | Considers |
|------|-----------|
| Walk | All paths accessible by foot |
| Bicycle | All paths accessible by bicycle (taking into account surface and slope) |
| Pedelec | All paths accessible by pedelec (taking into account surface and slope) |
| Car | All paths accessible by car (taking into account speed limits and one-way restrictions) |
| Public Transport | All journeys possible by public transport (according to official GTFS schedules), considering walking access and egress to and from stops |

<Tabs>
<TabItem value="active-car" label="Walk / Bicycle / Pedelec / Car" default className="tabItemBox">

<div class="step">
  <div class="step-number">4</div>
  <div class="content">In the <code>Calculate by</code> menu, choose either the Time (minutes) or Distance (metres) cost type.</div>
</div>

</TabItem>

<TabItem value="public transport" label="Public Transport (PT)" className="tabItemBox">

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Choose <code>PT modes</code> to analyze: Bus, Tram, Rail, Subway, Ferry, Cable Car, Gondola, and/or Funicular. Then, select the <code>Day</code> and <code>Arrival time</code> for the analysis. The best public transport journeys that reach the opportunities at or before this time will be considered.</div>
</div>

</TabItem>
</Tabs>

#### Advanced options

Optionally, enable <code>Advanced options</code> to configure additional settings for routing and heatmap generation.

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Select a <code>Reference area</code> - a polygon layer that represents your study area. When set, the heatmap extends to cover all H3 cells within that polygon, with inaccessible cells assigned a value of <code>NULL</code> to expose coverage gaps and underserved areas.</div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Configure various routing options for your selected transport mode such as travel speed, max transfers, access/egress limits and more. Further information about mode-specific options can be found under the <a href="/docs/category/routing">Routing</a> section.</div>
</div>

### Opportunities

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Select your <code>Input layer</code> from the drop-down menu. This can be any previously created layer containing point or polygon based data.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Enter a cost <code>Limit</code> in minutes or metres for your heatmap. This will be used according to your previously selected transport mode and cost type.</div>
</div>

:::tip Hint

Need help choosing a suitable travel time limit for various common amenities? The ["Standort-Werkzeug"](https://www.chemnitz.de/chemnitz/media/unsere-stadt/verkehr/verkehrsplanung/vep2040_standortwerkzeug.pdf) of the City of Chemnitz can provide helpful guidance.

:::

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Specify the <code>Number of destinations</code> that should be considered while computing the average travel cost.</div>
</div>

<div class="step">
  <div class="step-number">10</div>
  <div class="content">Optionally, click <code>+ Add Opportunity</code> to include additional opportunity layers. Each layer can have different travel cost limits and destination counts for multi-criteria analysis.</div>
</div>

### Result Layer

<div class="step">
  <div class="step-number">11</div>
  <div class="content">Set the <code>Result layer name</code> for the output heatmap layer.</div>
</div>

<div class="step">
  <div class="step-number">12</div>
  <div class="content">Click <code>Run</code> to start the calculation of the heatmap.</div>
</div>

### Results

Once the calculation is complete, a result layer will be added to the map. Clicking on any of the **heatmap's hexagonal cells will reveal the computed average travel cost value for that cell.**

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/closest_average_based/clst-avg-calculation.gif').default} alt="Closest Average Heatmap Calculation Result in GOAT" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>

## 4. Technical details

### Cell costs

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/shared/cell_cost_assignment.png').default} alt="gravity-no-destination-potential" style={{ maxHeight: "400px", maxWidth: "auto"}}/>
</div>

<p></p>

When multiple edges (streets) of the road network intersect a hexagonal cell, the cell's cost is calculated as the **minimum of all edge costs** within that cell. For the closest-average-based heatmap, this cost value (represented by **tᵢⱼ**) is then used according to the formula described in the following section to determine the average travel cost (time or distance) of each cell.

### Calculation

**After combining all opportunity layers** (for example, schools, shops, or parks), the tool **creates a grid made of hexagonal cells around the area**. **It only includes cells where at least one opportunity can be reached based on the selected** **routing type** (e.g., walking, cycling) and **travel cost limit** (e.g., 15 minutes).

Then, for each cell, it calculates the average travel cost to the **nearest n destinations** (as set in the settings).

The formula for average travel cost (time or distance) is:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"\\overline{t}_i = \\frac{\\sum_{j=1}^{n} t_{ij}}{n}"} />
  </div>
</MathJax.Provider>

For each cell (i), the tool adds up the travel costs (tij) to all reachable opportunities (j), up to n of them, and divides by n to get the average travel cost.

### Classification
In order to classify the accessibility levels that were computed for each grid cell, a classification based on quantiles is used by default. However, various other classification methods may be used instead. Read more in the **[Data Classification Methods](../../map/layer_style/style/attribute_based_styling#data-classification-methods)** section of the *Attribute-based Styling* page.

### Visualization 

Heatmaps in GOAT utilize **[Uber's H3 grid-based](../../further_reading/glossary#h3-grid)** solution for efficient computation and easy-to-understand visualization. Behind the scenes, accessibility is computed on-the-fly by GOAT's own routing engine. For each *routing type*, the engine routes outward from the opportunities to discover the reachable H3 cells and their travel costs, then aggregates these into a per-cell accessibility score. Public transport uses the RAPTOR-based engine, while the active mobility and car modes use GOAT's Dijkstra implementation.

The resolution and dimensions of the hexagonal grid used depend on the selected *routing type*:

| Mode | Resolution | Average hexagon area | Average hexagon edge length |
|------|-----------|----------------------|-----------------------------|
| Walk | 10 | 11,285.6 m² | 65.9 m |
| Bicycle | 9 | 78,999.4 m² | 174.4 m |
| Pedelec | 9 | 78,999.4 m² | 174.4 m |
| Car | 8 | 552,995.7 m² | 461.4 m |
| Public Transport | 9 | 78,999.4 m² | 174.4 m |


:::tip Hint

For further insights into the Routing algorithm, visit [Routing](../../category/routing). In addition, you can check this [Publication](https://doi.org/10.1016/j.jtrangeo.2021.103080).


:::

### Example of calculation

The following examples illustrate the computation of a closest-average-based heatmap for the same opportunities, with a varying `Number of destinations` value.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/closest_average_based/cls-avg-destinations.png').default} alt="Closest Average Heatmaps for different destinations" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>

<p></p>

In the first example, the average travel time is computed considering only the closest destination, while in the second example, the closest 5 destinations are considered.
