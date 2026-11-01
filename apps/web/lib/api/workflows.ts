import useSWR, { mutate } from "swr";

import { SAVE_TIMEOUT_MS, changedElsewhere } from "@/lib/api/changedElsewhere";
import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { PROCESSES_BASE_URL } from "@/lib/constants";
// ============================================================================
// Temp Layer Data API (for workflow preview)
// ============================================================================
import { GEOAPI_BASE_URL } from "@/lib/constants";
import { OutOfCreditsError } from "@/lib/utils/credits";
import type { Workflow, WorkflowCreate, WorkflowUpdate } from "@/lib/validations/workflow";
import {
  type WorkflowIssue,
  workflowCheckResponseSchema,
  workflowRefusalSchema,
} from "@/lib/validations/workflowIssues";

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

/**
 * Reads a project's workflow list again and writes it into the cache every
 * reader of the list shares, so the page that selects a workflow next (the map
 * page's `useMapUrlIntent`) finds one created since. A bare `mutate(key)` only
 * revalidates lists a mounted hook shows; there may be none on screen, and the
 * page would then read the old list from the cache. Rejects when the list cannot
 * be read.
 */
export const refreshWorkflowList = (projectId: string): Promise<Workflow[] | undefined> =>
  mutate<Workflow[]>(workflowListKey(projectId), fetcher(workflowListKey(projectId)) as Promise<Workflow[]>, {
    revalidate: false,
  });

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
 * Read one workflow as core stores it now, with its revision.
 */
export const getWorkflow = async (projectId: string, workflowId: string): Promise<Workflow> =>
  (await fetcher(workflowKey(projectId, workflowId))) as Workflow;

/**
 * Update an existing workflow. With `base_revision`, core saves only while the
 * stored workflow is still at that revision and throws a
 * `ChangedElsewhereError` otherwise. Gives up after `SAVE_TIMEOUT_MS`.
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
    signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Core refuses a damaged config (422) with the issues it found, in the
    // shape of a refused run; the editor's "Not saved" notice lists them.
    const refused =
      response.status === 422
        ? issuesRefusal(response.status, await response.text())
        : await changedElsewhere(response);
    throw refused ?? new Error("Failed to update workflow");
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
 * A run processes refused because the workflow has damaged or error issues
 * (HTTP 422). The editor shows these issues in place of its own list.
 */
export class WorkflowIssuesError extends Error {
  constructor(
    public readonly issues: WorkflowIssue[],
    message = "The workflow has issues."
  ) {
    super(message);
    this.name = "WorkflowIssuesError";
  }
}

const issuesRefusal = (status: number, body: string): WorkflowIssuesError | undefined => {
  if (status !== 422) return undefined;
  try {
    // A request validation error is a 422 too, with a list as `detail`; it does not parse here.
    const parsed = workflowRefusalSchema.safeParse(JSON.parse(body));
    if (parsed.success) return new WorkflowIssuesError(parsed.data.detail.issues, parsed.data.detail.message);
  } catch {
    // Not JSON: an error page or plain text.
  }
  return undefined;
};

export interface WorkflowCheckRequest {
  projectId: string;
  nodes: unknown[];
  edges: unknown[];
  variables: { name: string; type: string; defaultValue?: string | number }[];
  /** The UI language: processes names steps, inputs and settings in it. */
  language?: string;
}

/**
 * Check a workflow as the editor holds it, saved or not. Processes answers
 * 200 with the issues, also for a damaged workflow; the caller must be able
 * to read the project.
 */
export const checkWorkflow = async ({
  projectId,
  nodes,
  edges,
  variables,
  language,
}: WorkflowCheckRequest): Promise<WorkflowIssue[]> => {
  const response = await apiRequestAuth(`${WORKFLOWS_API_BASE_URL}/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(language ? { "Accept-Language": language } : {}),
    },
    body: JSON.stringify({ project_id: projectId, nodes, edges, variables }),
  });
  if (!response.ok) {
    throw new Error(`Failed to check workflow: ${response.status}`);
  }
  return workflowCheckResponseSchema.parse(await response.json()).issues;
};

/**
 * Execute a workflow via Windmill
 */
export const executeWorkflow = async (
  workflowId: string,
  request: WorkflowExecuteRequest,
  /** The UI language: a refusal's issues name steps and settings in it. */
  language?: string
): Promise<WorkflowExecuteResponse> => {
  const response = await apiRequestAuth(`${WORKFLOWS_API_BASE_URL}/${workflowId}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(language ? { "Accept-Language": language } : {}),
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    if (response.status === 402) throw new OutOfCreditsError();
    const error = await response.text();
    throw issuesRefusal(response.status, error) ?? new Error(`Failed to execute workflow: ${error}`);
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
