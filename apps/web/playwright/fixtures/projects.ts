import { type APIRequestContext, expect } from "@playwright/test";

import { API_URL } from "./users";

const INITIAL_VIEW_STATE = {
  latitude: 48.1502132,
  longitude: 11.5696284,
  zoom: 12,
  min_zoom: 0,
  max_zoom: 20,
  bearing: 0,
  pitch: 0,
};

/** Creates a project, in the caller's own home folder unless a folder is
 * given, and returns its id. */
export const createProject = async (
  api: APIRequestContext,
  name: string,
  folderId?: string
): Promise<string> => {
  let folder = folderId;
  if (!folder) {
    const folders = await api.get(`${API_URL}/api/v2/folder`);
    expect(folders.ok(), await folders.text()).toBeTruthy();
    const home = ((await folders.json()) as { id: string; name: string; is_owned: boolean }[]).find(
      (candidate) => candidate.name === "home" && candidate.is_owned
    );
    expect(home, "no owned home folder").toBeTruthy();
    folder = home!.id;
  }
  const created = await api.post(`${API_URL}/api/v2/project`, {
    data: { folder_id: folder, name, initial_view_state: INITIAL_VIEW_STATE },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  return ((await created.json()) as { id: string }).id;
};

/** Grants users a role on a project ("project-viewer" / "project-editor"). */
export const shareProjectWithUsers = async (
  api: APIRequestContext,
  projectId: string,
  users: { id: string; role: "project-viewer" | "project-editor" }[]
): Promise<void> => {
  const shared = await api.post(`${API_URL}/api/v2/share/project/${projectId}`, { data: { users } });
  expect(shared.ok(), await shared.text()).toBeTruthy();
};

export const deleteProject = async (api: APIRequestContext, projectId: string | undefined): Promise<void> => {
  if (projectId) await api.delete(`${API_URL}/api/v2/project/${projectId}`);
};

/** Adds datasets to a project, as its layers, in the order given. */
export const addDatasetsToProject = async (
  api: APIRequestContext,
  projectId: string,
  datasetIds: string[]
): Promise<void> => {
  const query = datasetIds.map((id) => `layer_ids=${id}`).join("&");
  const added = await api.post(`${API_URL}/api/v2/project/${projectId}/layer?${query}`);
  expect(added.ok(), await added.text()).toBeTruthy();
};

/** A project's layers: their names and the datasets behind them. */
export const projectLayers = async (
  api: APIRequestContext,
  projectId: string
): Promise<{ name: string; layer_id: string }[]> => {
  const layers = await api.get(`${API_URL}/api/v2/project/${projectId}/layer`);
  expect(layers.ok(), await layers.text()).toBeTruthy();
  return (await layers.json()) as { name: string; layer_id: string }[];
};

/** A saved workflow of one dataset feeding a Buffer of 100 m. `staleInput`
 * leaves a layer id in the Buffer's own config for the input the edge feeds,
 * as a workflow keeps after its dataset was replaced: the runner never reads
 * it. */
export const createBufferWorkflow = async (
  api: APIRequestContext,
  projectId: string,
  dataset: { id: string; name: string },
  options: { name: string; staleInput?: string }
): Promise<string> => {
  const config = {
    nodes: [
      {
        id: "dataset-e2e",
        type: "dataset",
        position: { x: 100, y: 150 },
        data: {
          type: "dataset",
          label: dataset.name,
          layerId: dataset.id,
          layerName: dataset.name,
          geometryType: "point",
          layerType: "feature",
        },
      },
      {
        id: "tool-e2e",
        type: "tool",
        position: { x: 450, y: 150 },
        data: {
          type: "tool",
          processId: "buffer",
          label: "Buffer",
          status: "idle",
          config: {
            distances: [100],
            units: "meters",
            ...(options.staleInput && { input_layer_id: options.staleInput }),
          },
        },
      },
    ],
    edges: [{ id: "edge-e2e", source: "dataset-e2e", target: "tool-e2e", targetHandle: "input_layer_id" }],
  };
  const created = await api.post(`${API_URL}/api/v2/project/${projectId}/workflow`, {
    data: { name: options.name, config },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  return ((await created.json()) as { id: string }).id;
};


/** Saves a workflow with this config in the project and returns its id. */
export const createWorkflowFromConfig = async (
  api: APIRequestContext,
  projectId: string,
  name: string,
  config: { nodes: unknown[]; edges: unknown[] }
): Promise<string> => {
  const created = await api.post(`${API_URL}/api/v2/project/${projectId}/workflow`, { data: { name, config } });
  expect(created.ok(), await created.text()).toBeTruthy();
  return ((await created.json()) as { id: string }).id;
};
