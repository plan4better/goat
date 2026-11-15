// The legend against the map: for a feature that falls in a legend entry, MapLibre's own evaluation of the
// compiled layers gives the look the entry's swatch shows. Compared are the properties an entry stands for (what its
// classification or rule sets); a block that sets no color draws grey by design, so its color is not compared.
// Heatmaps, clusters, H3 and rasters are not features with a look of their own and are left to the other checks.
import { Color } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { FieldType, Geometry } from "@/lib/style/compile/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { type LegendEntry, type Swatch, buildLegend } from "@/lib/style/legend";

import { type LegendCase, compileInput, legendCases, pointsDrawn } from "./cases";
import { known } from "./known";
import { type MapLook, mapLook, paintValue } from "./mapSwatch";

const MAIN: Record<Geometry, string> = { point: "marker", line: "line", polygon: "fill" };
const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

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

/** A feature that falls in an entry of a classification; null where none can be made up. */
function sample(
  c: JsonObject,
  entry: LegendEntry,
  type: FieldType | undefined
): Record<string, unknown> | null {
  const field = c.field as string;
  const numeric = type === "number" || type === "integer";
  if (entry.extra === "no_data") return {};
  if (entry.extra === "other") {
    if (c.method !== "categories" || type === "boolean") return null;
    return { [field]: numeric ? -987654 : "not a listed value" };
  }
  if (entry.values) {
    const value = entry.values[0];
    if (type === "boolean") return { [field]: value === true || value === "true" };
    return { [field]: numeric ? Number(value) : value };
  }
  if (entry.range) {
    const { from, to } = entry.range;
    if (from !== undefined && to !== undefined) return { [field]: (from + to) / 2 };
    if (to !== undefined) return { [field]: to - 1 };
    if (from !== undefined) return { [field]: from + 1 };
    return { [field]: 0 };
  }
  return null;
}

const targetOf = (c: JsonObject, geometry: Geometry) =>
  typeof c.target === "string" ? c.target : `${MAIN[geometry]}.color`;
/** Classifications the legend shows as one block: one field, the same categories or the same numeric bounds. */
const sameClasses = (a: JsonObject, b: JsonObject) =>
  a.field === b.field &&
  (a.method === "categories") === (b.method === "categories") &&
  JSON.stringify(list(a.classes).map((k) => [k.values, k.from, k.to])) ===
    JSON.stringify(list(b.classes).map((k) => [k.values, k.from, k.to]));

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
  const look = (properties: Record<string, unknown>) => mapLook(compiled, properties, c.zoom, geometry);
  const classify = list(c.style.classify);
  const symbol = isObject(c.style.symbol) ? c.style.symbol : {};
  // The sizes the style gives by zoom: the legend reads them at one zoom (spec 7.2), the map at its own.
  const sizesByZoom = ["marker.size", "line.width", "outline.width", "casing.width"].filter((path) => {
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
        return !(isObject(form) && typeof form.field === "string");
      });
      out.push(...compare("base", section.entries[0].swatch, drawn, fixed, steady));
    } else if (section.kind === "entries" && section.id === "rules") {
      for (const entry of section.entries) {
        const rule = list(c.style.rules).find(
          (r, i) => (typeof r.id === "string" ? r.id : String(i)) === entry.id
        );
        const when = isObject(rule?.when) ? rule.when : {};
        const args = Array.isArray(when.args) ? when.args : [];
        if (!rule || when.op !== "=" || !isObject(args[0])) continue;
        const drawn = look({ [args[0].property as string]: args[1] });
        out.push(...compare(`rule ${entry.id}`, entry.swatch, drawn, rulePaths(rule)));
      }
    } else if (section.kind === "entries") {
      const own = classify.find((k) => (typeof k.id === "string" ? k.id : String(k.field)) === section.id);
      if (!own) continue;
      // What the block stands for: its classification's property, and those of the classifications merged into it.
      const paths = classify
        .filter((k) => k === own || sameClasses(k, own))
        .map((k) => targetOf(k, geometry));
      for (const entry of section.entries) {
        const properties = sample(own, entry, c.fields[own.field as string]);
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
          const byField = isObject(form) && typeof form.field === "string";
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
            if (!height && (held === undefined || !(path in drawn))) notCompared?.add(path);
          }
      }
    } else if (section.kind === "ramp" || section.kind === "sizes") {
      const [part, key] = section.id.split(".");
      const form = isObject(symbol[part]) ? (symbol[part] as JsonObject)[key] : undefined;
      if (!isObject(form) || typeof form.field !== "string") continue;
      const field = form.field;
      if (section.kind === "ramp") {
        const ends = [section.colors[0], section.colors[section.colors.length - 1]];
        ends.forEach((color, end) => {
          const drawn = look({ [field]: section.domain[end] });
          if (section.id in drawn && !same(color, drawn[section.id]))
            out.push(`ramp ${section.id} end ${end}: legend ${color}, map ${show(drawn[section.id])}`);
        });
      } else
        for (const s of section.samples)
          out.push(
            ...compare(`sizes ${section.id} at ${s.value}`, s.swatch, look({ [field]: s.value }), [
              section.id,
            ])
          );
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

  it("compares every property a block stands for, but these", () => {
    const notCompared = new Set<string>();
    for (const c of cases) differences(c, notCompared);
    // Not compared, so a legend that got these wrong would pass: the dash is not read back from the layers here.
    // Every other property a classification sets in the cases is compared.
    expect([...notCompared].sort()).toEqual(["line.dash", "outline.dash"]);
  });
});

