---
description: "Build workflows on a canvas by connecting dataset, tool and Conditional nodes, run them, review results as table or map, and save them as templates."
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
  <img src={require('/img/workflows/workflows_canvas-bars.webp').default} alt="Map Interface Overview" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

### Workflow Management and Project Layers panel
This panel is located on the left and it is divided into two sections:

**Workflow Management**

- **New**: Click <code>+ New</code> and choose <code>From scratch</code> or <code>From template</code> to create new analytical pipelines
- **Workflow List**: Manage existing workflows with options to rename, duplicate, and delete

**Project Layers**

- **Layer Tree**: Read-only display of project's data layers. You can drag and drop them onto the canvas to build the workflow.
- **Add a Layer**: Add new layers to the project to use them in the workflow and map mode.

### Workflow Canvas

**Canvas Workspace**

The canvas workspace is where you can drag and drop nodes, zoom, pan, and select elements. It contains several control areas:

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workflows/workflows_interface.webp').default} alt="Map Interface Overview" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

**Canvas View Bar**: Located in the bottom left corner of the canvas:
-  <img src={require('/img/icons/plus.png').default} alt="Zoom In" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Zoom In</code>: <strong>Increase</strong> the canvas magnification for detailed work
-  <img src={require('/img/icons/minus.png').default} alt="Zoom Out" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Zoom Out</code>: <strong>Decrease</strong> the canvas magnification to see more of the workflow
-  <img src={require('/img/icons/fit-view.png').default} alt="Fit View" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Fit View</code>: <strong>Adjust the view</strong> to display the entire workflow at once
-  <img src={require('/img/icons/lock.png').default} alt="Lock" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Lock</code>: <strong>Prevent accidental changes</strong>: while the canvas is locked, nodes and text cards can't be moved, connected or deleted. Panning and zooming still work. Click <code>Unlock</code> to edit again
  
**Toolbar Controls**: Located at the middle bottom of the canvas:
- <img src={require('/img/icons/cursor.png').default} alt="Select" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Select</code>: <strong>Default cursor</strong> for selecting and moving nodes
- <img src={require('/img/icons/text-card.png').default} alt="Text Card" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Text Card</code>: <strong>Add text annotations</strong> to document workflow steps
- <img src={require('/img/icons/redo.png').default} alt="Redo" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Redo</code>: <strong>Restore the last undone action</strong>
- <img src={require('/img/icons/undo.png').default} alt="Undo" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Undo</code>: <strong>Reverse the last action</strong>
- <img src={require('/img/icons/variables.png').default} alt="Variables" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Variables</code>: <strong>Create and manage</strong> [workflow variables](variables) for reusable parameters
- <img src={require('/img/icons/play.png').default} alt="Run" style={{ maxHeight: "40px", maxWidth: "40px", objectFit: "cover"}}/> <code>Run</code>: <strong>Execute the entire workflow</strong>

**Minimap**: Located in the bottom right corner of the canvas, providing an overview navigator for complex workflows.

**Data View Controls**: Located at the bottom of the canvas. Select a node to activate the panel. It shows the data of that node's layer:
- <code>Table</code>: Opens the attribute table of the selected node's layer
- <code>Map</code>: Opens a map preview of the selected node's layer (only available if the layer has geometry)

### Keyboard shortcuts

On macOS, use `⌘` instead of `Ctrl`.

| Shortcut | Action |
|---|---|
| `Delete` or `Backspace` | Delete the selected node, text card or connection |
| `Ctrl+Z` | Undo the last change |
| `Ctrl+Shift+Z` or `Ctrl+Y` | Redo the last undone change |
| `Ctrl` + click | Add a node or text card to the selection |
| Arrow keys | Move the selected node or text card |
| `Esc` | Clear the selection |

With the mouse, drag on an empty part of the canvas to pan, and scroll to zoom.

