// The simple style panel of dashboards and mobile maps: an editor's opacity saves the layer's
// active style through the page's style stores; a published map's viewer changes an opacity of their own and may pick
// another of the layer's named styles, both view state on the layer rows (the style choice also goes into the link).
import { useCallback } from "react";

import { updateProjectLayer } from "@/lib/store/layer/slice";
import { useStyleStores } from "@/lib/style/editor/StyleStores";
import { getStylesFromUrl, writeStylesToUrl } from "@/lib/utils/map/loc-url";
import type { ProjectLayer } from "@/lib/validations/project";

import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

export const useLayerStyleChange = (projectId: string | undefined, viewOnly?: boolean) => {
  const dispatch = useAppDispatch();
  const registry = useStyleStores();

  const onOpacityChange = useCallback(
    (layer: MapLayer, opacity: number) => {
      if (viewOnly) {
        dispatch(updateProjectLayer({ id: layer.id, changes: { opacity } as Partial<ProjectLayer> }));
        return;
      }
      const style = layer.style;
      if (!registry || !projectId || !style) return;
      const key = { projectId, layerProjectId: layer.id, styleId: style.id };
      // Held only for this edit: the store stays until its save is stored, and the map draws it meanwhile.
      const store = registry.acquire(key, { document: style.document, revision: style.revision });
      store.set("opacity", opacity);
      registry.release(key);
    },
    [viewOnly, dispatch, registry, projectId]
  );

  const onStyleChange = useCallback(
    (layer: MapLayer, styleId: string) => {
      const list = layer.publishedStyles ?? [];
      const style = list.find((s) => s.id === styleId);
      if (!style) return;
      const otherStyles = list.filter((s) => s !== style).map((s) => ({ id: s.id, name: s.name }));
      dispatch(
        updateProjectLayer({ id: layer.id, changes: { style, otherStyles } as Partial<ProjectLayer> })
      );
      writeStylesToUrl({ ...getStylesFromUrl(), [String(layer.id)]: styleId });
    },
    [dispatch]
  );

  return { onOpacityChange, onStyleChange: viewOnly ? onStyleChange : undefined };
};
