import { mutate } from "swr";

import {
  PROJECTS_API_BASE_URL,
  addBundleToProject,
  addCatalogLayersToProject,
  addProjectLayers,
  deleteProjectLayer,
  deleteProjectLayerGroup,
  projectLayerGroupsKey,
  projectLayersKey,
} from "@/lib/api/projects";
import type { ResultItem } from "@/lib/assistant/items";
import type { ProjectLayer } from "@/lib/validations/project";

export interface AddedToProject {
  /** The new layers in the project (layer_project ids). */
  layers: number[];
  /** Takes the addition back out of the project. */
  undo: () => Promise<void>;
}

/** The project's layer list, groups and project, as the add dialogs refresh them. */
export const refreshProjectLayers = (projectId: string) =>
  Promise.all([
    mutate(projectLayersKey(projectId)),
    mutate(projectLayerGroupsKey(projectId)),
    mutate([`${PROJECTS_API_BASE_URL}/${projectId}`]),
  ]);

const layerIds = (links: unknown): number[] =>
  (Array.isArray(links) ? links : [])
    .map((link) => (link as { id?: unknown }).id)
    .filter((id): id is number => typeof id === "number");

/**
 * Adds what a card stands for to a project through the same calls as the Add
 * Layer dialogs: a dataset or a layer's dataset is linked, a catalog record is
 * promoted into GOAT on first use and linked, a bundle comes in as one locked
 * group. Throws when the server refuses.
 */
export async function addItemToProject(projectId: string, item: ResultItem): Promise<AddedToProject> {
  if (item.kind === "bundle") {
    const group = (await addBundleToProject(projectId, item.id)) as { id?: number };
    await refreshProjectLayers(projectId);
    return {
      layers: [],
      undo: async () => {
        // A bundle's layers leave only together, with their group.
        if (typeof group.id === "number") await deleteProjectLayerGroup(projectId, group.id);
        await refreshProjectLayers(projectId);
      },
    };
  }
  // A catalog add also answers with existing links it repaired: Undo takes out
  // only the layers that were not in the project before.
  const before = new Set(
    (((await mutate(projectLayersKey(projectId))) as ProjectLayer[] | undefined) ?? []).map(
      (layer) => layer.id
    )
  );
  const links =
    item.kind === "catalog"
      ? await addCatalogLayersToProject(projectId, [item.id])
      : await addProjectLayers(projectId, [item.datasetId ?? item.id]);
  await refreshProjectLayers(projectId);
  const layers = layerIds(links).filter((layer) => !before.has(layer));
  return {
    layers,
    undo: async () => {
      await Promise.all(layers.map((layer) => deleteProjectLayer(projectId, layer)));
      await refreshProjectLayers(projectId);
    },
  };
}
