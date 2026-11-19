// Value tiles (goatlib.raster.values): geoapi sends a band's or a formula's cells as codes in RGB, `q = R * 65536 +
// G * 256 + B`, code 0 for no data and `base + q * step` for a value, and MapLibre colors them in the browser: a
// `raster-dem` source with the custom encoding under a `color-relief` layer. A color edit is a paint change; the tiles
// stay. The coloring comes from `rasterColorSpec`, placed here on the codes as stops.
import { type JsonObject, isObject } from "@/lib/style/json";
import { type RasterColorSpec, rasterColorSpec, rgbOf } from "@/lib/style/raster/color";

/** The largest code (24 bits). */
export const MAX_Q = 16_777_215;
/** The most stops a color-relief layer is given (WebGL 2 guarantees textures 2048 wide, common graphics cards 8192 or
 * more); a coloring that needs more draws from image tiles. */
export const MAX_RELIEF_STOPS = 4096;

/** A tileset description of value tiles (its `goat:values` and native zoom). */
export interface RasterValues {
  /** The `raster-dem` source's custom encoding: `base = -baseShift`, `step = blueFactor`. */
  encoding: { redFactor: number; greenFactor: number; blueFactor: number; baseShift: number };
  /** The band's (or formula's) minimum and maximum: a ramp without a domain spreads over it. */
  range: [number, number] | null;
  /** Whether the codes hold whole numbers exactly. */
  integer: boolean;
  /** Changes with the file and the encoding, never with the style. */
  version: string;
  maxzoom?: number;
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

/** How a raster style draws its cells past their resolution (spec 9): the style's `resampling`, else crisp cells for a
 * color scale (continuous, categorical, a hillshade's colors) and smooth ones for images and shading alone. */
export function resamplingOf(style: JsonObject): "linear" | "nearest" {
  if (style.resampling === "nearest" || style.resampling === "linear") return style.resampling;
  const render: JsonObject = isObject(style.render) ? style.render : { type: "image" };
  if (render.type === "continuous" || render.type === "categorical") return "nearest";
  return render.type === "hillshade" && rasterColorSpec(render) !== null ? "nearest" : "linear";
}

/** The values a raster style colors in the browser; null for images (categories without classes too). */
export function valueQuery(style: JsonObject): ValueQuery | null {
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
];

/** The URL of the tileset description of a raster's value tiles (`coverage`: its coverage tileset). */
export function valuesUrl(coverage: string, query: ValueQuery, version?: string): string {
  return `${coverage}?${queryString([...readParams(query), ["v", version]])}`;
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
  return {
    encoding: { redFactor, greenFactor, blueFactor, baseShift },
    range: range as [number, number] | null,
    integer: values.integer,
    version: values.version,
    ...(num(json.maxzoom) ? { maxzoom: json.maxzoom } : {}),
  };
}

type Rgba = [number, number, number, number];
/** A code and its color; colors are linear between knots, the end colors hold beyond them. */
type Knot = [q: number, color: Rgba];

const CLEAR: Rgba = [0, 0, 0, 0];

const fill = (color: string | null): Rgba => (color === null ? CLEAR : [...rgbOf(color), 1]);

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
    // Classes are [from, to); painted from the last, so the first that holds a value wins.
    for (const k of [...spec.classes].reverse())
      paint(
        knots,
        k.from !== undefined ? first(k.from) : 1,
        k.to !== undefined ? first(k.to) - 1 : MAX_Q,
        fill(k.color)
      );
  } else {
    const other = fill(spec.other);
    knots = [
      [1, other],
      [MAX_Q, other],
    ];
    // A category holds the values that round to it (none round to a fraction); the first of the same value wins.
    for (const k of [...spec.classes].reverse())
      if (Number.isInteger(k.value))
        paint(knots, first(k.value - 0.5), first(k.value + 0.5) - 1, fill(k.color));
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

/** The `color-relief-color` of stops: each code's value as the source decodes it. */
export function reliefColor(stops: ReliefStop[], values: RasterValues): unknown[] {
  const base = -values.encoding.baseShift;
  const step = values.encoding.blueFactor;
  return [
    "interpolate",
    ["linear"],
    ["elevation"],
    ...stops.flatMap(([q, color]) => [base + q * step, color]),
  ];
}
