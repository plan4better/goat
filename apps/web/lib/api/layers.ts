import { useRef } from "react";
import useSWR from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { type Job, PROCESSES_API_BASE_URL, executeProcessAsync } from "@/lib/api/processes";
import { GEOAPI_BASE_URL } from "@/lib/constants";
import type {
  ClassBreaks,
  CreatableFieldKind,
  CreateLayerFromDataset,
  CreateRasterLayer,
  DatasetCollectionItems,
  DatasetDownloadRequest,
  FieldKind,
  GetCollectionItemsQueryParams,
  GetLayerUniqueValuesQueryParams,
  Layer,
  LayerClassBreaks,
  LayerPaginated,
  LayerQueryables,
  LayerUniqueValuesPaginated,
  PostDataset,
} from "@/lib/validations/layer";

export const LAYERS_API_BASE_URL = new URL("api/v2/layer", process.env.NEXT_PUBLIC_API_URL).href;
export const COLLECTIONS_API_BASE_URL = `${GEOAPI_BASE_URL}/collections`;

export const updateBaseLayerProperties = async (
  layerId: string,
  properties: Record<string, unknown>
): Promise<void> => {
  const response = await apiRequestAuth(`${LAYERS_API_BASE_URL}/${layerId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });
  if (!response.ok) {
    throw new Error(`Failed to update layer properties for ${layerId}`);
  }
};

/**
 * Fetcher for OGC API Processes execution endpoints (POST requests)
 */
const processExecuteFetcher = async ([url, body]: [string, object]) => {
  const response = await apiRequestAuth(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail?.detail || error.detail || "Process execution failed");
  }
  return response.json();
};

export const useDataset = (datasetId: string) => {
  const { data, isLoading, error, mutate } = useSWR<Layer>(
    () => (datasetId ? [`${LAYERS_API_BASE_URL}/${datasetId}`] : null),
    fetcher
  );
  return { dataset: data, isLoading, isError: error, mutate };
};

/** Statuses meaning the user may not reach the dataset at all. With login on
 * the access check refuses a dataset they may not see before the question is
 * answered: that is a "no" as well. Not 404: the endpoint answers an unknown
 * dataset with `can_write: false`, so a 404 means a core without the route,
 * which says nothing about rights. */
const REFUSED = new Set([401, 403]);

/** The edit right from the write-access answer or its error: `undefined`
 * while loading or on an error that says nothing about rights. */
export const writeAccessFrom = (
  data: { can_write: boolean } | undefined,
  error: unknown
): boolean | undefined => {
  if (data) return data.can_write;
  const status = (error as { status?: number } | undefined)?.status;
  return status !== undefined && REFUSED.has(status) ? false : undefined;
};

/** Whether the caller may edit a dataset's rows (the rule every layer write
 * uses). `undefined` while loading or without an id. */
export const useLayerWriteAccess = (datasetId: string | undefined) => {
  const { data, error, isLoading } = useSWR<{ can_write: boolean }>(
    () => (datasetId ? [`${LAYERS_API_BASE_URL}/${datasetId}/write-access`] : null),
    fetcher,
    // A refusal is an answer here, not a hiccup to retry.
    { shouldRetryOnError: false }
  );
  return { canWrite: writeAccessFrom(data, error), isLoading };
};

export const getDataset = async (datasetId: string): Promise<Layer> => {
  // The reason why getDataset is used instead of useDataset is when you want to get the data inside a function
  const response = await apiRequestAuth(`${LAYERS_API_BASE_URL}/${datasetId}`, {
    method: "GET",
  });
  if (!response.ok) {
    throw new Error("Failed to get dataset");
  }
  return await response.json();
};

export const updateDataset = async (datasetId: string, payload: PostDataset) => {
  const response = await apiRequestAuth(`${LAYERS_API_BASE_URL}/${datasetId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error("Failed to update dataset");
  }
  return response;
};

export const updateLayerDataset = async (
  layerId: string,
  options?: { s3_key?: string; refresh_wfs?: boolean }
): Promise<Job> => {
  // Use LayerUpdate process
  // user_id is extracted from JWT token by the server
  const inputs: Record<string, unknown> = {
    layer_id: layerId,
    ...(options?.s3_key && { s3_key: options.s3_key }),
    ...(options?.refresh_wfs && { refresh_wfs: options.refresh_wfs }),
  };

  return executeProcessAsync("layer_update", inputs);
};

export const useDatasetCollectionItems = (
  datasetId: string,
  queryParams?: GetCollectionItemsQueryParams,
  options?: { keepPreviousPage?: boolean }
) => {
  const { data, isLoading, error, mutate } = useSWR<DatasetCollectionItems>(
    () => (datasetId ? [`${COLLECTIONS_API_BASE_URL}/${datasetId}/items`, queryParams] : null),
    fetcher
  );
  // With keepPreviousPage, the current page stays visible while another page or
  // sort order of the same dataset loads; a different dataset, or a request that
  // failed, never shows it.
  const previous = useRef<{ datasetId: string; data: DatasetCollectionItems } | null>(null);
  if (data) previous.current = { datasetId, data };
  const shown =
    data ??
    (options?.keepPreviousPage && !error && previous.current?.datasetId === datasetId
      ? previous.current.data
      : undefined);
  return { data: shown, isLoading, isError: error, mutate };
};

export const useLayerQueryables = (layerId: string) => {
  const { data, isLoading, error, mutate } = useSWR<LayerQueryables>(
    () => (layerId ? [`${COLLECTIONS_API_BASE_URL}/${layerId}/queryables`] : null),
    fetcher
  );
  return { queryables: data, isLoading, isError: error, mutate };
};

//TODO: remove this hook and use useLayerQueryables instead
export const useLayerKeys = (layerId: string) => {
  const { data, isLoading, error } = useSWR<LayerPaginated>(
    [`${COLLECTIONS_API_BASE_URL}/${layerId}/queryables`],
    fetcher
  );
  return { data, isLoading, error };
};

export const useLayerClassBreaks = (
  layerId: string,
  operation?: ClassBreaks,
  column?: string,
  breaks?: number
) => {
  const { data, isLoading, error } = useSWR<LayerClassBreaks>(
    () =>
      operation && column && breaks
        ? [
            `${PROCESSES_API_BASE_URL}/class-breaks/execution`,
            {
              inputs: {
                collection: layerId,
                attribute: column,
                method: operation,
                breaks: breaks,
              },
            },
          ]
        : null,
    processExecuteFetcher
  );
  return { classBreaks: data, isLoading, isError: error };
};

/** Move a dataset to the trash (30-day soft delete; restorable from the space's trash). */
export const deleteLayer = async (id: string): Promise<void> => {
  const response = await apiRequestAuth(`${LAYERS_API_BASE_URL}/${id}`, { method: "DELETE" });
  if (!response.ok) {
    let detail = "Failed to delete layer";
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // no body
    }
    throw new Error(detail);
  }
};

