---
description: "Find your way around the Map interface: the upper bar, the Layers panel, search, toolbox and measurement tools, the style and filter panel, and map navigation."
sidebar_position: 1
---

# Map Interface

**Opening a project will take you to the Map Interface**. Here, you can create, organize, and style layers, visualize spatial data, and harness all of GOAT's powerful spatial analysis capabilities.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/interface/map_interface.webp').default} alt="Map Interface Overview" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

### Upper Bar

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/interface/upper_bar.webp').default} alt="Upper bar interface elements" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

#### Left Side
- <code>Project menu</code>: <strong>Click to return</strong> to the home page, edit project metadata, delete the project, lock the map extent, or read the privacy policy.
- <code>Project Name</code>: <strong>Double-click to edit</strong> the project name.
- <code>Last Saved</code>: <strong>Shows the timestamp</strong> of the last saved change.

#### Right Side
- <code>Project mode toggle</code>: <strong>Switch between</strong> the Map, Workflows, Layouts and Dashboard interfaces.
- <code>Share Project</code>: <strong>Manage the sharing options</strong>.
- <code>Support</code>: <strong>Open your support tickets, report a problem or open the documentation</strong>. See [Support](../support/support.md).
- <code>Job status</code>: <strong>View the status</strong> of ongoing and completed tasks. The icon appears once you have started a task.
- <code>User profile</code>: <strong>Access account settings</strong> and log out.


### Panels & tools

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/interface/right-left_panels.webp').default} alt="recent datasets" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

#### Layers Panel

The Layers Panel on the left side of the map interface provides **access to all project layers**. From here, users can manage their data by **adding new layers** with <code>+ Add layer</code> and **organizing them** using <img src={require('/img/icons/layer.png').default} alt="Group layers" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/><code>Group layers</code> to create logical collections of related datasets.

#### Tools
The tools are located on the right side of the Layers Panel:

- <img src={require('/img/icons/magnifying-glass.png').default} alt="Address and coordinates search" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code> Search button</code>: <strong>Search for addresses</strong> or coordinates to quickly navigate to a specific location on the map. 

- <img src={require('/img/icons/toolbox.png').default} alt="Toolbox" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Toolbox</code>: <strong>Access to the Toolbox</strong>. Read more in [Toolbox](../category/toolbox).


-  <img src={require('/img/icons/ruler-horizontal.png').default} alt="Measurements" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Measurements</code>: Users can <strong>measure distances and areas</strong>, such as routes, lines and polygons.
  
#### Editing and Tools Panel

When selecting a layer from the Layers Panel, the Editing Panel appears on the right side of the map interface. This panel provides access to various options:

- <code>Style</code>: <strong>Customize the visual appearance</strong> of the selected layer by changing colors, opacity, and other styling options. Read more in [Layer Styling](../category/layer-design).

- <code>Filter</code>: <strong>Apply filters</strong> to the selected layer to display only specific features based on attribute values. Read more in [Layer Filtering](filter).

- <code>Metadata</code>: <strong>View and edit metadata information</strong> for the selected layer. 
  
### Map Navigation

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/interface/map_navigation.webp').default} alt="recent datasets" style={{ maxHeight: "auto", maxWidth: "90%", objectFit: "cover"}}/>
</div> 

<p></p>



- <img src={require('/img/icons/plus.png').default} alt="Zoom In" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Zoom In</code> 

- <img src={require('/img/icons/minus.png').default} alt="Zoom out" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Zoom Out</code> 
  
- <img src={require('/img/icons/fullscreen.png').default} alt="Fullscreen" style={{ maxHeight: "16px", maxWidth: "16px", objectFit: "cover"}}/> <code>Fullscreen</code> 

-  <img src={require('/img/icons/map.png').default} alt="Base map" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Base map</code>: <strong>Choose between</strong> the available base map options. Click <code>+ Add a new basemap</code> at the bottom of the panel to add a custom basemap. Under the <code>Basemap</code> tab, select the type (<code>Vector</code> or <code>Raster</code>), enter the <strong>Basemap URL</strong>, a <strong>Title</strong>, and optionally a description and thumbnail URL. Alternatively, use the <code>Single Color</code> tab to set a solid color as the map background. Click <code>Add basemap</code> to save.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/basemap/add_basemap.webp').default} alt="Add custom basemap in GOAT" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div>

### 3D view {#3d-view}

The <code>View</code> button with the cube icon, above <code>Zoom In</code>, opens the <code>View</code> panel. It switches the map between 2D and 3D:

- <code>2D</code> | <code>3D</code>: <strong>Switch to 3D</strong> to tilt and rotate the map. Back in <code>2D</code>, the map turns flat and faces north again.
- <code>Globe when zoomed out</code>: <strong>Show the world as a globe</strong> when you zoom out. The globe floats in space with a soft glow and faint stars around it. This works in 2D and 3D; from zoom 9 on the map is flat again.
- <code>Terrain</code> (3D only): <strong>Show mountains and valleys</strong> with shading. <code>Exaggeration</code> makes the relief steeper (1x, 1.5x, 2x or 3x). Over satellite and other image basemaps the terrain gets no extra shading. On the globe, relief shows as shading; raised terrain rises once the map is flat again.
- <code>3D buildings</code> (3D only): <strong>Raise the basemap's buildings</strong> from zoom 14 on. If one of your layers has its own heights, the basemap's buildings start switched off. <code>Opacity</code> makes the buildings see-through (60% by default), so the layers on the ground below them stay readable.
- <code>Sky and atmosphere</code> (editors, in 3D or with the globe): <code>Auto</code> takes the sky colors from the basemap, so the horizon matches the map, lets the light come from where you look, and draws no fog. Turn <code>Auto</code> off to set your own <code>Sky</code>, <code>Fog</code>, <code>Globe glow</code> and <code>Light</code>; the map changes only once you edit one of them. Switch on <code>Fog</code> with the switch at the top of its section to add haze towards the horizon. Under <code>Globe glow</code>, <code>Strength</code> and <code>Glow color</code> set the glow around the zoomed-out globe; a strength of 0 turns it off. Under <code>Light</code>, <code>Direction</code> and <code>Height</code> set where the light comes from, <code>Intensity</code> and <code>Color</code> how it looks. <code>Reset to auto</code> goes back to the automatic look.

**Tilt and rotate** the map in 3D by dragging with the right mouse button, with <code>Ctrl</code> + drag or with <code>Shift</code> + the arrow keys. The sky, and fog if you switched it on, show when the map is tilted steeply.

While the map is tilted or rotated, a **compass** shows above the <code>View</code> button with the tilt, such as <code>Tilt 55°</code>. Click it once to face north, and again to go back to 2D.

What editors choose here is saved with the project, so public maps and dashboards open in the same view. Viewers can change the view for themselves; their changes are not saved.

Your own polygon layers and H3 hexagons can stand in 3D too: see [Height](./layer_style/style/styling.md#height). A layout's map element prints the tilted view as an image; see [Tilted maps](../layouts/layouts.md#tilted-maps).

