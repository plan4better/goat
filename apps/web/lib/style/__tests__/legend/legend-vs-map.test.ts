// The legend against the map: for a feature that falls in a legend entry, MapLibre's own evaluation of the
// compiled layers gives the look the entry's swatch shows. Compared are the properties an entry stands for (what its
// classification or rule sets); a block that sets no color draws grey by design, so its color is not compared.
// Heatmaps, clusters, H3 and rasters are not features with a look of their own and are left to the other checks.
import { Color } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { Geometry } from "@/lib/style/compile/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import {
  type LegendSection,
  type Swatch,
  buildLegend,
  itemKey,
  legendBlocks,
  listedRules,
} from "@/lib/style/legend";
import { countPresence } from "@/lib/style/presence";

import { type LegendCase, compileInput, legendCases, pointsDrawn } from "./cases";
import { known } from "./known";
import { type MapLook, mapLook, paintValue } from "./mapSwatch";
import { sampleFor } from "./samples";
import { ZOOM_STOPS, attributePaths, inZoomStops } from "./zoomStops";

const MAIN: Record<Geometry, string> = { point: "marker", line: "line", polygon: "fill" };
const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);
/** The sizes and widths: the legend reads one by zoom at the middle of its stops (spec 7.2), the map at its zoom. */
const SIZES = ["marker.size", "line.width", "outline.width", "casing.width"];

/** The field a value follows: its own (spec 4.3), or the one its zoom stops follow (spec 4.4); none where it follows
 * none or its stops follow more than one. */
function fieldOf(form: unknown): string | undefined {
  if (!isObject(form)) return undefined;
  if (typeof form.field === "string") return form.field;
  const stops = Array.isArray(form.zoom) ? (form.zoom as unknown[][]) : [];
  const fields = new Set(
    stops.flatMap(([, v]) => (isObject(v) && typeof v.field === "string" ? [v.field] : []))
  );
  return fields.size === 1 ? [...fields][0] : undefined;
}

/** Whether a value follows a field, at every zoom or in its zoom stops: it has no one value to show. */
const followsField = (form: unknown): boolean =>
  isObject(form) &&
  (typeof form.field === "string" ||
    (Array.isArray(form.zoom) &&
      (form.zoom as unknown[][]).some(([, v]) => isObject(v) && typeof v.field === "string")));

/** Whether a case has a color by zoom on its symbol: by zoom alone (spec 4.2) or by attribute in its stops (4.4). */
const colorByZoom = (c: LegendCase): boolean =>
  Object.values(isObject(c.style.symbol) ? c.style.symbol : {}).some(
    (node) =>
      isObject(node) &&
      Object.entries(node).some(
        ([key, form]) => key.endsWith("color") && isObject(form) && Array.isArray(form.zoom)
      )
  );

/** Whether the map draws a case's markers or patterns as images. */
const drawsImages = (c: LegendCase): boolean =>
  compileLayer(compileInput(c)).layers.some(
    (l) => (l.id === "1-marker" && l.type === "symbol") || l.id === "1-pattern"
  );

/** Colors by zoom on marker images and patterns, which the generated cases draw on a pin only: a pin's fill, icon
 * and stroke, a square on a polygon with a pattern, a circle on a line, by zoom alone (spec 4.2) and by attribute in
 * zoom stops (spec 4.4), each over two stops around zoom 12. */
