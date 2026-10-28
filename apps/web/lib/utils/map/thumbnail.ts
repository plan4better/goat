// The thumbnail page's layers from the payload goatlib injects (`window.__THUMBNAIL_DATA__`): the map's layers top
// first, each with its active style document (`style`). A layer without one (a payload from before GOAT Style)
// draws nothing.
import type { LayerStyle } from "@/lib/style/generated/types";
import { isObject } from "@/lib/style/json";
import type { ViewLayer } from "@/lib/style/render/viewLayers";

export function thumbnailLayers(payload: unknown[] | undefined): ViewLayer[] {
  return (payload ?? []).filter(isObject).map((layer) => {
    const style =
      isObject(layer.style) && layer.style.version === 1 ? (layer.style as unknown as LayerStyle) : null;
    return {
      ...(layer as unknown as ViewLayer),
      visible: layer.visible !== false,
      style: style ? { document: style } : null,
    };
  });
}
