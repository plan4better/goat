// What the panel knows about a raster file (spec 9): its bands, no-data value, color table and band statistics, from
// the raster service's info (geoapi `/collections/{id}/raster/info`, statistics from an overview).

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
  }>;
}

export interface BandStats {
  index: number;
  min: number | null;
  max: number | null;
  p2: number | null;
  p98: number | null;
  /** The distinct values of a whole-number band with few of them. */
  values: number[] | null;
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
  stats: BandStats[];
}

const hex = (rgb: number[]) =>
  `#${rgb
    .slice(0, 3)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;

export function rasterInfoOf(json: RasterInfoResponse): RasterInfo {
  const table = json.color_table;
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
    stats: json.bands.map((b) => ({
      index: b.index,
      min: b.min,
      max: b.max,
      p2: b.p2,
      p98: b.p98,
      values: b.values,
    })),
  };
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
