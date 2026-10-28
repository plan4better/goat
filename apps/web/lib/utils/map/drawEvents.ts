import type { Map as MaplibreMap } from "maplibre-gl";
import type { MapRef } from "react-map-gl/maplibre";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrawListener = (event: any) => void;

interface DrawEventTarget {
  on(type: string, listener: DrawListener): void;
  off(type: string, listener: DrawListener): void;
}

/**
 * mapbox-gl-draw fires its `draw.*` events on the map, but MapLibre types
 * `on`/`off` against its own event names only. Returns the same map, typed to
 * subscribe to draw's events.
 */
export const drawEvents = (map: MaplibreMap | MapRef): DrawEventTarget => map as unknown as DrawEventTarget;
