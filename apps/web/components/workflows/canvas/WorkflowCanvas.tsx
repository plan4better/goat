"use client";

import CollapseIcon from "@mui/icons-material/CloseFullscreen";
import ExpandIcon from "@mui/icons-material/OpenInFull";
import FitViewIcon from "@mui/icons-material/FitScreen";
import LockIcon from "@mui/icons-material/Lock";
import UnlockIcon from "@mui/icons-material/LockOpen";
import WorkflowIcon from "@mui/icons-material/AccountTree";
import ZoomInIcon from "@mui/icons-material/Add";
import ZoomOutIcon from "@mui/icons-material/Remove";
import { Box, IconButton, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { styled } from "@mui/material/styles";
import {
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type EdgeTypes,
  MiniMap,
  type Node,
  type NodeTypes,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
  type Viewport,
  useEdgesState,
  useNodesState,
  useOnSelectionChange,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { v4 as uuidv4 } from "uuid";

import type { AppDispatch } from "@/lib/store";
import {
  selectCanvasVersion,
  selectEdges,
  selectNodes,
  selectSelectedNodeId,
  selectSelectedWorkflowId,
  selectViewport,
} from "@/lib/store/workflow/selectors";
import {
  addEdge as addEdgeAction,
  addNode,
  removeEdges,
  removeNodes,
  selectNode,
  updateNodePositions,
  updateViewport,
} from "@/lib/store/workflow/slice";
import type { WorkflowNode } from "@/lib/validations/workflow";
import { createTextAnnotationNode } from "@/lib/validations/workflow";

import { useConnectionValidator, useWorkflowProcessDescriptions } from "@/hooks/map/useConnectionValidation";
import { useCurrentDatasetTypes } from "@/hooks/workflows/useCurrentDatasetTypes";
import { useWorkflowHistory } from "@/hooks/workflows/useWorkflowHistory";

import WorkflowVariablesDialog from "../dialogs/WorkflowVariablesDialog";
import DeletableEdge from "../edges/DeletableEdge";
import DatasetNode from "../nodes/DatasetNode";
import ExportNode from "../nodes/ExportNode";
import IfNode from "../nodes/IfNode";
import TextAnnotationNode from "../nodes/TextAnnotationNode";
import ToolNode from "../nodes/ToolNode";
import { AnimatedEdgeStyles, BorderAnglePropertyStyles } from "../nodes/shared";
import CanvasToolbar from "./CanvasToolbar";

const CanvasContainer = styled(Box)(({ theme }) => ({
  flex: 1,
  height: "100%",
  position: "relative",
  backgroundColor: theme.palette.background.default,
  "& .react-flow__attribution": {
    display: "none",
  },
  // Ensure nodes render above edges
  "& .react-flow__edges": {
    zIndex: 0,
  },
  "& .react-flow__nodes": {
    zIndex: 1,
  },
}));

// Collapsible MiniMap container
const MiniMapContainer = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isExpanded" && prop !== "isHovered",
})<{ isExpanded: boolean; isHovered: boolean }>(({ isExpanded }) => ({
  position: "absolute",
  bottom: 10,
  right: 10,
  zIndex: 5,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  "& .react-flow__minimap": {
    position: "relative !important" as "relative",
    margin: 0,
    display: isExpanded ? "block" : "none",
  },
}));

const MiniMapToggleButton = styled(IconButton)(({ theme }) => ({
  width: 36,
  height: 36,
  backgroundColor: theme.palette.background.paper,
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: theme.shape.borderRadius,
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.08)",
  // When used as collapse button (on hover over minimap), no shadow
  "&.collapse-button": {
    boxShadow: "none",
  },
}));

// Custom controls container
const ControlsContainer = styled(Stack)(({ theme }) => ({
  backgroundColor: theme.palette.background.paper,
  borderRadius: theme.shape.borderRadius * 2,
  border: `1px solid ${theme.palette.divider}`,
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.08)",
  overflow: "hidden",
}));

const ControlButton = styled(IconButton)(({ theme }) => ({
  width: 36,
  height: 36,
  borderRadius: 0,
  "&:hover": {
    backgroundColor: theme.palette.action.hover,
  },
}));

