---
description: "The dataset types in GOAT: feature datasets, tables, Overture street networks, GTFS public transport networks, bundles, and WMS, WMTS, XYZ or COG rasters."
sidebar_position: 1
---

# Dataset Types

On GOAT, you can work with datasets from Plan4Better’s catalog, upload your own, or connect to an external service by URL (**WFS**, **WMS**, **WMTS**, **XYZ Tiles** or **COG**). It accepts various formats for both **Feature Datasets** and **[Raster Datasets](https://www.plan4better.de/en/glossary/raster-data)**, as well as [**Street Networks**](#street-networks) and [**Public Transport Networks**](#public-transport-networks). Here we explain the different types of datasets you can use in GOAT.

## Feature Datasets

### 1.1 Spatial Features

Feature datasets store **spatial features like points, lines, or polygons**. On GOAT you can upload data from **Shapefiles**, **Geopackages**, **GeoJSON**, **KML**, **GML**, **ZIP**, or **Parquet** files, or add a **WFS** external URL. For raster external sources (WMS, WMTS, XYZ Tiles, COG), see [Raster Datasets](#rasters-datasets) below. You can visualize, style, and analyze these datasets using the different tools from the toolbox.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/data/spatial.webp').default} alt="Spatial features in GOAT" style={{ maxHeight: "450px", maxWidth: "750px", objectFit: "cover"}}/>
  <p style={{ textAlign: 'center', fontStyle: 'italic', marginTop: '8px', color: '#666' }}> Example of spatial features displayed in GOAT</p>
</div>

<p></p>

GOAT recognizes two types of feature datasets based on their source:

- **Feature Dataset Standard**: These are the datasets you upload yourself (like GeoJSON, GPKG, KML, and ZIP files), including the layers that arrive with a [Street Network](#street-networks) or a [Public Transport Network](#public-transport-networks). Think of these as your "raw materials" - the original data you bring into GOAT to work with.

- **Feature Dataset Tool**: These are datasets created by GOAT's analysis tools. When you run an analysis (like creating [catchment areas](https://www.plan4better.de/en/glossary/catchment-area) or [heatmaps](https://www.plan4better.de/en/glossary/heatmap)), the results become this type of dataset.

### 1.2 Non-Spatial Datasets

**Tables** are **non-spatial datasets** without geographic reference points, so they can't be visualized on the map. Import them in **CSV** or **XLSX** formats for analysis and data management.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/data/table.webp').default} alt="Non-spatial datasets in GOAT" style={{ maxHeight: "450px", maxWidth: "750px", objectFit: "cover"}}/>
  <p style={{ textAlign: 'center', fontStyle: 'italic', marginTop: '8px', color: '#666' }}> Example of a table displayed in GOAT</p>
</div>

## Street Networks

A **Street Network** is a routable representation of roads, paths and cycleways. GOAT provides a built-in network, and you can import your own whenever you want [routing](https://www.plan4better.de/en/glossary/routing) to run on data you control: a network you maintain yourself, or a planned one you want to test before it is built.

Your data must follow the **[Overture](https://www.plan4better.de/en/glossary/overture-maps)** format, segments and connectors as Parquet files, packed into a `.zip` whose name contains `overture`, for example `overture.zip` or `berlin_overture.zip`. Other street data, including OpenStreetMap, is not supported at the moment.

A street network is made up of two layers that GOAT keeps together:

- **Edges**: the routable segments. This is the layer you edit when you change the network.
- **Nodes**: the points where edges meet. GOAT maintains these for you whenever you save an edge, so the network stays routable.

Street networks power GOAT's [Walking](../routing/walking), [Cycling](../routing/bicycle), [E-bike](../routing/bicycle), and [Car](../routing/car) routing. To import one, see [Adding content](../workspace/content.md#adding-content); for what GOAT's built-in network contains and how to bring your own, see [Network Datasets](./builtin_datasets.md#bringing-your-own-networks).

## Public Transport Networks

A **Public Transport Network** describes the stops, lines and timetables of a transit system. GOAT provides a built-in network, and you can import your own whenever you want to analyse a service you control: your own feed, or a timetable you are planning.

Your data must follow the **[GTFS](https://www.plan4better.de/en/glossary/gtfs)** format, packed into a `.zip` whose name contains `gtfs`, for example `gtfs.zip` or `vbb_gtfs.zip`. The `.zip` can be at most **200 MiB**: GOAT builds the timetable from the whole feed at once, so larger feeds cannot be imported.

The member layers follow the GTFS feed itself: **Stops**, **Routes**, **Trips** and **Stop times** are always present, and **Agency**, **Calendar** and **Shapes** are added when the feed provides them.

:::info A Public Transport Network needs a Street Network
GOAT connects stops to streets so that it can route the walk to and from a stop. You therefore choose a Street Network while uploading the GTFS file, either GOAT's built-in `Default` network or one of your own, which then has to be imported first.
:::

Public transport networks power GOAT's [Public Transport](../routing/public_transport) routing. To import one, see [Adding content](../workspace/content.md#adding-content); for what GOAT's built-in network contains and how to bring your own, see [Network Datasets](./builtin_datasets.md#bringing-your-own-networks).

## XPlan Plans

An **XPlan plan** is a land-use or development plan (Bebauungsplan, Flächennutzungsplan) in **XPlanGML**, the German exchange standard for planning. Upload the plan's `.gml` file, or the plan's archive: a ZIP that holds the plan as `xplan.gml`, as planning offices exchange it (XPlanArchiv). GOAT recognises an XPlan plan by its content, whatever the file is called. From an archive only the plan itself is imported, not the documents and scanned plan sheets beside it. A `.gml` that is not XPlan, or a ZIP without an `xplan.gml`, is imported as an ordinary dataset.

The plan becomes one layer for each kind of plan object it contains, named after its XPlan class, for example `BP_BaugebietsTeilFlaeche` for building areas or `BP_BauGrenze` for building limits. GOAT also makes the plan readable:

- **Codes become words.** XPlanGML stores most statements as codes, such as `1500` for the type of building area. Next to each code field, GOAT adds a field ending in `Wert` with its meaning, for example `besondereArtDerBaulNutzungWert` = `Mischgebiet`.
- **Rules travel with the areas.** Many rules, such as limits on retail, are only written as text clauses. Each area carries the text of the clauses that apply to it in `refTextInhaltWert`, and all clauses are also in their own table.
- **Every object names its plan.** Fields such as `xpPlanName`, `xpRechtsstand` and `xpAgs` tell which plan an object comes from and what state that plan is in.
- **The plan looks like a plan.** Building areas are coloured by their type of use and building limits are drawn as dashed blue lines, following the German planning symbols (PlanZV).

GOAT reads XPlanGML versions 5.0 to 6.1; a plan of another version is refused with a message naming them. GOAT imports a plan as it is and does not check it against the XPlanung rules; use the XLeitstelle's validator for that.

## Datasets made of several layers

Street Networks, Public Transport Networks and XPlan plans are all made up of **several layers that only make sense together**. GOAT calls such a dataset a **bundle** and manages it as a unit: its layers are shared together, they appear together in a project, and deleting the dataset removes all of them.

You will meet the term while working: the upload dialog confirms that a recognized file *will be imported as a bundle*, the [Catalog](../workspace/catalog.md) labels an entry holding several layers `Bundle`, and sharing or deleting one always applies to the whole set.

## Rasters Datasets

Raster datasets can be uploaded directly as **COG (Cloud Optimized GeoTIFF)** files, or connected from external sources via **WMS** (Web Map Service), **WMTS** (Web Map Tile Service), **XYZ Tiles**, or a direct **COG URL** (.tif/.tiff link). They provide georeferenced map images, such as topographic maps, but on GOAT they’re static, so they don’t support analysis or editing.

:::tip Note
In the style panel, a raster file is drawn with a color range, as categories, as a hillshade or as the image it stores, with adjustments for brightness, contrast, saturation and hue. A map service (WMS, WMTS or XYZ) sends finished pictures in its own colors, which GOAT adjusts the same way and, where the service offers several styles, switches between them. See [Raster layers and map services](../map/layer_style/style/styling.md#raster-layers-and-map-services).
:::

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/data/raster.webp').default} alt="Raster datasets in GOAT" style={{ maxHeight: "450px", maxWidth: "750px", objectFit: "cover"}}/>
  <p style={{ textAlign: 'center', fontStyle: 'italic', marginTop: '8px', color: '#666' }}> Example of a raster layer displayed in GOAT</p>

</div>

- **WMS (Web Map Service)**: Supports zooming and panning, ideal for basemaps, but outputs static images and loads slower.

- **WMTS (Web Map Tile Service)**: Uses pre-rendered tiles for fast loading and smooth zooming. Best for large areas and consistent map styles.

- **XYZ Tiles**: Offers fast zooming and panning with tiles defined by X (longitude), Y (latitude), and Z (zoom level) coordinates. Ideal for fast-loading maps with consistent performance at different zoom levels.

|   | WMS | WMTS and XYZ Tiles |
|----|-------------|--------------|
| **Type of URL in GOAT**    | Capabilities URL | Capabilities (only WMTS), Direct URL |
| **Data output** | Dynamic map images | Pre-rendered, cached map tiles |
| **Structure** | No tiles - images generated on-the-fly | Structured tiles based on grid |
| **Performance** | Slower (images generated per request) | Faster (tiles cached) |
| **Customization** | Limited | Limited |
| **Scalability** | Less scalable | Highly scalable |
| **Zoom level** | Variable, set by request parameters | Fixed zoom level, predetermined by server |