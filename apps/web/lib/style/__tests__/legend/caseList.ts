// The legend test cases built from goatlib's fixtures: the generated styles over a made-up dataset (every pair of
// style settings, the server's classes written in; packages/python/goatlib/tests/unit/style/legend_cases.py), the
// spec's checked examples, and the generated block of automatic colors, None and transparency (`buildColorCases`),
// each case of which carries the basemap's tone it is drawn on. No case reads user data. Nothing here reads files, so the style lab builds the same cases
// in the browser from the fixtures it imports as JSON; cases.ts loads them for the jsdom tests.
import { sourceKind } from "@/lib/style/compile";
import type { CompileInput, FieldType, Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import type { Tone } from "@/lib/style/tone";

import { type SampleDataset, type SpecExample, fieldTypes } from "../fixtureTypes";

export interface LegendCase {
  id: string;
  /** A generated case's value per dimension; none for a spec example. */
  values?: Record<string, string>;
  style: JsonObject;
  /** The dataset's geometry; none for a raster. */
  geometry?: Geometry;
  zoom: number;
  fields: Record<string, FieldType>;
  /** The spec example's sample dataset: where its data comes from (a file, a map service). */
  dataset?: SampleDataset;
  /** The legend image of a map service that has one. */
  serviceLegendUrl?: string;
  /** The basemap's tone a case of the colors is drawn on (`CompileInput.tone`); none for the other cases. */
  tone?: Tone;
}

interface GeneratedCase {
  id: string;
  values: Record<string, string>;
  geometry: Geometry;
  zoom: number;
  style: JsonObject;
}

/** legend_cases.json: the generated cases over one dataset's fields, and the block of automatic colors, None and
 * transparency over its own fields (the legend's and `color_hex`, hex text), each case with its basemap's tone and
 * its settings in `values`: the legend's (`geometry`, `render`, `method`, `target`, `base`, ...), `auto:<key>` ("yes"
 * where the key is `"auto"`), `label_colors`, `none`, `alpha` and `tone`. */
export interface GeneratedCases {
  fields: Record<string, FieldType>;
  cases: GeneratedCase[];
  colors?: {
    fields: Record<string, FieldType>;
    cases: Array<GeneratedCase & { tone: Tone }>;
  };
}

/** The generated cases, then the spec's examples of a layer style that are valid (not the map documents, the compiled
 * outputs or the mistakes), each over its sample dataset. */
export function buildLegendCases(
  generated: GeneratedCases,
  examples: SpecExample[],
  datasets: Record<string, SampleDataset>
): LegendCase[] {
  return [
    ...generated.cases.map((c) => ({ ...c, fields: generated.fields })),
    ...examples
      .filter((e) => e.target in datasets && !e.expect.length)
      .map((e): LegendCase => {
        const dataset = datasets[e.target];
        return {
          id: `spec-${e.line}`,
          style: e.doc as JsonObject,
          geometry: dataset.geometry,
          zoom: 12,
          fields: fieldTypes(dataset),
          dataset,
          ...(dataset.legend_image ? { serviceLegendUrl: "https://wms.example/legend.png" } : {}),
        };
      }),
  ];
}

/** The generated cases of automatic colors, None and transparency, each drawn on its basemap's tone; the cases
 * the review named (`focus-class-none`, `focus-data-color`) come last. */
export function buildColorCases(generated: GeneratedCases): LegendCase[] {
  const colors = generated.colors;
  return colors ? colors.cases.map((c) => ({ ...c, fields: colors.fields })) : [];
}

/** Whether the map draws the layer's single points at the case's zoom: a heatmap or an H3 layer draws them from
 * `points_from_zoom` on, or never (spec 8.1, 8.3); every other layer always. */
export function pointsDrawn(c: LegendCase): boolean {
  const render = isObject(c.style.render) ? c.style.render : {};
  if (render.type !== "heatmap" && render.type !== "h3") return true;
  return typeof render.points_from_zoom === "number" && c.zoom >= render.points_from_zoom;
}

/** What the compiler takes for a case: its style over a source of the kind its data has. */
export function compileInput(c: LegendCase): CompileInput {
  const style = c.style as unknown as LayerStyle;
  const dataset = c.dataset;
  let source: CompileInput["source"];
  if (dataset?.source === "wms")
    source = {
      type: "service",
      id: "s",
      service: "wms",
      tiles: "https://wms.example/?STYLES=&BBOX={bbox-epsg-3857}",
    };
  else if (dataset?.source === "xyz")
    source = { type: "service", id: "s", service: "xyz", tiles: "https://tiles.example/{z}/{x}/{y}.png" };
  else if (dataset?.kind === "raster")
    source = {
      type: "raster",
      id: "s",
      tiles: "https://geo.example/collections/d/raster/tiles/{z}/{x}/{y}.webp",
      coverage: "https://geo.example/collections/d/coverage/tiles/WebMercatorQuad",
      values: {
        encoding: { redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 1 },
        range: [0, 255],
        integer: true,
        version: "1-e1",
        maxzoom: 14,
      },
    };
  else if (sourceKind(style) === "points")
    source = { type: "points", id: "s", data: "https://geoapi.example/items" };
  else source = { type: "tiles", id: "s", tiles: ["https://tiles.example/{z}/{x}/{y}"] };
  return {
    id: "1",
    style,
    geometry: c.geometry,
    fields: c.fields,
    source,
    ...(c.tone ? { tone: c.tone } : {}),
  };
}