const MiniMapWrapper = styled(Box)(({ theme }) => ({
  position: "relative",
  backgroundColor: theme.palette.background.paper,
  borderRadius: theme.shape.borderRadius,
  border: `1px solid ${theme.palette.divider}`,
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.08)",
  overflow: "hidden",
  "& .collapse-button": {
    position: "absolute",
    top: 4,
    left: 4,
    zIndex: 10,
    opacity: 0,
    transition: "opacity 0.2s ease",
  },
  "&:hover .collapse-button": {
    opacity: 1,
  },
}));

const EmptyState = styled(Box)(({ theme }) => ({
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: theme.spacing(1),
  color: theme.palette.text.secondary,
  pointerEvents: "none",
}));

const EmptyStateCard = styled(Box)(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: theme.spacing(1.5),
  padding: theme.spacing(4),
  backgroundColor: theme.palette.background.paper,
  borderRadius: theme.shape.borderRadius * 2,
  border: `1px dashed ${theme.palette.divider}`,
  maxWidth: 320,
  textAlign: "center",
}));

const EmptyStateIconWrapper = styled(Box)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 64,
  height: 64,
  borderRadius: theme.shape.borderRadius,
  backgroundColor: theme.palette.action.hover,
  color: theme.palette.text.secondary,
}));

// React Flow's default minZoom (0.5) is too tight to see a large workflow as a
// whole; zoom-out, wheel/trackpad and fit view all share this limit.
export const WORKFLOW_CANVAS_MIN_ZOOM = 0.1;

// Custom Controls component with MUI buttons and tooltips
interface CustomControlsProps {
  isLocked: boolean;
  onToggleLock: () => void;
}

const CustomControls: React.FC<CustomControlsProps> = ({ isLocked, onToggleLock }) => {
  const { t } = useTranslation("common");
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <ControlsContainer>
      <Tooltip title={t("zoom_in")} placement="right" arrow>
        <ControlButton onClick={() => zoomIn()}>
          <ZoomInIcon fontSize="small" />
        </ControlButton>
      </Tooltip>
      <Tooltip title={t("zoom_out")} placement="right" arrow>
        <ControlButton onClick={() => zoomOut()}>
          <ZoomOutIcon fontSize="small" />
        </ControlButton>
      </Tooltip>
      <Tooltip title={t("fit_view")} placement="right" arrow>
        <ControlButton onClick={() => fitView({ minZoom: WORKFLOW_CANVAS_MIN_ZOOM })}>
          <FitViewIcon fontSize="small" />
        </ControlButton>
      </Tooltip>
      <Tooltip title={isLocked ? t("unlock") : t("lock")} placement="right" arrow>
        <ControlButton onClick={onToggleLock}>
          {isLocked ? <LockIcon fontSize="small" /> : <UnlockIcon fontSize="small" />}
        </ControlButton>
      </Tooltip>
    </ControlsContainer>
  );
};

// Custom node types for ReactFlow
const nodeTypes: NodeTypes = {
  dataset: DatasetNode,
  tool: ToolNode,
  export: ExportNode,
  textAnnotation: TextAnnotationNode,
  if: IfNode,
};

// Custom edge types for ReactFlow
const edgeTypes: EdgeTypes = {
  deletable: DeletableEdge,
};

interface WorkflowCanvasProps {
  onDrop: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  // Execution props
  isExecuting?: boolean;
  canExecute?: boolean;
  /** Starts a run; resolves true when processes refused it with issues. */
  onRun?: () => void | Promise<boolean>;
  onStop?: () => void;
}

