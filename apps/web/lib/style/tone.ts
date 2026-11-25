// Whether the basemap a layer draws on is light or dark (its tone), for the automatic colors of a layer style (spec
// 18.10, "chosen together for the basemap"): the built-in Dark and Satellite basemaps are dark, every other built-in
// light; a solid basemap and a custom vector basemap with a known background go by that color's luminance; a custom
// image basemap and anything unknown are light. The 3D scene has its own tone (`toneOf` in `lib/scene/auto.ts`), in
// which imagery follows the app theme: a sky and fog around a picture of the ground may follow the panel, but a label
// drawn onto the picture needs the contrast of a dark ground whatever the theme, and a custom image is unknown, so it
// counts as the default light.
import type { StyleSpecification } from "maplibre-gl";

import { BASEMAPS } from "@/lib/constants/basemaps";

export type Tone = "light" | "dark";

/** What the tone and imagery rules read of a basemap. */
export interface BasemapLook {
  value?: string;
  source: string;
  type: string;
  /** A solid basemap's color. */
  color?: string;
  /** A custom vector basemap's `background` layer color. */
  backgroundColor?: string;
}

/** WCAG relative luminance of a hex color, 0 (black) to 1 (white); null for anything else. */
export function basemapLuminance(color: string | undefined): number | null {
  const m = /^#([0-9a-f]{6})/i.exec(color ?? "");
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Below this relative luminance a basemap's color counts as dark. */
export const DARK_BELOW = 0.35;

/** The built-in basemaps that count as dark. */
const DARK_BUILT_INS = new Set(["dark", "satellite"]);

/** The tone a layer's automatic colors take on `basemap`; light where nothing is known. */
export function basemapTone(basemap: BasemapLook | null | undefined): Tone {
  if (!basemap) return "light";
  if (basemap.source === "builtin") return DARK_BUILT_INS.has(basemap.value ?? "") ? "dark" : "light";
  const color =
    basemap.type === "solid"
      ? basemap.color
      : basemap.type === "vector"
        ? basemap.backgroundColor
        : undefined;
  const lum = basemapLuminance(color);
  return lum !== null && lum < DARK_BELOW ? "dark" : "light";
}

/**
 * The basemap a map style draws, where only the style is known (a print map's locked basemap): a built-in by its URL,
 * another URL as a custom vector basemap, a style of one background layer as a solid basemap in its color, any other
 * style as an image basemap; null for none.
 */
export function lookOfMapStyle(style: string | StyleSpecification | null | undefined): BasemapLook | null {
  if (!style) return null;
  if (typeof style === "string") {
    const builtIn = BASEMAPS.find((b) => b.url === style);
    return builtIn
      ? { source: "builtin", type: builtIn.type, value: builtIn.value }
      : { source: "custom", type: "vector" };
  }
  const [only, ...rest] = style.layers ?? [];
  if (only?.type === "background" && !rest.length) {
    const color = only.paint?.["background-color"];
    return { source: "custom", type: "solid", color: typeof color === "string" ? color : undefined };
  }
  return { source: "custom", type: "raster" };
}
