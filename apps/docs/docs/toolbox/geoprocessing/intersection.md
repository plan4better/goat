---
sidebar_position: 4
---

# Intersection

This tool allows you to **compute the geometric intersection of features from two layers**.

## 1. Explanation

Computes the **geometric intersection of two vector layers.** The output contains only the areas where both input layers overlap. Unlike Clip, the attributes from **both** layers are combined and retained in the output features.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

  <img src={require('/img/toolbox/geoprocessing/intersection.png').default} alt="Buffer Types" style={{ maxHeight: "400px", maxWidth: "400px", objectFit: "cover"}}/>

</div> 

## 2. Example use cases 

- Find areas where a proposed development overlaps with protected environmental zones.
- Identify properties that are within a specific flood risk zone.

## 3. How to use the tool?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click on <code>Toolbox</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Under the <code>Geoprocessing</code> menu, click on <code>intersection</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Select the <code>Input layer</code> you want to clip.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Select the <code>Overlay layer</code> you want to use as a second input.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Optionally, switch the toggle on <code>Field Selection</code> to choose which attributes to include in the output:
    <ul>
      <li>Select specific fields from the <code>Input layer</code> to keep in the result</li>
      <li>Select specific fields from the <code>Overlay layer</code> to keep in the result</li>
      <li>Modify the <code>Overlay Fields Prefix</code> if needed to avoid naming conflicts (default: "intersection_")</li>
    </ul>
  </div>
</div>

:::tip Note

If no fields are selected, all attributes from both layers will be included in the output.

:::
    

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Click <code>Run</code> to execute the intersection. Result will be added to the map.</div>
</div>
