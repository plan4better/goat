// The checkerboard every swatch draws its color over (spec 4.6), the panel's CSS swatches and the legend's SVG ones
// alike: a transparent color then looks lighter and shows the squares, whatever the panel's own color (drawn straight
// onto a dark panel it would look darker), and a None color shows the squares alone. Faint, so the squares show only
// once a color is clearly transparent; the same in the light and the dark theme and in print.
import { alphaOf } from "@/lib/style/colors";

/** The checkerboard's two colors and the side of one square in pixels. */
export const CHECKER = { light: "#ffffff", dark: "#ebebeb", square: 4 } as const;

const HEXES = /#(?:[0-9a-f]{8}|[0-9a-f]{6})(?![0-9a-f])/gi;

/** Whether a color or a CSS background (a gradient) holds a hex color that is not opaque. */
export const seeThrough = (background: unknown): boolean =>
  typeof background === "string" && (background.match(HEXES) ?? []).some((c) => (alphaOf(c) ?? 255) < 255);

/** The checkerboard as CSS background layers: two layers of diagonal corners, the second moved by one square, over
 * the light color. */
const corners = `linear-gradient(45deg, ${CHECKER.dark} 25%, transparent 25%, transparent 75%, ${CHECKER.dark} 75%)`;
const tile = `${2 * CHECKER.square}px ${2 * CHECKER.square}px`;
const BOARD = `${corners} 0 0 / ${tile}, ${corners} ${CHECKER.square}px ${CHECKER.square}px / ${tile} ${CHECKER.light}`;

/**
 * A swatch's CSS background: `background` (a color or a gradient) over the checkerboard where it holds a color that is
 * not opaque; as it is where it is opaque, as the checkerboard would not show, or holds no color (the hatch).
 */
export function checkered(background: string): string {
  if (!seeThrough(background)) return background;
  const layer = background.includes("gradient(")
    ? background
    : `linear-gradient(${background}, ${background})`;
  return `${layer}, ${BOARD}`;
}

/** The checkerboard as one SVG pattern tile of two squares a side (`square` pixels each): its size and its rects. */
export function checkerTiles(square: number = CHECKER.square): {
  size: number;
  rects: Array<{ x: number; y: number; width: number; height: number; fill: string }>;
} {
  const size = 2 * square;
  return {
    size,
    rects: [
      { x: 0, y: 0, width: size, height: size, fill: CHECKER.light },
      { x: 0, y: 0, width: square, height: square, fill: CHECKER.dark },
      { x: square, y: square, width: square, height: square, fill: CHECKER.dark },
    ],
  };
}
