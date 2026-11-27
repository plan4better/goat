// Raster files (spec 9) drawn from geoapi. Continuous, classified and categorical renders color the cells' values in
// the browser: value tiles as a `raster-dem` source with their custom encoding, colored by `color-relief`, so a color
// edit is a paint change. Hillshade shades the same values. An image drawn with its file's color table colors its
// table band's codes the same way, in the table's colors, so the map holds every cell's code. Other images, and a
// coloring needing more stops than color-relief takes, draw image tiles that geoapi colors, with the coloring in the
// tile URL as a token.
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

import { layerBlend } from "@/lib/style/compile/parts";
import { imageAdjustment, imagePaint, zoomRange } from "@/lib/style/compile/services";
import type { CompileSource, CompiledLayer } from "@/lib/style/compile/types";
import { combine, fromForm, toProperty } from "@/lib/style/compile/values";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";
import {
  type RasterColorSpec,
  alphaShare,
  rasterColorSpec,
  rgbOf,
  tableColorSpec,
} from "@/lib/style/raster/color";
import { MAX_TOKEN_LENGTH, rasterToken } from "@/lib/style/raster/token";
import {
  type BandFacts,
  type RasterValues,
  type ReliefStop,
  TILE_SIZE,
  type ValueQuery,
  reliefColor,
  reliefStops,
  resamplingOf,
  valueQuery,
  valueTilesUrl,
  verticalScale,
} from "@/lib/style/raster/values";

type RasterSource = Extract<CompileSource, { type: "raster" }>;
type Bounds = RasterSource["bounds"];

/** A URL template with query parameters added. */
function withQuery(template: string, params: Record<string, string | undefined>): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  if (!query) return template;
  return `${template}${template.includes("?") ? "&" : "?"}${query}`;
}

/** A hillshade's light (3D spec 7.4): the scene's light through the global state `sunAzimuth` and `sunAltitude`,
 * its own direction and altitude while those are null (an automatic light), measured from north. */
export const illumination = (direction: number, altitude: number): Record<string, unknown> => ({
  "hillshade-illumination-direction": ["coalesce", ["global-state", "sunAzimuth"], direction],
  "hillshade-illumination-altitude": ["coalesce", ["global-state", "sunAltitude"], altitude],
  "hillshade-illumination-anchor": "map",
});

/** The hillshade paint (spec 9.6): one light that follows the scene's, or GDAL's four for `multidirectional`; the
 * layer opacity multiplies the colors' own alpha, since a hillshade has no opacity of its own. */
