import { describe, expect, it } from "vitest";

import { compileLayer, sourceKind } from "@/lib/style/compile";
import type { CompileInput, CompiledLayer, Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { maplibreErrors } from "./maplibre";

const TILES = { type: "tiles" as const, id: "s7", tiles: ["https://t/{z}/{x}/{y}"] };

describe("compileLayer", () => {
  it("names the source and defaults the position", () => {
    const out = compileLayer({
      id: "7",
      style: { version: "1.0.0", kind: "vector" } as LayerStyle,
      geometry: "point",
      source: TILES,
    });
    expect(out.sources).toEqual({ s7: { type: "vector", tiles: ["https://t/{z}/{x}/{y}"], maxzoom: 14 } });
    expect(out.position).toBe("top");
    expect(out.unsupported).toEqual([]);
  });

  it("passes the position through and says which source a style needs", () => {
    const out = compileLayer({
      id: "7",
      style: { version: "1.0.0", kind: "vector" } as LayerStyle,
      source: TILES,
      entry: { position: "below_labels" },
    });
    expect(out.position).toBe("below_labels");
    expect(sourceKind({ version: "1.0.0", kind: "vector", render: { type: "cluster" } } as LayerStyle)).toBe(
      "points"
    );
    expect(sourceKind({ version: "1.0.0", kind: "vector" } as LayerStyle)).toBe("tiles");
    expect(sourceKind({ version: "1.0.0", kind: "raster", render: { type: "image" } } as LayerStyle)).toBe(
      "raster"
    );
  });
});

describe("blend (spec 4.7)", () => {
  const POINTS: CompileInput["source"] = { type: "points", id: "s7", data: "https://geoapi.example/items" };
  const BLENDS = ["multiply", "screen", "overlay", "color"] as const;

  const compile = (
    style: object,
    geometry: Geometry,
    source: CompileInput["source"] = TILES,
    blend?: string
  ): CompiledLayer =>
    compileLayer({
      id: "7",
      style: { version: "1.0.0", kind: "vector", ...style, ...(blend ? { blend } : {}) } as LayerStyle,
      geometry,
      source,
      highlight: true,
    });

  /** Each layer's blend property and its value, by layer id; layers without one are left out. */
  const blends = (out: CompiledLayer): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      out.layers
        .map((layer) => {
          const paint = (layer.paint ?? {}) as Record<string, unknown>;
          const own = Object.entries(paint).filter(([key]) => key.endsWith("-layer-blend"));
          return [layer.id, Object.fromEntries(own)] as const;
        })
        .filter(([, own]) => Object.keys(own).length)
    );

  /** The output with every blend property taken out again. */
  const withoutBlend = (out: CompiledLayer): CompiledLayer => {
    const copy = JSON.parse(JSON.stringify(out)) as CompiledLayer;
    for (const layer of copy.layers) {
      const paint = (layer.paint ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(paint)) if (key.endsWith("-layer-blend")) delete paint[key];
    }
    return copy;
  };

  /** Compiled with each blend: the blend properties it writes, and otherwise exactly the output without the key. */
  function compiledWith(style: object, geometry: Geometry, source: CompileInput["source"] = TILES) {
    const plain = compile(style, geometry, source);
    return BLENDS.map((blend) => {
      const out = compile(style, geometry, source, blend);
      expect(withoutBlend(out)).toEqual(JSON.parse(JSON.stringify(plain)));
      expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
      return { blend, out };
    });
  }

  const POLYGON = {
    symbol: {
      fill: { color: "#fcbba1", pattern: "hatch_45", pattern_color: "#cb181d" },
      outline: { color: "#555555", width: 2 },
      label: { text: "{name}" },
    },
  };

  it("a polygon's fill and pattern take fill-layer-blend, its outline line-layer-blend; labels draw normally", () => {
    for (const { blend, out } of compiledWith(POLYGON, "polygon")) {
      expect(blends(out)).toEqual({
        "7-fill": { "fill-layer-blend": blend },
        "7-pattern": { "fill-layer-blend": blend },
        "7-outline": { "line-layer-blend": blend },
      });
    }
  });

  it("with a layer opacity both properties go on each layer", () => {
    const out = compile({ ...POLYGON, opacity: 0.5 }, "polygon", TILES, "multiply");
    for (const id of ["7-fill", "7-pattern"])
      expect(out.layers.find((l) => l.id === id)?.paint).toMatchObject({
        "fill-layer-opacity": 0.5,
        "fill-layer-blend": "multiply",
      });
    expect(out.layers.find((l) => l.id === "7-outline")?.paint).toMatchObject({
      "line-layer-opacity": 0.5,
      "line-layer-blend": "multiply",
    });
    expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
  });

  it("the highlight edge of a polygon without an outline draws normally", () => {
    for (const { out } of compiledWith(
      { symbol: { fill: { color: "#fcbba1" }, outline: false } },
      "polygon"
    )) {
      expect(out.layers.map((l) => l.id)).toEqual(["7-fill", "7-outline"]);
      expect(Object.keys(blends(out))).toEqual(["7-fill"]);
    }
  });

  it("raised polygons draw normally; their outline on the ground mixes", () => {
    const raised = { symbol: { extrude: { height: 20 }, outline: { width: 1 } } };
    for (const { blend, out } of compiledWith(raised, "polygon")) {
      expect(out.layers.find((l) => l.id === "7-fill")?.type).toBe("fill-extrusion");
      expect(blends(out)).toEqual({ "7-outline": { "line-layer-blend": blend } });
    }
  });

  it("a line and its casing take line-layer-blend; arrows and labels draw normally", () => {
    const line = {
      symbol: {
        line: { color: "#2166ac", width: 4 },
        casing: { width: 2 },
        arrows: { placement: "repeat" },
        label: { text: "{name}" },
      },
    };
    for (const { blend, out } of compiledWith(line, "line")) {
      expect(out.layers.map((l) => l.id)).toEqual(expect.arrayContaining(["7-arrows", "7-label"]));
      expect(blends(out)).toEqual({
        "7-casing": { "line-layer-blend": blend },
        "7-line": { "line-layer-blend": blend },
      });
    }
  });

  it("flat hexagons take it on their fill and outline; columns draw normally", () => {
    const flat = { render: { type: "h3", outline: { width: 1 } } };
    for (const { blend, out } of compiledWith(flat, "point")) {
      expect(blends(out)).toEqual({
        "7-h3-fill": { "fill-layer-blend": blend },
        "7-h3-outline": { "line-layer-blend": blend },
      });
    }
    const columns = { render: { type: "h3", extrude: { tallest: 500 }, outline: { width: 1 } } };
    for (const { out } of compiledWith(columns, "point")) expect(blends(out)).toEqual({});
  });

  it("points drawn as features, a heatmap and clusters draw normally", () => {
    const features = { symbol: { marker: { color: "#cc0000" }, label: { text: "{name}" } } };
    for (const { out } of compiledWith(features, "point")) expect(blends(out)).toEqual({});
    const heatmap = { render: { type: "heatmap", points_from_zoom: 14 } };
    for (const { out } of compiledWith(heatmap, "point")) expect(blends(out)).toEqual({});
    for (const { out } of compiledWith({ render: { type: "cluster" } }, "point", POINTS))
      expect(blends(out)).toEqual({});
  });

  it("normal writes nothing: the output is the one without the key", () => {
    for (const [style, geometry] of [
      [POLYGON, "polygon"],
      [{ symbol: { line: { color: "#2166ac" }, casing: { width: 1 } } }, "line"],
      [{ render: { type: "h3", outline: { width: 1 } } }, "point"],
    ] as const)
      expect(compile(style, geometry, TILES, "normal")).toEqual(compile(style, geometry));
  });
});
