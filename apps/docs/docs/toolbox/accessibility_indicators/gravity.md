---
sidebar_position: 2
---
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import MathJax from 'react-mathjax';

# Heatmap - Gravity

The Heatmap - Gravity indicator **produces a color-coded map to visualize the accessibility of points (such as amenities) or polygons (such as parks) from surrounding areas**.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/yteOnb6N7hA?si=bj1l5gLCCDHsOhRc&amp;start=46" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## 1. Explanation

The heatmap Gravity displays a **color-coded hexagonal grid showing the accessibility of destinations (opportunities) based on travel cost (time or distance) and destination attractiveness**. Accessibility is calculated using real-world transport networks and a gravity-based formula that reflects how people’s willingness to travel decreases with distance.

You can specify the **routing type**, **opportunity layer**, **travel cost limit**, and adjust **sensitivity** and **destination potential** to fine-tune how accessibility is calculated.

- The **Opportunity layer contains point-based destination data** (such as POIs, transit stops, schools, amenities, or custom points). You can select multiple opportunity layers, which will be combined into a single unified heatmap.

- The **Sensitivity controls how quickly accessibility decreases with increasing travel cost**, while the **Destination potential lets you give more weight to destinations with higher capacity or quality** (e.g., a larger supermarket or a bus stop with more departures). Together with the chosen **Impedance function, these settings define how accessibility is calculated**.

- The **Potential Type** determines how each opportunity's weight is derived: use **Constant** to apply the same value to all opportunities, or **Field** to use a numeric attribute from the input layer (e.g., number of departures, seats, or capacity).

- Using **Destination potential helps prioritize certain opportunities over others**. For example, a larger but farther supermarket can be valued more than a smaller nearby one. This allows you to include qualitative information—such as size, frequency, or service level—when computing accessibility, resulting in a more realistic heatmap.

Influenced by all these properties, **the accessibility of a point can model complex real-world human behavior** and is a powerful measure for transport and accessibility planning.

:::tip

**Key difference:** Unlike the *Closest-Average* heatmap, which measures travel effort, the *Gravity-based Heatmap* measures **attractiveness** - showing how accessible and appealing destinations are when both distance and quality are considered.

:::


:::info

