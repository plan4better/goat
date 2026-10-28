// A point marker with a shape (spec 3.3: a shape or a pin from lib/style/markerShapes.ts, its stroke, an icon on it) is
// one image, so overlapping
// points stack as whole markers. The compiler names the image after what it shows; the renderer draws each name once
// (lib/style/render/markerImages.ts). A name is `goat-marker:` and the parts below, joined by `|`.
import { MARKER_SHAPES, type MarkerShapeId } from "@/lib/style/markerShapes";

export const MARKER_IMAGE = "goat-marker:";

/** An icon on a shape is this share of the shape's side. */
export const ICON_SHARE = 0.6;
/** A square's corners are rounded by this share of its side. */
export const SQUARE_RADIUS = 0.2;

export interface MarkerImage {
  shape: MarkerShapeId;
  /** The shape's side or diameter in px, without the stroke. */
  size: number;
  /** An icon reference, or "" for none. */
  icon: string;
  /** The fill color, or "" for a hollow marker (spec 3.3 `fill: false`). */
  fill: string;
  /** The stroke's color, or "" for none. */
  stroke: string;
  strokeWidth: number;
  /** The tint of a library icon; icons with their own colors ignore it. */
  iconColor: string;
}

export const isMarkerImage = (name: string): boolean => name.startsWith(MARKER_IMAGE);

/** The parts of a marker image name; null for any other image or a name with parts missing. */
export function parseMarkerImage(name: string): MarkerImage | null {
  if (!isMarkerImage(name)) return null;
  const parts = name.slice(MARKER_IMAGE.length).split("|");
  if (parts.length !== 7) return null;
  const [shape, size, icon, fill, stroke, width, iconColor] = parts;
  if (!(shape in MARKER_SHAPES)) return null;
  const px = Number(size);
  if (!(px > 0)) return null;
  const strokeWidth = Number(width);
  return {
    shape: shape as MarkerShapeId,
    size: px,
    icon,
    fill,
    stroke,
    strokeWidth: Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth : 0,
    iconColor,
  };
}
