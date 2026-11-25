import type { RequestParameters } from "maplibre-gl";

import ranges from "./glyphRanges.json";

// GOAT's own label fonts: the Noto Sans weights and italics the basemaps' glyph servers do not serve, built by
// scripts/build-glyphs.mjs into public/glyphs. A map keeps its style's glyphs URL for every font the server has;
// MAPLIBRE_MAP_OPTIONS routes a request for one of these stacks to the app's files instead, from any style's glyphs
// URL, so the basemap's own fonts stay as they are.

/** Where the app serves the own stacks' glyph ranges. */
export const GLYPHS_PATH = "/glyphs";

/** The own stacks, as a style names them in `text-font`: their directory under GLYPHS_PATH, and the stack the
 * basemaps' glyph servers serve that stands in for a range the font has no glyph in (another script). */
export const OWN_FONT_STACKS: Record<string, { dir: string; fallback: string }> = {
  "Noto Sans Light": { dir: "noto-sans-light", fallback: "Noto Sans Regular" },
  "Noto Sans Light Italic": { dir: "noto-sans-light-italic", fallback: "Noto Sans Regular" },
  "Noto Sans Medium": { dir: "noto-sans-medium", fallback: "Noto Sans Regular" },
  "Noto Sans Medium Italic": { dir: "noto-sans-medium-italic", fallback: "Noto Sans Regular" },
  "Noto Sans Bold Italic": { dir: "noto-sans-bold-italic", fallback: "Noto Sans Bold" },
};

/** The first codepoint of each range of 256 each own stack has files for. */
export const OWN_GLYPH_RANGES: Record<string, number[]> = ranges;

/** The stack and range at the end of a glyph URL's path: `.../{fontstack}/{start}-{end}.pbf`. */
const GLYPH_PATH = /\/([^/?#]+)\/(\d+)-(\d+)\.pbf(?=[?#]|$)/;

/** MapLibre's `transformRequest`: a glyph range of an own stack comes from the app's files, or, for a range the font
 * has no glyph in, from the map's glyph server in the stack standing in for it. Anything else is left as it is. */
export function ownGlyphsRequest(url: string, resourceType?: string): RequestParameters | undefined {
  if (resourceType !== "Glyphs") return undefined;
  const match = GLYPH_PATH.exec(url);
  if (!match) return undefined;
  let stack: string;
  try {
    stack = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  const own = OWN_FONT_STACKS[stack];
  if (!own) return undefined;
  const [start, end] = [match[2], match[3]];
  if (!OWN_GLYPH_RANGES[stack]?.includes(Number(start))) {
    const at = match.index + 1;
    return {
      url: `${url.slice(0, at)}${encodeURIComponent(own.fallback)}${url.slice(at + match[1].length)}`,
    };
  }
  const origin = typeof location === "undefined" ? "" : location.origin;
  return { url: `${origin}${GLYPHS_PATH}/${own.dir}/${start}-${end}.pbf` };
}
