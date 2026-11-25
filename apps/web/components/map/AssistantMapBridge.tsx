"use client";

// The map page's bridge for the assistant dock (rendered inside the page's style and scene providers): it keeps the
// map, an open style editor and the scene in step with what the assistant changed on the server, without a reload,
// and shows a view the assistant asks for.
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "react-redux";
import { useSWRConfig } from "swr";

import { type MapResponse, projectMapUrl, withStyleReply } from "@/lib/api/map";
import { PROJECTS_API_BASE_URL, projectLayerGroupsKey, projectLayersKey } from "@/lib/api/projects";
import { registerMapBridge } from "@/lib/assistant/mapBridge";
import type { MapChange, ViewTarget } from "@/lib/assistant/mapEdits";
import { type MapLike, applyViewTarget } from "@/lib/assistant/mapView";
import type { StyleChange } from "@/lib/assistant/styleEdits";
import type { UndoFn } from "@/lib/assistant/types";
import { SceneSaver } from "@/lib/scene/save";
import { graphicsSupport } from "@/lib/scene/support";
import type { RootState } from "@/lib/store";
import { setProjection, setViewMode } from "@/lib/store/map/slice";
import { useStyleStores } from "@/lib/style/editor/StyleStores";
import { createCoreTransport } from "@/lib/style/transports/core";

import { sceneSaverOf, useSceneStoreContext } from "@/hooks/map/useSceneStore";

/** The changes of one project as one per style: its newest revision (null when one is not known), and whether any
 * changed the layer's list of styles. */
function perStyle(changes: StyleChange[], projectId: string): StyleChange[] {
  const styles = new Map<string, StyleChange>();
  for (const change of changes) {
    if (change.projectId !== projectId) continue;
    const id = `${change.layerProjectId}/${change.styleId}`;
    const known = styles.get(id);
    if (!known) {
      styles.set(id, change);
      continue;
    }
    styles.set(id, {
      ...change,
      revision:
        known.revision === null || change.revision === null
          ? null
          : Math.max(known.revision, change.revision),
      listChanged: known.listChanged || change.listChanged,
      removed: change.removed,
    });
  }
  return [...styles.values()];
}

const activeOf = (map: MapResponse | undefined, layerProjectId: number) =>
  map?.styles[String(layerProjectId)]?.active;

