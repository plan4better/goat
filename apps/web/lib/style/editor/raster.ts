// Raster render choices of the panel (spec 9): which renders fit a file, how each starts, and its classes by method:
// equal classes over a range, or the breaks the raster service computed for the band.
import { CLASS_COUNTS, MAX_CLASS_COUNT } from "@/lib/style/editor/classify";
import { getIn, setIn } from "@/lib/style/editor/paths";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { paletteSteps } from "@/lib/style/palettes";
import { bandOrFormula } from "@/lib/style/raster/formula";
import {
  type RasterInfo,
  type ValueSample,
  bandBreaks,
  bandRange,
  sampleOf,
  seedDomain,
  valueBands,
} from "@/lib/style/raster/metadata";

export type RasterRenderType = "hillshade" | "continuous" | "categorical" | "image";

/** The panel's palette for new categories. */
const CATEGORY_PALETTE = "colorbrewer:Set3";

/** The renders a file allows, none until its info answered: hillshade on one band of elevation (an alpha band beside
 * it is no band of values), a color range on any band without a color table, categories on whole-number cells, the
 * image always. */
export function drawAsOptions(info: RasterInfo | undefined): RasterRenderType[] {
  if (!info) return [];
  const out: RasterRenderType[] = [];
  if (valueBands(info).length === 1 && !info.colorTable) out.push("hillshade");
  if (!info.colorTable) out.push("continuous");
  if (info.integer) out.push("categorical");
  out.push("image");
  return out;
}

/** One category per code `band` holds (the raster service's distinct values, at most `limit`: as many as a
 * classification's All values), each in the file's color table color for it, else the palette's colors in order; named
 * by its code. Null where the codes are not known (float cells, or too many codes to list). */
export function categoriesOf(
  info: RasterInfo | undefined,
  band = 1,
  limit = MAX_CLASS_COUNT
): Array<{ value: number; color: string }> | null {
  const values = info?.stats.find((b) => b.index === band)?.values;
  if (!values?.length) return null;
  const codes = values.slice(0, limit);
  const colors = paletteSteps(CATEGORY_PALETTE, Math.min(codes.length, 12));
  return codes.map((value, i) => ({
    value,
    color: info?.tableColors?.[value] ?? colors[i % colors.length],
  }));
}

/** A render of `type` from what is known about the file: a color range gets a written range (the browser cannot
 * compute one), categories the band's codes; everything else stays at its defaults. */
export function defaultRender(
  type: RasterRenderType,
  opts: {
    info?: RasterInfo;
    sample?: ValueSample | null;
    stops?: Array<{ value: number }>;
    band?: number;
  } = {}
): JsonObject {
  if (type === "continuous") {
    const domain = opts.info ? seedDomain(opts.sample ?? null, opts.info, opts.stops) : null;
    return domain ? { type, domain } : { type };
  }
  if (type === "categorical") {
    const classes = categoriesOf(opts.info, opts.band);
    return classes ? { type, classes } : { type };
  }
  return { type };
}

/** `count` classes of equal width over a range (spec 9.4 manual classes), the breaks rounded to two digits of the
 * class width: the first class has no `from`, the last no `to`. */
export function equalClasses(domain: [number, number], count: number): Array<{ from?: number; to?: number }> {
  const [d0, d1] = domain;
  const width = (d1 - d0) / count;
  const decimals = width === 0 ? 0 : Math.max(0, 1 - Math.floor(Math.log10(Math.abs(width))));
  const round = (x: number) => Number(x.toFixed(decimals));
  const breaks = Array.from({ length: count - 1 }, (_, i) => round(d0 + (i + 1) * width));
  return Array.from({ length: count }, (_, i) => ({
    ...(i > 0 ? { from: breaks[i - 1] } : {}),
    ...(i < count - 1 ? { to: breaks[i] } : {}),
  }));
}

/** The ways of coloring that cover `render.domain`; every other method classifies the whole band. */
export const RANGED_METHODS: readonly string[] = ["continuous", "equal_interval", "manual"];

/** The methods whose breaks the raster service computes for each band (goatlib `BREAK_METHODS`). */
export const BREAK_METHODS: readonly string[] = [
  "quantile",
  "natural_breaks",
  "std_dev",
  "geometric_interval",
];

/** Whether `band` rules geometric intervals out: they need every value above 0 (spec 5.8), and its statistics (a
 * formula's, where the info was asked for it) say it reaches 0 or below. A band or formula whose statistics are not
 * known yet has no precomputed breaks instead. */
export function geometricRefused(info: RasterInfo | undefined, band: unknown): boolean {
  const range = bandRange(info, bandOrFormula(band));
  return range !== null && range[0] <= 0;
}

/** A number as a style check writes it: twelve significant digits (goatlib `stable`). */
const stable = (x: number) => Number(x.toPrecision(12));