/**
 * Create a new layer from a dataset using OGC API Processes (LayerImport).
 * Supports both S3 file uploads and WFS imports.
 * Layer type (feature or table) is auto-detected based on geometry presence.
 * user_id is extracted from JWT token by the server.
 */
export const createLayer = async (
  payload: CreateLayerFromDataset & {
    // Optional WFS import fields
    url?: string;
    other_properties?: Record<string, unknown>;
  },
  projectId?: string
): Promise<Job> => {
  // Map to LayerImport process inputs
  // user_id is extracted from JWT token by the server. No layer id: the
  // import names the layers it creates, and processes refuses a layer id
  // the caller cannot read, which a new one never is.
  const inputs: Record<string, unknown> = {
    folder_id: payload.folder_id,
    name: payload.name,
    ...(payload.description && { description: payload.description }),
    ...(payload.tags && { tags: payload.tags }),
    ...(projectId && { project_id: projectId }),
    // S3 upload path
    ...(payload.s3_key && { s3_key: payload.s3_key }),
    // WFS import path
    ...(payload.url && { wfs_url: payload.url }),
    ...(payload.other_properties && { other_properties: payload.other_properties }),
    ...(payload.has_header !== undefined && { has_header: payload.has_header }),
    ...(payload.sheet_name && { sheet_name: payload.sheet_name }),
  };

  return executeProcessAsync("layer_import", inputs);
};

/**
 * Create a new raster/external layer (WMS, WMTS, XYZ, COG).
 * These don't upload data, just reference external URLs.
 */
