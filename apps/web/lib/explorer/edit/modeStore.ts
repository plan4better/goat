/**
 * A line mode ("Edit stops", "Edit path"; 26 Nov 2026): the line it edits,
 * as the map needs it to place the pointer along it — the pattern shown,
 * its stops along its shape and the shape's points, and where an edit on it
 * starts — handed from the mode's resolver, which reads it from the
 * snapshot, to the map's layers, which sit outside the Explorer's data (as
 * the selection store hands them the path pointed at).
 */
import type { PatternLine } from "@/lib/explorer/derive/path";
import type { LineScope } from "@/lib/explorer/edit/ops/lineStops";

export interface ModeLine {
  line: PatternLine;
  scope: LineScope;
}

let current: ModeLine | null = null;
const listeners = new Set<() => void>();

export const modeStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): ModeLine | null {
    return current;
  },
  set(next: ModeLine | null): void {
    current = next;
    listeners.forEach((l) => l());
  },
};