/** Classes from inner breaks: the first open below, the last open above; one class without breaks. */
export function classesFromBreaks(breaks: number[]): Array<{ from?: number; to?: number }> {
  return Array.from({ length: breaks.length + 1 }, (_, i) => ({
    ...(i > 0 ? { from: breaks[i - 1] } : {}),
    ...(i < breaks.length ? { to: breaks[i] } : {}),
  }));
}

/** `count` equal classes over a range as a style check computes them (goatlib `compute_raster_stats`), so the saved
 * classes are the ones the panel wrote: unrounded, to twelve digits; on a band of whole numbers (`whole`) each break
 * rounded half up, breaks that round together kept once (fewer classes). */
export function equalIntervalClasses(
  [d0, d1]: [number, number],
  count: number,
  whole = false
): Array<{ from?: number; to?: number }> {
  const raw = Array.from({ length: count - 1 }, (_, i) => {
    const b = stable(d0 + ((i + 1) * (d1 - d0)) / count);
    return whole ? Math.floor(b + 0.5) : b;
  });
  const low = stable(d0);
  const high = stable(d1);
  return classesFromBreaks([...new Set(raw)].filter((b) => low < b && b < high).sort((a, b) => a - b));
}

/** Whether `band` holds whole numbers as it is read (goatlib `whole_number_values`): an integer data type, neither
 * scaled nor offset, and a band rather than a formula (a formula of one band alone, `b2`, is that band). Its computed
 * class breaks are whole numbers (spec 9.4). */
export function wholeBand(info: RasterInfo | undefined, band: unknown): boolean {
  const plain =
    typeof band === "number" ||
    (isObject(band) && typeof band.expression === "string" && /^b\d+$/.test(band.expression.trim()));
  return plain && info?.integer === true && info.scaled !== true;
}

/** The class counts `method` offers on `band`: those the raster service computed breaks for (3 to 13; for a band
 * formula, where the info was asked for it); 2 to 13 for equal intervals and manual breaks, which need no breaks. */
export function breakCounts(info: RasterInfo | undefined, band: unknown, method: string): number[] {
  if (!BREAK_METHODS.includes(method)) return [...CLASS_COUNTS];
  if (typeof band !== "number") return [];
  return CLASS_COUNTS.filter((n) => bandBreaks(info, band, method, n) !== undefined);
}

/** A class's own settings (spec 9.4: they survive a recompute by position): its name, visibility, legend and a color
 * picked by hand; a color the server wrote with the classes (`computed.generated`) is the palette's and goes. */
function ownSettings(classify: JsonObject, record: unknown): JsonObject {
  if (!isObject(record)) return {};
  const generated = isObject(classify.computed) ? classify.computed.generated : undefined;
  const written =
    isObject(generated) && generated.target === "color" && isObject(generated.values) ? generated.values : {};
  const byServer = typeof record.id === "string" && written[record.id] === record.color;
  return {
    ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
    ...(typeof record.color === "string" && !byServer ? { color: record.color } : {}),
    ...(record.visible === false ? { visible: false } : {}),
    ...(record.legend === false ? { legend: false } : {}),
  };
}

/** The range a color range or its equal or manual classes cover: the written one, else the band's 2nd to 98th
 * percentile as Draw as Color range starts it (`seedDomain`, so a switch back from a method without a range of its own
 * does not spread the colors over the band's outliers), else the range the check computed, else the band's minimum and
 * maximum. */
function classRange(render: JsonObject, info: RasterInfo | undefined): [number, number] | null {
  const given = Array.isArray(render.domain) ? render.domain : null;
  if (given && given.length === 2 && given.every((v) => typeof v === "number"))
    return given as [number, number];
  const band = render.band ?? 1;
  const seeded = typeof band === "number" && info ? seedDomain(sampleOf(info, band), info) : null;
  if (seeded) return seeded;
  const computed =
    isObject(render.computed) && Array.isArray(render.computed.domain) ? render.computed.domain : null;
  if (computed && computed.length === 2 && computed.every((v) => typeof v === "number"))
    return computed as [number, number];
  return typeof band === "number" ? bandRange(info, band) : null;
}

/** The color range's render with its colors by `method` in `count` classes (spec 9.4), written by the panel at once:
 * `continuous` without classes; equal intervals over the range (written, so the check splits the same one); quantiles,
 * natural breaks and standard deviation from the breaks the raster service computed for the band, without a range (they
 * classify the whole band, and the check then writes the band's minimum and maximum, which close the first and last
 * class in labels and the legend); manual breaks keep the classes there are when there are `count` of them, else start
 * as equal classes. A palette, equal and manual classes without a written range get one (`classRange`). What the
 * author set on a class stays by position. */