function hillshadePaint(style: JsonObject, render: JsonObject): Record<string, unknown> {
  const pick = <T>(key: string): T => (render[key] ?? DEFAULTS[`hillshade.${key}`]) as T;
  const method = pick<string>("method");
  const direction = pick<number>("direction");
  const altitude = pick<number>("altitude");
  const opacity = fromForm(style.opacity, "number", 1);
  const color = (hex: string) =>
    toProperty(
      combine(
        [opacity],
        ([a]) => {
          const [r, g, b] = rgbOf(hex);
          // The color's own alpha times the layer opacity (spec 4.6).
          const alpha = alphaShare(hex) * (typeof a === "number" ? a : 1);
          return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(4))})`;
        },
        { kind: "color" }
      )
    );
  const lights =
    method === "multidirectional"
      ? [-90, -45, 0, 45].map((d) => (((direction + d) % 360) + 360) % 360)
      : null;
  const shadow = color(pick<string>("shadow_color"));
  const highlight = color(pick<string>("highlight_color"));
  // A color array cannot be an expression over zoom: several lights take the opacity at the last zoom stop.
  const flat = (c: unknown) => (Array.isArray(c) && c[0] === "interpolate" ? c[c.length - 1] : c);
  const paint: Record<string, unknown> = {
    "hillshade-method": method,
    // An expression cannot build the four lights' array: several lights keep their own.
    ...(lights
      ? {
          "hillshade-illumination-direction": lights,
          "hillshade-illumination-altitude": lights.map(() => altitude),
          "hillshade-illumination-anchor": "map",
        }
      : illumination(direction, altitude)),
    "hillshade-exaggeration": pick<number>("exaggeration"),
    "hillshade-shadow-color": lights ? lights.map(() => flat(shadow)) : shadow,
    "hillshade-highlight-color": lights ? lights.map(() => flat(highlight)) : highlight,
  };
  if (method === "standard") paint["hillshade-accent-color"] = color(pick<string>("accent_color"));
  if (style.resampling === "nearest") paint.resampling = "nearest";
  return paint;
}

/** The value tiles' source: the cells' codes, decoded by MapLibre with their encoding, the values raised `k` times. */
function valueSource(
  coverage: string,
  query: ValueQuery,
  values: RasterValues,
  k: number,
  bounds: Bounds
): SourceSpecification {
  const { redFactor, greenFactor, blueFactor, baseShift } = values.encoding;
  return {
    type: "raster-dem",
    tiles: [valueTilesUrl(coverage, query, values)],
    tileSize: TILE_SIZE,
    encoding: "custom",
    redFactor: redFactor * k,
    greenFactor: greenFactor * k,
    blueFactor: blueFactor * k,
    baseShift: baseShift * k,
    ...(values.maxzoom !== undefined ? { maxzoom: values.maxzoom } : {}),
    ...(bounds ? { bounds } : {}),
  };
}

/** The color-relief stops of a coloring over value tiles of `values`; null where the browser does not color them and
 * geoapi does: images, float codes of an unknown range (they cover only a stand-in span, too narrow to place colors
 * on), a coloring past the stop limit. */
export function browserStops(spec: RasterColorSpec | null, values: RasterValues): ReliefStop[] | null {
  const placeable = values.range !== null || values.integer;
  return placeable && spec && spec.kind !== "rgb" ? reliefStops(spec, values) : null;
}

/** Whether a raster style draws value tiles once their description (`values`) is loaded: colors the browser paints,
 * or a hillshade's shading; for an image drawn with its file's color table, with the file's band facts (`facts`).
 * Where it does not, nothing on the map holds the cells' values. */
export function drawsValueTiles(
  style: JsonObject,
  values: RasterValues,
  facts?: Partial<BandFacts>
): boolean {
  const render: JsonObject = isObject(style.render) ? style.render : { type: "image" };
  if (!valueQuery(style, facts)) return false;
  const spec = tableColorSpec(style, facts) ?? rasterColorSpec(render);
  return render.type === "hillshade" || browserStops(spec, values) !== null;
}

/** Whether an image is drawn with its file's color table (spec 9.1), from the file's facts alone: a color table, values
 * not scaled, no three chosen bands. The adjustments do not count: with one by zoom the colored tiles draw it, still in
 * the table's colors. */
function drawnWithTable(render: JsonObject, facts: Partial<BandFacts> | undefined): boolean {
  if (!facts?.colorTable || facts.scaled === true) return false;
  return !(Array.isArray(render.bands) && render.bands.filter((b) => typeof b === "number").length === 3);
}

/** Whether a raster's blend is drawn (spec 4.7): for an image (or no render) that its file's color table does not
 * color, with the file's band facts `facts`; the colors of values and a hillshade never mix. */
export function rasterBlendDrawn(render: JsonObject, facts: Partial<BandFacts> | undefined): boolean {
  return (render.type === "image" || render.type === undefined) && !drawnWithTable(render, facts);
}

/** An image's coloring by its file's color table (`tableColorSpec`) with the style's adjustments on its colors, as
 * MapLibre's raster layer would show the image (`imageAdjustment`). */
function adjusted<S extends { classes: Array<{ color: string | null }> }>(spec: S, style: JsonObject): S {
  const adjust = imageAdjustment(style);
  if (!adjust) return spec;
  return { ...spec, classes: spec.classes.map((c) => ({ ...c, color: c.color && adjust(c.color) })) };
}

/** The layers of a raster file style; its sources and colorings go into `out`. */
export function rasterLayers(
  id: string,
  source: RasterSource,
  style: JsonObject,
  out: CompiledLayer
): LayerSpecification[] {
  const render: JsonObject = isObject(style.render) ? style.render : { type: "image" };
  // An image drawn with its file's color table colors its table band's values in the table's colors, once the colored
  // tiles' description has told the table; where those values failed (null), the colored tiles draw it, as any image.
  const facts = source.values === null ? undefined : source.image?.bands;
  const table = tableColorSpec(style, facts);
  // The adjustments are an image's (categories without classes have none, as `imagePaint` gives them none).
  const image = render.type === "image" || render.type === undefined;
  const spec = table ? (image ? adjusted(table, style) : table) : rasterColorSpec(render);
  const query = valueQuery(style, facts);
  const values = query ? (source.values ?? undefined) : undefined;
  // A render of values draws once their description is loaded, an image whose source names the colored tiles'
  // description once that has answered (null: there is none); until then nothing, and nothing is missing.
  if (query ? !values : source.tileset !== undefined && source.image === undefined) return [];
  // A hillshade alone still draws from values of an unknown range (flat, as their span is).
  const stops = values ? browserStops(spec, values) : null;
  // Images, colors over an unknown range and a coloring with more stops than color-relief takes draw image tiles; an
  // image's own coloring, never its table's classes.
  const token = spec && !stops ? rasterToken(table ? rasterColorSpec(render)! : spec) : null;
  // A coloring too long for a URL (hundreds of categories past the stop limit) is not sent (spec 19: raster_service).
  if (token && token.length > MAX_TOKEN_LENGTH) {
    out.unsupported.push("raster_service");
    return [];
  }
  const zooms = zoomRange(style);
  // What a loaded description says, the value tiles' or else the colored tiles': the file's bounds as read from its
  // header (none when they are no box on earth), its native zoom, and the version that lets caches keep the tiles.
  // Without one, the bounds the layer holds.
  const described = values ?? source.image ?? undefined;
  const bounds = described ? described.bounds : source.bounds;
  const layers: LayerSpecification[] = [];
  if (token) {
    out.sources[source.id] = {
      type: "raster",
      tiles: [
        withQuery(source.tiles, {
          style: token,
          v: described?.version ?? source.version,
          tilesize: String(TILE_SIZE),
        }),
      ],
      tileSize: TILE_SIZE,
      // Past the file's native zoom MapLibre magnifies the deepest tiles with the layer's resampling.
      ...(described?.maxzoom !== undefined ? { maxzoom: described.maxzoom } : {}),
      ...(bounds ? { bounds } : {}),
    };
    const paint = imagePaint(style, render.type === "image" || render.type === undefined);
    if (resamplingOf(style, facts) === "nearest") paint["raster-resampling"] = "nearest";
    // An image mixes with what is below (spec 4.7), unless its file's color table colors it, whatever tiles draw it;
    // the colors of values and a hillshade never do.
    const blend = rasterBlendDrawn(render, source.image?.bands) ? layerBlend(style) : null;
    if (blend) paint["raster-layer-blend"] = blend;
    layers.push({
      id: `${id}-raster`,
      type: "raster",
      source: source.id,
      ...zooms,
      paint,
    } as LayerSpecification);
  }
  if (!query || !values || (!stops && render.type !== "hillshade")) return layers;
  // The value tiles: the colors' and the shading's source, next to image tiles when those draw the colors. A hillshade
  // raises flat terrain on the source (spec 9.6), and the colors on it move with the heights.
  const valuesId = token ? `${source.id}-values` : source.id;
  const k = render.type === "hillshade" ? verticalScale(values.range) : 1;
  out.sources[valuesId] = valueSource(source.coverage, query, values, k, bounds);
  if (stops) {
    const paint: Record<string, unknown> = { "color-relief-color": reliefColor(stops, values, k) };
    const opacity = toProperty(fromForm(style.opacity, "number", 1));
    if (opacity !== 1) paint["color-relief-opacity"] = opacity;
    if (resamplingOf(style, facts) === "nearest") paint.resampling = "nearest";
    layers.push({
      id: `${id}-relief`,
      type: "color-relief",
      source: valuesId,
      ...zooms,
      paint,
    } as LayerSpecification);
  }
  if (render.type === "hillshade") {
    layers.push({
      id: `${id}-hillshade`,
      type: "hillshade",
      source: valuesId,
      ...zooms,
      paint: hillshadePaint(style, render),
    } as LayerSpecification);
  }
  return layers;
}
