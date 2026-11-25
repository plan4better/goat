// A palette's colors as a list to edit (spec "Palettes": a catalogue id or an inline list of 2 to 12 colors): the
// colors in the order they draw, and the edits that keep the list within those bounds. The first edit of a catalogue
// palette writes the list as an inline palette, Reverse folded into its order.
import { paletteColors, paletteSteps } from "@/lib/style/palettes";

/** The fewest and most colors of an inline palette. */
export const PALETTE_MIN = 2;
export const PALETTE_MAX = 12;

const clamp = (n: number) => Math.min(PALETTE_MAX, Math.max(PALETTE_MIN, n));

/** The colors a palette's list shows, as they draw: an inline palette as written, a catalogue palette in as many
 * colors as the classes it colors (`steps`: its variant for that many, else blended) or its own colors; reversed where
 * `reverse` says so; 2 to 12 of them. */
export function paletteList(
  value: string | string[],
  { reverse = false, steps }: { reverse?: boolean; steps?: number } = {}
): string[] {
  if (Array.isArray(value)) {
    const own = value.slice(0, PALETTE_MAX);
    return reverse ? own.reverse() : own;
  }
  return paletteSteps(value, clamp(steps ?? paletteColors(value).length), { reverse });
}

export const recolor = (list: string[], i: number, hex: string): string[] =>
  list.map((c, k) => (k === i ? hex : c));

/** A copy of color `i` after it, up to 12 colors. */
export const addColorAfter = (list: string[], i: number): string[] =>
  list.length >= PALETTE_MAX ? list : [...list.slice(0, i + 1), list[i], ...list.slice(i + 1)];

/** The list without color `i`, down to `min` colors (2, or as many as a classification has classes). */
export const removeColor = (list: string[], i: number, min = PALETTE_MIN): string[] =>
  list.length <= Math.max(PALETTE_MIN, min) ? list : list.filter((_, k) => k !== i);

/** The list with color `from` moved to place `to`. */
export function moveColor(list: string[], from: number, to: number): string[] {
  if (from === to) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