// A heatmap, H3 hexagons and clusters are no features with a look of their own: their legends are held against
// the layers that draw them.
describe("the density legends against the map", () => {
  const renderOf = (c: LegendCase) => (isObject(c.style.render) ? String(c.style.render.type) : "features");
  const drawn = cases.filter((c) => c.geometry === "point");
  const legendOf = (c: LegendCase) => buildLegend(c.style, { geometry: c.geometry, zoom: c.zoom })!;

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
  });

  const hexagons = drawn.filter((c) => renderOf(c) === "h3" && !pointsDrawn(c));
  it.each(hexagons.map((c) => [c.id, c] as const))(
    "%s: the hexagons' classes or ramp are their colors",
    (_id, c) => {
      const compiled = compileLayer(compileInput(c));
      const layer = compiled.layers.find((l) => l.id === "1-h3-fill")!;
      const key = layer.type === "fill-extrusion" ? "fill-extrusion-color" : "fill-color";
      const at = (value: number) => paintValue(compiled, "1-h3-fill", key, { value }, c.zoom);
      const section = legendOf(c).sections.find((s) => s.id === "h3");
      if (section?.kind === "ramp") {
        const ends = [section.colors[0], section.colors[section.colors.length - 1]];
        ends.forEach((color, end) =>
          expect(same(color, at(section.domain[end])), `end ${end}: ${show(at(section.domain[end]))}`).toBe(
            true
          )
        );
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
        }
      } else throw new Error("no h3 section");
    }
  );

  const clusters = drawn.filter((c) => renderOf(c) === "cluster" && c.zoom < 14);
  it.each(clusters.map((c) => [c.id, c] as const))("%s: the Clusters sample is a cluster", (_id, c) => {
    const compiled = compileLayer(compileInput(c));
    const [section] = legendOf(c).sections;
    if (section.kind !== "entries" || section.id !== "cluster") throw new Error("no cluster entry");
    const marker = section.entries[0].swatch.marker!;
    const at = (key: string, count: number) =>
      paintValue(compiled, "1-cluster-marker", key, { point_count: count }, c.zoom);
    expect(same(marker.color, at("circle-color", 10)), show(at("circle-color", 10))).toBe(true);
    // The sample's size lies between the smallest and the largest cluster's.
    const [small, large] = [at("circle-radius", 2), at("circle-radius", 1000)].map((r) => (r as number) * 2);
    expect(marker.size as number).toBeGreaterThanOrEqual(small);
    expect(marker.size as number).toBeLessThanOrEqual(large);
  });

  it("covers heatmaps, hexagons and clusters", () => {
    expect([heatmaps.length, hexagons.length, clusters.length].every((n) => n >= 3)).toBe(true);
  });
});
