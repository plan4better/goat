import { createSlice } from "@reduxjs/toolkit";
import type { PayloadAction } from "@reduxjs/toolkit";
import type { Edge, Node } from "@xyflow/react";

import { isDrawableWorkflowConfig } from "@/lib/validations/workflow";
import type {
  Workflow,
  WorkflowConfig,
  WorkflowEdge,
  WorkflowNode,
  WorkflowVariable,
} from "@/lib/validations/workflow";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface WorkflowState {
  // All workflows for the project
  workflows: Workflow[];
  // Currently selected workflow
  selectedWorkflowId: string | null;
  // Currently selected node ID (separate from node.selected)
  selectedNodeId: string | null;
  // ReactFlow nodes (source of truth during editing)
  nodes: Node[];
  // ReactFlow edges (source of truth during editing)
  edges: Edge[];
  // Viewport (pan/zoom)
  viewport: Viewport;
  // Workflow-level variables
  variables: WorkflowVariable[];
  // The stored revision each workflow's copy here is based on: the canvas for
  // the open workflow, the list entry for the others. A save sends it as
  // `base_revision`, so core refuses it when the workflow changed elsewhere.
  revisions: Record<string, number>;
  // Changes made elsewhere (by the assistant, or the dock's Undo of its
  // edits) that the editor takes over: the revision each made, by workflow.
  // The editor loads the stored workflow once it has saved what it holds.
  reloadRequests: Record<string, number>;
  // Counts the times the open canvas's steps and connections were replaced
  // as a whole (an undo or redo, a stored version loaded over it): the
  // canvas then draws them anew, positions included.
  canvasVersion: number;
  // Dirty flag for unsaved changes
  isDirty: boolean;
  // Unsaved changes beyond the view (pan, zoom): steps, connections, variables
  contentDirty: boolean;
  // Flag to request opening map view (e.g., from spatial filter)
  requestMapView: boolean;
  // Flag to request opening table view
  requestTableView: boolean;
  // Currently active data panel view (null = collapsed, 'table' = table view, 'map' = map view)
  activeDataPanelView: "table" | "map" | null;
}

const initialState: WorkflowState = {
  workflows: [],
  selectedWorkflowId: null,
  selectedNodeId: null,
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  variables: [],
  revisions: {},
  reloadRequests: {},
  canvasVersion: 0,
  isDirty: false,
  contentDirty: false,
  requestMapView: false,
  requestTableView: false,
  activeDataPanelView: null,
};

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

// Helper to convert WorkflowConfig to ReactFlow format. Only called for a
// config `isDrawableWorkflowConfig` accepts (see `loadCanvas`).
const configToReactFlow = (config: WorkflowConfig | undefined) => {
  if (!config) return { nodes: [], edges: [] };

  const nodes: Node[] = config.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    data: node.data,
    zIndex: node.zIndex,
  }));

  // Sort nodes so textAnnotation nodes come first (render below other nodes)
  nodes.sort((a, b) => {
    if (a.type === "textAnnotation" && b.type !== "textAnnotation") return -1;
    if (a.type !== "textAnnotation" && b.type === "textAnnotation") return 1;
    return 0;
  });

  const edges: Edge[] = config.edges.map((edge) => ({
    id: edge.id,
    type: "deletable",
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
    zIndex: 500, // Edges appear above text annotations (zIndex: 0) but below tool/dataset nodes (zIndex: 1000)
  }));

  return { nodes, edges };
};


// The canvas state a stored config opens as. A config the canvas cannot draw
// opens as an empty canvas: the editor shows the damaged notice in its place
// and never saves over it, and the reducer never throws on it. The stored
// config itself stays as it is.
const loadCanvas = (config: WorkflowConfig | undefined) => {
  if (!config || !isDrawableWorkflowConfig(config)) {
    return {
      nodes: [] as Node[],
      edges: [] as Edge[],
      viewport: { ...DEFAULT_VIEWPORT },
      variables: [] as WorkflowVariable[],
    };
  }
  const { nodes, edges } = configToReactFlow(config);
  return { nodes, edges, viewport: config.viewport ?? { ...DEFAULT_VIEWPORT }, variables: config.variables ?? [] };
};

