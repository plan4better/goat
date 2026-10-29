/**
 * The trips of the selected line that the map shows in full: those of the
 * direction or variant shown (the first direction while nothing is picked,
 * the Stops tab's line while it is open). Null when there is no line. The map fades the line's other vehicles; the bottom bar counts
 * only these.
 */
import { useSyncExternalStore } from "react";

import { highlightedPatterns } from "@/lib/explorer/directionChoice";
import { highlightStore } from "@/lib/explorer/highlightStore";

import { useAppSelector } from "@/hooks/store/ContextHooks";

/** The highlighted patterns, comma-joined, as the map's highlight keys them. */
export function usePatternKey(): string {
  return useAppSelector((s) =>
    s.explorer.drawing
      ? (highlightedPatterns(
          s.explorer.pattern,
          s.explorer.drawing.directions,
          s.explorer.routeTab === "stops"
        )?.join(",") ?? "")
      : ""
  );
}

export function usePickedTrips(): Set<number> | null {
  const patternKey = usePatternKey();
  const highlight = useSyncExternalStore(highlightStore.subscribe, highlightStore.getSnapshot, () => null);
  return patternKey && highlight?.key === patternKey ? highlight.trips : null;
}
