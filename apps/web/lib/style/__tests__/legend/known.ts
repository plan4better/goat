// What the legend checks find wrong today and nobody has decided on yet. Each entry names the check, the cases it
// holds for (by their settings, so the list survives a reshuffle of the cases) and what is wrong. A check expects
// these to fail: once one is fixed its test turns red until the entry is removed. Differences that are by design
// do not belong here; the checks themselves allow for those.
import type { LegendCase } from "./cases";

export interface KnownDifference {
  check: "compiles" | "invariants" | "map" | "render";
  when: (c: LegendCase) => boolean;
  reason: string;
}

export const KNOWN_DIFFERENCES: KnownDifference[] = [];

/** Properties the legend's data holds and its swatches do not draw: two entries that differ only in these look the
 * same on screen. The render check expects exactly that, so drawing one turns it red until its line is removed. */
export const NOT_DRAWN: Array<{ keys: string[]; reason: string }> = [];

/** The known difference a case has for a check, if any. */
export const known = (check: KnownDifference["check"], c: LegendCase): KnownDifference | undefined =>
  KNOWN_DIFFERENCES.find((k) => k.check === check && k.when(c));
