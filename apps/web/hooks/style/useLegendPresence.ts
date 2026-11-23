"use client";

// Which classes a layer's legend lists (spec 7.2 `legend.classes`), for every place a legend shows: with `filter` the
// classes the layer's saved filter keeps, counted by the server with the processes requests that take a filter, once
// per layer, filter and classes (SWR keeps the answer, so every legend of the layer shares it); with `view` the classes
// the map drew in its view, which the map's renderer counts (`watchViewPresence`); with `all`, nothing, and the legend
// lists every class. Until the counts arrive the legend waits (`PRESENCE_PENDING`: placeholder rows), so it never
// lists every class first and then shrinks; a count that fails, or a layer the map does not count, lists every class.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import useSWR from "swr";

import { getFeatureCount, getUniqueValues } from "@/lib/api/processes";
import { getHistogramStats } from "@/lib/api/projects";
import { loadRasterValues, useLoadedRasterValues } from "@/lib/api/rasters";
import type { Geometry } from "@/lib/style/compile/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { coverageUrl, layerFilter, versionParam } from "@/lib/style/layerSource";
import { type Legend, PRESENCE_PENDING, type Presence, buildLegend, legendClasses } from "@/lib/style/legend";
import {
  type PresenceCount,
  type PresenceRequest,
  presenceFromCounts,
  presenceRequests,
} from "@/lib/style/presence";
import { rasterColorSpec } from "@/lib/style/raster/color";
import { valueQuery, valuesUrl } from "@/lib/style/raster/values";
import { subscribeViewPresence, viewCounted, viewPresence } from "@/lib/style/render/viewPresence";

import { useAppSelector } from "@/hooks/store/ContextHooks";

/** The most values the unique values request answers at once: a field with more cannot prove a class absent. */
const VALUES_LIMIT = 1000;
/** The most bins the histogram request takes. */
const MAX_BINS = 100;

/** A layer as its legend's counts need it. */
export interface LegendLayer {
  /** The renderer's key (the project layer id): the map's count is kept by it. */
  key: string;
  /** The dataset the server counts in. */
  dataset?: string | null;
  /** The layer's saved filter (`query.cql`). */
  cql?: unknown;
  /** When the dataset's data last changed: a change counts again. */
  version?: string | null;
}

/** A project layer (or a node of the layer tree) as its legend's counts need it. */
export const legendLayerOf = (layer: {
  id: number | string;
  layer_id?: string | null;
  query?: { cql?: unknown } | null;
  dataset_updated_at?: string | null;
}): LegendLayer => ({
  key: String(layer.id),
  dataset: layer.layer_id,
  cql: layer.query?.cql,
  version: layer.dataset_updated_at,
});

/** One request's answer: the values with their counts and the features without a value, or the histogram. */
async function countOf(
  dataset: string,
  filter: JsonObject,
  request: PresenceRequest
): Promise<PresenceCount> {
  const text = JSON.stringify(filter);
  if (request.kind === "values") {
    // The values request leaves features without a value out: they are counted on their own.
    const empty = { op: "and", args: [filter, { op: "isNull", args: [{ property: request.field }] }] };
    const [page, missing] = await Promise.all([
      getUniqueValues(dataset, request.field, { filter: text, limit: VALUES_LIMIT }),
      getFeatureCount(dataset, JSON.stringify(empty)),
    ]);
    return { kind: "values", values: page.values, total: page.total, missing: missing.count };
  }
  const stats = await getHistogramStats(dataset, {
    column_name: request.field,
    num_bins: Math.min(request.breaks.length + 1, MAX_BINS),
    method: "custom_breaks",
    custom_breaks: request.breaks,
    query: text,
  });
  return { kind: "histogram", bins: stats.bins, missing: stats.missing_count };
}

/** The counts of every classification by its key; the same request asked once (a size and a color of one field). A
 * request that fails leaves its classifications out, so their legends list every class. */
async function countUnder(
  dataset: string,
  filter: JsonObject,
  requests: Array<{ key: string; request: PresenceRequest }>
): Promise<Record<string, PresenceCount>> {
  const asked = new Map<string, Promise<PresenceCount>>();
  const ask = (request: PresenceRequest) => {
    const id = JSON.stringify(request);
    if (!asked.has(id)) asked.set(id, countOf(dataset, filter, request));
    return asked.get(id) as Promise<PresenceCount>;
  };
  const settled = await Promise.allSettled(requests.map(({ request }) => ask(request)));
  return Object.fromEntries(
    requests.flatMap(({ key }, i) => {
      const answer = settled[i];
      return answer.status === "fulfilled" ? [[key, answer.value]] : [];
    })
  );
}

/** What a legend lists: the classes present, `PRESENCE_PENDING` while they are counted, nothing for every class. */
export type LegendPresence = Presence | typeof PRESENCE_PENDING | undefined;