- Undo and redo don't apply while you type in a field, such as a text card or a tool setting.
- Moving a node or text card, by dragging it or with the arrow keys, is a change you can undo like any other.
- A version loaded over the canvas, such as a change by the AI assistant or the saved version after <code>Reload</code>, is one step too: `Ctrl+Z` takes it back (see <a href="#change-a-workflow-with-the-ai-assistant">Change a workflow with the AI assistant</a>). After <code>Reload</code>, `Ctrl+Z` brings back your version, and it is then saved over the other change without asking again.
- While the canvas is locked with <code>Lock</code>, `Delete` doesn't remove anything.

### Tools and Configuration panel
The right panel changes depending if there is a node selected or not. If no node is selected then the **Tools and History panel** will be visible. If a tool node is selected, the **Configuration panel** will appear, and if a dataset node is selected the **Dataset panel** will appear.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workflows/workflow_right-panel.webp').default} alt="Map Interface Overview" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

**Tools and History panel**

**Tools Tab**

This tab contains categorized tools available for workflow construction, similar to the Map Mode Toolbox. Drag and drop tools onto the canvas to add them to your workflow. The tools are organized into the following categories:

- **Data I/O**
  - <code>+ Add dataset</code>: Create dataset nodes
  - <code>Save as dataset</code>: Save workflow results as permanent datasets. Configure the **Dataset name**, toggle **Add to project** to automatically add the result to the project layer list, and enable **Overwrite on re-run** to replace the previously exported dataset each time the workflow runs instead of creating a new one. Connected directly to a dataset node, it saves the features that match the node's filter, in the dataset's style.

:::tip Good practice
Give each **Save as dataset** node a descriptive name and enable **Overwrite on re-run** when running the same workflow repeatedly. This keeps your project clean by avoiding duplicate layers after each run.
:::

- **Accessibility Indicators**: All tools available in the [Accessibility Indicators](../category/accessibility-indicators) section of the Toolbox
- **Geoanalysis**: All tools available in the [Geoanalysis](../category/geoanalysis) section of the Toolbox
- **Geoprocessing**: All tools available in the [Geoprocessing](../category/geoprocessing) section of the Toolbox
- **Data Management**
  - [Join](../toolbox/data_management/join.md), [Merge](../toolbox/data_management/merge.md), and other data manipulation tools
  - [Custom SQL](custom_sql.md): Advanced data processing with SQL queries
- **Control**: Add a <code>Conditional</code> node that routes the layer to a <strong>True</strong> or <strong>False</strong> path based on defined conditions. See [Conditional](if_clause).


**History Tab**

Here you can see:
- **Execution Log**: Previous workflow runs with timestamps and status
- **Execution Details**: Duration, success/failure status, and error messages
- **Result Access**: Links to previous workflow outputs

**Configuration Panel (Tool Node Selected)**

When a tool node is selected, the right panel displays the **Tool Configuration** panel. Configure all tool-specific parameters for the selected analysis. You can also use [workflow variables](variables.md) within parameter fields for dynamic values.

**Dataset Panel (Dataset Node Selected)**

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
  <div class="content"><strong>Create a new workflow</strong>: Click <code>+ New</code> in the left panel and choose <code>From scratch</code> to start with an empty canvas, or <code>From template</code> to start from a ready-made workflow (see <a href="#start-from-a-template">Start from a template</a>). A new workflow is added to the list with a default name. In a project without workflows, the canvas offers the same in its centre: <code>New workflow</code>, <code>Start from a template</code> when workflow templates are available to you, and a <code>What's a workflow?</code> link to this page.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content"><strong>Rename it</strong>: Open the workflow's <code>more options</code> menu and choose <code>Rename</code> to give it a name that reflects your analytical objective (e.g. "Urban Accessibility Analysis").</div>
</div>

### Building Your Workflow

<div class="step">
  <div class="step-number">1</div>
  <div class="content"><strong>Add Data Sources</strong>: Add data to your workflow by either dragging <code>+ Add dataset</code> from the right panel's Tools tab onto the canvas, or by dragging layers directly from the Project Layers panel on the left. Configure the dataset node to reference your input data layers.</div>
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
  <div class="content"><strong>Execute Workflow</strong>: Click <code>Run</code> at the bottom of the canvas to execute the entire workflow from start to finish. It is greyed out while the workflow has errors (see <a href="#checking-and-running-a-workflow">Checking and running a workflow</a>).</div>
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

