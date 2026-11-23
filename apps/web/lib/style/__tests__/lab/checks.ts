// The checks that read a drawn scene: every sample drawn (and none drawn whose class or rule hides it at the map's
// zoom), every image the map asked for present, the color the map drew at each sample the one its legend swatch
// shows, and a scene without samples (points in groups) not blank. Each check returns what it found and never throws;
// the tests assert on it. The expected color comes from the legend's swatch and the layer's opacity; where to read it (a
// marker's image, size, anchor and offset, a line's width) comes from the layers that drew the sample's feature, with
// the values MapLibre evaluated for it.
import { Color, featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { MapGeoJSONFeature } from "maplibre-gl";

import { ICON_HEIGHT } from "@/lib/style/compile/constants";
import { cqlToExpression } from "@/lib/style/compile/cql";
import { keepsColors } from "@/lib/style/compile/images";
import { parseMarkerImage } from "@/lib/style/compile/markerImage";
import type { Geometry } from "@/lib/style/compile/types";
import { fromForm, valueAt } from "@/lib/style/compile/values";
import { type JsonObject, isObject } from "@/lib/style/json";
import { type Swatch, itemKey, legendBlocks, listedRules } from "@/lib/style/legend";
import { markerLayout } from "@/lib/style/render/markerImages";

import { type PlacedSample, SAMPLE_SIZE, type Scene } from "./scene";

/** The side of the square of device pixels read around a point. */
const WINDOW = 5;
/** How far a drawn channel may be from the expected one, of 255. */
const TOLERANCE = 10;
/** How many pixels of a read must have the expected color: one pixel could be an edge's blend of two colors. */
const MIN_PIXELS = 3;
/** How far inside its outline a polygon's fill is read beside a marker, in pixels: clear of the outline's blend. */
const CORNER_INSET = 4;
/** Lines thinner than this blend into the ground at every pixel. */
const MIN_LINE_WIDTH = 3;
/** Where a marker with an icon is read: this share of its radius from its middle, on the ring around the icon. */
const RING = 0.6;
/** A line sample's ends are left out of the strip read along it: its caps. */
const LINE_END = 4;
/** How far beyond its square the outline of a polygon whose fill is switched off is looked for: the only sample not
 * looked for exactly where it is drawn, as its middle is empty. */
const OUTLINE_REACH = 2;
export const WHITE: Rgb = [255, 255, 255];

export type Rgb = [number, number, number];
type Part = Record<string, unknown>;
/** A rectangle in CSS pixels of the map. `dominant`: its color is the one most of its non-white pixels have (an
 * icon's box, whose long edges hold every blend of the icon's color with the ground). */
export type Rect = { x: number; y: number; w: number; h: number; dominant?: true };
/** A rendered feature's layer: its paint and layout values evaluated for that feature. */
export type DrawnLayer = {
  id: string;
  type: string;
  source?: string;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};
/** One color to compare: the part read (empty for the main part), the color expected and where it is read. */
type Read = { part: string; want: Rgb; rect: Rect };
type Verdict = { skip: string } | { error: string } | { reads: Read[] };

const MAIN: Record<Geometry, "marker" | "line" | "fill"> = { point: "marker", line: "line", polygon: "fill" };
const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Whether a value follows a field, at every zoom (spec 4.3) or in its zoom stops (spec 4.4): the legend shows a
 * stand-in for it. */
const followsField = (form: unknown): boolean =>
  isObject(form) &&
  (typeof form.field === "string" ||
    (Array.isArray(form.zoom) &&
      (form.zoom as unknown[][]).some(([, v]) => isObject(v) && typeof v.field === "string")));

type Box = [[number, number], [number, number]];
const around = ([x, y]: [number, number], reach: number): Box => [
  [x - reach, y - reach],
  [x + reach, y + reach],
];

/** The rendered features of a sample's own feature where it is drawn: a marker's box (its place, size, anchor and
 * offset as MapLibre evaluated them for the feature); a polygon whose fill is switched off along its outline (the edge
 * of its square); any other sample at its pixel. */
function drawnAt(scene: Scene, p: PlacedSample): MapGeoJSONFeature[] {
  const own = (where?: [number, number] | Box) =>
    (where ? scene.map.queryRenderedFeatures(where) : scene.map.queryRenderedFeatures()).filter(
      (f) => f.id === p.featureId
    );
  if (p.swatch.geometry === "polygon" && !p.swatch.fill)
    return own(around(p.pixel, SAMPLE_SIZE / 2 + OUTLINE_REACH));
  // A point without a marker (its label alone): at its pixel.
  if (p.swatch.geometry !== "point" || !p.swatch.marker) return own(p.pixel);
  // Where the marker's layers put it, from the feature as they drew it; a marker not drawn by a marker layer is not
  // drawn.
  const anywhere = own();
  let box: Rect;
  try {
    box = markerPlace(
      scene,
      p,
      anywhere.map((f) => f.layer as unknown as DrawnLayer)
    ).box;
  } catch {
    return [];
  }
  return own([
    [box.x, box.y],
    [box.x + box.w, box.y + box.h],
  ]);
}

/** Why a sample is not expected on the map: its class or rule (or that record's main part) is drawn only in a zoom
 * range the map's zoom is outside of (spec 4.5); null when it is expected. */
export function drawSkip(scene: Scene, p: PlacedSample): string | null {
  const { record } = recordOf(scene.style, p);
  if (!isObject(record)) return null;
  const main = record[MAIN[p.swatch.geometry]];
  const zoom = scene.map.getZoom();
  for (const range of [record, isObject(main) ? main : {}]) {
    if (typeof range.min_zoom === "number" && zoom < range.min_zoom)
      return `its class or rule is drawn from zoom ${range.min_zoom} on`;
    if (typeof range.max_zoom === "number" && zoom >= range.max_zoom)
      return `its class or rule is drawn below zoom ${range.max_zoom}`;
  }
  return null;
}

/** Samples the map should draw (drawSkip) with no rendered feature where they are placed. */
export function notDrawn(scene: Scene): PlacedSample[] {
  return scene.placed.filter((p) => !drawSkip(scene, p) && !drawnAt(scene, p).length);
}

/** Samples the map should not draw at its zoom (drawSkip) that it draws where they are placed. */
export function drawnHidden(scene: Scene): PlacedSample[] {
  return scene.placed.filter((p) => drawSkip(scene, p) && drawnAt(scene, p).length);
}

/** Images the map asked for while drawing that it does not have. */
export function missingImages(scene: Scene): string[] {
  return scene.requestedImages.filter((id) => !scene.map.hasImage(id));
}

/** The part of a compiled layer: its id after the layer's id and a dash. */
const partOf = (layer: DrawnLayer) => (layer.source ? layer.id.slice(layer.source.length + 1) : "");

const targetOf = (c: JsonObject, geometry: Geometry) =>
  typeof c.target === "string" ? c.target : `${MAIN[geometry]}.color`;

/** Whether a rule's condition holds for a feature's properties: the app's expression for it, evaluated by MapLibre. */
function matches(rule: JsonObject, properties: Record<string, unknown>): boolean {
  const condition = cqlToExpression(rule.when);
  if (condition === null) return false;
  return featureFilter(condition as never, "rules.when").filter({ zoom: 0 }, {
    type: 1,
    properties,
  } as never);
}

/** The main part's keys the expected color reads. */
const READ_KEYS = ["color", "opacity"] as const;

// A block of the outline color alone compares the base fill its swatch shows, not the outline color: the checks have
// no read position or width rule for outlines yet.

/** The record a sample's entry stands for (its rule, its class, its classification's Other or No data record; none
 * for the base look and the features no rule matches), the classification of a class entry, and the paths that
 * entry's legend block stands for. */
function recordOf(
  style: JsonObject,
  p: PlacedSample
): { record?: unknown; block?: JsonObject; paths: string[] } {
  const classify = list(style.classify);
  if (p.section === "rules")
    return {
      record: listedRules(style).find((r, i) => itemKey(r, i) === p.entry.id),
      paths: [],
    };
  if (p.section === "base" || p.entry.extra === "rest") return { paths: [] };
  const block = classify.find((k) => (typeof k.id === "string" ? k.id : String(k.field)) === p.section);
  if (!block) return { paths: [] };
  return {
    record: p.entry.extra
      ? block[p.entry.extra]
      : list(block.classes).find((k, i) => itemKey(k, i) === p.entry.id),
    block,
    // What the block stands for, as the legend merges it.
    paths: legendBlocks(style, p.swatch.geometry).find((b) => b.id === p.section)?.targets ?? [],
  };
}

/** Why the swatch's main color and opacity are not the ones the map draws for the sample's feature, by the style's
 * structure (as legend-vs-map.test.ts reads it); null when they are. A sample holds only the properties its entry
 * stands for, so a key its entry does not own follows the base, or another classification's class for features
 * without a value. */
function standIn(style: JsonObject, p: PlacedSample, properties: Record<string, unknown>): string | null {
  const geometry = p.swatch.geometry;
  const main = MAIN[geometry];
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const classify = list(style.classify);
  const rules = list(style.rules);
  const sets = (record: unknown, key: string) =>
    isObject(record) && isObject(record[main]) && record[main][key] !== undefined;

  const { record, block, paths } = recordOf(style, p);
  if (p.section !== "rules" && p.section !== "base" && p.entry.extra !== "rest") {
    if (!block) return "no classification of the section in the style";
    // The legend shows a class's own color in any block (legend.ts swatch), and grey where it sets none.
    if (!paths.some((path) => path.endsWith("color")) && !sets(record, "color"))
      return "the legend's grey stand-in: the block sets no color, the map draws the feature's";
  }
  // A rule the sample matches wins over its class and the base (spec 6.1); of the rules, the sample's own entry
  // shows only its own.
  if (rules.some((r) => r !== record && matches(r, properties) && READ_KEYS.some((key) => sets(r, key))))
    return "a rule the sample matches sets its color or opacity";
  for (const key of READ_KEYS) {
    const path = `${main}.${key}`;
    if (sets(record, key)) continue;
    const form = isObject(symbol[main]) ? symbol[main][key] : undefined;
    if (followsField(form)) return `the legend's stand-in for a main ${key} by attribute`;
    if (paths.includes(path)) continue;
    if (classify.some((k) => targetOf(k, geometry) === path))
      return `another classification sets the main ${key}, which the sample has no value for`;
  }
  return null;
}

/** The layer's opacity at the map's zoom (spec 4.6): it fades every part on the map, not the swatch. */
function layerOpacity(style: JsonObject, zoom: number): number {
  const at = valueAt(fromForm(style.opacity, "number", 1), zoom);
  return typeof at === "number" ? at : 1;
}

/** A part's color at its opacity times `fade` over `ground`; null when the color does not parse. */
export function over(part: Part, fade: number, ground: Rgb): Rgb | null {
  const color = typeof part.color === "string" ? Color.parse(part.color) : undefined;
  if (!color) return null;
  const opacity = (typeof part.opacity === "number" ? part.opacity : 1) * fade;
  // Color holds its channels premultiplied by its alpha.
  const alpha = color.a * opacity;
  return [color.r, color.g, color.b].map((c, i) => c * opacity * 255 + (1 - alpha) * ground[i]) as Rgb;
}

/** The color the swatch says the map draws: its main part over the ground, a line over its casing. */
function expected(swatch: Swatch, fade: number): Rgb | null {
  const geometry = swatch.geometry;
  const ground = (geometry === "line" && swatch.casing && over(swatch.casing, fade, WHITE)) || WHITE;
  return over(swatch[MAIN[geometry]]!, fade, ground);
}

const num = (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback);
const pair = (value: unknown): [number, number] =>
  Array.isArray(value) && value.length === 2 ? [num(value[0], 0), num(value[1], 0)] : [0, 0];
const imageName = (value: unknown): string =>
  typeof value === "object" && value !== null && "name" in value
    ? String((value as { name: unknown }).name)
    : String(value ?? "");

/** The top left corner of a box of `w` x `h` placed at `at` by a symbol's anchor. */
function placeBox([x, y]: [number, number], w: number, h: number, anchor: unknown): [number, number] {
  const name = typeof anchor === "string" ? anchor : "center";
  const left = name.includes("left") ? x : name.includes("right") ? x - w : x - w / 2;
  const top = name.includes("top") ? y : name.includes("bottom") ? y - h : y - h / 2;
  return [left, top];
}

/** A WINDOW x WINDOW square of device pixels around a point. */
function windowAt(scene: Scene, [x, y]: [number, number]): Rect {
  const side = WINDOW / scene.map.getPixelRatio();
  return { x: x - side / 2, y: y - side / 2, w: side, h: side };
}

/** Where a point's marker is drawn (`box`) and where its color is read (`read`): the middle of its marker (a pin's
 * head, above its tip), on the ring around an icon; the whole box of an icon alone. */
export function markerPlace(
  scene: Scene,
  p: Pick<PlacedSample, "pixel">,
  layers: DrawnLayer[]
): { box: Rect; read: Rect } {
  const at = (layer: DrawnLayer, key: string) => layer.layout?.[key] ?? layer.paint?.[key];
  const circle = layers.find((l) => l.type === "circle" && partOf(l) === "marker");
  if (circle) {
    const [dx, dy] = pair(at(circle, "circle-translate"));
    const middle: [number, number] = [p.pixel[0] + dx, p.pixel[1] + dy];
    const r = num(at(circle, "circle-radius"), 0) + num(at(circle, "circle-stroke-width"), 0);
    return { box: { x: middle[0] - r, y: middle[1] - r, w: 2 * r, h: 2 * r }, read: windowAt(scene, middle) };
  }
  const marker = layers.find((l) => l.type === "symbol" && partOf(l) === "marker");
  // An icon alone: the layer of library icons, or of icons that keep their colors (`icon-asset` and the like).
  const icon = layers.find((l) => l.type === "symbol" && /^icon(-|$)/.test(partOf(l)));
  const layer = marker ?? icon;
  if (!layer) throw new Error(`no marker layer among ${layers.map((l) => l.id).join(", ")}`);
  const scale = num(at(layer, "icon-size"), 1);
  const [ox, oy] = pair(at(layer, "icon-offset"));
  const place: [number, number] = [p.pixel[0] + ox * scale, p.pixel[1] + oy * scale];
  if (!marker) {
    // An icon alone: its box, which its color fills in the icon's strokes.
    const side = scale * ICON_HEIGHT;
    const [x, y] = placeBox(place, side, side, at(layer, "icon-anchor"));
    const box: Rect = { x, y, w: side, h: side, dominant: true };
    return { box, read: box };
  }
  const name = imageName(at(marker, "icon-image"));
  const spec = parseMarkerImage(name);
  if (!spec) throw new Error(`not a marker image: ${name}`);
  // The renderer's own layout of the image: its side with the stroke's padding, the icon's box in the shape's head.
  const box = markerLayout(spec);
  const side = box.side * scale;
  const [x, y] = placeBox(place, side, side, at(marker, "icon-anchor"));
  const middle: [number, number] = [
    x + (box.iconX + box.icon / 2) * scale,
    y + (box.iconY + box.icon / 2) * scale,
  ];
  // Left of the icon: a flag's ring side is its pole.
  if (spec.icon) middle[0] -= (RING * spec.size * scale) / 2;
  return { box: { x, y, w: side, h: side }, read: windowAt(scene, middle) };
}

/** Where the marker of a polygon or line sample is drawn, from the layers that draw the sample's feature anywhere on
 * the map (a pin stands on its tip, above the pixel); null when no marker layer draws it (a size by an attribute the
 * sample has no value for). */
function markerOn(scene: Scene, p: PlacedSample): { box: Rect; read: Rect } | null {
  const layers = scene.map
    .queryRenderedFeatures()
    .filter((f) => f.id === p.featureId)
    .map((f) => f.layer as unknown as DrawnLayer);
  const drawsMarker = (l: DrawnLayer) =>
    (l.type === "circle" || l.type === "symbol") && /^(marker|icon(-.*)?)$/.test(partOf(l));
  return layers.some(drawsMarker) ? markerPlace(scene, p, layers) : null;
}

/** Whether two rectangles overlap. */
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Where a polygon sample's fill is read beside its marker: a window inside one of its square's corners, clear of its
 * outline and of the marker's box; null when the marker covers every corner. */
function fillBeside(scene: Scene, p: PlacedSample, marker: Rect): Rect | null {
  const inset = num(p.swatch.outline?.width, 0) + CORNER_INSET;
  const reach = SAMPLE_SIZE / 2 - inset;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const rect = windowAt(scene, [p.pixel[0] + sx * reach, p.pixel[1] + sy * reach]);
    if (!overlaps(rect, marker)) return rect;
  }
  return null;
}

