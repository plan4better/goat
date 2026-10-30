import useSWR, { mutate } from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { PROCESSES_BASE_URL } from "@/lib/constants";
// ============================================================================
// Temp Layer Data API (for workflow preview)
// ============================================================================
import { GEOAPI_BASE_URL } from "@/lib/constants";
import { OutOfCreditsError } from "@/lib/utils/credits";
import type { Workflow, WorkflowCreate, WorkflowUpdate } from "@/lib/validations/workflow";

import { PROJECTS_API_BASE_URL } from "./projects";

// Workflows API on Processes service
const WORKFLOWS_API_BASE_URL = `${PROCESSES_BASE_URL}/workflows`;

// Types for Workflow Execution

export interface WorkflowExecuteRequest {
  project_id: string;
  folder_id: string;
  nodes: unknown[];
  edges: unknown[];
  variables?: { name: string; type: string; defaultValue?: string | number }[];
}

export interface WorkflowExecuteResponse {
  job_id: string;
  workflow_id: string;
  status: string;
}

export interface WorkflowFinalizeRequest {
  workflow_id: string;
  node_id: string;
  project_id: string;
  layer_name?: string;
}

export interface WorkflowFinalizeResponse {
  job_id: string;
}

export interface WorkflowCleanupResponse {
  status: string;
  message: string;
}

// ============================================================================
// SWR keys
// ============================================================================

/** SWR key of the workflow list of one project. */
const workflowListKey = (projectId: string) => [`${PROJECTS_API_BASE_URL}/${projectId}/workflow`];

/** SWR key of one workflow, including its stored config. The read hooks key on
 * an array, so an invalidation only matches when it uses the same shape. */
const workflowKey = (projectId: string, workflowId: string) => [
  `${PROJECTS_API_BASE_URL}/${projectId}/workflow/${workflowId}`,
];

/** Invalidate one workflow so every consumer of its stored config — the
 * "Save as template" dialog, the workflow runner, the print page — reads what
 * the server now holds. `updateWorkflow` calls this itself; the workflow list
 * key stays with the callers, several of which update it optimistically
 * without revalidating to keep unsaved editor state. */
export const refreshWorkflow = (projectId: string, workflowId: string) =>
  mutate(workflowKey(projectId, workflowId));

// ============================================================================
// Hooks
// ============================================================================

/**
 * Fetch all workflows for a project
 */
export const useWorkflows = (projectId?: string) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<Workflow[]>(
    () => (projectId ? workflowListKey(projectId) : null),
    fetcher
  );

  return {
    workflows: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

/**
 * Fetch a specific workflow
 */
export const useWorkflow = (projectId?: string, workflowId?: string) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<Workflow>(
    () => (projectId && workflowId ? workflowKey(projectId, workflowId) : null),
    fetcher
  );

  return {
    workflow: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

// ============================================================================
// API Functions
// ============================================================================

/**
 * Create a new workflow
 */
export const createWorkflow = async (projectId: string, workflow: WorkflowCreate): Promise<Workflow> => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/workflow`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(workflow),
  });
  if (!response.ok) {
    throw new Error("Failed to create workflow");
  }
  return await response.json();
};

/**
 * Update an existing workflow
 */
export const updateWorkflow = async (
  projectId: string,
  workflowId: string,
  workflow: WorkflowUpdate
): Promise<Workflow> => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/workflow/${workflowId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(workflow),
  });
  if (!response.ok) {
    throw new Error("Failed to update workflow");
  }
  const updated = await response.json();
  refreshWorkflow(projectId, workflowId);
  return updated;
};

/**
 * Delete a workflow
 */
export const deleteWorkflow = async (projectId: string, workflowId: string): Promise<void> => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/workflow/${workflowId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error("Failed to delete workflow");
  }
};

/**
 * Duplicate a workflow
 */
export const duplicateWorkflow = async (
  projectId: string,
  workflowId: string,
  newName?: string
): Promise<Workflow> => {
  let url = `${PROJECTS_API_BASE_URL}/${projectId}/workflow/${workflowId}/duplicate`;
  if (newName) {
    url += `?new_name=${encodeURIComponent(newName)}`;
  }
  const response = await apiRequestAuth(url, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error("Failed to duplicate workflow");
  }
  return await response.json();
};

// ============================================================================
// Workflow Execution API Functions
// ============================================================================

/**
 * A run processes refused: the workflow's own nodes that hold datasets the
 * caller may not use, and whether the project or folder it writes to is
 * refused.
 */
export class WorkflowRefusedError extends Error {
  constructor(
    public readonly refusedNodes: string[],
    public readonly destinationRefused: boolean
  ) {
    super("Workflow refused");
    this.name = "WorkflowRefusedError";
  }
}

const refusal = (body: string): WorkflowRefusedError | undefined => {
  try {
    const detail = (
      JSON.parse(body) as { detail?: { refused_nodes?: unknown; destination_refused?: unknown } }
    ).detail;
    if (detail && Array.isArray(detail.refused_nodes)) {
      return new WorkflowRefusedError(detail.refused_nodes.map(String), detail.destination_refused === true);
    }
  } catch {
    // Not JSON: an error page or plain text.
  }
  return undefined;
};

/**
 * Execute a workflow via Windmill
 */
export const executeWorkflow = async (
  workflowId: string,
  request: WorkflowExecuteRequest
): Promise<WorkflowExecuteResponse> => {
  const response = await apiRequestAuth(`${WORKFLOWS_API_BASE_URL}/${workflowId}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    if (response.status === 402) throw new OutOfCreditsError();
    const error = await response.text();
    throw refusal(error) ?? new Error(`Failed to execute workflow: ${error}`);
  }
  return await response.json();
};

