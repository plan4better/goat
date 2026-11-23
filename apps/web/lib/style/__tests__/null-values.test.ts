// A feature without a value: GeoJSON sources (clustered points from geoapi's items, pending edits) keep a NULL as a
// property holding null, vector tiles leave it out. Both are "no value" on the map, as in the legend; 0, "" and false
// are values.
import { createExpression, featureFilter as maplibreFilter } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { classIndexOf } from "@/lib/style/legend";

import { evaluate, maplibreErrors } from "./maplibre";

const points = { type: "points" as const, id: "s9", data: "https://geoapi/collections/9/items?f=json" };
const tiles = { type: "tiles" as const, id: "s9", tiles: ["https://t/{z}/{x}/{y}"] };

const compile = (style: object, extra: Partial<CompileInput> = {}) =>
  compileLayer({
    id: "9",
    style: { version: "1.0.0", kind: "vector", ...style } as LayerStyle,
    geometry: "point",
    source: points,
    ...extra,
  });

type Layer = {
  id: string;
  type: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};

const marker = (out: ReturnType<typeof compileLayer>) =>
  out.layers.find((l) => l.type === "circle") as unknown as Layer;

/** A text expression evaluated in a locale (number labels read it from the global state). */
const textOf = (expr: unknown, properties: Record<string, unknown>) => {
  const parsed = createExpression(expr, "layers[0].layout.text-field");
  if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
  return String(
    parsed.value.evaluate(
      { zoom: 14, globalState: { locale: "en-US" } } as never,
      { type: 1, properties } as never
    )
  );
};

const valid = (out: ReturnType<typeof compileLayer>) => maplibreErrors(out.layers, out.sources);

/** The four ways a feature can hold (or not hold) a value. */
const absent = {};
const empty = (field: string) => ({
  null: { [field]: null },
  zero: { [field]: 0 },
  text: { [field]: "" },
});

const CIRCLE = { shape: "circle", color: "#999999", size: 10 };

const [RED, GREEN, BLUE, GREY] = ["#ff0000", "#00ff00", "#0000ff", "#999999"];
/** The color an expression gives a feature, as the style writes it. */
const colorOf = (expr: unknown, properties: Record<string, unknown>) => evaluate(expr, properties);

