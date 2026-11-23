import type { ProjectLayer } from "@/lib/validations/project";

/**
 * The predicate `useFilteredProjectLayers` applies for every layer picker
 * (starting points, statistics field, chart/table/number widget setup):
 * drops an excluded type, an excluded dataset id (typically the system
 * layers), and — per D7 — any `locked` layer, so an editor can never pick
 * one they have no access to in the first place.
 */
export function filterSelectableProjectLayers(
  layers: ProjectLayer[] | undefined,
  excludeLayerTypes: readonly string[],
  excludeLayerIds: readonly string[]
): ProjectLayer[] {
  if (!layers) return [];
  return layers.filter(
    (layer) =>
      !excludeLayerTypes.includes(layer.type) &&
      !excludeLayerIds.includes(layer.layer_id) &&
      !layer.locked
  );
}

/**
 * Resolves a saved config's `layer_project_id` (a chart/table/number
 * widget's setup, a tool's starting-points/statistics layer, …) to its
 * project layer, refusing to hand out `layerId` — the dataset UUID every
 * caller uses to fetch feature data/fields/unique values from geoapi — when
 * that layer is `locked` (D7).
 *
 * A saved config can point at a layer that was pickable when it was
 * configured but has since become locked for the current viewer (the
 * picker itself already excludes locked layers via
 * {@link filterSelectableProjectLayers}, so this only bites an *existing*
 * config) — `isLayerLocked` lets the caller render a hint instead of
 * silently requesting nothing.
 */
export function resolveProjectLayer(
  layers: ProjectLayer[] | undefined,
  layerProjectId: number | undefined
): { layer: ProjectLayer | undefined; layerId: string | undefined; isLayerLocked: boolean } {
  const layer = layerProjectId ? layers?.find((l) => l.id === layerProjectId) : undefined;
  const isLayerLocked = !!layer?.locked;
  return { layer, layerId: isLayerLocked ? undefined : layer?.layer_id, isLayerLocked };
}

