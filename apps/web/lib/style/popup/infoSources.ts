// Where a popup's values come from (spec 7.4, 9.7). A raster file's popup reads the cell under the pointer: while
// hovering from the value tiles the map has loaded, so it sends no request and shows what the map draws; on a click
// that value at once, then the exact value and every band from the raster service's point query. An image whose
// pixels are its values (`imagePixels`: 8 bit bands drawn as they are, or codes its color table gives colors of
// their own) answers the same way from its colored tiles. Other images, and a color scale the raster service colors,
// never answer a hover, and a click asks the point query only. Vector features keep their own path in the map (the
// feature under the pointer, its highlight, clusters and hexagons); map services have no popup yet (spec 9.8).
import type { TFunction } from "i18next";

import { fetchRasterPoint, loadedRasterTileset, loadedRasterValues } from "@/lib/api/rasters";
import { type JsonObject, isObject } from "@/lib/style/json";
import { coverageUrl, imageTilesetUrl } from "@/lib/style/layerSource";
import { rasterColorSpec } from "@/lib/style/raster/color";
import { type RasterInfo, valueBands } from "@/lib/style/raster/metadata";
import {
  type ImagePixels,
  type PopupRaster,
  type RasterPopupRule,
  bandText,
  imagePixels,
  isStyleNoData,
  pixelValuesAt,
  rasterClassOf,
  rasterDraws,
  rasterPopupOf,
  renderOf,
  tableBand,
  valueText,
} from "@/lib/style/raster/popup";
import {
  type MapRasterSource,
  type TilesMap,
  sourceTileOptions,
  tilePixelAt,
  tileUnder,
  tileValueAt,
  valueTileOptions,
} from "@/lib/style/raster/tileValues";
import { rasterToken } from "@/lib/style/raster/token";
import {
  type RasterValues,
  tilesetUrl,
  valueQuery,
  valueTilesUrl,
  valuesUrl,
} from "@/lib/style/raster/values";

/** A field a popup can show. */
export interface InfoField {
  name: string;
  label: string;
  type: "string" | "number";
}

/** The values a popup shows; `exact: false` while they are the map's (a tile's), until the service's arrive. */
export type InfoRecord = { values: Record<string, unknown>; exact: boolean };

/** The map a popup reads on: MapLibre's own `Map` (react-map-gl's `MapRef` has no `terrain`). */
export type InfoMap = TilesMap & { getSource(id: string): unknown };

export interface InfoContext {
  map: InfoMap;
  trigger: "click" | "hover";
  /** On a click, the value the map shows, before the exact one is asked for. */
  onFirst?: (record: InfoRecord) => void;
  /** The reader's language and number locale, for the class's name. */
  t?: TFunction;
  locale?: string;
}

