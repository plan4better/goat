import type { RootState } from "@/lib/store";

// Select all workflows
export const selectWorkflows = (state: RootState) => state.workflow.workflows;

// Select currently selected workflow
export const selectSelectedWorkflow = (state: RootState) => {
  const { workflows, selectedWorkflowId } = state.workflow;
  return selectedWorkflowId ? workflows.find((w) => w.id === selectedWorkflowId) : null;
};

// Select selected workflow id
export const selectSelectedWorkflowId = (state: RootState) => state.workflow.selectedWorkflowId;

// Select selected node id
export const selectSelectedNodeId = (state: RootState) => state.workflow.selectedNodeId;

// Select ReactFlow nodes
export const selectNodes = (state: RootState) => state.workflow.nodes;

// Select ReactFlow edges
export const selectEdges = (state: RootState) => state.workflow.edges;

// Select viewport
export const selectViewport = (state: RootState) => state.workflow.viewport;

// Select dirty flag
export const selectIsDirty = (state: RootState) => state.workflow.isDirty;

// Select a specific node by id
export const selectNodeById = (id: string) => (state: RootState) =>
  state.workflow.nodes.find((n) => n.id === id);

// Select the currently selected node
export const selectSelectedNode = (state: RootState) => {
  const { nodes, selectedNodeId } = state.workflow;
  return selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : null;
};

// Select map view request flag
export const selectRequestMapView = (state: RootState) => state.workflow.requestMapView;

// Select table view request flag
export const selectRequestTableView = (state: RootState) => state.workflow.requestTableView;

// Select active data panel view (table, map, or null for collapsed)
export const selectActiveDataPanelView = (state: RootState) => state.workflow.activeDataPanelView;

// Select workflow variables
export const selectVariables = (state: RootState) => state.workflow.variables;

// Counts the times the open canvas's steps were replaced as a whole
export const selectCanvasVersion = (state: RootState) => state.workflow.canvasVersion;

// The revision of a change made elsewhere that the open workflow takes over, if one is waiting
export const selectOpenReloadRequest = (state: RootState) => {
  const open = state.workflow.selectedWorkflowId;
  return open === null ? undefined : state.workflow.reloadRequests[open];
};

// Unsaved changes beyond the view (pan, zoom)
export const selectContentDirty = (state: RootState) => state.workflow.contentDirty;
