// Draws the fill pattern images compiled layers name (lib/style/compile/patternImage.ts) when the map first needs one:
// one tile, lines stroked or dots filled in the pattern's color on a clear ground. One image per name and map.
import { parsePatternImage, patternTile } from "@/lib/style/compile/patternImage";

/** Pattern tiles are drawn at this pixel ratio: sharp on high density screens, whole pixels at any tile size. */
const PIXEL_RATIO = 2;

interface PatternMap {
  hasImage(id: string): boolean;
  addImage(
    id: string,
    image: { width: number; height: number; data: Uint8Array },
    options: { pixelRatio: number }
  ): unknown;
}

/** The tile of pattern image `name` as pixels; null for a name that is no pattern or without a canvas. */
export function drawPattern(name: string): { width: number; height: number; data: Uint8Array } | null {
  const spec = parsePatternImage(name);
  if (!spec) return null;
  const tile = patternTile(spec.kind, spec.spacing, spec.width);
  const canvas = document.createElement("canvas");
  canvas.width = tile.size * PIXEL_RATIO;
  canvas.height = tile.size * PIXEL_RATIO;
  const context = canvas.getContext("2d");
  if (!context || typeof Path2D === "undefined") return null;
  context.scale(PIXEL_RATIO, PIXEL_RATIO);
  const path = new Path2D(tile.path);
  if (tile.dots) {
    context.fillStyle = spec.color;
    context.fill(path);
  } else {
    context.strokeStyle = spec.color;
    context.lineWidth = spec.width;
    context.stroke(path);
  }
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: new Uint8Array(data.data.buffer) };
}

/** Draws the pattern image `name` onto the map once. */
export function addPatternImage(map: PatternMap, name: string): void {
  if (map.hasImage(name)) return;
  try {
    const image = drawPattern(name);
    if (image) map.addImage(name, image, { pixelRatio: PIXEL_RATIO });
  } catch (error) {
    console.debug(`Failed to draw pattern image "${name}":`, error);
  }
}