const WorkflowCanvas: React.FC<WorkflowCanvasProps> = ({
  onDrop,
  onDragOver,
  isExecuting = false,
  canExecute = false,
  onRun,
  onStop,
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useDispatch<AppDispatch>();
  const { setViewport, screenToFlowPosition } = useReactFlow();

  // Canvas tool state
  const [activeTool, setActiveTool] = useState<"select" | "text">("select");

  // Lock state - prevents node dragging and panning
  const [isLocked, setIsLocked] = useState(false);

  // MiniMap state
  const [miniMapExpanded, setMiniMapExpanded] = useState(true);
  const [miniMapHovered, setMiniMapHovered] = useState(false);

  // Variables dialog state
  const [variablesDialogOpen, setVariablesDialogOpen] = useState(false);

  // Drawing state for text annotation
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawRect, setDrawRect] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null
  );

  // Undo/Redo history
  const { canUndo, canRedo, undo, redo } = useWorkflowHistory();

  // Get state from Redux
  const reduxNodes = useSelector(selectNodes);
  const reduxEdges = useSelector(selectEdges);
  const selectedWorkflowId = useSelector(selectSelectedWorkflowId);
  const selectedNodeId = useSelector(selectSelectedNodeId);
  const reduxViewport = useSelector(selectViewport);
  const canvasVersion = useSelector(selectCanvasVersion);

  // Get process descriptions for connection validation. Dataset steps are
  // checked with their layer's current type; the store keeps what was stored.
  const workflowNodes = useCurrentDatasetTypes(reduxNodes) as WorkflowNode[];
  const processMap = useWorkflowProcessDescriptions(workflowNodes);
  const validateConnection = useConnectionValidator(workflowNodes, processMap);

  // Local ReactFlow state for smooth dragging
  const [localNodes, setLocalNodes, onNodesChange] = useNodesState<Node>([]);
  const [localEdges, setLocalEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Track if we're syncing from Redux to avoid circular updates
  const isSyncingFromRedux = useRef(false);
  // Track if we're syncing selection to avoid circular updates
  const isSyncingSelectionRef = useRef(false);
  // Track previous workflow id to detect workflow switch
  const prevWorkflowIdRef = useRef<string | null>(null);
  // Track previous node/edge counts to detect structural changes
  const prevNodeCountRef = useRef<number>(0);
  const prevEdgeCountRef = useRef<number>(0);
  // Track the canvas version to detect steps replaced as a whole (undo, redo, a stored version)
  const prevCanvasVersionRef = useRef(canvasVersion);
  // Track if ReactFlow is initialized (for initial viewport restore)
  const isReactFlowReady = useRef(false);
  // Track pending viewport to restore after init
  const pendingViewportRef = useRef<Viewport | null>(null);

  // Sync Redux selectedNodeId to ReactFlow's visual selection
  useEffect(() => {
    isSyncingSelectionRef.current = true;
    setLocalNodes((nodes) =>
      nodes.map((node) => ({
        ...node,
        selected: node.id === selectedNodeId,
      }))
    );
    // Reset flag after state update settles
    queueMicrotask(() => {
      isSyncingSelectionRef.current = false;
    });
  }, [selectedNodeId, setLocalNodes]);

  // Listen to ReactFlow selection changes and sync to Redux
  useOnSelectionChange({
    onChange: ({ nodes }) => {
      // Skip if we're syncing from Redux to local
      if (isSyncingSelectionRef.current) return;

      const newSelectedId = nodes.length > 0 ? nodes[0].id : null;
      // Only dispatch if selection actually changed
      if (newSelectedId !== selectedNodeId) {
        // Defer dispatch to avoid updating during render
        queueMicrotask(() => {
          dispatch(selectNode(newSelectedId));
        });
      }
    },
  });

  // Handle ReactFlow initialization - restore viewport here
  const handleInit = useCallback(
    (_instance: ReactFlowInstance) => {
      isReactFlowReady.current = true;
      // Restore pending viewport if we have one
      if (pendingViewportRef.current) {
        setViewport(pendingViewportRef.current, { duration: 0 });
        pendingViewportRef.current = null;
      }
    },
    [setViewport]
  );

  // Sync from Redux to local state ONLY when workflow changes, structure changes (add/remove), or
  // the steps were replaced as a whole (undo, redo, a stored version loaded over the canvas).
  // We don't want to sync on every Redux update (e.g., position changes) as local state is source of truth during editing
  useEffect(() => {
    const workflowChanged = selectedWorkflowId !== prevWorkflowIdRef.current;
    const nodeCountChanged = reduxNodes.length !== prevNodeCountRef.current;
    const edgeCountChanged = reduxEdges.length !== prevEdgeCountRef.current;
    const replaced = canvasVersion !== prevCanvasVersionRef.current;

    // Update tracking refs
    prevNodeCountRef.current = reduxNodes.length;
    prevEdgeCountRef.current = reduxEdges.length;
    prevCanvasVersionRef.current = canvasVersion;

    // Only do full sync when workflow changes, nodes/edges are added/removed, or they were replaced
    if (workflowChanged || nodeCountChanged || edgeCountChanged || replaced) {
      isSyncingFromRedux.current = true;
      // Ensure text annotation nodes have low zIndex so they stay behind other nodes;
      // the selected step stays selected
      const nodesWithZIndex = reduxNodes.map((node) => ({
        ...node,
        zIndex: node.type === "textAnnotation" ? -1000 : (node.zIndex ?? 0),
        ...(replaced ? { selected: node.id === selectedNodeId } : {}),
      }));
      setLocalNodes(nodesWithZIndex);
      setLocalEdges(reduxEdges);

      // Restore viewport when switching workflows
      if (workflowChanged) {
        prevWorkflowIdRef.current = selectedWorkflowId;
        if (reduxViewport && selectedWorkflowId) {
          if (isReactFlowReady.current) {
            // ReactFlow is ready, set viewport immediately
            setViewport(reduxViewport, { duration: 0 });
          } else {
            // ReactFlow not ready yet, save for onInit
            pendingViewportRef.current = reduxViewport;
          }
        }
      }

      // Reset sync flag after state update
      isSyncingFromRedux.current = false;
    }
  }, [
    reduxNodes,
    reduxEdges,
    selectedWorkflowId,
    reduxViewport,
    canvasVersion,
    selectedNodeId,
    setLocalNodes,
    setLocalEdges,
    setViewport,
  ]);

  // Sync node data (config) changes from Redux to local state
  // This ensures config panel changes are reflected in the canvas without losing positions
  useEffect(() => {
    // Skip if we're already syncing
    if (isSyncingFromRedux.current) return;

    setLocalNodes((currentNodes) =>
      currentNodes.map((localNode) => {
        const reduxNode = reduxNodes.find((n) => n.id === localNode.id);
        if (!reduxNode) return localNode;

        // Check if data has changed (shallow comparison)
        const dataChanged = JSON.stringify(localNode.data) !== JSON.stringify(reduxNode.data);
        if (dataChanged) {
          return {
            ...localNode,
            data: reduxNode.data,
          };
        }
        return localNode;
      })
    );
  }, [reduxNodes, setLocalNodes]);

  // Handle pane click - deselect all nodes (but not when text tool is active)
  const handlePaneClick = useCallback(() => {
    if (activeTool === "text") return; // Don't deselect when drawing
    dispatch(selectNode(null));
  }, [dispatch, activeTool]);

  // Handle node changes (position, removal - selection is handled by useOnSelectionChange)
  const handleNodesChange: OnNodesChange = useCallback(
    (changes) => {
      // Apply all changes locally (including selection for visual feedback)
      onNodesChange(changes);

      // Skip syncing to Redux if we're syncing from Redux
      if (isSyncingFromRedux.current) return;

      // Process position changes for Redux sync
      const positionUpdates: { id: string; position: { x: number; y: number } }[] = [];

      for (const change of changes) {
        if (change.type === "position" && change.position && !change.dragging) {
          // Sync final position to Redux on drag end
          positionUpdates.push({ id: change.id, position: change.position });
        }
      }

      if (positionUpdates.length > 0) {
        dispatch(updateNodePositions(positionUpdates));
      }
    },
    [dispatch, onNodesChange]
  );

  // Handle nodes deleted
  const handleNodesDelete = useCallback(
    (deletedNodes: Node[]) => {
      const ids = deletedNodes.map((n) => n.id);
      dispatch(removeNodes(ids));
    },
    [dispatch]
  );

  // Handle edge changes (removal)
  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      // Always apply changes locally
      onEdgesChange(changes);

      // Skip syncing to Redux if we're syncing from Redux
      if (isSyncingFromRedux.current) return;

      const removedIds: string[] = [];
      for (const change of changes) {
        if (change.type === "remove") {
          removedIds.push(change.id);
        }
      }
      if (removedIds.length > 0) {
        dispatch(removeEdges(removedIds));
      }
    },
    [dispatch, onEdgesChange]
  );

  // Handle new connections
  const handleConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;

      const newEdge: Edge = {
        id: `edge-${uuidv4()}`,
        type: "deletable",
        source: connection.source,
        sourceHandle: connection.sourceHandle,
        target: connection.target,
        targetHandle: connection.targetHandle,
      };

      dispatch(addEdgeAction(newEdge));
    },
    [dispatch]
  );

  // Handle viewport changes (pan/zoom)
  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      dispatch(updateViewport({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }));
    },
    [dispatch]
  );

  // Handle drop events
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      onDrop(event);
    },
    [onDrop]
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      onDragOver(event);
    },
    [onDragOver]
  );

  // Handle mouse down on pane for text tool drawing
  const handlePaneMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (activeTool !== "text") return;

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setIsDrawing(true);
      setDrawStart(position);
      setDrawRect({ x: position.x, y: position.y, width: 0, height: 0 });
    },
    [activeTool, screenToFlowPosition]
  );

  // Handle mouse move for drawing
  const handlePaneMouseMove = useCallback(
    (event: React.MouseEvent) => {
      if (!isDrawing || !drawStart) return;

      const currentPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      // Calculate rectangle dimensions (allow drawing in any direction)
      const x = Math.min(drawStart.x, currentPos.x);
      const y = Math.min(drawStart.y, currentPos.y);
      const width = Math.abs(currentPos.x - drawStart.x);
      const height = Math.abs(currentPos.y - drawStart.y);

      setDrawRect({ x, y, width, height });
    },
    [isDrawing, drawStart, screenToFlowPosition]
  );

  // Handle mouse up to complete drawing
  const handlePaneMouseUp = useCallback(() => {
    if (!isDrawing || !drawRect) {
      setIsDrawing(false);
      setDrawStart(null);
      setDrawRect(null);
      return;
    }

    // Minimum size check (at least 100x50)
    const finalWidth = Math.max(drawRect.width, 200);
    const finalHeight = Math.max(drawRect.height, 100);

    // Create text annotation node
    const newNode = createTextAnnotationNode(
      `text-${uuidv4()}`,
      { x: drawRect.x, y: drawRect.y },
      finalWidth,
      finalHeight
    );

    dispatch(addNode(newNode as WorkflowNode));

    // Reset drawing state and switch back to select tool
    setIsDrawing(false);
    setDrawStart(null);
    setDrawRect(null);
    setActiveTool("select");
  }, [isDrawing, drawRect, dispatch]);

  // Empty state when no workflow selected
  if (!selectedWorkflowId) {
    return (
      <CanvasContainer>
        <EmptyState>
          <WorkflowIcon sx={{ fontSize: 64, opacity: 0.5 }} />
          <Typography variant="h6">{t("no_workflow_selected")}</Typography>
          <Typography variant="body2">{t("select_or_create_workflow")}</Typography>
        </EmptyState>
      </CanvasContainer>
    );
  }

  return (
    <CanvasContainer
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      sx={{ cursor: activeTool === "text" ? "crosshair" : "default" }}>
      <ReactFlow
        nodes={localNodes}
        edges={localEdges}
        onInit={handleInit}
        minZoom={WORKFLOW_CANVAS_MIN_ZOOM}
        onNodesChange={handleNodesChange}
        onNodesDelete={handleNodesDelete}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onPaneClick={handlePaneClick}
        onPaneMouseMove={handlePaneMouseMove}
        onMoveEnd={handleMoveEnd}
        isValidConnection={validateConnection}
        selectionOnDrag={activeTool === "select" && !isLocked}
        panOnDrag={activeTool === "select"}
        nodesDraggable={!isLocked}
        nodesConnectable={!isLocked}
        deleteKeyCode={isLocked ? [] : ["Backspace", "Delete"]}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        elevateNodesOnSelect={true}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: "deletable",
          zIndex: 500, // Edges appear above text annotations (zIndex: 0) but below tool/dataset nodes (zIndex: 1000)
          style: { stroke: theme.palette.grey[500], strokeWidth: 2 },
        }}
        connectionLineStyle={{ stroke: theme.palette.grey[500], strokeWidth: 2 }}>
        <BorderAnglePropertyStyles />
        <AnimatedEdgeStyles />
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Panel position="bottom-left">
          <CustomControls isLocked={isLocked} onToggleLock={() => setIsLocked(!isLocked)} />
        </Panel>
      </ReactFlow>

      {/* Collapsible MiniMap */}
      <MiniMapContainer
        isExpanded={miniMapExpanded}
        isHovered={miniMapHovered}
        onMouseEnter={() => setMiniMapHovered(true)}
        onMouseLeave={() => setMiniMapHovered(false)}>
        {miniMapExpanded ? (
          <MiniMapWrapper>
            <MiniMapToggleButton
              className="collapse-button"
              size="small"
              onClick={() => setMiniMapExpanded(false)}
              title={t("collapse")}>
              <CollapseIcon fontSize="small" />
            </MiniMapToggleButton>
            <MiniMap
              nodeColor={(node) => (node.type === "textAnnotation" ? "transparent" : theme.palette.grey[500])}
              maskColor={theme.palette.mode === "dark" ? "rgba(0,0,0,0.8)" : "rgba(255,255,255,0.8)"}
              style={{ position: "relative", margin: 0 }}
            />
          </MiniMapWrapper>
        ) : (
          <MiniMapToggleButton onClick={() => setMiniMapExpanded(true)} title={t("expand")}>
            <ExpandIcon fontSize="small" />
          </MiniMapToggleButton>
        )}
      </MiniMapContainer>

      {/* Drawing overlay for text annotation tool */}
      {activeTool === "text" && (
        <Box
          onMouseDown={handlePaneMouseDown}
          onMouseMove={handlePaneMouseMove}
          onMouseUp={handlePaneMouseUp}
          onMouseLeave={handlePaneMouseUp}
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            cursor: "crosshair",
            zIndex: 5,
          }}
        />
      )}

      {/* Drawing rectangle preview */}
      {isDrawing && drawRect && (
        <Box
          sx={{
            position: "absolute",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            pointerEvents: "none",
            zIndex: 6,
          }}>
          <svg width="100%" height="100%" style={{ overflow: "visible" }}>
            <rect
              x={drawRect.x}
              y={drawRect.y}
              width={drawRect.width}
              height={drawRect.height}
              fill={theme.palette.primary.main}
              fillOpacity={0.1}
              stroke={theme.palette.primary.main}
              strokeWidth={2}
              strokeDasharray="5,5"
              style={{
                transform: `translate(${reduxViewport?.x || 0}px, ${reduxViewport?.y || 0}px) scale(${reduxViewport?.zoom || 1})`,
                transformOrigin: "0 0",
              }}
            />
          </svg>
        </Box>
      )}

      {/* Bottom Toolbar */}
      <CanvasToolbar
        activeTool={activeTool}
        onToolChange={setActiveTool}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        onRun={onRun || (() => {})}
        onStop={onStop}
        isRunning={isExecuting}
        canRun={canExecute && localNodes.length > 0}
        onVariablesClick={() => setVariablesDialogOpen(true)}
      />

      {/* Variables Dialog */}
      <WorkflowVariablesDialog open={variablesDialogOpen} onClose={() => setVariablesDialogOpen(false)} />

      {/* Empty canvas hint */}
      {localNodes.length === 0 && (
        <EmptyState>
          <EmptyStateCard>
            <EmptyStateIconWrapper>
              <WorkflowIcon sx={{ fontSize: 32 }} />
            </EmptyStateIconWrapper>
            <Typography variant="subtitle1" fontWeight="medium" color="text.primary">
              {t("start_building_workflow")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("drag_tools_to_start")}
            </Typography>
          </EmptyStateCard>
        </EmptyState>
      )}
    </CanvasContainer>
  );
};

export default WorkflowCanvas;
