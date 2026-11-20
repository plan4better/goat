// geoapi's raster service: a raster file's info with its band statistics, the cell values at a point, and the
// descriptions of its value tiles.
import { useMemo, useSyncExternalStore } from "react";
import useSWR from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { GEOAPI_BASE_URL } from "@/lib/constants";
import { type RasterInfo, type RasterInfoResponse, rasterInfoOf } from "@/lib/style/raster/metadata";
import { type RasterValues, rasterValuesOf } from "@/lib/style/raster/values";

const rasterUrl = (datasetId: string) => `${GEOAPI_BASE_URL}/collections/${datasetId}/raster`;

/** Why the raster service could not describe a file: its address is refused (a private host) or the file cannot be
 * read now (unreachable, too slow, not a raster). */
export type RasterError = "refused" | "unavailable";

export function rasterErrorOf(error: unknown): RasterError | undefined {
  if (!error) return undefined;
  return (error as { status?: number }).status === 422 ? "refused" : "unavailable";
}

/** A raster dataset's bands, no data, color table and band statistics; undefined until read, with the reason when
 * the service could not read the file. */
export function useRasterInfo(datasetId?: string): { info?: RasterInfo; error?: RasterError } {
  const { data, error } = useSWR<RasterInfoResponse>(
    datasetId ? `${rasterUrl(datasetId)}/info` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      errorRetryCount: 2,
    }
  );
  const info = useMemo(() => (data ? rasterInfoOf(data) : undefined), [data]);
  return { info, error: rasterErrorOf(error) };
}

export interface RasterPoint {
  /** Every band's value; null where the point is no data or outside the file. */
  values: Array<number | null>;
  /** The value of the style's band or formula, when a coloring token was sent. */
  styled: number | null;
}

/** The cell values at a point; null when the service could not answer. */
export async function fetchRasterPoint(
  datasetId: string,
  lngLat: { lng: number; lat: number },
  token?: string
): Promise<RasterPoint | null> {
  const params = new URLSearchParams({ lon: String(lngLat.lng), lat: String(lngLat.lat) });
  if (token) params.set("style", token);
  try {
    const response = await apiRequestAuth(`${rasterUrl(datasetId)}/point?${params.toString()}`);
    return response.ok ? ((await response.json()) as RasterPoint) : null;
  } catch {
    return null;
  }
}

/** A raster file's west, south, east and north in degrees, from its header; null when the service cannot tell. For a
 * layer stored without an extent: core stores these when it creates a COG layer. */
export async function fetchRasterBounds(datasetId: string): Promise<[number, number, number, number] | null> {
  const response = await apiRequestAuth(`${rasterUrl(datasetId)}/bounds`);
  if (!response.ok) return null;
  const body = (await response.json()) as { bounds: [number, number, number, number] | null };
  return body.bounds;
}

/** How long a loaded description of value tiles is used before it is asked for again (a file replaced at its address
 * gets a new version). */
export const VALUES_TTL_MS = 600_000;
/** How long after a failed request a description is asked for again. */
export const VALUES_RETRY_MS = 30_000;
/** How long a description request may take before it counts as failed. */
export const VALUES_TIMEOUT_MS = 20_000;

interface ValuesEntry {
  /** Undefined until the first answer, null when there was none. */
  values?: RasterValues | null;
  /** When the description is asked for again. */
  due: number;
  loading: boolean;
  /** Called once when the next answer arrives. */
  waiting: Set<() => void>;
}

/** The descriptions of value tiles, by address, for every map of the page. */
const valuesCache = new Map<string, ValuesEntry>();
/** Who hears when a description arrives (the style panel, which reads what the map loaded). */
const valuesListeners = new Set<() => void>();

/** Calls `listener` whenever a description arrives; returns the call that stops it. */
export function subscribeRasterValues(listener: () => void): () => void {
  valuesListeners.add(listener);
  return () => {
    valuesListeners.delete(listener);
  };
}

/** The description already loaded for `url` (`valuesUrl` without a version), whatever version the map asked for;
 * asks nothing. */
export function loadedRasterValues(url: string): RasterValues | undefined {
  for (const [key, entry] of valuesCache)
    if ((key === url || key.startsWith(`${url}&v=`)) && entry.values) return entry.values;
  return undefined;
}

/** `loadedRasterValues` for a component, read again when a description arrives. */
export function useLoadedRasterValues(url: string | undefined): RasterValues | undefined {
  return useSyncExternalStore(
    subscribeRasterValues,
    () => (url ? loadedRasterValues(url) : undefined),
    () => undefined
  );
}

/** A description, or null and whether the failure may pass (a server error, no answer in time). */
async function requestValues(url: string): Promise<{ values: RasterValues | null; passing: boolean }> {
  try {
    const response = await apiRequestAuth(url, { signal: AbortSignal.timeout(VALUES_TIMEOUT_MS) });
    if (!response.ok) return { values: null, passing: response.status >= 500 };
    return { values: rasterValuesOf(await response.json()), passing: false };
  } catch {
    // Unreachable, too slow, or the answer cut off.
    return { values: null, passing: true };
  }
}

function askValues(url: string, entry: ValuesEntry): void {
  entry.loading = true;
  void requestValues(url).then(({ values, passing }) => {
    entry.loading = false;
    // A failed refresh keeps the description it had.
    if (values || entry.values === undefined) entry.values = values;
    entry.due = Date.now() + (values ? VALUES_TTL_MS : VALUES_RETRY_MS);
    // A first answer that failed for a passing reason: whoever still waits (a map drawing the layer) gets the next
    // answer without asking. A refused one (a bad formula) and a failed refresh are asked again by a later call.
    if (entry.values === null && passing)
      setTimeout(() => {
        if (entry.waiting.size && !entry.loading) askValues(url, entry);
      }, VALUES_RETRY_MS);
    const waiting = [...entry.waiting];
    entry.waiting.clear();
    for (const onLoad of waiting) onLoad();
    for (const listener of [...valuesListeners]) listener();
  });
}

/** The description of a raster's value tiles at `url` (`valuesUrl`): undefined while it loads, null when geoapi gave
 * none (refused, failing, unreachable or too slow; asked again after `VALUES_RETRY_MS`). The old description stays
 * while a stale one is asked for again. `onLoad` is called once when the answer it waits for arrives. */
export function loadRasterValues(url: string, onLoad: () => void): RasterValues | null | undefined {
  let entry = valuesCache.get(url);
  if (!entry) {
    entry = { due: 0, loading: false, waiting: new Set() };
    valuesCache.set(url, entry);
  }
  if (!entry.loading && Date.now() >= entry.due) askValues(url, entry);
  if (entry.loading || entry.values === null) entry.waiting.add(onLoad);
  return entry.values;
}
