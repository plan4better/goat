"use client";

// The layer's map state the style panel shows next to its style (spec 10): where it draws among the basemap's layers.
// The project page provides it; the dev route has no map document, so its panel shows no such rows.
import { type ReactNode, createContext, useContext, useSyncExternalStore } from "react";

export type Position = "top" | "below_labels" | "below_roads";

export interface MapStateValue {
  position: Position;
  onPosition: (position: Position) => void;
  /** The project layer: an offer to move it belongs to it, whichever style is open. */
  layer?: string | number;
}

const MapStateContext = createContext<MapStateValue | null>(null);

export function MapStateProvider({ value, children }: { value: MapStateValue | null; children: ReactNode }) {
  return <MapStateContext.Provider value={value}>{children}</MapStateContext.Provider>;
}

export const useLayerMapState = (): MapStateValue | null => useContext(MapStateContext);

/** The layers whose Position row offers the move below the basemap's labels: the user switched Draw as from an image
 * to colors of its own (a color range, a hillshade, categories) while the layer was on top, where they hide the place
 * names (spec 10). The panel never moves a layer itself. Keyed by the project layer, else (no map document) by the
 * panel's store; each holds the store of the named style the switch was made in, the only one that shows it. Kept
 * while the page is open. */
const offered = new Map<unknown, object>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const changed = () => listeners.forEach((listener) => listener());

export const placementKey = (mapState: MapStateValue, store: object): unknown =>
  mapState.layer !== undefined ? `layer:${mapState.layer}` : store;

export function offerMove(key: unknown, store: object): void {
  if (offered.get(key) === store) return;
  offered.set(key, store);
  changed();
}

/** The offer is over: the layer was moved or placed by hand, is no longer on top, or draws an image again. */
export function dropOffer(key: unknown): void {
  if (offered.delete(key)) changed();
}

/** Whether the move is offered for `key` in the named style of `store`, read again when an offer starts or ends. */
export function useMoveOffered(key: unknown, store: object): boolean {
  const read = () => offered.get(key) === store;
  return useSyncExternalStore(subscribe, read, read);
}
