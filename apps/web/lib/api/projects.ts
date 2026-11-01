import useSWR, { type SWRConfiguration } from "swr";

import { SAVE_TIMEOUT_MS, changedElsewhere } from "@/lib/api/changedElsewhere";
import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { PROCESSES_API_BASE_URL } from "@/lib/api/processes";
import { useAuthedSWR } from "@/lib/api/useAuthedSWR";
import type { GetContentQueryParams } from "@/lib/validations/common";
import type {
  AggregationStatsQueryParams,
  AggregationStatsResponse,
  HistogramStatsQueryParams,
  HistogramStatsResponse,
  PostProject,
  Project,
  ProjectLayer,
  ProjectLayerGroup,
  ProjectLayerTreeUpdate,
  ProjectPaginated,
  ProjectPublic,
  ProjectViewState,
} from "@/lib/validations/project";

export const PROJECTS_API_BASE_URL = new URL("api/v2/project", process.env.NEXT_PUBLIC_API_URL).href;

export const useProjects = (queryParams?: GetContentQueryParams) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<ProjectPaginated>(
    [`${PROJECTS_API_BASE_URL}`, queryParams],
    fetcher
  );
  return {
    projects: data,
    isLoading: isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

export const useProject = (projectId?: string) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<Project>(
    () => (projectId ? [`${PROJECTS_API_BASE_URL}/${projectId}`] : null),
    fetcher
  );

  return {
    project: data,
    isLoading: isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

/** Read one project as core stores it now, with its dashboard's revision. */
export const getProject = async (projectId: string): Promise<Project> =>
  (await fetcher([`${PROJECTS_API_BASE_URL}/${projectId}`])) as Project;

export const useProjectLayers = (projectId?: string, config?: SWRConfiguration<ProjectLayer[]>) => {
  const { data, isLoading, error, mutate, isValidating } = useAuthedSWR<ProjectLayer[]>(
    () => (projectId ? [`${PROJECTS_API_BASE_URL}/${projectId}/layer`] : null),
    fetcher,
    config
  );

  return {
    layers: data,
    isLoading: isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

export const useProjectLayerGroups = (projectId?: string) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<ProjectLayerGroup[]>(
    () => (projectId ? projectLayerGroupsKey(projectId) : null),
    fetcher
  );

  return {
    layerGroups: data,
    isLoading: isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

export const useProjectInitialViewState = (projectId: string) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<ProjectViewState>(
    [`${PROJECTS_API_BASE_URL}/${projectId}/initial-view-state`],
    fetcher
  );
  return {
    initialView: data,
    isLoading: isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

export const useProjectLayerChartData = (projectId: string, layerId: number, cumSum: boolean = false) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR(
    [`${PROJECTS_API_BASE_URL}/${projectId}/layer/${layerId}/chart-data?cumsum=${cumSum}`],
    fetcher
  );
  return {
    chartData: data,
    isLoading: isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

/**
 * Hook to get aggregation statistics for a layer using GeoAPI OGC Processes
 * @param layerId - The layer UUID (not layer_project_id)
 * @param queryParams - Query parameters including operation_type, group_by_column_name, etc.
 */
export const useProjectLayerAggregationStats = (
  layerId?: string,
  queryParams?: AggregationStatsQueryParams
) => {
  // Only require layerId and operation_type - group_by_column is optional (for Numbers widget)
  const shouldFetch = layerId && queryParams?.operation_type;

  const { data, isLoading, error, mutate, isValidating } = useSWR<AggregationStatsResponse>(
    shouldFetch
      ? [
          `${PROCESSES_API_BASE_URL}/aggregation-stats/execution`,
          {
            inputs: {
              collection: layerId,
              group_by_column: queryParams.group_by_column_name || undefined,
              operation: queryParams.operation_type,
              operation_column: queryParams.operation_value,
              limit: queryParams.size || 10,
              order: queryParams.order,
              filter: queryParams.query,
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
        throw new Error(error.detail?.detail || error.detail || "Failed to get aggregation stats");
      }
      const result = await response.json();
      // Transform response to match expected format
      return {
        items:
          result.items?.map((item: { grouped_value: string; operation_value: number }) => ({
            grouped_value: item.grouped_value,
            operation_value: item.operation_value,
          })) || [],
        total_items: result.total_items || 0,
        total_count: result.total_count || 0,
      };
    },
    {
      keepPreviousData: true,
    }
  );
  return {
    aggregationStats: data,
    isLoading: isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

/**
 * Hook to get histogram statistics for a layer using GeoAPI OGC Processes
 * @param layerId - The layer UUID (not layer_project_id)
 * @param queryParams - Query parameters including column_name, num_bins, etc.
 */
export const useProjectLayerHistogramStats = (layerId?: string, queryParams?: HistogramStatsQueryParams) => {
  const shouldFetch = layerId && queryParams?.column_name;

  const { data, isLoading, error, mutate, isValidating } = useSWR<HistogramStatsResponse>(
    shouldFetch
      ? [
          `${PROCESSES_API_BASE_URL}/histogram/execution`,
          {
            inputs: {
              collection: layerId,
              column: queryParams.column_name,
              num_bins: queryParams.num_bins || 10,
              method: queryParams.method || "equal_interval",
              custom_breaks: queryParams.custom_breaks,
              filter: queryParams.query,
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
        throw new Error(error.detail?.detail || error.detail || "Failed to get histogram stats");
      }
      const result = await response.json();
      // Response already matches expected format (bins with range and count)
      return {
        bins:
          result.bins?.map((bin: { range: [number, number]; count: number }) => ({
            range: bin.range,
            count: bin.count,
          })) || [],
        missing_count: result.missing_count || 0,
        total_rows: result.total_rows || 0,
      };
    },
    {
      keepPreviousData: true,
    }
  );
  return {
    histogramStats: data,
    isLoading: isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

export const updateProjectInitialViewState = async (projectId: string, payload: ProjectViewState) => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/initial-view-state`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Failed to update project initial view state");
  }
  return await response.json();
};

export const updateProjectLayer = async (projectId: string, layerId: number, payload: ProjectLayer) => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/layer/${layerId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw Error(`Failed to update project layer ${layerId}`);
  }
  return await response.json();
};

export const deleteProjectLayer = async (projectId: string, layerId: number) => {
  const response = await apiRequestAuth(
    `${PROJECTS_API_BASE_URL}/${projectId}/layer?layer_project_id=${layerId}`,
    {
      method: "DELETE",
    }
  );
  if (!response.ok) {
    throw Error(`deleteProjectLayer: unable to delete layer with id ${layerId}`);
  }
  return response;
};

/** SWR key of a project's layer list — for targeted revalidation. */
export const projectLayersKey = (projectId: string) => [`${PROJECTS_API_BASE_URL}/${projectId}/layer`];

/** SWR key of a project's layer groups — for targeted revalidation. */
export const projectLayerGroupsKey = (projectId: string) => [`${PROJECTS_API_BASE_URL}/${projectId}/group`];

/**
 * Add catalog items to a project (promote-on-use).
 *
 * Each id is a STAC item id; core resolves it to the shared promoted layer —
 * creating it on first use, with data materialized in the background — and
 * links it to the project. Returned layers may be `pending` until the
 * materialize job finishes.
 */
export const addCatalogLayersToProject = async (projectId: string, catalogIds: string[]) => {
  const params = catalogIds.map((id) => `catalog_ids=${encodeURIComponent(id)}`).join("&");
  const response = await apiRequestAuth(
    `${PROJECTS_API_BASE_URL}/${projectId}/layer-catalog?${params}`,
    { method: "POST", headers: { "Content-Type": "application/json" } }
  );
  if (!response.ok) {
    // The server's own words when it has them: a refusal here says how many
    // layers were asked for and what the limit is, which the generic message
    // cannot. Falls back when the body is not the expected shape.
    const detail = await response
      .json()
      .then((body) => (typeof body?.detail === "string" ? body.detail : undefined))
      .catch(() => undefined);
    throw new Error(detail ?? "Failed to add catalog layers to project");
  }
  return await response.json();
};

export const addProjectLayers = async (projectId: string, layerIds: string[]) => {
  //todo: fix the api for this. This structure doesn't make sense.
  //layer_ids=1&layer_ids=2&layer_ids=3
  const layerIdsParams = layerIds.map((layerId) => {
    return `layer_ids=${layerId}`;
  });

  const response = await apiRequestAuth(
    `${PROJECTS_API_BASE_URL}/${projectId}/layer?${layerIdsParams.join("&")}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
  if (!response.ok) {
    throw new Error("Failed to add layers to project");
  }
  return await response.json();
};

export const addBundleToProject = async (projectId: string, bundleId: string) => {
  // Creates a bundle-backed layer group and places the bundle's member layers
  // into it (locked membership). Returns the created group.
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/bundle/${bundleId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error("Failed to add bundle to project");
  }
  return await response.json();
};

/** A project update. The dashboard (`builder_config`) is saved on a
 * revision of its own: with `builder_base_revision`, core saves it only while
 * the stored dashboard is still at that revision. */
export type ProjectUpdate = PostProject & {
  builder_config?: unknown;
  builder_base_revision?: number | null;
};

/**
 * Update a project. Throws a `ChangedElsewhereError` when core refuses a
 * dashboard save because the dashboard changed since `builder_base_revision`.
 * Gives up after `SAVE_TIMEOUT_MS`.
 */
export const updateProject = async (projectId: string, payload: ProjectUpdate): Promise<Project> => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw (await changedElsewhere(response)) ?? new Error("Failed to update project");
  }
  return await response.json();
};

export const updateProjectLayerTree = async (projectId: string, payload: ProjectLayerTreeUpdate) => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/layer-tree`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Failed to update project layer tree structure");
  }
  // 204 No Content usually, returns undefined or empty
  return response;
};

export const createProject = async (payload: PostProject): Promise<Project> => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Failed to create project");
  }
  return await response.json();
};

export const deleteProject = async (id: string) => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw Error(`deleteProject: unable to delete project with id ${id}`);
  }
  return response;
};

export const usePublicProject = (projectId: string) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<ProjectPublic>(
    `${PROJECTS_API_BASE_URL}/${projectId}/public`,
    fetcher
  );
  return {
    sharedProject: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

export const publishProject = async (projectId: string) => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/publish`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error("Failed to publish project");
  }
  return await response.json();
};

export const unpublishProject = async (projectId: string) => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/unpublish`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error("Failed to unpublish project");
  }
  return await response.json();
};

export const createProjectLayerGroup = async (
  projectId: string,
  payload: { name: string; parent_id?: number }
) => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/group`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Failed to create project layer group");
  }
  return await response.json();
};

export const updateProjectLayerGroup = async (
  projectId: string,
  groupId: number,
  payload: {
    name?: string;
    parent_id?: number;
    properties?: Record<string, unknown> | null;
    expanded?: boolean;
  }
) => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/group/${groupId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Failed to update project layer group");
  }
  return await response.json();
};

export const deleteProjectLayerGroup = async (projectId: string, groupId: number) => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/group/${groupId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw Error(`Failed to delete project layer group ${groupId}`);
  }
  return response;
};

export const copyProject = async (projectId: string, folderId?: string): Promise<Project> => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/copy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ folder_id: folderId ?? null }),
  });
  if (!response.ok) {
    throw new Error("Failed to copy project");
  }
  return await response.json();
};