const IMAGE_CASES: LegendCase[] = (() => {
  const byZoom = (a: string, b: string) => ({
    zoom: [
      [11, a],
      [13, b],
    ],
  });
  const inStops = (a: string[], b: string[]) => ({
    zoom: [
      [11, { field: "amount", palette: a, domain: [0, 100] }],
      [13, { field: "amount", palette: b, domain: [0, 100] }],
    ],
  });
  const one = (id: string, geometry: Geometry, symbol: JsonObject): LegendCase => ({
    id,
    style: { version: 1, kind: "vector", symbol },
    geometry,
    zoom: 12,
    fields: { amount: "number" },
  });
  return [
    one("pin-by-zoom", "point", {
      marker: {
        shape: "pin",
        icon: "goat:park",
        color: byZoom("#ff0000", "#0000ff"),
        icon_color: byZoom("#ffffff", "#000000"),
      },
      outline: { color: byZoom("#000000", "#ffff00"), width: 1 },
    }),
    one("pin-in-stops", "point", {
      marker: { shape: "pin", color: inStops(["#0000ff", "#00ff00"], ["#ff0000", "#ffff00"]) },
      outline: { color: "fill", width: 1 },
    }),
    one("polygon-by-zoom", "polygon", {
      fill: { color: "#cccccc", pattern: "hatch_45", pattern_color: byZoom("#ff0000", "#0000ff") },
      marker: { shape: "square", color: byZoom("#00ff00", "#ff00ff") },
    }),
    one("polygon-in-stops", "polygon", {
      fill: {
        color: "#cccccc",
        pattern: "hatch_45",
        pattern_color: inStops(["#0000ff", "#00ff00"], ["#ff0000", "#ffff00"]),
      },
      marker: { shape: "square", color: inStops(["#000000", "#ffffff"], ["#ff0000", "#00ff00"]) },
    }),
    one("line-in-stops", "line", {
      line: { color: "#2166ac", width: 4 },
      marker: { shape: "circle", color: inStops(["#0000ff", "#00ff00"], ["#ff0000", "#ffff00"]) },
    }),
  ];
})();

/** The middle of a value's zoom stops: where the legend reads a size by zoom. */
function middleOf(form: JsonObject): number {
  const stops = form.zoom as unknown[][];
  return ((stops[0][0] as number) + (stops[stops.length - 1][0] as number)) / 2;
}

const cases = legendCases().filter((c) => c.style.kind === "vector" && c.geometry && !known("compiles", c));

/** Whether a legend value and what the map draws are the same color, number or name. */
function same(legend: unknown, map: unknown): boolean {
  if (typeof legend === "number") return typeof map === "number" && Math.abs(legend - map) <= 0.06;
  const a = typeof legend === "string" ? Color.parse(legend) : undefined;
  const b = map instanceof Color ? map : typeof map === "string" ? Color.parse(map) : undefined;
  if (a && b) return (["r", "g", "b", "a"] as const).every((k) => Math.abs(a[k] - b[k]) <= 0.01);
  return String(legend ?? "") === String(map ?? "");
}

const show = (value: unknown) => (value instanceof Color ? value.toString() : JSON.stringify(value));

/** The differences between a swatch and a look on `paths`; a path the swatch does not hold is not compared. */
function compare(label: string, swatch: Swatch, look: MapLook, paths: string[], steady?: string[]): string[] {
  return paths.flatMap((path) => {
    const [part, key] = path.split(".");
    const legend = (swatch as unknown as Record<string, Record<string, unknown> | undefined>)[part]?.[key];
    if (legend === undefined || !(path in look) || same(legend, look[path])) return [];
    // By design: a size by zoom is read at one zoom in the legend, and the layer's opacity does not fade it.
    if (steady?.includes(path)) return [];
    // A hollow marker has no fill to fade: the map draws its fill at 0, the legend carries `fill: false`.
    if (path === "marker.opacity" && swatch.marker?.fill === false) return [];
    return [`${label} ${path}: legend ${show(legend)}, map ${show(look[path])}`];
  });
}

const targetOf = (c: JsonObject, geometry: Geometry) =>
  typeof c.target === "string" ? c.target : `${MAIN[geometry]}.color`;

/** The `part.key` paths a rule sets. */
const rulePaths = (rule: JsonObject): string[] =>
  Object.entries(rule).flatMap(([part, node]) =>
    isObject(node) && part !== "when" ? Object.keys(node).map((key) => `${part}.${key}`) : []
  );

/** The paths set by the rules a feature matches: a rule wins over the feature's class (spec 6.1), and a class's
 * entry shows the class. */
const ruledPaths = (rules: JsonObject[], properties: Record<string, unknown>): string[] =>
  rules.flatMap((rule) => {
    const when = isObject(rule.when) ? rule.when : {};
    const args = Array.isArray(when.args) ? when.args : [];
    const matches =
      when.op === "=" && isObject(args[0]) && properties[args[0].property as string] === args[1];
    return matches ? rulePaths(rule) : [];
  });