export interface InfoSource {
  /** The fields its popups can show; `info`: what the raster service tells about the file. */
  fields(layer: PopupRaster | undefined, info?: RasterInfo, t?: TFunction): InfoField[];
  /** Answers a hover without a request. */
  hover: boolean;
  /** The values at a place; null where there is nothing to show (no popup). */
  at(layer: PopupRaster, lngLat: { lng: number; lat: number }, ctx: InfoContext): Promise<InfoRecord | null>;
  /** Whether a popup that has no values to read without a request (an image, colors the raster service paints) has
   * something drawn at a place, from the map's own tiles; false where `at` answers on hover. */
  paints(layer: PopupRaster, lngLat: { lng: number; lat: number }, ctx: InfoContext): Promise<boolean>;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The dataset a layer's cells come from. */
const datasetOf = (layer: PopupRaster) => String(layer.layer_id ?? layer.id);

/** The value tiles the map draws for a layer: their description and URL template (the source's own). "service" where
 * the map draws none but the raster service answers a click (an image, colors the service paints); null where no
 * value is known (a value render whose description has not loaded or failed: the map draws nothing). */
function valueTilesOf(
  layer: PopupRaster,
  style: JsonObject,
  map: InfoMap
): { values: RasterValues; template: string } | "service" | null {
  const query = valueQuery(style);
  if (!query) return "service";
  const coverage = coverageUrl(datasetOf(layer));
  const values = loadedRasterValues(valuesUrl(coverage, query));
  if (!values) return null;
  const template = valueTilesUrl(coverage, query, values);
  // The layer's value source (compile/rasters.ts: `src-<key>`, or `src-<key>-values` beside image tiles): only tiles
  // the map loads are read, so a hover sends no request.
  const drawn = [`src-${layer.id}`, `src-${layer.id}-values`].some((id) => {
    const source = map.getSource(id) as { type?: string; tiles?: string[] } | undefined;
    return source?.type === "raster-dem" && source.tiles?.[0] === template;
  });
  return drawn ? { values, template } : "service";
}

/** The layer's colored tiles as the map holds their source (compile/rasters.ts: `src-<key>`); undefined without. */
function coloredSourceOf(layer: PopupRaster, map: InfoMap): MapRasterSource | undefined {
  const source = map.getSource(`src-${layer.id}`) as (MapRasterSource & { type?: string }) | undefined;
  return source?.type === "raster" && source.tiles?.[0] ? source : undefined;
}

/** The band facts of the colored tiles' description the map loaded. */
const factsOf = (layer: PopupRaster) =>
  loadedRasterTileset(tilesetUrl(imageTilesetUrl(datasetOf(layer))))?.bands;

/** An image whose colored tiles' pixels are its values (`imagePixels`, with the band facts of the description the map
 * loaded): what they are and the tiles' source; null for anything else. */
function pixelsOf(
  layer: PopupRaster,
  style: JsonObject,
  map: InfoMap
): { pixels: ImagePixels; source: MapRasterSource } | null {
  const pixels = imagePixels(style, factsOf(layer));
  const source = pixels ? coloredSourceOf(layer, map) : undefined;
  return pixels && source ? { pixels, source } : null;
}

/** A tile's value at the precision of its codes: `base + q * step` carries float noise past the step. */
function atStep(value: number, values: RasterValues): number {
  const step = values.encoding.blueFactor;
  if (values.integer || !(step > 0) || step >= 1) return values.integer ? Math.round(value) : value;
  const decimals = Math.min(15, Math.floor(-Math.log10(step)));
  return Number(value.toFixed(decimals));
}

/** The values description the map loaded for a layer's style (its band's or formula's range names the open classes);
 * undefined for an image or before it loaded. */
function describedOf(layer: PopupRaster, style: JsonObject): RasterValues | undefined {
  const query = valueQuery(style);
  return query ? loadedRasterValues(valuesUrl(coverageUrl(datasetOf(layer)), query)) : undefined;
}

/** The record of a cell's value: the value and its class (its open ends named by the range of `described`, the values
 * the map loaded); null for no value, the style's no data and a cell the map does not draw (`rasterDraws`: a hidden
 * class, a value in no category, beyond a range left out), as no popup opens over a feature its style hides. */
function valueRecord(
  style: JsonObject,
  value: number | null | undefined,
  ctx: InfoContext,
  described: RasterValues | undefined
): Record<string, unknown> | null {
  if (!num(value) || isStyleNoData(style, value) || !rasterDraws(style, value, described)) return null;
  const name = rasterClassOf(style, value, { t: ctx.t, locale: ctx.locale, described });
  return name === undefined ? { value } : { value, class: name };
}

/** The raster service's values at a place: the styled value and its class (for an image, the code its color table
 * colors), and every band. */
async function pointRecord(
  layer: PopupRaster,
  style: JsonObject,
  lngLat: { lng: number; lat: number },
  ctx: InfoContext
): Promise<Record<string, unknown> | null> {
  const render = renderOf(style);
  const band = render.band;
  // A formula's value is computed by the service from the coloring it is sent.
  const formula = isObject(band);
  const spec = formula ? rasterColorSpec(render) : null;
  const point = await fetchRasterPoint(datasetOf(layer), lngLat, spec ? rasterToken(spec) : undefined);
  if (!point) return null;
  const image = render.type === "image" || render.type === undefined;
  const styled = image ? null : formula ? point.styled : point.values[(num(band) ? band : 1) - 1];
  const record = image ? {} : valueRecord(style, styled, ctx, describedOf(layer, style));
  // A styled value the map does not draw there (the style's no data, a hidden class): no popup.
  if (record === null && num(styled)) return null;
  const out: Record<string, unknown> = record ?? {};
  point.values.forEach((value, i) => {
    if (num(value)) out[`band_${i + 1}`] = value;
  });
  const coded = image ? tableBand(style, factsOf(layer)) : null;
  if (coded !== null && num(out[`band_${coded}`])) out.value = out[`band_${coded}`];
  return Object.keys(out).length ? out : null;
}

/** A raster file's cells. */
export const cellSource: InfoSource = {
  fields(_layer, info, t) {
    const bands = valueBands(info);
    return [
      { name: "value", label: valueText(t), type: "number" },
      { name: "class", label: t ? t("style_editor.popup_class") : "Class", type: "string" },
      ...bands.map((n) => ({ name: `band_${n}`, label: bandText(n, { t, info }), type: "number" as const })),
    ];
  },
  hover: true,
  async at(layer, lngLat, ctx) {
    const rule: RasterPopupRule | undefined = rasterPopupOf(layer);
    if (!rule) return null;
    const style = layer.style!.document as unknown as JsonObject;
    const tiles = valueTilesOf(layer, style, ctx.map);
    if (tiles === null) return null;
    let shown: Record<string, unknown> | null;
    if (tiles === "service") {
      // An image whose pixels are its values shows them as the map draws them; anything else asks the service on a
      // click only.
      const read = pixelsOf(layer, style, ctx.map);
      const rgba = read
        ? await tilePixelAt(read.source, lngLat, tileUnder(ctx.map, sourceTileOptions(read.source), lngLat))
        : undefined;
      // Nothing drawn there (no data, outside the file): no popup, no request.
      if (rgba === null) return null;
      shown = read && rgba ? pixelValuesAt(read.pixels, rgba) : null;
      // Without pixels to read, a pixel this browser could not read, or a color that no entry or two entries of the
      // color table have (or that is not opaque): the service answers a click.
      if (!shown) {
        if (ctx.trigger === "hover") return null;
        const exact = await pointRecord(layer, style, lngLat, ctx);
        return exact ? { values: exact, exact: true } : null;
      }
    } else {
      const code = await tileValueAt(
        tiles.values,
        tiles.template,
        lngLat,
        tileUnder(ctx.map, valueTileOptions(tiles.values), lngLat)
      );
      shown = valueRecord(style, code === null ? null : atStep(code, tiles.values), ctx, tiles.values);
    }
    if (!shown) return null;
    const first: InfoRecord = { values: shown, exact: false };
    if (ctx.trigger === "hover") return first;
    ctx.onFirst?.(first);
    // The service not answering keeps what the map shows.
    const exact = await pointRecord(layer, style, lngLat, ctx);
    return exact ? { values: exact, exact: true } : first;
  },
  async paints(layer, lngLat, ctx) {
    if (!rasterPopupOf(layer)) return false;
    const style = layer.style!.document as unknown as JsonObject;
    if (valueTilesOf(layer, style, ctx.map) !== "service") return false;
    const source = coloredSourceOf(layer, ctx.map);
    if (!source) return false;
    return !!(await tilePixelAt(source, lngLat, tileUnder(ctx.map, sourceTileOptions(source), lngLat)));
  },
};

/** Where a layer's popup values come from: the cells of a COG file; undefined for vector data (its own path in the
 * map) and map services. */
export function infoSourceOf(layer: PopupRaster): InfoSource | undefined {
  return layer.type === "raster" && layer.data_type === "cog" ? cellSource : undefined;
}
