// Fixed choices of the compiler that the format leaves to the renderer (spec section 16).

/** Every compiled image is drawn this many px high, so `icon-size` = size / ICON_HEIGHT. */
export const ICON_HEIGHT = 24;
/** Images are rasterized at this pixel ratio, so icons stay sharp up to four times ICON_HEIGHT. */
export const IMAGE_PIXEL_RATIO = 4;

/** Font stacks for `label.font.weight` and `label.font.style` (section 15), one font each: a static glyph host serves
 * no combined stack. The basemaps' glyph servers (OpenFreeMap, basemap.de) serve Noto Sans Regular, Bold and Italic;
 * the other five are GOAT's own, which every map loads from the app (lib/utils/map/glyphs.ts). */
export const FONT_STACKS = {
  light: { normal: ["Noto Sans Light"], italic: ["Noto Sans Light Italic"] },
  regular: { normal: ["Noto Sans Regular"], italic: ["Noto Sans Italic"] },
  medium: { normal: ["Noto Sans Medium"], italic: ["Noto Sans Medium Italic"] },
  bold: { normal: ["Noto Sans Bold"], italic: ["Noto Sans Bold Italic"] },
} as const;

/** The stack of a weight and a style; regular and upright for anything else. */
export function fontStack(weight: unknown, style: unknown): readonly string[] {
  const stacks = FONT_STACKS[weight as keyof typeof FONT_STACKS] ?? FONT_STACKS.regular;
  return style === "italic" ? stacks.italic : stacks.normal;
}

/** `line-dasharray` per dash, in line widths. */
export const DASHES: Record<string, number[]> = {
  solid: [1, 0],
  dashed: [2, 2],
  dotted: [0.5, 2],
  dash_dot: [3, 2, 0.5, 2],
};

/** GOAT's highlight of the active and hovered feature. */
export const HIGHLIGHT = { color: "#ffc300", width: 3 } as const;

/** The vector tile source's maxzoom when the caller gives none; tiles are overscaled above it. */
export const TILE_MAXZOOM = 14;
