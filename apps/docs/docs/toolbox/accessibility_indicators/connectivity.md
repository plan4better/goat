---
sidebar_position: 4

---

import MathJax from 'react-mathjax';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Heatmap - Connectivity
The Heatmap - Connectivity indicator **produces a color-coded map to visualize the connectivity of locations within an area of interest** ([**AOI**](../../further_reading/glossary#area-of-interest-aoi "What is an AOI?")).

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/PzWEIbcSf4Y?si=MB4LNSEkMmnzccuX" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## 1. Explanation

The heatmap uses a color-coded hexagonal grid to show **how well-connected different areas are.** It takes an **Area of Interest** (AOI), a **routing type** (walking, cycling, etc.), and a **travel time limit** as inputs. Considering real-world transport and street networks, it calculates the connectivity of each hexagon within the AOI.


:::info

Heatmap computation is available across **over 30 European countries** for `Walk`, `Bicycle`, `Pedelec`, and `Car`. For `Public Transport`, Germany, Switzerland, and the Haut-Rhin region of France are supported. If you need analyses beyond these regions, feel free to [contact us](https://plan4better.de/en/contact/).

:::

## 2. Example use cases

 - Does the existing transport network provide equitable access across the AOI?
 - How well connected is the street, footpath, or cycle lane network in a specific area?
 - How do locations within an AOI compare in terms of connectivity across the different modes of transport?
 - Are there barriers, gaps, or islands within the street network that hinder connectivity?

## 3. How to use the indicator?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click on <code>Toolbox</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Under the <code>Accessibility Indicators</code> menu, click on <code>Heatmap Connectivity</code>.</div>
</div>

### Routing & Configuration

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Pick the <code>Routing Type</code> you would like to use for the heatmap.</div>
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

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Enter a cost <code>Limit</code> in minutes or metres for your heatmap. This will be used according to your previously selected transport mode and cost type.</div>
</div>

</TabItem>

<TabItem value="public transport" label="Public Transport (PT)" className="tabItemBox">

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Choose <code>PT modes</code> to analyze: Bus, Tram, Rail, Subway, Ferry, Cable Car, Gondola, and/or Funicular. Then, select the <code>Day</code> and <code>Arrival time</code> for the analysis. The best public transport journeys that reach the opportunities at or before this time will be considered.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Enter a cost <code>Limit</code> in minutes for your heatmap.</div>
</div>

</TabItem>
</Tabs>

:::tip Hint
Need help choosing a suitable travel time limit for various common amenities? The ["Standort-Werkzeug"](https://www.chemnitz.de/chemnitz/media/unsere-stadt/verkehr/verkehrsplanung/vep2040_standortwerkzeug.pdf) of the City of Chemnitz can provide helpful guidance.
:::

#### Advanced options

Optionally, enable <code>Advanced options</code> to configure additional settings for routing and heatmap generation.

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Configure various routing options for your selected transport mode such as travel speed, max transfers, access/egress limits and more. Further information about mode-specific options can be found under the <a href="/docs/category/routing">Routing</a> section.</div>
</div>

### Reference layer

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Select the <code>Reference layer</code> (layer containing your area of interest) <strong>for which you would like to calculate the heatmap</strong>. This can be any polygon feature layer.</div>
</div>


### Result layer

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Set the <code>Result layer name</code> for the output heatmap layer.</div>
</div>

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Click <code>Run</code> to start the calculation of the heatmap.</div>
</div>

### Results

Once the calculation is complete, a result layer will be added to the map. This Heatmap Connectivity layer will contain your color-coded heatmap. **Clicking on any of the heatmap's hexagonal cells will reveal the computed connectivity value for this cell.**

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/connectivity_based/connectivity_calculation.gif').default} alt="Connectivity Heatmap Calculation Result in GOAT" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>
<p></p>

:::tip Tip

Want to style your heatmaps and create nice-looking maps? See [Styling](../../map/layer_style/style/styling).

:::

## 4. Technical details

### Calculation

For each hexagon in the grid within the Area of Interest (AOI), the tool identifies all surrounding hexagons that can reach it. These surrounding hexagons can be outside the AOI but must be within the specified **travel time** and using the chosen **travel method**.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/toolbox/accessibility_indicators/heatmaps/connectivity_based/heatmap_connectivity_infographic.png').default} alt="Extent of cells from where destination cell within AOI is accessible." style={{ maxHeight: "400px", maxWidth: "500px", alignItems:'center'}}/>
</div>

Connectivity formula:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"\\text{cell connectivity} = \\sum_{i=1}^{n} (\\text{number of reachable cells}_i \\times \\text{cell area})"} />
  </div>
</MathJax.Provider>

The connectivity formula calculates the total area (in square meters) from which a destination cell within the Area of Interest (AOI) can be reached. It does this by considering the **number of cells** that can reach the destination cell within each **travel time step** ***i*** up to the specified **travel time limit** ***n***. **The sum of all these reachable areas gives the final connectivity value for that cell.**

### Grid cells 

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

### Visualization

For visualization, the result form the connectivity analysis, uses a classification method based on quantiles by default. However, various other classification methods may be used instead. Read more in the **[Data Classification Methods](../../map/layer_style/style/attribute_based_styling#data-classification-methods)** section of the *Attribute-based Styling* page.