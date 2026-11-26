---
description: "Aggregate point data onto polygons or an H3 grid and calculate the count, sum, mean, min, max or standard deviation of a point attribute for each area."
sidebar_position: 1
---
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Aggregate Points

The Aggregate Points tool **performs statistical analysis of points, e.g. count, sum, min, or max, and aggregates the information on polygons.**

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/_ybPf_fuMLA?si=mX1-uugIA5LiCKss" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## 1. Explanation

The Aggregate Points tool can be used to **analyze the characteristics of points within a given area**. It aggregates the information of the points and therewith allows calculation of the point count, the sum of point attributes, or derive e.g. the maximum value of a certain point attribute within a polygon. As a polygon layer, either a feature layer (e.g. city districts) or a hexagonal grid can be used. 

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>

  <img src={require('/img/toolbox/geoanalysis/aggregate_points/point_aggregation.webp').default} alt="Point Aggregation" style={{ maxHeight: "auto", maxWidth: "40%", objectFit: "cover"}}/>

</div> 


## 2. Example use cases

- Aggregating the population numbers on a hexagon grid.
- Deriving the sum of traffic accidents within a city district.
- Visualizing the average number of carsharing vehicles available per station on a district level. 

## 3. How to use the tool?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click on <code>Tools</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Under the <code>Geoanalysis</code> menu, click on <code>Aggregate Points</code>.</div>
</div>

### Layer to Aggregate

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Select your <code>Input Point Layer</code>, which contains <strong>the points you like to aggregate</strong>.</div>
</div>

### Summary Areas

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Select the <code>Area Type</code> on which you like to aggregate the points. You can choose between <b>Polygon</b> or <b>H3 Grid</b>.</div>
</div>

<Tabs>
  <TabItem value="Polygon" label="Polygon" default className="tabItemBox">

Select the <code>Area Layer</code> which contains the polygons on which you like to aggregate your point data. A point on the shared boundary of two or more areas is counted in one of them.


  </TabItem>
  <TabItem value="H3 Grid" label="H3 Grid" className="tabItemBox">

Select the <code>H3 Resolution</code>. You can choose resolutions between 3 (average edge length of 69km) and 10 (average edge length of 70m). Higher values create smaller hexagons.

:::tip NOTE

To learn more about the H3 grid, you can visit the [Glossary](https://www.plan4better.de/en/glossary/h3-grid).

:::

  </TabItem>
</Tabs>

### Statistics

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Under <code>Statistics Configuration</code>, select the <code>Operation</code>. For all operations except <b>Count</b>, also select the <code>Field</code> of the point layer to calculate the statistic on. Only numeric fields can be selected.</div>
</div>

The following **operations** are available:

| Operation          | Field    | Description                                                    |
| ------------------ | -------- | -------------------------------------------------------------- |
| Count              | –        | Counts the points in each area                                 |
| Sum                | `number` | Calculates the sum of the values of the selected field         |
| Min                | `number` | Yields the minimum value of the selected field                 |
| Max                | `number` | Yields the maximum value of the selected field                 |
| Mean               | `number` | Calculates the average (mean) value of the selected field      |
| Standard Deviation | `number` | Calculates the standard deviation of the selected field        |

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Optionally, enter a <code>Result Name</code> for the result column. If you leave it empty, the column is called <code>count</code> for Count and <code>&lt;field&gt;_&lt;operation&gt;</code> otherwise (e.g. <code>population_sum</code>).</div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">To calculate further statistics in the same run, click on <code>Add Statistics Configuration</code> and repeat steps 5 and 6. You can add up to 30 statistics; to remove one, click the trash icon above it.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Optionally, click the options icon <img src={require('/img/icons/options.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> in the <code>Statistics</code> header and select up to three <code>Group Fields</code> of the point layer. The statistics are then additionally calculated per group (per combination of values of these fields).</div>
</div>

### Results

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Optionally, change the <code>Result layer name</code> (default: <b>Aggregate Points</b>).</div>
</div>

<div class="step">
  <div class="step-number">10</div>
  <div class="content">Click on <code>Run</code>.</div>
</div>

As soon as the calculation process is finished, the resulting polygon layer is added to the map. It contains **one additional column per statistic** and is colored by the first statistic. You can see the values by clicking on a polygon on the map.

- With the area type **Polygon**, the result contains all polygons of the area layer with their attributes. Areas without points get 0 for **Count** and **Sum** and no value for **Mean**, **Minimum**, **Maximum** and **Standard deviation**. An area with a single point has no value for **Standard deviation**, and an area whose points all lack a value in the selected field has no value for **Mean**, **Minimum**, **Maximum** and **Standard deviation**.
- With the area type **H3 Grid**, the result contains the hexagons that contain at least one point. The column <code>h3_&lt;resolution&gt;</code> (e.g. <code>h3_8</code>) holds the ID of the hexagon.
- If you selected <code>Group Fields</code>, an additional column <code>&lt;result column&gt;_grouped</code> holds the value of each group.

<img src={require('/img/toolbox/geoanalysis/aggregate_points/aggregate_points_result.webp').default} alt="Point Aggregation Result in GOAT" style={{ maxHeight: "auto", maxWidth: "auto"}}/>

<p></p>

:::tip Tip
Want to style your result layer and create nice-looking maps? See [Styling](../../map/layer_style/style/styling).
:::