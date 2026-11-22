// What the panel knows about a raster file (spec 9): its bands and their names, no-data value, color table and band
// statistics, from the raster service's info (geoapi `/collections/{id}/raster/info`, statistics from an overview).
import type { TFunction } from "i18next";

import type { BandFacts, Palette } from "@/lib/style/raster/values";

/** The raster service's info, as geoapi answers it. */
export interface RasterInfoResponse {
  width: number;
  height: number;
  bounds: [number, number, number, number];
  count: number;
  dtype: string;
  nodata: number | null;
  bits: number[];
  color_table: Record<string, number[]> | null;
  names: string[];
  /** Each band's color interpretation (GDAL's names); missing from older services. */
  color_interp?: string[];
  /** With a color table: the band it colors and the color (RGBA, by code) of every entry of the whole table, used or
   * not; null without a table, for scaled values or a table over 256 entries; missing from older services. */
  palette?: { band: number; colors: Record<string, number[]> } | null;
  scales: number[];
  offsets: number[];
  bands: Array<{
    index: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    std: number | null;
    p2: number | null;
    p98: number | null;
    histogram: { counts: number[]; edges: number[] };
    values: number[] | null;
    approximate: boolean;
    /** The cells holding each of `values`, in the same order; null where `values` is. */
    counts?: number[] | null;
    /** Inner class breaks by method and class count ("3" to "12"), over the same sample a style check classifies;
     * a list can be shorter than count - 1, or empty; `{}` for a band without values. */
    breaks?: BandBreaks;
  }>;
}

/** Inner class breaks by method (`quantile`, `natural_breaks`, `std_dev`, `geometric_interval`) and class count. */
export type BandBreaks = Record<string, Record<string, number[]>>;

export interface BandStats {
  index: number;
  min: number | null;
  max: number | null;
  p2: number | null;
  p98: number | null;
  /** The distinct values of a whole-number band with few of them. */
  values: number[] | null;
  /** The cells holding each of `values`, in the same order. */
  counts?: number[] | null;
  mean?: number | null;
  std?: number | null;
  /** Cell counts per bin and the bins' edges (one more than the counts), over the band's minimum to maximum. */
  histogram?: { counts: number[]; edges: number[] };
  breaks?: BandBreaks;
}

export interface RasterInfo {
  bands: number;
  bits: number[];
  noData?: number;
  colorTable: boolean;
  /** The color table's color per cell value, when the file has one. */
  tableColors?: Record<number, string>;
  /** Whole-number cells. */
  integer: boolean;
  /** The cells' data type, as the file stores them ("uint8", "float32", ...). */
  dtype?: string;
  /** Whether the file scales or offsets its bands' stored values. */
  scaled?: boolean;
  /** The file's description of each band, in band order; "" where it has none. */
  names?: string[];
  /** Each band's color interpretation, in band order (`BandFacts.colorInterp`). */
  colorInterp?: string[];
  /** With a color table: its entries' colors (`BandFacts.palette`). */
  palette?: Palette;
  stats: BandStats[];
}

