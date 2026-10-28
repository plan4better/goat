// Draws the marker images compiled layers name (lib/style/compile/markerImage.ts) when the map first needs one: the
// shape in its fill (a hollow marker leaves it clear), the stroke outside it like a circle's, and the icon in the
// shape's head, library icons tinted with the icon color, emoji and uploads in their own colors. One image per name
// and map.
import { defaultResolveIcon } from "@/lib/style/compile/images";
import { type MarkerImage, SQUARE_RADIUS, parseMarkerImage } from "@/lib/style/compile/markerImage";
import type { ImageRequest } from "@/lib/style/compile/types";
import { MARKER_SHAPES } from "@/lib/style/markerShapes";

/** Marker images are drawn at the layer's largest marker size and scaled down, at this pixel ratio. */
const PIXEL_RATIO = 3;

interface MarkerMap {
  hasImage(id: string): boolean;
  addImage(
    id: string,
    image: { width: number; height: number; data: Uint8Array },
    options: { pixelRatio: number }
  ): unknown;
}

/** Where a marker's parts go, in px: the image's side, the shape's box (both square) and its offset in the image, and
 * the icon's side and top left corner, in the shape's head. */
export function markerLayout(spec: MarkerImage): {
  side: number;
  shape: number;
  offset: number;
  icon: number;
  iconX: number;
  iconY: number;
} {
  const stroke = spec.stroke ? spec.strokeWidth : 0;
  const head = MARKER_SHAPES[spec.shape].icon;
  const icon = spec.icon ? spec.size * head.share : 0;
  return {
    side: spec.size + 2 * stroke,
    shape: spec.size,
    offset: stroke,
    icon,
    iconX: stroke + (head.cx / 24) * spec.size - icon / 2,
    iconY: stroke + (head.cy / 24) * spec.size - icon / 2,
  };
}

const icons = new Map<string, Promise<HTMLImageElement | null>>();

function iconImage(url: string): Promise<HTMLImageElement | null> {
  let found = icons.get(url);
  if (!found) {
    found = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    icons.set(url, found);
  }
  return found;
}

/** Strokes (`width` > 0, twice the stroke so its outer half shows) or fills the shape in the box at `x`, `y`; `clear`
 * erases the shape's inside instead of filling it. */
function paintShape(
  context: CanvasRenderingContext2D,
  spec: MarkerImage,
  box: { x: number; y: number; side: number },
  paint: { width: number; color: string; clear?: boolean }
): void {
  if (paint.clear) {
    context.save();
    context.globalCompositeOperation = "destination-out";
    paintShape(context, spec, box, { width: 0, color: "#000000" });
    context.globalCompositeOperation = "source-over";
    context.restore();
    return;
  }
  const { x, y, side } = box;
  const stroke = paint.width > 0;
  if (spec.shape === "circle" || spec.shape === "square") {
    context.beginPath();
    if (spec.shape === "circle") context.arc(x + side / 2, y + side / 2, side / 2, 0, Math.PI * 2);
    else context.roundRect(x, y, side, side, side * SQUARE_RADIUS);
    context.closePath();
    if (stroke) {
      context.lineWidth = paint.width;
      context.strokeStyle = paint.color;
      context.stroke();
    } else {
      context.fillStyle = paint.color;
      context.fill();
    }
    return;
  }
  // The other shapes are paths in a 24 box, scaled to the marker.
  const path = new Path2D(MARKER_SHAPES[spec.shape].path);
  const k = side / 24;
  context.save();
  context.translate(x, y);
  context.scale(k, k);
  if (stroke) {
    context.lineWidth = paint.width / k;
    context.lineJoin = "round";
    context.strokeStyle = paint.color;
    context.stroke(path);
  } else {
    context.fillStyle = paint.color;
    context.fill(path);
  }
  context.restore();
}

/** The icon at `box` (logical px), fitted into it; a library icon in `color`. */
function drawIcon(
  context: CanvasRenderingContext2D,
  img: HTMLImageElement,
  tint: string | null,
  box: { x: number; y: number; side: number }
): void {
  const ratio = (img.naturalWidth || 1) / (img.naturalHeight || 1);
  const w = ratio >= 1 ? box.side : box.side * ratio;
  const h = ratio >= 1 ? box.side / ratio : box.side;
  const x = box.x + (box.side - w) / 2;
  const y = box.y + (box.side - h) / 2;
  if (!tint) {
    context.drawImage(img, x, y, w, h);
    return;
  }
  // Tinted on a canvas of its own, so the shape below keeps its fill.
  const scale = context.getTransform().a;
  const layer = document.createElement("canvas");
  layer.width = Math.ceil(w * scale);
  layer.height = Math.ceil(h * scale);
  const own = layer.getContext("2d");
  if (!own) return;
  own.drawImage(img, 0, 0, layer.width, layer.height);
  own.globalCompositeOperation = "source-in";
  own.fillStyle = tint;
  own.fillRect(0, 0, layer.width, layer.height);
  context.drawImage(layer, x, y, w, h);
}

/** The marker as image data at PIXEL_RATIO; null where there is no canvas or the name is not a marker's. */
export async function drawMarker(
  name: string,
  lookup: (ref: string) => Pick<ImageRequest, "url" | "sdf"> | undefined = () => undefined
): Promise<{ width: number; height: number; data: Uint8Array } | null> {
  const spec = parseMarkerImage(name);
  if (!spec) return null;
  const layout = markerLayout(spec);
  const request = spec.icon ? (lookup(spec.icon) ?? defaultResolveIcon(spec.icon) ?? undefined) : undefined;
  const img = request ? await iconImage(request.url) : null;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(layout.side * PIXEL_RATIO);
  canvas.height = canvas.width;
  const context = canvas.getContext("2d");
  if (!context) return null;
  if (spec.shape !== "circle" && spec.shape !== "square" && typeof Path2D === "undefined") return null;
  context.scale(PIXEL_RATIO, PIXEL_RATIO);
  const box = { x: layout.offset, y: layout.offset, side: layout.shape };
  // The stroke centered on the shape's edge at twice the width; the fill covers its inner half, and a hollow marker
  // erases it, so its stroke lies outside the shape as a filled marker's does.
  const stroked = !!spec.stroke && spec.strokeWidth > 0;
  if (stroked) paintShape(context, spec, box, { width: spec.strokeWidth * 2, color: spec.stroke });
  if (spec.fill) paintShape(context, spec, box, { width: 0, color: spec.fill });
  else if (stroked) paintShape(context, spec, box, { width: 0, color: "", clear: true });
  if (img && request)
    drawIcon(context, img, request.sdf ? spec.iconColor : null, {
      x: layout.iconX,
      y: layout.iconY,
      side: layout.icon,
    });
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: new Uint8Array(data.data.buffer) };
}

const drawing = new WeakMap<object, Set<string>>();

/** Draws the marker image `name` onto the map once. */
export async function addMarkerImage(
  map: MarkerMap,
  name: string,
  lookup: (ref: string) => Pick<ImageRequest, "url" | "sdf"> | undefined
): Promise<void> {
  let pending = drawing.get(map);
  if (!pending) {
    pending = new Set();
    drawing.set(map, pending);
  }
  if (pending.has(name) || map.hasImage(name)) return;
  pending.add(name);
  try {
    const image = await drawMarker(name, lookup);
    if (image && !map.hasImage(name)) map.addImage(name, image, { pixelRatio: PIXEL_RATIO });
  } catch (error) {
    console.debug(`Failed to draw marker image "${name}":`, error);
  } finally {
    pending.delete(name);
  }
}
