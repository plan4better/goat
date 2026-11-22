import { isObject } from "@/lib/style/json";

/** What a render's `band` reads: a band number (1 without one), or a band formula's expression (what the info is
 * asked for, `statsOf`). */
export function bandOrFormula(band: unknown): number | string {
  return formulaOf(band)?.expression ?? (typeof band === "number" ? band : 1);
}

/** A band formula of a style (`render.band`), or null for a band number. */
export function formulaOf(band: unknown): { name: string; expression: string } | null {
  if (!isObject(band) || typeof band.expression !== "string" || !band.expression.trim()) return null;
  return { name: typeof band.name === "string" ? band.name : "", expression: band.expression };
}
