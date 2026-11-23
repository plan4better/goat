// The legend test cases built from goatlib's fixtures: the generated styles over a made-up dataset (every pair of
// style settings, the server's classes written in; packages/python/goatlib/tests/unit/style/legend_cases.py) and the
// spec's checked examples. No case reads user data. Nothing here reads files, so the style lab builds the same cases
// in the browser from the fixtures it imports as JSON; cases.ts loads them for the jsdom tests.
import { sourceKind } from "@/lib/style/compile";
import type { CompileInput, FieldType, Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";

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
}

/** legend_cases.json: the generated cases over one dataset's fields. */
export interface GeneratedCases {
  fields: Record<string, FieldType>;
  cases: Array<{
    id: string;
    values: Record<string, string>;
    geometry: Geometry;
    zoom: number;
    style: JsonObject;
  }>;
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
  return { id: "1", style, geometry: c.geometry, fields: c.fields, source };
}
