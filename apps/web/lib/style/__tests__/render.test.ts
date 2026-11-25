import { createExpression } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import { PALETTES } from "@/lib/style/generated/catalog";
import type { LayerStyle } from "@/lib/style/generated/types";

import { specExamples } from "./fixtures";
import { evaluate, maplibreErrors } from "./maplibre";

const example = (line: number) => specExamples().find((e) => e.line === line)!.doc;
const tiles = { type: "tiles" as const, id: "s9", tiles: ["https://t/{z}/{x}/{y}"] };
const points = { type: "points" as const, id: "s9", data: "https://geoapi/collections/9/items?f=json" };
const compile = (style: object, source: CompileInput["source"] = tiles) =>
  compileLayer({ id: "9", style: style as LayerStyle, geometry: "point", source });
const byId = (out: ReturnType<typeof compileLayer>, suffix: string) =>
  out.layers.find((l) => l.id === `9-${suffix}`) as unknown as
    | Record<string, Record<string, unknown>>
    | undefined;
const valid = (out: ReturnType<typeof compileLayer>) => maplibreErrors(out.layers, out.sources, out.state);

describe("heatmaps", () => {
  it("compiles the spec 8.1 example: a heatmap, the facilities from zoom 15", () => {
    const out = compile(example(1666));
    expect(out.layers.map((l) => [l.id, l.type, l.minzoom, l.maxzoom])).toEqual([
      ["9-heatmap", "heatmap", undefined, 15],
      ["9-marker", "circle", 15, undefined],
    ]);
    const magma = PALETTES["d3:magma"].colors;
    expect(byId(out, "heatmap")?.paint).toEqual({
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 10, 15, 14, 40],
      "heatmap-weight": ["interpolate", ["linear"], ["to-number", ["get", "visitors"], 0], 0, 0, 50000, 1],
      "heatmap-color": [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(0, 0, 0, 0)",
        ...magma.flatMap((c, i) => [Number(((i + 1) / magma.length).toFixed(10)), c]),
      ],
    });
    expect(valid(out)).toEqual([]);
  });

  it("without points_from_zoom only the heatmap draws", () => {
    const out = compile({ version: "1.0.0", kind: "vector", render: { type: "heatmap" } });
    expect(out.layers.map((l) => l.id)).toEqual(["9-heatmap"]);
    expect(byId(out, "heatmap")?.paint["heatmap-radius"]).toBe(26);
  });
});

describe("clusters", () => {
  it("compiles the spec 8.2 example: a clustered GeoJSON source, cluster layers over the single points", () => {
    const out = compile(example(1702), points);
    expect(out.sources).toEqual({
      s9: {
        type: "geojson",
        data: points.data,
        cluster: true,
        clusterRadius: 50,
        clusterMinPoints: 3,
        clusterMaxZoom: 13,
      },
    });
    expect(out.layers.map((l) => l.id)).toEqual(["9-marker", "9-cluster-marker", "9-cluster-label"]);
    expect(byId(out, "marker")?.filter).toEqual(["!", ["has", "point_count"]]);
    expect(byId(out, "marker")?.["source-layer"]).toBeUndefined();
    expect(byId(out, "cluster-marker")?.filter).toEqual(["has", "point_count"]);
    expect(JSON.stringify(byId(out, "cluster-label")?.layout["text-field"])).toContain(
      '["get","point_count"]'
    );
    expect(JSON.stringify(byId(out, "cluster-marker")?.paint["circle-radius"])).toContain('"point_count"');
    expect(valid(out)).toEqual([]);
  });

  it("puts the count on the cluster, without a halo unless the cluster symbol sets one", () => {
    const cluster = (symbol?: object) =>
      byId(
        compile({ version: "1.0.0", kind: "vector", render: { type: "cluster", symbol } }, points),
        "cluster-label"
      );
    const label = cluster();
    expect(label?.layout["text-variable-anchor-offset"]).toBeUndefined();
    expect(label?.layout["text-anchor"]).toBeUndefined();
    expect(label?.layout["text-offset"]).toBeUndefined();
    expect(label?.paint["text-halo-width"]).toBe(0);
    const own = cluster({
      marker: { shape: "circle", size: 30 },
      label: { text: "{count}", placement: "above", halo: { color: "#000000", width: 1 } },
    });
    expect(own?.layout["text-variable-anchor-offset"]).toBeUndefined();
    expect(own?.layout["text-anchor"]).toBeUndefined();
    expect(own?.paint["text-halo-color"]).toBe("#000000");
    expect(own?.paint["text-halo-width"]).toBe(1);
  });

  it("lists the fields the drawing reads, for the points request", () => {
    const out = compile(
      {
        version: "1.0.0",
        kind: "vector",
        render: {
          type: "cluster",
          symbol: { marker: { shape: "circle", color: { field: "count", palette: "d3:viridis" } } },
        },
        symbol: {
          marker: { shape: "circle", size: { field: "pupils", domain: [0, 900], range: [4, 12] } },
          label: { text: "{name}" },
        },
        classify: [
          {
            id: "k",
            field: "kind",
            method: "categories",
            classes: [{ id: "a", values: ["A"], marker: { color: "#ff0000" } }],
          },
        ],
        rules: [{ when: { op: "=", args: [{ property: "closed" }, true] }, visible: false }],
        time: { field: "opened", step: "day" },
        order: { field: "rank" },
      },
      points
    );
    expect(out.tileParams.fields).toEqual(["closed", "kind", "name", "opened", "pupils", "rank"]);
  });

  it("asks for no fields when the drawing reads none", () => {
    const out = compile({ version: "1.0.0", kind: "vector", render: { type: "cluster" } }, points);
    expect(out.tileParams.fields).toEqual([]);
  });
});

