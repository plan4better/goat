---
sidebar_position: 1
---

# Workflow Interface

**Workflows** in GOAT provide a powerful visual automation system for creating sophisticated spatial analysis pipelines. Instead of running individual tools sequentially, you can connect multiple analysis steps together using a drag-and-drop canvas, creating an automated data processing that eliminates repetitive manual work.

The workflows can be reused across different datasets and scenarios. Each workflow consists of different types of nodes connected by edges, enabling you to:

- **Automate complex analytical pipelines**: Chain multiple tools together where the output of one analysis automatically feeds into the next
- **Create multi-source data workflows**: Build sophisticated analysis processes that integrate multiple datasets and processing steps
- **Document automated processes**: Add text annotations to explain methodology and analytical decisions
- **Execute with flexible automation**: Run individual nodes, execute workflow segments, or automate entire pipelines
- **Build reusable automation templates**: Store workflows within projects for repeatability across different scenarios
- **Leverage advanced automation features**: Use [workflow variables](variables.md) and [custom SQL](custom_sql.md) for sophisticated parameterized analysis

The visual canvas interface makes complex spatial analysis automation accessible to users at all technical levels while maintaining full documentation of the analytical process for reproducibility and collaboration.

## 1. Interface Components

The workflow interface consists of two main panels and the workflow canvas, providing an intuitive workspace for visual workflow construction.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workflows/workflows_interface.webp').default} alt="Map Interface Overview" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

### Workflow Management and Project Layers panel
This panel is located on the left and it is divided into two sections:

#### Workflows Management

- **New**: Click <code>+ New</code> and choose <code>From scratch</code> or <code>From template</code> to create new analytical pipelines

- **Workflow List**: Manage existing workflows with options to rename, duplicate, and delete

#### Project Layers

- **Layer Tree**: Read-only display of project's data layers. You can drag and drop them onto the canvas to build the workflow.

- **Add a Layer**: Add new layers to the project to use them in the workflow and map mode.

### Workflow Canvas

#### Canvas Workspace

The canvas workspace is where you can drag and drop nodes, zoom, pan, and select elements. It contains several control areas:

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workflows/workflows_canvas-bars.webp').default} alt="Map Interface Overview" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

**Canvas View Bar**: Located in the bottom left corner of the canvas:
-  <img src={require('/img/icons/plus.png').default} alt="Zoom In" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Zoom In</code>: <strong>Increase</strong> the canvas magnification for detailed work
-  <img src={require('/img/icons/minus.png').default} alt="Zoom Out" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Zoom Out</code>: <strong>Decrease</strong> the canvas magnification to see more of the workflow
-  <img src={require('/img/icons/fit-view.png').default} alt="Fit View" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Fit View</code>: <strong>Adjust the view</strong> to display the entire workflow at once
-  <img src={require('/img/icons/lock.png').default} alt="Lock View" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Lock View</code>: <strong>Prevent accidental panning and zooming</strong> of the canvas
  
**Toolbar Controls**: Located at the middle bottom of the canvas:
- <img src={require('/img/icons/cursor.png').default} alt="Select" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Select</code>: <strong>Default cursor</strong> for selecting and moving nodes
- <img src={require('/img/icons/text-card.png').default} alt="Text Card" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Text Card</code>: <strong>Add text annotations</strong> to document workflow steps
- <img src={require('/img/icons/redo.png').default} alt="Redo" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Redo</code>: <strong>Restore the last undone action</strong>
- <img src={require('/img/icons/undo.png').default} alt="Undo" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Undo</code>: <strong>Reverse the last action</strong>
- <img src={require('/img/icons/variables.png').default} alt="Variables" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Variables</code>: <strong>Create and manage</strong> <a href="variables">workflow variables</a> for reusable parameters
- <img src={require('/img/icons/play.png').default} alt="Run" style={{ maxHeight: "40px", maxWidth: "40px", objectFit: "cover"}}/> <code>Run</code>: <strong>Execute the entire workflow</strong>

**Minimap**: Located in the bottom right corner of the canvas, providing an overview navigator for complex workflows.

