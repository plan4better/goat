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

You can add layers from [different sources](../data/dataset_types) to your map:

**New data**

- **Upload file**: a dataset from your device (GeoPackage, GeoJSON, Shapefile, KML, CSV, XLSX, Parquet, and GTFS or Overture archives)
- **Create layer**: a new empty layer you draw into
- **Connect service**: a layer served by WFS, WMS, WMTS, XYZ Tiles or COG, added by URL

**Existing data**

- **My datasets**: anything already in your spaces
- **Catalog**: ready-made datasets from official providers

<div class="step">
  <div class="step-number">1</div>
  <div class="content">On the left panel, click <code>+ Add layer</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Choose where the layer comes from.</div>
</div>

<Tabs>
  <TabItem value="Upload" label="Upload file" default className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Drag a file onto the drop zone, or click to choose one. The supported formats are listed above it.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Give the dataset a name and, if you like, a description. For a CSV or XLSX you can also open <code>Set up columns</code> to pick the worksheet and say whether the first row holds column names.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Click <code>Upload</code>.</div>
</div>

<div class="content"><strong>Street networks and GTFS feeds:</strong> a GTFS or Overture archive is imported as a <a href="../data/dataset_types#datasets-made-of-several-layers">bundle</a> rather than a single layer, and a public transport feed asks you to link it to a street network. See <a href="../data/builtin_datasets#bringing-your-own-networks">Network Datasets</a> for where to get this data and what happens on import.</div>

  </TabItem>
  <TabItem value="Create" label="Create layer" className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Enter a <strong>layer name</strong>, select the <strong>geometry type</strong> (<code>Point</code>, <code>Line</code>, <code>Polygon</code>, or <code>Table</code>), and define your <strong>fields</strong>. For full details, see <a href="./layer_editing">Layer Editing</a>.</div>
</div>

  </TabItem>
  <TabItem value="My datasets" label="My datasets" className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Browse or search your spaces for the dataset you want.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Select one or more and click <code>Add layer</code> (<code>Add 3 layers</code> when you have selected three).</div>
</div>

  </TabItem>
  <TabItem value="Catalog" label="Catalog" className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Search and filter the <a href="../workspace/catalog">Catalog</a> for the dataset you need. The same filters as the Catalog page are available here.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Select one or more datasets and click <code>Add layer</code>. GOAT prepares a copy for your project; the layer reads <code>Preparing data …</code> while that runs.</div>
</div>

  </TabItem>
  <TabItem value="External" label="Connect service" className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Enter the <code>URL</code> of the service, then follow the steps for the kind of source you are adding.</div>
</div>

<Tabs>
  <TabItem value="WFS" label="WFS" default className="tabItemBox">
    <div class="step">
      <div class="content"><p>A WFS layer needs a <strong>GetCapabilities</strong> link.</p>You then choose which layer to add. <strong>Only one layer can be added at a time.</strong></div>
    </div>
  </TabItem>

  <TabItem value="WMS" label="WMS" className="tabItemBox">
    <div class="step">
      <div class="content"><p>A WMS layer also needs a <strong>GetCapabilities</strong> link.</p>You can select several layers here, but GOAT <strong>merges them into one</strong>.</div>
    </div>
  </TabItem>

  <TabItem value="WMTS" label="WMTS" className="tabItemBox">
    <div class="step">
      <div class="content"><p>A WMTS can be added by <strong>direct URL</strong> or <strong>GetCapabilities</strong> link. If the URL carries more than one layer, only one can be added at a time.</p>The projection must be <strong>Web Mercator (EPSG:3857)</strong> and GoogleMaps compatible. Zoom levels differ otherwise, so a source that does not meet both will not appear in the list.</div>
    </div>
  </TabItem>

  <TabItem value="XYZ" label="XYZ" className="tabItemBox">
    <div class="step">
      <div class="content"><p>An <strong>XYZ Tiles</strong> layer is any tile URL with <code>&#123;z&#125;/&#123;x&#125;/&#123;y&#125;</code> placeholders. The address is the layer, so there is no list to choose from &mdash; check the preview shows what you expect.</p></div>
    </div>
  </TabItem>

  <TabItem value="COG" label="COG" className="tabItemBox">
    <div class="step">
      <div class="content"><p>A <strong>Cloud Optimized GeoTIFF (COG)</strong> is added by a direct <code>.tif</code>/<code>.tiff</code> link. The file is read in pieces straight from where it is stored, so nothing is uploaded to GOAT.</p></div>
    </div>
  </TabItem>
</Tabs>

  </TabItem>
</Tabs>

:::tip tip

You can manage all your datasets on the [Content page](../workspace/content). 

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
<img src={require('/img/map/layers/layer_options.webp').default} alt="Layer Options" style={{ maxHeight: "auto", maxWidth: "420px", objectFit: "cover", alignItems: 'center'}}/>
</div>

<p></p>

:::tip tip

Want to change the design of your layers? See [Layer Style](../category/style).  
Only want to visualize parts of your dataset? See [Filter](./filter). 

:::

### Edit Features

Use <code>Edit features</code> from the layer's <code>more options</code> menu to update feature data directly on the map.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click <code>Edit features</code> in the layer options to <strong>start editing mode</strong>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click a feature on the map to <strong>open its attributes</strong> in the right-side panel.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Update the values you want to change in the <code>Feature attributes</code> panel.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Click <code>Done</code> to confirm the feature edit.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Click <code>Save</code> to apply all pending changes, or <code>Discard</code> to cancel them.</div>
</div>