:::info Auto-Save Feature
Workflows automatically save changes as you build them. The system preserves all configurations, connections, and execution states. If a save fails, a <code>Not saved</code> notice appears at the top of the canvas; click <code>Retry</code> to save again.

If the workflow was saved somewhere else since you opened it, for example by someone else or in another tab, your changes don't replace that version. A notice at the top of the canvas says <code>This workflow was changed elsewhere</code>, with who changed it and when, and nothing is saved until you choose: click <code>Reload</code> to load the saved version, or <code>Keep mine</code> to save your version over it. If the AI assistant changed the workflow while you were editing it, the notice reads <code>The assistant changed this workflow while you were editing.</code> Panning and zooming never cause this notice.
:::

### Checking and running a workflow

GOAT checks the workflow while you build it and shows what still needs attention. Nothing it finds stops you from building or saving.

- Next to <code>Run</code>, a chip such as <code>2 issues</code> counts everything that was found. Click it to open the list, grouped by node; issues that concern the whole workflow come first.
- A node with an issue shows a badge at its bottom right corner. Point at the badge, or tap it, to read its messages.
- An input that must be connected but is not gets an amber ring around its handle.
- In a node's settings, a message appears under the setting it concerns, and the node's other issues are listed at the top. Required settings are marked with an asterisk (<code>*</code>).

Click an issue in the list or on a badge to go to it: the canvas moves to the node, selects it and opens its settings at the setting concerned.

| Level | Colour | What it means |
|---|---|---|
| Error | amber | The workflow cannot run yet, for example because an input is not connected, a required setting is empty or a field does not exist in the input dataset. |
| Warning | grey | Worth a look, but it never stops a run, for example a node that is not connected to any other node. |
| Run error | red | The node failed in the last run, and its badge shows the node's own error message. It goes away when you change the node or run the workflow again. |

While the workflow has errors, <code>Run</code> is greyed out; pointing at it tells you how many are left, for example <code>Fix 2 issues to run</code>. Warnings and run errors never disable <code>Run</code>.

If the workflow could not be checked, for example because the connection dropped, a chip <code>Not checked</code> appears. Click it to check again; a run is always checked when it starts.

:::info Damaged workflows
If the saved version of a workflow cannot be read, for example because it was changed outside GOAT, it opens with the notice <code>This workflow cannot be opened</code> in place of the canvas, listing what is broken. Such a workflow cannot be edited or run there, and GOAT does not save over it. The other workflows of the project keep working.
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

### Build a workflow with the AI assistant

You can also describe an analysis to the AI assistant and have it build the workflow. In a project you can edit, open the assistant with <code>Ask AI</code> in the upper bar, in the <code>Map</code> or <code>Workflows</code> view, and describe what you need, for example <em>Build a workflow that finds the areas within a 15-minute walk of the schools and counts the residents in them</em>.

- When a workflow template fits, the assistant uses it. Otherwise it builds the workflow from the tools of your Toolbox, checks it with the same check as the editor (see <a href="#checking-and-running-a-workflow">Checking and running a workflow</a>) and fixes what it can. It creates the workflow only when what is left is yours to choose: the layers of the steps it left open, and the settings that read them, such as a field.
- When you have to choose, for example which dataset to use, the assistant asks you in a card with one or more questions, at the bottom of the assistant in place of the message field. Several questions appear one at a time: choose an option (or several, where the question allows it), or pick <code>Type your own answer</code> and enter it; then click <code>Next</code>. <code>Review</code> then lists your answers, and <code>Send answer</code> sends them. A single question has <code>Send answer</code> right below it. The option the assistant suggests is marked <code>Recommended</code> and comes first. To answer in the message field instead, click <code>Reply in text instead</code>.
- The assistant adds a dataset from the catalog to your project only when you choose it as an option in such a card, not when you name it in an answer you type. A template is the exception: the datasets it ships come into your project with it (see <a href="../getting_started/start_from_a_template#datasets-in-a-template">Datasets in a template</a>).
- If you choose to leave a dataset open, or no fitting data exists, the assistant leaves the dataset node empty and names the step for what is missing. The node then shows <code>No dataset</code> and <code>Pick a layer</code>, and the issue list shows <code>No dataset is chosen for this step.</code> under the step's name. <code>Run</code> stays greyed out until you have picked a layer and filled in what the issue list then asks for in the steps that use it.
- If you are still in the project and the workflow you have open has no unsaved changes, the new workflow opens in the editor at once; otherwise click <code>Open</code> on the workflow card in the answer.

