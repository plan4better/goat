// A raster file's popup (spec 9.7): the cell under the pointer, on click (a color scale's default), while hovering, or
// both. Its fields are `value` (the band or formula the style colors), `class` (the class or category that value is
// drawn in) and `band_1` to `band_<n>` (every band, on click). Its content is the popup of spec 7.4 over those
// fields; without blocks it shows the value with the legend's unit and a class with a name of its own, an image the
// bands it draws. Map services show none (their feature info comes later, spec 9.8).
import type { TFunction } from "i18next";

import { loadedRasterTileset, loadedRasterValues } from "@/lib/api/rasters";
import { browserStops } from "@/lib/style/compile/rasters";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { type SourceLayer, coverageUrl, imageTilesetUrl, sourceOf } from "@/lib/style/layerSource";
import { rangeText, valuesText } from "@/lib/style/legend";
import { fromPopupConfig, toPopupConfig } from "@/lib/style/popup";
import { classEnds, rasterColorSpec, tableColorSpec } from "@/lib/style/raster/color";
import {
  type RasterInfo,
  bandFactsOf,
  bandLabel,
  drawingFacts,
  imageBands,
  valueBands,
} from "@/lib/style/raster/metadata";
import { type NamedRasterColorSpec, rasterClassAt } from "@/lib/style/raster/tileValues";
import {
  type BandFacts,
  type RasterValues,
  type ReliefStop,
  reliefColorAt,
  tilesetUrl,
  valueQuery,
  valuesUrl,
} from "@/lib/style/raster/values";
import type { PopupProperties } from "@/lib/validations/layer";

/** The renders whose style opens a popup on click without a `popup` key (goatlib `RASTER_POPUP_ON_BY_DEFAULT`): the
 * color scales. An image opens none. */
export const RASTER_POPUP_ON_BY_DEFAULT = ["continuous", "categorical", "hillshade"] as const;

export interface PopupRaster extends SourceLayer {
  visible?: boolean;
  style?: { document: LayerStyle } | null;
}

export type RasterTrigger = "click" | "hover" | "click_and_hover";

export interface RasterPopupRule {
  trigger: RasterTrigger;
  /** "all": the default content adds every band's value. */
  bands: "styled" | "all";
  /** The style's `popup` as written; empty without one. */
  popup: JsonObject;
}