describe("a NULL property is no value (GeoJSON sources)", () => {
  it("categories: NULL and absent take No data, 0 and empty text take Other", () => {
    const out = compile({
      render: { type: "cluster" },
      symbol: { marker: CIRCLE },
      classify: [
        {
          field: "kind",
          method: "categories",
          classes: [{ values: ["a"], marker: { color: "#ff0000" } }],
          other: { marker: { color: "#00ff00" } },
          no_data: { marker: { color: "#0000ff" } },
        },
      ],
    });
    const color = marker(out).paint!["circle-color"];
    const f = empty("kind");
    expect([absent, f.null, f.zero, f.text, { kind: "a" }].map((p) => colorOf(color, p))).toEqual([
      BLUE,
      BLUE,
      GREEN,
      GREEN,
      RED,
    ]);
    // The legend and the popup classify the same way.
    const c = { method: "categories", classes: [{ values: ["a"] }] };
    expect([null, undefined, 0, ""].map((v) => classIndexOf(c, v))).toEqual([
      "no_data",
      "no_data",
      "other",
      "other",
    ]);
    // geoapi is still asked for the field.
    expect(out.tileParams.fields).toContain("kind");
    expect(valid(out)).toEqual([]);
  });

  it("categories without No data: a NULL keeps the base value instead of Other", () => {
    const out = compile({
      render: { type: "cluster" },
      symbol: { marker: CIRCLE },
      classify: [
        {
          field: "kind",
          method: "categories",
          classes: [{ values: ["a"], marker: { color: "#ff0000" } }],
          other: { marker: { color: "#00ff00" } },
        },
      ],
    });
    const color = marker(out).paint!["circle-color"];
    expect([absent, { kind: null }, { kind: 0 }].map((p) => colorOf(color, p))).toEqual([GREY, GREY, GREEN]);
  });

  it("numeric classes: a NULL takes No data, not the first class; 0 is in the first class", () => {
    const out = compile({
      render: { type: "cluster" },
      symbol: { marker: CIRCLE },
      classify: [
        {
          field: "n",
          method: "manual",
          classes: [
            { to: 10, marker: { color: "#ff0000" } },
            { from: 10, marker: { color: "#00ff00" } },
          ],
          no_data: { marker: { color: "#0000ff" } },
        },
      ],
    });
    const color = marker(out).paint!["circle-color"];
    expect([absent, { n: null }, { n: 0 }, { n: 12 }].map((p) => colorOf(color, p))).toEqual([
      BLUE,
      BLUE,
      RED,
      GREEN,
    ]);
  });

  it("no_data visible false hides NULL and absent values, not 0 or empty text", () => {
    const out = compile({
      render: { type: "cluster" },
      symbol: { marker: CIRCLE },
      classify: [
        {
          field: "kind",
          method: "categories",
          classes: [{ values: ["a"], marker: { color: "#ff0000" } }],
          other: { marker: { color: "#00ff00" } },
          no_data: { visible: false },
        },
      ],
    });
    const filter = maplibreFilter(marker(out).filter as never, "layers[0].filter");
    const shows = (properties: Record<string, unknown>) =>
      filter.filter({ zoom: 14 }, { type: 1, properties, geometry: [] } as never);
    const f = empty("kind");
    expect([absent, f.null, f.zero, f.text, { kind: "a" }].map(shows)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("a size by attribute draws its no_data for a NULL and its range for 0", () => {
    const out = compile({
      render: { type: "cluster" },
      symbol: {
        marker: { ...CIRCLE, size: { field: "n", range: [4, 20], domain: [0, 10], no_data: 2 } },
      },
    });
    const radius = marker(out).paint!["circle-radius"];
    const sizes = [absent, { n: null }, { n: 0 }, { n: 10 }].map((p) => evaluate(radius, p));
    expect(sizes[0]).toBe(sizes[1]);
    expect(sizes[2]).not.toBe(sizes[1]);
    expect(sizes[3]).toBeGreaterThan(sizes[2] as number);
    for (const scale of ["sqrt", "log"]) {
      const scaled = marker(
        compile({
          render: { type: "cluster" },
          symbol: {
            marker: { ...CIRCLE, size: { field: "n", range: [4, 20], domain: [1, 10], no_data: 2, scale } },
          },
        })
      ).paint!["circle-radius"];
      expect([scale, evaluate(scaled, { n: null })]).toEqual([scale, evaluate(scaled, absent)]);
    }
    const flat = marker(
      compile({
        render: { type: "cluster" },
        symbol: { marker: { ...CIRCLE, size: { field: "n", range: [4, 20], domain: [5, 5], no_data: 2 } } },
      })
    ).paint!["circle-radius"];
    expect([evaluate(flat, { n: null }), evaluate(flat, { n: 0 })]).toEqual([
      evaluate(flat, absent),
      evaluate(flat, { n: 5 }),
    ]);
  });

  it("an isNull rule matches NULL and absent values, not 0 or empty text", () => {
    const out = compile({
      render: { type: "cluster" },
      symbol: { marker: CIRCLE },
      rules: [{ when: { op: "isNull", args: [{ property: "name" }] }, marker: { color: "#ff0000" } }],
    });
    const color = marker(out).paint!["circle-color"];
    const f = empty("name");
    expect([absent, f.null, f.zero, f.text].map((p) => colorOf(color, p))).toEqual([RED, RED, GREY, GREY]);
  });

  it("a number in a label shows nothing for a NULL and 0 for 0", () => {
    const out = compileLayer({
      id: "9",
      style: {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: CIRCLE, label: { text: "{n}" } },
      } as LayerStyle,
      geometry: "point",
      fields: { n: "number" },
      source: tiles,
    });
    const label = out.layers.find((l) => (l as Layer).layout?.["text-field"]) as unknown as Layer;
    expect([absent, { n: null }, { n: 0 }].map((p) => textOf(label.layout!["text-field"], p))).toEqual([
      "",
      "",
      "0",
    ]);
  });

  it("a heatmap weight of one value weighs a NULL 0", () => {
    const out = compileLayer({
      id: "9",
      style: {
        version: "1.0.0",
        kind: "vector",
        render: { type: "heatmap", weight: { field: "w", domain: [3, 3] } },
      } as LayerStyle,
      geometry: "point",
      source: tiles,
    });
    const heatmap = out.layers.find((l) => l.type === "heatmap") as unknown as Layer;
    const weight = heatmap.paint!["heatmap-weight"];
    expect([absent, { w: null }, { w: 0 }].map((p) => evaluate(weight, p))).toEqual([0, 0, 1]);
  });
});

describe("cluster values skip NULLs", () => {
  const shops = (op: string) =>
    compile({
      render: { type: "cluster", value: { op, field: "turnover" }, symbol: { label: { text: "{value}" } } },
    });
  const accumulators = (out: ReturnType<typeof compileLayer>) =>
    (out.sources.s9 as { clusterProperties: Record<string, [unknown, unknown]> }).clusterProperties;

  it("a NULL adds nothing to the sum and the count of values; min and max ignore it", () => {
    for (const op of ["sum", "mean", "min", "max"]) {
      const props = accumulators(shops(op));
      const value = props.goat_cluster_value[1];
      const n = props.goat_cluster_value_n[1];
      expect([
        op,
        evaluate(n, { turnover: null }),
        evaluate(n, absent),
        evaluate(n, { turnover: 0 }),
      ]).toEqual([op, 0, 0, 1]);
      expect([op, evaluate(value, { turnover: null })]).toEqual([op, evaluate(value, absent)]);
      expect([op, evaluate(value, { turnover: 0 })]).toEqual([op, 0]);
    }
    expect(evaluate(accumulators(shops("min")).goat_cluster_value[1], { turnover: null })).toBe(1e300);
    expect(evaluate(accumulators(shops("max")).goat_cluster_value[1], { turnover: null })).toBe(-1e300);
  });

  it("a cluster whose points have no value shows no number for any op", () => {
    for (const op of ["sum", "mean", "min", "max"]) {
      const out = shops(op);
      const label = out.layers.find((l) => l.id.endsWith("cluster-label")) as unknown as Layer;
      const props = {
        point_count: 3,
        goat_cluster_value: op === "min" ? 1e300 : op === "max" ? -1e300 : 0,
        goat_cluster_value_n: 0,
      };
      expect([op, textOf(label.layout!["text-field"], props)]).toEqual([op, ""]);
      expect(valid(out)).toEqual([]);
    }
  });
});

describe("expression size", () => {
  it("256 categories with Other and No data compile to a valid style that tells NULL apart", () => {
    const classes = Array.from({ length: 256 }, (_, i) => ({
      values: [`v${i}`],
      marker: { color: `#${(i * 997).toString(16).padStart(6, "0").slice(-6)}` },
      ...(i % 50 === 0 ? { visible: false } : {}),
    }));
    const out = compile({
      render: { type: "cluster" },
      symbol: { marker: CIRCLE },
      classify: [
        {
          field: "kind",
          method: "categories",
          classes,
          other: { marker: { color: "#00ff00" } },
          no_data: { marker: { color: "#0000ff" }, visible: false },
        },
      ],
    });
    expect(valid(out)).toEqual([]);
    const color = marker(out).paint!["circle-color"];
    expect([{ kind: null }, { kind: "zzz" }].map((p) => colorOf(color, p))).toEqual([BLUE, GREEN]);
  });
});