### Change a workflow with the AI assistant

You can also ask the assistant to change a workflow of the open project, for example <em>Set the walking time to 10 minutes and add a note that explains it</em>.

- The assistant reads the workflow first and changes only what you asked for: steps, settings, connections and text cards. It never deletes a workflow.
- It checks the changed workflow with the same check as the editor and doesn't save a change that adds an error. Its answer says what it changed.
- If the workflow is open in the editor, the canvas shows the change at once. `Ctrl+Z` (`⌘+Z` on macOS) in the canvas takes the change back as one step.
- An answer that changed a workflow shows <code>Undo</code> below it; on older answers, point at the answer to see it. Click it to take back all the changes of that answer, also when the workflow isn't open. The button then reads <code>Undone</code>.
- If the workflow was saved again after the answer, <code>Undo</code> asks first and says who changed it and when. <code>Undo anyway</code> takes back those later changes too. If the editor has changes that aren't saved yet, <code>Undo</code> asks as well; after <code>Undo anyway</code>, the notice at the top of the canvas lets you choose which version to keep.

### Run a workflow with the AI assistant

- When you ask for a result, for example <em>How many residents live within a 15-minute walk of a school?</em>, the assistant builds the workflow and runs it. A workflow it created in this conversation runs without asking. Any other workflow, such as one you built yourself, runs only after you agree: the assistant asks in a card whether to run it, and nothing runs until you choose to.
- While the workflow runs, the answer shows a line such as <code>Workflow running: step 2 of 4, Catchment Area</code> with the time since it started. <code>Open in Workflows</code> opens the workflow, where the canvas shows the run.
- The assistant waits for the run and reports the result in its answer, with the layers the run saved. If the run failed (<code>Workflow run failed</code>), it names the step that failed and what to change.
- If the run takes longer than the answer can wait, the line reads <code>Workflow was running when this answer ended</code>. The run goes on; ask the assistant again later for the result. If you stop the answer, a run it started stops too.

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
  <div class="content">In the <code>Inputs</code> table, decide for each input layer whether it <strong>ships with the template</strong> or the template <strong>asks for a layer when used</strong>. A layer that ships is shared with the template so others can run it. For a shipped layer you can also choose <code>Copy for every user (with content)</code> or <code>Empty copy for every user</code>, so that everyone gets their own editable copy instead of your read-only layer (see <a href="../getting_started/start_from_a_template#datasets-in-a-template">Datasets in a template</a>).</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Click <code>Save</code>.</div>
</div>

:::tip Your styling comes along
If you have run an export node and styled its result layer, the template keeps that style. People who use the template get your styling on their first run. An export that overwrites an earlier result keeps that layer's own style.
:::

:::info Update instead of duplicate
If a template was already saved from this workflow, you can **update it from the source** with the current version instead of creating a duplicate. Because the inputs are part of the saved snapshot, use <code>Update template from source</code> to change them.
:::

## 4. Running workflows from the Map view

Workflows can also be run directly from the **Map view** without opening the workflow editor. Open the **Toolbox**, click the **Workflows** tab, and select a workflow from the list. If the workflow has [variables](variables.md#running-workflows-with-variables-from-the-map-view), a **Variables** section appears where you can set values before running.



