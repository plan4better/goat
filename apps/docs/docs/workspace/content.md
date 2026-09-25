---
sidebar_position: 3
---

# Content

The **Content** page is where your projects, datasets and templates live. Everything you can reach is organised into **spaces**: your own, your teams', and your organisation's. Content belongs to a space rather than to you personally, so it stays where it is when people join or leave.

From the Content page you can:

- **Browse everything in a space**, in folders you organise yourself
- **See what other people have shared with you**, and what you opened recently
- **Share, move, rename, transfer or delete** the content you are responsible for
- **Restore** anything you deleted by mistake

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workspace/content/content_general.webp').default} alt="The Content page in GOAT" style={{ maxHeight: "auto", maxWidth: "100%"}}/>
</div>

## Spaces

You can reach three kinds of space:

- **My Content** is yours. What you create lands here unless you put it somewhere else.
- **Team spaces**, one per team you belong to. Everyone in the team can reach what the space holds.
- **Organization**, shared across everyone in your organisation.

Three further views search across all of them at once, which saves knowing where something lives: **Shared with me** for anything other people have given you access to, **Recent** for what you opened lately, and **Trash** for what you deleted but can still get back.

Opening a space shows what it holds, grouped by kind: **Folders**, **Projects**, **Templates** and **Datasets**. Each group carries a count and can be collapsed, a group with nothing in it is left out, and `Load more` fetches the rest of a long one.

A fifth group, **Shortcuts**, appears only once something has been transferred out of the space. See [Sharing and transferring](#sharing-and-transferring-are-different).

## Finding your way around

The toolbar above the content offers:

- **Search** within the space you are in
- **Grid** or **List** view
- **Filter** by content type
- **Sort**, by `Last updated` and other options
- **Details**, which opens a panel describing the selected item
- **Add new**, to create a project, upload a dataset or add a folder

## Managing content

Select an item, or several, to act on them. The kebab menu on a card and the action bar offer:

| Action | What it does |
|--------|--------------|
| **Share** | Gives other people access. You stay the owner. |
| **Move** | Puts the item in a different folder. |
| **Rename** | Changes its name. |
| **Transfer Ownership** | Hands the item to someone else, permanently. |
| **Delete** | Sends it to the Trash. |

### Sharing and transferring are different

**Sharing** grants access while you remain the owner. That suits colleagues need to see or edit something that is still yours to look after.

**Transferring ownership** moves the item into someone else's space for good. Reach for it when a project genuinely changes hands, for example when you hand a piece of work over before leaving a team.

A transfer leaves a **shortcut** behind in the space the item came from, badged as such and carrying the item's real name. It is a pointer, so opening it takes you to the item where it now lives.

:::info Who can see what
An item shows its **audience**: private, shared with named people, shared with a team or organisation, or public. Folders and bundles can be shared with teams and the organisation.
:::

### Trash and restore

Deleting content does not remove it straight away: it goes to the **Trash**, where the owner can **Restore** it. Content stays there until it is purged, so a delete made in error is recoverable.

## Adding content

`Add new` on the Content page offers:

- **New Folder**, to group content however suits you
- **Blank project** or **Import project**
- **Dataset**, to upload a file from your device (GeoPackage, GeoJSON, Shapefile, KML, CSV, XLSX, Parquet, and GTFS or Overture archives)
- **Connect service**, to add an external layer by URL (WFS, WMS, WMTS, XYZ Tiles or COG)
- **Upload Document**, for a file that belongs with the work without being data

A project can also be started from the Home page.

### Creating a project

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Open the <code>Content</code> page from the sidebar, and go to the folder you want the project to live in.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click <code>Add new</code> and select <code>Blank project</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Give the project a name and click <code>Create project</code>. It is created in the folder you were browsing, and opens straight away.</div>
</div>

To add a **description** or **tags**, or to rename the project later, open its `More Options` menu and choose `Edit metadata`. To put it in a different folder, use `Move` from the same menu.

### Importing a project

You can import a project that was exported from GOAT as a `.zip` file.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click <code>Add new</code> and select <code>Import project</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Choose the <code>.zip</code> file.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Give it a <code>Project Name</code> if you want one, or leave the field empty to keep the name it was exported under. Pick the <code>Destination</code> space and <code>Folder</code>.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Click <code>Import</code>. The import runs in the background, so follow its progress in the jobs menu.</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workspace/projects/project_import.webp').default} alt="Import a project in GOAT" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div>

### Uploading a dataset

GOAT supports multiple file formats for upload: **GeoPackage**, **GeoJSON**, **Shapefile**, **KML**, **CSV**, **XLSX**, **ZIP**, **Parquet**, and **COG** files, as well as **GTFS** (`gtfs.zip`) archives for [Public Transport Networks](../data/dataset_types.md#public-transport-networks) and **Overture** (`overture.zip`) archives for [Street Networks](../data/dataset_types.md#street-networks).

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Open the <code>Content</code> page from the sidebar, and go to the folder you want the dataset to live in.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click <code>Add new</code> and select <code>Dataset</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Drag a file onto the drop zone, or click to choose one. The supported formats are listed above it.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">The file appears as a row. Its <code>Layer name</code> starts as the file name and can be changed there. Use the folder button to change where the dataset is saved, and <code>Add description</code> to describe it.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content"><strong>CSV and XLSX files only:</strong> click <code>Set up columns</code> to check a preview of the first rows.
    <ul>
      <li><code>Worksheet</code>: for XLSX files with several sheets, select which sheet to import.</li>
      <li><code>First row is header</code>: on by default. Turn it off if the first row is data; column names are then generated, and you can rename them later in the layer settings.</li>
    </ul>
    Click <code>Confirm</code> to return to the file.
  </div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Click <code>Upload</code>.</div>
</div>

### Connecting to an external source

A service that already publishes the data, such as a **Web Feature Service (WFS)**, **Web Map Service (WMS)**, **Web Map Tile Service (WMTS)**, **XYZ Tiles** or a **Cloud Optimized GeoTIFF (COG)**, is added with `Connect service`. On this page, click `Add new` and choose `Connect service` to add it to the current folder. Inside a project you can also reach it from `+ Add layer` on the map. See [Add Layers](../map/layers#add-layers) for the steps.

Once added, a connected layer appears on this page like any other dataset, with two differences that show where its data comes from:

- A **`Linked`** tag, meaning the layer is **drawn live from the external service** rather than stored in GOAT. Its content can change or disappear if the service does.
- A **source line** showing the format and host, for example `WMS, linked from wms.nrw.de`. A **WFS** layer is imported as a copy into GOAT instead, and reads `Imported from WFS (wfs.nrw.de)`.

## Working with a dataset

### Dataset metadata and preview

Click a dataset's name to open it. The `Summary` tab describes it and lists what the publisher recorded, and where the dataset has rows to show, a `Data` tab holds a sample of them alongside the columns and their types.

To change a dataset's name or description, or to add tags, open its `More Options` menu and choose `Edit metadata`.

### Downloading a dataset

When downloading a spatial dataset, a dialog lets you choose:

- **Download Type**: the export file format (e.g. GeoPackage, GeoJSON, Shapefile).
- **Coordinate Reference System (CRS)**: the CRS to reproject the data into before download. GOAT automatically suggests CRS options based on the dataset's geographic extent: global options (WGS 84, Web Mercator) are always available, plus the matching UTM zone and any relevant national or regional CRS. The default is **WGS 84 (EPSG:4326)**.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workspace/datasets/managing_datasets.webp').default} alt="Dataset management options" style={{ maxHeight: "auto", maxWidth: "100%"}}/>
</div>