Heatmap computation is available across **over 30 European countries** for `Walk`, `Bicycle`, `Pedelec`, and `Car`. For `Public Transport`, Germany, Switzerland, and the Haut-Rhin region of France are supported. If you need analyses beyond these regions, feel free to [contact us](https://plan4better.de/en/contact/).

:::

## 2. Example use cases

 - Which neighborhoods or areas have limited access to public amenities, such as parks, recreational facilities, or cultural institutions, and may require targeted interventions to improve accessibility?

 - Are there areas with high potential for transit-oriented development or opportunities for improving non-motorized transportation infrastructure, such as bike lanes or pedestrian-friendly streets?

 - What is the impact of a new amenity on local accessibility?

 - Is there potential to expand the availability of services such as bike sharing or car sharing stations?

## 3. How to use the indicator?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click on <code>Toolbox</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Under the <code>Accessibility Indicators</code> menu, click on <code>Heatmap Gravity</code>.</div>
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

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Pick the <code>Impedance Function</code> you would like to use for the heatmap.</div>
</div>

<Tabs>

<TabItem value="gaussian" label="Gaussian" default className="tabItemBox">

This function calculates accessibilities based on a Gaussian curve, which is influenced by the `sensitivity` and `destination_potential` you define. For a more in-depth understanding, refer to the [Technical details](./gravity#4-technical-details) section.

</TabItem>
  
<TabItem value="linear" label="Linear" default className="tabItemBox">

This function maintains a direct correlation between travel cost and accessibility, which is modulated by the `destination_potential` you specify. For a more in-depth understanding, refer to the [Technical details](./gravity#4-technical-details) section.

</TabItem>

<TabItem value="exponential" label="Exponential" default className="tabItemBox">

This function calculates accessibilities based on an exponential curve, which is influenced by the `sensitivity` and `destination_potential` you define. For a more in-depth understanding, refer to the [Technical details](./gravity#4-technical-details) section.

</TabItem>

<TabItem value="power" label="Power" default className="tabItemBox">

This function calculates accessibilities based on a power curve, which is influenced by the `sensitivity` and `destination_potential` you define. For a more in-depth understanding, refer to the [Technical details](./gravity#4-technical-details) section.

</TabItem>

<TabItem value="cumulative" label="Cumulative" default className="tabItemBox">

This function counts every destination within the travel cost limit equally, applying no distance decay: destinations reachable within the limit receive full weight (modulated by their `destination_potential`), while those beyond it are ignored. It does not use the `sensitivity` parameter. For a more in-depth understanding, refer to the [Technical details](./gravity#4-technical-details) section.

</TabItem>

</Tabs>

<Tabs>
<TabItem value="active-car" label="Walk / Bicycle / Pedelec / Car" default className="tabItemBox">

<div class="step">
  <div class="step-number">5</div>
  <div class="content">In the <code>Calculate by</code> menu, choose either the Time (minutes) or Distance (metres) cost type.</div>
</div>

</TabItem>

<TabItem value="public transport" label="Public Transport (PT)" className="tabItemBox">

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Choose <code>PT modes</code> to analyze: Bus, Tram, Rail, Subway, Ferry, Cable Car, Gondola, and/or Funicular. Then, select the <code>Day</code> and <code>Arrival time</code> for the analysis. The best public transport journeys that reach the opportunities at or before this time will be considered.</div>
</div>

</TabItem>
</Tabs>

#### Advanced options

Optionally, enable <code>Advanced options</code> to configure additional settings for routing and heatmap generation.

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Select a <code>Reference area</code> - a polygon layer that represents your study area. When set, the heatmap extends to cover all H3 cells within that polygon, with inaccessible cells assigned a value of <code>NULL</code> to expose coverage gaps and underserved areas.</div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Configure various routing options for your selected transport mode such as travel speed, max transfers, access/egress limits and more. Further information about mode-specific options can be found under the <a href="/docs/category/routing">Routing</a> section.</div>
</div>

### Opportunities

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Select your <code>Input Layer</code> from the drop-down menu. This can be any previously created layer containing point-based data.</div>
</div>

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Choose a travel cost <code>Limit</code> for your heatmap. This will be used in the context of your previously selected <i>Transport mode</i>.</div>
</div>

:::tip Hint

Need help choosing a suitable travel time limit for various common amenities? The ["Standort-Werkzeug"](https://www.chemnitz.de/chemnitz/media/unsere-stadt/verkehr/verkehrsplanung/vep2040_standortwerkzeug.pdf) of the City of Chemnitz can provide helpful guidance.

:::

<div class="step">
  <div class="step-number">10</div>
  <div class="content">Choose a <code>Potential Type</code> to define how each opportunity is weighted:
    <ul>
      <li><b>Constant</b> — all opportunities have the same weight. Enter a numeric value (default: 1.0).</li>
      <li><b>Field</b> — use a numeric field from the <i>Input Layer</i> as the weight (e.g. number of departures, seats, or capacity).</li>
    </ul>
  </div>
</div>


<div class="step">
  <div class="step-number">11</div>
  <div class="content">Specify a <code>Sensitivity</code> value. This must be numeric and will be used by the heatmap function to determine how accessibility changes with increasing travel cost.</div>
</div>


:::tip Hint

**How to choose the sensitivity value?**

The best **sensitivity (β)** value depends on your analysis — there’s no single correct number. It defines **how quickly accessibility decreases as travel cost increases**.

- **Low β (urban scale):** Use a lower sensitivity for city-level analyses. This makes accessibility drop faster with distance, which fits urban contexts where many destinations are nearby and people usually choose the closest one.
- **High β (regional scale):** Use a higher sensitivity for regional or rural analyses. This makes accessibility decrease more slowly, which reflects that people are willing to travel longer distances when options are fewer.

For a visual explanation of how sensitivity affects the calculation, see the **[Calculation](#calculation)** section.

:::

### Result Layer

<div class="step">
  <div class="step-number">12</div>
  <div class="content">Set the <code>Result layer name</code> for the output heatmap layer.</div>
</div>

<div class="step">
  <div class="step-number">13</div>
  <div class="content">Click <code>Run</code> to start the calculation of the heatmap.</div>
</div>

### Results

Once the calculation is complete, a result layer will be added to the map. This <i>Heatmap Gravity</i> layer will contain your color-coded heatmap. Clicking on any of the heatmap's hexagonal cells will reveal the computed accessibility value for this cell.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/gravity_based/gravity_calculation.gif').default} alt="Heatmap Gravity-Based Calculation Result in GOAT" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>

<p></p>

:::tip Tip

Want to create visually compelling maps that tell a clear story? Learn how to customize colors, legends, and styling in our [Styling section](../../map/layer_style/style/styling).

:::

### Example of calculation

The example below shows how the changes in the opportunity settings can affect the gravity heatmap. Its destination potential is based on the total number of hourly public transport departures from a stop.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/gravity_based/gravity_calculation_comparison.png').default} alt="gravity-no-destination-potential" style={{ maxHeight: "500px", maxWidth: "auto"}}/>
</div>

<p></p>

The map on the back is calculated without destination potential. The second map used the same settings, but added destination potential based on the total number of departures. This altered the accessibility values of each hexagon and they returned in a wider range, because the highest value increased even more. **Higher accessibility values are more concentrated around the stops that have larger trip count (red points).**

## 4. Technical details

### Cell costs

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/shared/cell_cost_assignment.png').default} alt="gravity-no-destination-potential" style={{ maxHeight: "400px", maxWidth: "auto"}}/>
</div>

<p></p>

When multiple edges (streets) of the road network intersect a hexagonal cell, the cell's cost is calculated as the **minimum of all edge costs** within that cell. For the gravity-based heatmap, this cost value (represented by **tᵢⱼ**) is then used according to the formula described in the following section to determine the accessibility of each cell.

### Calculation
The accessibility value for each hexagonal cell is calculated using a **gravity-based formula**, which estimates how strongly destinations influence each location.

**Accessibility formula:**

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px'  }}>
    <MathJax.Node formula={"A_i=\\sum_j O_jf(t_{i,j})"} />
  </div>
</MathJax.Provider>

In simple terms, the accessibility (**A**) of a cell (**i**) depends on:
- the **number or importance of destinations** (**O**) nearby, and  
- the **travel cost** (**tᵢⱼ**) needed to reach them.

The function **f(tᵢⱼ)** reduces the influence of destinations that are farther away — this is called the **impedance function**. In GOAT you can choose between different impedance types: `gaussian`, `linear`, `exponential`, `power`, or `cumulative`.

and adjust how strongly distance affects accessibility using the **sensitivity (β)** parameter. If **destination potential** is included, it further increases the weight of destinations with higher capacity or quality (e.g., larger stores or frequent transit stops).

#### GOAT uses the following formulas for its impedance functions:

*Modified Gaussian, (Kwan,1998):*

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px'  }}>
    <MathJax.Node formula={"f(t_{i,j})=\\exp^{(-t_{i,j}^2/\\beta)}"} />
  </div>
</MathJax.Provider>

:::tip Pro tip

As studies have shown, the relationship between travel cost and accessibility is often non-linear. This means that people may be willing to travel a short distance to reach an amenity, but as the distance increases, their willingness to travel rapidly decreases (often disproportionately).

Leveraging the *sensitivity* you define, the Gaussian function allows you to model this aspect of real-world behaviour more accurately.

:::


*Cumulative Opportunities Linear, (Kwan,1998):*
<div>
<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={`
      f(t_{ij}) =
      \\begin{cases}
        1 - \\frac{t_{ij}}{\\bar{t}} & \\text{for } t_{ij} \\leq \\bar{t} \\\\
        0 & \\text{otherwise}
      \\end{cases}
    `} />
  </div>
</MathJax.Provider>
  </div>    

*Negative Exponential, (Kwan,1998):*


<div><MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px'  }}>
    <MathJax.Node formula={"f(t_{i,j})=\\exp^{(-\\beta t_{i,j})}"} />
  </div>
</MathJax.Provider>
    </div>  

*Inverse Power, (Kwan,1998) (`power` in GOAT):*

<div>
<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={`f(t_{ij}) = \\begin{cases}
      \\ 1 & \\text{for } t_{ij} \\leq 1 \\\\
      t_{i,j}^{-\\beta} & \\text{otherwise}
    \\end{cases}`} />
  </div>
</MathJax.Provider>
</div>  

*Cumulative Opportunities (`cumulative` in GOAT):*

<div>
<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={`f(t_{ij}) = \\begin{cases}
      1 & \\text{for } t_{ij} \\leq \\bar{t} \\\\
      0 & \\text{otherwise}
    \\end{cases}`} />
  </div>
</MathJax.Provider>
</div>

Unlike the other functions, the cumulative function applies **no distance decay** within the travel cost limit **t̄**: every reachable destination counts equally. It therefore does not use the *sensitivity (β)* parameter — it simply counts the opportunities reachable within the limit.

The *sensitivity* parameter determines how accessibility changes with increasing travel cost. As the *sensitivity* parameter is decisive when measuring accessibility, GOAT allows you to adjust this. The graph shows how the willingness to walk decreases with increasing travel cost based on the selected impedance function and sensitivity value (β).

import ImpedanceFunction from '@site/src/components/ImpedanceFunction';

<div style={{ display: 'block', textAlign: 'center'}}>
  <div style={{ maxHeight: "auto", maxWidth: "auto"}}>
    <ImpedanceFunction />
   </div> 
</div>

### Classification
In order to classify the accessibility levels that were computed for each grid cell (for color-coded visualization), a classification based on **8 quantile group is used by default**. That means, each color covers 12,5 % of the grid cells. The area outside of the computed layer has no access within the defined travel cost.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/gravity_based/gravity_default_classification.png').default} alt="gravity-default-classification" style={{ maxHeight: "auto", maxWidth: "40%"}}/>
</div>
<p></p>

However, various other classification methods may be used instead. Read more in the **[Data Classification Methods](../../map/layer_style/style/attribute_based_styling#data-classification-methods)** section of the *Attribute-based Styling* page.

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

## 5. References

Kwan, Mei-Po. 1998. “Space-Time and Integral Measures of Individual Accessibility: A Comparative Analysis Using a Point-Based Framework.” Geographical Analysis 30 (3): 191–216. [https://doi.org/10.1111/j.1538-4632.1998.tb00396.x](https://doi.org/10.1111/j.1538-4632.1998.tb00396.x).

Vale, D.S., and M. Pereira. 2017. “The Influence of the Impedance Function on Gravity-Based Pedestrian Accessibility Measures: A Comparative Analysis.” Environment and Planning B: Urban Analytics and City Science 44 (4): 740–63.  [https://doi.org/10.1177%2F0265813516641685](https://doi.org/10.1177%2F0265813516641685).

Higgins, Christopher D. 2019. “Accessibility Toolbox for R and ArcGIS.” Transport Findings, May.  [https://doi.org/10.32866/8416](https://doi.org/10.32866/8416).
