// Value tiles (goatlib.raster.values): geoapi sends a band's or a formula's cells as codes in RGB, `q = R * 65536 +
// G * 256 + B`, code 0 for no data and `base + q * step` for a value, and MapLibre colors them in the browser: a
// `raster-dem` source with the custom encoding under a `color-relief` layer. A color edit is a paint change; the tiles
// stay. The coloring comes from `rasterColorSpec`, placed here on the codes as stops.
import { type JsonObject, isObject } from "@/lib/style/json";
import {
  type RasterColorSpec,
  alphaShare,
  classReach,
  rasterColorSpec,
  rgbOf,
  tableColorSpec,
} from "@/lib/style/raster/color";
import { colorInterpOf, fileName, paletteOf } from "@/lib/style/raster/metadata";

/** The largest code (24 bits). */
export const MAX_Q = 16_777_215;
/** The width of the raster service's tiles the map asks for, value tiles and image tiles: 512 px tiles need a quarter of
 * the requests of 256 px ones (geoapi's default) for the same view. */
export const TILE_SIZE = 512;
/** The most stops a color-relief layer is given (WebGL 2 guarantees textures 2048 wide, common graphics cards 8192 or
 * more); a coloring that needs more draws from image tiles. */
export const MAX_RELIEF_STOPS = 4096;

/** The colors of the file's color table (geoapi `palette`): the band the table colors and each entry's color
 * ("#rrggbb", without its alpha), the entries drawn fully transparent left out; the alpha (0 to 1) of those drawn
 * partly transparent. */
export interface Palette {
  band: number;
  colors: Record<number, string>;
  alphas?: Record<number, number>;
}

/** What tells whether a raster image's tile pixels are its bands' values (`imagePixels`): the file's band count
 * and data type, whether its bands are scaled, whether it has a color table; and the bands' names, "" where a band has
 * none. */
export interface BandFacts {
  count: number;
  dtype: string;
  scaled: boolean;
  colorTable: boolean;
  names?: string[];
  /** The bands that hold values, by index: every band but an alpha band (goatlib `RasterInfo.value_bands`). */
  valueBands?: number[];
  /** Each band's color interpretation, in band order (GDAL's names: "red", "green", "blue", "alpha", "palette",
   * ...): an image draws the bands marked red, green and blue (`imageBands`). */
  colorInterp?: string[];
  /** With a color table: its entries' colors, which an image drawn with the table colors its table band's value tiles
   * in (`tableColorSpec`). */
  palette?: Palette;
}

/** What a tileset description of a raster file's tiles tells a map's source: the colored tiles' description holds
 * only this, the value tiles' their values too. */
export interface RasterTileset {
  /** The layer's values version: changes with the file and the encoding, never with the style. Tile URLs that name it
   * are kept by caches for good when read with a sign-in or for a layer anyone may read, an hour otherwise. */
  version: string;
  /** The native zoom of `TILE_SIZE` tiles: past it the map magnifies the deepest tiles. */
  maxzoom?: number;
  /** The file's west, south, east and north in degrees: the map asks only for the tiles that touch them. */
  bounds?: [number, number, number, number];
  /** The colored tiles' description: the file's band facts, from its header; missing from older services. */
  bands?: BandFacts;
}

/** A tileset description of value tiles (its `goat:values`, native zoom and bounds). */
export interface RasterValues extends RasterTileset {
  /** The `raster-dem` source's custom encoding: `base = -baseShift`, `step = blueFactor`. */
  encoding: { redFactor: number; greenFactor: number; blueFactor: number; baseShift: number };
  /** The band's (or formula's) minimum and maximum: a ramp without a domain spreads over it. */
  range: [number, number] | null;
  /** Whether the codes hold whole numbers exactly. */
  integer: boolean;
  /** The file's band names in band order, "" where a band has none (a popup's labels); missing from older services. */
  names?: string[];
}

