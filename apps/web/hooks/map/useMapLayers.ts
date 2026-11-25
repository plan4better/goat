// The map's layers as one view model: the project layer rows (`/layer`, everything but styles) joined with
// the map document (`/map`, styles and map state), top first in the tree's order, with group visibility folded in.
import { useEffect, useMemo, useRef } from "react";

import {
  type MapDocument,
  type MapGroup,
  type MapLayerEntry,
  type MapResponse,
  type StyleName,
  type StyleRead,
  fetchProjectStyle,
  useProjectMap,
  withStyleReply,
} from "@/lib/api/map";
import { useProjectLayers } from "@/lib/api/projects";
import { getStylesFromUrl } from "@/lib/utils/map/loc-url";
import type { ProjectLayer } from "@/lib/validations/project";

export type MapLayer = ProjectLayer & {
  /** Drawn: the layer and every group around it are visible (spec 10). */
  visible: boolean;
  /** The layer's own entry in the map document (its own `visible`, `position`, `time`, `legend`). */
  entry: MapLayerEntry;
  /** The active style; null for a layer that draws nothing (locked for this user, a snapshot without styles). */
  style: StyleRead | null;
  otherStyles: StyleName[];
  /** A published map's every named style, whole: a viewer may switch between them (view state). */
  publishedStyles?: StyleRead[];
  /** A viewer's opacity over the style's (view state on a published map). */
  opacity?: number;
};

type Entry = MapLayerEntry | MapGroup;

/** The layer entries in tree order (top first) with their effective visibility. */
function flatten(items: Entry[], parentVisible = true, out: Array<[MapLayerEntry, boolean]> = []) {
  for (const item of items) {
    const visible = parentVisible && item.visible !== false;
    if (item.type === "group") flatten(item.children ?? [], visible, out);
    else out.push([item, visible]);
  }
  return out;
}

function join(
  layers: ProjectLayer[],
  doc: MapDocument | undefined,
  styleOf: (
    layer: ProjectLayer,
    entry: MapLayerEntry
  ) => Pick<MapLayer, "style" | "otherStyles" | "publishedStyles">
): MapLayer[] {
  const rows = new Map(layers.map((layer) => [layer.id, layer]));
  const entries: Array<[MapLayerEntry, boolean]> = doc
    ? flatten(doc.layers ?? [])
    : // A snapshot published before the map document existed: the layers in their order, all shown.
      [...layers]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((layer) => [{ type: "layer", id: layer.id, visible: true }, true]);
  return entries.flatMap(([entry, visible]) => {
    const row = rows.get(entry.id);
    if (!row) return [];
    return [{ ...row, visible, entry, ...styleOf(row, entry) }];
  });
}

/** The project's layers from its layer rows and its map request. */
export function joinMapLayers(layers: ProjectLayer[] | undefined, map: MapResponse | undefined): MapLayer[] {
  if (!layers || !map) return [];
  return join(layers, map.map, (row) => {
    const styles = map.styles[String(row.id)];
    return { style: styles?.active ?? null, otherStyles: styles?.others ?? [] };
  });
}

/** A published map's layers from its snapshot: every named style is stored whole, the entry names the active one,
 * unless the viewer chose another (`chosen`, by project layer id: the `styles` URL parameter). */
export function publicMapLayers(
  config: {
    layers: ProjectLayer[];
    map?: MapDocument | null;
    styles?: Record<string, StyleRead[]> | null;
  },
  chosen: Record<string, string> = {}
): MapLayer[] {
  return join(config.layers, config.map ?? undefined, (row, entry) => {
    const list = config.styles?.[String(row.id)] ?? [];
    const pick = (id: unknown) => list.find((s) => s.id === id);
    const style = pick(chosen[String(row.id)]) ?? pick(entry.style) ?? list[0] ?? null;
    return {
      style,
      otherStyles: list.filter((s) => s !== style).map((s) => ({ id: s.id, name: s.name })),
      publishedStyles: list,
    };
  });
}

/** The group rows with their visibility from the map document, which carries the optimistic map state. */
export function withMapGroups<T extends { id: number; visible?: boolean }>(
  groups: T[],
  doc: MapDocument | undefined
): T[] {
  if (!doc) return groups;
  const visible = new Map<number, boolean>();
  const walk = (items: Entry[]) => {
    for (const item of items) {
      if (item.type !== "group") continue;
      if (typeof item.id === "number") visible.set(item.id, item.visible !== false);
      walk(item.children ?? []);
    }
  };
  walk(doc.layers ?? []);
  return groups.map((g) => (visible.has(g.id) ? { ...g, visible: visible.get(g.id) } : g));
}

