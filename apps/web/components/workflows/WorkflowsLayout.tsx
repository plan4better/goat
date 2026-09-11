"use client";

import { Box, useTheme } from "@mui/material";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import React, { useCallback, useEffect, useRef } from "react";
import { MapProvider } from "react-map-gl/maplibre";
import { useDispatch, useSelector } from "react-redux";
import { v4 as uuidv4 } from "uuid";

import { updateWorkflow as updateWorkflowApi, useWorkflows } from "@/lib/api/workflows";
import type { AppDispatch } from "@/lib/store";
import {
  selectEdges,
  selectIsDirty,
  selectNodes,
  selectSelectedNode,
  selectSelectedNodeId,
  selectSelectedWorkflow,
  selectSelectedWorkflowId,
  selectVariables,
  selectViewport,
  selectWorkflows,
} from "@/lib/store/workflow/selectors";
import {
  addNode,
  markSaved,
  selectWorkflow,
  setWorkflows,
  syncToWorkflowConfig,
} from "@/lib/store/workflow/slice";
import { parseCQLQueryToObject } from "@/lib/transformers/filter";
import type { Project, ProjectLayer, ProjectLayerGroup } from "@/lib/validations/project";
import { createIfNode } from "@/lib/validations/workflow";
import type { WorkflowNode } from "@/lib/validations/workflow";

import { useWorkflowExecution } from "@/hooks/workflows/useWorkflowExecution";

import WorkflowCanvas from "@/components/workflows/canvas/WorkflowCanvas";
import { WorkflowExecutionProvider } from "@/components/workflows/context/WorkflowExecutionContext";
import WorkflowDataPanel from "@/components/workflows/panels/WorkflowDataPanel";
import WorkflowsConfigPanel from "@/components/workflows/panels/WorkflowsConfigPanel";
import WorkflowsNodesPanel from "@/components/workflows/panels/WorkflowsNodesPanel";

export interface WorkflowsLayoutProps {
  project?: Project;
  projectLayers?: ProjectLayer[];
  projectLayerGroups?: ProjectLayerGroup[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onProjectUpdate?: (key: string, value: any, refresh?: boolean) => void;
}

/**
 * Inner component that has access to ReactFlow context
 */
const WorkflowsLayoutInner: React.FC<WorkflowsLayoutProps> = ({
  project,
  projectLayers = [],
  projectLayerGroups = [],
  onProjectUpdate: _onProjectUpdate,
}) => {
  const theme = useTheme();
  const dispatch = useDispatch<AppDispatch>();
  const reactFlowInstance = useReactFlow();

  // Redux state
  const selectedWorkflowId = useSelector(selectSelectedWorkflowId);
  const selectedWorkflow = useSelector(selectSelectedWorkflow);
  const storeWorkflows = useSelector(selectWorkflows);
  const selectedNodeId = useSelector(selectSelectedNodeId);
  const selectedNode = useSelector(selectSelectedNode) as WorkflowNode | null;
  const nodes = useSelector(selectNodes);
  const edges = useSelector(selectEdges);
  const viewport = useSelector(selectViewport);
  const isDirty = useSelector(selectIsDirty);
  const variables = useSelector(selectVariables);

  // Ref to track drag data
  const dragDataRef = useRef<{
    nodeType: string;
    toolId?: string;
    projectLayerId?: number;
    layerId?: string;
    layerName?: string;
    geometryType?: string;
    layerType?: string;
    layerCql?: { op: string; args: unknown[] };
  } | null>(null);

  // Ref for save timeout
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch workflows from API
  const { workflows, mutate: mutateWorkflows } = useWorkflows(project?.id);

  // Workflow execution hook
  const {
    isExecuting,
    canExecute,
    hasUnresolvedInputs,
    nodeStatuses,
    nodeExecutionInfo,
    tempLayerIds,
    exportedLayerIds,
    tempLayerProperties,
    execute,
    cancel,
    finalizeNode,
  } = useWorkflowExecution({
    workflow: selectedWorkflow ?? undefined,
    projectId: project?.id,
    folderId: project?.folder_id,
  });

  // Sync workflows from API to Redux
  useEffect(() => {
    if (workflows) {
      dispatch(setWorkflows(workflows));
    }
  }, [workflows, dispatch]);

  // Auto-save when dirty (debounced)
  useEffect(() => {
    if (!isDirty || !selectedWorkflow || !project?.id) return;

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce save by 1 second
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        // Sync current state to workflow config
        dispatch(syncToWorkflowConfig());

        // Build config from current state with proper typing
        const config: typeof selectedWorkflow.config = {
          ...selectedWorkflow.config,
          nodes: nodes.map((node) => ({
            id: node.id,
            type: node.type as "dataset" | "tool",
            position: node.position,
            data: node.data as (typeof selectedWorkflow.config.nodes)[number]["data"],
          })),
          edges: edges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            sourceHandle: edge.sourceHandle || undefined,
            target: edge.target,
            targetHandle: edge.targetHandle || undefined,
          })),
          viewport,
          variables,
        };

