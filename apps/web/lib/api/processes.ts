/**
 * OGC API Processes client
 *
 * This module provides functions to interact with the OGC API Processes
 * service for:
 * - Process execution (analytics tools, layer operations)
 * - Job status tracking and management
 * - Analytics operations (feature-count, class-breaks, etc.)
 */
import useSWR from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { PROCESSES_BASE_URL } from "@/lib/constants";

// OGC API Processes base URLs
export const PROCESSES_API_BASE_URL = `${PROCESSES_BASE_URL}/processes`;
export const JOBS_API_BASE_URL = `${PROCESSES_BASE_URL}/jobs`;

// ============================================================================
// Types for OGC API Processes
// ============================================================================

export interface ProcessSummary {
  id: string;
  title: string;
  description: string;
  version: string;
  jobControlOptions: string[];
  outputTransmission: string[];
  links: ProcessLink[];
}

export interface ProcessLink {
  href: string;
  rel: string;
  type: string;
  title?: string;
}

export interface ProcessList {
  processes: ProcessSummary[];
  links: ProcessLink[];
}

// ============================================================================
// OGC Job Types
// ============================================================================

/**
 * OGC API Processes job status types
 * See: https://docs.ogc.org/is/18-062r2/18-062r2.html#sc_job_status
 */
export type JobStatusType = "accepted" | "running" | "successful" | "failed" | "dismissed";

/**
 * Process/Job types (process IDs)
 * These match the Windmill script names (snake_case)
 */
export type JobType =
  | "layer_import"
  | "layer_export"
  | "layer_update"
  | "layer_delete"
  | "print_report"
  | "workflow_runner"
  | "buffer"
  | "join"
  | "catchment_area_active_mobility"
  | "catchment_area_pt"
  | "catchment_area_car"
  | "oev_gueteklasse"
  | "heatmap_connectivity_active_mobility"
  | "heatmap_connectivity_car"
  | "heatmap_closest_average_active_mobility"
  | "heatmap_closest_average_car"
  | "heatmap_gravity_active_mobility"
  | "heatmap_gravity_car"
  | "heatmap_2sfca"
  | "huff_model"
  | "aggregate_point"
  | "aggregate_polygon"
  | "trip_count_station"
  | "origin_destination"
  | "nearby_station_access"
  | "finalize_layer"
  | "project_export"
  | "project_import"
  | "layer_create"
  | "bundle_import"
  | "bundle_artifact_rebuild"
  | "bundle_artifact_delete"
  | "layer_create_filtered"
  | "layer_copy";

/**
 * OGC Job status response
 */
export interface Job {
  jobID: string;
  processID: JobType;
  status: JobStatusType;
  message?: string;
  created?: string;
  started?: string;
  finished?: string;
  updated?: string;
  progress?: number;
  links?: ProcessLink[];
  // Extended fields from our implementation
  user_id?: string;
  read?: boolean;
  project_id?: string;
  /** A job the user did not start — a side effect of another action, which
   * the job tray leaves out. Set by the processes service from the tool
   * registry, so the list of them is not kept here. */
  hidden?: boolean;
  inputs?: Record<string, unknown>; // Job inputs (e.g., layout_id for PrintReport)
  result?: Record<string, unknown>; // Job result/output
  // Workflow execution status
  workflow_as_code_status?: {
    running?: string[];
    completed?: string[];
    failed?: string[];
  };
  // Node status for workflow jobs (from flow_user_state)
  node_status?: Record<
    string,
    | string // Legacy: just status string
    | {
        status: "pending" | "running" | "completed" | "failed";
        started_at?: number; // Unix timestamp in seconds
        duration_ms?: number; // Duration in milliseconds
        temp_layer_id?: string; // Temp layer ID for completed nodes
      }
  >;
}

/**
 * Paginated jobs response
 */
export interface JobsResponse {
  jobs: Job[];
  links?: ProcessLink[];
  numberMatched?: number;
  numberReturned?: number;
}

/**
 * Query parameters for listing jobs
 */
export interface GetJobsQueryParams {
  status?: JobStatusType;
  processID?: JobType;
  limit?: number;
  offset?: number;
  read?: boolean; // Filter by read status
}

// Feature Count types
export interface FeatureCountInput {
  collection: string;
  filter?: string;
}

export interface FeatureCountOutput {
  count: number;
}

// Extent types
export interface ExtentInput {
  collection: string;
  filter?: string;
}

