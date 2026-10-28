// The map request (GOAT Style spec 10, 13.2) and the writes around it: map state, named styles, dataset defaults.
// `GET /project/{id}/map` answers the map document, every layer's active style and the names of the others, with an
// ETag; map state is written by small PATCHes, shown at once and taken back when the write fails.
import { useCallback } from "react";
import useSWR from "swr";

import { apiRequestAuth } from "@/lib/api/fetcher";
import { LAYERS_API_BASE_URL } from "@/lib/api/layers";
import { PROJECTS_API_BASE_URL } from "@/lib/api/projects";
import { useAuthedSWR } from "@/lib/api/useAuthedSWR";
import type {
  LayerStyle,
  MapDocument,
  MapGroup,
  MapLayer as MapLayerEntry,
} from "@/lib/style/generated/types";
import type { StyleIssue } from "@/lib/style/save";

export type { MapDocument, MapGroup, MapLayerEntry };

/** A named style or a dataset default as core answers it. */
export interface StyleRead {
  id: string;
  name: string;
  position: number;
  revision: number;
  document: LayerStyle;
  issues: StyleIssue[];
  /** Its computed values belong to other data than the layer's now (spec 12). */
  stale: boolean;
}

export interface StyleName {
  id: string;
  name: string;
}

export interface LayerStyles {
  active: StyleRead;
  others: StyleName[];
}

export interface UnpublishedChange {
  layer_project_id: number;
  reason: "recomputed" | "edited";
}

export interface MapResponse {
  map: MapDocument;
  /** By project layer id. A layer without an entry (locked for this user) draws nothing. */
  styles: Record<string, LayerStyles>;
  unpublished: UnpublishedChange[];
}

/** A project layer's map state; only the fields sent are written. */
export interface LayerMapState {
  visible?: boolean;
  active_style_id?: string;
  position?: "top" | "below_labels" | "below_roads";
  time_value?: unknown;
  legend_expanded?: boolean;
}

export const projectMapUrl = (projectId: string) => `${PROJECTS_API_BASE_URL}/${projectId}/map`;