/** Every place the legend of a case and the map disagree. */
function differences(c: LegendCase, notCompared?: Set<string>): string[] {
  const geometry = c.geometry!;
  const compiled = compileLayer(compileInput(c));
  const legend = buildLegend(c.style, { geometry, zoom: c.zoom });
  if (!legend) return [];
  const look = (properties: Record<string, unknown>, zoom = c.zoom) =>
    mapLook(compiled, properties, zoom, geometry);
  const classify = list(c.style.classify);
  const symbol = isObject(c.style.symbol) ? c.style.symbol : {};
  // The sizes the style gives by zoom: the legend reads them at one zoom (spec 7.2), the map at its own.
  const sizesByZoom = SIZES.filter((path) => {
    const [part, key] = path.split(".");
    const form = isObject(symbol[part]) ? (symbol[part] as JsonObject)[key] : undefined;
    return isObject(form) && Array.isArray(form.zoom);
  });
  // The layer's opacity fades the map; the legend's swatches stay at full strength, so they can be read.
  const faded = c.style.opacity !== undefined && c.style.opacity !== 1;
  const steady = [
    ...sizesByZoom,
    ...(faded ? ["marker.opacity", "outline.opacity", "fill.opacity", "line.opacity", "casing.opacity"] : []),
  ];
  const out: string[] = [];
  for (const section of legend.sections) {
    if (section.kind === "entries" && section.id === "base") {
      const drawn = look({});
      // A base value by attribute has no one value: the swatch shows a stand-in, the map each feature's own.
      const fixed = Object.keys(drawn).filter((path) => {
        const [part, key] = path.split(".");
        const form = isObject(symbol[part]) ? (symbol[part] as JsonObject)[key] : undefined;
        return !followsField(form);
      });
      out.push(...compare("base", section.entries[0].swatch, drawn, fixed, steady));
    } else if (section.kind === "entries" && section.id === "rules") {
      for (const entry of section.entries) {
        // The rules the legend lists, keyed by their place among those.
        const rule = listedRules(c.style).find((r, i) => itemKey(r, i) === entry.id);
        const when = isObject(rule?.when) ? rule.when : {};
        const args = Array.isArray(when.args) ? when.args : [];
        if (!rule || when.op !== "=" || !isObject(args[0])) continue;
        const drawn = look({ [args[0].property as string]: args[1] });
        out.push(...compare(`rule ${entry.id}`, entry.swatch, drawn, rulePaths(rule)));
      }
    } else if (section.kind === "entries") {
      const own = classify.find((k) => (typeof k.id === "string" ? k.id : String(k.field)) === section.id);
      if (!own) continue;
      // What the block stands for, as the legend merges it: its classification's property, and those of the
      // classifications merged into it (a label's font joins no block).
      const paths = legendBlocks(c.style, geometry).find((b) => b.id === section.id)?.targets ?? [];
      for (const entry of section.entries) {
        const properties = sampleFor(own, entry, c.fields[own.field as string]);
        if (!properties) continue;
        const drawn = look(properties);
        const record = entry.extra
          ? own[entry.extra]
          : list(own.classes).find((k, i) => (typeof k.id === "string" ? k.id : String(i)) === entry.id);
        const zoomed = isObject(record) && (record.min_zoom !== undefined || record.max_zoom !== undefined);
        if (!Object.keys(drawn).length && !zoomed)
          out.push(`${section.id}/${entry.id}: the map draws nothing`);
        const ruled = ruledPaths(list(c.style.rules), properties);
        // Beside what the block stands for, an entry shows the base look: compared too, except what is not the
        // entry's to show. The main color of a block that sets no color is grey by design; a property another
        // classification sets follows that one's classes; a base value by attribute has no one value.
        const main = `${MAIN[geometry]}.color`;
        const others = classify
          .filter((k) => !paths.includes(targetOf(k, geometry)))
          .map((k) => targetOf(k, geometry));
        const rest = Object.keys(drawn).filter((path) => {
          const [part, key] = path.split(".");
          const form = isObject(symbol[part]) ? (symbol[part] as JsonObject)[key] : undefined;
          const byField = followsField(form);
          const neutral =
            (path === main || path === "marker.icon_color" || path === "fill.pattern_color") &&
            !paths.some((p) => p.endsWith("color"));
          return !paths.includes(path) && !others.includes(path) && !byField && !neutral;
        });
        out.push(
          ...compare(
            `${section.id}/${entry.id}`,
            entry.swatch,
            drawn,
            [...paths, ...rest].filter((path) => !ruled.includes(path)),
            steady
          )
        );
        // A class of the height writes its height beside the entry: the height the map raises the feature to.
        if (
          entry.height !== undefined &&
          "extrude.height" in drawn &&
          !same(entry.height, drawn["extrude.height"])
        )
          out.push(
            `${section.id}/${entry.id} height: legend ${entry.height}, map ${show(drawn["extrude.height"])}`
          );
        // A property the block stands for that the swatch or the look does not hold was not compared at all.
        // (An Other or No data entry the style sets nothing for stands for the base look, compared above.)
        if (Object.keys(drawn).length && !(entry.extra && !isObject(own[entry.extra])))
          for (const path of paths) {
            const [part, key] = path.split(".");
            const held = (entry.swatch as unknown as Record<string, Record<string, unknown> | undefined>)[
              part
            ]?.[key];
            const height = path === "extrude.height" && entry.height !== undefined;
            // A part the layer switches off is drawn neither on the map nor in the swatch (spec 3).
            if (symbol[part] === false) continue;
            if (!height && (held === undefined || !(path in drawn))) notCompared?.add(path);
          }
      }
    } else if (section.kind === "ramp" || section.kind === "sizes") {
      const [part, key] = section.id.split(".");
      const form = isObject(symbol[part]) ? (symbol[part] as JsonObject)[key] : undefined;
      const field = fieldOf(form);
      if (!isObject(form) || !field) continue;
      if (section.kind === "ramp") {
        const ends = [section.colors[0], section.colors[section.colors.length - 1]];
        // The bar shows the part's own opacity: not a pattern's (drawn at full strength), not a hollow marker's
        // (no fill to fade), not one by attribute (no one value), nor the layer's.
        const own = isObject(symbol[part]) ? (symbol[part] as JsonObject) : {};
        const opacity = `${part}.opacity`;
        const opacityByField = followsField(own.opacity);
        const fades =
          (key === "color" || key === "icon_color") &&
          !(part === "marker" && own.fill === false) &&
          !opacityByField &&
          !steady.includes(opacity);
        ends.forEach((color, end) => {
          const drawn = look({ [field]: section.domain[end] });
          if (section.id in drawn && !same(color, drawn[section.id]))
            out.push(`ramp ${section.id} end ${end}: legend ${color}, map ${show(drawn[section.id])}`);
          if (fades && opacity in drawn && !same(section.opacity ?? 1, drawn[opacity]))
            out.push(
              `ramp ${section.id} end ${end} opacity: legend ${section.opacity ?? 1}, map ${show(drawn[opacity])}`
            );
        });
      } else {
        // A size by zoom with sizes by attribute in its stops (spec 4.4): its samples are the sizes the map draws at
        // the middle of the stops, the zoom the legend reads it at.
        const zoom = SIZES.includes(section.id) && Array.isArray(form.zoom) ? middleOf(form) : c.zoom;
        for (const s of section.samples)
          out.push(
            ...compare(
              `sizes ${section.id} at ${s.value} (zoom ${zoom})`,
              s.swatch,
              look({ [field]: s.value }, zoom),
              [section.id]
            )
          );
      }
    }
  }
  return out;
}