/** How the popup's texts read: the reader's language and number locale. */
export interface RasterTexts {
  t?: TFunction;
  locale?: string;
  /** The file's bands and their names, where the raster service has answered. */
  info?: RasterInfo;
  /** The file's band names from the value tiles' description, where the info is not loaded (the map). */
  names?: string[];
  /** The value tiles' description the map loaded: the cell's color is the one its relief stops give. */
  described?: RasterValues;
  /** The colored tiles' band facts the map loaded: an image's pixels may be its values, or its codes are drawn from
   * value tiles with its color table (`imagePixels`). */
  facts?: BandFacts;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** A style's render; an image without one. */
export const renderOf = (style: unknown): JsonObject =>
  isObject(style) && isObject(style.render) ? style.render : { type: "image" };

/** Whether a popup that opens on `trigger` opens on a `on`. */
export const opensOn = (trigger: RasterTrigger | undefined, on: "click" | "hover"): boolean =>
  trigger === on || trigger === "click_and_hover";

/** A raster style's popup rule; undefined when it opens none: switched off, or an image without a `popup` key. A hover
 * opens it only where the map has the values to read: its value tiles (an image drawn with its color table too), or
 * an image's pixels that are its values (`imagePixels`); the data tell that, not the style. */
export function rasterPopupRuleOf(style: JsonObject): RasterPopupRule | undefined {
  const popup = style.popup;
  const type = renderOf(style).type;
  if (popup === false || (isObject(popup) && popup.enabled === false)) return undefined;
  if (!isObject(popup) && !(RASTER_POPUP_ON_BY_DEFAULT as readonly unknown[]).includes(type))
    return undefined;
  const record = isObject(popup) ? popup : {};
  const trigger: RasterTrigger =
    record.trigger === "hover" || record.trigger === "click_and_hover" ? record.trigger : "click";
  return { trigger, bands: record.bands === "all" ? "all" : "styled", popup: record };
}

const isImage = (render: JsonObject): boolean => render.type === "image" || render.type === undefined;

/** Whether an image's style chooses its three bands. */
const choosesBands = (render: JsonObject): boolean =>
  Array.isArray(render.bands) && render.bands.filter(num).length === 3;

/** The bands whose values an image's pixels are, red, green and blue; null where its pixels are colors made of them.
 * The raster service draws 8 bit bands as they are (goatlib.raster.color `_image`): an unsigned 8 bit file without a
 * scale or offset, three bands chosen, or the three it draws by default (`imageBands`) when it has no color table.
 * Anything else is stretched or colored: wider or signed bands, scaled ones, one band as grey, a color table.
 * Brightness, contrast, saturation and hue are the map's paint, not the tile's. `facts`: the file's (`bandFactsOf` of
 * its info, or the colored tiles' description); null without them. */
export function pixelValueBands(
  style: JsonObject,
  facts: Partial<BandFacts> | undefined
): [number, number, number] | null {
  const render = renderOf(style);
  if (!isImage(render)) return null;
  if (!facts || facts.dtype !== "uint8" || facts.scaled !== false || !num(facts.count)) return null;
  if (!choosesBands(render) && facts.colorTable !== false) return null;
  // The bands of values: an alpha band (an orthophoto's transparency) is none (goatlib `bands_needed`).
  const values = facts.valueBands ?? Array.from({ length: facts.count }, (_, i) => i + 1);
  const bands = imageBands(render.bands, { ...facts, count: facts.count });
  return bands?.length === 3 && bands.every((b) => values.includes(b))
    ? (bands as [number, number, number])
    : null;
}

/** What a hover over an image reads (spec 9.7): the values of 8 bit bands drawn as they are, red, green and blue, from
 * its pixels (`pixelValueBands`); or, drawn with the file's color table, the code of the band the table colors, from
 * the value tiles the map draws it from (`tableColorSpec`), every code whatever its color, and the table's `colors`.
 * Null where its pixels are colors only: a hover reads nothing there. */
export type ImagePixels =
  | { kind: "bands"; bands: [number, number, number] }
  | { kind: "palette"; bands: [number]; colors: Record<number, string> };

/** What a hover over an image reads (`ImagePixels`), from the file's band facts; the one rule the map and the style
 * panel follow for a hover over an image. */
export function imagePixels(style: JsonObject, facts: Partial<BandFacts> | undefined): ImagePixels | null {
  const bands = pixelValueBands(style, facts);
  if (bands) return { kind: "bands", bands };
  const table = tableColorSpec(style, facts);
  return table && facts?.palette
    ? { kind: "palette", bands: [facts.palette.band], colors: facts.palette.colors }
    : null;
}

const hexOf = (rgb: readonly number[]) =>
  `#${rgb
    .slice(0, 3)
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("")}`;

/** The values a drawn pixel of red, green, blue (and alpha) `rgba` holds: the bands it draws, by band. */
export function pixelValuesAt(
  pixels: Extract<ImagePixels, { kind: "bands" }>,
  rgba: readonly number[]
): Record<string, number> {
  return Object.fromEntries(pixels.bands.map((band, i) => [`band_${band}`, rgba[i]]));
}

/** The band an image colors with its file's color table: its code is the cell's `value`. Null for anything else. */
export function tableBand(style: JsonObject, facts: Partial<BandFacts> | undefined): number | null {
  const render = renderOf(style);
  if (!isImage(render) || choosesBands(render) || !facts?.colorTable || !num(facts.count)) return null;
  return imageBands(undefined, { ...facts, count: facts.count })?.[0] ?? null;
}

/** A COG layer's popup rule; undefined for vector data, map services and a popup that opens none. */
export function rasterPopupOf(layer: PopupRaster): RasterPopupRule | undefined {
  const style = layer.style?.document as unknown as JsonObject | undefined;
  if (style?.kind !== "raster" || sourceOf(layer)?.kind !== "cog") return undefined;
  return rasterPopupRuleOf(style);
}

/** The drawn files (layers top first) whose popup opens on `trigger`. */
export function rasterPopupLayers<T extends PopupRaster>(
  layers: readonly T[],
  trigger: "click" | "hover"
): T[] {
  return layers.filter((layer) => layer.visible !== false && opensOn(rasterPopupOf(layer)?.trigger, trigger));
}

/** A band's label: the file's name for it, else "Band <n>" (translated with `t`). */
export function bandText(band: number, { t, info, names }: RasterTexts): string {
  const named = info ?? (names ? { names } : undefined);
  return t ? bandLabel(named, band, t) : named?.names?.[band - 1] || `Band ${band}`;
}

/** The translated "Value" (also a band formula's value without a name). */
export const valueText = (t?: TFunction): string => (t ? t("style_editor.value") : "Value");

/** The label of a style's `value`: its band's, or its formula's name. */
function valueLabel(style: JsonObject, texts: RasterTexts): string {
  const band = renderOf(style).band;
  if (isObject(band)) return text(band.name) ?? valueText(texts.t);
  return bandText(num(band) ? band : 1, texts);
}

/** The style's no-data values: cells the map leaves transparent, with the raster service's tolerance. */
export function isStyleNoData(style: JsonObject, value: number): boolean {
  const noData = renderOf(style).no_data;
  const values = isObject(noData) && Array.isArray(noData.values) ? noData.values.filter(num) : [];
  return values.some((x) => Math.abs(value - x) <= 1e-6 * Math.max(1, Math.abs(x)));
}

/** The style's coloring with a name on each class or category: the style's name for it, else the legend's text (its
 * range or value, with the legend's unit; an open first or last class closed by `classEnds` of the file's statistics
 * in `texts.info`, else the values the map loaded in `texts.described`). A copy of `rasterColorSpec`, whose own
 * entries carry no names (they go into tile URLs); its entries are matched after the same filter. Null for colorings
 * without classes. */
export function namedRasterSpec(style: JsonObject, texts: RasterTexts = {}): NamedRasterColorSpec | null {
  // Read on every pointer move: kept per document, language, locale and the ends of its open classes.
  const ends = endsOf(style, texts);
  const kept = named.get(style);
  if (
    kept &&
    kept.t === texts.t &&
    kept.locale === texts.locale &&
    kept.ends?.[0] === ends?.[0] &&
    kept.ends?.[1] === ends?.[1]
  )
    return kept.spec;
  const spec = nameClasses(style, texts, ends);
  named.set(style, { t: texts.t, locale: texts.locale, ends, spec });
  return spec;
}

const named = new WeakMap<
  JsonObject,
  { t?: TFunction; locale?: string; ends?: [number, number]; spec: NamedRasterColorSpec | null }
>();

/** Where a style's classes end, from the file's statistics, else the values the map loaded (`classEnds`). */
const endsOf = (style: JsonObject, texts: RasterTexts) =>
  classEnds(renderOf(style), { info: texts.info, range: texts.described?.range });

/** How a raster style's class ranges read (`rangeText`): the reader's words and locale, the legend's unit. */
function rangeOptions(style: JsonObject, texts: RasterTexts) {
  const { t } = texts;
  const legend = isObject(style.legend) ? style.legend : {};
  return {
    locale: texts.locale ?? "en",
    words: {
      under: t ? t("style_editor.range_under") : "Under",
      to: t ? t("style_editor.range_to") : "to",
      andMore: t ? t("style_editor.range_and_more") : "and more",
    },
    unit: text(legend.unit),
  };
}

/** `ends`: what closes the open first and last class (`classEnds`). */
function nameClasses(
  style: JsonObject,
  texts: RasterTexts,
  ends: [number, number] | undefined
): NamedRasterColorSpec | null {
  const render = renderOf(style);
  const spec = rasterColorSpec(render);
  if (!spec || (spec.kind !== "classes" && spec.kind !== "categories")) return null;
  const { locale, unit } = rangeOptions(style, texts);
  const objects = (v: unknown) => (Array.isArray(v) ? v.filter(isObject) : []);
  // The names the user gave (or the file brought into the style), unless they only repeat the range or the code.
  const owned = new Set<string>();
  const own = (name: string | undefined, plain: string[]): string | undefined => {
    if (!name || plain.includes(name)) return undefined;
    owned.add(name);
    return name;
  };
  if (spec.kind === "classes") {
    const written = objects(isObject(render.classify) ? render.classify.classes : undefined);
    const options = rangeOptions(style, texts);
    const classes = {
      ...spec,
      classes: spec.classes.map((c, i) => {
        const range = rangeText(
          { from: c.from, to: c.to },
          { ...options, ...(ends ? { domain: ends } : {}) }
        );
        return { ...c, name: own(text(written[i]?.name), [range]) ?? range };
      }),
    };
    ownedNames.set(classes, owned);
    return classes;
  }
  const written = objects(render.classes).filter((c) => num(c.value));
  const categories = {
    ...spec,
    classes: spec.classes.map((c, i) => {
      const code = valuesText([c.value], { locale, unit });
      const plain = [code, valuesText([c.value], { locale }), String(c.value)];
      return { ...c, name: own(text(written[i]?.name), plain) ?? code };
    }),
  };
  ownedNames.set(categories, owned);
  return categories;
}

/** The class and category names of a named coloring (`namedRasterSpec`) that the user gave, not its ranges or codes. */
const ownedNames = new WeakMap<NamedRasterColorSpec, Set<string>>();

/** The class of a value's cell: its name, "Other" for a value in no category drawn in the other color; undefined
 * where none is drawn (no classes, a hidden class, no data). */
export function rasterClassOf(style: JsonObject, value: number, texts: RasterTexts = {}): string | undefined {
  const named = namedRasterSpec(style, texts);
  const found = named ? rasterClassAt(named, value) : null;
  if (found === null) return undefined;
  if (found === "other") return texts.t ? texts.t("style_editor.other") : "Other";
  return found.name;
}

/** Whether the map draws a cell of `value` (the raster service colors it the same, goatlib.raster.color): not in a
 * hidden class or category, nor a value in no category without a color for the rest, nor beyond a color range, stops
 * or classes whose outside cells are left out (`outside: "hide"`; a range not yet known spreads over the values the map
 * loaded, `described`), nor, for an image drawn with its file's color table (`facts`, the file's band facts), a code
 * without an entry or the style's no data. A hillshade draws its shading under any color; another image is drawn as it
 * is. */
export function rasterDraws(
  style: JsonObject,
  value: number,
  described?: RasterValues,
  facts?: Partial<BandFacts>
): boolean {
  const render = renderOf(style);
  const spec = tableColorSpec(style, facts) ?? (render.type === "hillshade" ? null : rasterColorSpec(render));
  if (!spec || spec.kind === "rgb") return true;
  if (spec.kind === "classes" || spec.kind === "categories")
    return rasterClassAt(spec, value, described?.range) !== null;
  if (spec.outside !== "hide") return true;
  if (spec.kind === "stops")
    return value >= spec.stops[0].value && value <= spec.stops[spec.stops.length - 1].value;
  const domain = spec.domain ?? described?.range;
  if (!domain) return true;
  // A range of one value colors that value and the next, as the service does.
  const [d0, d1] = domain;
  const end = d0 + (d1 - d0 || 1);
  return value >= Math.min(d0, end) && value <= Math.max(d0, end);
}

/** The row of the cell's class (spec 9.7): only where its name is a real one, a class or category the user named (or
 * a name the file brought), never its range, its code or "Other", which the value says already; without a cell (the
 * style panel), where any class has one. Labelled "Class", for categories "Category". */
function classRow(
  style: JsonObject,
  values: Record<string, unknown> | undefined,
  texts: RasterTexts
): JsonObject | null {
  const named = namedRasterSpec(style, texts);
  if (!named || (named.kind !== "classes" && named.kind !== "categories")) return null;
  const owned = ownedNames.get(named);
  if (!owned?.size) return null;
  if (values) {
    const found = num(values.value) ? rasterClassAt(named, values.value, endsOf(style, texts)) : null;
    if (!found || found === "other" || !found.name || !owned.has(found.name)) return null;
  }
  const { t } = texts;
  const label =
    named.kind === "categories"
      ? t
        ? t("category")
        : "Category"
      : t
        ? t("style_editor.popup_class")
        : "Class";
  return { field: "class", label, type: "string" };
}

/** The relief stops the map colors a style's value tiles with (compile/rasters.ts), kept per render and description:
 * the popup reads them on every pointer move. */
const stopsKept = new WeakMap<
  JsonObject,
  { values: RasterValues; facts?: Partial<BandFacts>; stops: ReliefStop[] | null }
>();

/** The color the map draws a cell of `value` in, from the relief stops it draws with (categories without classes: the
 * file's color table, `tableColorSpec` with its band facts `facts`); null where it draws none (shading alone, colors
 * the raster service paints, no description loaded). */
function cellColor(
  style: JsonObject,
  value: number,
  described: RasterValues | undefined,
  facts?: Partial<BandFacts>
): string | null {
  if (!described) return null;
  const render = renderOf(style);
  let kept = stopsKept.get(render);
  if (!kept || kept.values !== described || kept.facts !== facts) {
    const spec = tableColorSpec(style, facts) ?? rasterColorSpec(render);
    kept = { values: described, facts, stops: browserStops(spec, described) };
    stopsKept.set(render, kept);
  }
  return kept.stops ? reliefColorAt(kept.stops, described, value) : null;
}

/** The color of an image's pixel whose values `values` holds, where its pixels are its values (`pixels`). */
function pixelColor(pixels: ImagePixels | null, values: Record<string, unknown>): string | null {
  if (!pixels) return null;
  if (pixels.kind === "palette") {
    const code = values[`band_${pixels.bands[0]}`];
    return (num(code) && pixels.colors[code]) || null;
  }
  const rgb = pixels.bands.map((b) => values[`band_${b}`]);
  return rgb.every((v): v is number => num(v) && v >= 0 && v <= 255) ? hexOf(rgb) : null;
}

const RGB_LABELS = [
  ["red", "style_editor.band_red", "Red"],
  ["green", "style_editor.band_green", "Green"],
  ["blue", "style_editor.band_blue", "Blue"],
] as const;

/** The label of an image's pixel row: the names of the bands it draws where the file names them all; else "Red,
 * Green, Blue" where the file marks them so (`colorInterp`); else "Color". */
function colorLabel(bands: number[], facts: BandFacts | undefined, texts: RasterTexts): string {
  const { t } = texts;
  const names = bands.map((n) => texts.info?.names?.[n - 1] || texts.names?.[n - 1] || "");
  if (names.every(Boolean)) return names.join(", ");
  const interp = facts?.colorInterp ?? [];
  if (bands.every((n, i) => interp[n - 1] === RGB_LABELS[i][0]))
    return RGB_LABELS.map(([, key, english]) => (t ? t(key) : english)).join(", ");
  return t ? t("style_editor.color") : "Color";
}

/** The content of a popup without blocks: the value with the legend's unit and its color, its class where the class
 * has a name of its own (`classRow`), and every band for `bands: "all"`; an image the bands it draws (or every band).
 * Every band is the cell's, else the file's. */
function defaultBlocks(
  style: JsonObject,
  rule: RasterPopupRule,
  values: Record<string, unknown> | undefined,
  texts: RasterTexts
): JsonObject[] {
  const render = renderOf(style);
  const band = (n: number): JsonObject => ({ field: `band_${n}`, label: bandText(n, texts), type: "number" });
  const fromCell = values
    ? Object.keys(values)
        .filter((key) => /^band_\d+$/.test(key))
        .map((key) => Number(key.slice(5)))
        .sort((a, b) => a - b)
    : [];
  const every = values ? fromCell : valueBands(texts.info);
  if (isImage(render)) {
    const facts = texts.facts ?? bandFactsOf(texts.info);
    // An image whose pixels are its values: one row of the pixel's color and the values it is made of (`colorLabel`),
    // or the code its color table colors; with every band asked for, the bands it does not draw below.
    const pixels = values ? imagePixels(style, facts) : null;
    const swatch = values ? pixelColor(pixels, values) : null;
    if (pixels && swatch) {
      const drawn: number[] = pixels.bands;
      const row: JsonObject =
        pixels.kind === "palette"
          ? { ...band(drawn[0]), swatch }
          : {
              field: `band_${drawn[0]}`,
              label: colorLabel(drawn, facts, texts),
              type: "string",
              join: drawn.map((n) => `band_${n}`),
              swatch,
            };
      const others = rule.bands === "all" ? every.filter((n) => !drawn.includes(n)).map(band) : [];
      return [{ type: "field_list", attributes: [row, ...others] }];
    }
    // Before the file is known, the bands it draws are not: the cell's (or the info's) every band, none named a
    // color.
    const drawn = imageBands(render.bands, facts ?? drawingFacts(texts.info));
    const shown = rule.bands === "all" && every.length ? every : (drawn ?? every);
    return [{ type: "field_list", attributes: shown.map(band) }];
  }
  const legend = isObject(style.legend) ? style.legend : {};
  const unit = text(legend.unit);
  const swatch =
    values && num(values.value)
      ? cellColor(style, values.value, texts.described, texts.facts ?? bandFactsOf(texts.info))
      : null;
  const value: JsonObject = {
    field: "value",
    label: valueLabel(style, texts),
    type: "number",
    ...(unit ? { format: { suffix: ` ${unit}` } } : {}),
    // The cell's color as the map draws it (the default content only: a block the user writes has none).
    ...(swatch ? { swatch } : {}),
  };
  const named = classRow(style, values, texts);
  return [
    {
      type: "field_list",
      attributes: [value, ...(named ? [named] : []), ...(rule.bands === "all" ? every.map(band) : [])],
    },
  ];
}

/** The type of each field the blocks name: the value and the bands are numbers, the class text. */
function fieldTypes(blocks: unknown[]): Record<string, "number" | "string"> {
  const types: Record<string, "number" | "string"> = { value: "number", class: "string" };
  for (const match of JSON.stringify(blocks).matchAll(/band_\d+/g)) types[match[0]] = "number";
  return types;
}

/** A raster style's popup in today's configuration (spec 7.4 with the fields of 9.7): its blocks, or the default
 * content for `values` (the cell's) or, without them, for the file (`texts.info`). */
export function rasterPopupProperties(
  style: JsonObject,
  rule: RasterPopupRule,
  values?: Record<string, unknown>,
  texts: RasterTexts = {}
): PopupProperties {
  const { bands: _bands, enabled: _enabled, ...popup } = rule.popup;
  const blocks = Array.isArray(popup.blocks) ? popup.blocks : defaultBlocks(style, rule, values, texts);
  return toPopupConfig({ ...popup, trigger: rule.trigger, blocks }, fieldTypes(blocks))!;
}

/** Whether a raster style opens a popup without a `popup` key: a color scale does, an image not. */
export const rasterPopupOnByDefault = (style: JsonObject): boolean =>
  (RASTER_POPUP_ON_BY_DEFAULT as readonly unknown[]).includes(renderOf(style).type);

/** A raster style's `popup` as written, from `popup` without the keys a popup of the render's default leaves out: an
 * image's popup, off without the key, stays written while it is on. */
export function rasterPopupWritten(style: JsonObject, popup: JsonObject): JsonObject | undefined {
  if (Object.keys(popup).length) return popup;
  return rasterPopupOnByDefault(style) ? undefined : { trigger: "click" };
}

/** A raster style's `popup` from today's configuration (the style panel's edit; `style` holds the popup as it was):
 * what equals a popup without keys (its default content too) stays out, the choice of bands stays. */
export function rasterPopupFrom(
  config: PopupProperties,
  style: JsonObject,
  texts: RasterTexts = {}
): JsonObject | false {
  const original = isObject(style.popup) ? style.popup : {};
  const bands = original.bands === "all" ? "all" : "styled";
  const absent = rasterPopupProperties(style, { trigger: "click", bands, popup: {} }, undefined, texts);
  const next = fromPopupConfig(config, original, absent);
  if (next === false) return false;
  if (original.bands !== undefined) next.bands = original.bands;
  return rasterPopupWritten(style, next) ?? {};
}

/** A COG layer's popup showing `values` (its cell's); undefined where it opens none. */
export function rasterPopupConfig(
  layer: PopupRaster,
  values: Record<string, unknown>,
  texts: RasterTexts = {}
): PopupProperties | undefined {
  const rule = rasterPopupOf(layer);
  if (!rule) return undefined;
  const style = layer.style!.document as unknown as JsonObject;
  // Without the file's info, the band names of the description the map loaded: its value tiles', else (an image) its
  // colored tiles'.
  const dataset = String(layer.layer_id ?? layer.id);
  // The band facts of an image or categories, which tell whether it is drawn from value tiles with its color table.
  const facts =
    isImage(renderOf(style)) || renderOf(style).type === "categorical"
      ? loadedRasterTileset(tilesetUrl(imageTilesetUrl(dataset)))?.bands
      : undefined;
  const query = valueQuery(style, facts);
  const described = query ? loadedRasterValues(valuesUrl(coverageUrl(dataset), query)) : undefined;
  const names = texts.info || texts.names ? undefined : (described?.names ?? facts?.names);
  return rasterPopupProperties(style, rule, values, {
    ...texts,
    ...(names ? { names } : {}),
    ...(described ? { described } : {}),
    ...(facts ? { facts } : {}),
  });
}
