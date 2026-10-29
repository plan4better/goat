/**
 * The stretch of line the map highlights for the picked patterns
 * (patternSections), handed from the route summary, which reads it from the
 * snapshot, to the map's layers, which sit outside the Explorer's data. Kept
 * with the patterns it is for (`key`, as the map's highlightedPatterns
 * joined), so the map draws it only while those are what it highlights.
 */
import type { FeatureCollection, LineString } from "geojson";

import type { SectionProps } from "@/lib/explorer/derive/patternSections";

export interface Highlight {
  key: string;
  sections: FeatureCollection<LineString, SectionProps>;
  /** The trips running the highlighted patterns, by trip_idx. */
  trips: Set<number>;
}

let current: Highlight | null = null;
const listeners = new Set<() => void>();

export const highlightStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): Highlight | null {
    return current;
  },
  set(next: Highlight | null): void {
    current = next;
    listeners.forEach((l) => l());
  },
};
