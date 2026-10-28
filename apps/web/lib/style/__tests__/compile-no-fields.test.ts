// The map compiles styles without field types: numbers are told apart from text while drawing,
// date steps slice whatever the type, and with field types the output stays exactly what it was.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compileLayer, sourceKind } from "@/lib/style/compile";
import type { CompileInput, CompiledLayer } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { fieldTypes, sampleDatasets, specExamples } from "./fixtures";
import { maplibreErrors } from "./maplibre";

const GOLDEN = resolve(__dirname, "golden/spec-examples.json");
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

const compileExample = (example: (typeof examples)[number], withFields: boolean): CompiledLayer => {
  const dataset = datasets[example.target];
  return compileLayer({
    id: "1",
    style: example.doc,
    geometry: dataset.geometry,
    fields: withFields ? fieldTypes(dataset) : undefined,
    source: source(example.doc, example.target),
    highlight: true,
  });
};

const outputs = (withFields: boolean) =>
  Object.fromEntries(
    examples.map((e) => [String(e.line), JSON.parse(JSON.stringify(compileExample(e, withFields)))])
  );

describe("compiling without field types", () => {
  it("with fields the output is unchanged", async () => {
    // Written before the compiler learned to work without field types; `vitest -u` rewrites it.
    await expect(`${JSON.stringify(outputs(true), null, 1)}\n`).toMatchFileSnapshot(GOLDEN);
  });

  it("outputs pass validateStyleMin", () => {
    for (const example of examples) {
      if (example.expect.length) continue;
      const out = compileExample(example, false);
      expect([example.line, maplibreErrors(out.layers, out.sources, out.state)]).toEqual([example.line, []]);
    }
  });

  it("a label on an unknown numeric field formats numbers and leaves text alone", () => {
    const out = compileLayer({
      id: "7",
      style: { version: 1, kind: "vector", symbol: { label: { text: "{pop} people" } } } as LayerStyle,
      geometry: "point",
      source: { type: "tiles", id: "s", tiles: ["https://tiles.example/{z}/{x}/{y}"] },
    });
    const label = out.layers.find((l) => l.id === "7-label") as { layout: Record<string, unknown> };
    const text = JSON.stringify(label.layout["text-field"]);
    expect(text).toContain('["typeof",["get","pop"]],"number"');
    expect(text).toContain('"number-format"');
    expect(text).toContain('["to-string",["get","pop"]]');
    expect(out.state.locale).toBeDefined();
  });

  it("time steps work without fields", () => {
    const out = compileLayer({
      id: "7",
      style: {
        version: 1,
        kind: "vector",
        symbol: { marker: { color: "#cc0000" } },
        time: { field: "opened", step: "year" },
      } as LayerStyle,
      geometry: "point",
      source: { type: "tiles", id: "s", tiles: ["https://tiles.example/{z}/{x}/{y}"] },
      entry: { time: { value: 2024 } },
    });
    const marker = out.layers.find((l) => l.id === "7-marker") as { filter: unknown };
    expect(JSON.stringify(marker.filter)).toContain(
      '["slice",["to-string",["get","opened"]],0,4],["to-string",["global-state","7:time"]]'
    );
  });
});