/** The classes the layer's saved filter keeps; nothing without a filter, waiting while the server counts. */
export function useFilterPresence(
  style: JsonObject | null | undefined,
  layer: LegendLayer | undefined
): LegendPresence {
  const filter = layerFilter(layer?.cql);
  const requests = useMemo(() => (style ? presenceRequests(style) : []), [style]);
  const dataset = layer?.dataset;
  const key =
    style && dataset && filter && requests.length
      ? ["legend-presence", dataset, JSON.stringify(filter), JSON.stringify(requests), layer?.version ?? ""]
      : null;
  const { data, error } = useSWR(key, () => countUnder(dataset as string, filter as JsonObject, requests), {
    // Counted once per filter: another legend of the layer mounting later, or the window regaining focus, asks nothing.
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
  const pending = key !== null && data === undefined && error === undefined;
  return useMemo(
    () => (style && data ? presenceFromCounts(style, data) : pending ? PRESENCE_PENDING : undefined),
    [style, data, pending]
  );
}

/** The classes a map drew in its view of the layer (`scope`: the map, `MAP_SCOPE` or a print map's); waiting until the
 * map has counted once. */
export function useViewPresence(scope: string | undefined, key: string | undefined): LegendPresence {
  const read = () =>
    scope && key
      ? (viewPresence(scope, key) ?? (viewCounted(scope) ? undefined : PRESENCE_PENDING))
      : undefined;
  return useSyncExternalStore(subscribeViewPresence, read, read);
}

/** The classes a layer's legend lists, for `buildLegend`'s `present`; `scope` is the map whose view counts. */
export function useLegendPresence(
  style: JsonObject | null | undefined,
  layer: LegendLayer | undefined,
  scope: string | undefined
): LegendPresence {
  const mode = style ? legendClasses(style) : "all";
  const filtered = useFilterPresence(mode === "filter" ? style : undefined, layer);
  const viewed = useViewPresence(mode === "view" ? scope : undefined, layer?.key);
  return mode === "filter" ? filtered : mode === "view" ? viewed : undefined;
}

/** The legends waiting for their counts: the print page marks itself ready once none waits, so a PDF never holds a
 * placeholder, nor every class of a legend that lists fewer. */
const waiting = new Set<symbol>();
const waitingListeners = new Set<() => void>();
const subscribeWaiting = (listener: () => void) => {
  waitingListeners.add(listener);
  return () => {
    waitingListeners.delete(listener);
  };
};
const readWaiting = () => waiting.size > 0;

/** Whether any legend on the page still waits for the classes it lists. */
export function useLegendsWaiting(): boolean {
  return useSyncExternalStore(subscribeWaiting, readWaiting, readWaiting);
}

/** The zoom a legend of the page's map reads its values at: the zoom the map is at, as the store holds it (MapViewer
 * writes it rounded down to a tenth once the map stops moving, so its whole zoom is the one the map draws at), and a
 * legend changes when the stored zoom does and never while the map moves. The map draws images at that whole zoom
 * (`buildLegend` reads those colors there). 12 before the map has said its zoom. */
export const useLegendZoom = (): number => useAppSelector((state) => state.map.currentZoom ?? 12);

/** Whether the description at `url` has answered (a description or none) since this component asked for it
 * (`loadRasterValues`, the cache every map of the page shares); false without `url`. */
function useRasterValuesAnswered(url: string | undefined): boolean {
  const [answered, setAnswered] = useState<string>();
  useEffect(() => {
    if (!url) return;
    let live = true;
    const answer = loadRasterValues(url, () => {
      if (live) setAnswered(url);
    });
    if (answer !== undefined) setAnswered(url);
    return () => {
      live = false;
    };
  }, [url]);
  return url !== undefined && answered === url;
}

/** A layer's legend (`buildLegend`) with the classes its `legend.classes` lists; null without a style or a legend.
 * `askValues` (the print's legends): a raster file's listed classes with an open outer end, whose values no map of
 * the page has loaded, ask for them
 * (the address the map asks, so one request) and hold the print until they answer, so a PDF never reads "under 49.4"
 * for a class the band's minimum closes. */
export function useLayerLegend(
  style: JsonObject | null | undefined,
  ctx: { geometry?: Geometry; zoom: number; serviceLegendUrl?: string; askValues?: boolean },
  layer: LegendLayer | undefined,
  scope: string | undefined
): Legend | null {
  const present = useLegendPresence(style, layer, scope);
  // A raster file's classes read the minimum and maximum of the values the map loaded for it (asks nothing).
  const query = style?.kind === "raster" && layer?.dataset ? valueQuery(style) : null;
  const values = useLoadedRasterValues(
    query && layer?.dataset ? valuesUrl(coverageUrl(layer.dataset), query) : undefined
  );
  const classed =
    !!query && !!style && isObject(style.render) && rasterColorSpec(style.render)?.kind === "classes";
  // Only a legend that lists classes with an open outer end reads the values: not a hidden one, not the name only,
  // nor one whose listed outer ends are written (values outside left out, each end with its bound or the color range).
  const { geometry, zoom, serviceLegendUrl, askValues } = ctx;
  const opensEnds = useMemo(() => {
    if (!askValues || !classed || values || !style) return false;
    const section = buildLegend(style, { geometry, zoom, serviceLegendUrl })?.sections.find(
      (s) => s.kind === "entries" && s.id === "raster"
    );
    if (section?.kind !== "entries") return false;
    // An end the map draws open: the outer classes with the end colors outside, else an end without a bound.
    return section.entries.some((e) => e.range && (e.range.from === undefined || e.range.to === undefined));
  }, [askValues, classed, values, style, geometry, zoom, serviceLegendUrl]);
  const asked =
    opensEnds && query && layer?.dataset
      ? valuesUrl(coverageUrl(layer.dataset), query, versionParam(layer.version))
      : undefined;
  const answered = useRasterValuesAnswered(asked);
  const isWaiting = present === PRESENCE_PENDING || (asked !== undefined && !answered);
  useEffect(() => {
    if (!isWaiting) return;
    const token = Symbol("legend");
    waiting.add(token);
    waitingListeners.forEach((listener) => listener());
    return () => {
      waiting.delete(token);
      waitingListeners.forEach((listener) => listener());
    };
  }, [isWaiting]);
  const valueRange = values?.range;
  return useMemo(
    () => (style ? buildLegend(style, { geometry, zoom, serviceLegendUrl, present, valueRange }) : null),
    [style, geometry, zoom, serviceLegendUrl, present, valueRange]
  );
}