export function rasterClassesRender(
  render: JsonObject,
  method: string,
  count: number,
  info: RasterInfo | undefined
): JsonObject {
  const next: JsonObject = { ...render };
  const before = isObject(render.classify) ? render.classify : {};
  const old = Array.isArray(before.classes) ? before.classes : [];
  delete next.classify;
  const written = classRange(render, info);
  // A palette, equal and manual classes cover a range: one is written where the render has none (after quantiles).
  if (RANGED_METHODS.includes(method) && !Array.isArray(render.domain) && written) next.domain = written;
  if (method === "continuous") return next;
  const own: JsonObject = {
    ...(before.palette !== undefined ? { palette: before.palette } : {}),
    ...(before.reverse !== undefined ? { reverse: before.reverse } : {}),
  };
  const settle = (bounds: Array<{ from?: number; to?: number }>) =>
    bounds.map((b, i) => ({ ...b, ...ownSettings(before, old[i]) }));
  const range = written ?? [0, 1];
  if (method === "manual") {
    const kept = old.filter(isObject).filter((c) => typeof c.from === "number" || typeof c.to === "number");
    const bounds =
      kept.length === count
        ? kept.map((c) => ({
            ...(typeof c.from === "number" ? { from: c.from } : {}),
            ...(typeof c.to === "number" ? { to: c.to } : {}),
          }))
        : equalClasses(range, count);
    next.classify = { method, ...own, classes: settle(bounds) };
    return next;
  }
  if (method === "equal_interval") {
    next.domain = range;
    next.classify = {
      method,
      count,
      ...own,
      classes: settle(equalIntervalClasses(range, count, wholeBand(info, render.band ?? 1))),
    };
    return next;
  }
  const breaks =
    typeof render.band === "object"
      ? undefined
      : bandBreaks(info, (render.band as number) ?? 1, method, count);
  delete next.domain;
  next.classify = {
    method,
    count,
    ...own,
    ...(breaks ? { classes: settle(classesFromBreaks(breaks)) } : {}),
  };
  return next;
}

/** The render with the first class's lower end (`from`) or the last class's upper end (`to`) typed by hand, as the
 * panel offers them while values outside are left out (spec 9.4): the classes become manual and keep their inner breaks
 * and what the author set on them, nothing is computed again. An end on the wrong side of its class's other bound
 * changes nothing. */
export function setOuterEnd(render: JsonObject, end: "from" | "to", value: number): JsonObject {
  const old = classesOf(render);
  if (!old.length) return render;
  const last = old.length - 1;
  const other = end === "from" ? old[0].to : old[last].from;
  if (typeof other === "number" && (end === "from" ? value >= other : value <= other)) return render;
  return asManual(render, (i) => ({
    ...(end === "from" && i === 0 ? { from: value } : {}),
    ...(end === "to" && i === last ? { to: value } : {}),
  }));
}

const classesOf = (render: JsonObject): JsonObject[] => {
  const classify = isObject(render.classify) ? render.classify : {};
  return (Array.isArray(classify.classes) ? classify.classes : []).filter(isObject);
};

/** The render's classes as manual breaks, with the bounds `edit` gives class `i` in place of its own; their own
 * settings kept, the server's colors and `computed` gone (the palette gives the same colors). */
function asManual(render: JsonObject, edit: (i: number) => { from?: number; to?: number }): JsonObject {
  const before = isObject(render.classify) ? render.classify : {};
  const classes = classesOf(render).map((c, i) => ({
    ...(typeof c.from === "number" ? { from: c.from } : {}),
    ...(typeof c.to === "number" ? { to: c.to } : {}),
    ...edit(i),
    ...ownSettings(before, c),
  }));
  return {
    ...render,
    classify: {
      method: "manual",
      ...(before.palette !== undefined ? { palette: before.palette } : {}),
      ...(before.reverse !== undefined ? { reverse: before.reverse } : {}),
      classes,
    },
  };
}

/** Whether no-data values change the drawing (spec 9): not where the file draws itself, by its color table,
 * as categories without classes or as plain hillshade. */
export function noDataApplies(render: JsonObject, info: RasterInfo | undefined): boolean {
  const type = render.type ?? "image";
  if (type === "image") return !info?.colorTable;
  if (type === "categorical") return Array.isArray(render.classes) && render.classes.length > 0;
  if (type === "hillshade") return render.palette !== undefined;
  return true;
}

/** The color range's `palette` or `reverse` set to `value`: a palette picked for classes takes every class, so the
 * classes' own palette and the colors picked by hand go. */
export function setRasterPalette(doc: LayerStyle, key: "palette" | "reverse", value: unknown): LayerStyle {
  const next = setIn(doc, `render.${key}`, value);
  const classify = getIn(next, "render.classify");
  if (!isObject(classify)) return next;
  const { palette: _palette, reverse: _reverse, ...rest } = classify;
  const classes = Array.isArray(rest.classes)
    ? rest.classes.map((c) => {
        if (!isObject(c)) return c;
        const { color: _color, ...kept } = c;
        return kept;
      })
    : rest.classes;
  return setIn(next, "render.classify", { ...rest, ...(classes !== undefined ? { classes } : {}) });
}