export default function AssistantMapBridge({
  projectId,
  isEditor,
  mapRef,
}: {
  projectId: string;
  isEditor: boolean;
  /** The page's map, for a view the assistant asks for; null while it is not drawn. */
  mapRef: RefObject<MapLike | null>;
}) {
  const registry = useStyleStores();
  const sceneStore = useSceneStoreContext();
  const redux = useStore<RootState>();
  const { cache, mutate } = useSWRConfig();
  const followStyles = async (changes: StyleChange[]): Promise<void> => {
    const url = projectMapUrl(projectId);
    const cached = () => cache.get(url)?.data as MapResponse | undefined;
    const followed = await Promise.all(
      perStyle(changes, projectId).map(async (change): Promise<boolean> => {
        if (change.removed) return true;
        const { layerProjectId, styleId, revision } = change;
        const key = { projectId, layerProjectId, styleId };
        // An open store draws the layer and decides alone whether it holds the change; else the cached map does.
        const open = registry?.get(key);
        const active = activeOf(cached(), layerProjectId);
        const held = open ? open.saver.revision : active?.id === styleId ? active.revision : null;
        if (revision !== null && held !== null && held >= revision) return change.listChanged;
        const stored = await createCoreTransport(key)
          .load()
          .catch(() => null);
        // The style is gone: the map request answers what the layer has now.
        if (!stored) return true;
        const reply = { document: stored.document, revision: stored.revision, issues: stored.issues ?? [] };
        // Written only over an older revision of the same style: a save of the page's own may have stored a newer
        // one meanwhile, and a write that changes nothing would still discard a map request under way.
        const older = (map: MapResponse | undefined) => {
          const drawn = activeOf(map, layerProjectId);
          return drawn?.id === styleId && drawn.revision < reply.revision;
        };
        if (older(cached())) {
          await mutate<MapResponse>(
            url,
            (map) => (map && older(map) ? withStyleReply(map, layerProjectId, styleId, reply) : map),
            { revalidate: false }
          );
        }
        registry?.get(key)?.takeOutside(reply);
        return change.listChanged;
      })
    );
    // The list of styles and the active one come with the map request. Only an editor's is read again: the change
    // was written with the editor's rights, and a viewer's map holds view state the stored map would replace.
    if (isEditor && followed.some(Boolean)) await mutate(url);
  };

  const followMap = async (change: MapChange): Promise<void> => {
    // A viewer changed nothing on the server, and the stored map would replace the view state the tab holds.
    if (change.projectId !== projectId || !isEditor) return;
    const url = projectMapUrl(projectId);
    await Promise.all([
      change.layers && mutate(projectLayersKey(projectId)),
      change.groups && mutate(projectLayerGroupsKey(projectId)),
      // The page switches the basemap itself when the project's row names another one.
      change.basemap && mutate([`${PROJECTS_API_BASE_URL}/${projectId}`]),
      // The scene comes with the map document: one read for both.
      (change.state || change.scene) && mutate(url),
    ]);
    if (!change.scene || !sceneStore) return;
    // The map draws the scene store's document, not the cached one.
    const map = cache.get(url)?.data as MapResponse | undefined;
    if (map) sceneSaverOf(sceneStore).receive(map.map.scene ?? null);
  };

  const applyView = (target: ViewTarget): UndoFn | void => {
    const map = mapRef.current;
    // The store outlives the page: a view stored for another project is not this map's.
    const shown = () => {
      const view = redux.getState().map.view;
      return view?.projectId === projectId ? view : undefined;
    };
    const view = shown();
    // Only the map of Map mode is the assistant's to move: the dashboard builder draws its own view of it.
    if (!map || !view || redux.getState().map.mapMode !== "data") return;
    // Read when used: the page draws a new map after a switch to another mode and back.
    return applyViewTarget(() => mapRef.current, target, {
      get: () => shown() ?? view,
      // As the View button: no 3D where the browser would draw it in software.
      setMode: (mode) => {
        if (mode === "2d" || graphicsSupport() !== "software") redux.dispatch(setViewMode(mode));
      },
      setProjection: (projection) => redux.dispatch(setProjection(projection)),
    });
  };

  // The pending style saves and the scene's go out together: a later save of either would write over what the
  // assistant or an Undo stores.
  const settle = async (timeoutMs?: number): Promise<void> => {
    const scene = sceneStore && sceneSaverOf(sceneStore);
    await Promise.all([
      registry?.settle(timeoutMs),
      scene instanceof SceneSaver ? scene.settle(timeoutMs) : undefined,
    ]);
  };

  const latest = useRef({ followStyles, followMap, applyView, settle });
  useLayoutEffect(() => {
    latest.current = { followStyles, followMap, applyView, settle };
  });
  // One call at a time: a later change is weighed against the map as the earlier one left it, and a cache write
  // of one does not discard a map request of another.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    const queued = (follow: () => Promise<void>): Promise<void> => {
      const run = queue.current.then(follow);
      queue.current = run.catch(() => undefined);
      return run;
    };
    return registerMapBridge({
      projectId,
      isEditor,
      followStyles: (changes) => queued(() => latest.current.followStyles(changes)),
      settle: (timeoutMs) => latest.current.settle(timeoutMs).catch(() => undefined),
      followMap: (change) => queued(() => latest.current.followMap(change)),
      applyView: (target) => latest.current.applyView(target),
    });
  }, [projectId, isEditor, registry]);
  return null;
}
