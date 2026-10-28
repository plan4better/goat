// Every checked example of the spec compiles; the valid ones to MapLibre styles without validation errors.
import { describe, expect, it } from "vitest";

import { compileLayer, sourceKind } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { fieldTypes, sampleDatasets, specExamples } from "./fixtures";
import { maplibreErrors } from "./maplibre";

const datasets = sampleDatasets();
const examples = specExamples().filter((e) => e.target in datasets);

function source(doc: LayerStyle, target: string): CompileInput["source"] {
  const dataset = datasets[target];
  if (dataset.source === "wms")
    return {
      type: "service",
      id: "s",
      service: "wms",
      tiles: "https://wms.example/?STYLES=&BBOX={bbox-epsg-3857}",
    };
  if (dataset.source === "xyz")
    return { type: "service", id: "s", service: "xyz", tiles: "https://tiles.example/{z}/{x}/{y}.png" };
  if (dataset.kind === "raster")
    return {
      type: "raster",
      id: "s",
      tiles: "https://geo/collections/d/raster/tiles/{z}/{x}/{y}.webp",
      dem: "https://geo/collections/d/raster/dem/{z}/{x}/{y}.webp",
    };
  if (sourceKind(doc) === "points") return { type: "points", id: "s", data: "https://geoapi.example/items" };
  return { type: "tiles", id: "s", tiles: ["https://tiles.example/{z}/{x}/{y}"] };
}

describe("the spec's examples", () => {
  it.each(examples.map((e) => [e.line, e.target, e] as const))(
    "line %i (%s) compiles",
    (_line, target, example) => {
      const dataset = datasets[target];
      const out = compileLayer({
        id: "1",
        style: example.doc,
        geometry: dataset.geometry,
        fields: fieldTypes(dataset),
        source: source(example.doc, target),
        highlight: true,
      });
      if (!example.expect.length) expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
    }
  );
});
