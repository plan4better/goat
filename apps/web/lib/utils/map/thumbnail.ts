// The thumbnail page's layers from the payload goatlib injects (`window.__THUMBNAIL_DATA__`): the map's layers top
// first, each with its active style document (`style`). A layer without one (a payload from before GOAT Style)
// draws nothing.
import { type ViewMode, cameraFor, viewModeOf } from "@/lib/scene/view";
import type { LayerStyle, Scene } from "@/lib/style/generated/types";
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

/** What goatlib's thumbnail task sends the thumbnail page (base64 JSON). */
export interface ThumbnailData {
  viewState: {
    latitude: number;
    longitude: number;
    zoom: number;
    bearing?: number;
    pitch?: number;
    /** A project's stored 3D keys (3D spec 5.1); absent in payloads from before 3D. */
    mode?: ViewMode;
    projection?: "mercator" | "globe";
  };
  basemap: string;
  /** The map's layers top first, each with its active style document (`style`). */
  layers: unknown[];
  bounds?: [number, number, number, number]; // [west, south, east, north]
  useBounds?: boolean; // If true, fit to bounds; if false, use viewState (default: true if bounds provided)
  /** A project's 3D scene (map document `scene`). */
  scene?: Scene;
}

/** The payload, decoded; null when it is missing or lacks the view, the basemap or the layers. */
export function parseThumbnailData(dataParam: string | null): ThumbnailData | null {
  if (!dataParam) return null;
  try {
    const parsed = JSON.parse(atob(dataParam)) as ThumbnailData;
    if (!parsed.viewState || !parsed.basemap || !Array.isArray(parsed.layers)) {
      console.error("Invalid thumbnail data: missing required fields");
      return null;
    }
    return parsed;
  } catch (error) {
    console.error("Failed to parse thumbnail data:", error);
    return null;
  }
}

/** How the thumbnail draws the view (3D spec 10): a project in its saved mode with its scene, a layer flat. */
export function thumbnailView(
  data: ThumbnailData,
  type: "project" | "layer" | "bundle"
): { mode: ViewMode; projection: "mercator" | "globe"; scene: Scene | undefined; maxPitch: number } {
  if (type !== "project") return { mode: "2d", projection: "mercator", scene: undefined, maxPitch: 0 };
  const mode = viewModeOf(data.viewState);
  return {
    mode,
    projection: data.viewState.projection === "globe" ? "globe" : "mercator",
    scene: isObject(data.scene) ? data.scene : undefined,
    maxPitch: cameraFor(mode).maxPitch,
  };
}