/** What value tiles hold: a band or a formula's result, read nearest or bilinear. */
export interface ValueQuery {
  band?: number;
  formula?: string;
  resampling: "nearest" | "bilinear";
}

/** A color-relief stop: a code and its color, `rgba(r, g, b, a)`. */
export type ReliefStop = [q: number, color: string];

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Whether a raster style draws codes, which never blend (spec 9): categories, and an image drawn with its file's color
 * table (`tableColorSpec`, which needs the file's band facts). Their cells stay crisp whatever `resampling` says. */
export function drawsCodes(style: JsonObject, facts?: Partial<BandFacts>): boolean {
  const render: JsonObject = isObject(style.render) ? style.render : { type: "image" };
  return render.type === "categorical" || tableColorSpec(style, facts) !== null;
}

/** How a raster style draws its cells past their resolution (spec 9): crisp where it draws codes (`drawsCodes`, with the
 * file's band facts `facts`); else the style's `resampling`, else crisp cells for a color scale (continuous, a
 * hillshade's colors) and smooth ones for images and shading alone. */
export function resamplingOf(style: JsonObject, facts?: Partial<BandFacts>): "linear" | "nearest" {
  if (drawsCodes(style, facts)) return "nearest";
  if (style.resampling === "nearest" || style.resampling === "linear") return style.resampling;
  const render: JsonObject = isObject(style.render) ? style.render : { type: "image" };
  if (render.type === "continuous") return "nearest";
  return render.type === "hillshade" && rasterColorSpec(render) !== null ? "nearest" : "linear";
}

/** The values a raster style colors in the browser; null for images (categories without classes too), but an image
 * drawn with its file's color table, which reads its table band's codes (`tableColorSpec`, with the file's band facts
 * `facts`: without them none). */
export function valueQuery(style: JsonObject, facts?: Partial<BandFacts>): ValueQuery | null {
  const table = tableColorSpec(style, facts);
  if (table) return { band: table.band as number, resampling: "nearest" };
  const render: JsonObject = isObject(style.render) ? style.render : { type: "image" };
  if (render.type !== "continuous" && render.type !== "categorical" && render.type !== "hillshade")
    return null;
  if (rasterColorSpec(render)?.kind === "rgb") return null;
  const band = render.band ?? 1;
  const read = num(band)
    ? { band }
    : isObject(band) && typeof band.expression === "string" && band.expression.trim()
      ? { formula: band.expression }
      : null;
  if (!read) return null;
  // Values read as the colors draw; a hillshade's shading needs smooth values unless the style says otherwise.
  const smooth =
    render.type === "hillshade" ? style.resampling !== "nearest" : resamplingOf(style) === "linear";
  return { ...read, resampling: smooth ? "bilinear" : "nearest" };
}

const queryString = (params: Array<[string, string | number | undefined]>) =>
  params
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");

const readParams = (query: ValueQuery): Array<[string, string | number]> => [
  query.formula !== undefined ? ["formula", query.formula] : ["band", query.band ?? 1],
  ["resampling", query.resampling],
  ["tilesize", TILE_SIZE],
];

/** The URL of the tileset description of a raster's value tiles (`coverage`: its coverage tileset), for tiles of
 * `TILE_SIZE`; the version last, so `loadedRasterValues` finds a description under the URL without it. */
export function valuesUrl(coverage: string, query: ValueQuery, version?: string): string {
  return `${coverage}?${queryString([...readParams(query), ["v", version]])}`;
}

/** The URL of the description of a raster's colored tiles (`tileset`: its colored tiles' address without z/x/y), for
 * tiles of `TILE_SIZE`; the version last, as `valuesUrl`. */
export function tilesetUrl(tileset: string, version?: string): string {
  return `${tileset}?${queryString([
    ["tilesize", TILE_SIZE],
    ["v", version],
  ])}`;
}

/** The value tiles' URL template. It names the encoding too, so the URL alone determines its tile. */
export function valueTilesUrl(coverage: string, query: ValueQuery, values: RasterValues): string {
  const params = queryString([
    ["f", "webp"],
    ...readParams(query),
    ["base", -values.encoding.baseShift],
    ["step", values.encoding.blueFactor],
    ["v", values.version],
  ]);
  return `${coverage}/{z}/{y}/{x}?${params}`;
}

/** West, south, east and north in degrees, west below east and south below north; undefined for anything else. */
function boundsOf(value: unknown): RasterValues["bounds"] {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(num)) return undefined;
  const [west, south, east, north] = value as number[];
  const inside = west >= -180 && east <= 180 && south >= -90 && north <= 90;
  return inside && west < east && south < north ? [west, south, east, north] : undefined;
}

