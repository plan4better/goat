// The filter's area: where the features have to be (or must not be), next to the conditions on their fields. It is made
// of pieces (the map view, drawn shapes, features picked from regions or other layers); a feature is in the area when
// it touches any piece. In the saved CQL the area is one `s_intersects` on all the pieces' polygons, under `not` for
// outside. Which polygons belong to which piece is not in the CQL: the notes say it, and they count only as long as
// they still describe the geometry that is saved.
import { type JsonObject, isObject } from "@/lib/style/json";

export type Position = [number, number];
/** One polygon: its rings, the outer one first. */
export type PolygonCoords = Position[][];

/** A picked feature: its id in its source, the name the picker showed and how many polygons it brought. */
export interface AreaFeature {
  id: string;
  name?: string;
  n: number;
}

export type AreaPiece =
  /** `center` and `km`: a circle around a point, kept so its radius can be changed (the fetch dialog, the catalog);
   * the filter saves neither. */
  | {
      kind: "shape";
      polygons: PolygonCoords[];
      shape?: "polygon" | "circle";
      label?: string;
      center?: Position;
      km?: number;
    }
  | { kind: "view"; polygons: PolygonCoords[] }
  /** `source`: the layer the features are of, or "region" for administrative regions. */
  | { kind: "features"; polygons: PolygonCoords[]; source: string; features: AreaFeature[] };

export interface FilterArea {
  pieces: AreaPiece[];
  op: "inside" | "outside";
  enabled: boolean;
  /** The geometry field the saved filter names, when it is not `geom`. */
  property?: string;
}

/** A piece as the notes hold it: without its polygons, `n` saying how many of the geometry's are its own. */
export type AreaPieceNote =
  | { kind: "shape"; n: number; shape?: "polygon" | "circle"; label?: string }
  | { kind: "view"; n: number }
  | { kind: "features"; source: string; features: AreaFeature[] };

export interface AreaNotes {
  pieces: AreaPieceNote[];
  /** The sum of the geometry the pieces describe. */
  sum: string;
  /** A switched-off area's CQL, as it would be written. */
  off?: JsonObject;
}

const GEOMETRY_FIELD = "geom";
const DECIMALS = 1e6;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isPosition = (v: unknown): boolean => Array.isArray(v) && isNumber(v[0]) && isNumber(v[1]);

const isPolygon = (v: unknown): v is PolygonCoords =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(isPosition));

/** An envelope as the polygon the server makes of it. */
function envelope(bbox: unknown[]): PolygonCoords | null {
  const box = bbox.length === 6 ? [bbox[0], bbox[1], bbox[3], bbox[4]] : bbox;
  if (box.length !== 4 || !box.every(isNumber)) return null;
  const [w, s, e, n] = box as number[];
  return [
    [
      [w, s],
      [w, n],
      [e, n],
      [e, s],
      [w, s],
    ],
  ];
}

/** The polygons of a geometry an area can be: a polygon, a multipolygon or an envelope. Null for any other. */
export function geometryPolygons(geometry: unknown): PolygonCoords[] | null {
  if (!isObject(geometry)) return null;
  const { type, coordinates, bbox } = geometry;
  if (type === "Polygon") return isPolygon(coordinates) ? [coordinates] : null;
  if (type === "MultiPolygon") {
    return Array.isArray(coordinates) && coordinates.length > 0 && coordinates.every(isPolygon)
      ? (coordinates as PolygonCoords[])
      : null;
  }
  if (Object.keys(geometry).length === 1 && Array.isArray(bbox)) {
    const polygon = envelope(bbox);
    return polygon && [polygon];
  }
  return null;
}

export const areaPolygons = (area: FilterArea): PolygonCoords[] => area.pieces.flatMap((p) => p.polygons);

/** Every piece's polygons as one geometry; null without a polygon. */
export function areaGeometry(area: FilterArea): JsonObject | null {
  const polygons = areaPolygons(area);
  if (!polygons.length) return null;
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}

/** The positions of every ring: what the points limit counts. */
export const pointCount = (polygons: PolygonCoords[]): number =>
  polygons.reduce((sum, polygon) => sum + polygon.reduce((n, ring) => n + ring.length, 0), 0);

export const shapeCount = (area: FilterArea): number => area.pieces.filter((p) => p.kind === "shape").length;

export const featureCount = (area: FilterArea): number =>
  area.pieces.reduce((n, p) => (p.kind === "features" ? n + p.features.length : n), 0);

