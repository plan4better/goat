// The legend test cases: goatlib's generated styles over a made-up dataset (every pair of style settings, the
// server's classes written in; packages/python/goatlib/tests/unit/style/legend_cases.py) and the spec's checked
// examples. No case reads user data.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sourceKind } from "@/lib/style/compile";
import type { CompileInput, FieldType, Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";

import { type SampleDataset, fieldTypes, sampleDatasets, specExamples } from "../fixtures";

const FIXTURE = resolve(
  __dirname,
  "../../../../../../packages/python/goatlib/tests/unit/style/fixtures/legend_cases.json"
);

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

interface Generated {
  fields: Record<string, FieldType>;
  cases: Array<{
    id: string;
    values: Record<string, string>;
    geometry: Geometry;
    zoom: number;
    style: JsonObject;
  }>;
}

let cached: LegendCase[] | undefined;

export function legendCases(): LegendCase[] {
  if (cached) return cached;
  const generated = JSON.parse(readFileSync(FIXTURE, "utf8")) as Generated;
  const datasets = sampleDatasets();
  cached = [
    ...generated.cases.map((c) => ({ ...c, fields: generated.fields })),
    ...specExamples()
      // The examples of a layer style that are valid: not the map documents, the compiled outputs or the mistakes.
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
  return cached;
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
      dem: "https://geo.example/collections/d/raster/dem/{z}/{x}/{y}.webp",
    };
  else if (sourceKind(style) === "points")
    source = { type: "points", id: "s", data: "https://geoapi.example/items" };
  else source = { type: "tiles", id: "s", tiles: ["https://tiles.example/{z}/{x}/{y}"] };
  return { id: "1", style, geometry: c.geometry, fields: c.fields, source };
}
