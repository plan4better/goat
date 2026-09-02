---
sidebar_position: 6
---

import MathJax from 'react-mathjax';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Huff Model

The Huff Model **predicts the probability of consumers in a reference area visiting particular locations** based on the attractiveness of the locations and the distance to those locations, including competition between opportunities. The Huff Model focuses on **competitive market share**.

<!-- TODO: Add YouTube video embed when available
<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="VIDEO_URL" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>
-->

## 1. Explanation

The Huff Model is a **spatial interaction model that estimates how demand (e.g., customers, residents) is distributed among competing supply locations (e.g., stores, facilities)**. 
The model works on a simple principle: **a location's probability of being chosen depends on its attractiveness relative to all competing locations, weighted by travel time**. A large, nearby shopping center will capture more demand than a small, distant one — but the exact split depends on the balance of attractiveness and distance for all available options.

The result is a **probability score for each supply location**, representing the share of total demand it captures from the reference area. This enables direct comparison of how well different facilities compete for the same customer base.

You can configure the routing type, opportunity layers (with capacity fields), demand layer (with population field), reference area, travel time limits, and calibrate your model.

- **Reference area** — A polygon defining the study area. Only demand and opportunities within this area are considered.

- The **Opportunity layers contain facility data** with an attractivity attribute (e.g., number of hospital beds, square meters of retail space, school seats).

- The **Demand layer contains population or user data** (e.g., number of residents, potential customers) that represents the demand for the facilities.



**Key difference:** Unlike the Heatmaps, which visualize accessibility per grid cell, the *Huff Model* produces a **probability per supply location** — showing what share of total demand each facility captures.

:::info

