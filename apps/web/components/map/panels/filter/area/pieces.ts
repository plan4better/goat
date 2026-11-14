// The area's pieces as the picker changes them, and what the area's row says of them. Nothing here reads the map or
// the area's host: a piece comes in, the next area goes out.
import circle from "@turf/circle";

import { DEFAULT_BUFFER_KM } from "@/lib/catalog/spatial";
import type { AreaFeature, AreaPiece, FilterArea, PolygonCoords, Position } from "@/lib/filter/area";
import { roundPolygons, viewPolygon } from "@/lib/filter/area";

/** West, south, east, north. */
export type Bounds = [number, number, number, number];

/** The source of the features picked from the administrative regions; any other source is a layer. */
export const REGION_SOURCE = "region";

/** How far the map may be off a map view piece before it counts as moved, as a share of the view's width. */
const STALE_SHARE = 0.01;

type Translate = (key: string, options?: Record<string, unknown>) => string;

type FeaturesPiece = Extract<AreaPiece, { kind: "features" }>;
type ShapePiece = Extract<AreaPiece, { kind: "shape" }>;

/** Enough sides that a circle reads as one at any zoom it is looked at. */
const CIRCLE_STEPS = 64;

export const viewPiece = (area: FilterArea | undefined) => area?.pieces.find((p) => p.kind === "view");

export const featuresPiece = (area: FilterArea | undefined, source: string): FeaturesPiece | undefined =>
  area?.pieces.find((p): p is FeaturesPiece => p.kind === "features" && p.source === source);

function boxOf(polygons: PolygonCoords[]): Bounds | null {
  const ring = polygons[0]?.[0];
  if (!ring?.length) return null;
  const box: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  return box;
}

/** Whether the map has moved off a map view piece: an edge is off by more than a hundredth of the view's width. */
export function viewStale(polygons: PolygonCoords[], bounds: Bounds): boolean {
  const was = boxOf(polygons);
  // The view as a piece would hold it, so a view wider than the world compares as it was saved.
  const now = boxOf([viewPolygon(bounds)]);
  if (!was || !now) return false;
  const tolerance = (now[2] - now[0]) * STALE_SHARE;
  return was.some((edge, i) => Math.abs(edge - now[i]) > tolerance);
}

/** The map view as a piece. */
export const viewPieceOf = (bounds: Bounds): AreaPiece => ({ kind: "view", polygons: [viewPolygon(bounds)] });

/** A circle around `center` with a radius of `km`, which it keeps so the radius can be changed. */
export function circlePiece(center: Position, km: number = DEFAULT_BUFFER_KM, label?: string): ShapePiece {
  const ring = circle(center, km, { steps: CIRCLE_STEPS, units: "kilometers" }).geometry.coordinates;
  return {
    kind: "shape",
    shape: "circle",
    center,
    km,
    ...(label !== undefined && { label }),
    polygons: roundPolygons([ring]),
  };
}

/** The area with the circle at `index` at another radius around the same centre. */
export function withRadius(area: FilterArea, index: number, km: number): FilterArea {
  const piece = area.pieces[index];
  if (piece?.kind !== "shape" || !piece.center) return area;
  const next = circlePiece(piece.center, km, piece.label);
  return { ...area, pieces: area.pieces.map((p, i) => (i === index ? next : p)) };
}

/** The area with one more piece: a new area starts inside and switched on, a map view replaces the one there is, a
 * shape goes right after the other shapes (the list and the summary keep them together). */
export function withPiece(area: FilterArea | undefined, piece: AreaPiece): FilterArea {
  if (!area) return { pieces: [piece], op: "inside", enabled: true };
  const pieces = area.pieces.slice();
  if (piece.kind === "view") {
    const at = pieces.findIndex((p) => p.kind === "view");
    pieces.splice(at >= 0 ? at : pieces.length, at >= 0 ? 1 : 0, piece);
  } else if (piece.kind === "shape") {
    const last = pieces.map((p) => p.kind).lastIndexOf("shape");
    pieces.splice(last >= 0 ? last + 1 : pieces.length, 0, piece);
  } else pieces.push(piece);
  return { ...area, pieces };
}