/** A description's native zoom and bounds, where it gives usable ones. */
function extentOf(json: JsonObject): Pick<RasterTileset, "maxzoom" | "bounds"> {
  const bounds = boundsOf(json.bounds);
  return {
    ...(num(json.maxzoom) ? { maxzoom: json.maxzoom } : {}),
    ...(bounds ? { bounds } : {}),
  };
}

/** The file's names of its bands, "" where a band has none; undefined for anything else. */
const namesOf = (names: unknown): string[] | undefined =>
  Array.isArray(names) && names.every((n) => typeof n === "string")
    ? (names as string[]).map((name, i) => fileName(name, i + 1))
    : undefined;

/** The colored tiles' band facts (`goat:bands`); undefined when there are none or they are malformed. */
function bandFactsOf(json: unknown): BandFacts | undefined {
  if (!isObject(json)) return undefined;
  const { count, dtype, scaled, color_table: colorTable } = json;
  if (
    !num(count) ||
    typeof dtype !== "string" ||
    typeof scaled !== "boolean" ||
    typeof colorTable !== "boolean"
  )
    return undefined;
  const names = namesOf(json.names);
  const valueBands =
    Array.isArray(json.value_bands) && json.value_bands.every(num)
      ? (json.value_bands as number[])
      : undefined;
  const colorInterp = colorInterpOf(json.color_interp);
  const palette = paletteOf(json.palette);
  return {
    count,
    dtype,
    scaled,
    colorTable,
    ...(names ? { names } : {}),
    ...(valueBands ? { valueBands } : {}),
    ...(colorInterp ? { colorInterp } : {}),
    ...(palette ? { palette } : {}),
  };
}

/** The colored tiles' description (`goat:version`, native zoom and bounds, band facts); null when it is not one. */
export function rasterTilesetOf(json: unknown): RasterTileset | null {
  if (!isObject(json)) return null;
  const version = json["goat:version"];
  if (typeof version !== "string" || !version) return null;
  const bands = bandFactsOf(json["goat:bands"]);
  return { version, ...extentOf(json), ...(bands ? { bands } : {}) };
}

/** The values of a tileset description; null when it is not one. */
export function rasterValuesOf(json: unknown): RasterValues | null {
  if (!isObject(json) || !isObject(json["goat:values"])) return null;
  const values = json["goat:values"];
  const e = isObject(values.encoding) ? values.encoding : {};
  const { redFactor, greenFactor, blueFactor, baseShift } = e;
  if (!num(redFactor) || !num(greenFactor) || !num(blueFactor) || !num(baseShift) || blueFactor <= 0)
    return null;
  const range = values.range ?? null;
  if (range !== null && !(Array.isArray(range) && range.length === 2 && range.every(num))) return null;
  if (typeof values.integer !== "boolean" || typeof values.version !== "string" || !values.version)
    return null;
  const names = namesOf(values.names);
  return {
    encoding: { redFactor, greenFactor, blueFactor, baseShift },
    range: range as [number, number] | null,
    integer: values.integer,
    version: values.version,
    ...(names ? { names } : {}),
    ...extentOf(json),
  };
}

