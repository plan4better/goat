// Raster render choices of the panel (spec 9): which renders fit a file, how each starts, equal classes over a range.
import { type JsonObject } from "@/lib/style/json";
import { paletteSteps } from "@/lib/style/palettes";
import { type RasterInfo, type ValueSample, seedDomain } from "@/lib/style/raster/metadata";

export type RasterRenderType = "terrain" | "continuous" | "categorical" | "image";

/** The panel's palette for new categories. */
const CATEGORY_PALETTE = "colorbrewer:Set3";

/** The renders a file allows (unknown files allow all): terrain on one band of elevation, a color range on any band
 * without a color table, categories on whole-number cells, the image always. */
export function drawAsOptions(info: RasterInfo | undefined): RasterRenderType[] {
  if (!info) return ["terrain", "continuous", "categorical", "image"];
  const out: RasterRenderType[] = [];
  if (info.bands === 1 && !info.colorTable) out.push("terrain");
  if (!info.colorTable) out.push("continuous");
  if (info.integer) out.push("categorical");
  out.push("image");
  return out;
}

/** A render of `type` from what is known about the file: a color range gets a written range (the browser cannot
 * compute one), categories the sampled values; everything else stays at its defaults. */
export function defaultRender(
  type: RasterRenderType,
  opts: { info?: RasterInfo; sample?: ValueSample | null; stops?: Array<{ value: number }> } = {}
): JsonObject {
  if (type === "continuous") {
    const domain = opts.info ? seedDomain(opts.sample ?? null, opts.info, opts.stops) : null;
    return domain ? { type, domain } : { type };
  }
  // A file with its own color table keeps drawing in it; categories are added one by one in its colors.
  if (type === "categorical" && opts.sample?.values.length && !opts.info?.colorTable) {
    const colors = paletteSteps(CATEGORY_PALETTE, Math.min(opts.sample.values.length, 12));
    return {
      type,
      classes: opts.sample.values.map((value, i) => ({ value, color: colors[i % colors.length] })),
    };
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

/** Whether no-data values change the drawing (spec 9): not where the file draws itself, by its color table,
 * as categories without classes or as plain hillshade. */
export function noDataApplies(render: JsonObject, info: RasterInfo | undefined): boolean {
  const type = render.type ?? "image";
  if (type === "image") return !info?.colorTable;
  if (type === "categorical") return Array.isArray(render.classes) && render.classes.length > 0;
  if (type === "terrain") return render.palette !== undefined;
  return true;
}
