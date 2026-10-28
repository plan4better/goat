// Palette ids and lists as colors (spec 1): the catalogue's colors, its variant for a class count, or evenly sampled.
import { PALETTES } from "@/lib/style/generated/catalog";

/** The colors of a palette id or list, in `steps` classes when the palette has that variant. */
export function paletteColors(value: string | string[], steps?: number): string[] {
  if (Array.isArray(value)) return value;
  const palette = PALETTES[value];
  if (!palette) return [];
  return [...((steps && palette.variants?.[steps]) || palette.colors)];
}

/** Exactly `count` colors of a palette: its variant for that count, else colors sampled evenly along it. */
export function paletteSteps(value: string | string[], count: number): string[] {
  const colors = paletteColors(value, count);
  if (colors.length === count || colors.length === 0) return colors;
  if (count === 1) return [colors[0]];
  return Array.from({ length: count }, (_, i) => colors[Math.round((i * (colors.length - 1)) / (count - 1))]);
}
