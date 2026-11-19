// The values a raster layer colors in the browser (spec 9): its source gets the description of the value tiles its
// style reads (band or formula, resampling), which the compiler needs for the tile URL and the stops. The renderer
// loads each description once; a description that changes while a band or formula is edited is asked for after a
// quiet moment, and the layer keeps its last drawing until it has loaded.
import type { JsonObject } from "@/lib/style/json";
import { type RasterValues, valueQuery, valuesUrl } from "@/lib/style/raster/values";
import { RASTER_QUIET_MS } from "@/lib/style/render/apply";
import type { RenderLayer } from "@/lib/style/render/mapLayers";

/** A description by its URL: undefined while it loads, null when there is none. */
export type ValuesAnswer = RasterValues | null | undefined;

/** The URL of the description a layer's style reads; null for other layers and a source that has its values. */
function valuesUrlOf(layer: RenderLayer): string | null {
  const source = layer.source;
  if (source.type !== "raster" || source.values) return null;
  const style = layer.style as unknown as JsonObject;
  if (style.kind !== "raster") return null;
  const query = valueQuery(style);
  return query ? valuesUrl(source.coverage, query, source.version) : null;
}

/** The layers with the values their raster styles read; pending while a visible layer's description loads (a hidden
 * one does not hold print and thumbnails). A failed one draws nothing and is not pending. Other layers are returned as
 * they are. */
export function withRasterValues(
  layers: RenderLayer[],
  load: (url: string, layer: RenderLayer) => ValuesAnswer
): { layers: RenderLayer[]; pending: boolean } {
  let pending = false;
  const out = layers.map((layer) => {
    const url = valuesUrlOf(layer);
    if (url === null || layer.source.type !== "raster") return layer;
    const values = load(url, layer);
    if (values === undefined && layer.entry.visible !== false) pending = true;
    return values ? { ...layer, source: { ...layer.source, values } } : layer;
  });
  return { layers: out, pending };
}

/** One map's raster values over its draws. */
export interface RasterValuesOver {
  attach(layers: RenderLayer[]): { layers: RenderLayer[]; pending: boolean };
  /** Stops the quiet moments still running. */
  dispose(): void;
}

/**
 * The raster values of one map's draws, through `load` (`loadRasterValues`, which calls `redraw` when an answer
 * arrives). A layer's first description is asked for at once. When a layer's description changes to one this map
 * has not asked for (a formula typed key by key), it is asked for once it stayed the wanted one for
 * `RASTER_QUIET_MS`, and `redraw` is called then; until it has loaded, the layer draws its last drawing (its style
 * and values before the change), so the map loads no tiles while the edit goes on.
 */
export function rasterValuesOver(
  load: (url: string, onLoad: () => void) => ValuesAnswer,
  redraw: () => void
): RasterValuesOver {
  const asked = new Set<string>();
  /** Per layer: the description it asked for last, and the layer as last drawn with values. */
  const wanted = new Map<string, { url: string; drawn?: RenderLayer }>();
  const quiet = new Map<string, { url: string; timer: ReturnType<typeof setTimeout> }>();
  const stopQuiet = (key: string) => {
    clearTimeout(quiet.get(key)?.timer);
    quiet.delete(key);
  };

  const ask = (url: string, layer: RenderLayer): ValuesAnswer => {
    const last = wanted.get(layer.key);
    if (last && last.url !== url && !asked.has(url)) {
      if (quiet.get(layer.key)?.url !== url) {
        stopQuiet(layer.key);
        const timer = setTimeout(() => {
          quiet.delete(layer.key);
          asked.add(url);
          redraw();
        }, RASTER_QUIET_MS);
        quiet.set(layer.key, { url, timer });
      }
      return undefined;
    }
    stopQuiet(layer.key);
    asked.add(url);
    wanted.set(layer.key, { url, drawn: last?.drawn });
    return load(url, redraw);
  };

  return {
    attach(layers) {
      const keys = new Set(layers.map((layer) => layer.key));
      for (const key of [...wanted.keys()]) {
        if (keys.has(key)) continue;
        wanted.delete(key);
        stopQuiet(key);
      }
      const answers = new Map<string, ValuesAnswer>();
      const result = withRasterValues(layers, (url, layer) => {
        const values = ask(url, layer);
        answers.set(layer.key, values);
        return values;
      });
      const out = result.layers.map((layer) => {
        const last = wanted.get(layer.key);
        if (!last) return layer;
        if (!answers.has(layer.key)) {
          // Another render (an image, no band): no quiet moment and no last drawing stand for it.
          stopQuiet(layer.key);
          last.drawn = undefined;
          return layer;
        }
        const values = answers.get(layer.key);
        if (values !== undefined) {
          last.drawn = values ? layer : undefined;
          return layer;
        }
        return last.drawn
          ? { ...layer, style: last.drawn.style, version: last.drawn.version, source: last.drawn.source }
          : layer;
      });
      return { layers: out, pending: result.pending };
    },
    dispose() {
      for (const key of [...quiet.keys()]) stopQuiet(key);
    },
  };
}
