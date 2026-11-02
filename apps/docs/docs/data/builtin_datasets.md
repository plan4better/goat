---
sidebar_position: 3
sidebar_label: Network Datasets
description: "The built-in public transport and street networks behind GOAT's routing, their sources and processing, and how to import your own Overture or GTFS network."
---

# Network Datasets

## The foundation behind GOAT's Indicators

GOAT's accessibility indicators and analysis tools rely on high-quality network datasets that work behind the scenes. **GOAT ships with built-in networks covering public transport and streets, and you can [import your own](#bringing-your-own-networks) when you want an analysis to run on data you control.**

Understanding these underlying datasets helps you:
- **Know what data quality** to expect from GOAT's indicators
- **Understand the geographic coverage** of different analysis tools
- **Interpret results** with knowledge of the data sources

:::info Networks vs. your own datasets
This page is about the **network datasets** behind GOAT's [routing](https://www.plan4better.de/en/glossary/routing) and [accessibility analyses](https://www.plan4better.de/en/glossary/accessibility-analysis). To upload ordinary datasets of your own, or to use ready-made ones, see [Content](../workspace/content.md) and the [Catalog](../workspace/catalog.md).
:::

## GOAT's built-in networks

GOAT includes comprehensive network datasets that power all routing-based accessibility indicators and analysis tools.

### Public Transport Network

Our public transport network covers multiple modes including buses, trams, subways, trains, and ferries. This network enables GOAT's [Public Transport](../routing/public_transport) routing capabilities.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/data/data_basis/pt_network_banner.webp').default} alt="Public Transport Network" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

**What's Included:**
- **Stops**: Names, locations, types, and accessibility information
- **Routes**: Service types, accessibility details, and route information  
- **Schedules**: Departure times, service frequency, and operating days
- **Transfers**: Interchange specifications and station connections
- **Trip Patterns**: Stop sequences and timing information
- **Route Shapes**: Geospatial representation of transit lines

**Data Sources:**
- **Germany**: [DELFI](https://www.delfi.de/) - Germany's national public transport data platform
- **Street-level Data**: [OpenStreetMap (OSM)](https://wiki.openstreetmap.org/) - For station access, pedestrian connections, and multi-modal routing

**How We Process the Data:**
1. **Import**: Data is collected in [GTFS (General Transit Feed Specification)](https://gtfs.org/) format
2. **Verify & Correct**: We validate stop relationships, platform connections, and service type classifications
3. **Optimize**: Networks are streamlined to include only the most representative service patterns for each route
4. **Schedule Types**: Analysis supports three day types - **Weekday** (typically Tuesday), **Saturday**, and **Sunday**

### Street Network and Topography

Our street network represents real-world transportation infrastructure including roads, highways, bike paths, and pedestrian ways. This powers GOAT's [Walking](../routing/walking), [Cycling](../routing/bicycle), [E-bike](../routing/bicycle), and [Car](../routing/car) routing.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/data/data_basis/street_network_banner.png').default} alt="Street Network" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

**Network Components:**
- **Segments (Edges)**: Continuous path sections between intersections
- **Intersections (Nodes)**: Points where different paths meet or cross

**Data Sources:**
- **Street Networks**: [Overture Maps Foundation](https://overturemaps.org/) - High-quality, Europe-wide transportation data
- **Elevation Data**: [Copernicus](https://www.copernicus.eu/en) Digital Elevation Model (DEM) for accurate slope calculations

**Processing Workflow:**
1. **Data Import**: Street network data is imported in [Geoparquet](https://www.plan4better.de/en/glossary/geoparquet) format from [Overture Maps](https://www.plan4better.de/en/glossary/overture-maps)' [Transportation theme](https://docs.overturemaps.org/guides/transportation/)
2. **Elevation Processing**: European DEM tiles are processed to extract topographical information
3. **Spatial Indexing**: Network segments are organized using [Uber's H3 grid system](https://www.plan4better.de/en/glossary/h3-grid) for efficient processing
4. **Slope Calculation**: Surface gradients and slope impedance are computed for each street segment
5. **Attribute Parsing**: Street classifications, speed limits, turning restrictions, and one-way designations are identified and standardized
6. **Speed Limit Interpolation**: Missing speed limits are estimated based on street type and modal speeds

## Bringing your own networks

The networks described above are GOAT's built-in ones, and they are used by default. You can also **import your own**: a network you maintain yourself, a region you want to analyse with your own data, or a planned network you want to test before it is built.

Once imported, your network is used exactly like the built-in one: the routing and accessibility tools offer it alongside the built-in one (`Default (Europe)` for street networks, `Default` for public transport), and you pick which one an analysis should run on.

### Your own street network

Your data must follow the [Overture Maps schema](https://docs.overturemaps.org/). There are two ways to obtain it:

**Ask us for an export.** Tell Plan4Better which region you need and we prepare a file you can upload directly. This needs nothing installed and is the quickest route if you would rather not handle the data yourself.

**Fetch it yourself.** Install the [overturemaps command-line tool](https://docs.overturemaps.org/getting-data/overturemaps-py/), find the bounding box for your area with a tool such as [boundingbox.klokantech.com](https://boundingbox.klokantech.com/) in CSV format, then download the two layers GOAT needs and pack them together:

```bash
overturemaps download --bbox=<your region> -f geoparquet --type=segment -o segment.geoparquet
overturemaps download --bbox=<your region> -f geoparquet --type=connector -o connector.geoparquet
zip -j overture.zip ./segment.geoparquet ./connector.geoparquet
```

Use the same bounding box for both downloads. Segments and connectors have to cover the same extent, or the network will not join up.

Once imported, a street network can be **edited on the map**: draw a street and GOAT splits and joins the topology, maintains the nodes, and rebuilds the routing data from what you changed. That makes it possible to test a planned connection, such as a new bridge, a closed street or a cycleway, and re-run an analysis on the result.

### Your own public transport network

Your data must be a feed following the [official GTFS specification](https://gtfs.org/documentation/schedule/reference/). Feeds usually come from one of three places:

**Ask us for an export.** Tell Plan4Better which region you need and we prepare a file you can upload directly. This is the quickest route if you would rather not track a feed down yourself.

**Go to the source.** Transit agencies publish their own feeds, and many countries collect them nationally. In Germany, [DELFI](https://www.delfi.de/) does this for the whole country. This gives you the most current data and the clearest licensing.

**Use an aggregator.** The [Mobility Database](https://mobilitydatabase.org/) and [transit.land](https://www.transit.land/) index feeds from operators worldwide, which is the easiest way to find one when you do not already know who publishes it.

Because GOAT routes the walk to and from each stop, a public transport network has to be **linked to a street network**. You choose that network while uploading: the built-in `Default (Europe)`, or one you have imported beforehand.

:::info Outside Europe, upload a street network first
The built-in `Default (Europe)` network covers Europe only. If your transit data is for a region outside that, import a street network for the region before importing the feed. There will otherwise be nothing to connect the stops to.
:::

Linking to your own street network is also what lets a timetable analysis account for streets you changed.

Once imported, a public transport network can be opened in the [PT Network Explorer](../toolbox/pt_network_explorer.md) from its bundle in a project: browse its lines, stations and timetables, play its vehicles on the map and estimate its operating cost.

For the file formats these networks are imported from and the layers they are made of, see [Dataset Types](./dataset_types.md#street-networks). For the import steps, see [Adding content](../workspace/content.md#adding-content).