/** The longer part of a line's strip left or right of its marker's box; null when neither is MIN_PIXELS long. */
function stripBeside(strip: Rect, marker: Rect): Rect | null {
  const left = { ...strip, w: Math.min(strip.w, marker.x - strip.x) };
  const rightStart = Math.max(strip.x, marker.x + marker.w);
  const right = { ...strip, x: rightStart, w: strip.x + strip.w - rightStart };
  const longer = left.w >= right.w ? left : right;
  return longer.w >= MIN_PIXELS ? longer : null;
}

/** Why a polygon's or a line's marker color is not compared, or null when it is. */
function markerSkip(style: JsonObject, marker: Part, geometry: Geometry): string | null {
  if (marker.fill === false) return "a hollow marker: it draws its outline and icon, no fill color";
  if (marker.shape === "icon" && keepsColors(marker.icon)) return "an icon that keeps its own colors";
  const form = isObject(style.symbol) && isObject(style.symbol.marker) ? style.symbol.marker : {};
  for (const key of READ_KEYS)
    if (followsField(form[key])) return `the legend's stand-in for a marker ${key} by attribute`;
  const color = typeof marker.color === "string" ? Color.parse(marker.color) : undefined;
  // A marker the line shows through: the ground under its read is the line in part, the ground in part.
  if (geometry === "line" && (color?.a ?? 1) * num(marker.opacity, 1) < 1)
    return "a see-through marker on a line: the line shows through part of it";
  return null;
}