describe("clusters drawn like the points (spec 8.2 look and count)", () => {
  const iconsByKind = {
    version: "1.0.0",
    kind: "vector",
    symbol: { marker: { shape: "icon", icon: "goat:shop", color: "#5a1846", size: 20 } },
    classify: [
      {
        id: "k",
        field: "kind",
        method: "categories",
        classes: [
          { id: "a", values: ["bakery"], marker: { icon: "goat:bakery" } },
          { id: "b", values: ["cafe", "bar"], marker: { icon: "goat:restaurant" } },
        ],
        other: { visible: false },
      },
    ],
  };
  const clustered = (render: object, style: object = iconsByKind, fields?: Record<string, "string">) =>
    compileLayer({
      id: "9",
      style: { ...style, render: { type: "cluster", ...render } } as LayerStyle,
      geometry: "point",
      source: points,
      fields,
    });
  const sourceOf = (out: ReturnType<typeof compileLayer>) =>
    out.sources.s9 as { clusterProperties?: Record<string, unknown> };
  const offsets = (out: ReturnType<typeof compileLayer>, properties: Record<string, unknown>, zoom = 10) => {
    const badge = byId(out, "cluster-badge")!;
    const size = badge.layout["text-size"] as number;
    const text = evaluate(badge.layout["text-offset"], properties, zoom) as number[];
    return {
      icon: evaluate(badge.layout["icon-offset"], properties, zoom),
      text: text.map((em) => Number((em * size).toFixed(6))),
    };
  };

  it("counts each category of the icon classification in the cluster", () => {
    const out = clustered({ look: "points", count: "badge" });
    const counters = sourceOf(out).clusterProperties!;
    expect(Object.keys(counters)).toEqual(["goat_cluster_0", "goat_cluster_1", "goat_cluster_other"]);
    const [op, map] = counters.goat_cluster_1 as [string, unknown];
    expect(op).toBe("+");
    expect(evaluate(map, { kind: "bar" })).toBe(1);
    expect(evaluate(map, { kind: "bakery" })).toBe(0);
    const other = (counters.goat_cluster_other as [string, unknown])[1];
    expect([{ kind: "shoes" }, {}].map((p) => evaluate(other, p))).toEqual([1, 1]);
    expect(evaluate(other, { kind: "cafe" })).toBe(0);
    // Text fields match their own values.
    const typed = sourceOf(clustered({ look: "points" }, iconsByKind, { kind: "string" })).clusterProperties!;
    expect(JSON.stringify(typed.goat_cluster_0)).toContain('["get","kind"]');
    expect(valid(out)).toEqual([]);
  });

  it("draws the icon of the most common category, ties by class order, the base icon for Other and No data", () => {
    const out = clustered({ look: "points", count: "badge" });
    const marker = byId(out, "cluster-icon")!;
    expect(marker.filter).toEqual(["has", "point_count"]);
    const icon = (a: number, b: number, other: number) =>
      evaluate(marker.layout["icon-image"], {
        point_count: a + b + other,
        goat_cluster_0: a,
        goat_cluster_1: b,
        goat_cluster_other: other,
      });
    expect(icon(1, 5, 2)).toBe("goat:restaurant");
    expect(icon(5, 1, 2)).toBe("goat:bakery");
    expect(icon(3, 3, 0)).toBe("goat:bakery");
    expect(icon(1, 1, 4)).toBe("goat:shop");
    expect(icon(2, 0, 2)).toBe("goat:bakery");
    // The points' own size and color, not a size by count.
    expect(marker.layout["icon-size"]).toBeCloseTo(20 / 24);
    expect(marker.paint["icon-color"]).toBe("#5a1846");
    expect(out.images.map((i) => i.name).sort()).toEqual(["goat:bakery", "goat:restaurant", "goat:shop"]);
    // The single points keep their classes and the hidden Other.
    expect(JSON.stringify(byId(out, "icon")?.layout["icon-image"])).toContain('"kind"');
    expect(valid(out)).toEqual([]);
  });

  it("colors the cluster like its most common category where the categories set the color", () => {
    const colored = {
      ...iconsByKind,
      classify: [
        {
          ...iconsByKind.classify[0],
          classes: [
            { id: "a", values: ["bakery"], marker: { icon: "goat:bakery", color: "#ffd92f" } },
            { id: "b", values: ["cafe", "bar"], marker: { icon: "goat:restaurant" } },
          ],
        },
      ],
    };
    const out = clustered({ look: "points", count: "badge" }, colored);
    const color = (a: number, b: number, other: number) =>
      evaluate(byId(out, "cluster-icon")!.paint["icon-color"], {
        goat_cluster_0: a,
        goat_cluster_1: b,
        goat_cluster_other: other,
      });
    expect(String(color(5, 1, 0))).toBe(String(evaluate("#ffd92f")));
    // A class without a color of its own, and Other: the base color.
    expect(String(color(1, 5, 0))).toBe(String(evaluate("#5a1846")));
    expect(String(color(0, 1, 5))).toBe(String(evaluate("#5a1846")));
    // Colors alone, without icons: the clusters still take the most common category's color.
    const colorsOnly = clustered(
      { look: "points" },
      {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: { shape: "circle", color: "#5a1846", size: 12 } },
        classify: [
          {
            id: "k",
            field: "kind",
            method: "categories",
            classes: [{ values: ["a"], marker: { color: "#00ff00" } }],
          },
        ],
      }
    );
    expect(Object.keys(sourceOf(colorsOnly).clusterProperties!)).toEqual([
      "goat_cluster_0",
      "goat_cluster_other",
    ]);
    expect(JSON.stringify(byId(colorsOnly, "cluster-marker")?.paint["circle-color"])).toContain("#00ff00");
    expect(valid(out)).toEqual([]);
    expect(valid(colorsOnly)).toEqual([]);
  });

  it("counts the first 12 categories that set an icon or a color; the points of the others count as Other", () => {
    const many = {
      version: "1.0.0",
      kind: "vector",
      symbol: { marker: { shape: "circle", color: "#5a1846", size: 12 } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          classes: Array.from({ length: 15 }, (_, i) => ({
            values: [`v${i}`],
            marker: { color: `#0000${(i + 16).toString(16)}` },
          })),
        },
      ],
    };
    const out = clustered({ look: "points" }, many);
    const counters = sourceOf(out).clusterProperties!;
    expect(Object.keys(counters)).toEqual([
      ...Array.from({ length: 12 }, (_, i) => `goat_cluster_${i}`),
      "goat_cluster_other",
    ]);
    const other = (counters.goat_cluster_other as [string, unknown])[1];
    expect(evaluate(other, { kind: "v11" })).toBe(0);
    expect(evaluate(other, { kind: "v12" })).toBe(1);
    // A cluster of mostly the thirteenth category takes the base color.
    const color = evaluate(byId(out, "cluster-marker")!.paint["circle-color"], {
      ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`goat_cluster_${i}`, i === 0 ? 1 : 0])),
      goat_cluster_other: 5,
    });
    expect(String(color)).toBe(String(evaluate("#5a1846")));
    expect(valid(out)).toEqual([]);
  });

  it("asks geoapi for the field the counters read, not for the counters", () => {
    const out = clustered({ look: "points", count: "badge" });
    expect(out.tileParams.fields).toEqual(["kind"]);
  });

  it("puts the count on a badge at the marker's upper right, aligned for every marker size", () => {
    const out = clustered({ look: "points", count: "badge" });
    expect(out.layers.map((l) => l.id)).toEqual(["9-icon", "9-cluster-icon", "9-cluster-badge"]);
    const badge = byId(out, "cluster-badge")!;
    expect(badge.type).toBe("symbol");
    expect(badge.filter).toEqual(["has", "point_count"]);
    expect(JSON.stringify(badge.layout["text-field"])).toContain('["get","point_count"]');
    expect(badge.layout["text-font"]).toEqual(["Noto Sans Bold"]);
    expect(badge.layout["icon-allow-overlap"]).toBe(true);
    expect(badge.layout["text-allow-overlap"]).toBe(true);
    // A 20 px marker: the badge's middle on the corner of its box.
    expect(offsets(out, { point_count: 12 })).toEqual({ icon: [10, -10], text: [10, -10] });
    const big = clustered(
      { look: "points", count: "badge" },
      {
        ...iconsByKind,
        symbol: { marker: { ...iconsByKind.symbol.marker, size: 40 } },
      }
    );
    expect(offsets(big, { point_count: 12 })).toEqual({ icon: [20, -20], text: [20, -20] });
    expect(valid(out)).toEqual([]);
  });

  it("colors the badge with the cluster symbol's marker color and its number with the label color", () => {
    const out = clustered({
      look: "points",
      count: "badge",
      symbol: { marker: { color: "#2838b2" }, label: { text: "{count}", color: "#ffff00" } },
    });
    const badge = byId(out, "cluster-badge")!;
    const image = (count: number) => evaluate(badge.layout["icon-image"], { point_count: count }) as string;
    expect(image(5)).toMatch(/^goat-marker:circle\|\d+\|\|#2838b2\|/);
    // More digits, a wider badge.
    const side = (count: number) => Number(image(count).split("|")[1]);
    expect(side(5)).toBeLessThan(side(500));
    expect(side(500)).toBeLessThan(side(50000));
    expect(badge.paint["text-color"]).toBe("#ffff00");
    expect(valid(out)).toEqual([]);
  });

  it("a pin's badge sits at the upper right of its head, above the tip it stands on", () => {
    const out = clustered(
      { look: "points", count: "badge" },
      {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: { shape: "pin", color: "#5a1846", size: 30 } },
      }
    );
    expect(offsets(out, { point_count: 3 })).toEqual({ icon: [15, -30], text: [15, -30] });
    expect(valid(out)).toEqual([]);
  });

  it("keeps the badge clear of a small marker", () => {
    const out = clustered(
      { look: "points", count: "badge" },
      {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: { shape: "circle", color: "#5a1846", size: 8 } },
      }
    );
    const { icon } = offsets(out, { point_count: 3 }) as { icon: number[] };
    expect(icon[0]).toBeGreaterThan(4);
    expect(icon[1]).toBeLessThan(-4);
    expect(byId(out, "cluster-marker")?.paint["circle-radius"]).toBe(4);
  });

  it("a circle by count with a badge moves the badge with the circle's size", () => {
    const out = clustered(
      {
        count: "badge",
        symbol: { marker: { shape: "circle", size: { field: "count", range: [16, 40], scale: "sqrt" } } },
      },
      { version: "1.0.0", kind: "vector" }
    );
    expect(out.layers.map((l) => l.id)).toEqual(["9-marker", "9-cluster-marker", "9-cluster-badge"]);
    expect(offsets(out, { point_count: 2 })).toEqual({ icon: [10, -10], text: [10, -10] });
    expect(offsets(out, { point_count: 1000 })).toEqual({ icon: [20, -20], text: [20, -20] });
    expect(valid(out)).toEqual([]);
  });

  it("like the points with the count in the middle: the marker with the count on it", () => {
    const out = clustered({ look: "points" });
    expect(out.layers.map((l) => l.id)).toEqual(["9-icon", "9-cluster-icon", "9-cluster-label"]);
    const label = byId(out, "cluster-label")!;
    expect(JSON.stringify(label.layout["text-field"])).toContain('["get","point_count"]');
    // The count never hides the marker it sits on.
    expect(byId(out, "cluster-icon")?.layout["icon-allow-overlap"]).toBe(true);
    expect(
      byId(clustered({ look: "points", count: "badge" }), "cluster-icon")?.layout["icon-allow-overlap"]
    ).toBe(true);
    expect(label.paint["text-color"]).toBe("#ffffff");
    expect(valid(out)).toEqual([]);
  });

  it("a marker by zoom moves its badge by zoom", () => {
    const out = clustered(
      { look: "points", count: "badge" },
      {
        version: "1.0.0",
        kind: "vector",
        symbol: {
          marker: {
            shape: "square",
            color: "#5a1846",
            size: {
              zoom: [
                [8, 20],
                [16, 40],
              ],
            },
          },
        },
      }
    );
    expect(offsets(out, { point_count: 3 }, 8).icon).toEqual([10, -10]);
    expect(offsets(out, { point_count: 3 }, 16).icon).toEqual([20, -20]);
    expect(valid(out)).toEqual([]);
  });

  it("every look and count compiles to a valid style for circles, pins and icons alone", () => {
    const markers = [
      { shape: "circle", size: 10, color: "#ff0000" },
      { shape: "pin", icon: "goat:shop", size: 24 },
      {
        shape: "icon",
        icon: "goat:shop",
        size: {
          zoom: [
            [10, 12],
            [16, 28],
          ],
        },
      },
      { shape: "icon", icon: "asset:abc", size: 24 },
    ];
    for (const marker of markers)
      for (const look of ["circle", "points"])
        for (const count of ["center", "badge"]) {
          const out = clustered(
            { look, count },
            { ...iconsByKind, symbol: { marker, outline: { width: 2 } } }
          );
          expect([marker, look, count, valid(out)]).toEqual([marker, look, count, []]);
        }
  });
});