describe("the legend against the map", () => {
  it("covers most cases", () => {
    expect(cases.length).toBeGreaterThan(100);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s: each entry shows what the map draws", (_id, c) => {
    const found = differences(c);
    if (known("map", c)) expect(found, known("map", c)!.reason).not.toEqual([]);
    else expect(found).toEqual([]);
  });

  it("a heatmap or H3 layer below its points zoom draws no point, and the legend lists none", () => {
    const without = cases.filter((c) => !pointsDrawn(c));
    expect(without.length).toBeGreaterThan(10);
    for (const c of without) {
      const compiled = compileLayer(compileInput(c));
      expect(
        mapLook(compiled, { category: "A", amount: 1000, flag: true }, c.zoom, c.geometry!),
        c.id
      ).toEqual({});
      const legend = buildLegend(c.style, { geometry: c.geometry, zoom: c.zoom });
      for (const section of legend?.sections ?? [])
        expect(["heatmap", "h3", "height"], c.id).toContain(section.id);
    }
  });

  // The cases' values by attribute put in zoom stops (spec 4.4): at a stop, between two on a linear and an
  // exponential curve, and the same at every stop.
  const inStops = cases.flatMap((c) =>
    pointsDrawn(c) && attributePaths(c).length
      ? Object.entries(ZOOM_STOPS).flatMap(([name, stops]) => {
          const variant = inZoomStops(c, name, stops);
          return variant ? [[variant.id, c, variant] as const] : [];
        })
      : []
  );
  it.each(inStops)(
    "%s: a value by attribute in zoom stops shows the samples or the ramp the map draws",
    (_id, c, variant) => {
      // Each ramp and each set of samples the plain value by attribute leaves, the value in stops leaves too.
      const shown = (one: LegendCase) =>
        (buildLegend(one.style, { geometry: one.geometry, zoom: one.zoom })?.sections ?? [])
          .filter((s) => s.kind === "ramp" || s.kind === "sizes")
          .map((s) => `${s.kind} ${s.id}`);
      expect(shown(variant)).toEqual(shown(c));
      const found = differences(variant);
      if (known("map", variant)) expect(found, known("map", variant)!.reason).not.toEqual([]);
      else expect(found).toEqual([]);
    }
  );

  it("values by attribute in zoom stops are held against the map in enough cases", () => {
    expect(inStops.length).toBeGreaterThanOrEqual(60);
  });

  // Half a zoom above the case's own: a color by zoom (spec 4.2) or by attribute in zoom stops (spec 4.4) blends at
  // the map's zoom on circles, icons, fills and lines, and holds the color of the whole zoom below on a marker image
  // or a pattern. The legend shows each as the map draws it.
  const halfway = [
    ...[...cases, ...IMAGE_CASES].map((c) => [c.id, c] as const),
    ...inStops.map(([id, , v]) => [id, v] as const),
  ]
    .filter(([, c]) => colorByZoom(c))
    .map(([id, c]) => [`${id}-halfway`, { ...c, id: `${c.id}-halfway`, zoom: c.zoom + 0.5 }] as const);
  it.each(halfway)("%s: between two whole zooms each entry shows the colors the map draws", (_id, c) => {
    expect(differences(c)).toEqual([]);
  });

  it("colors by zoom are held against the map between two whole zooms, on marker images too", () => {
    expect(halfway.length).toBeGreaterThanOrEqual(40);
    expect(halfway.filter(([, c]) => drawsImages(c)).length).toBeGreaterThanOrEqual(8);
  });

  it("a rule's entry is held against that rule, after a rule the legend does not list", () => {
    const c: LegendCase = {
      id: "rules-after-unlisted",
      geometry: "point",
      zoom: 12,
      fields: { kind: "string" },
      style: {
        version: 1,
        kind: "vector",
        symbol: { marker: { shape: "circle", color: "#888888", size: 10 } },
        rules: [
          {
            when: { op: "=", args: [{ property: "kind" }, "a"] },
            marker: { color: "#ff0000" },
            legend: false,
          },
          { name: "B", when: { op: "=", args: [{ property: "kind" }, "b"] }, marker: { color: "#0000ff" } },
        ],
      },
    };
    expect(differences(c)).toEqual([]);
  });

  it("compares every property a block stands for", () => {
    const notCompared = new Set<string>();
    for (const c of cases) differences(c, notCompared);
    // Every property a classification sets in the cases is held against the map.
    expect([...notCompared].sort()).toEqual([]);
  });
});

