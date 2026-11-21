// A raster coloring as the tile URL carries it (`?style=<token>`): base64url of its canonical JSON (keys sorted),
// decoded by goatlib.raster.token. The same coloring always gives the same URL, so tiles stay cached.
import type { RasterColorSpec } from "@/lib/style/raster/color";

/** Tokens longer than this are not sent: proxies refuse request lines over about 8 KB. */
export const MAX_TOKEN_LENGTH = 6144;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    );
  return value;
}

export function rasterToken(spec: RasterColorSpec): string {
  const json = JSON.stringify(canonical({ ...spec, v: 1 }));
  // The coloring is ASCII (numbers, hex colors, a formula), so btoa needs no UTF-8 step.
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