**Data View Controls**: Located at the bottom of the canvas. Select a node to activate the panel — it shows the data of that node's layer:
- <code>Table</code>: Opens the attribute table of the selected node's layer
- <code>Map</code>: Opens a map preview of the selected node's layer (only available if the layer has geometry)

### Tools and Configuration panel
The right panel changes depending if there is a node selected or not. If no node is selected then the **Tools and History panel** will be visible. If a tool node is selected, the **Configuration panel** will appear, and if a dataset node is selected the **Dataset panel** will appear.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workflows/workflow_right-panel.webp').default} alt="Map Interface Overview" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

#### Tools and History panel

**Tools Tab**

This tab contains categorized tools available for workflow construction, similar to the Map Mode Toolbox. Drag and drop tools onto the canvas to add them to your workflow. The tools are organized into the following categories:

- **Data I/O**
  - <code>+ Add Dataset</code>: Create dataset nodes
  - <code>Save as Dataset</code>: Save workflow results as permanent datasets. Configure the **Dataset name**, toggle **Add to project** to automatically add the result to the project layer list, and enable **Overwrite on re-run** to replace the previously exported dataset each time the workflow runs instead of creating a new one.

:::tip Good practice
Give each **Save as Dataset** node a descriptive name and enable **Overwrite on re-run** when running the same workflow repeatedly — this keeps your project clean by avoiding duplicate layers after each run.
:::

- **Accessibility Indicators**
  - All tools available in the [Accessibility Indicators](../category/accessibility-indicators) section of the Toolbox

- **Geoanalysis**
  - All tools available in the [Geoanalysis](../category/geoanalysis) section of the Toolbox

- **Geoprocessing**
  - All tools available in the [Geoprocessing](../category/geoprocessing) section of the Toolbox
  
- **Data Management**
  - [Join](../toolbox/data_management/join.md), [Merge](../toolbox/data_management/merge.md), and other data manipulation tools
  - [Custom SQL](custom_sql.md): Advanced data processing with SQL queries

- **Control**
  - <code>Conditional</code>: Add a branching node that routes the layer to a <strong>True</strong> or <strong>False</strong> path based on defined conditions. See <a href="if_clause">Conditional</a>.


**History Tab**
Here you can see:
- **Execution Log**: Previous workflow runs with timestamps and status
- **Execution Details**: Duration, success/failure status, and error messages
- **Result Access**: Links to previous workflow outputs

#### Configuration Panel (Tool Node Selected)
When a tool node is selected, the right panel displays the **Tool Configuration** panel. Configure all tool-specific parameters for the selected analysis. You can also use [workflow variables](variables.md) within parameter fields for dynamic values.

#### Dataset Panel (Dataset Node Selected)
When a **dataset node** is selected, the dataset panel appears with two available tabs:

**Source Tab**: View metadata from the data source and access table and map views. You can also change the dataset assigned to the node from this tab.

**Filter Tab**: Apply filters specific to the workflow without affecting the original layer.


## 2. Example use cases

- **Accessibility Analysis Pipeline**: Create [catchment areas](../toolbox/accessibility_indicators/catchments.md), intersect with population data, calculate accessibility indicators, and export results
- **Site Suitability Assessment**: [Buffer](../toolbox/geoprocessing/buffer.md) constraints, perform spatial overlays, apply weighting factors, and rank suitable locations
- **Multi-Source Data Integration**: [Join](../toolbox/data_management/join.md) multiple datasets, apply spatial filters, aggregate statistics, and create comprehensive analytical outputs
- **Quality Assessment Workflow**: Validate data quality, check spatial relationships, generate validation reports using [Custom SQL](custom_sql.md)
- **Comparative Scenario Analysis**: Use [workflow variables](variables.md) to run identical analyses with different parameters or datasets

## 3. How to use the workflow interface

:::tip Getting Started
Begin with simple 2-3 node workflows to understand the interface, then gradually build more complex analytical pipelines as you become comfortable with the system.
:::

### Creating Your First Workflow