// Notes the revision of a workflow whose stored config the copy here now is,
// or is saved as. A change requested to be loaded that this revision includes
// (or was saved over: Keep mine) is then left to the copy here.
const recordRevision = (state: WorkflowState, workflow: Pick<Workflow, "id" | "revision">) => {
  if (typeof workflow.revision !== "number") return;
  state.revisions[workflow.id] = workflow.revision;
  const requested = state.reloadRequests[workflow.id];
  if (requested !== undefined && workflow.revision >= requested) delete state.reloadRequests[workflow.id];
};

// Helper to convert ReactFlow to WorkflowConfig format
const reactFlowToConfig = (nodes: Node[], edges: Edge[]): Pick<WorkflowConfig, "nodes" | "edges"> => {
  const workflowNodes: WorkflowNode[] = nodes.map((node) => ({
    id: node.id,
    type: node.type as "dataset" | "tool" | "export" | "textAnnotation",
    position: node.position,
    data: node.data as WorkflowNode["data"],
  }));

  const workflowEdges: WorkflowEdge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle || undefined,
    target: edge.target,
    targetHandle: edge.targetHandle || undefined,
  }));

  return { nodes: workflowNodes, edges: workflowEdges };
};

const workflowSlice = createSlice({
  name: "workflow",
  initialState,
  reducers: {
    // Set all workflows (from API). A workflow selected before the list
    // carried it — created from a template and picked the moment the panel's
    // own list had it, a render before the layout's copy reached the store —
    // loads its config now, so the canvas never sits empty over a config
    // that exists (and never auto-saves that emptiness back). A canvas the
    // author already changed is left alone.
    // The open workflow's canvas, and so its revision, stays as it is: its
    // next save names the revision it was made on.
    setWorkflows: (state, action: PayloadAction<Workflow[]>) => {
      const selectedWasKnown = state.workflows.some((w) => w.id === state.selectedWorkflowId);
      state.workflows = action.payload;
      const open = state.selectedWorkflowId;
      state.revisions = open !== null && open in state.revisions ? { [open]: state.revisions[open] } : {};
      for (const workflow of action.payload) {
        if (workflow.id !== open) recordRevision(state, workflow);
      }
      if (!state.selectedWorkflowId || selectedWasKnown || state.isDirty) return;
      const workflow = action.payload.find((w) => w.id === state.selectedWorkflowId);
      if (!workflow) return;
      const canvas = loadCanvas(workflow.config);
      state.nodes = canvas.nodes;
      state.edges = canvas.edges;
      state.viewport = canvas.viewport;
      state.variables = canvas.variables;
      recordRevision(state, workflow);
    },

    // Add a new workflow
    addWorkflow: (state, action: PayloadAction<Workflow>) => {
      state.workflows.push(action.payload);
      recordRevision(state, action.payload);
    },

    // Remove a workflow
    removeWorkflow: (state, action: PayloadAction<string>) => {
      state.workflows = state.workflows.filter((w) => w.id !== action.payload);
      delete state.revisions[action.payload];
      if (state.selectedWorkflowId === action.payload) {
        state.selectedWorkflowId = null;
        state.nodes = [];
        state.edges = [];
      }
    },

    // Select a workflow - loads its config into ReactFlow state
    selectWorkflow: (state, action: PayloadAction<string | null>) => {
      state.selectedWorkflowId = action.payload;
      state.selectedNodeId = null;
      state.isDirty = false;
      state.contentDirty = false;

      if (action.payload) {
        const workflow = state.workflows.find((w) => w.id === action.payload);
        const canvas = loadCanvas(workflow?.config);
        state.nodes = canvas.nodes;
        state.edges = canvas.edges;
        state.viewport = canvas.viewport;
        state.variables = canvas.variables;
        if (workflow) recordRevision(state, workflow);
      } else {
        state.nodes = [];
        state.edges = [];
        state.viewport = { x: 0, y: 0, zoom: 1 };
        state.variables = [];
      }
    },

    // ==========================================
    // ReactFlow state management (source of truth)
    // ==========================================

    // Set all nodes (from ReactFlow)
    setNodes: (state, action: PayloadAction<Node[]>) => {
      state.nodes = action.payload;
      state.isDirty = true;
      state.contentDirty = true;
    },

    // Set all edges (from ReactFlow)
    setEdges: (state, action: PayloadAction<Edge[]>) => {
      state.edges = action.payload;
      state.isDirty = true;
      state.contentDirty = true;
    },

    // Add a single node
    addNode: (state, action: PayloadAction<Node>) => {
      // Text annotations should be at the beginning of the array so they render below other nodes
      if (action.payload.type === "textAnnotation") {
        state.nodes.unshift(action.payload);
      } else {
        state.nodes.push(action.payload);
      }
      state.isDirty = true;
      state.contentDirty = true;
    },

    // Update a single node
    updateNode: (state, action: PayloadAction<{ id: string; changes: Partial<Node> }>) => {
      const { id, changes } = action.payload;
      const index = state.nodes.findIndex((n) => n.id === id);
      if (index !== -1) {
        state.nodes[index] = { ...state.nodes[index], ...changes };
        state.isDirty = true;
        state.contentDirty = true;
      }
    },

    // Remove nodes by ids
    removeNodes: (state, action: PayloadAction<string[]>) => {
      const idsToRemove = new Set(action.payload);
      state.nodes = state.nodes.filter((n) => !idsToRemove.has(n.id));
      // Also remove connected edges
      state.edges = state.edges.filter((e) => !idsToRemove.has(e.source) && !idsToRemove.has(e.target));
      // Clear selection if removed node was selected
      if (state.selectedNodeId && idsToRemove.has(state.selectedNodeId)) {
        state.selectedNodeId = null;
      }
      state.isDirty = true;
      state.contentDirty = true;
    },

    // Add an edge
    addEdge: (state, action: PayloadAction<Edge>) => {
      state.edges.push(action.payload);
      state.isDirty = true;
      state.contentDirty = true;
    },

    // Remove edges by ids
    removeEdges: (state, action: PayloadAction<string[]>) => {
      const idsToRemove = new Set(action.payload);
      state.edges = state.edges.filter((e) => !idsToRemove.has(e.id));
      state.isDirty = true;
      state.contentDirty = true;
    },

    // Update node positions (batch update for performance)
    updateNodePositions: (
      state,
      action: PayloadAction<Array<{ id: string; position: { x: number; y: number } }>>
    ) => {
      for (const { id, position } of action.payload) {
        const node = state.nodes.find((n) => n.id === id);
        if (node) {
          node.position = position;
        }
      }
      state.isDirty = true;
      state.contentDirty = true;
    },

    // Select a node by ID (null to deselect)
    selectNode: (state, action: PayloadAction<string | null>) => {
      state.selectedNodeId = action.payload;
    },

    // Update viewport (pan/zoom)
    updateViewport: (state, action: PayloadAction<Viewport>) => {
      state.viewport = action.payload;
      state.isDirty = true;
    },

    // Sync current state to workflow config (called before save)
    syncToWorkflowConfig: (state) => {
      if (!state.selectedWorkflowId) return;

      const workflow = state.workflows.find((w) => w.id === state.selectedWorkflowId);
      if (!workflow) return;

      const { nodes, edges } = reactFlowToConfig(state.nodes, state.edges);
      workflow.config = {
        ...workflow.config,
        nodes,
        edges,
        viewport: state.viewport,
        variables: state.variables,
      };
    },

    // Mark as saved (clear dirty flag)
    markSaved: (state) => {
      state.isDirty = false;
      state.contentDirty = false;
    },

    // The revision core holds for a workflow whose stored config is the copy
    // here: after a save, a rename, or "Keep mine" on a conflict.
    setWorkflowRevision: (state, action: PayloadAction<{ id: string; revision: number }>) => {
      const { id, revision } = action.payload;
      recordRevision(state, { id, revision });
      const workflow = state.workflows.find((w) => w.id === id);
      if (workflow) workflow.revision = revision;
    },

    // A workflow as core stores it now, over the copy here: "Reload" on a
    // conflict, or a change made elsewhere that the editor takes over. On the
    // open canvas it replaces the changes made here; the view stays. It
    // serves a reload request for that revision or an older one.
    reloadWorkflow: (state, action: PayloadAction<Workflow>) => {
      const workflow = action.payload;
      const index = state.workflows.findIndex((w) => w.id === workflow.id);
      if (index === -1) state.workflows.push(workflow);
      else state.workflows[index] = workflow;
      recordRevision(state, workflow);
      if (state.selectedWorkflowId !== workflow.id) return;
      const canvas = loadCanvas(workflow.config);
      state.nodes = canvas.nodes;
      state.edges = canvas.edges;
      state.variables = canvas.variables;
      state.isDirty = false;
      state.contentDirty = false;
      state.canvasVersion += 1;
      if (state.selectedNodeId && !canvas.nodes.some((n) => n.id === state.selectedNodeId)) {
        state.selectedNodeId = null;
      }
    },

    // A change made elsewhere at `revision` that the editor takes over: the
    // assistant edited the workflow, or the dock's Undo took its edit back.
    requestWorkflowReload: (state, action: PayloadAction<{ id: string; revision: number }>) => {
      const { id, revision } = action.payload;
      // The copy here is based on that change already (a replayed answer names it again).
      if ((state.revisions[id] ?? -1) >= revision) return;
      const known = state.reloadRequests[id];
      if (known === undefined || revision > known) state.reloadRequests[id] = revision;
    },

    // The steps and connections an undo or redo goes back to, saved like
    // any other change.
    restoreCanvas: (state, action: PayloadAction<{ nodes: Node[]; edges: Edge[] }>) => {
      state.nodes = action.payload.nodes;
      state.edges = action.payload.edges;
      state.isDirty = true;
      state.contentDirty = true;
      state.canvasVersion += 1;
      if (state.selectedNodeId && !state.nodes.some((n) => n.id === state.selectedNodeId)) {
        state.selectedNodeId = null;
      }
    },

    // Update workflow in list (e.g., after rename)
    updateWorkflow: (state, action: PayloadAction<{ id: string; changes: Partial<Workflow> }>) => {
      const { id, changes } = action.payload;
      const index = state.workflows.findIndex((w) => w.id === id);
      if (index !== -1) {
        state.workflows[index] = { ...state.workflows[index], ...changes };
      }
    },

    // Request opening map view (e.g., from spatial filter creation)
    requestMapView: (state) => {
      state.requestMapView = true;
    },

    // Clear map view request (after handling)
    clearMapViewRequest: (state) => {
      state.requestMapView = false;
    },

    // Request opening table view
    requestTableView: (state) => {
      state.requestTableView = true;
    },

    // Clear table view request (after handling)
    clearTableViewRequest: (state) => {
      state.requestTableView = false;
    },

    // Set active data panel view (for tracking selected state of Table/Map buttons)
    setActiveDataPanelView: (state, action: PayloadAction<"table" | "map" | null>) => {
      state.activeDataPanelView = action.payload;
    },

    // ==========================================
    // Workflow variables
    // ==========================================

    // Set all variables (bulk replace)
    setVariables: (state, action: PayloadAction<WorkflowVariable[]>) => {
      state.variables = action.payload;
      state.isDirty = true;
      state.contentDirty = true;
    },

    // Add a new variable
    addVariable: (state, action: PayloadAction<WorkflowVariable>) => {
      state.variables.push(action.payload);
      state.isDirty = true;
      state.contentDirty = true;
    },

    // Update a variable by id
    updateVariable: (
      state,
      action: PayloadAction<{ id: string; changes: Partial<WorkflowVariable> }>
    ) => {
      const { id, changes } = action.payload;
      const index = state.variables.findIndex((v) => v.id === id);
      if (index !== -1) {
        state.variables[index] = { ...state.variables[index], ...changes };
        state.isDirty = true;
        state.contentDirty = true;
      }
    },

    // Remove a variable by id
    removeVariable: (state, action: PayloadAction<string>) => {
      state.variables = state.variables.filter((v) => v.id !== action.payload);
      state.isDirty = true;
      state.contentDirty = true;
    },
  },
});

export const {
  setWorkflows,
  addWorkflow,
  removeWorkflow,
  selectWorkflow,
  setNodes,
  setEdges,
  addNode,
  updateNode,
  removeNodes,
  addEdge,
  removeEdges,
  updateNodePositions,
  selectNode,
  updateViewport,
  syncToWorkflowConfig,
  markSaved,
  setWorkflowRevision,
  reloadWorkflow,
  requestWorkflowReload,
  restoreCanvas,
  updateWorkflow,
  requestMapView,
  clearMapViewRequest,
  requestTableView,
  clearTableViewRequest,
  setActiveDataPanelView,
  setVariables,
  addVariable,
  updateVariable,
  removeVariable,
} = workflowSlice.actions;

export const workflowReducer = workflowSlice.reducer;
