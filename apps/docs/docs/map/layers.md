---
sidebar_position: 2
---


import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';


# Layers

**In the Layers section, layers can be added and organized**. Among others, the layer order can be adjusted, layers can be enabled/disabled, duplicated, renamed, downloaded, and removed.

<iframe width="100%" height="500" src="https://www.youtube.com/embed/McjAUSq2p_k?si=2hh0hU10l95Tkjqt" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>



## How to manage your Layers

The Layers Panel is your central hub for organizing and controlling all the data in your GOAT project. Here you can **add new datasets, arrange layer order for optimal visualization, group related layers together, and control visibility**.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/layers/add_layer.webp').default} alt="Add layers in GOAT" style={{ maxHeight: "flex", maxWidth: "flex", objectFit: "cover"}}/>
</div>

### Add Layers

You can add layers from [different sources](../data/dataset_types) to your map. You can either:
- Integrate **datasets from your data explorer or the catalog explorer**
- Upload new **datasets from your local device** (GeoPackage, GeoJSON, Shapefile, KML, CSV, or XLSX). 
- Add external layers by inserting the **url of the external source** (WMS, WMTS, or MVT).



<p></p>

<div class="step">
  <div class="step-number">1</div>
  <div class="content">On the left panel, click on <code>+ Add Layer</code> to <strong>open the layer options</strong>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Select if you like to integrate a dataset using the: <code>Data Explorer</code>, <code>Dataset Upload</code>, <code>Dataset External</code> or <code>Dataset Catalog</code> to <strong>choose your data source</strong>.</div>
</div>

<Tabs>
  <TabItem value="Dataset Explorer" label="Dataset Explorer" default className="tabItemBox">


<div class="step">
  <div class="step-number">3</div>
  <div class="content">Select the file you want to <strong>import</strong>.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Click on <code>+ Add Layer</code> to <strong>add the selected file</strong>.</div>
</div>


</TabItem>
<TabItem value="Dataset Upload" label="Dataset Upload" className="tabItemBox">


<div class="step">
  <div class="step-number">3</div>
  <div class="content">Select the file you want to <strong>import</strong>.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Define the name of the dataset and <strong>add a description</strong>, if you like.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Check the information and click on <code>Upload</code> to <strong>upload the dataset</strong>.</div>
</div>


  </TabItem>
  <TabItem value="Catalog Explorer" label="Catalog Explorer" className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Browse <code>GOAT Dataset Catalog</code> to <strong>explore available datasets</strong>.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Select the Dataset you want to <strong>import</strong>.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Click on <code>+ Add Layer</code> to <strong>add the selected dataset</strong>.</div>
</div>


 </TabItem>
  <TabItem value="Dataset External" label="Dataset External" default className="tabItemBox">
  
<div class="step">
  <div class="step-number">3</div>
  <div class="content">Insert your <code>external URL</code> and <strong>follow the steps</strong> depending on the type of dataset you would like to add.</div>
</div>

<Tabs>
  <TabItem value="WFS" label="WFS" default className="tabItemBox">

  <div class="step">
      <div class="content"> <p>When you would like to add a WFS layer you need to have a <strong>GetCapabilities</strong> link. </p>
      In the next step you can choose which layer you would like to add to your dataset. <strong>You can only choose one layer at a time.</strong></div>
      </div>
     </TabItem>

  <TabItem value="WMS" label="WMS" className="tabItemBox">
     
  <div class="step">
      <div class="content"> <p>When you would like to add a WMS layer you need to have a <strong>GetCapabilities</strong> link.</p> Here you have the option to select multiple layers, but when added to GOAT it <strong>will be merged onto one layer.</strong> </div>
      </div>
      </TabItem>

  <TabItem value="WMTS" label="WMTS" className="tabItemBox">

  <div class="step">
      <div class="content"> <p>You can add a WMTS to your dataset via a <strong>direct URL</strong> or <strong>GetCapabilities</strong> link. You can only choose *one layer* at a time if your URL contains more than one layer.</p>
      The projection needs to be <strong>WEB Mercator (EPSG:3857) and GoogleMaps compatible</strong>. Because they have different zoom levels, the dataset would not show up in the list of available layers if it doesn't meet both requirements.</div>
      </div>
    </TabItem>
  </Tabs>
</TabItem>
</Tabs>

:::tip tip

You can manage all your datasets on the [Datasets page](../workspace/datasets). 

:::

### Order Layers

When visualizing several data sets at once, the layer order is crucial for creating clear, readable maps. Therefore, **the layer order can be changed interactively**.

<strong> Click on the layer</strong> you want to move, then <strong>drag and drop</strong> the layer to your desired position.

### Show / Hide Layers

Click the <img src={require('/img/icons/eye.png').default} alt="Add layers in GOAT" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> icon next to the layer name to  <strong>temporarily hide</strong> a layer from the map view. Clicking the eye again will <strong>make the layer visible</strong> again.

### Group Layers

Click the <img src={require('/img/icons/layer.png').default} alt="Group layers" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code> Group Layers</code> button on top of the Layers Panel to **create layer groups** that help organize related datasets together. 

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click the <code>Group Layers</code> button <img src={require('/img/icons/layer.png').default} alt="Group layers" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> at the top of the Layers Panel.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Enter a <strong>name for your layer group</strong> in the dialog that appears.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Click <code>Create</code> to <strong>create the new layer group</strong>.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content"><strong>Drag and drop layers</strong> from the main layers list into your newly created group to organize them.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Use the <strong>expand/collapse arrow</strong> next to the group name to show or hide the group contents.</div>
</div>

### Layer Options

By clicking on <img src={require('/img/icons/3dots.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>more options</code> icon next to each layer you have further options to <strong>manage and organize</strong> the selected layer.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/map/layers/layer_options.webp').default} alt="Layer Options" style={{ maxHeight: "250px", maxWidth: "250px", objectFit: "cover", alignItems: 'center'}}/>
</div>

<p></p>

:::tip tip

Want to change the design of your layers? See [Layer Style](../category/style).  
Only want to visualize parts of your dataset? See [Filter](./filter). 

:::
