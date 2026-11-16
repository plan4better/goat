"use client";

// Which classes a layer's legend lists (spec 7.2 `legend.classes`), for every place a legend shows: with `filter` the
// classes the layer's saved filter keeps, counted by the server with the processes requests that take a filter, once
// per layer, filter and classes (SWR keeps the answer, so every legend of the layer shares it); with `view` the classes
// the map drew in its view, which the map's renderer counts (`watchViewPresence`); with `all`, nothing, and the legend
// lists every class. Until the counts arrive the legend waits (`PRESENCE_PENDING`: placeholder rows), so it never
// lists every class first and then shrinks; a count that fails, or a layer the map does not count, lists every class.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import useSWR from "swr";

import { getFeatureCount, getUniqueValues } from "@/lib/api/processes";
import { getHistogramStats } from "@/lib/api/projects";
import type { Geometry } from "@/lib/style/compile/types";
import type { JsonObject } from "@/lib/style/json";
import { layerFilter } from "@/lib/style/layerSource";
import { type Legend, PRESENCE_PENDING, type Presence, buildLegend, legendClasses } from "@/lib/style/legend";
import {
  type PresenceCount,
  type PresenceRequest,
  presenceFromCounts,
  presenceRequests,
} from "@/lib/style/presence";
import { subscribeViewPresence, viewCounted, viewPresence } from "@/lib/style/render/viewPresence";

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

/** A layer's legend (`buildLegend`) with the classes its `legend.classes` lists; null without a style or a legend. */
export function useLayerLegend(
  style: JsonObject | null | undefined,
  ctx: { geometry?: Geometry; zoom: number; serviceLegendUrl?: string },
  layer: LegendLayer | undefined,
  scope: string | undefined
): Legend | null {
  const present = useLegendPresence(style, layer, scope);
  const isWaiting = present === PRESENCE_PENDING;
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
  const { geometry, zoom, serviceLegendUrl } = ctx;
  return useMemo(
    () => (style ? buildLegend(style, { geometry, zoom, serviceLegendUrl, present }) : null),
    [style, geometry, zoom, serviceLegendUrl, present]
  );
}