/** A short sum of the coordinates (FNV-1a): tells whether notes still describe the saved geometry. */
export function areaSum(polygons: PolygonCoords[]): string {
  const text = JSON.stringify(polygons);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The area's CQL: nothing without a polygon. */
export function areaCql(area: FilterArea): JsonObject | undefined {
  const geometry = areaGeometry(area);
  if (!geometry) return undefined;
  const inside = { op: "s_intersects", args: [{ property: area.property ?? GEOMETRY_FIELD }, geometry] };
  return area.op === "outside" ? { op: "not", args: [inside] } : inside;
}

interface AreaNode {
  property: string;
  geometry: JsonObject;
  polygons: PolygonCoords[];
  outside: boolean;
}

function intersects(node: unknown): Omit<AreaNode, "outside"> | null {
  if (!isObject(node) || node.op !== "s_intersects" || !Array.isArray(node.args) || node.args.length !== 2) {
    return null;
  }
  const [field, geometry] = node.args;
  if (!isObject(field) || typeof field.property !== "string") return null;
  const polygons = geometryPolygons(geometry);
  return polygons && { property: field.property, geometry: geometry as JsonObject, polygons };
}

function areaNode(node: unknown): AreaNode | null {
  if (isObject(node) && node.op === "not") {
    const inner = Array.isArray(node.args) && node.args.length === 1 ? intersects(node.args[0]) : null;
    return inner && { ...inner, outside: true };
  }
  const inside = intersects(node);
  return inside && { ...inside, outside: false };
}

/** A condition the area says: `s_intersects` of a field and polygons, or `not` of exactly that. */
export const isAreaNode = (node: unknown): node is JsonObject => areaNode(node) !== null;

const polygonsOf = (note: AreaPieceNote): number =>
  note.kind === "features" ? note.features.reduce((n, f) => n + f.n, 0) : note.n;

/** The pieces the notes describe, each with its share of the polygons; null when they describe another geometry. */
function notedPieces(polygons: PolygonCoords[], notes: AreaNotes | undefined): AreaPiece[] | null {
  if (!notes || notes.sum !== areaSum(polygons)) return null;
  if (notes.pieces.reduce((n, p) => n + polygonsOf(p), 0) !== polygons.length) return null;
  let at = 0;
  return notes.pieces.map((note) => {
    const own = polygons.slice(at, (at += polygonsOf(note)));
    if (note.kind === "features") return { ...note, polygons: own };
    const { n: _n, ...piece } = note;
    return { ...piece, polygons: own };
  });
}

/** A geometry nothing describes as one piece: the map view for the extent older panels saved, a shape otherwise. */
function onePiece(polygons: PolygonCoords[], geometry: JsonObject): AreaPiece {
  const properties = isObject(geometry.properties) ? geometry.properties : {};
  if (properties.type === "bbox") return { kind: "view", polygons };
  const label = typeof properties.label === "string" && properties.label ? properties.label : undefined;
  return { kind: "shape", polygons, ...(label && { label }) };
}

/** The area an area node says, in the pieces its notes describe. Nothing for any other node. */
export function readArea(
  node: unknown,
  notes: AreaNotes | undefined,
  enabled: boolean
): FilterArea | undefined {
  const read = areaNode(node);
  if (!read) return undefined;
  return {
    pieces: notedPieces(read.polygons, notes) ?? [onePiece(read.polygons, read.geometry)],
    op: read.outside ? "outside" : "inside",
    enabled,
    ...(read.property !== GEOMETRY_FIELD && { property: read.property }),
  };
}

/** The sum of the pieces already written: an edit to the conditions writes the filter again with the same pieces. */
const sums = new WeakMap<AreaPiece[], string>();

function piecesSum(area: FilterArea): string {
  let sum = sums.get(area.pieces);
  if (sum === undefined) sums.set(area.pieces, (sum = areaSum(areaPolygons(area))));
  return sum;
}

/** What the notes keep of a piece: its kind, which polygons are its own and what it is called. */
function pieceNote(piece: AreaPiece): AreaPieceNote {
  const n = piece.polygons.length;
  if (piece.kind === "features") return { kind: "features", source: piece.source, features: piece.features };
  if (piece.kind === "view") return { kind: "view", n };
  return {
    kind: "shape",
    n,
    ...(piece.shape && { shape: piece.shape }),
    ...(piece.label !== undefined && { label: piece.label }),
  };
}

/** What the notes keep of the area: its pieces without their polygons and the sum of the geometry they make. */
export function areaNotes(area: FilterArea): AreaNotes {
  const pieces = area.pieces.filter((p) => p.polygons.length > 0).map(pieceNote);
  return { pieces, sum: piecesSum(area) };
}

const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;

function readFeature(raw: unknown): AreaFeature | null {
  if (!isObject(raw) || typeof raw.id !== "string" || !isCount(raw.n)) return null;
  return { id: raw.id, ...(typeof raw.name === "string" && { name: raw.name }), n: raw.n };
}

function readPieceNote(raw: unknown): AreaPieceNote | null {
  if (!isObject(raw)) return null;
  if (raw.kind === "view") return isCount(raw.n) ? { kind: "view", n: raw.n } : null;
  if (raw.kind === "shape") {
    if (!isCount(raw.n)) return null;
    return {
      kind: "shape",
      n: raw.n,
      ...((raw.shape === "polygon" || raw.shape === "circle") && { shape: raw.shape }),
      ...(typeof raw.label === "string" && { label: raw.label }),
    };
  }
  if (raw.kind === "features") {
    if (typeof raw.source !== "string" || !Array.isArray(raw.features) || !raw.features.length) return null;
    const features = raw.features.map(readFeature);
    if (features.some((f) => f === null)) return null;
    return { kind: "features", source: raw.source, features: features as AreaFeature[] };
  }
  return null;
}

/** The area's notes as far as they are well formed; nothing when a piece is not. */
export function readAreaNotes(raw: unknown): AreaNotes | undefined {
  if (!isObject(raw) || typeof raw.sum !== "string" || !Array.isArray(raw.pieces)) return undefined;
  const pieces = raw.pieces.map(readPieceNote);
  if (pieces.some((p) => p === null)) return undefined;
  return {
    pieces: pieces as AreaPieceNote[],
    sum: raw.sum,
    ...(isObject(raw.off) && { off: raw.off }),
  };
}

const round = (v: number) => Math.round(v * DECIMALS) / DECIMALS;

/** Coordinates as a piece keeps them: longitude and latitude to six decimals. */
export const roundPolygons = (polygons: number[][][][]): PolygonCoords[] =>
  polygons.map((polygon) => polygon.map((ring) => ring.map(([x, y]): Position => [round(x), round(y)])));

/** The map view (west, south, east, north) as a polygon, held to the world. */
export function viewPolygon([west, south, east, north]: [number, number, number, number]): PolygonCoords {
  const w = round(Math.max(west, -180));
  const s = round(Math.max(south, -90));
  const e = round(Math.min(east, 180));
  const n = round(Math.min(north, 90));
  return [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ];
}
