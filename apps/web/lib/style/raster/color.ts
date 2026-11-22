// The coloring of a raster file (spec 9): a style's render resolved into what the raster service colors cells with
// (goatlib.raster.token, same keys). Palettes become colors and class colors come from the palette here, so the
// service needs no palette catalog; class names and legend texts never travel.
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";
import { paletteColors, paletteSteps } from "@/lib/style/palettes";
import type { BandFacts } from "@/lib/style/raster/values";

type Outside = "clamp" | "hide";
/** A band number, or a band formula's expression. */
type Band = number | string;

/** How the cells are colored. A color of null draws nothing (a hidden class). */
export type RasterColorSpec =
  | {
      kind: "ramp";
      band: Band;
      noData: number[];
      colors: string[];
      /** null: the band's minimum and maximum, until the style's domain is computed. */
      domain: [number, number] | null;
      outside: Outside;
    }
  | {
      kind: "stops";
      band: Band;
      noData: number[];
      stops: Array<{ value: number; color: string }>;
      interpolate: "linear" | "nearest";
      outside: Outside;
    }
  | {
      kind: "classes";
      band: Band;
      noData: number[];
      /** With `clamp` the first and last class are open (their outer `from` and `to` are left out); with `hide` they
       * end at their own `from` and `to`, else at `domain`, else at the band's minimum and maximum, the last one holding
       * its end (`classReach`). */
      classes: Array<{ from?: number; to?: number; color: string | null }>;
      /** null: the band's minimum and maximum; only `hide` reads it. */
      domain: [number, number] | null;
      outside: Outside;
    }
  | {
      kind: "categories";
      band: Band;
      noData: number[];
      /** `alpha` (0 to 1): an entry of the file's color table drawn partly transparent (`tableColorSpec`). */
      classes: Array<{ value: number; color: string | null; alpha?: number }>;
      other: string | null;
    }
  /** bands null: the file as it is (its color table, bands 1 to 3, or one band in grey from its minimum to maximum). */
  | { kind: "rgb"; bands: [number, number, number] | null; noData: number[] };

/** A class without a color of its own (the panel's color for a new category). */
const CLASS_GRAY = "#9aa3ad";

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A hex color's red, green and blue (`#rgb` or `#rrggbb`). */
export const rgbOf = (hex: string): [number, number, number] => {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
};

/** The band a render colors: a number, or a formula's expression; null when it is neither. */
function bandOf(render: JsonObject): Band | null {
  const band = render.band ?? 1;
  if (num(band)) return band;
  if (isObject(band) && typeof band.expression === "string" && band.expression.trim()) return band.expression;
  return null;
}

/** The domain a ramp colors over: the author's, else the computed one (spec 12), else null. */
function domainOf(render: JsonObject): [number, number] | null {
  const given = Array.isArray(render.domain) ? render.domain : null;
  const computed =
    isObject(render.computed) && Array.isArray(render.computed.domain) ? render.computed.domain : null;
  const domain = given ?? computed;
  return domain && domain.length === 2 && domain.every(num) ? (domain as [number, number]) : null;
}

/** A minimum and maximum, where it reads as one. */
const span = (d: unknown): [number, number] | undefined =>
  Array.isArray(d) && d.length === 2 && d.every(num) && d[0] <= d[1] ? [d[0], d[1]] : undefined;

/** What the cells a render colors hold: its band's minimum and maximum from the file's statistics (`info`), else the
 * values the map loaded (`range`, the value tiles' description: the band's statistics, or a formula's sample). */
export interface RasterDataRange {
  info?: { stats: Array<{ index: number; min: number | null; max: number | null }> };
  range?: readonly number[] | null;
}

/** A domain as its lowest and highest value (a reversed domain covers the same values). */
const sorted = (d: unknown): [number, number] | undefined =>
  Array.isArray(d) && d.length === 2 && d.every(num)
    ? [Math.min(d[0], d[1]), Math.max(d[0], d[1])]
    : undefined;

/** The minimum and maximum that close a raster class list's open first and last class wherever their names show (the
 * legend, the popup's class, the panel's rows), as the map draws them. With the end colors outside (`clamp`) the first
 * and last class hold every cell beyond, so the ends read the data's: the band's (`data`), else the range the check
 * computed. With `outside: "hide"` they read where the drawing stops: the first class's own `from` and the last
 * class's own `to`, else the color range (`domain`, else the computed one), else the data's. Undefined where none is
 * known: the ends read by their bound alone ("Under 49.4", "101.6 and more"). */
