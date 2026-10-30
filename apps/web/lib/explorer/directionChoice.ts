/**
 * The one direction choice the route's views share (02-panel-behaviour-spec ›
 * Direction): the trip strip, the Stops tab and the stop timetable. A choice
 * is one direction whole (its main pattern and every variant), or one
 * variant; none yet is the first direction, whole, in every view — the
 * map's highlight too, so all agree from the start. There is no "all
 * directions": one direction at a time (22 Oct 2026).
 */
import type { Direction } from "@/lib/explorer/derive/directions";
import type { ExplorerPatternChoice } from "@/lib/store/explorer/slice";

export interface ResolvedChoice {
  /** The direction chosen; null for a route with none. */
  direction: Direction | null;
  /** The variant chosen; null for a whole direction. */
  pattern_idx: number | null;
  /** Every pattern the choice shows. */
  patterns: Set<number>;
}

export function resolveChoice(choice: ExplorerPatternChoice | null, directions: Direction[]): ResolvedChoice {
  const direction = directions.find((d) => d.key === choice?.direction) ?? directions[0] ?? null;
  if (!direction) return { direction: null, pattern_idx: null, patterns: new Set() };
  const variant = direction.patterns.find((p) => p.pattern_idx === choice?.pattern_idx);
  return variant
    ? { direction, pattern_idx: variant.pattern_idx, patterns: new Set([variant.pattern_idx]) }
    : { direction, pattern_idx: null, patterns: new Set(direction.patterns.map((p) => p.pattern_idx)) };
}

/** One line for a view that draws one (the Stops tab, the map's highlight):
 * the variant chosen, else the direction's main pattern. */
export function shownLine(
  r: ResolvedChoice,
  directions: Direction[]
): { direction: Direction; pattern_idx: number } | null {
  const direction = r.direction ?? directions[0];
  if (!direction) return null;
  return { direction, pattern_idx: r.pattern_idx ?? direction.key };
}

/** The patterns the map highlights over the rest of the route, from the
 * drawing's directions (the map has them, not the full Direction); null,
 * none: the route as a whole. On the Stops tab, the one line it draws
 * (`shownPattern`). Elsewhere, the choice: a variant alone, or a whole
 * direction with all its variants — nothing picked yet, the first. */
export function highlightedPatterns(
  choice: ExplorerPatternChoice | null,
  directions: { key: number; patterns: number[] }[],
  stopsTab: boolean
): number[] | null {
  if (stopsTab) {
    const p = shownPattern(choice, directions);
    return p === null ? null : [p];
  }
  const direction = choice ? directions.find((d) => d.key === choice.direction) : directions[0];
  if (!direction) return null;
  return choice?.pattern_idx != null && direction.patterns.includes(choice.pattern_idx)
    ? [choice.pattern_idx]
    : direction.patterns;
}

/** The pattern `shownLine` draws, from the route drawing's directions (the
 * map has them, not the full Direction). */
export function shownPattern(
  choice: ExplorerPatternChoice | null,
  directions: { key: number; patterns: number[] }[]
): number | null {
  const direction = directions.find((d) => d.key === choice?.direction) ?? directions[0];
  if (!direction) return null;
  return choice?.pattern_idx !== null &&
    choice?.pattern_idx !== undefined &&
    direction.patterns.includes(choice.pattern_idx)
    ? choice.pattern_idx
    : direction.key;
}

/** The picker's value for a choice, and back. */
export function choiceValue(r: ResolvedChoice): string {
  return `${r.direction?.key ?? ""}:${r.pattern_idx ?? ""}`;
}

export function choiceFromValue(value: string): ExplorerPatternChoice {
  const [d, p] = value.split(":");
  return { direction: Number(d), pattern_idx: p === "" ? null : Number(p) };
}

/** The directions whose patterns run on any of `shapeIds` (shapes clicked on
 * the map), by key, in the route's order. */
export function directionsOnShapes(
  shapeIds: string[],
  directions: { key: number; patterns: number[] }[],
  patternShapes: Record<number, string[]>
): number[] {
  const hit = new Set(shapeIds);
  return directions
    .filter((d) => d.patterns.some((p) => (patternShapes[p] ?? []).some((s) => hit.has(s))))
    .map((d) => d.key);
}