export interface ExtentOutput {
  bbox: [number, number, number, number] | null;
  feature_count: number;
}

// Area Statistics types
export type AreaStatisticsOperation = "sum" | "mean" | "min" | "max";

export interface AreaStatisticsInput {
  collection: string;
  operation: AreaStatisticsOperation;
  filter?: string;
}

export interface AreaStatisticsOutput {
  total_area: number;
  feature_count: number;
  result: number;
  unit: string;
}

// Unique Values types
export type UniqueValuesOrder = "ascendent" | "descendent";

export interface UniqueValuesInput {
  collection: string;
  attribute: string;
  order?: UniqueValuesOrder;
  filter?: string;
  limit?: number;
  offset?: number;
}

export interface UniqueValue {
  value: string | number | null;
  count: number;
}

export interface UniqueValuesOutput {
  attribute: string;
  total: number;
  values: UniqueValue[];
}

// Class Breaks types
export type ClassBreaksMethod = "quantile" | "equal_interval" | "standard_deviation" | "heads_and_tails";

export interface ClassBreaksInput {
  collection: string;
  attribute: string;
  method: ClassBreaksMethod;
  breaks: number;
  filter?: string;
  strip_zeros?: boolean;
}

export interface ClassBreaksOutput {
  attribute: string;
  method: string;
  breaks: number[];
  min: number | null;
  max: number | null;
  mean: number | null;
  std_dev: number | null;
}

// Generic process execution request/response
export interface ProcessExecuteRequest<T> {
  inputs: T;
}

// Layer Search types
export interface LayerSearchLayerInput {
  layer_id: string;
  columns: string[];
  label_column?: string;
  limit?: number;
}

export interface LayerSearchInputs {
  query: string;
  map_center?: [number, number];
  project_id?: string;
  layers?: LayerSearchLayerInput[];
}

export interface LayerSearchResultItem {
  id: number;
  label: string | null;
  matched_column: string;
  matched_value: string;
  values?: Record<string, string | null>;
  centroid: number[];
  bbox: number[] | null;
}

export interface LayerSearchGroup {
  layer_id: string;
  results: LayerSearchResultItem[];
  truncated: boolean;
  timed_out: boolean;
  error: string | null;
}

export interface LayerSearchOutput {
  groups: LayerSearchGroup[];
}

// ============================================================================
// Process execution functions
// ============================================================================

/**
 * Execute a process on the GeoAPI server
 */
async function executeProcess<TInput, TOutput>(processId: string, inputs: TInput): Promise<TOutput> {
  const response = await apiRequestAuth(`${PROCESSES_API_BASE_URL}/${processId}/execution`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail?.detail || error.detail || `Process execution failed: ${processId}`);
  }

  return await response.json();
}

/**
 * Execute a process and return the job status (for async processes)
 */
export async function executeProcessAsync<TInput>(processId: string, inputs: TInput): Promise<Job> {
  const response = await apiRequestAuth(`${PROCESSES_API_BASE_URL}/${processId}/execution`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail?.detail || error.detail || `Process execution failed: ${processId}`);
  }

  return await response.json();
}

/**
 * Search features across one or more layers
 */
export async function searchLayerFeatures(
  inputs: LayerSearchInputs,
  signal?: AbortSignal
): Promise<LayerSearchOutput> {
  const response = await apiRequestAuth(`${PROCESSES_API_BASE_URL}/layer-search/execution`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs }),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => undefined);
    throw new Error(error?.detail?.detail || error?.detail || "Layer search failed");
  }
  return await response.json();
}

// ============================================================================
// Job Management Functions
// ============================================================================

/**
 * Get job status by ID
 */
export async function getJob(jobId: string): Promise<Job> {
  const response = await apiRequestAuth(`${JOBS_API_BASE_URL}/${jobId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to get job: ${jobId}`);
  }

  return await response.json();
}

/**
 * A finished job's own result payload.
 *
 * The job *list* does not carry results — `GET /jobs` reports `result: null` for every
 * entry — so anything that needs what a job produced has to ask for it per job.
 */
export async function getJobResult(jobId: string): Promise<Record<string, unknown> | null> {
  const response = await apiRequestAuth(`${JOBS_API_BASE_URL}/${jobId}/results`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) return null;
  const body = (await response.json()) as { result?: Record<string, unknown> };
  return body?.result ?? null;
}