// With `legend.classes: view` the legend lists the classes of the features the map drew in its view: a map that
// draws a feature for every entry keeps every entry, however the classifications of a field are merged into a block.
describe("the legend's counts against the map", () => {
  const entries = (sections: LegendSection[] = []) =>
    sections.flatMap((s) => (s.kind === "entries" ? s.entries.map((e) => `${s.id}/${e.id}`) : []));

  /** The legend in `view`, counted over a feature for each entry that has one, and the entries those stand for. */
  function viewed(c: LegendCase): { all: string[]; kept: string[] } {
    const geometry = c.geometry!;
    const legend = buildLegend(c.style, { geometry, zoom: c.zoom });
    const classify = list(c.style.classify);
    const sampled: string[] = [];
    const features = (legend?.sections ?? []).flatMap((section) => {
      const own = classify.find((k) => (typeof k.id === "string" ? k.id : String(k.field)) === section.id);
      if (section.kind !== "entries" || !own) return [];
      return section.entries.flatMap((entry) => {
        const properties = sampleFor(own, entry, c.fields[own.field as string]);
        if (properties) sampled.push(`${section.id}/${entry.id}`);
        return properties ? [{ properties }] : [];
      });
    });
    const counter = countPresence(c.style);
    counter.add(features);
    const style = {
      ...c.style,
      legend: { ...(isObject(c.style.legend) ? c.style.legend : {}), classes: "view" },
    };
    const kept = entries(buildLegend(style, { geometry, zoom: c.zoom, present: counter.result() })?.sections);
    return { all: sampled, kept: kept.filter((id) => sampled.includes(id)) };
  }

  const shown = cases.filter((c) => buildLegend(c.style, { geometry: c.geometry, zoom: c.zoom }) !== null);
  it.each(shown.map((c) => [c.id, c] as const))("%s: every entry the map draws stays listed", (_id, c) => {
    const { all, kept } = viewed(c);
    expect(kept).toEqual(all);
  });

  it("a label font by the classes a color sets, and a size by another field: both blocks stay", () => {
    const STAMP = { at: "2026-01-01T00:00:00Z", data: "synthetic:1", scope: "dataset" };
    const c: LegendCase = {
      id: "label-font-classes",
      geometry: "point",
      zoom: 12,
      fields: { category: "string", amount: "number" },
      style: {
        version: 1,
        kind: "vector",
        symbol: { marker: { shape: "circle", color: "#fdae61", size: 10 }, label: { text: "{category}" } },
        classify: [
          {
            id: "kind",
            field: "category",
            method: "categories",
            classes: [
              { id: "c1", values: ["A"], marker: { color: "#66c2a5" } },
              { id: "c2", values: ["B"], marker: { color: "#fc8d62" } },
            ],
            computed: { ...STAMP, other: false, no_data: false },
          },
          {
            id: "amount",
            field: "amount",
            method: "quantile",
            target: "marker.size",
            classes: [
              { id: "c3", to: 100, marker: { size: 4 } },
              { id: "c4", from: 100, marker: { size: 24 } },
            ],
            computed: { ...STAMP, domain: [5, 2000], no_data: false },
          },
          {
            id: "font",
            field: "category",
            method: "categories",
            target: "label.font.weight",
            classes: [
              { id: "c5", values: ["A"] },
              { id: "c6", values: ["B"], label: { font: { style: "italic", weight: "regular" } } },
            ],
            computed: { ...STAMP, other: false, no_data: false },
          },
        ],
      },
    };
    const { all, kept } = viewed(c);
    expect(all).toEqual(["kind/c1", "kind/c2", "amount/c3", "amount/c4"]);
    expect(kept).toEqual(all);
    const notCompared = new Set<string>();
    expect(differences(c, notCompared)).toEqual([]);
    expect([...notCompared]).toEqual([]);
  });
});

