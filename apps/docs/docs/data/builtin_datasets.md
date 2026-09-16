---
sidebar_position: 3
sidebar_label: Network Datasets
---

# Network Datasets

## The foundation behind GOAT's Indicators

GOAT's accessibility indicators and analysis tools rely on high-quality network datasets that work behind the scenes. **GOAT ships with built-in networks covering public transport and streets, and you can [import your own](#bringing-your-own-networks) when you want an analysis to run on data you control.**

Understanding these underlying datasets helps you:
- **Know what data quality** to expect from GOAT's indicators
- **Understand the geographic coverage** of different analysis tools
- **Interpret results** with knowledge of the data sources

:::info Networks vs. your own datasets
This page is about the **network datasets** behind GOAT's routing and accessibility analyses. To upload ordinary datasets of your own, or to use ready-made ones, see [Content](../workspace/content.md) and the [Catalog](../workspace/catalog.md).
:::

## GOAT's built-in networks

GOAT includes comprehensive network datasets that power all routing-based accessibility indicators and analysis tools.

### Public Transport Network

Our public transport network covers multiple modes including buses, trams, subways, trains, and ferries. This network enables GOAT's [Public Transport](../routing/public_transport) routing capabilities.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/data/data_basis/pt_network_banner.png').default} alt="Public Transport Network" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
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
1. **Data Import**: Street network data is imported in Geoparquet format from Overture Maps' [Transportation theme](https://docs.overturemaps.org/guides/transportation/)
2. **Elevation Processing**: European DEM tiles are processed to extract topographical information
3. **Spatial Indexing**: Network segments are organized using [Uber's H3 grid system](../further_reading/glossary#h3-grid) for efficient processing
4. **Slope Calculation**: Surface gradients and slope impedance are computed for each street segment
5. **Attribute Parsing**: Street classifications, speed limits, turning restrictions, and one-way designations are identified and standardized
6. **Speed Limit Interpolation**: Missing speed limits are estimated based on street type and modal speeds

## Bringing your own networks

The networks described above are GOAT's built-in ones, and they are used by default. You can also **import your own** — a network you maintain yourself, a region you want to analyse with your own data, or a planned network you want to test before it is built.

Once imported, your network is used exactly like the built-in one: the routing and accessibility tools offer it alongside `Default (Europe)`, and you pick which one an analysis should run on.

### Your own street network

Your data must follow the [Overture Maps schema](https://docs.overturemaps.org/). There are three ways to obtain it:

**Ask us for an export.** Tell Plan4Better which region you need and we prepare a file you can upload directly. This needs nothing installed and is the quickest route if you would rather not handle the data yourself.

**Fetch it yourself.** Install the [overturemaps command-line tool](https://docs.overturemaps.org/getting-data/overturemaps-py/), find the bounding box for your area with a tool such as [boundingbox.klokantech.com](https://boundingbox.klokantech.com/) in CSV format, then download the two layers GOAT needs and pack them together:

```bash
overturemaps download --bbox=<your region> -f geoparquet --type=segment -o segment.geoparquet
overturemaps download --bbox=<your region> -f geoparquet --type=connector -o connector.geoparquet
zip -j overture.zip ./segment.geoparquet ./connector.geoparquet
```

Use the same bounding box for both downloads — segments and connectors have to cover the same extent, or the network will not join up.

**Let an AI assistant do it.** If you work with a coding assistant that can run commands — Claude Code, Cursor, Copilot in agent mode — copy the prompt below, fill in your region, and paste it in. The assistant runs the steps above and hands you the finished `.zip`.

<details>
<summary>Prompt for an AI assistant</summary>

```text
Produce a single file, overture.zip, containing Overture Maps transportation
data for the region below, ready to upload to a GOAT project.

REGION: <your area of interest, e.g. Munich, Germany>

Work through these steps in order. Run the commands yourself, show me the real
output, and stop if any step fails.

1. Install the overturemaps CLI in an isolated environment:
     python3 -m venv .overture-venv
     source .overture-venv/bin/activate
     pip install --upgrade pip
     pip install overturemaps
   Confirm with: overturemaps --help

2. Work out the bounding box for the region, in EPSG:4326, in the order
   west,south,east,north. You can look it up with Nominatim:
     curl -s 'https://nominatim.openstreetmap.org/search?q=PLACE&format=json&limit=1' \
       -H 'User-Agent: goat-docs/1.0' \
     | python3 -c "import sys,json; b=json.load(sys.stdin)[0]['boundingbox']; print(f'{b[2]},{b[0]},{b[3]},{b[1]}')"
   Nominatim returns [south,north,west,east], so the values must be reordered,
   not copied. Show me the box and roughly what area it covers before going on.
   Warn me if it spans more than about 1 degree in either direction, since the
   download will then be very large.

3. Download the segments:
     overturemaps download --bbox=BBOX -f geoparquet --type=segment -o segment.geoparquet

4. Download the connectors, using the exact same bounding box:
     overturemaps download --bbox=BBOX -f geoparquet --type=connector -o connector.geoparquet

5. Check both files exist and are not empty:
     ls -lh segment.geoparquet connector.geoparquet
   An empty file usually means the coordinates were in the wrong order. If that
   happens, go back to step 2 rather than continuing.

6. Build the archive from the two filenames explicitly, never with a wildcard:
     rm -f segment.geoparquet.state connector.geoparquet.state
     zip -j overture.zip ./segment.geoparquet ./connector.geoparquet
     unzip -l overture.zip
   The listing must show exactly segment.geoparquet and connector.geoparquet.

7. Tell me the path to overture.zip, its size, the bounding box used, and the
   row count of each layer.
```

</details>

Once imported, a street network can be **edited on the map**: draw a street and GOAT splits and joins the topology, maintains the nodes, and rebuilds the routing data from what you changed. That makes it possible to test a planned connection — a new bridge, a closed street, a cycleway — and re-run an analysis on the result.

### Your own public transport network

Your data must be a feed following the [official GTFS specification](https://gtfs.org/documentation/schedule/reference/). Feeds usually come from one of three places:

**Ask us for an export.** Tell Plan4Better which region you need and we prepare a file you can upload directly. This is the quickest route if you would rather not track a feed down yourself.

**Go to the source.** Transit agencies publish their own feeds, and many countries collect them nationally — in Germany, [DELFI](https://www.delfi.de/) does this for the whole country. This gives you the most current data and the clearest licensing.

**Use an aggregator.** The [Mobility Database](https://mobilitydatabase.org/) and [transit.land](https://www.transit.land/) index feeds from operators worldwide, which is the easiest way to find one when you do not already know who publishes it.

Because GOAT routes the walk to and from each stop, a public transport network has to be **linked to a street network**. You choose that network while uploading, so the street network has to exist first.

:::info Outside Europe, upload a street network first
The built-in `Default (Europe)` network covers Europe only. If your transit data is for a region outside that, import a street network for the region before importing the feed — there will otherwise be nothing to connect the stops to.
:::

Linking to your own street network is also what lets a timetable analysis account for streets you changed.

For the file formats these networks are imported from and the layers they are made of, see [Dataset Types](./dataset_types.md#street-networks). For the import steps, see [Adding content](../workspace/content.md#adding-content).