type Rgba = [number, number, number, number];
/** A code and its color; colors are linear between knots, the end colors hold beyond them. */
type Knot = [q: number, color: Rgba];

const CLEAR: Rgba = [0, 0, 0, 0];

/** A color as drawn: its own alpha (spec 4.6) times `alpha` (a color table entry's). */
const fill = (color: string | null, alpha = 1): Rgba =>
  color === null ? CLEAR : [...rgbOf(color), alpha * alphaShare(color)];

/** Rounds as goatlib's encoder rounds a value to its code (numpy's rint: halves to even). */
const rint = (x: number): number => {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

/** The index of the first knot at or above code `q`. */
function lowerBound(knots: Knot[], q: number): number {
  let lo = 0;
  let hi = knots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (knots[mid][0] < q) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The color at code `q`: linear between knots, the end colors beyond them. */
function colorAt(knots: Knot[], q: number): Rgba {
  const i = lowerBound(knots, q);
  if (i === knots.length) return knots[i - 1][1];
  if (knots[i][0] === q || i === 0) return knots[i][1];
  const [qa, a] = knots[i - 1];
  const [qb, b] = knots[i];
  const t = (q - qa) / (qb - qa);
  return a.map((v, k) => v + (b[k] - v) * t) as Rgba;
}

/** One color on the codes `qa` to `qb` (clipped to the codes); the colors around them stay. */
function paint(knots: Knot[], qa: number, qb: number, color: Rgba): void {
  const a = Math.max(1, qa);
  const b = Math.min(MAX_Q, qb);
  if (a > b) return;
  const left = a > 1 ? colorAt(knots, a - 1) : null;
  const right = b < MAX_Q ? colorAt(knots, b + 1) : null;
  const from = lowerBound(knots, a - 1);
  const to = lowerBound(knots, b + 2);
  const added: Knot[] = [];
  if (left) added.push([a - 1, left]);
  added.push([a, color]);
  if (b > a) added.push([b, color]);
  if (right) added.push([b + 1, right]);
  knots.splice(from, to - from, ...added);
}

/** Knots of colors at positions among the codes, clipped to the codes: linear between positions, the end colors beyond
 * them, and where two colors share a position the later one from there on (numpy's interp, as the service). The knots
 * sit on the codes around each position, and on the code before a whole code two colors share, each with the color
 * there, so every code takes its exact color. */
export function linear(points: Array<[number, Rgba]>): Knot[] {
  const sorted = [...points].sort((x, y) => x[0] - y[0]);
  const at = (p: number): Rgba => {
    // The last position at or below p.
    let i = -1;
    while (i + 1 < sorted.length && sorted[i + 1][0] <= p) i += 1;
    if (i === -1) return sorted[0][1];
    if (i === sorted.length - 1 || sorted[i][0] === p) return sorted[i][1];
    const [qa, a] = sorted[i];
    const [qb, b] = sorted[i + 1];
    return a.map((v, k) => v + (b[k] - v) * ((p - qa) / (qb - qa))) as Rgba;
  };
  const codes = new Set([1, MAX_Q]);
  sorted.forEach(([p], i) => {
    codes.add(Math.floor(p));
    codes.add(Math.ceil(p));
    if (Number.isInteger(p) && i > 0 && sorted[i - 1][0] === p) codes.add(p - 1);
  });
  return [...codes]
    .filter((q) => q >= 1 && q <= MAX_Q)
    .sort((x, y) => x - y)
    .map((q) => [q, at(q)]);
}

/** A shader's value of code `q`: the dot product of its bytes with the factors, in float32. */
function shaderValue(q: number, encoding: RasterValues["encoding"]): number {
  const f = Math.fround;
  const products = [
    f((q >> 16) * f(encoding.redFactor)),
    f(((q >> 8) & 255) * f(encoding.greenFactor)),
    f((q & 255) * f(encoding.blueFactor)),
    f(-f(encoding.baseShift)),
  ];
  return products.reduce((sum, p) => f(sum + p), 0);
}

/** The knots with every one decoding below the next in float32, or the shader divides by zero between them. Codes
 * far above the data's range can share a float32 value: the later knot keeps its code, the earlier one moves down
 * until it decodes apart, or goes when it cannot. */
function apart(knots: Knot[], encoding: RasterValues["encoding"]): Knot[] {
  const kept: Knot[] = [knots[knots.length - 1]];
  for (let i = knots.length - 2; i >= 0; i--) {
    const next = shaderValue(kept[kept.length - 1][0], encoding);
    const floor = i > 0 ? knots[i - 1][0] : -1;
    let q = knots[i][0];
    while (q > floor && shaderValue(q, encoding) >= next) q -= 1;
    if (q > floor) kept.push([q, knots[i][1]]);
  }
  return kept.reverse();
}

const css = ([r, g, b, a]: Rgba) =>
  `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a.toFixed(4))})`;

/** A coloring as color-relief stops over the codes of `values`: code 0 (no data) transparent, then the colors as the
 * raster service paints them (goatlib.raster.color), each on a code of its own. Null when it needs more than
 * `MAX_RELIEF_STOPS`. */
export function reliefStops(
  spec: Exclude<RasterColorSpec, { kind: "rgb" }>,
  values: RasterValues
): ReliefStop[] | null {
  const { baseShift, blueFactor: step } = values.encoding;
  const qr = (v: number) => (v + baseShift) / step;
  // The first code of the values from `v` on, and the last of those up to `v`. Whole numbers are stored exactly, so a
  // code's own value decides; any other band keeps each value at its nearest code, and the code that holds `v` itself
  // goes with `v`.
  const first = (v: number) => (values.integer ? Math.ceil(qr(v)) : rint(qr(v)));
  const last = (v: number) => (values.integer ? Math.floor(qr(v)) : rint(qr(v)));
  const hide = (knots: Knot[], lo: number, hi: number) => {
    paint(knots, 1, first(lo) - 1, CLEAR);
    paint(knots, last(hi) + 1, MAX_Q, CLEAR);
  };
  let knots: Knot[];
  if (spec.kind === "ramp") {
    const [d0, d1] = spec.domain ?? values.range ?? [0, 1];
    // A domain of one value colors that value and the next with the ramp, as the service does.
    const span = d1 - d0 || 1;
    const n = spec.colors.length;
    knots = linear(spec.colors.map((c, i) => [qr(d0 + (n > 1 ? (i * span) / (n - 1) : 0)), fill(c)]));
    if (spec.outside === "hide") hide(knots, Math.min(d0, d0 + span), Math.max(d0, d0 + span));
  } else if (spec.kind === "stops") {
    const stops = spec.stops;
    const end = fill(stops[stops.length - 1].color);
    if (spec.interpolate === "linear") knots = linear(stops.map((s) => [qr(s.value), fill(s.color)]));
    else {
      knots = [
        [1, end],
        [MAX_Q, end],
      ];
      // A value on a midpoint takes the lower stop.
      let start = 1;
      for (let i = 0; i < stops.length - 1; i++) {
        const until = last((stops[i].value + stops[i + 1].value) / 2);
        paint(knots, start, until, fill(stops[i].color));
        start = Math.max(start, until + 1);
      }
    }
    if (spec.outside === "hide") hide(knots, stops[0].value, stops[stops.length - 1].value);
  } else if (spec.kind === "classes") {
    knots = [
      [1, CLEAR],
      [MAX_Q, CLEAR],
    ];
    // Classes are [from, to), the first and last as far as `outside` lets them (`classReach`, a range not yet known
    // spread over the values); painted from the last, so the first that holds a value wins.
    const reach = classReach(spec, values.range);
    for (let i = spec.classes.length - 1; i >= 0; i--) {
      const { from, to, closed } = reach[i];
      paint(
        knots,
        from !== undefined ? first(from) : 1,
        to !== undefined ? (closed ? last(to) : first(to) - 1) : MAX_Q,
        fill(spec.classes[i].color)
      );
    }
  } else {
    const other = fill(spec.other);
    knots = [
      [1, other],
      [MAX_Q, other],
    ];
    // A category holds the values that round to it (none round to a fraction); the first of the same value wins.
    for (const k of [...spec.classes].reverse())
      if (Number.isInteger(k.value))
        paint(knots, first(k.value - 0.5), first(k.value + 0.5) - 1, fill(k.color, k.alpha));
  }
  // The style's no-data values, with the service's tolerance.
  for (const x of spec.noData) {
    const t = 1e-6 * Math.max(1, Math.abs(x));
    paint(knots, first(x - t), last(x + t), CLEAR);
  }
  const stops = apart([[0, CLEAR], ...knots], values.encoding);
  if (stops.length > MAX_RELIEF_STOPS) return null;
  return stops.map(([q, color]) => [q, css(color)]);
}

/** The color the map draws at `value` with the relief stops it was given (`reliefColor`): linear between stops over
 * premultiplied colors, as MapLibre interpolates them, the end colors beyond; "#rrggbb", or null where it draws
 * nothing (transparent). */
export function reliefColorAt(stops: ReliefStop[], values: RasterValues, value: number): string | null {
  if (!stops.length || !Number.isFinite(value)) return null;
  const q = (value + values.encoding.baseShift) / values.encoding.blueFactor;
  const rgba = (color: string): Rgba => {
    const [r, g, b, a] = (color.match(/[\d.]+/g) ?? []).map(Number);
    return [r ?? 0, g ?? 0, b ?? 0, a ?? 1];
  };
  let i = stops.findIndex(([at]) => at >= q);
  if (i === -1) i = stops.length - 1;
  const [qb, cb] = stops[i];
  const [qa, ca] = stops[Math.max(0, i - 1)];
  const t = i === 0 || qb === qa || q >= qb ? 1 : (q - qa) / (qb - qa);
  const [a0, b0] = [rgba(ca), rgba(cb)];
  const alpha = a0[3] + (b0[3] - a0[3]) * t;
  if (!(alpha > 0)) return null;
  const channel = (k: number) =>
    Math.round((a0[k] * a0[3] + (b0[k] * b0[3] - a0[k] * a0[3]) * t) / alpha)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** The `color-relief-color` of stops: each code's value as the source decodes it, raised `k` times with the source
 * (`verticalScale`). */
export function reliefColor(stops: ReliefStop[], values: RasterValues, k = 1): unknown[] {
  const base = -values.encoding.baseShift;
  const step = values.encoding.blueFactor;
  return [
    "interpolate",
    ["linear"],
    ["elevation"],
    ...stops.flatMap(([q, color]) => [(base + q * step) * k, color]),
  ];
}

/** The relief a hillshade's source raises a band's relief to at most, and the most it raises it. */
const RAISED_RELIEF = 1000;
const MAX_RAISE = 16;

/** How many times a hillshade's source raises the heights of a band of `range` (minimum and maximum) before MapLibre
 * shades them (spec 9.6): MapLibre keeps the slopes in 8 bits before `hillshade-exaggeration` acts, so the slopes of
 * flat terrain are lost unless the heights are raised first. The largest power of two that keeps the relief within
 * `RAISED_RELIEF`, at most `MAX_RAISE`; 1 for an unknown range. A power of two, so the raised codes decode exactly
 * (float32 products by a power of two are exact) and the colors on the same source stay on their codes. */
export function verticalScale(range: [number, number] | null): number {
  const relief = range ? range[1] - range[0] : 0;
  if (!(relief > 0) || !Number.isFinite(relief)) return 1;
  return Math.min(MAX_RAISE, Math.max(1, 2 ** Math.floor(Math.log2(RAISED_RELIEF / relief))));
}
