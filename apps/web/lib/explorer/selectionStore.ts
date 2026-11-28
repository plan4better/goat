/**
 * The line of the path pointed at in a line mode, between two
 * stops, handed from the mode's map side (EditModeLayers) to the layers
 * that draw it over the route (ExplorerMapLayers).
 */
import type { LineString } from "geojson";

let current: LineString[] | null = null;
const listeners = new Set<() => void>();

export const selectionStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): LineString[] | null {
    return current;
  },
  set(next: LineString[] | null): void {
    current = next;
    listeners.forEach((l) => l());
  },
};