export const createRasterLayer = async (payload: CreateRasterLayer, projectId?: string) => {
  const url = new URL(`${LAYERS_API_BASE_URL}/raster`);
  if (projectId) {
    url.searchParams.append("project_id", projectId);
  }
  const response = await apiRequestAuth(url.toString(), {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error("Failed to create raster layer");
  }
  return await response.json();
};

/**
 * Create a new empty layer with user-defined fields.
 * Executed as a Windmill job via the Processes API.
 */
/** Kinds a new layer can be created with — see `CreatableFieldKind`. */
export type CreateEmptyLayerPayload = {
  name: string;
  geometry_type: "point" | "line" | "polygon" | null;
  /**
   * Sent as `kind`, the same vocabulary `addColumn` uses on an existing layer, so
   * a datetime is stored as a timestamp rather than as text. Computed kinds are
   * absent by construction: they need the compute SQL that geoapi's add-column
   * path builds, which creation does not run.
   */
  fields: Array<{
    name: string;
    kind: CreatableFieldKind;
    /** The column's vocabulary, carried through to the layer's `field_config`
     * so a constraint declared at creation means what the same constraint
     * means when a column is added to a layer that already exists. */
    allowed_values?: (string | number)[];
    allow_other?: boolean;
    /** kind="serial" only: the first number the empty layer hands out. */
    start?: number;
  }>;
};

export const createEmptyLayer = async (payload: CreateEmptyLayerPayload, projectId: string): Promise<Job> => {
  const inputs: Record<string, unknown> = {
    name: payload.name,
    geometry_type: payload.geometry_type,
    fields: payload.fields,
    project_id: projectId,
  };
  return executeProcessAsync("layer_create", inputs);
};

export const getLayerClassBreaks = async (
  layerId: string,
  operation: ClassBreaks,
  column: string,
  breaks: number
): Promise<LayerClassBreaks> => {
  const response = await apiRequestAuth(`${PROCESSES_API_BASE_URL}/class-breaks/execution`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inputs: {
        collection: layerId,
        attribute: column,
        method: operation,
        breaks: breaks,
      },
    }),
  });
  if (!response.ok) {
    throw new Error("Failed to get class breaks");
  }
  return await response.json();
};

export const getLayerUniqueValues = async (
  layerId: string,
  column: string,
  size?: number
): Promise<LayerUniqueValuesPaginated> => {
  const response = await apiRequestAuth(`${PROCESSES_API_BASE_URL}/unique-values/execution`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inputs: {
        collection: layerId,
        attribute: column,
        limit: size || 100,
      },
    }),
  });
  if (!response.ok) {
    throw new Error("Failed to get unique values");
  }
  // Transform OGC Processes response to legacy paginated format
  const result = await response.json();
  return {
    items: result.values.map((v: { value: string | number; count: number }) => ({
      value: String(v.value),
      count: v.count,
    })),
    total: result.total,
    page: 1,
    size: result.values.length,
    pages: 1,
  };
};

/**
 * Transform OGC Processes unique-values response to legacy paginated format
 */
const transformUniqueValuesResponse = (result: {
  values: { value: string | number | null; count: number }[];
  total: number;
}): LayerUniqueValuesPaginated => ({
  items: result.values.map((v) => ({
    value: String(v.value ?? ""),
    count: v.count,
  })),
  total: result.total,
  page: 1,
  size: result.values.length,
  pages: 1,
});