/** A fetcher that asks with the last ETag and keeps the last body on `304`. */
export function createMapFetcher() {
  const last = new Map<string, { etag: string; body: MapResponse }>();
  return async (url: string): Promise<MapResponse> => {
    const known = last.get(url);
    const response = await apiRequestAuth(url, {
      headers: known ? { "If-None-Match": known.etag } : {},
    });
    if (response.status === 304 && known) return known.body;
    if (!response.ok) {
      const error = new Error(`Loading the map failed (${response.status})`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const body = (await response.json()) as MapResponse;
    const etag = response.headers.get("ETag");
    if (etag) last.set(url, { etag, body });
    return body;
  };
}

const fetchMap = createMapFetcher();

/** A copy of the document with `update` applied to the entry `id` of `type`. */
function withEntry<T extends MapLayerEntry | MapGroup>(
  doc: MapDocument,
  type: T["type"],
  id: number,
  update: (entry: T) => T
): MapDocument {
  const walk = (items: (MapLayerEntry | MapGroup)[]): (MapLayerEntry | MapGroup)[] =>
    items.map((item) => {
      const changed = item.type === type && item.id === id ? update(item as T) : item;
      return changed.type === "group" && changed.children
        ? { ...changed, children: walk(changed.children) }
        : changed;
    });
  return { ...doc, layers: walk(doc.layers ?? []) };
}

/** A layer's entry with map state written into it, as the map request answers it. */
export function entryWithState(entry: MapLayerEntry, state: LayerMapState): MapLayerEntry {
  const next: MapLayerEntry = { ...entry };
  if (state.visible !== undefined) next.visible = state.visible;
  if (state.active_style_id !== undefined) next.style = state.active_style_id;
  if (state.position !== undefined) next.position = state.position === "top" ? undefined : state.position;
  if (state.time_value !== undefined) next.time = { value: state.time_value as never };
  if (state.legend_expanded !== undefined)
    next.legend = state.legend_expanded ? undefined : { expanded: false };
  return next;
}

/** The map with a layer's map state written into its entry, as the next map request would answer it. */
export function withLayerState(map: MapResponse, layerProjectId: number, state: LayerMapState): MapResponse {
  const document = withEntry<MapLayerEntry>(map.map, "layer", layerProjectId, (entry) =>
    entryWithState(entry, state)
  );
  return { ...map, map: document };
}

export function withGroupState(map: MapResponse, groupId: number, state: { visible: boolean }): MapResponse {
  return {
    ...map,
    map: withEntry<MapGroup>(map.map, "group", groupId, (g) => ({ ...g, visible: state.visible })),
  };
}

/** The map with `style` as the layer's active style; the others are the rest of its styles in their order (a style
 * new to the list joins it). */
export function withActiveStyle(map: MapResponse, layerProjectId: number, style: StyleRead): MapResponse {
  const styles = map.styles[String(layerProjectId)];
  if (!styles) return map;
  const all: StyleName[] = [...styles.others];
  all.splice(Math.min(styles.active.position, all.length), 0, {
    id: styles.active.id,
    name: styles.active.name,
  });
  const others = all.filter((other) => other.id !== style.id);
  return { ...map, styles: { ...map.styles, [String(layerProjectId)]: { active: style, others } } };
}

/** The map with a stored style reply in place of the layer's active style, when that is the style saved. */
export function withStyleReply(
  map: MapResponse,
  layerProjectId: number,
  styleId: string,
  reply: { document: LayerStyle; revision: number; issues: StyleIssue[] }
): MapResponse {
  const styles = map.styles[String(layerProjectId)];
  if (!styles || styles.active.id !== styleId) return map;
  const active: StyleRead = { ...styles.active, ...reply, stale: false };
  return { ...map, styles: { ...map.styles, [String(layerProjectId)]: { ...styles, active } } };
}

async function send(url: string, method: string, body?: unknown): Promise<Response> {
  const response = await apiRequestAuth(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error(`${method} ${url} failed (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response;
}

const layerUrl = (projectId: string, layerProjectId: number) =>
  `${PROJECTS_API_BASE_URL}/${projectId}/layer/${layerProjectId}`;

/** The map request of a project, and its map state writes (shown at once, taken back when they fail). */
export function useProjectMap(projectId?: string, opts: { revalidateOnMount?: boolean } = {}) {
  const key = projectId ? projectMapUrl(projectId) : null;
  // Only asked again when something changed it (a write, a job, a link the document lacks): a viewer's view state
  // lives in this cache, and a component mounting later or a reconnect must not replace it with the stored map.
  const { data, error, isLoading, mutate } = useAuthedSWR<MapResponse>(key, fetchMap, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    revalidateOnReconnect: false,
    // The page that shows the map asks once when it opens (a 304 when nothing changed).
    ...(opts.revalidateOnMount ? { revalidateOnMount: true } : {}),
  });

  const write = useCallback(
    async (url: string, body: unknown, optimistic: (map: MapResponse) => MapResponse) => {
      await mutate(
        async () => {
          await send(url, "PATCH", body);
          return undefined;
        },
        {
          optimisticData: (current) => (current ? optimistic(current) : (current as unknown as MapResponse)),
          rollbackOnError: true,
          populateCache: false,
          revalidate: false,
        }
      );
    },
    [mutate]
  );

  const setLayerState = useCallback(
    async (layerProjectId: number, state: LayerMapState) => {
      if (!projectId) return;
      const written = write(`${layerUrl(projectId, layerProjectId)}/map-state`, state, (map) =>
        withLayerState(map, layerProjectId, state)
      );
      const styleId = state.active_style_id;
      if (!styleId) return written;
      // A switch draws as soon as the chosen style arrives, fetched beside the write; the map request follows in
      // the background for the rest it answers (what is unpublished).
      const [style] = await Promise.all([
        fetchProjectStyle(projectId, layerProjectId, styleId).catch(() => null),
        written,
      ]);
      if (!style) return void (await mutate());
      await mutate((current) => (current ? withActiveStyle(current, layerProjectId, style) : current), {
        revalidate: false,
      });
      void mutate();
    },
    [projectId, write, mutate]
  );

  const setGroupState = useCallback(
    async (groupId: number, state: { visible: boolean }) => {
      if (!projectId) return;
      await write(`${PROJECTS_API_BASE_URL}/${projectId}/group/${groupId}/map-state`, state, (map) =>
        withGroupState(map, groupId, state)
      );
    },
    [projectId, write]
  );

  // A viewer's changes stay on this page: the cached map changes, nothing is written (view state).
  const viewLayerState = useCallback(
    async (layerProjectId: number, state: LayerMapState) => {
      await mutate((current) => (current ? withLayerState(current, layerProjectId, state) : current), {
        revalidate: false,
      });
    },
    [mutate]
  );
  const viewGroupState = useCallback(
    async (groupId: number, state: { visible: boolean }) => {
      await mutate((current) => (current ? withGroupState(current, groupId, state) : current), {
        revalidate: false,
      });
    },
    [mutate]
  );

  return {
    map: data,
    error,
    isLoading,
    mutate,
    setLayerState,
    setGroupState,
    viewLayerState,
    viewGroupState,
  };
}

/** One style of a project layer; core recomputes it first when its data changed (spec 12). */
export const fetchProjectStyle = (
  projectId: string,
  layerProjectId: number,
  styleId: string
): Promise<StyleRead> => fetchStyle(`${layerUrl(projectId, layerProjectId)}/style/${styleId}`);

/** Named styles of a project layer (spec 10: at most ten, one active). */
export async function createNamedStyle(
  projectId: string,
  layerProjectId: number,
  body: { name: string; copy_from?: string }
): Promise<StyleRead> {
  const response = await send(`${layerUrl(projectId, layerProjectId)}/style`, "POST", body);
  return (await response.json()) as StyleRead;
}

export async function updateNamedStyle(
  projectId: string,
  layerProjectId: number,
  styleId: string,
  body: { name?: string; position?: number }
): Promise<StyleRead> {
  const response = await send(`${layerUrl(projectId, layerProjectId)}/style/${styleId}`, "PATCH", body);
  return (await response.json()) as StyleRead;
}

export async function deleteNamedStyle(
  projectId: string,
  layerProjectId: number,
  styleId: string
): Promise<void> {
  await send(`${layerUrl(projectId, layerProjectId)}/style/${styleId}`, "DELETE");
}

/** Makes a named style the dataset's default style (for the dataset's editors). */
export async function setStyleAsDefault(
  projectId: string,
  layerProjectId: number,
  styleId: string
): Promise<StyleRead> {
  const response = await send(
    `${layerUrl(projectId, layerProjectId)}/style/${styleId}/set-as-default`,
    "POST"
  );
  return (await response.json()) as StyleRead;
}

export const datasetStyleUrl = (layerId: string) => `${LAYERS_API_BASE_URL}/${layerId}/style`;

async function fetchStyle(url: string): Promise<StyleRead> {
  const response = await send(url, "GET");
  return (await response.json()) as StyleRead;
}

/** A dataset's default style (`GET /layer/{id}/style`): previews of datasets and bundle members. */
export function useDatasetStyle(layerId?: string | null) {
  const { data, error, isLoading } = useSWR<StyleRead>(
    layerId ? datasetStyleUrl(layerId) : null,
    fetchStyle,
    {
      revalidateOnFocus: false,
    }
  );
  return { style: data, error, isLoading };
}

/** The default styles of several datasets (a bundle's members), by dataset id, loaded together. */
export function useDatasetStyles(layerIds: string[]) {
  const { data, error, isLoading } = useSWR<Record<string, StyleRead>>(
    layerIds.length ? ["dataset-styles", ...layerIds] : null,
    async () => {
      const styles = await Promise.all(layerIds.map((id) => fetchStyle(datasetStyleUrl(id))));
      return Object.fromEntries(layerIds.map((id, i) => [id, styles[i]]));
    },
    { revalidateOnFocus: false }
  );
  return { styles: data, error, isLoading };
}
