"use client";

// The project's scene as an editor store (3D spec 8.2, 8.3): the style editor's EditorStore over `{ scene }`, so the
// View popover and the Sky and atmosphere panel edit it with the style editor's rows, undo included. An editor's
// changes are saved to the project, a viewer's stay on screen. The page provides one store per project to the map
// controls and the map.
import { type ReactNode, createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

import { putScene } from "@/lib/api/map";
import { LocalSaver, type SceneDocument, SceneSaver } from "@/lib/scene/save";
import { type DocumentSaver, EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle, Scene } from "@/lib/style/generated/types";

/** The scene store's saver: what the panel reads issues from. */
export const sceneSaverOf = (store: EditorStore): SceneSaver | LocalSaver =>
  store.saver as unknown as SceneSaver | LocalSaver;

/** One store per project (and per editing right), starting from the stored scene. */
export function useSceneStore(projectId: string, initial: Scene | null | undefined, editable: boolean): EditorStore {
  const store = useMemo(() => {
    const document: SceneDocument = { scene: initial ?? {} };
    const saver = editable
      ? new SceneSaver({ document, put: (scene) => putScene(projectId, scene) })
      : new LocalSaver(document);
    // The style editor's store over a document of another shape: rows read and write it by path.
    return new EditorStore({ saver: saver as unknown as DocumentSaver<LayerStyle> }) as unknown as EditorStore;
    // A stored scene that arrives later does not replace the one being edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, editable]);
  useEffect(() => {
    const saver = sceneSaverOf(store);
    return () => {
      store.dispose();
      if (saver instanceof SceneSaver) saver.dispose();
    };
  }, [store]);
  return store;
}

const SceneStoreContext = createContext<EditorStore | null>(null);

export function SceneStoreProvider({
  projectId,
  initial,
  editable,
  children,
}: {
  projectId: string;
  initial: Scene | null | undefined;
  editable: boolean;
  children: ReactNode;
}) {
  const store = useSceneStore(projectId, initial, editable);
  return <SceneStoreContext.Provider value={store}>{children}</SceneStoreContext.Provider>;
}

/** The page's scene store; null outside a project map (dashboards' previews, the dataset pages). */
export const useSceneStoreContext = (): EditorStore | null => useContext(SceneStoreContext);

const NO_STORE = () => () => undefined;
const AUTOMATIC: Scene = {};

/** The scene as the store holds it now (an empty one once every key is removed); undefined without a store. */
export function useSceneDocument(store: EditorStore | null): Scene | undefined {
  const read = () =>
    store ? ((store.document as unknown as Partial<SceneDocument>).scene ?? AUTOMATIC) : undefined;
  return useSyncExternalStore(store ? store.subscribe : NO_STORE, read, read);
}