/**
 * Dismiss/cancel a job
 */
export async function dismissJob(jobId: string): Promise<void> {
  const response = await apiRequestAuth(`${JOBS_API_BASE_URL}/${jobId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Failed to dismiss job: ${jobId}`);
  }
}

/**
 * Mark jobs as read (clear from notification list)
 * For completed jobs, this dismisses them from the system
 */
export async function setJobsReadStatus(jobIds: string[]): Promise<void> {
  // Dismiss all jobs to clear them from the notification list
  // This is the OGC-standard way to remove jobs from the system
  const results = await Promise.allSettled(jobIds.map((id) => dismissJob(id)));

  // Log any failures but don't throw
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    console.warn(`Failed to dismiss ${failures.length} of ${jobIds.length} jobs`);
  }
}

// ============================================================================
// Job SWR Hooks
// ============================================================================

/**
 * Hook to fetch and poll jobs list
 * Only polls when there are running/accepted jobs
 */
export function useJobs(queryParams?: GetJobsQueryParams) {
  const { data, isLoading, error, mutate, isValidating } = useSWR<JobsResponse>(
    [`${JOBS_API_BASE_URL}`, queryParams],
    fetcher,
    {
      refreshInterval: (latestData) => {
        if (!latestData?.jobs) return 0;
        // Check if there are any running or accepted jobs
        const hasActiveJobs = latestData.jobs.some(
          (job) => job.status === "running" || job.status === "accepted"
        );
        // Poll every 2 seconds if there are active jobs, otherwise stop polling
        return hasActiveJobs ? 2000 : 0;
      },
    }
  );

  return {
    jobs: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
}

/**
 * Hook to fetch and poll a single job by ID
 */
export function useJob(jobId?: string, refreshInterval = 2000) {
  const { data, isLoading, error, mutate } = useSWR<Job>(
    jobId ? [`${JOBS_API_BASE_URL}/${jobId}`] : null,
    fetcher,
    {
      refreshInterval: (data) => {
        if (!data) return refreshInterval;
        // Stop polling when job is finished
        if (data.status === "successful" || data.status === "failed" || data.status === "dismissed") {
          return 0;
        }
        return refreshInterval;
      },
    }
  );

  return {
    job: data,
    isLoading,
    isError: error,
    mutate,
  };
}

/**
 * Get feature count for a collection
 */
export async function getFeatureCount(layerId: string, filter?: string): Promise<FeatureCountOutput> {
  const inputs: FeatureCountInput = {
    collection: layerId,
    ...(filter && { filter }),
  };
  return executeProcess<FeatureCountInput, FeatureCountOutput>("feature-count", inputs);
}

/**
 * Get extent (bounding box) for a collection
 * Supports optional CQL filter to get extent of filtered features
 */
export async function getExtent(layerId: string, filter?: string): Promise<ExtentOutput> {
  const inputs: ExtentInput = {
    collection: layerId,
    ...(filter && { filter }),
  };
  return executeProcess<ExtentInput, ExtentOutput>("extent", inputs);
}

/**
 * Get area statistics for a polygon collection
 */
export async function getAreaStatistics(
  layerId: string,
  operation: AreaStatisticsOperation,
  filter?: string
): Promise<AreaStatisticsOutput> {
  const inputs: AreaStatisticsInput = {
    collection: layerId,
    operation,
    ...(filter && { filter }),
  };
  return executeProcess<AreaStatisticsInput, AreaStatisticsOutput>("area-statistics", inputs);
}

/**
 * Get unique values for an attribute in a collection
 */
export async function getUniqueValues(
  layerId: string,
  attribute: string,
  options?: {
    order?: UniqueValuesOrder;
    filter?: string;
    limit?: number;
    offset?: number;
  }
): Promise<UniqueValuesOutput> {
  const inputs: UniqueValuesInput = {
    collection: layerId,
    attribute,
    ...options,
  };
  return executeProcess<UniqueValuesInput, UniqueValuesOutput>("unique-values", inputs);
}

export type MirrorValue = { value: string; count: number };
export type MirrorValuesOutput = {
  key: string | null;
  total: number;
  /** The area holds more than the tool reads, so the counts are of a sample, not totals. */
  sampled?: boolean;
  /** A quick read that saw the whole area, so its counts are final. */
  complete?: boolean;
  /** Features in the area, guessed from the mirror's index; with the attribute list only. */
  estimate?: number | null;
  /** More in the area than one fetch reads: a fetch would be refused. */
  too_large?: boolean;
  values: MirrorValue[];
};

/** Features in an area, estimated from the mirror's file parts, without any list. */
export async function getMirrorSize(
  area: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  featureType: string,
  source: string
): Promise<{ estimate?: number; tooLarge: boolean }> {
  const result = await executeProcess<Record<string, unknown>, MirrorValuesOutput>("mirror-values", {
    area,
    source,
    feature_type: featureType,
    size_only: true,
  });
  return { estimate: result.estimate ?? undefined, tooLarge: !!result.too_large };
}

/** Attributes, or the values of one attribute, in the mirror for an area: OSM tags or Overture columns. */
export async function getMirrorValues(
  area: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  featureType: string,
  key?: string,
  limit = 200,
  source = "osm",
  quick = false
): Promise<MirrorValuesOutput> {
  return executeProcess<Record<string, unknown>, MirrorValuesOutput>("mirror-values", {
    area,
    source,
    feature_type: featureType,
    ...(key ? { key } : {}),
    limit,
    ...(quick ? { quick } : {}),
  });
}

/**
 * Get class breaks for a numeric attribute
 */
export async function getClassBreaks(
  layerId: string,
  attribute: string,
  method: ClassBreaksMethod,
  breaks: number,
  options?: {
    filter?: string;
    strip_zeros?: boolean;
  }
): Promise<ClassBreaksOutput> {
  const inputs: ClassBreaksInput = {
    collection: layerId,
    attribute,
    method,
    breaks,
    ...options,
  };
  return executeProcess<ClassBreaksInput, ClassBreaksOutput>("class-breaks", inputs);
}

// ============================================================================
// SWR Hooks for process results
// ============================================================================

/**
 * Hook to get class breaks using SWR
 */
export function useClassBreaks(
  layerId: string | undefined,
  attribute: string | undefined,
  method: ClassBreaksMethod | undefined,
  breaks: number | undefined,
  options?: {
    filter?: string;
    strip_zeros?: boolean;
  }
) {
  const shouldFetch = layerId && attribute && method && breaks;

  const { data, isLoading, error, mutate } = useSWR<ClassBreaksOutput>(
    shouldFetch
      ? [
          `${PROCESSES_API_BASE_URL}/class-breaks/execution`,
          {
            inputs: {
              collection: layerId,
              attribute,
              method,
              breaks,
              ...options,
            },
          },
        ]
      : null,
    async ([url, body]) => {
      const response = await apiRequestAuth(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail?.detail || error.detail || "Failed to get class breaks");
      }
      return response.json();
    }
  );

  return {
    classBreaks: data,
    isLoading,
    isError: error,
    mutate,
  };
}