<div class="step">
  <div class="step-number">1</div>
  <div class="content"><strong>Navigate to Workflows</strong>: Click on the <code>Workflows</code> tab in GOAT's main navigation to access the workflow interface.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content"><strong>Create a new workflow</strong>: Click <code>+ New</code> in the left panel and choose <code>From scratch</code> to start with an empty canvas, or <code>From template</code> to start from a ready-made workflow (see <a href="#start-from-a-template">Start from a template</a>). A new workflow is added to the list with a default name.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content"><strong>Rename it</strong>: Open the workflow's <code>more options</code> menu and choose <code>Rename</code> to give it a name that reflects your analytical objective (e.g. "Urban Accessibility Analysis").</div>
</div>

### Building Your Workflow

<div class="step">
  <div class="step-number">1</div>
  <div class="content"><strong>Add Data Sources</strong>: Add data to your workflow by either dragging <code>+ Add Dataset</code> from the right panel's Tools tab onto the canvas, or by dragging layers directly from the Project Layers panel on the left. Configure the dataset node to reference your input data layers.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content"><strong>Add Analysis Tools</strong>: Browse the categorized tool sections and drag the required analysis tools to your canvas. Tools are organized by function (Accessibility, Geoprocessing, etc.).</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content"><strong>Connect Workflow Elements</strong>: Create edges by dragging from output handles to input handles. GOAT automatically validates geometry compatibility.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content"><strong>Configure Parameters</strong>: Click on each tool node to set analysis parameters. Use workflow variables for flexible, reusable configurations.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content"><strong>Document Your Process</strong>: Add text annotation to explain your methodology and analytical decisions.</div>
</div>

### Executing and Managing Workflows

<div class="step">
  <div class="step-number">1</div>
  <div class="content"><strong>Execute Workflow</strong>: Use the <code>Run Workflow</code> option to execute the entire workflow from start to finish.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content"><strong>Monitor Execution</strong>: Watch the progress indicators and check the job status in the main interface for execution updates.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content"><strong>Review Results</strong>: Use the <code>Table</code> and <code>Map</code> buttons at the bottom of the canvas to inspect the selected node's results once the workflow completes.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content"><strong>Save Results</strong>: Add and configure export nodes to save important results as permanent datasets in your project.</div>
</div>

### Results

Successfully using the workflow interface provides:

- **Reproducible Analysis**: Documented analytical processes that can be rerun with different data or parameters
- **Efficient Workflow**: Streamlined multi-step analysis execution with automatic dependency management  
- **Quality Control**: Validation capabilities at each step of complex analytical pipelines
- **Collaborative Documentation**: Visual representation of methodology for team sharing and knowledge transfer
- **Advanced Capabilities**: Access to specialized tools like [Custom SQL](custom_sql.md) and [workflow variables](variables.md) for sophisticated analysis

:::info Auto-Save Feature
Workflows automatically save changes as you build them. The system preserves all configurations, connections, and execution states.
:::

### Save a workflow as a template

Once a workflow is set up, you can save it as a **template** so it can be reused, without repeating the setup, on other data or by other people.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Open the workflow's <code>more options</code> menu and choose <code>Save as template…</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Give the template a <code>Name</code> and, optionally, a <code>Description</code> and categories.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Choose the <code>Location</code> (a space and folder) where the template is saved. Everyone who can open that folder can use the template.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">In the <code>Inputs</code> table, decide for each input layer whether it <strong>ships with the template</strong> or the template <strong>asks for a layer when used</strong>. A layer that ships is shared with the template so others can run it.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Click <code>Save</code>.</div>
</div>

:::info Update instead of duplicate
If a template was already saved from this workflow, you can **update it from the source** with the current version instead of creating a duplicate. Because the inputs are part of the saved snapshot, use <code>Update template from source</code> to change them.
:::

### Start from a template

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the <code>Workflows</code> panel, click <code>From template</code> to open the template browser, filtered to workflow templates.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Search or browse, select a template to <strong>preview</strong> it, and click <code>Use template</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">The workflow is added to your project. Where the template left an input open, pick a layer once it is in the project.</div>
</div>

## 4. Running workflows from the Map view

Workflows can also be run directly from the **Map view** without opening the workflow editor. Open the **Toolbox**, click the **Workflows** tab, and select a workflow from the list. If the workflow has [variables](variables.md#running-workflows-with-variables-from-the-map-view), a **Variables** section appears where you can set values before running.



