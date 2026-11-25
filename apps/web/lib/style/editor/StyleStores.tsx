"use client";

// The page's style editor stores, provided to the style panel and the map. Saves go to core's
// style routes; every stored reply is written into the map request's cache once.
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useSWRConfig } from "swr";

import { renewAccessToken } from "@/lib/api/fetcher";
import { type MapResponse, projectMapUrl, withStyleReply } from "@/lib/api/map";
import { StyleStoreRegistry, editedLayersOf } from "@/lib/style/editor/registry";
import { createCoreTransport } from "@/lib/style/transports/core";

const StyleStoresContext = createContext<StyleStoreRegistry | null>(null);

export function StyleStoresProvider({ children }: { children: ReactNode }) {
  const { mutate } = useSWRConfig();
  const [registry] = useState(
    () =>
      new StyleStoreRegistry({
        createTransport: (key) => createCoreTransport(key),
        renewSession: renewAccessToken,
        onStored: (key, reply) =>
          void mutate<MapResponse>(
            projectMapUrl(key.projectId),
            (map) => (map ? withStyleReply(map, key.layerProjectId, key.styleId, reply) : map),
            { revalidate: false }
          ),
      })
  );
  return <StyleStoresContext.Provider value={registry}>{children}</StyleStoresContext.Provider>;
}

export const useStyleStores = (): StyleStoreRegistry | null => useContext(StyleStoresContext);

/** The layers the map draws from an open store (their style panel is open, or a save of theirs is out). */
export function useEditedLayers(
  projectId: string | undefined,
  layers: ReadonlyArray<{ id: number; style?: { id?: string } | null }>
) {
  const registry = useStyleStores();
  const subscribe = useCallback(
    (listener: () => void) => (registry ? registry.subscribe(listener) : () => undefined),
    [registry]
  );
  const read = () => registry?.keys().join("|") ?? "";
  const open = useSyncExternalStore(subscribe, read, read);
  return useMemo(
    () => (registry && projectId && open ? editedLayersOf(registry, projectId, layers) : []),
    [registry, projectId, layers, open]
  );
}