/** What to compare for a sample: a reason to skip it, an error, or the expected colors and where to read them. A
 * polygon's or a line's marker sits on the sample's pixel: its fill or line is then read beside the marker, and the
 * marker's color is read where the marker is drawn, over the fill (a polygon) or the ground. */
function judge(scene: Scene, p: PlacedSample): Verdict {
  try {
    const geometry = p.swatch.geometry;
    const main = p.swatch[MAIN[geometry]];
    if (!main) return { skip: "the main part is switched off: no color to compare" };
    const hidden = drawSkip(scene, p);
    if (hidden) return { skip: hidden };
    const drawn = drawnAt(scene, p);
    if (!drawn.length) return { skip: "not drawn where it is placed (notDrawn reports it)" };
    if (geometry === "point" && main.fill === false)
      return { skip: "a hollow marker: it draws its outline and icon, no fill color" };
    if (geometry === "point" && main.shape === "icon" && keepsColors(main.icon))
      return { skip: "an icon that keeps its own colors (an upload or an emoji)" };
    const layers = drawn.map((f) => f.layer as unknown as DrawnLayer);
    if (layers.some((l) => l.type === "fill-extrusion"))
      return { skip: "a raised polygon: the map's light shades its faces, the swatch shows the color unlit" };
    const reason = standIn(scene.style, p, drawn[0].properties);
    if (reason) return { skip: reason };
    let rect: Rect;
    if (geometry === "line") {
      const line = layers.find((l) => l.type === "line" && partOf(l) === "line");
      const width = num(line?.paint?.["line-width"], 1);
      if (width < MIN_LINE_WIDTH)
        return { skip: `a line under ${MIN_LINE_WIDTH} px: its edges blend into the ground` };
      if (num(line?.paint?.["line-blur"], 0) > 0)
        return {
          skip: "a blurred line: its blur fades it from its middle out, the swatch draws it unblurred",
        };
      // Dash lengths are in line widths; the dashes of a pattern are its even entries. MapLibre gives the evaluated
      // pattern as the two it fades between.
      const pattern = line?.paint?.["line-dasharray"];
      const patterns = isObject(pattern) ? [pattern.from, pattern.to] : [pattern];
      const dashes = patterns.flatMap((dash) =>
        Array.isArray(dash) ? dash.filter((_, i: number) => i % 2 === 0) : []
      );
      if (dashes.some((dash) => num(dash, 1) * width < MIN_LINE_WIDTH))
        return { skip: `dashes under ${MIN_LINE_WIDTH} px: their ends blend into the ground` };
      // The line's core rows along its length: a dashed line's dashes are in it wherever its gaps fall.
      const half = SAMPLE_SIZE / 2 - LINE_END;
      rect = { x: p.pixel[0] - half, y: p.pixel[1] - 1, w: 2 * half, h: 2 };
    } else rect = geometry === "point" ? markerPlace(scene, p, layers).read : windowAt(scene, p.pixel);
    const fade = layerOpacity(scene.style, scene.map.getZoom());
    const want = expected(p.swatch, fade);
    if (!want) return { error: `legend color ${String(main.color)} is not a color` };
    const reads: Read[] = [];
    const marker = geometry !== "point" ? p.swatch.marker : undefined;
    const mark = marker ? markerOn(scene, p) : null;
    if (marker && mark) {
      const beside = geometry === "line" ? stripBeside(rect, mark.box) : fillBeside(scene, p, mark.box);
      if (!beside) return { skip: `the marker covers the ${MAIN[geometry]} where it is read` };
      rect = beside;
      const skip = markerSkip(scene.style, marker, geometry);
      const markerWant = skip ? null : over(marker, fade, geometry === "polygon" ? want : WHITE);
      if (!skip && !markerWant)
        return { error: `legend marker color ${String(marker.color)} is not a color` };
      if (markerWant) reads.push({ part: " marker", want: markerWant, rect: mark.read });
    }
    return { reads: [{ part: "", want, rect }, ...reads] };
  } catch (error) {
    return { error: message(error) };
  }
}

