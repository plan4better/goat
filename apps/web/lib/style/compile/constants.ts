// Fixed choices of the compiler that the format leaves to the renderer (spec section 16).

/** Every compiled image is drawn this many px high, so `icon-size` = size / ICON_HEIGHT. */
export const ICON_HEIGHT = 24;
/** Images are rasterized at this pixel ratio, so icons stay sharp up to four times ICON_HEIGHT. */
export const IMAGE_PIXEL_RATIO = 4;

/** Font stacks for `label.font.weight` until GOAT serves its own fonts (section 15): the stacks both default
 * basemap glyph servers have (OpenFreeMap serves only Noto Sans). */
export const FONT_STACKS = { regular: ["Noto Sans Regular"], bold: ["Noto Sans Bold"] } as const;

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
