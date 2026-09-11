import { createSlice } from "@reduxjs/toolkit";
import type { PayloadAction } from "@reduxjs/toolkit";
import type { Edge, Node } from "@xyflow/react";

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
  // Dirty flag for unsaved changes
  isDirty: boolean;
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
  isDirty: false,
  requestMapView: false,
  requestTableView: false,
  activeDataPanelView: null,
};

// Helper to convert WorkflowConfig to ReactFlow format
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
    setWorkflows: (state, action: PayloadAction<Workflow[]>) => {
      const selectedWasKnown = state.workflows.some((w) => w.id === state.selectedWorkflowId);
      state.workflows = action.payload;
      if (!state.selectedWorkflowId || selectedWasKnown || state.isDirty) return;
      const workflow = action.payload.find((w) => w.id === state.selectedWorkflowId);
      if (!workflow) return;
      const { nodes, edges } = configToReactFlow(workflow.config);
      state.nodes = nodes;
      state.edges = edges;
      state.viewport = workflow.config?.viewport ?? { x: 0, y: 0, zoom: 1 };
      state.variables = workflow.config?.variables ?? [];
    },

    // Add a new workflow
    addWorkflow: (state, action: PayloadAction<Workflow>) => {
      state.workflows.push(action.payload);
    },

    // Remove a workflow
    removeWorkflow: (state, action: PayloadAction<string>) => {
      state.workflows = state.workflows.filter((w) => w.id !== action.payload);
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

      if (action.payload) {
        const workflow = state.workflows.find((w) => w.id === action.payload);
        const { nodes, edges } = configToReactFlow(workflow?.config);
        state.nodes = nodes;
        state.edges = edges;
        state.viewport = workflow?.config?.viewport ?? { x: 0, y: 0, zoom: 1 };
        state.variables = workflow?.config?.variables ?? [];
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
    },

    // Set all edges (from ReactFlow)
    setEdges: (state, action: PayloadAction<Edge[]>) => {
      state.edges = action.payload;
      state.isDirty = true;
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
    },

    // Update a single node
    updateNode: (state, action: PayloadAction<{ id: string; changes: Partial<Node> }>) => {
      const { id, changes } = action.payload;
      const index = state.nodes.findIndex((n) => n.id === id);
      if (index !== -1) {
        state.nodes[index] = { ...state.nodes[index], ...changes };
        state.isDirty = true;
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
    },

    // Add an edge
    addEdge: (state, action: PayloadAction<Edge>) => {
      state.edges.push(action.payload);
      state.isDirty = true;
    },

    // Remove edges by ids
    removeEdges: (state, action: PayloadAction<string[]>) => {
      const idsToRemove = new Set(action.payload);
      state.edges = state.edges.filter((e) => !idsToRemove.has(e.id));
      state.isDirty = true;
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
    },

    // Add a new variable
    addVariable: (state, action: PayloadAction<WorkflowVariable>) => {
      state.variables.push(action.payload);
      state.isDirty = true;
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
      }
    },

    // Remove a variable by id
    removeVariable: (state, action: PayloadAction<string>) => {
      state.variables = state.variables.filter((v) => v.id !== action.payload);
      state.isDirty = true;
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