/** Why a sample's color is not compared, or null when it is (or when the check reports an error for it). */
export function colorSkip(scene: Scene, p: PlacedSample): string | null {
  const verdict = judge(scene, p);
  return "skip" in verdict ? verdict.skip : null;
}

/** The device pixels of a rectangle given in CSS pixels of the map, the part inside the drawing buffer, as the buffer
 * holds them: RGBA, rows from the bottom up. */
function readBuffer(scene: Scene, rect: Rect): { data: Uint8Array; w: number; h: number } {
  const canvas = scene.map.getCanvas();
  const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
  const ratio = scene.map.getPixelRatio();
  const x0 = Math.max(0, Math.round(rect.x * ratio));
  const y0 = Math.max(0, Math.round(rect.y * ratio));
  const x1 = Math.min(gl.drawingBufferWidth, Math.max(x0 + 1, Math.round((rect.x + rect.w) * ratio)));
  const y1 = Math.min(gl.drawingBufferHeight, Math.max(y0 + 1, Math.round((rect.y + rect.h) * ratio)));
  const [w, h] = [x1 - x0, y1 - y0];
  if (w <= 0 || h <= 0) return { data: new Uint8Array(0), w: 0, h: 0 };
  const data = new Uint8Array(w * h * 4);
  // readPixels counts rows from the bottom of the drawing buffer.
  gl.readPixels(x0, gl.drawingBufferHeight - y1, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return { data, w, h };
}

/** The pixels of a rectangle given in CSS pixels of the map, read from the drawing buffer. */
export function readRect(scene: Scene, rect: Rect): Rgb[] {
  const { data } = readBuffer(scene, rect);
  const out: Rgb[] = [];
  for (let i = 0; i < data.length; i += 4) out.push([data[i], data[i + 1], data[i + 2]]);
  return out;
}

/** The pixels of a rectangle given in CSS pixels of the map, row by row from its top, each row from its left: the
 * pixels `readRect` reads, for checks that need to know where each one is. */
export function readRows(scene: Scene, rect: Rect): Rgb[][] {
  const { data, w, h } = readBuffer(scene, rect);
  const rows: Rgb[][] = [];
  for (let r = h - 1; r >= 0; r--) {
    const row: Rgb[] = [];
    for (let c = 0; c < w; c++) {
      const i = (r * w + c) * 4;
      row.push([data[i], data[i + 1], data[i + 2]]);
    }
    rows.push(row);
  }
  return rows;
}

const hex = (rgb: Rgb) =>
  `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;

/** The largest difference of two colors in one channel, of 255. */
export const distance = (a: Rgb, b: Rgb) => Math.max(...a.map((c, i) => Math.abs(c - b[i])));

/** The color most pixels of a read have, white (the ground) left out unless nothing else is there. */
function mostFrequent(pixels: Rgb[]): Rgb {
  const counts = new Map<string, { rgb: Rgb; n: number }>();
  for (const rgb of pixels) {
    if (distance(rgb, WHITE) <= TOLERANCE) continue;
    const key = hex(rgb);
    const found = counts.get(key);
    if (found) found.n += 1;
    else counts.set(key, { rgb, n: 1 });
  }
  let best: { rgb: Rgb; n: number } = { rgb: WHITE, n: 0 };
  for (const entry of counts.values()) if (entry.n > best.n) best = entry;
  return best.rgb;
}

/** Whether the map drew nothing: every pixel of it is the white ground. A scene of points in groups (clusters, a
 * heatmap) places no samples, so this is what tells that it drew. */
export function blank(scene: Scene): boolean {
  const canvas = scene.map.getCanvas();
  const pixels = readRect(scene, { x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight });
  return pixels.every((rgb) => distance(rgb, WHITE) <= TOLERANCE);
}

/** Samples whose drawn color is not the one their legend swatch shows: "section/entry: legend #rrggbb, map #rrggbb",
 * the legend's color at its opacity (and the layer's) over the ground, the map's the most frequent color read. Passes
 * when at least MIN_PIXELS pixels of the read are within TOLERANCE per channel; a dominant read when its most frequent
 * non-white color is. */
export function colorMismatches(scene: Scene): string[] {
  const out: string[] = [];
  for (const p of scene.placed) {
    const label = `${p.section}/${p.entry.id}`;
    const verdict = judge(scene, p);
    if ("skip" in verdict) continue;
    if ("error" in verdict) {
      out.push(`${label}: ${verdict.error}`);
      continue;
    }
    for (const { part, want, rect } of verdict.reads) {
      const pixels = readRect(scene, rect);
      const drawn = mostFrequent(pixels);
      const near = pixels.filter((rgb) => distance(rgb, want) <= TOLERANCE).length;
      const pass = rect.dominant ? distance(drawn, want) <= TOLERANCE : near >= MIN_PIXELS;
      if (!pass) out.push(`${label}${part}: legend ${hex(want)}, map ${hex(drawn)}`);
    }
  }
  return out;
}
