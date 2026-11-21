"use client";

import React, { type ReactNode, createContext, useContext, useMemo, useRef } from "react";

import type { LayerStyle } from "@/lib/style/generated/types";

export type NodeExecutionStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface NodeExecutionInfo {
  status: NodeExecutionStatus;
  startedAt?: number; // Unix timestamp in seconds
  durationMs?: number; // Duration in milliseconds (set when completed)
}

interface WorkflowExecutionContextValue {
  isExecuting: boolean;
  nodeStatuses: Record<string, NodeExecutionStatus>;
  nodeExecutionInfo: Record<string, NodeExecutionInfo>;
  tempLayerIds: Record<string, string>;
  exportedLayerIds: Record<string, string>;
  tempLayerStyles: Record<string, LayerStyle>;
  onSaveNode?: (nodeId: string, layerName?: string) => Promise<string | null>;
}

const WorkflowExecutionContext = createContext<WorkflowExecutionContextValue>({
  isExecuting: false,
  nodeStatuses: {},
  nodeExecutionInfo: {},
  tempLayerIds: {},
  exportedLayerIds: {},
  tempLayerStyles: {},
});

export interface WorkflowExecutionProviderProps {
  children: ReactNode;
  isExecuting: boolean;
  nodeStatuses: Record<string, NodeExecutionStatus>;
  nodeExecutionInfo: Record<string, NodeExecutionInfo>;
  tempLayerIds: Record<string, string>;
  exportedLayerIds: Record<string, string>;
  tempLayerStyles: Record<string, LayerStyle>;
  onSaveNode?: (nodeId: string, layerName?: string) => Promise<string | null>;
}

/**
 * Shallow-compare two Record<string, T> objects.
 * Returns the previous reference if content is identical, avoiding unnecessary re-renders.
 */
function useStableRecord<T>(record: Record<string, T>): Record<string, T> {
  const ref = useRef(record);
  const keys = Object.keys(record);
  const prevKeys = Object.keys(ref.current);

  if (
    keys.length !== prevKeys.length ||
    keys.some((k) => record[k] !== ref.current[k])
  ) {
    ref.current = record;
  }

  return ref.current;
}

export const WorkflowExecutionProvider: React.FC<WorkflowExecutionProviderProps> = ({
  children,
  isExecuting,
  nodeStatuses,
  nodeExecutionInfo,
  tempLayerIds,
  exportedLayerIds,
  tempLayerStyles,
  onSaveNode,
}) => {
  const stableNodeStatuses = useStableRecord(nodeStatuses);
  const stableNodeExecutionInfo = useStableRecord(nodeExecutionInfo);
  const stableTempLayerIds = useStableRecord(tempLayerIds);
  const stableExportedLayerIds = useStableRecord(exportedLayerIds);
  const stableTempLayerStyles = useStableRecord(tempLayerStyles);

  const value = useMemo(
    () => ({
      isExecuting,
      nodeStatuses: stableNodeStatuses,
      nodeExecutionInfo: stableNodeExecutionInfo,
      tempLayerIds: stableTempLayerIds,
      exportedLayerIds: stableExportedLayerIds,
      tempLayerStyles: stableTempLayerStyles,
      onSaveNode,
    }),
    [isExecuting, stableNodeStatuses, stableNodeExecutionInfo, stableTempLayerIds, stableExportedLayerIds, stableTempLayerStyles, onSaveNode]
  );

  return (
    <WorkflowExecutionContext.Provider value={value}>
      {children}
    </WorkflowExecutionContext.Provider>
  );
};

export const useWorkflowExecutionContext = (): WorkflowExecutionContextValue => {
  return useContext(WorkflowExecutionContext);
};

/**
 * Per-node selector hook — only triggers a re-render when this specific node's
 * status or execution info actually changes.
 */
export const useNodeExecutionStatus = (nodeId: string) => {
  const { nodeStatuses, nodeExecutionInfo, tempLayerIds, exportedLayerIds } =
    useWorkflowExecutionContext();

  const status = nodeStatuses[nodeId];
  const info = nodeExecutionInfo[nodeId];
  const tempLayerId = tempLayerIds[nodeId];
  const exportedLayerId = exportedLayerIds[nodeId];

  return useMemo(
    () => ({ status, info, tempLayerId, exportedLayerId }),
    [status, info, tempLayerId, exportedLayerId]
  );
};