describe("cluster values (spec 8.2 value)", () => {
  const shops = (render: object, symbol?: object) =>
    compileLayer({
      id: "9",
      style: {
        version: "1.0.0",
        kind: "vector",
        render: { type: "cluster", ...render, ...(symbol ? { symbol } : {}) },
      } as LayerStyle,
      geometry: "point",
      source: points,
    });
  const accumulators = (out: ReturnType<typeof compileLayer>) =>
    (out.sources.s9 as { clusterProperties?: Record<string, unknown> }).clusterProperties ?? {};
  /** A text expression evaluated in a locale (labels read it from the global state). */
  const text = (expr: unknown, properties: Record<string, unknown>, locale = "en-US") => {
    const parsed = createExpression(expr, "layers[0].layout.text-field");
    if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
    const out = parsed.value.evaluate(
      { zoom: 10, globalState: { locale } } as never,
      {
        type: 1,
        properties,
      } as never
    );
    return String(out);
  };
  const cluster = (count: number, values: number[]) => ({
    point_count: count,
    goat_cluster_value: values.reduce((a, b) => a + b, 0),
    goat_cluster_value_n: values.length,
  });

  it("accumulates the field on the source and asks geoapi for the field, not for the accumulators", () => {
    const out = shops({ value: { op: "sum", field: "turnover" } }, { label: { text: "{value}" } });
    const props = accumulators(out);
    expect(Object.keys(props).sort()).toEqual(["goat_cluster_value", "goat_cluster_value_n"]);
    const [op, map] = props.goat_cluster_value as [string, unknown];
    expect(op).toBe("+");
    expect([{ turnover: 12.5 }, {}].map((p) => evaluate(map, p))).toEqual([12.5, 0]);
    expect(evaluate((props.goat_cluster_value_n as [string, unknown])[1], {})).toBe(0);
    expect(out.tileParams.fields).toEqual(["turnover"]);
    expect(valid(out)).toEqual([]);
  });

  it("labels the sum, the mean (sum over the points with a value), the smallest and the largest value", () => {
    const label = (op: string) =>
      byId(shops({ value: { op, field: "turnover" } }, { label: { text: "{value}" } }), "cluster-label")!
        .layout["text-field"];
    expect(text(label("sum"), cluster(3, [100, 200, 34]))).toBe("334");
    expect(text(label("mean"), cluster(4, [100, 200, 30]))).toBe("110");
    // Whole numbers below a thousand, as a badge has room for them.
    expect(text(label("mean"), cluster(3, [85, 85.5, 85.6]))).toBe("85");
    const min = shops({ value: { op: "min", field: "turnover" } }, { label: { text: "{value}" } });
    const [reduce, map] = accumulators(min).goat_cluster_value as [unknown, unknown];
    expect(JSON.stringify(reduce)).toContain('"min"');
    expect(evaluate(map, { turnover: 7 })).toBe(7);
    expect(JSON.stringify(accumulators(shops({ value: { op: "max", field: "turnover" } })))).toContain(
      '"max"'
    );
    // No point with a value: no number.
    expect(text(label("mean"), cluster(4, []))).toBe("");
    expect(valid(min)).toEqual([]);
  });

  it("sizes and colors the clusters by the value over its domain", () => {
    const out = shops(
      { value: { op: "mean", field: "turnover" } },
      {
        marker: {
          shape: "circle",
          size: { field: "value", range: [10, 30], domain: [0, 1000] },
          color: { field: "value", palette: ["#000000", "#ffffff"], domain: [0, 1000] },
        },
      }
    );
    const paint = byId(out, "cluster-marker")!.paint;
    expect(evaluate(paint["circle-radius"], cluster(2, [500, 500]))).toBe(10);
    expect(evaluate(paint["circle-radius"], cluster(9, [1000, 1000]))).toBe(15);
    expect(valid(out)).toEqual([]);
  });

  it("without a value of its own, value is the count", () => {
    const out = shops({}, { label: { text: "{value}" } });
    expect(accumulators(out)).toEqual({});
    expect(text(byId(out, "cluster-label")!.layout["text-field"], { point_count: 42 })).toBe("42");
  });

  it("shortens large counts as the app's numbers do, in the viewer's language", () => {
    const label = byId(shops({}), "cluster-label")!.layout["text-field"];
    expect(text(label, { point_count: 999 })).toBe("999");
    expect(text(label, { point_count: 1234 })).toBe("1.2 k");
    expect(text(label, { point_count: 1234 }, "de-DE")).toBe("1,2 k");
    expect(text(label, { point_count: 2_500_000 })).toBe("2.5 M");
    // A format of the cluster label's own wins.
    const own = byId(
      shops({}, { label: { text: "{count}", format: { thousands_separator: false } } }),
      "cluster-label"
    )!;
    expect(text(own.layout["text-field"], { point_count: 1234 })).toBe("1234");
  });

  it("the badge shows the label's number, shortened, on a badge wide enough for it", () => {
    const out = shops(
      { count: "badge", value: { op: "sum", field: "turnover" } },
      { label: { text: "{value}" } }
    );
    const badge = byId(out, "cluster-badge")!;
    expect(text(badge.layout["text-field"], cluster(3, [1000, 2345]))).toBe("3.3 k");
    const side = (properties: object) =>
      Number(
        String(evaluate(badge.layout["icon-image"], properties as Record<string, unknown>)).split("|")[1]
      );
    expect(side(cluster(3, [10, 20]))).toBeLessThan(side(cluster(3, [1000, 2345])));
    const count = byId(shops({ count: "badge" }), "cluster-badge")!;
    expect(text(count.layout["text-field"], { point_count: 25000 })).toBe("25.0 k");
    expect(valid(out)).toEqual([]);
  });

  it("rings the badge in white unless the cluster symbol has an outline", () => {
    const image = (symbol?: object) =>
      String(
        evaluate(byId(shops({ count: "badge" }, symbol), "cluster-badge")!.layout["icon-image"], {
          point_count: 5,
        })
      );
    expect(image()).toMatch(/\|#ffffff\|1\.5\|$/);
    expect(image({ marker: { color: "#283593" }, outline: { color: "#000000", width: 2 } })).toMatch(
      /\|#283593\|#000000\|2\|$/
    );
  });
});

describe("H3", () => {
  const VALUE = ["to-number", ["get", "value"], 0];
  const STAMP = { at: "2026-10-26T00:00:00Z", data: "ducklake:1", scope: "dataset" };
  const h3 = (render: object) =>
    compile({ version: "1.0.0", kind: "vector", render: { type: "h3", ...render } });

  it("compiles the spec 8.3 example: hexagon tiles from geoapi, the schools from zoom 15", () => {
    const out = compile(example(1736));
    expect(out.unsupported).toEqual([]);
    expect(out.sources["s9-h3"]).toEqual({
      type: "vector",
      tiles: ["https://t/{z}/{x}/{y}?h3=auto&h3_value=sum&h3_field=pupils"],
      maxzoom: 14,
    });
    expect(out.layers.map((l) => [l.id, l.type, l.minzoom, l.maxzoom])).toEqual([
      ["9-h3-fill", "fill", undefined, 15],
      ["9-h3-outline", "line", undefined, 15],
      ["9-marker", "circle", 15, undefined],
    ]);
    expect(byId(out, "h3-fill")?.source).toBe("s9-h3");
    expect(byId(out, "h3-fill")?.["source-layer"]).toBe("h3");
    expect(byId(out, "h3-fill")?.paint["fill-opacity"]).toBe(0.85);
    expect(byId(out, "h3-outline")?.paint).toEqual({ "line-color": "#ffffff", "line-width": 1 });
    expect(valid(out)).toEqual([]);
  });

  it("counts by default and asks for a fixed resolution", () => {
    const out = h3({ resolution: 8 });
    expect((out.sources["s9-h3"] as { tiles: string[] }).tiles).toEqual([
      "https://t/{z}/{x}/{y}?h3=8&h3_value=count",
    ]);
    expect(out.layers.map((l) => l.id)).toEqual(["9-h3-fill", "9-h3-outline"]);
  });

  it("colors classes per resolution from the computed breaks", () => {
    const pal = ["#000001", "#000002", "#000003"];
    const out = h3({
      palette: pal,
      classify: { method: "quantile", count: 3 },
      computed: {
        ...STAMP,
        resolutions: { "7": { min: 1, max: 9, breaks: [3, 6] }, "8": { min: 1, max: 4, breaks: [2] } },
      },
    });
    expect(byId(out, "h3-fill")?.paint["fill-color"]).toEqual([
      "match",
      ["get", "resolution"],
      7,
      ["step", VALUE, "#000001", 3, "#000002", 6, "#000003"],
      8,
      ["step", VALUE, "#000001", 2, "#000003"],
      "#000002",
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("spreads the palette over each resolution's range without classes", () => {
    const pal = ["#000001", "#000002", "#000003"];
    const out = h3({
      resolution: 8,
      palette: pal,
      reverse: true,
      computed: { ...STAMP, resolutions: { "8": { min: 0, max: 10 } } },
    });
    expect(byId(out, "h3-fill")?.paint["fill-color"]).toEqual([
      "interpolate",
      ["linear"],
      VALUE,
      0,
      "#000003",
      5,
      "#000002",
      10,
      "#000001",
    ]);
  });

  it("draws the palette's middle color until the values are computed", () => {
    const out = h3({ palette: ["#000001", "#000002", "#000003"] });
    expect(byId(out, "h3-fill")?.paint["fill-color"]).toBe("#000002");
  });

  it("manual classes and an author's class color apply at every resolution", () => {
    const out = h3({
      palette: ["#000001", "#000002"],
      classify: { method: "manual", classes: [{ to: 10 }, { from: 10, color: "#ff0000" }] },
    });
    expect(byId(out, "h3-fill")?.paint["fill-color"]).toEqual(["step", VALUE, "#000001", 10, "#ff0000"]);
  });

  it("an outline of width 0 draws no outline layer; the layer opacity multiplies in", () => {
    const out = compileLayer({
      id: "9",
      style: {
        version: "1.0.0",
        kind: "vector",
        opacity: 0.5,
        render: { type: "h3", outline: { width: 0 }, opacity: 0.8 },
      } as LayerStyle,
      geometry: "point",
      source: tiles,
    });
    expect(out.layers.map((l) => l.id)).toEqual(["9-h3-fill"]);
    expect(byId(out, "h3-fill")?.paint["fill-opacity"]).toBeCloseTo(0.4);
  });
});

describe("heatmap weights over a single value", () => {
  it("a weight domain with d0 = d1 weighs every feature with the value the same", () => {
    const out = compile({
      version: "1.0.0",
      kind: "vector",
      render: { type: "heatmap", weight: { field: "v", domain: [5, 5] } },
    });
    expect(byId(out, "heatmap")?.paint["heatmap-weight"]).toEqual(["case", ["!=", ["get", "v"], null], 1, 0]);
    expect(valid(out)).toEqual([]);
  });
});
