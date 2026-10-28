"use client";

// The layer's map state the style panel shows next to its style (spec 10): where it draws among the basemap's layers.
// The project page provides it; the dev route has no map document, so its panel shows no such rows.
import { type ReactNode, createContext, useContext } from "react";

export type Position = "top" | "below_labels" | "below_roads";

export interface MapStateValue {
  position: Position;
  onPosition: (position: Position) => void;
}

const MapStateContext = createContext<MapStateValue | null>(null);

export function MapStateProvider({ value, children }: { value: MapStateValue | null; children: ReactNode }) {
  return <MapStateContext.Provider value={value}>{children}</MapStateContext.Provider>;
}

export const useLayerMapState = (): MapStateValue | null => useContext(MapStateContext);
