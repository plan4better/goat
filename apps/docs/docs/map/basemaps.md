---
sidebar_position: 7
---

# Basemaps

**Basemaps provide the background map layer for your project**, giving geographic context to your data — streets, terrain, satellite imagery, or a plain colour. GOAT supports any provider that offers a Style JSON URL (vector) or XYZ tile URL (raster).

## How to add a custom basemap

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the Map Interface, click the <img src={require('/img/icons/map.png').default} alt="Basemap icon" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Base map</code> button in the map navigation controls.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">At the bottom of the panel, click <code>+ Add a new basemap</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Select the <code>Basemap</code> tab. Choose <code>Vector</code> for Style JSON sources or <code>Raster</code> for XYZ tile sources.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Enter the <strong>Basemap URL</strong>, a <strong>Title</strong>, and optionally a description and thumbnail URL. Click <code>Add basemap</code> to save.</div>
</div>

:::tip Single colour background
Use the **Single Color** tab instead of a URL to set a flat colour as the map background — useful for print layouts or minimalist dashboards.
:::

## Most common providers

### Mapbox

Mapbox offers a wide range of basemap styles. Create a free account at [mapbox.com](https://www.mapbox.com) to get your access token.

**Sample URL:**
```
https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}?access_token={YOUR_ACCESS_TOKEN}
```

:::info Access token visibility
Basemaps added to a **shared or public project** will expose your Mapbox access token to viewers. In your Mapbox account, restrict the token to your domain to prevent unauthorised usage.
:::

---

### MapTiler

MapTiler provides high-quality vector basemaps that work seamlessly with GOAT's map engine. Create a free account at [maptiler.com](https://www.maptiler.com) to get your API key.

**Sample URL:**
```
https://api.maptiler.com/maps/streets-v2/style.json?key={YOUR_API_KEY}
```

:::info API key visibility
Your MapTiler API key will be visible in shared projects. Use MapTiler Cloud's key restriction settings to limit usage to your domain.
:::

---

### Esri / ArcGIS

Esri provides a variety of professional basemaps — no account or API key required.

**Sample URL:**
```
https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
```

---

### OpenStreetMap

OpenStreetMap (OSM) provides free, community-maintained basemaps — no account or API key required.

**Sample URL:**
```
https://tile.openstreetmap.org/{z}/{x}/{y}.png
```

:::info Tile usage policy
OpenStreetMap's tile servers are intended for light use. For production or high-traffic projects, consider a hosted provider such as [OpenFreeMap](#openfreemap) or [MapTiler](#maptiler), which offer OSM-based styles with better reliability.
:::

---

### OpenFreeMap

OpenFreeMap serves free vector basemaps built from OpenStreetMap data — no account, no API key and no usage limit. Its tiles follow the same OpenMapTiles schema the commercial providers use, so styles are largely interchangeable between them. GOAT's own built-in vector basemaps are served from here.

**Sample URL:**
```
https://tiles.openfreemap.org/styles/liberty
```

Available styles: `liberty`, `bright`, `positron`, `dark` and `fiord`.

:::info No service guarantee
OpenFreeMap is a donation-funded service with no uptime guarantee. Its tiles are served behind a CDN and cached, and the whole planet is published for self-hosting if you need to run it yourself.
:::

---

### Carto Dark Matter

Carto's Dark Matter style offers a dark, minimal basemap well suited to data-heavy maps where bright data visualisations need to stand out — no account or API key required.

**Sample URL:**
```
https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json
```

:::tip More providers
For a broader list of compatible basemap providers and connection guides, see the [GOAT blog post on where to find basemaps](https://www.plan4better.de/en/post/where-to-find-basemaps).
:::

## Arrange basemap layers

When editing a custom basemap, the **Layer** tab lets you control how each sub-layer group of that basemap is stacked relative to your own data layers — and toggle individual groups on or off.

To access it, click the edit icon on a custom basemap in the basemap panel, then select the **Layer** tab.

The basemap is organised into five layer groups:

| Group | Contents |
|-------|----------|
| **Streets** | Road network, paths |
| **Waters** | Rivers, lakes, coastlines |
| **Land Use** | Forests, parks, fields |
| **Buildings** | Building footprints |
| **Other** | Remaining layers |

For each group you can:
- **Toggle visibility** — show or hide the group entirely using the switch on the right
- **Position** — choose `Above` or `Below` to control whether the group renders above or below your own layers
- **Reference layer** — select which of your layers acts as the boundary (defaults to *All my layers*)

Click **Reset** to restore all groups to their default positions and visibility.

:::tip When is this useful?
Place **Streets** above your data to keep roads legible over polygon overlays. Place **Buildings** below your own layers so your data appears on top of building footprints.
:::

## Basemaps in shared dashboards

When you share a project as a public dashboard via the **Dashboard**, you can control which basemaps viewers are allowed to switch between. In the **Dashboard**, open the **Settings** tab and find the **Allowed basemaps** field. Select the basemaps you want to make available — if no restriction is set, all basemaps are shown to viewers.