/**
 * Hook to get unique values using SWR
 */
export function useUniqueValues(
  layerId: string | undefined,
  attribute: string | undefined,
  options?: {
    order?: UniqueValuesOrder;
    filter?: string;
    limit?: number;
    offset?: number;
  }
) {
  const shouldFetch = layerId && attribute;

  const { data, isLoading, error, mutate, isValidating } = useSWR<UniqueValuesOutput>(
    shouldFetch
      ? [
          `${PROCESSES_API_BASE_URL}/unique-values/execution`,
          {
            inputs: {
              collection: layerId,
              attribute,
              ...options,
            },
          },
        ]
      : null,
    async ([url, body]) => {
      const response = await apiRequestAuth(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail?.detail || error.detail || "Failed to get unique values");
      }
      return response.json();
    }
  );

  return {
    data,
    isLoading,
    error,
    mutate,
    isValidating,
  };
}

/**
 * Hook to get feature count using SWR
 */
export function useFeatureCount(layerId: string | undefined, filter?: string) {
  const shouldFetch = !!layerId;

  const { data, isLoading, error, mutate } = useSWR<FeatureCountOutput>(
    shouldFetch
      ? [
          `${PROCESSES_API_BASE_URL}/feature-count/execution`,
          {
            inputs: {
              collection: layerId,
              ...(filter && { filter }),
            },
          },
        ]
      : null,
    async ([url, body]) => {
      const response = await apiRequestAuth(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail?.detail || error.detail || "Failed to get feature count");
      }
      return response.json();
    }
  );

  return {
    featureCount: data?.count,
    isLoading,
    isError: error,
    mutate,
  };
}