export const useUniqueValues = (layerId: string, column: string, page?: number) => {
  const offset = page ? (page - 1) * 50 : 0;
  const { data, isLoading, error } = useSWR<LayerUniqueValuesPaginated>(
    layerId && column
      ? [
          `${PROCESSES_API_BASE_URL}/unique-values/execution`,
          {
            inputs: {
              collection: layerId,
              attribute: column,
              limit: 50,
              offset: offset,
            },
          },
        ]
      : null,
    async ([url, body]: [string, object]) => {
      const response = await apiRequestAuth(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Failed to get unique values");
      const result = await response.json();
      return transformUniqueValuesResponse(result);
    }
  );
  return { data, isLoading, error };
};

export const useLayerUniqueValues = (
  layerId: string,
  column: string,
  queryParams?: GetLayerUniqueValuesQueryParams
) => {
  const limit = queryParams?.size || 50;
  const offset = queryParams?.page ? (queryParams.page - 1) * limit : 0;
  const { data, isLoading, error, mutate, isValidating } = useSWR<LayerUniqueValuesPaginated>(
    layerId && column
      ? [
          `${PROCESSES_API_BASE_URL}/unique-values/execution`,
          {
            inputs: {
              collection: layerId,
              attribute: column,
              order: queryParams?.order || "descendent",
              limit: limit,
              offset: offset,
              ...(queryParams?.query && { filter: queryParams.query }),
            },
          },
        ]
      : null,
    async ([url, body]: [string, object]) => {
      const response = await apiRequestAuth(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Failed to get unique values");
      const result = await response.json();
      const transformed = transformUniqueValuesResponse(result);
      // Add proper pagination info
      transformed.page = queryParams?.page || 1;
      transformed.size = limit;
      transformed.pages = Math.ceil(transformed.total / limit);
      return transformed;
    }
  );
  return { data, isLoading, error, mutate, isValidating };
};

/**
 * Start a dataset export job using OGC API Processes.
 * Returns a Job that can be polled for completion.
 * When job is finished, use getExportDownloadUrl to get the download URL.
 */
export const startDatasetExport = async (
  payload: DatasetDownloadRequest & { user_id: string; layer_owner_id: string }
): Promise<Job> => {
  const inputs = {
    user_id: payload.user_id,
    layer_id: payload.id,
    layer_owner_id: payload.layer_owner_id,
    file_type: payload.file_type,
    file_name: payload.file_name,
    ...(payload.crs && { crs: payload.crs }),
    ...(payload.query && { query: payload.query }),
  };

  return executeProcessAsync("layer_export", inputs);
};

/**
 * Download a public layer directly from GeoAPI (no auth required).
 * Fetches the file as a blob and triggers a browser download.
 */
export const downloadLayerDirect = async (
  layerId: string,
  format: string,
  fileName: string,
  crs?: string
): Promise<void> => {
  const params = new URLSearchParams({ format });
  if (crs) {
    params.set("crs", crs);
  }

  const url = `${COLLECTIONS_API_BASE_URL}/${layerId}/download?${params.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Download failed" }));
    throw new Error(error.detail || `Download failed: ${response.status}`);
  }

  const blob = await response.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `${fileName}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(downloadUrl);
};

export const useClassBreak = (layerId: string, operation: string, column: string, breaks: number) => {
  const { data, isLoading, error } = useSWR<LayerClassBreaks>(
    layerId && operation && column && breaks
      ? [
          `${PROCESSES_API_BASE_URL}/class-breaks/execution`,
          {
            inputs: {
              collection: layerId,
              attribute: column,
              method: operation,
              breaks: breaks,
            },
          },
        ]
      : null,
    processExecuteFetcher
  );
  return { data, isLoading, error };
};

// --- Feature Write API Functions ---

export const getFeature = async (layerId: string, featureId: string) => {
  const response = await apiRequestAuth(`${COLLECTIONS_API_BASE_URL}/${layerId}/items/${featureId}`, {
    method: "GET",
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to get feature");
  }
  return response.json() as Promise<GeoJSON.Feature>;
};

/**
 * Fetch features from a collection with optional query parameters.
 */
export const getFeatures = async (
  layerId: string,
  params?: {
    filter?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    properties?: string[];
  }
): Promise<GeoJSON.FeatureCollection> => {
  const parts: string[] = [];
  if (params?.filter) {
    parts.push(`filter=${encodeURIComponent(JSON.stringify(params.filter))}`);
    parts.push("filter-lang=cql2-json");
  }
  if (params?.limit) parts.push(`limit=${params.limit}`);
  if (params?.offset) parts.push(`offset=${params.offset}`);
  if (params?.properties) parts.push(`properties=${params.properties.join(",")}`);
  const query = parts.length > 0 ? `?${parts.join("&")}` : "";
  const response = await apiRequestAuth(`${COLLECTIONS_API_BASE_URL}/${layerId}/items${query}`, {
    method: "GET",
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to get features");
  }
  return response.json() as Promise<GeoJSON.FeatureCollection>;
};

export const createFeature = async (
  layerId: string,
  feature: { geometry?: Record<string, unknown> | null; properties: Record<string, unknown> }
) => {
  const response = await apiRequestAuth(`${COLLECTIONS_API_BASE_URL}/${layerId}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "Feature",
      geometry: feature.geometry || null,
      properties: feature.properties,
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to create feature");
  }
  return response.json();
};

export const createFeaturesBulk = async (
  layerId: string,
  features: Array<{ geometry?: Record<string, unknown> | null; properties: Record<string, unknown> }>
) => {
  const response = await apiRequestAuth(`${COLLECTIONS_API_BASE_URL}/${layerId}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "FeatureCollection",
      features: features.map((f) => ({
        type: "Feature",
        geometry: f.geometry || null,
        properties: f.properties,
      })),
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to create features");
  }
  return response.json();
};

export const updateFeatureProperties = async (
  layerId: string,
  featureId: string,
  properties: Record<string, unknown>
) => {
  const response = await apiRequestAuth(`${COLLECTIONS_API_BASE_URL}/${layerId}/items/${featureId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to update feature");
  }
  return response.json();
};

export const replaceFeature = async (
  layerId: string,
  featureId: string,
  feature: { geometry?: Record<string, unknown> | null; properties: Record<string, unknown> }
) => {
  const response = await apiRequestAuth(`${COLLECTIONS_API_BASE_URL}/${layerId}/items/${featureId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "Feature",
      geometry: feature.geometry || null,
      properties: feature.properties,
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to replace feature");
  }
  return response.json();
};

export const deleteFeature = async (layerId: string, featureId: string) => {
  const response = await apiRequestAuth(`${COLLECTIONS_API_BASE_URL}/${layerId}/items/${featureId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to delete feature");
  }
  return response.json();
};

export const deleteFeaturesBulk = async (layerId: string, featureIds: string[]) => {
  const response = await apiRequestAuth(`${COLLECTIONS_API_BASE_URL}/${layerId}/items/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: featureIds }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to delete features");
  }
  return response.json();
};

// --- Column Management API Functions ---
//
// These hit geoapi, which manages both the DuckLake DDL and the
// `customer.layer.field_config` JSONB metadata in one place.

export interface AddColumnPayload {
  name: string;
  kind: FieldKind;
  display_config?: Record<string, unknown>;
  default_value?: unknown;
  /** The values the column accepts; `allow_other` makes them suggestions. */
  allowed_values?: (string | number)[];
  allow_other?: boolean;
  /** SQL expression for kind="formula" (validated server-side) */
  formula?: string;
  /** kind="serial" only: existing rows are numbered from it in feature order,
   * new features continue after the highest number (default 1). */
  start?: number;
}

export const addColumn = async (layerId: string, payload: AddColumnPayload) => {
  const response = await apiRequestAuth(`${COLLECTIONS_API_BASE_URL}/${layerId}/columns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to add column");
  }
  return response.json();
};

/** What a PATCH may change about a column; the endpoint takes any subset. */
export interface ColumnPatch {
  new_name?: string;
  /** SQL expression for a formula column; revalidated and recomputed. */
  formula?: string;
  /** An empty list removes the vocabulary, leaving the column free text. */
  allowed_values?: (string | number)[];
  allow_other?: boolean;
  display_config?: Record<string, unknown>;
  default_value?: unknown;
  /** Change what the column is — number to "serial" or back — on its own. */
  kind?: FieldKind;
  /** With kind="serial": where blank rows start being numbered. */
  start?: number;
}

/**
 * Change a column. Every field of `ColumnUpdate` travels in one request, so
 * two edits to the same column are one round trip and one revision.
 */
export const patchColumn = async (
  layerId: string,
  columnName: string,
  body: ColumnPatch,
  failureMessage = "Failed to update column"
) => {
  const response = await apiRequestAuth(`${COLLECTIONS_API_BASE_URL}/${layerId}/columns/${columnName}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || failureMessage);
  }
  return response.json();
};

export const updateColumnFormula = (layerId: string, columnName: string, formula: string) =>
  patchColumn(layerId, columnName, { formula }, "Failed to update formula");

export const renameColumn = (layerId: string, columnName: string, newName: string) =>
  patchColumn(layerId, columnName, { new_name: newName }, "Failed to rename column");

export const deleteColumn = async (layerId: string, columnName: string) => {
  const response = await apiRequestAuth(`${COLLECTIONS_API_BASE_URL}/${layerId}/columns/${columnName}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to delete column");
  }
  return null; // 204 No Content
};