const hex = (rgb: number[]) =>
  `#${rgb
    .slice(0, 3)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;

/** A band's own name; the service names a band without a description "Band <n>", which is none. */
export const fileName = (name: string | undefined, band: number): string =>
  !name || name === `Band ${band}` ? "" : name;

/** A band's label: the file's name for it (the info's, or a value tiles description's), else "Band <n>" in the
 * reader's language. */
export function bandLabel(info: Pick<RasterInfo, "names"> | undefined, band: number, t: TFunction): string {
  return info?.names?.[band - 1] || t("style_editor.band_n", { n: band });
}

/** The band facts of each info read, one object per info: the popup's color cache keys on them (raster/popup.ts). */
const factsKept = new WeakMap<RasterInfo, BandFacts>();

/** The facts that tell whether an image's pixels are its values (`imagePixels`), from the file's info; undefined
 * where the info does not tell its data type or scaling. The same object for the same info. */
export function bandFactsOf(info: RasterInfo | undefined): BandFacts | undefined {
  if (!info || info.dtype === undefined || info.scaled === undefined) return undefined;
  const kept = factsKept.get(info);
  if (kept) return kept;
  const facts: BandFacts = {
    count: info.bands,
    dtype: info.dtype,
    scaled: info.scaled,
    colorTable: info.colorTable,
    valueBands: valueBands(info),
    ...(info.colorInterp ? { colorInterp: info.colorInterp } : {}),
    ...(info.palette ? { palette: info.palette } : {}),
  };
  factsKept.set(info, facts);
  return facts;
}

const RGB = ["red", "green", "blue"] as const;

/** The bands an image draws, red, green and blue (goatlib `image_bands`): the three the style chooses (`bands`); else
 * the value bands its file marks red, green and blue, in that order, where it marks all three; else its first three
 * value bands, or its first. Null while the file is not known (its description or info has not loaded): nothing is
 * assumed. */
export function imageBands(
  chosen: unknown,
  facts: Pick<BandFacts, "count" | "valueBands" | "colorInterp"> | undefined
): number[] | null {
  const given = Array.isArray(chosen) ? chosen.filter((b): b is number => Number.isInteger(b)) : [];
  if (given.length === 3) return given;
  if (!facts) return null;
  const values = facts.valueBands ?? Array.from({ length: facts.count }, (_, i) => i + 1);
  const interp = facts.colorInterp ?? [];
  // The last band marked a color wins, as in goatlib.
  const marked = new Map(values.map((b) => [interp[b - 1], b] as const));
  if (RGB.every((c) => marked.has(c))) return RGB.map((c) => marked.get(c)!);
  return values.length >= 3 ? values.slice(0, 3) : values.slice(0, 1);
}

/** What `imageBands` reads from the file's info: its bands of values and their color interpretation; undefined
 * before the info has answered. */
export const drawingFacts = (
  info: RasterInfo | undefined
): Pick<BandFacts, "count" | "valueBands" | "colorInterp"> | undefined =>
  info ? { count: info.bands, valueBands: valueBands(info), colorInterp: info.colorInterp } : undefined;

/** The bands' color interpretation as geoapi tells it (`color_interp`); undefined from an older one. */
export const colorInterpOf = (json: unknown): string[] | undefined =>
  Array.isArray(json) && json.every((c) => typeof c === "string") ? (json as string[]) : undefined;

/** The colors of a color table's entries as geoapi tells them (`palette`: RGBA by code), without the entries drawn
 * fully transparent (never drawn), the alpha of those drawn partly transparent apart; undefined without a table, or
 * of another shape. */
export function paletteOf(json: unknown): Palette | undefined {
  if (!json || typeof json !== "object") return undefined;
  const { band, colors } = json as { band?: unknown; colors?: unknown };
  if (!Number.isInteger(band) || !colors || typeof colors !== "object") return undefined;
  const out: Record<number, string> = {};
  const alphas: Record<number, number> = {};
  for (const [code, rgba] of Object.entries(colors)) {
    const valid =
      /^\d+$/.test(code) &&
      Array.isArray(rgba) &&
      rgba.length >= 3 &&
      rgba.slice(0, 3).every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
    if (!valid) return undefined;
    // An entry without alpha is drawn opaque (goatlib `_table`).
    const alpha = typeof rgba[3] === "number" ? rgba[3] : 255;
    if (alpha === 0) continue;
    out[Number(code)] = hex(rgba as number[]);
    if (alpha < 255) alphas[Number(code)] = Number((alpha / 255).toFixed(4));
  }
  return { band: band as number, colors: out, ...(Object.keys(alphas).length ? { alphas } : {}) };
}

/** The file's bands of values, by index: those with statistics. An alpha band (an orthophoto's transparency) is none,
 * though the file's band count includes it. Before the info has answered, none. */
export function valueBands(info: RasterInfo | undefined): number[] {
  if (!info) return [];
  return info.stats.length
    ? info.stats.map((s) => s.index)
    : Array.from({ length: info.bands }, (_, i) => i + 1);
}

export function rasterInfoOf(json: RasterInfoResponse): RasterInfo {
  const table = json.color_table;
  const colorInterp = colorInterpOf(json.color_interp);
  const palette = paletteOf(json.palette);
  return {
    bands: json.count,
    bits: json.bits,
    noData: json.nodata ?? undefined,
    colorTable: !!table,
    ...(table
      ? {
          tableColors: Object.fromEntries(
            Object.entries(table).map(([value, rgba]) => [Number(value), hex(rgba)])
          ),
        }
      : {}),
    integer: /^u?int/.test(json.dtype),
    dtype: json.dtype,
    scaled: json.scales.some((s) => s !== 1) || json.offsets.some((o) => o !== 0),
    names: Array.from({ length: json.count }, (_, i) => fileName(json.names[i], i + 1)),
    ...(colorInterp ? { colorInterp } : {}),
    ...(palette ? { palette } : {}),
    stats: json.bands.map((b) => ({
      index: b.index,
      min: b.min,
      max: b.max,
      p2: b.p2,
      p98: b.p98,
      values: b.values,
      counts: b.counts ?? null,
      mean: b.mean,
      std: b.std,
      histogram: b.histogram,
      breaks: b.breaks ?? {},
    })),
  };
}

/** The statistics of a band (its number) or of a band formula (its expression, when the info was asked for it). */
export function statsOf(info: RasterInfo | undefined, band: number | string): BandStats | undefined {
  return info?.stats.find((b) => b.index === band);
}

/** A number as typed, cut to three digits when longer (a float file's lowest value as its no-data value: -3.4e+38).
 * Not locale formatted: the no-data box reads commas as separators. */
export function shortNumber(value: number): string {
  const text = String(value);
  return text.length <= 10 ? text : value.toPrecision(3).replace(/\.?0+(?=e|$)/, "");
}

/** A bin of a histogram: its range and how many values fall in it (a band's cells, a field's features). */
export interface HistogramBin {
  range: [number, number];
  count: number;
}

/** A band's histogram as bins; none where the info has none for it. */
export function bandHistogram(info: RasterInfo | undefined, band: number): HistogramBin[] {
  const histogram = info?.stats.find((b) => b.index === band)?.histogram;
  if (!histogram) return [];
  const { counts, edges } = histogram;
  return counts.map((count, i) => ({ range: [edges[i], edges[i + 1]], count }));
}

/** The inner breaks the raster service computed for `count` classes of `method` on a band; undefined where it computed
 * none (a formula, another count, a band without values). */
export function bandBreaks(
  info: RasterInfo | undefined,
  band: number,
  method: string,
  count: number
): number[] | undefined {
  return info?.stats.find((b) => b.index === band)?.breaks?.[method]?.[String(count)];
}

const binTotal = (bins: HistogramBin[]) => bins.reduce((sum, bin) => sum + bin.count, 0);

/** The share (0 to 1) of a band's cells in the class from `from` up to `to` (from inclusive, an open end unbounded):
 * each bin adds the part of its cells that lies in the class, taking the cells as spread evenly over the bin, so the
 * classes of a band add up to all of it; a bin without width (a band of one value) counts whole in the class its edge
 * falls in. Undefined without a histogram. */
export function rangeShare(bins: HistogramBin[], from?: number, to?: number): number | undefined {
  const total = binTotal(bins);
  if (!total) return undefined;
  const low = from ?? -Infinity;
  const high = to ?? Infinity;
  let inside = 0;
  for (const { range, count } of bins) {
    const [a, b] = range;
    if (b <= a) {
      if (a >= low && a < high) inside += count;
      continue;
    }
    const covered = Math.min(b, high) - Math.max(a, low);
    if (covered > 0) inside += (count * covered) / (b - a);
  }
  return inside / total;
}

/** The bin `value` falls in, as the service's histogram counts it (the last bin holds its upper edge); -1 beyond. */
function binOf(bins: HistogramBin[], value: number): number {
  return bins.findIndex(
    (bin, i) =>
      value >= bin.range[0] && (value < bin.range[1] || (i === bins.length - 1 && value === bin.range[1]))
  );
}

/** The share (0 to 1) of a band's cells holding the whole number `value`, out of the band's distinct `values`: known
 * where it is the only one of them in its bin (the histogram counts bins, not values); 0 for a value the band does not
 * hold, undefined where its bin holds others too. */
export function valueShare(bins: HistogramBin[], values: number[], value: number): number | undefined {
  const total = binTotal(bins);
  if (!total) return undefined;
  if (!values.includes(value)) return 0;
  const k = binOf(bins, value);
  if (k < 0) return 0;
  return values.some((v) => v !== value && binOf(bins, v) === k) ? undefined : bins[k].count / total;
}

/** The share (0 to 1) of a band's cells holding the code `value`: its cell count over all the codes' counts (the
 * service counts every code of a band whose codes it lists), exact; from the histogram where an info has no counts
 * (`valueShare`). 0 for a code the band does not hold, undefined where the band's codes are not known. */
export function codeShare(info: RasterInfo | undefined, band: number, value: number): number | undefined {
  const stats = info?.stats.find((b) => b.index === band);
  if (!stats?.values) return undefined;
  const { values, counts } = stats;
  if (!counts || counts.length !== values.length) return valueShare(bandHistogram(info, band), values, value);
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (!total) return undefined;
  const i = values.indexOf(value);
  return i < 0 ? 0 : counts[i] / total;
}

/** A band's (or band formula's, `statsOf`) minimum and maximum, as the values' description gives them; null when
 * unknown. */
export function bandRange(info: RasterInfo | undefined, band: number | string): [number, number] | null {
  const stats = statsOf(info, band);
  return stats && stats.min !== null && stats.max !== null ? [stats.min, stats.max] : null;
}

export interface ValueSample {
  min: number;
  max: number;
  /** Distinct values, sorted, at most 32. */
  values: number[];
}

const MAX_VALUES = 32;

/** A band's values as the panel starts a range from them: its 2nd to 98th percentile (outliers left out) and its
 * distinct values; null when the band has no values. */
export function sampleOf(info: RasterInfo | undefined, band: number): ValueSample | null {
  const stats = info?.stats.find((b) => b.index === band);
  if (!stats || stats.p2 === null || stats.p98 === null) return null;
  return { min: stats.p2, max: stats.p98, values: (stats.values ?? []).slice(0, MAX_VALUES) };
}

/** A starting range for a palette: the style's stops, else the band's values (whole numbers around them), else the
 * full range of an 8-bit file; null when nothing is known. */
export function seedDomain(
  sample: ValueSample | null,
  info: RasterInfo,
  stops?: Array<{ value: number }>
): [number, number] | null {
  if (stops?.length) return [stops[0].value, stops[stops.length - 1].value];
  if (sample) {
    const low = Math.floor(sample.min);
    const high = Math.ceil(sample.max);
    return [low, high > low ? high : low + 1];
  }
  if (info.integer && info.bits.every((b) => b === 8)) return [0, 255];
  return null;
}
