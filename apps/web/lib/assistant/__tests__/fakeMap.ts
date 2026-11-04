import { vi } from "vitest";

import type { MapLike } from "@/lib/assistant/mapView";

/** A map at a fixed view whose flyTo and fitBounds are spies. */
export function fakeMap(view: {
  lng: number;
  lat: number;
  zoom: number;
  bearing?: number;
  pitch?: number;
  bounds?: number[];
}) {
  const [west, south, east, north] = view.bounds ?? [view.lng - 1, view.lat - 1, view.lng + 1, view.lat + 1];
  return {
    getCenter: () => ({ lng: view.lng, lat: view.lat }),
    getZoom: () => view.zoom,
    getBearing: () => view.bearing ?? 0,
    getPitch: () => view.pitch ?? 0,
    getBounds: () => ({
      getWest: () => west,
      getSouth: () => south,
      getEast: () => east,
      getNorth: () => north,
    }),
    flyTo: vi.fn(),
    fitBounds: vi.fn(),
  } satisfies MapLike;
}
