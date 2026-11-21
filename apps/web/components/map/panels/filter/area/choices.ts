// The area's pieces as the fetch dialog and the catalog's location filter keep them: each piece one choice of the kinds
// they kept before an area had pieces (regions by their ids, a point with its radius, a polygon's corners, the map view
// as a box), so a choice saved then reads back as one piece. Regions are kept by id: their outlines are loaded again
// when a choice is read.
import { useMemo } from "react";

import type { CatalogSpatialFilter } from "@/lib/catalog/spatial";
import {
  type AreaFeature,
  type AreaPiece,
  type FilterArea,
  type PolygonCoords,
  type Position,
  geometryPolygons,
  roundPolygons,
  viewPolygon,
} from "@/lib/filter/area";

import { useCatalogNutsGeometries } from "@/hooks/catalog/useCatalogNutsGeometries";

import { REGION_SOURCE, circlePiece } from "@/components/map/panels/filter/area/pieces";

/** West, south, east, north. */
export type Bbox = [number, number, number, number];

export type AreaChoice = CatalogSpatialFilter | { kind: "view"; bbox: Bbox };

/** A region's outline and name as they were loaded. */
type Loaded = Record<string, { geometry?: unknown; name?: string }>;

/** One piece as the choice that keeps it; null for one that no choice says (a shape of several polygons or with holes,
 * features of a layer, a map view without its box). */
export function choiceOf(piece: AreaPiece, viewBox?: Bbox): AreaChoice | null {
  if (piece.kind === "view") return viewBox ? { kind: "view", bbox: viewBox } : null;
  if (piece.kind === "features") {
    if (piece.source !== REGION_SOURCE) return null;
    const names = Object.fromEntries(piece.features.flatMap((f) => (f.name ? [[f.id, f.name]] : [])));
    return { kind: "region", nutsIds: piece.features.map((f) => f.id), names };
  }
  if (piece.center && piece.km !== undefined) {
    const [lng, lat] = piece.center;
    return {
      kind: "point",
      lng,
      lat,
      km: piece.km,
      ...(piece.label !== undefined && { label: piece.label }),
    };
  }
  const [polygon, ...more] = piece.polygons;
  if (!polygon || more.length || polygon.length !== 1) return null;
  // A choice keeps the corners; the ring is closed again when it is read.
  return { kind: "polygon", ring: polygon[0].slice(0, -1) };
}

/** Every piece as a choice; null when one of them is none. */
export function choicesOf(area: FilterArea, viewBox?: Bbox): AreaChoice[] | null {
  const choices = area.pieces.map((piece) => choiceOf(piece, viewBox));
  return choices.some((choice) => choice === null) ? null : (choices as AreaChoice[]);
}

/** A choice as a piece; regions need their outlines, null while one of them is missing. `byId`: regions are kept by
 * their ids alone (the catalog filters by them), so one without an outline stays, with no polygons. */
export function pieceOf(choice: AreaChoice, loaded: Loaded, byId = false): AreaPiece | null {
  switch (choice.kind) {
    case "view":
      return { kind: "view", polygons: [viewPolygon(choice.bbox)] };
    case "point":
      return circlePiece([choice.lng, choice.lat], choice.km, choice.label);
    case "polygon": {
      const ring: Position[] = [...choice.ring, choice.ring[0]];
      return { kind: "shape", shape: "polygon", polygons: [[ring]] };
    }
    case "region": {
      const features: AreaFeature[] = [];
      const polygons: PolygonCoords[] = [];
      for (const id of choice.nutsIds) {
        const outline = geometryPolygons(loaded[id]?.geometry) ?? [];
        if (!outline.length && !byId) return null;
        const name = choice.names?.[id] ?? loaded[id]?.name;
        features.push({ id, ...(name && { name }), n: outline.length });
        polygons.push(...roundPolygons(outline));
      }
      return { kind: "features", source: REGION_SOURCE, features, polygons };
    }
  }
}

/** The regions the choices name, each once. */
export const regionsOf = (choices: readonly AreaChoice[]): string[] => [
  ...new Set(choices.flatMap((choice) => (choice.kind === "region" ? choice.nutsIds : []))),
];

/** The pieces of saved choices, once the outlines of their regions have loaded; `failed` when one of them did not.
 * `byId` as for `pieceOf`. */
export function useChoicePieces(
  choices: readonly AreaChoice[] | undefined,
  byId = false
): {
  pieces?: AreaPiece[];
  failed: boolean;
} {
  const ids = useMemo(() => (choices ? regionsOf(choices) : []), [choices]);
  const { shapes } = useCatalogNutsGeometries(ids);
  return useMemo(() => {
    if (!choices || !ids.every((id) => id in shapes)) return { failed: false };
    const pieces = choices.map((choice) => pieceOf(choice, shapes, byId));
    return pieces.every((piece) => piece !== null) ? { pieces, failed: false } : { failed: true };
  }, [choices, ids, shapes, byId]);
}

/** The pieces new in `next`. */
const fresh = (next: FilterArea, prev: FilterArea | undefined) =>
  next.pieces.filter((piece) => !prev?.pieces.includes(piece));

/** The fetch's map view follows the map, so it does not mix with pieces that stay where they are: a new map view
 * replaces the other pieces, a new piece of another kind drops the map view. */
export function viewApart(
  next: FilterArea | undefined,
  prev: FilterArea | undefined
): FilterArea | undefined {
  if (!next) return next;
  const added = fresh(next, prev);
  if (added.some((piece) => piece.kind === "view"))
    return { ...next, pieces: added.filter((piece) => piece.kind === "view") };
  if (added.length && next.pieces.some((piece) => piece.kind === "view"))
    return { ...next, pieces: next.pieces.filter((piece) => piece.kind !== "view") };
  return next;
}

/** The catalog filters by one kind of area (regions, or a point, or a polygon): the newest piece replaces the others. A
 * region picked joins the regions' one piece, which then is the newest. */
export function newestAlone(
  next: FilterArea | undefined,
  prev: FilterArea | undefined
): FilterArea | undefined {
  if (!next) return next;
  const added = fresh(next, prev);
  return added.length ? { ...next, pieces: [added[added.length - 1]] } : next;
}