export function classEnds(render: JsonObject, data: RasterDataRange = {}): [number, number] | undefined {
  const band = render.band ?? 1;
  const stats = num(band) ? data.info?.stats.find((b) => b.index === band) : undefined;
  const computed = isObject(render.computed) ? render.computed.domain : undefined;
  const values = span(stats ? [stats.min, stats.max] : undefined) ?? span(data.range) ?? span(computed);
  if (render.outside !== "hide") return values;
  const range = sorted(render.domain) ?? sorted(computed) ?? values;
  const written =
    isObject(render.classify) && Array.isArray(render.classify.classes) ? render.classify.classes : [];
  const classes = written.filter(isObject);
  const first = classes[0]?.from;
  const last = classes[classes.length - 1]?.to;
  const lo = num(first) ? first : range?.[0];
  const hi = num(last) ? last : range?.[1];
  return lo !== undefined && hi !== undefined ? [lo, hi] : undefined;
}

/** Where each class of a coloring's classes starts and ends as the map draws them (goatlib.raster.color `_classes`):
 * `[from, to)`; with `clamp` the first and last class are open; with `hide` they end at their own `from` and `to`, else
 * at the coloring's domain, else at `range` (the band's minimum and maximum), and the last one holds its end
 * (`closed`). An end that stays unknown is open. */
export function classReach(
  spec: { classes: Array<{ from?: number; to?: number }>; domain: [number, number] | null; outside: Outside },
  range?: readonly number[] | null
): Array<{ from?: number; to?: number; closed: boolean }> {
  const hide = spec.outside === "hide";
  const ends = sorted(spec.domain) ?? sorted(range);
  const last = spec.classes.length - 1;
  return spec.classes.map((c, i) => {
    const outerFrom = i === 0;
    const outerTo = i === last;
    const from = outerFrom ? (hide ? (c.from ?? ends?.[0]) : undefined) : c.from;
    const to = outerTo ? (hide ? (c.to ?? ends?.[1]) : undefined) : c.to;
    return { from, to, closed: hide && outerTo && to !== undefined };
  });
}

/** The color of each class of a raster classification (spec 9.4), hidden ones too: its own, else the color goatlib
 * compute writes into it (`paletteSteps`, as its `sample_colors`) from the classification's own palette and reverse,
 * else the render's `palette` and `reverse`. The map's colors (`rasterColorSpec`) and the panel's (its classes, strip
 * and histogram) both. */
export function classColors(classify: JsonObject, palette: string | string[], reverse: unknown): string[] {
  const written = (Array.isArray(classify.classes) ? classify.classes : []).filter(isObject);
  const own = classify.palette !== undefined && classify.palette !== null;
  const steps = paletteSteps((own ? classify.palette : palette) as string | string[], written.length, {
    reverse: (own ? classify.reverse : reverse) === true,
  });
  return written.map((c, i) => (typeof c.color === "string" ? c.color : (steps[i] ?? CLASS_GRAY)));
}

