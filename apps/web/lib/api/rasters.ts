// geoapi's raster service: a raster file's info with its band statistics, and the cell values at a point.
import { useMemo } from "react";
import useSWR from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { GEOAPI_BASE_URL } from "@/lib/constants";
import { type RasterInfo, type RasterInfoResponse, rasterInfoOf } from "@/lib/style/raster/metadata";

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