/** Whether a piece can be changed on the map: a drawn polygon's corners, a circle around a point's centre. A circle kept
 * as its ring alone (the filter's) would stop being one if its corners moved; a map view, picked features and a shape a
 * saved filter does not name have no corners someone drew. */
export const editable = (piece: AreaPiece): boolean =>
  piece.kind === "shape" && (!!piece.center || piece.shape === "polygon");

/** The area with `next` where `piece` is, the other pieces as they were; the same area once `piece` is not in it. */
export function withReplaced(area: FilterArea, piece: AreaPiece, next: AreaPiece): FilterArea {
  const at = area.pieces.indexOf(piece);
  if (at < 0) return area;
  return { ...area, pieces: area.pieces.map((p, i) => (i === at ? next : p)) };
}

/** The area without the piece at `index`; no area once its last piece is gone. */
export function withoutPiece(area: FilterArea, index: number): FilterArea | undefined {
  const pieces = area.pieces.filter((_, i) => i !== index);
  return pieces.length ? { ...area, pieces } : undefined;
}

/** The area with one more picked feature in its source's piece; the same area when the feature is in already. */
export function withFeature(
  area: FilterArea | undefined,
  source: string,
  feature: AreaFeature,
  polygons: PolygonCoords[]
): FilterArea {
  const piece = featuresPiece(area, source);
  if (!area || !piece) return withPiece(area, { kind: "features", source, features: [feature], polygons });
  if (piece.features.some((f) => f.id === feature.id)) return area;
  const next: FeaturesPiece = {
    ...piece,
    features: [...piece.features, feature],
    polygons: [...piece.polygons, ...polygons],
  };
  return { ...area, pieces: area.pieces.map((p) => (p === piece ? next : p)) };
}

/** The area without a picked feature and its polygons; its piece goes with its last feature. */
export function withoutFeature(
  area: FilterArea | undefined,
  source: string,
  id: string
): FilterArea | undefined {
  const piece = featuresPiece(area, source);
  if (!area || !piece) return area;
  const at = piece.features.findIndex((f) => f.id === id);
  if (at < 0) return area;
  if (piece.features.length === 1) return withoutPiece(area, area.pieces.indexOf(piece));
  // The polygons are in the features' order, each feature's `n` of them.
  const before = piece.features.slice(0, at).reduce((n, f) => n + f.n, 0);
  const next: FeaturesPiece = {
    ...piece,
    features: piece.features.filter((_, i) => i !== at),
    polygons: piece.polygons.filter((_, i) => i < before || i >= before + piece.features[at].n),
  };
  return { ...area, pieces: area.pieces.map((p) => (p === piece ? next : p)) };
}

const shapeName = (piece: Extract<AreaPiece, { kind: "shape" }>, t: Translate) =>
  piece.label || t(piece.shape ? `filter_panel.area_shape_${piece.shape}` : "filter_panel.area_shape");

const featuresName = (piece: FeaturesPiece, t: Translate) => {
  const [only] = piece.features;
  if (piece.features.length === 1 && only.name) return only.name;
  const count = piece.features.length;
  return t(piece.source === REGION_SOURCE ? "filter_panel.area_regions" : "filter_panel.area_features", {
    count,
  });
};

/** What one piece is, as the picker lists it. */
export function pieceName(piece: AreaPiece, t: Translate): string {
  if (piece.kind === "view") return t("filter_panel.area_view");
  return piece.kind === "shape" ? shapeName(piece, t) : featuresName(piece, t);
}

/** The area in a line: its pieces in their order, the shapes as one where the first is, "outside" said before. */
export function areaSummary(area: FilterArea, t: Translate): string {
  const shapes = area.pieces.filter((p) => p.kind === "shape");
  const parts: string[] = [];
  let counted = false;
  for (const piece of area.pieces) {
    if (piece.kind !== "shape" || shapes.length === 1) parts.push(pieceName(piece, t));
    else if (!counted) {
      counted = true;
      parts.push(t("filter_panel.area_shapes", { count: shapes.length }));
    }
  }
  const said = parts.join(", ");
  // The names are the user's own and go into the page as text: nothing to escape.
  return area.op === "outside"
    ? t("filter_panel.area_outside_of", { area: said, interpolation: { escapeValue: false } })
    : said;
}