/** The coloring of a raster render; null for shading without colors (hillshade without a palette). */
export function rasterColorSpec(render: JsonObject): RasterColorSpec | null {
  const noData =
    isObject(render.no_data) && Array.isArray(render.no_data.values) ? render.no_data.values.filter(num) : [];
  if (render.type === "image" || render.type === undefined) {
    const given = Array.isArray(render.bands) ? render.bands.filter(num) : [];
    return { kind: "rgb", bands: given.length === 3 ? (given as [number, number, number]) : null, noData };
  }
  const band = bandOf(render);
  if (band === null) return null;
  if (render.type === "categorical") {
    const classes = (Array.isArray(render.classes) ? render.classes : [])
      .filter(isObject)
      .filter((c) => num(c.value));
    // Without classes the file draws as stored (its color table).
    if (!classes.length) return { kind: "rgb", bands: null, noData };
    return {
      kind: "categories",
      band,
      noData,
      classes: classes.map((c) => ({
        value: c.value as number,
        color: c.visible === false ? null : typeof c.color === "string" ? c.color : CLASS_GRAY,
      })),
      other: typeof render.other_color === "string" ? render.other_color : null,
    };
  }
  if (render.type !== "continuous" && render.type !== "hillshade") return null;
  const outside: Outside = render.outside === "hide" ? "hide" : "clamp";
  if (render.type === "continuous" && Array.isArray(render.stops)) {
    const stops = render.stops
      .filter(isObject)
      .filter((s) => num(s.value) && typeof s.color === "string")
      .map((s) => ({ value: s.value as number, color: s.color as string }))
      .sort((a, b) => a.value - b.value);
    if (!stops.length) return null;
    return {
      kind: "stops",
      band,
      noData,
      stops,
      interpolate: render.interpolate === "nearest" ? "nearest" : "linear",
      outside,
    };
  }
  // Hillshade is colored only with a palette; continuous defaults to the reference palette.
  const fallback = render.type === "continuous" ? (DEFAULTS["continuous.palette"] as string) : undefined;
  const palette = (render.palette ?? fallback) as string | string[] | undefined;
  if (palette === undefined) return null;
  const domain = domainOf(render);
  const classify = isObject(render.classify) ? render.classify : null;
  const written = (classify && Array.isArray(classify.classes) ? classify.classes : []).filter(isObject);
  const manual = (classify?.method ?? "manual") === "manual";
  // Computed classes draw once the server filled their bounds, or computed a single class, which has none (geometric
  // intervals over values at or below 0); until then the color range stands in.
  const bounded =
    written.length > 0 &&
    (manual ||
      (written.length === 1 && isObject(classify?.computed)) ||
      written.some((c) => num(c.from) || num(c.to)));
  if (classify && bounded) {
    const colors = classColors(classify, palette, render.reverse);
    const hide = outside === "hide";
    const last = written.length - 1;
    return {
      kind: "classes",
      band,
      noData,
      // With the end colors outside, the first and last class are open whatever ends they carry.
      classes: written.map((c, i) => ({
        ...(num(c.from) && (i > 0 || hide) ? { from: c.from } : {}),
        ...(num(c.to) && (i < last || hide) ? { to: c.to } : {}),
        color: c.visible === false ? null : colors[i],
      })),
      domain: hide ? domain : null,
      outside,
    };
  }
  const colors = paletteColors(palette);
  if (!colors.length) return null;
  return {
    kind: "ramp",
    band,
    noData,
    colors: render.reverse === true ? [...colors].reverse() : colors,
    domain,
    outside,
  };
}

/** The image adjustments (spec 9.1), which MapLibre applies to an image's colors. */
const ADJUSTMENT_KEYS = ["brightness", "contrast", "saturation", "hue"] as const;

/** The coloring of an image drawn with its file's color table (spec 9.1) as the map draws it: the codes of the band the
 * table colors, read from value tiles nearest, each entry's code in its color (an entry drawn partly transparent with
 * its alpha), codes without an entry, and entries drawn fully transparent, left out (geoapi leaves those out of
 * `palette`), and the style's no data too. Drawn so, the map holds every cell's code, also where entries share a
 * color. The colors are the table's own: an image's adjustments go onto them where they are drawn
 * (compile/rasters.ts). Categories without classes draw the file as stored (`rasterColorSpec`), so the same where
 * their band is the one the table colors.
 * Null for anything else: other renders, chosen bands, a file without a table or with one geoapi does not describe
 * (scaled values, over 256 entries), before the file's band facts are known (`facts`: the colored tiles' description's,
 * or the info's), and an image's adjustments that vary by zoom, which a color cannot follow (null is none): those
 * images draw the raster service's colored tiles. */
export function tableColorSpec(
  style: JsonObject,
  facts: Partial<BandFacts> | undefined
): Extract<RasterColorSpec, { kind: "categories" }> | null {
  const render: JsonObject = isObject(style.render) ? style.render : { type: "image" };
  const image = render.type === "image" || render.type === undefined;
  if (!image && !(render.type === "categorical" && rasterColorSpec(render)?.kind === "rgb")) return null;
  const palette = facts?.colorTable && facts.scaled !== true ? facts.palette : undefined;
  if (!palette || !Object.keys(palette.colors).length) return null;
  if (Array.isArray(render.bands) && render.bands.filter(num).length === 3) return null;
  // Categories read their own band: the table's codes only where that is the band the table colors (geoapi draws any
  // other band through the table from its colored tiles).
  if (!image && (render.band ?? 1) !== palette.band) return null;
  if (image && ADJUSTMENT_KEYS.some((key) => style[key] != null && !num(style[key]))) return null;
  const noData =
    isObject(render.no_data) && Array.isArray(render.no_data.values) ? render.no_data.values.filter(num) : [];
  const classes = Object.entries(palette.colors)
    .map(([code, color]) => {
      const alpha = palette.alphas?.[Number(code)];
      return { value: Number(code), color, ...(alpha !== undefined ? { alpha } : {}) };
    })
    .sort((a, b) => a.value - b.value);
  return { kind: "categories", band: palette.band, noData, classes, other: null };
}