/**
 * Finalize a temporary workflow layer (save to permanent storage)
 */
export const finalizeWorkflowLayer = async (
  workflowId: string,
  request: WorkflowFinalizeRequest
): Promise<WorkflowFinalizeResponse> => {
  const response = await apiRequestAuth(`${WORKFLOWS_API_BASE_URL}/${workflowId}/finalize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to finalize layer: ${error}`);
  }
  return await response.json();
};

/**
 * Cleanup temporary workflow files
 */
export const cleanupWorkflowTemp = async (
  workflowId: string,
  nodeIds?: string[]
): Promise<WorkflowCleanupResponse> => {
  let url = `${WORKFLOWS_API_BASE_URL}/${workflowId}/temp`;
  if (nodeIds && nodeIds.length > 0) {
    url += `?node_ids=${nodeIds.join(",")}`;
  }
  const response = await apiRequestAuth(url, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error("Failed to cleanup temp files");
  }
  return await response.json();
};

// ============================================================================
// Schema Prediction for Workflow Nodes
// ============================================================================

export interface NodeMetadata {
  node_type: string;
  executed: boolean;
  layer_id: string | null;
  columns: Record<string, string> | null;
  geometry_type: string | null;
  process_id: string | null;
}

export interface WorkflowMetadataResponse {
  workflow_id: string;
  nodes: Record<string, NodeMetadata>;
}

export interface InputSchemaInfo {
  layer_id?: string | null;
  source_node_id?: string | null;
  columns?: Record<string, string> | null;
}

export interface PredictSchemaRequest {
  process_id: string;
  input_schemas: Record<string, InputSchemaInfo>;
  params: Record<string, unknown>;
}

export interface PredictedSchemaResponse {
  columns: Record<string, string>;
  geometry_type: string | null;
  geometry_column: string;
}

/**
 * Fetch metadata for all executed nodes in a workflow
 */
export const getWorkflowMetadata = async (workflowId: string): Promise<WorkflowMetadataResponse> => {
  const response = await apiRequestAuth(`${WORKFLOWS_API_BASE_URL}/${workflowId}/metadata`);
  if (!response.ok) {
    if (response.status === 404) {
      return { workflow_id: workflowId, nodes: {} };
    }
    throw new Error("Failed to fetch workflow metadata");
  }
  return await response.json();
};

/**
 * Hook to fetch workflow metadata with SWR
 */
export const useWorkflowMetadata = (workflowId?: string) => {
  const { data, isLoading, error, mutate } = useSWR<WorkflowMetadataResponse>(
    workflowId ? [`${WORKFLOWS_API_BASE_URL}/${workflowId}/metadata`] : null,
    fetcher
  );

  return {
    metadata: data,
    isLoading,
    isError: error,
    mutate,
  };
};

/**
 * Predict output schema for a tool node before execution
 */
export const predictNodeSchema = async (
  workflowId: string,
  request: PredictSchemaRequest
): Promise<PredictedSchemaResponse> => {
  const response = await apiRequestAuth(`${WORKFLOWS_API_BASE_URL}/${workflowId}/predict-schema`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error("Failed to predict schema");
  }
  return await response.json();
};

// ============================================================================

// ============================================================================

export interface TempLayerMetadata {
  layer_name: string;
  geometry_type: string | null;
  feature_count: number;
  bbox: number[] | null;
  columns: Record<string, string>;
  workflow_id: string;
  node_id: string;
}

export interface TempLayerFeaturesResponse {
  type: "FeatureCollection";
  features: unknown[];
  numberMatched?: number;
  numberReturned?: number;
}

/**
 * Fetch temp layer features (GeoJSON) using the standard features endpoint
 * with temp=true query param
 */
export const getTempLayerFeatures = async (
  layerId: string,
  params?: { limit?: number; offset?: number }
): Promise<TempLayerFeaturesResponse> => {
  const searchParams = new URLSearchParams();
  searchParams.set("temp", "true");
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));

  const url = `${GEOAPI_BASE_URL}/collections/${layerId}/items?${searchParams.toString()}`;

  const response = await apiRequestAuth(url);
  if (!response.ok) {
    throw new Error("Failed to fetch temp layer features");
  }
  return await response.json();
};

/**
 * Hook to fetch temp layer features with SWR
 * URL format: /collections/{layer_uuid}/items?temp=true
 */
export const useTempLayerFeatures = (
  layerId: string | undefined,
  params?: { limit?: number; offset?: number }
) => {
  const searchParams = new URLSearchParams();
  searchParams.set("temp", "true");
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));

  const url = layerId ? `${GEOAPI_BASE_URL}/collections/${layerId}/items?${searchParams.toString()}` : null;

  const { data, isLoading, error, mutate } = useSWR<TempLayerFeaturesResponse>(url ? [url] : null, fetcher);

  return {
    data,
    isLoading,
    isError: error,
    mutate,
  };
};