/** A published map's group rows with their visibility from its map document; snapshots converted from the old format
 * keep visibility and the open state in each group's `properties`. */
export function publishedGroups<
  T extends { id: number; visible?: boolean; expanded?: boolean; properties?: unknown },
>(config: { layer_groups?: T[] | null; map?: MapDocument | null }): T[] {
  const groups = (config.layer_groups ?? []).map((g) => {
    const expanded = g.expanded ?? (g.properties as { expanded?: boolean } | null | undefined)?.expanded;
    return expanded === undefined ? g : { ...g, expanded };
  });
  return withMapGroups(groups, config.map ?? undefined);
}

/** A group as far as drawing is concerned: shown unless it or a group around it is hidden. */
export interface GroupVisibility {
  id: number;
  parent_id?: number | null;
  visible?: boolean | null;
}

/** The layers with what is drawn folded again from their own entry and every group around them: a viewer's changes
 * to a published map are view state, kept on these rows. */
export function foldVisibility<T extends MapLayer>(layers: T[], groups: GroupVisibility[]): T[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const groupShown = (groupId: number | null | undefined) => {
    const seen = new Set<number>();
    for (let id = groupId; id !== null && id !== undefined && !seen.has(id); ) {
      seen.add(id);
      const group = byId.get(id);
      if (!group) break;
      if (group.visible === false) return false;
      id = group.parent_id;
    }
    return true;
  };
  return layers.map((layer) => {
    const visible = layer.entry.visible !== false && groupShown(layer.layer_project_group_id);
    return visible === layer.visible ? layer : { ...layer, visible };
  });
}

/** Stale styles already asked for (project, layer, style and revision), across every user of the map. */
const staleAsked = new Set<string>();

/** The project page's map layers, and the map state writes. */
export function useMapLayers(projectId?: string, opts: { revalidateOnMount?: boolean } = {}) {
  const { layers: rows, isLoading: rowsLoading, mutate: mutateRows } = useProjectLayers(projectId);
  const projectMap = useProjectMap(projectId, opts);
  const layers = useMemo(() => joinMapLayers(rows, projectMap.map), [rows, projectMap.map]);

  // Links the map document does not know yet (just added by a picker, an upload or a tool job): the map request is
  // asked again, once for each such set, since only it answers their entries and styles.
  const unknown = useMemo(() => {
    if (!rows || !projectMap.map) return "";
    const known = new Set(flatten(projectMap.map.map.layers ?? []).map(([entry]) => entry.id));
    return rows
      .filter((row) => !known.has(row.id))
      .map((row) => row.id)
      .sort((a, b) => a - b)
      .join(",");
  }, [rows, projectMap.map]);
  const asked = useRef("");
  const { mutate: mutateMap } = projectMap;
  useEffect(() => {
    if (!unknown || asked.current === unknown) return;
    asked.current = unknown;
    void mutateMap();
  }, [unknown, mutateMap]);

  // A drawn layer whose style's computed values belong to older data (spec 12, 13.2): the map draws the stored classes
  // at once and asks for that style alone, which core recomputes; a hidden layer when it is shown.
  useEffect(() => {
    if (!projectId) return;
    for (const layer of layers) {
      const style = layer.style;
      if (!layer.visible || !style?.stale) continue;
      const key = `${projectId}:${layer.id}:${style.id}:${style.revision}`;
      if (staleAsked.has(key)) continue;
      staleAsked.add(key);
      fetchProjectStyle(projectId, layer.id, style.id)
        .then((reply) =>
          mutateMap((map) => (map ? withStyleReply(map, layer.id, style.id, reply) : map), {
            revalidate: false,
          })
        )
        .catch(() => undefined);
    }
  }, [projectId, layers, mutateMap]);
  return {
    ...projectMap,
    layers,
    isLoading: rowsLoading || projectMap.isLoading,
    mutateRows,
  };
}

/** A published map's layers, with the viewer's style choices from the link. */
export function usePublicMapLayers(config?: {
  layers: ProjectLayer[];
  map?: MapDocument | null;
  styles?: Record<string, StyleRead[]> | null;
}): MapLayer[] {
  return useMemo(() => (config ? publicMapLayers(config, getStylesFromUrl()) : []), [config]);
}