// A heatmap, H3 hexagons and clusters are no features with a look of their own: their legends are held against
// the layers that draw them.
describe("the density legends against the map", () => {
  const renderOf = (c: LegendCase) => (isObject(c.style.render) ? String(c.style.render.type) : "features");
  const drawn = cases.filter((c) => c.geometry === "point");
  const legendOf = (c: LegendCase) => buildLegend(c.style, { geometry: c.geometry, zoom: c.zoom })!;
  // The layer's opacity fades the map, not the legend: the drawn opacity is the density's own only without it.
  const faded = (c: LegendCase) => c.style.opacity !== undefined && c.style.opacity !== 1;

  const heatmaps = drawn.filter((c) => renderOf(c) === "heatmap" && !pointsDrawn(c));
  it.each(heatmaps.map((c) => [c.id, c] as const))("%s: the ramp is the heatmap's colors", (_id, c) => {
    const compiled = compileLayer(compileInput(c));
    const ramp = legendOf(c).sections.find((s) => s.id === "heatmap");
    if (ramp?.kind !== "ramp") throw new Error("no heatmap ramp");
    const n = ramp.colors.length;
    // The layer spreads the palette over the density: its first color where the density starts, its last at 1.
    const at = (density: number) =>
      paintValue(compiled, "1-heatmap", "heatmap-color", {}, c.zoom, { heatmapDensity: density });
    expect(same(ramp.colors[0], at(1 / n)), `low: ${show(at(1 / n))}`).toBe(true);
    expect(same(ramp.colors[n - 1], at(1)), `high: ${show(at(1))}`).toBe(true);
    // The bar shows the heatmap's own opacity.
    const opacity = paintValue(compiled, "1-heatmap", "heatmap-opacity", {}, c.zoom);
    if (!faded(c)) expect(same(ramp.opacity ?? 1, opacity), `opacity: ${show(opacity)}`).toBe(true);
  });

  const hexagons = drawn.filter((c) => renderOf(c) === "h3" && !pointsDrawn(c));
  it.each(hexagons.map((c) => [c.id, c] as const))(
    "%s: the hexagons' classes or ramp are their colors",
    (_id, c) => {
      const compiled = compileLayer(compileInput(c));
      const layer = compiled.layers.find((l) => l.id === "1-h3-fill")!;
      const key = layer.type === "fill-extrusion" ? "fill-extrusion-color" : "fill-color";
      const at = (value: number) => paintValue(compiled, "1-h3-fill", key, { value }, c.zoom);
      // The hexagons' own opacity, which the swatches and the ramp show.
      const opacity = paintValue(
        compiled,
        "1-h3-fill",
        layer.type === "fill-extrusion" ? "fill-extrusion-opacity" : "fill-opacity",
        {},
        c.zoom
      );
      const section = legendOf(c).sections.find((s) => s.id === "h3");
      if (section?.kind === "ramp") {
        const ends = [section.colors[0], section.colors[section.colors.length - 1]];
        ends.forEach((color, end) =>
          expect(same(color, at(section.domain[end])), `end ${end}: ${show(at(section.domain[end]))}`).toBe(
            true
          )
        );
        if (!faded(c)) expect(same(section.opacity ?? 1, opacity), `opacity: ${show(opacity)}`).toBe(true);
      } else if (section?.kind === "entries") {
        for (const entry of section.entries) {
          const { from, to } = entry.range ?? {};
          const value =
            from !== undefined && to !== undefined
              ? (from + to) / 2
              : to !== undefined
                ? to - 1
                : (from ?? 0) + 1;
          expect(same(entry.swatch.fill?.color, at(value)), `${entry.id}: ${show(at(value))}`).toBe(true);
          if (!faded(c))
            expect(
              same(entry.swatch.fill?.opacity ?? 1, opacity),
              `${entry.id} opacity: ${show(opacity)}`
            ).toBe(true);
        }
      } else throw new Error("no h3 section");
    }
  );

  const clusters = drawn.filter((c) => renderOf(c) === "cluster" && c.zoom < 14);
  it.each(clusters.map((c) => [c.id, c] as const))("%s: the Clusters sample is a cluster", (_id, c) => {
    const compiled = compileLayer(compileInput(c));
    const [section] = legendOf(c).sections;
    if (section.kind !== "entries" || section.id !== "cluster") throw new Error("no cluster entry");
    const { marker, badge } = section.entries[0].swatch as {
      marker: Record<string, unknown>;
      badge?: object;
    };
    const render = c.style.render as JsonObject;
    // A badge where the count is on one, on the map too.
    expect(badge !== undefined).toBe(compiled.layers.some((l) => l.id === "1-cluster-badge"));
    if (render.look === "points") {
      // Drawn like the points: the base marker, in the color the map gives the clusters' icons or markers.
      // A marker with a shape is an image named after its look; an icon alone and a circle carry their color.
      const layer = compiled.layers.find((l) => l.id === "1-cluster-icon" || l.id === "1-cluster-marker")!;
      if (layer.type === "symbol" && layer.id === "1-cluster-marker") return;
      const key = layer.type === "circle" ? "circle-color" : "icon-color";
      const color = paintValue(compiled, layer.id, key, { point_count: 10 }, c.zoom);
      expect(same(marker.color, color), show(color)).toBe(true);
      return;
    }
    // A cluster of `n` points; with a value by a field, the value at `n` too (one point with it).
    const at = (key: string, n: number) =>
      paintValue(
        compiled,
        "1-cluster-marker",
        key,
        { point_count: n, goat_cluster_value: n, goat_cluster_value_n: 1 },
        c.zoom
      );
    expect(same(marker.color, at("circle-color", 10)), show(at("circle-color", 10))).toBe(true);
    // The sample's size lies between the smallest and the largest cluster's: over the counts, or over the value's
    // domain.
    const size = ((render.symbol as JsonObject)?.marker as JsonObject)?.size as JsonObject | undefined;
    const [from, to] =
      isObject(render.value) && render.value.op !== "count" && Array.isArray(size?.domain)
        ? (size.domain as [number, number])
        : [2, 1000];
    const [small, large] = [at("circle-radius", from), at("circle-radius", to)].map((r) => (r as number) * 2);
    expect(marker.size as number).toBeGreaterThanOrEqual(small);
    expect(marker.size as number).toBeLessThanOrEqual(large);
  });

  it("clusters drawn like points colored and sized by a field: the Clusters sample is what the map draws", () => {
    const c: LegendCase = {
      id: "cluster-points-by-field",
      geometry: "point",
      zoom: 10,
      fields: { amount: "number" },
      style: {
        version: 1,
        kind: "vector",
        symbol: {
          marker: {
            shape: "circle",
            color: { field: "amount", palette: ["#0000ff", "#00ff00", "#ff0000"], domain: [0, 10] },
            size: { field: "amount", range: [8, 24], domain: [0, 10] },
          },
          outline: { color: { field: "amount", palette: ["#000000", "#ffffff"], domain: [0, 10] }, width: 2 },
        },
        render: { type: "cluster", look: "points" },
      },
    };
    const compiled = compileLayer(compileInput(c));
    const [section] = legendOf(c).sections;
    if (section.kind !== "entries" || section.id !== "cluster") throw new Error("no cluster entry");
    const { marker, outline } = section.entries[0].swatch;
    const at = (key: string) => paintValue(compiled, "1-cluster-marker", key, { point_count: 10 }, c.zoom);
    expect(same(marker?.color, at("circle-color")), show(at("circle-color"))).toBe(true);
    expect(marker?.size).toBe((at("circle-radius") as number) * 2);
    expect(same(outline?.color, at("circle-stroke-color")), show(at("circle-stroke-color"))).toBe(true);
    // The same values by attribute in zoom stops (spec 4.4).
    const stops = (form: unknown) => ({
      zoom: [
        [8, form],
        [12, form],
      ],
    });
    const symbol = c.style.symbol as JsonObject;
    const marker4 = symbol.marker as JsonObject;
    const inStops: LegendCase = {
      ...c,
      id: "cluster-points-by-field-in-stops",
      style: {
        ...c.style,
        symbol: { ...symbol, marker: { ...marker4, color: stops(marker4.color) } },
      },
    };
    const sample = legendOf(inStops).sections[0];
    if (sample.kind !== "entries") throw new Error("no cluster entry");
    const drawn = paintValue(
      compileLayer(compileInput(inStops)),
      "1-cluster-marker",
      "circle-color",
      { point_count: 10 },
      inStops.zoom
    );
    expect(same(sample.entries[0].swatch.marker?.color, drawn), show(drawn)).toBe(true);
  });

  it("covers heatmaps, hexagons and clusters", () => {
    expect([heatmaps.length, hexagons.length, clusters.length].every((n) => n >= 3)).toBe(true);
  });
});