        await updateWorkflowApi(project.id, selectedWorkflow.id, { config });
        dispatch(markSaved());
        mutateWorkflows();
      } catch (error) {
        console.error("Failed to save workflow:", error);
      }
    }, 1000);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [isDirty, selectedWorkflow, project?.id, nodes, edges, viewport, variables, dispatch, mutateWorkflows]);

  // Handle workflow selection (from config panel)
  // Only dispatch if the ID actually changes to avoid clearing selectedNodeId
  const handleSelectWorkflow = useCallback(
    (workflow: { id: string } | null) => {
      const newId = workflow?.id ?? null;
      if (newId === selectedWorkflowId) return;
      // `selectWorkflow` reads the config from the store's list. A workflow
      // the panel just created is in the fetched list before the effect
      // above has copied it over, so the store is brought up to date first.
      if (newId && workflows && !storeWorkflows.some((w) => w.id === newId)) {
        dispatch(setWorkflows(workflows));
      }
      dispatch(selectWorkflow(newId));
    },
    [dispatch, selectedWorkflowId, workflows, storeWorkflows]
  );

  // Handle drag start from nodes panel
  const handleDragStart = useCallback(
    (event: React.DragEvent, nodeType: string, toolId?: string, _layerId?: string) => {
      dragDataRef.current = { nodeType, toolId };
      event.dataTransfer.setData("application/reactflow", nodeType);
      event.dataTransfer.effectAllowed = "move";
    },
    []
  );

  // Handle drag start from layer tree (for dropping layers directly onto canvas)
  const handleLayerDragStart = useCallback(
    (event: React.DragEvent, layer: ProjectLayer) => {
      // Extract CQL filter if present
      const layerCql = layer.query?.cql as { op?: string; args?: unknown[] } | undefined;
      const hasValidCql = layerCql?.op && layerCql?.args && layerCql.args.length > 0;

      dragDataRef.current = {
        nodeType: "dataset",
        projectLayerId: layer.id, // ProjectLayer.id (number) — canonical for live name lookup
        layerId: layer.layer_id, // Dataset UUID — used for tiles/features/fields API calls
        layerName: layer.name,
        geometryType: layer.feature_layer_geometry_type || undefined,
        layerType: layer.type || undefined,
        layerCql: hasValidCql ? (layerCql as { op: string; args: unknown[] }) : undefined,
      };
      event.dataTransfer.setData("application/reactflow", "dataset");
      event.dataTransfer.effectAllowed = "move";

      // Create a custom drag image that looks like a dataset node
      const dragImage = document.createElement("div");
      dragImage.style.cssText = `
        padding: 12px;
        border-radius: 4px;
        background-color: ${theme.palette.background.paper};
        border: 2px solid ${theme.palette.primary.main};
        box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        font-family: ${theme.typography.fontFamily};
        font-size: 14px;
        font-weight: bold;
        color: ${theme.palette.text.primary};
        display: flex;
        align-items: center;
        gap: 8px;
        position: absolute;
        top: -1000px;
        left: -1000px;
        white-space: nowrap;
      `;
      dragImage.textContent = layer.name;
      document.body.appendChild(dragImage);
      event.dataTransfer.setDragImage(dragImage, 0, 0);

      // Clean up the element after drag starts
      setTimeout(() => {
        document.body.removeChild(dragImage);
      }, 0);
    },
    [theme]
  );

  // Handle drag over canvas
  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  // Handle drop on canvas
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      if (!selectedWorkflowId || !dragDataRef.current || !reactFlowInstance) return;

      const { nodeType, toolId, projectLayerId, layerId, layerName, geometryType, layerType, layerCql } =
        dragDataRef.current;
      dragDataRef.current = null;

      // Get canvas position from drop coordinates - use screen coordinates directly
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      if (nodeType === "dataset") {
        // Check if this is a layer drag (has layerId) or empty dataset drag
        if (layerId && layerName) {
          // Convert layer's CQL filter to workflow filter format (one-way copy)
          let inheritedFilter: { op: string; expressions: unknown[] } | undefined;
          if (layerCql) {
            try {
              const expressions = parseCQLQueryToObject(layerCql);
              if (expressions.length > 0) {
                inheritedFilter = {
                  op: layerCql.op,
                  expressions,
                };
              }
            } catch {
              // Ignore parse errors, just don't inherit filter
            }
          }

          // Create dataset node pre-populated with layer data and inherited filter
          dispatch(
            addNode({
              id: `dataset-${uuidv4()}`,
              type: "dataset",
              position,
              data: {
                type: "dataset",
                label: layerName,
                projectLayerId: projectLayerId,
                layerId: layerId,
                layerName: layerName,
                geometryType: geometryType || undefined,
                layerType: (layerType as "feature" | "table" | "raster") || undefined,
                filter: inheritedFilter,
                filterInitialized: true, // Mark as initialized so settings panel doesn't re-copy
              },
            })
          );
        } else {
          // Empty dataset node
          dispatch(
            addNode({
              id: `dataset-${uuidv4()}`,
              type: "dataset",
              position,
              data: {
                type: "dataset",
                label: "Dataset",
              },
            })
          );
        }
      } else if (nodeType === "tool" && toolId) {
        dispatch(
          addNode({
            id: `tool-${uuidv4()}`,
            type: "tool",
            position,
            data: {
              type: "tool",
              label: toolId,
              processId: toolId,
              config: {},
              status: "idle",
            },
          })
        );
      } else if (nodeType === "export") {
        dispatch(
          addNode({
            id: `export-${uuidv4()}`,
            type: "export",
            position,
            data: {
              type: "export",
              label: "Export Dataset",
              datasetName: "",
              addToProject: true,
              overwritePrevious: false,
              status: "idle",
            },
          })
        );
      } else if (nodeType === "if") {
        dispatch(addNode(createIfNode(`if-${uuidv4()}`, position)));
      }
    },
    [selectedWorkflowId, reactFlowInstance, dispatch]
  );

  return (
    <MapProvider>
      <WorkflowExecutionProvider
        isExecuting={isExecuting}
        nodeStatuses={nodeStatuses}
        nodeExecutionInfo={nodeExecutionInfo}
        tempLayerIds={tempLayerIds}
        exportedLayerIds={exportedLayerIds}
        tempLayerProperties={tempLayerProperties}
        onSaveNode={finalizeNode}>
        <Box
          sx={{
            display: "flex",
            width: "100%",
            height: "100%",
            overflow: "hidden",
            backgroundColor: theme.palette.background.default,
          }}>
          {/* Left Panel - Workflow list and Layers */}
          <WorkflowsConfigPanel
            project={project}
            projectLayers={projectLayers}
            projectLayerGroups={projectLayerGroups}
            selectedWorkflow={selectedWorkflow ?? null}
            onSelectWorkflow={handleSelectWorkflow}
            onLayerDragStart={handleLayerDragStart}
          />

          {/* Center - Canvas and Data Panel */}
          <Box
            sx={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              height: "100%",
              overflow: "hidden",
            }}>
            {/* Canvas area */}
            <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
              <WorkflowCanvas
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                isExecuting={isExecuting}
                canExecute={canExecute}
                hasUnresolvedInputs={hasUnresolvedInputs}
                onRun={execute}
                onStop={cancel}
              />
            </Box>

            {/* Bottom Data Panel - Table/Map view */}
            <WorkflowDataPanel
              selectedNode={selectedNode}
              tempLayerIds={tempLayerIds}
              tempLayerProperties={tempLayerProperties}
              workflowId={selectedWorkflow?.id}
            />
          </Box>

          {/* Right Panel - Tools palette & Node Settings */}
          <WorkflowsNodesPanel
            config={selectedWorkflow?.config || null}
            selectedNodeId={selectedNodeId}
            projectLayers={projectLayers}
            workflowId={selectedWorkflow?.id}
            onDragStart={handleDragStart}
          />
        </Box>
      </WorkflowExecutionProvider>
    </MapProvider>
  );
};

/**
 * Main WorkflowsLayout component wrapped with ReactFlowProvider
 */
const WorkflowsLayout: React.FC<WorkflowsLayoutProps> = (props) => {
  return (
    <ReactFlowProvider>
      <WorkflowsLayoutInner {...props} />
    </ReactFlowProvider>
  );
};

export default WorkflowsLayout;
