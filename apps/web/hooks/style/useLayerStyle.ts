// The editor store of a map layer's active style, held while the caller is mounted (the style panel, the mobile
// opacity slider): the page's registry keeps it until its saves are answered.
import { useEffect, useState } from "react";

import { useStyleStores } from "@/lib/style/editor/StyleStores";
import type { EditorStore } from "@/lib/style/editor/store";

import type { MapLayer } from "@/hooks/map/useMapLayers";

export function useLayerStyle(
  projectId: string | undefined,
  layer: MapLayer | undefined
): EditorStore | null {
  const registry = useStyleStores();
  const [store, setStore] = useState<EditorStore | null>(null);
  const style = layer?.style;
  const layerProjectId = layer?.id;
  const styleId = style?.id;
  useEffect(() => {
    if (!registry || !projectId || layerProjectId === undefined || !style || !styleId) {
      setStore(null);
      return;
    }
    const key = { projectId, layerProjectId, styleId };
    setStore(registry.acquire(key, { document: style.document, revision: style.revision }));
    return () => registry.release(key);
    // A new document of the same style reaches the store through its saves, not by acquiring it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, projectId, layerProjectId, styleId]);
  return store;
}