Huff Model computation is available across **over 30 European countries** for `Walk`, `Bicycle`, `Pedelec`, and `Car`. For `Public Transport`, Germany, Switzerland, and the Haut-Rhin region of France are supported. If you need analyses beyond these regions, feel free to [contact us](https://plan4better.de/en/contact/ "Contact us").

:::

## 2. Example use cases

- How much market share does each supermarket capture from surrounding residential areas?

- Where should a new retail store be opened to maximize customer reach while considering existing competitors?

- How would adding a new school affect enrollment distribution across existing schools?

- What share of demand does each public library capture from surrounding neighborhoods?

## 3. How to use the tool?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click on <code>Toolbox</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Under the <code>Accessibility Indicators</code> menu, click on <code>Huff Model</code>.</div>
</div>

### Routing & Configuration

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Pick the <code>Transport mode</code> you would like to use for the analysis.</div>
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
  <div class="content">Enter a cost <code>Limit</code> in minutes or metres. This will be used according to your previously selected transport mode and cost type. Facilities beyond this limit are not considered.</div>
</div>

</TabItem>

<TabItem value="public transport" label="Public Transport (PT)" className="tabItemBox">

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Choose <code>PT modes</code> to analyze: Bus, Tram, Rail, Subway, Ferry, Cable Car, Gondola, and/or Funicular. Then, select the <code>Day</code> and <code>Arrival time</code> for the analysis. The best public transport journeys that reach the facilities at or before this time will be considered.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Enter a cost <code>Limit</code> in minutes. Facilities beyond this limit are not considered.</div>
</div>

</TabItem>
</Tabs>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Select your <code>Reference Area</code> — a polygon layer defining the study area boundary. Only demand and opportunities within this area are included in the analysis.</div>
</div>

:::tip Hint

Need help choosing a suitable travel time limit for various common amenities? The ["Standort-Werkzeug"](https://www.chemnitz.de/chemnitz/media/unsere-stadt/verkehr/verkehrsplanung/vep2040_standortwerkzeug.pdf) of the City of Chemnitz can provide helpful guidance.

:::

### Demand

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Select your <code>Demand Layer</code> from the drop-down menu. This layer should contain population or consumer data (e.g., census data with resident counts, customer locations).</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Choose the <code>Demand Field</code> — a numeric field from your demand layer representing the number of potential consumers (e.g., population, number of households).</div>
</div>

### Opportunities

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Select your <code>Opportunity Layer</code> from the drop-down menu. This layer should contain facility or store locations that compete for demand.</div>
</div>

<div class="step">
  <div class="step-number">10</div>
  <div class="content">Choose the <code>Attractivity Field</code> — a numeric field representing the attractiveness of each facility (e.g., floor area in m², number of products, quality score).</div>
</div>

### Advanced Configuration

<div class="step">
  <div class="step-number">11</div>
  <div class="content">Optionally, adjust the <code>Attractiveness Parameter</code> (default: 1.0) to control how strongly attractiveness influences the probability. Higher values amplify differences between facilities.</div>
</div>

<div class="step">
  <div class="step-number">12</div>
  <div class="content">Optionally, adjust the <code>Distance Decay</code> parameter (default: 2.0) to control how strongly travel time reduces a facility's appeal. Higher values mean people are less willing to travel far.</div>
</div>

:::info Model Calibration

For realistic results, the Huff Model parameters should be **calibrated using observed market share or user choice data**. The default parameters may not reflect actual customer behavior in your study area.
Ideally, collect data on actual customer visits or market shares to estimate optimal parameters.

**Note:** Automated parameter calibration is not currently available in GOAT. You can manually adjust the parameters.

:::

<div class="step">
  <div class="step-number">13</div>
  <div class="content">Optionally, configure various routing options for your selected transport mode such as travel speed, max transfers, access/egress limits and more. Further information about mode-specific options can be found under the <a href="/docs/category/routing">Routing</a> section.</div>
</div>

### Result Layer

<div class="step">
  <div class="step-number">14</div>
  <div class="content">Set the <code>Result layer name</code> for the output Huff Model layer.</div>
</div>

<div class="step">
  <div class="step-number">15</div>
  <div class="content">Click <code>Run</code> to start the calculation.</div>
</div>

### Results

Once the calculation is complete, a result layer will be added to the map. Each feature in the result layer represents a **supply location** with its computed market share/probability expressed in percent.

- **Higher probability** values indicate that a facility captures a larger share of the total demand — it is more competitive relative to alternatives.
- **Lower probability** values indicate that a facility captures less demand, either because it is less attractive, farther away, or faces strong competition from nearby alternatives.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/huff_model/huff_model.png').default} alt="Huff Model Calculation Result in GOAT" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>
<p></p>


:::tip Tip

Want to create visually compelling maps that tell a clear story? Learn how to customize colors, legends, and styling in our [Styling section](../../map/layer_style/style/styling).

:::

## 4. Technical details

### Calculation

The Huff Model computes the probability that demand from location *i* flows to supply location *j*:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"P_{ij} = \\frac{A_j^{\\alpha} \\cdot d_{ij}^{-\\beta}}{\\sum_{k=1}^{n} A_k^{\\alpha} \\cdot d_{ik}^{-\\beta}}"} />
  </div>
</MathJax.Provider>

Where:
- *P<sub>ij</sub>* = probability that demand at location *i* visits supply location *j*
- *A<sub>j</sub>* = attractiveness of supply location *j*
- *d<sub>ij</sub>* = travel time from demand location *i* to supply location *j*
- *α* = attractiveness parameter (default: 1.0)
- *β* = distance decay parameter (default: 2.0)
- *n* = number of supply locations reachable from *i*

The **captured demand** for each supply location is then computed by multiplying the probability by the demand value at each origin and summing across all origins:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"C_j = \\sum_{i=1}^{m} P_{ij} \\cdot D_i"} />
  </div>
</MathJax.Provider>

Where:
- *C<sub>j</sub>* = total captured demand at supply location *j*
- *D<sub>i</sub>* = demand (population) at location *i*
- *m* = number of demand locations

The final **Huff probability** reported per supply location is the share of total demand it captures:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"H_j = \\frac{C_j}{\\sum_{i=1}^{m} D_i}"} />
  </div>
</MathJax.Provider>


## 5. References

Huff, D. L. (1963). A Probabilistic Analysis of Shopping Center Trade Areas. *Land Economics*, 39(1), 81–90.
