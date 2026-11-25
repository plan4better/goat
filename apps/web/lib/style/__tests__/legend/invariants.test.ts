// What holds for the legend of every case (spec 7.2): which entries it lists and in which order, that its texts
// and colors are real, and where each kind of section sits. Then what holds for the compiled layers of every case of
// automatic colors, None and transparency (spec 18.10, 4.6), on a light and on a dark basemap.
import { Color } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { LABEL_FALLBACK, contrastRatio, isNone } from "@/lib/style/colors";
import { compileLayer } from "@/lib/style/compile";
import { HIGHLIGHT } from "@/lib/style/compile/constants";
import { parseMarkerImage } from "@/lib/style/compile/markerImage";
import type { CompiledLayer } from "@/lib/style/compile/types";
import { PALETTES } from "@/lib/style/generated/catalog";
import { type JsonObject, isObject } from "@/lib/style/json";
import { type LegendSection, type Swatch, buildLegend, rangeText, valuesText } from "@/lib/style/legend";
import type { Tone } from "@/lib/style/tone";

import { maplibreErrors } from "../maplibre";
import { type LegendCase, colorCases, compileInput, legendCases, pointsDrawn } from "./cases";
import { CONTRAST_LIMITS, contrastLimit, known } from "./known";
import { colorOf, layerReader, layerValue, mapLook } from "./mapSwatch";
import { sampleFor } from "./samples";
import { ZOOM_STOPS, attributePaths, inZoomStops } from "./zoomStops";

const cases = legendCases();
const each = cases.map((c) => [c.id, c] as const);
const WORDS = { under: "under", to: "to", andMore: "and more" };
const BAD = /NaN|undefined|null|Infinity/;

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);
const legendOf = (c: LegendCase) =>
  buildLegend(c.style, { geometry: c.geometry, zoom: c.zoom, serviceLegendUrl: c.serviceLegendUrl });
const entriesOf = (sections: LegendSection[]) =>
  sections.filter((s): s is Extract<LegendSection, { kind: "entries" }> => s.kind === "entries");

/** The ids a classification's block lists: its classes in list order that are neither hidden with the eye nor left
 * out of the legend, then Other, then No data. Those two are listed when the data holds such features
 * (`computed.other`, `computed.no_data`, written by the server), whether the style sets something for them or not,
 * unless the author hid them or left them out; while the server has not said, when the style has a record. */
function expectedEntries(c: JsonObject): string[] {
  const shown = (k: JsonObject) => k.visible !== false && k.legend !== false;
  const classes = list(c.classes).flatMap((k, i) =>
    shown(k) && !(Array.isArray(k.values) && !k.values.length)
      ? [typeof k.id === "string" ? k.id : String(i)]
      : []
  );
  const facts = isObject(c.computed) ? c.computed : {};
  const extras = (["other", "no_data"] as const).filter((key) => {
    const record = c[key];
    if (isObject(record) && !shown(record)) return false;
    return typeof facts[key] === "boolean" ? facts[key] : isObject(record);
  });
  return [...classes, ...extras];
}

const colorsOf = (swatch: Swatch): unknown[] =>
  (["fill", "outline", "line", "casing", "marker"] as const).flatMap((part) =>
    ["color", "pattern_color", "icon_color"].flatMap((key) => {
      const value = swatch[part]?.[key];
      return value === undefined ? [] : [value];
    })
  );

describe("legend invariants", () => {
  it.each(each)("%s: a legend unless it is switched off or a raster has nothing to show", (_id, c) => {
    const legend = legendOf(c);
    const off = c.style.legend === false || (isObject(c.style.legend) && c.style.legend.show === false);
    if (off) expect(legend).toBeNull();
    else if (c.style.kind === "vector") expect(legend!.sections.length).toBeGreaterThan(0);
    else if (legend) expect(legend.sections.length).toBeGreaterThan(0);
  });

  it.each(each)("%s: title and caption come through", (_id, c) => {
    const legend = legendOf(c);
    if (!legend || !isObject(c.style.legend)) return;
    expect(legend.title).toBe(c.style.legend.title);
    expect(legend.caption).toBe(c.style.legend.caption);
  });

  it.each(each.filter(([, c]) => c.values && c.values.method !== "none"))(
    "%s: the first classification lists its shown classes in order, then Other, then No data",
    (_id, c) => {
      const [first, second] = list(c.style.classify);
      const section = entriesOf(legendOf(c)!.sections).find((s) => s.id === "first");
      // A heatmap or H3 layer that draws no points at this zoom lists none of their classes.
      if (!pointsDrawn(c)) return expect(section).toBeUndefined();
      const expected = expectedEntries(first);
      // Two classifications of one field with the same categories are one list (their records merged).
      const merged = c.values!.second === "same_field" && !!second;
      if (!expected.length && !section) return;
      // The merged list keeps the first classification's class ids, which its counts (`legend.classes`) read.
      expect(section?.entries.map((e) => e.id)).toEqual(expected);
      expect(section?.field).toBe(first.field);
      if (merged) expect(entriesOf(legendOf(c)!.sections).some((s) => s.id === "second")).toBe(false);
    }
  );

  it.each(each)("%s: no block is empty", (_id, c) => {
    const empty = entriesOf(legendOf(c)?.sections ?? []).filter((s) => !s.entries.length);
    if (known("invariants", c)) expect(empty.length, known("invariants", c)!.reason).toBeGreaterThan(0);
    else expect(empty).toEqual([]);
  });

  it.each(each)("%s: named rules are listed unless left out", (_id, c) => {
    const legend = legendOf(c);
    if (!legend || c.style.kind !== "vector") return;
    // A rule that hides its features draws nothing, so it has no entry either.
    const expected = (pointsDrawn(c) ? list(c.style.rules) : []).filter(
      (r) => typeof r.name === "string" && r.legend !== false && r.visible !== false
    );
    const section = entriesOf(legend.sections).find((s) => s.id === "rules");
    // (Beside the rules, a layer without classes lists its other features: checked on its own below.)
    const named = section?.entries.filter((e) => !e.extra) ?? [];
    expect(named.map((e) => e.name)).toEqual(expected.map((r) => r.name));
  });

  it.each(each)("%s: every text is real and every color one MapLibre reads", (_id, c) => {
    for (const section of legendOf(c)?.sections ?? []) {
      if (section.kind === "entries")
        for (const entry of section.entries) {
          const text =
            entry.name ??
            (entry.values
              ? valuesText(entry.values, { locale: "en", unit: section.unit, format: section.format })
              : entry.range
                ? rangeText(entry.range, {
                    locale: "en",
                    words: WORDS,
                    domain: section.domain,
                    unit: section.unit,
                    format: section.format,
                  })
                : (entry.extra ?? "base"));
          // The base look and a rule's entry take their text from the layer and the rule.
          expect(text, `${section.id}/${entry.id}`).not.toMatch(BAD);
          if (section.id !== "base" && section.id !== "h3")
            expect(text.trim(), `${section.id}/${entry.id}`).not.toBe("");
          for (const color of colorsOf(entry.swatch))
            expect(Color.parse(color as string), `${section.id}/${entry.id}: ${String(color)}`).toBeTruthy();
        }
      if (section.kind === "ramp") {
        expect(section.colors.length).toBeGreaterThanOrEqual(2);
        // The features' own opacity where they are drawn fainter than full strength; none at full strength.
        if (section.opacity !== undefined) {
          expect(section.opacity).toBeGreaterThanOrEqual(0);
          expect(section.opacity).toBeLessThan(1);
        }
        for (const color of section.colors) expect(Color.parse(color), color).toBeTruthy();
        expect(section.domain.every(Number.isFinite)).toBe(true);
        expect(section.domain[0]).toBeLessThanOrEqual(section.domain[1]);
      }
      if (section.kind === "sizes") {
        expect(section.samples).toHaveLength(3);
        const values = section.samples.map((s) => s.value);
        expect(values.every(Number.isFinite)).toBe(true);
        expect([...values].sort((a, b) => a - b)).toEqual(values);
      }
    }
  });

  it.each(each)("%s: beside clusters, every entry says what it stands for", (_id, c) => {
    const sections = entriesOf(legendOf(c)?.sections ?? []);
    if (!sections.some((s) => s.id === "cluster")) return;
    for (const section of sections)
      for (const entry of section.entries)
        expect(
          entry.name ?? entry.values ?? entry.range ?? entry.extra,
          `${section.id}/${entry.id}`
        ).toBeDefined();
  });

  it.each(each)("%s: numeric classes ascend and do not overlap", (_id, c) => {
    for (const section of entriesOf(legendOf(c)?.sections ?? [])) {
      const ranges = section.entries.flatMap((e) => (e.range && !e.extra ? [e.range] : []));
      ranges.forEach((range, i) => {
        if (range.from !== undefined && range.to !== undefined) expect(range.from).toBeLessThan(range.to);
        const before = ranges[i - 1];
        if (before?.to !== undefined && range.from !== undefined)
          expect(range.from).toBeGreaterThanOrEqual(before.to);
      });
    }
  });

  it.each(each)("%s: the Height line comes last, only for raised layers", (_id, c) => {
    const sections = legendOf(c)?.sections ?? [];
    const at = sections.findIndex((s) => s.kind === "height");
    if (at >= 0) expect(at).toBe(sections.length - 1);
    // A classification of the height without classes says nothing of the height: the base height is what is drawn.
    const height = sections[at];
    if (height?.kind === "height" && height.mode === "classes") expect(height.count).toBeGreaterThan(0);
    // Raised polygons, and H3 columns while the hexagons are drawn.
    if (c.values)
      expect(at >= 0).toBe(
        c.values.geometry === "polygon_raised" || (c.values.render === "h3_raised" && !pointsDrawn(c))
      );
  });

  it.each(each.filter(([, c]) => c.values))("%s: each setting of the case leaves its section", (_id, c) => {
    const sections = legendOf(c)!.sections;
    const v = c.values!;
    const ids = sections.map((s) => s.id);
    // How the points are drawn: the density alone while no points show, then the points alone; clusters first.
    if (v.render.startsWith("heatmap") || v.render.startsWith("h3")) {
      const own = v.render.startsWith("heatmap") ? "heatmap" : "h3";
      if (pointsDrawn(c)) expect(ids).not.toContain(own);
      else expect(ids.filter((id) => id !== "height")).toEqual([own]);
    }
    // Clusters first, while the map clusters (below zoom 14, the default).
    expect(ids[0] === "cluster").toBe(v.render === "cluster" && c.zoom < 14);
    if (!pointsDrawn(c)) return;
    // A palette or a range by attribute on the base symbol: a ramp, three size samples.
    expect(sections.some((s) => s.kind === "ramp" && s.id.endsWith(".color"))).toBe(v.base === "palette");
    expect(sections.some((s) => s.kind === "sizes")).toBe(v.base === "range");
    // A second classification of another field: a block of its own.
    if (v.second === "other_field" && v.data !== "boolean")
      expect(entriesOf(sections).some((s) => s.id === "second")).toBe(true);
    if (v.second === "none") expect(entriesOf(sections).some((s) => s.id === "second")).toBe(false);
    // The ramp and the size samples name the field they stand for.
    for (const s of sections)
      if ((s.kind === "ramp" && s.id.endsWith(".color")) || s.kind === "sizes")
        expect(s.field).toBe("amount");
    // A base color by attribute has no one color: swatches draw neutral grey, not the default green.
    if (v.base === "palette") {
      const main = { point: "marker", line: "line", polygon: "fill" }[c.geometry!] as
        | "marker"
        | "line"
        | "fill";
      // The cluster symbol has its own color (the default where the style gives none), on the map too.
      const swatches = sections
        .filter((s) => s.id !== "cluster")
        .flatMap((s) =>
          s.kind === "entries"
            ? s.entries.map((e) => e.swatch)
            : s.kind === "sizes"
              ? s.samples.map((x) => x.swatch)
              : []
        );
      for (const swatch of swatches) expect(swatch[main]?.color).not.toBe("#2bb381");
    }
    // Classes of a size: the block says so, and only it (its entries are drawn at sizes).
    const first = entriesOf(sections).find((x) => x.id === "first");
    if (first)
      expect(first.sized === true).toBe(
        v.target === "size" || (v.second === "same_field" && v.target === "color")
      );
    // Classes of the height: each entry carries its height, drawn as a bar.
    if (v.target === "height") {
      const block = entriesOf(sections).find((s) => s.id === "first");
      if (block) {
        expect(block.bars).toBe(true);
        for (const entry of block.entries) expect(typeof entry.height).toBe("number");
      }
    }
  });

  // A value by attribute in zoom stops (spec 4.4) that is the same at every stop draws what it draws alone.
  const sameAtEveryStop = cases.flatMap((c) => {
    const variant = attributePaths(c).length ? inZoomStops(c, "same", ZOOM_STOPS.same) : null;
    return variant ? [[c.id, c, variant] as const] : [];
  });
  it.each(sameAtEveryStop)(
    "%s: a value by attribute the same at every zoom stop leaves the legend it leaves alone",
    (_id, c, variant) => {
      // Colors compared as MapLibre reads them, whatever their letters' case.
      const read = (legend: unknown) => JSON.parse(JSON.stringify(legend).toLowerCase()) as unknown;
      expect(read(legendOf(variant))).toEqual(read(legendOf(c)));
    }
  );

  it("values by attribute in zoom stops are checked in enough cases", () => {
    expect(sameAtEveryStop.length).toBeGreaterThanOrEqual(20);
  });

  const spec = (line: number) => legendOf(cases.find((c) => c.id === `spec-${line}`)!)!;

  it("a heatmap's ramp reads low to high, not numbers", () => {
    const [ramp] = spec(1666).sections;
    expect(ramp).toMatchObject({ kind: "ramp", id: "heatmap", ends: "low_high" });
  });

  it("clusters come first with a sample, then the single points", () => {
    const [cluster, base] = spec(1702).sections;
    expect(cluster).toMatchObject({ kind: "entries", id: "cluster" });
    const [entry] = (cluster as Extract<LegendSection, { kind: "entries" }>).entries;
    expect(entry.extra).toBe("cluster");
    // The spec's example sizes clusters from 16 to 40 px: the sample sits in the middle.
    expect(entry.swatch.marker).toMatchObject({ color: "#283593", size: 28 });
    expect(base).toMatchObject({ kind: "entries", id: "base" });
    // Below the Clusters row, the base look reads as the single points; without clusters it takes the layer's name.
    expect((base as Extract<LegendSection, { kind: "entries" }>).entries[0].extra).toBe("points");
    const plain = buildLegend(
      { version: "1.0.0", kind: "vector", symbol: { marker: { color: "#283593" } } },
      { geometry: "point", zoom: 12 }
    )!.sections;
    expect((plain[0] as Extract<LegendSection, { kind: "entries" }>).entries[0].extra).toBeUndefined();
  });

  it("a cluster value's size samples have the cluster symbol's color and outline, as on the map", () => {
    const style = {
      version: "1.0.0",
      kind: "vector",
      render: {
        type: "cluster",
        value: { op: "sum", field: "amount" },
        symbol: {
          marker: {
            shape: "circle",
            color: "#2166ac",
            size: { field: "value", range: [16, 48], scale: "sqrt", domain: [0, 1000] },
            opacity: { field: "count", range: [0.5, 1], domain: [0, 10] },
          },
          outline: { color: "#ffffff", width: 2 },
        },
      },
      symbol: { marker: { shape: "circle", color: "#283593", size: 8 } },
    };
    const sections = buildLegend(style, { geometry: "point", zoom: 12 })!.sections;
    // A form over the count is no sample of the value.
    expect(sections.map((s) => s.id)).toEqual(["cluster", "cluster.marker.size", "base"]);
    const sizes = sections[1] as Extract<LegendSection, { kind: "sizes" }>;
    for (const sample of sizes.samples) {
      expect(sample.swatch.marker).toMatchObject({ color: "#2166ac" });
      expect(sample.swatch.outline).toMatchObject({ color: "#ffffff", width: 2 });
    }
  });

  it("the cluster sample follows the cluster size set in the panel", () => {
    const sample = (size: unknown) => {
      const style = {
        version: "1.0.0",
        kind: "vector",
        render: { type: "cluster", symbol: { marker: { shape: "circle", size } } },
      };
      const [cluster] = buildLegend(style, { geometry: "point", zoom: 12 })!.sections;
      return (cluster as Extract<LegendSection, { kind: "entries" }>).entries[0].swatch.marker!.size;
    };
    expect(sample({ field: "count", range: [10, 60], scale: "sqrt" })).toBe(35);
    expect(sample(20)).toBe(20);
  });

  it("a part the layer switches off shows in no swatch, though classes set it; an outline in the fill color takes the class's", () => {
    const style = {
      version: "1.0.0",
      kind: "vector",
      symbol: { fill: false, outline: { color: "fill", width: 2 } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          target: "fill.color",
          classes: [{ id: "a", values: ["a"], fill: { color: "#111111" } }],
        },
      ],
    };
    const [block] = buildLegend(style, { geometry: "polygon", zoom: 12 })!.sections;
    const { swatch } = (block as Extract<LegendSection, { kind: "entries" }>).entries[0];
    expect(swatch.fill).toBeUndefined();
    expect(swatch.outline?.color).toBe("#111111");
    // A class still switches off a part the layer shows.
    const shown = buildLegend(
      {
        ...style,
        symbol: { fill: { color: "#cccccc" } },
        classify: [{ ...style.classify[0], classes: [{ id: "a", values: ["a"], fill: false }] }],
      },
      { geometry: "polygon", zoom: 12 }
    )!.sections[0] as Extract<LegendSection, { kind: "entries" }>;
    expect(shown.entries[0].swatch.fill).toBeUndefined();
  });

  it("clusters drawn like the points show the points' marker, with a badge where the count is on one", () => {
    const sample = (render: object) => {
      const style = {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: { shape: "icon", icon: "goat:shop", color: "#5a1846", size: 20 } },
        render: {
          type: "cluster",
          symbol: { marker: { color: "#2838b2" }, label: { text: "{count}", color: "#ffff00" } },
          ...render,
        },
      };
      const [cluster] = buildLegend(style, { geometry: "point", zoom: 12 })!.sections;
      expect(cluster).toMatchObject({ kind: "entries", id: "cluster" });
      return (cluster as Extract<LegendSection, { kind: "entries" }>).entries[0].swatch;
    };
    const points = sample({ look: "points", count: "badge" });
    expect(points.marker).toMatchObject({ shape: "icon", icon: "goat:shop", color: "#5a1846" });
    expect(points.badge).toEqual({ color: "#2838b2", text: "#ffff00", ring: "#ffffff" });
    expect(sample({ look: "points" }).badge).toBeUndefined();
    expect(sample({ look: "points" }).marker).toMatchObject({ icon: "goat:shop" });
    // A circle by count with a badge: the circle in the cluster color, the badge too.
    const circle = sample({ count: "badge" });
    expect(circle.marker).toMatchObject({ color: "#2838b2" });
    expect(circle.marker?.icon).toBeUndefined();
    expect(circle.badge).toEqual({ color: "#2838b2", text: "#ffff00", ring: "#ffffff" });
    expect(sample({}).badge).toBeUndefined();
  });

  it("a cluster badge takes the cluster symbol's outline as its ring", () => {
    const style = {
      version: "1.0.0",
      kind: "vector",
      render: {
        type: "cluster",
        count: "badge",
        symbol: { marker: { color: "#283593" }, outline: { color: "#000000", width: 2 } },
      },
    };
    const [cluster] = buildLegend(style, { geometry: "point", zoom: 12 })!.sections;
    const swatch = (cluster as Extract<LegendSection, { kind: "entries" }>).entries[0].swatch;
    expect(swatch.badge?.ring).toBe("#000000");
  });

  it("clusters with a value name it, and a size or color by the value shows its range", () => {
    const style = {
      version: "1.0.0",
      kind: "vector",
      render: {
        type: "cluster",
        value: { op: "sum", field: "turnover" },
        symbol: {
          marker: {
            shape: "circle",
            size: { field: "value", range: [10, 30], domain: [0, 1000] },
            color: { field: "value", palette: ["#000000", "#ffffff"], domain: [0, 1000] },
          },
          label: { text: "{value}" },
        },
      },
    };
    const sections = buildLegend(style, { geometry: "point", zoom: 12 })!.sections;
    expect(sections.map((s) => [s.kind, s.id])).toEqual([
      ["entries", "cluster"],
      ["sizes", "cluster.marker.size"],
      ["ramp", "cluster.marker.color"],
      ["entries", "base"],
    ]);
    expect(sections[0]).toMatchObject({ op: "sum", field: "turnover" });
    expect(sections[1]).toMatchObject({ op: "sum", field: "turnover" });
    expect(sections[2]).toMatchObject({ op: "sum", field: "turnover", domain: [0, 1000] });
    // The count names nothing more, as today.
    const counted = buildLegend(
      { ...style, render: { ...style.render, value: undefined } },
      { geometry: "point", zoom: 12 }
    )!.sections;
    expect(counted[0]).not.toHaveProperty("op");
  });

  it("a cluster badge without a cluster symbol has the map's default colors", () => {
    const style = {
      version: "1.0.0",
      kind: "vector",
      symbol: { marker: { shape: "pin" } },
      render: { type: "cluster", look: "points", count: "badge" },
    };
    const [cluster] = buildLegend(style, { geometry: "point", zoom: 12 })!.sections;
    const swatch = (cluster as Extract<LegendSection, { kind: "entries" }>).entries[0].swatch;
    const compiled = compileLayer({
      id: "1",
      style: style as never,
      geometry: "point",
      source: { type: "points", id: "s", data: "https://geoapi.example/items" },
    });
    const badge = compiled.layers.find((l) => l.id === "1-cluster-badge") as {
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
    };
    expect(JSON.stringify(badge.layout["icon-image"])).toContain(`||${swatch.badge!.color}|`);
    expect(badge.paint["text-color"]).toBe(swatch.badge!.text);
    expect(swatch.marker).toMatchObject({ shape: "pin" });
  });

  it("clusters without a symbol of their own show the color the map gives them", () => {
    const style = {
      version: "1.0.0",
      kind: "vector",
      render: { type: "cluster" },
      symbol: { marker: { shape: "circle", color: "#d7191c", size: 8 } },
    };
    const [cluster] = buildLegend(style, { geometry: "point", zoom: 12 })!.sections;
    const sample = (cluster as Extract<LegendSection, { kind: "entries" }>).entries[0].swatch.marker!;
    const compiled = compileLayer({
      id: "1",
      style: style as never,
      geometry: "point",
      fields: {},
      source: { type: "points", id: "s", data: "https://geoapi.example/items" },
    });
    const layer = compiled.layers.find((l) => l.id === "1-cluster-marker") as {
      paint: Record<string, unknown>;
    };
    expect(layer.paint["circle-color"]).toBe(sample.color);
  });

  // A heatmap or H3 layer draws its points from a zoom on, or never: the legend follows what is on the map.
  const density = (render: object, zoom: number) =>
    buildLegend(
      {
        version: "1.0.0",
        kind: "vector",
        render,
        symbol: { marker: { shape: "circle", color: "#3366cc", size: 8 } },
        classify: [
          {
            id: "kinds",
            field: "category",
            method: "categories",
            classes: [
              { values: ["A"], marker: { color: "#1b9e77" } },
              { values: ["B"], marker: { color: "#d95f02" } },
            ],
          },
        ],
        rules: [
          {
            id: "r",
            name: "Flagged",
            when: { op: "=", args: [{ property: "flag" }, true] },
            marker: { size: 12 },
          },
        ],
      },
      { geometry: "point", zoom }
    )!.sections.map((s) => s.id);

  it("a heatmap that never draws its points lists none of their classes or rules", () => {
    expect(density({ type: "heatmap" }, 12)).toEqual(["heatmap"]);
    expect(density({ type: "h3", resolution: 8 }, 12)).toEqual(["h3"]);
  });

  it("with points from a zoom on: the density below that zoom, the points from it", () => {
    expect(density({ type: "heatmap", points_from_zoom: 14 }, 13)).toEqual(["heatmap"]);
    expect(density({ type: "heatmap", points_from_zoom: 14 }, 14)).toEqual(["kinds", "rules"]);
    expect(density({ type: "h3", resolution: 8, points_from_zoom: 14 }, 13)).toEqual(["h3"]);
    expect(density({ type: "h3", resolution: 8, points_from_zoom: 14 }, 15)).toEqual(["kinds", "rules"]);
  });

  const point = (extra: object, zoom = 12) =>
    buildLegend(
      {
        version: "1.0.0",
        kind: "vector",
        symbol: {
          marker: { shape: "circle", color: "#3366cc", size: 10 },
          outline: { color: "#ffffff", width: 1 },
        },
        ...extra,
      },
      { geometry: "point", zoom }
    )!.sections;
  const breaks = (records: object[]) => [
    { to: 10, ...records[0] },
    { from: 10, ...records[1] },
  ];

  it("the unit follows numbers, not names; yes and no are words", () => {
    expect(valuesText(["A"], { locale: "en", unit: "units" })).toBe("A");
    expect(valuesText([100, 50], { locale: "en", unit: "px" })).toBe("100, 50 px");
    const flags = { yes: "Yes", no: "No" };
    expect(valuesText([true], { locale: "en", unit: "px", flags })).toBe("Yes");
    expect(valuesText(["false"], { locale: "en", flags })).toBe("No");
    expect(valuesText(["true", "maybe"], { locale: "en", flags })).toBe("true, maybe");
  });

  it("numeric classifications of one field with the same classes are one block, as categories are", () => {
    const size = { id: "s", field: "rate", method: "manual", target: "marker.size" };
    const color = { id: "c", field: "rate", method: "manual" };
    const sizes = breaks([{ marker: { size: 4 } }, { marker: { size: 20 } }]);
    const colors = breaks([{ marker: { color: "#eeeeee" } }, { marker: { color: "#008800" } }]);
    const one = entriesOf(
      point({
        classify: [
          { ...size, classes: sizes },
          { ...color, classes: colors },
        ],
      })
    );
    expect(one).toHaveLength(1);
    expect(one[0].sized).toBe(true);
    expect(one[0].entries.map((e) => [e.swatch.marker?.size, e.swatch.marker?.color])).toEqual([
      [4, "#eeeeee"],
      [20, "#008800"],
    ]);
    // Other breaks: two blocks.
    const other = [
      { to: 50, marker: { color: "#eeeeee" } },
      { from: 50, marker: { color: "#008800" } },
    ];
    expect(
      entriesOf(
        point({
          classify: [
            { ...size, classes: sizes },
            { ...color, classes: other },
          ],
        })
      )
    ).toHaveLength(2);
  });

  it("a layer with only rules lists its other features after them", () => {
    const rules = [
      {
        id: "r",
        name: "Flagged",
        when: { op: "=", args: [{ property: "flag" }, true] },
        marker: { color: "#d7191c" },
      },
    ];
    const [section] = entriesOf(point({ rules }));
    expect(section.entries.map((e) => [e.id, e.extra, e.swatch.marker?.color])).toEqual([
      ["r", undefined, "#d7191c"],
      ["rest", "rest", "#3366cc"],
    ]);
    // With classes, those say what the other features are.
    const classify = [
      { id: "c", field: "rate", method: "manual", classes: breaks([{ marker: { color: "#eeeeee" } }, {}]) },
    ];
    const withClasses = entriesOf(point({ rules, classify })).find((x) => x.id === "rules")!;
    expect(withClasses.entries.map((e) => e.id)).toEqual(["r"]);
  });

  it("a block that sets the outline alone draws hollow swatches", () => {
    const outline = { id: "o", field: "rate", method: "manual", target: "outline.color" };
    const classes = breaks([{ outline: { color: "#111111" } }, { outline: { color: "#999999" } }]);
    expect(entriesOf(point({ classify: [{ ...outline, classes }] }))[0].hollow).toBe(true);
    const fill = {
      id: "c",
      field: "rate",
      method: "manual",
      classes: breaks([{ marker: { color: "#eeeeee" } }, {}]),
    };
    expect(entriesOf(point({ classify: [fill] }))[0].hollow).toBeUndefined();
  });

  it("clusters are listed only while the map clusters", () => {
    const render = { type: "cluster", cluster_until_zoom: 12 };
    expect(point({ render }, 11).map((x) => x.id)).toEqual(["cluster", "base"]);
    expect(point({ render }, 12).map((x) => x.id)).toEqual(["base"]);
    // Without a zoom of its own: the default, 14.
    expect(point({ render: { type: "cluster" } }, 13)[0].id).toBe("cluster");
    expect(point({ render: { type: "cluster" } }, 14)[0].id).toBe("base");
  });

  // The data decides whether No data and Other are listed, once the server has looked (spec 12).
  const extras = (computed: object | undefined, records: object) =>
    entriesOf(
      buildLegend(
        {
          version: "1.0.0",
          kind: "vector",
          symbol: { marker: { shape: "circle", color: "#3366cc", size: 10 } },
          classify: [
            {
              id: "k",
              field: "category",
              method: "categories",
              target: "marker.size",
              classes: [{ values: ["A"], marker: { size: 4 } }],
              ...records,
              ...(computed
                ? { computed: { at: "2026-01-01T00:00:00Z", data: "f", scope: "dataset", ...computed } }
                : {}),
            },
          ],
        },
        { geometry: "point", zoom: 12 }
      )!.sections
    )[0].entries.flatMap((e) => (e.extra ? [e.extra] : []));

  it("No data and Other are listed when the data has such features, with or without a record", () => {
    expect(extras({ no_data: true, other: true }, {})).toEqual(["other", "no_data"]);
    const records = { other: { marker: { size: 6 } }, no_data: { marker: { size: 8 } } };
    expect(extras({ no_data: true, other: true }, records)).toEqual(["other", "no_data"]);
  });

  it("they are not listed when the data has none, even with a record", () => {
    const records = { other: { marker: { size: 6 } }, no_data: { marker: { size: 8 } } };
    expect(extras({ no_data: false, other: false }, records)).toEqual([]);
    expect(extras({ no_data: true, other: false }, records)).toEqual(["no_data"]);
  });

  it("the author still hides them or leaves them out of the legend", () => {
    const facts = { no_data: true, other: true };
    expect(extras(facts, { no_data: { visible: false }, other: { legend: false } })).toEqual([]);
  });

  it("while the server has not looked, a record lists them", () => {
    expect(extras(undefined, {})).toEqual([]);
    expect(extras(undefined, { no_data: { marker: { size: 8 } } })).toEqual(["no_data"]);
  });

  it("a field with No data in one block has it in every block of that field", () => {
    const legend = buildLegend(
      {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: { shape: "circle", color: "#3366cc", size: 10 } },
        classify: [
          {
            id: "size",
            field: "rate",
            method: "manual",
            target: "marker.size",
            classes: [
              { to: 10, marker: { size: 4 } },
              { from: 10, marker: { size: 20 } },
            ],
          },
          {
            id: "color",
            field: "rate",
            method: "manual",
            classes: [
              // (Other bounds than the size classes: with the same ones the two would be one block.)
              { to: 50, marker: { color: "#eeeeee" } },
              { from: 50, marker: { color: "#008800" } },
            ],
            no_data: { marker: { color: "#cccccc" } },
          },
        ],
      },
      { geometry: "point", zoom: 12 }
    )!;
    const [size, color] = entriesOf(legend.sections);
    // The size classification sets nothing for features without a value: they keep the base size, and are listed.
    expect(size.entries.map((e) => e.id)).toEqual(["0", "1", "no_data"]);
    expect(size.entries[2]).toMatchObject({ extra: "no_data", swatch: { marker: { size: 10 } } });
    expect(color.entries.map((e) => e.id)).toEqual(["0", "1", "no_data"]);
  });

  it("H3 hexagons before their values are computed show the one color the map draws, not a point", () => {
    const sections = spec(1736).sections;
    expect(sections.some((s) => s.id === "base")).toBe(false);
    const h3 = entriesOf(sections).find((s) => s.id === "h3")!;
    expect(h3.entries).toHaveLength(1);
    expect(h3.entries[0].swatch).toMatchObject({ geometry: "polygon", fill: { color: expect.any(String) } });
  });
});

// --- automatic colors, None and transparency ------------------------------------------------------------------------

const colors = colorCases();
const TONES: Tone[] = ["light", "dark"];
/** The zooms the colors are read at: the stops of the cases' colors by zoom (8, 16), between them, and around. */
const ZOOMS = [6, 8, 9, 10, 11.5, 12, 12.5, 14, 16, 18];
const CLUSTER_COUNTS = [2, 10, 100, 1000];
/** The zooms a label's text and halo are read at: every twentieth of a zoom from 4 to 20, so a dip between the
 * points where the text is worked out shows. */
const LABEL_ZOOMS = Array.from({ length: 321 }, (_, i) => 4 + i / 20);
const H3_VALUES = [0, 1, 5, 20, 100, 1000, 10000, 100000];
const WHITE = "#ffffff";
const ON_COLORS = ["#ffffff", "#3a3541"];
/** The least contrast an on-color reaches with the color underneath: white over the lightest color it is drawn on
 * (relative luminance just below 0.5), GOAT's dark text over the darkest (at least 6.2 to 1). */
const ON_COLOR_CONTRAST = 1.9;

const toned = (c: LegendCase, tone: Tone, extra: object = {}): CompiledLayer =>
  compileLayer({ ...compileInput(c), tone, ...extra });
const layerOf = (out: CompiledLayer, id: string) => out.layers.find((l) => l.id === `1-${id}`);
const auto = (c: LegendCase, key: string) => c.values?.[`auto:${key}`] === "yes";
const symbolOf = (c: LegendCase): JsonObject => (isObject(c.style.symbol) ? c.style.symbol : {});
const MAIN_PART = { point: "marker", line: "line", polygon: "fill" } as const;

/** The values a field takes at each color of every palette by attribute on the symbol, where the map draws that
 * color itself; with `between`, that many more evenly between the palette's ends. */
function paletteStops(c: LegendCase, between = 0): Array<Record<string, unknown>> {
  return Object.values(symbolOf(c)).flatMap((part) =>
    isObject(part)
      ? Object.values(part).flatMap((form) => {
          if (!isObject(form) || typeof form.field !== "string" || form.palette === undefined) return [];
          const computed = isObject(form.computed) ? form.computed : {};
          const domain = (form.domain ?? computed.domain) as [number, number] | undefined;
          const n = Array.isArray(form.palette)
            ? form.palette.length
            : (PALETTES[form.palette as string]?.colors.length ?? 2);
          if (!domain) return [];
          const at = (share: number) => ({
            [form.field as string]: domain[0] + (domain[1] - domain[0]) * share,
          });
          return [
            ...Array.from({ length: n }, (_, i) => at(i / (n - 1))),
            ...Array.from({ length: between }, (_, i) => at((i + 0.5) / between)),
          ];
        })
      : []
  );
}

/** The features a check reads: the base look, a feature a rule takes, one per legend entry of a classification, one at
 * each palette color (and `between` more along each palette), and features whose hex text field holds a color, no
 * color, or nothing. */
function featuresOf(c: LegendCase, between = 0): Array<Record<string, unknown>> {
  const classify = list(c.style.classify);
  const legend = buildLegend(c.style, { geometry: c.geometry, zoom: c.zoom });
  const entries = entriesOf(legend?.sections ?? []).flatMap((section) => {
    const own = classify.find((k) => (typeof k.id === "string" ? k.id : String(k.field)) === section.id);
    if (!own) return [];
    return section.entries.flatMap((entry) => {
      const properties = sampleFor(own, entry, c.fields[own.field as string]);
      return properties ? [properties] : [];
    });
  });
  return [
    {},
    { flag: true },
    { color_hex: "#e6ab02" },
    { color_hex: "#1f78b4" },
    { color_hex: "not a color" },
    ...entries,
    ...paletteStops(c, between),
  ];
}

/** Whether `a` is darker than `b` (each of red, green and blue no lighter, and further from white), or both black. */
function darker(a: string, b: string): boolean {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ca, cb] = [channels(a), channels(b)];
  if (!ca.every((x, i) => x <= cb[i])) return false;
  return b === "#000000" ? a === b : contrastRatio(a, WHITE) > contrastRatio(b, WHITE);
}

/** The factor a darker shade of the same hue scales red, green and blue by, at least: one darkening, not several and
 * not to black. */
const ONE_SHADE = 0.5;

/** How far a channel may lie from the common factor: the rounding to whole numbers, and a blend between two palette
 * stops drawn in Lab, where the blend of two shades is not exactly the shade of the blend. */
const HUE_SLACK = 2.5;

/** What is wrong with `a` as a darker shade of `b`: it must be darker (`darker`) and keep `b`'s hue, its red, green and
 * blue each `b`'s times one common factor below 1 (within `HUE_SLACK`) and above `ONE_SHADE`; black stays black.
 * Undefined where nothing is. */
function notAShadeOf(a: string, b: string): string | undefined {
  if (!darker(a, b)) return `${a} is not darker than ${b}`;
  if (b === "#000000") return undefined;
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ca, cb] = [channels(a), channels(b)];
  const most = cb.indexOf(Math.max(...cb));
  const k = ca[most] / cb[most];
  if (!cb.every((x, i) => Math.abs(ca[i] - k * x) <= HUE_SLACK)) return `${a} does not keep the hue of ${b}`;
  if (k >= 1 || k < ONE_SHADE) return `${a} is ${b} times ${k.toFixed(2)}, not one shade of it`;
  return undefined;
}

/** The case's style with every color's transparency left out: what an Auto color follows (its hue, spec 3.1). */
function opaqueCase(c: LegendCase): LegendCase {
  const strip = (value: unknown): unknown =>
    typeof value === "string" && /^#[0-9a-f]{8}$/i.test(value)
      ? value.slice(0, 7)
      : Array.isArray(value)
        ? value.map(strip)
        : isObject(value)
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strip(v)]))
          : value;
  return { ...c, style: strip(c.style) as JsonObject };
}

/** Each feature's color read from the hex text field as it is: drawn as the data gives it (spec 18.10 shade). */
const readFromData = (c: LegendCase, properties: Record<string, unknown>) =>
  c.values?.base === "data" &&
  typeof properties.color_hex === "string" &&
  /^#[0-9a-f]{6}$/i.test(properties.color_hex) &&
  Object.keys(properties).length === 1;

describe("automatic colors, None and transparency", () => {
  it("are generated in enough cases for each setting", () => {
    expect(colors.length).toBeGreaterThan(50);
    const count = (key: string, value: string) => colors.filter((c) => c.values?.[key] === value).length;
    for (const key of Object.keys(colors[0].values!).filter((k) => k.startsWith("auto:")))
      expect(count(key, "yes"), key).toBeGreaterThanOrEqual(3);
    for (const none of ["fill", "outline", "marker", "line", "class"])
      expect(count("none", none), none).toBeGreaterThanOrEqual(3);
    for (const alpha of ["fixed", "class", "palette"])
      expect(count("alpha", alpha), alpha).toBeGreaterThanOrEqual(3);
  });

  // 1. An Auto edge is a darker shade of what it follows, class by class, opaque.
  const edges = colors.filter((c) =>
    ["outline.color", "casing.color", "cluster.symbol.outline.color", "h3.outline.color"].some((k) =>
      auto(c, k)
    )
  );
  it.each(edges.map((c) => [c.id, c] as const))(
    "%s: an Auto outline or casing is a darker shade of the color it follows, class by class, and opaque",
    (_id, c) => {
      const wrong: string[] = [];
      let checked = 0;
      const check = (label: string, edge: unknown, followed: unknown, equal = false) => {
        checked++;
        const [e, f] = [colorOf(edge), colorOf(followed)];
        if (!e || !f) return wrong.push(`${label}: edge ${String(edge)}, follows ${String(followed)}`);
        if (e.alpha !== 1) wrong.push(`${label}: edge ${e.hex} at alpha ${e.alpha}`);
        const off = equal
          ? e.hex === f.hex
            ? undefined
            : `${e.hex} is not ${f.hex}`
          : notAShadeOf(e.hex, f.hex);
        if (off) wrong.push(`${label}: edge ${off}`);
      };
      const geometry = c.geometry!;
      const out = toned(c, c.tone!);
      const hue = toned(opaqueCase(c), c.tone!);
      const edge = geometry === "line" ? "casing" : "outline";
      // Features in the classes of a classification of the edge's color draw their class's color, not the Auto one.
      const classified = list(c.style.classify).filter((k) => k.target === `${edge}.color`);
      const autoDrawn = (properties: Record<string, unknown>) =>
        !classified.some((k) => (k.field as string) in properties);
      if (auto(c, `${edge}.color`))
        for (const properties of featuresOf(c).filter(autoDrawn))
          for (const zoom of ZOOMS) {
            const look = mapLook(out, properties, zoom, geometry);
            const followed = mapLook(hue, properties, zoom, geometry)[`${MAIN_PART[geometry]}.color`];
            if (!(`${edge}.color` in look) || followed === undefined) continue;
            check(
              `${JSON.stringify(properties)} at ${zoom}`,
              look[`${edge}.color`],
              followed,
              readFromData(c, properties)
            );
          }
      if (auto(c, "cluster.symbol.outline.color")) {
        const circles = layerOf(out, "cluster-marker")?.type === "circle";
        for (const n of CLUSTER_COUNTS) {
          const at = (compiled: CompiledLayer, key: string) =>
            layerValue(
              compiled,
              "1-cluster-marker",
              circles ? "paint" : "layout",
              key,
              { point_count: n },
              c.zoom
            );
          if (circles) check(`cluster of ${n}`, at(out, "circle-stroke-color"), at(hue, "circle-color"));
          else {
            const image = parseMarkerImage(at(out, "icon-image") as string)!;
            const plain = parseMarkerImage(at(hue, "icon-image") as string)!;
            check(`cluster of ${n}`, image.stroke, plain.fill);
          }
        }
      }
      if (auto(c, "h3.outline.color"))
        for (const value of H3_VALUES)
          check(
            `hexagon of ${value}`,
            layerValue(out, "1-h3-outline", "paint", "line-color", { value }, c.zoom),
            layerValue(hue, "1-h3-fill", "paint", "fill-color", { value }, c.zoom)
          );
      expect(checked).toBeGreaterThan(0);
      expect(wrong).toEqual([]);
    }
  );

  /** Where a label draws a halo: its width is above 0 and its color has some alpha. Each pair of text and halo the
   * map draws there, at every feature and zoom, with their contrast. */
  function labelPairs(
    out: CompiledLayer,
    layer: string,
    features: Array<Record<string, unknown>>,
    zooms: number[] = LABEL_ZOOMS
  ) {
    const pairs: Array<{ at: string; text: string; halo: string; contrast: number }> = [];
    const readers = Object.fromEntries(
      ["text-halo-width", "text-color", "text-halo-color"].map((key) => [
        key,
        layerReader(out, `1-${layer}`, "paint", key),
      ])
    );
    for (const properties of features)
      for (const zoom of zooms) {
        const read = (key: string) => readers[key](properties, zoom);
        const width = read("text-halo-width") as number;
        const [text, halo] = [colorOf(read("text-color")), colorOf(read("text-halo-color"))];
        if (!(width > 0) || !halo || halo.alpha === 0 || !text) continue;
        pairs.push({
          at: `${JSON.stringify(properties)} at ${zoom}`,
          text: text.hex,
          halo: halo.hex,
          contrast: contrastRatio(text.hex, halo.hex),
        });
      }
    return pairs;
  }

  // 2. An Auto text reads on the halo the map draws, an Auto halo behind its text, by at least 4.5 to 1.
  const labels = colors.filter((c) =>
    ["label.color", "label.halo.color", "cluster.symbol.label.color", "cluster.symbol.label.halo.color"].some(
      (k) => auto(c, k)
    )
  );
  it.each(labels.map((c) => [c.id, c] as const))(
    "%s: an Auto text and the halo the map draws, and an Auto halo and its text, contrast by at least 4.5 to 1",
    (_id, c) => {
      // A documented limit is about a label's text on its halo: a cluster's number keeps the floor.
      const limit = contrastLimit(c);
      let lowest = Infinity;
      for (const tone of TONES) {
        const out = toned(c, tone);
        // Every feature over the zooms, and features close together along each palette at the case's zoom.
        const labelPairsOf =
          auto(c, "label.color") || auto(c, "label.halo.color")
            ? [
                ...labelPairs(out, "label", featuresOf(c)),
                ...labelPairs(out, "label", paletteStops(c, 512), [c.zoom]),
              ]
            : [];
        const numberPairs =
          auto(c, "cluster.symbol.label.color") || auto(c, "cluster.symbol.label.halo.color")
            ? labelPairs(
                out,
                "cluster-label",
                CLUSTER_COUNTS.map((n) => ({ point_count: n }))
              )
            : [];
        for (const pair of labelPairsOf) lowest = Math.min(lowest, pair.contrast);
        // A label with a halo of its own draws one: there is a pair to read (a None halo or a number without a halo
        // of its own draws none).
        if (c.values!.label_colors !== "none" && (auto(c, "label.halo.color") || auto(c, "label.color")))
          expect(labelPairsOf.length, tone).toBeGreaterThan(0);
        const below = (pairs: typeof labelPairsOf, floor: number) =>
          pairs.filter((p) => p.contrast < floor - 1e-9);
        expect(
          [...below(labelPairsOf, limit?.floor ?? 4.5), ...below(numberPairs, 4.5)],
          `${tone}${limit ? `: ${limit.reason}` : ""}`
        ).toEqual([]);
      }
      // A documented limit holds only where the contrast does dip below the floor.
      if (limit) expect(lowest, limit.reason).toBeLessThan(4.5);
    }
  );

  it("documents each limit of the contrast floor by the cases it holds for", () => {
    for (const limit of CONTRAST_LIMITS) {
      const held = labels.filter((c) => limit.when(c));
      expect(held.length, limit.reason).toBeGreaterThan(0);
      expect(held.length, limit.reason).toBeLessThanOrEqual(4);
    }
  });

  // 3. An Auto icon color and number: white or GOAT's dark text on the color underneath, reading on it, white over the
  // darker colors underneath and dark over the lighter ones (one switch at most), white for a color read from the data.
  const onColors = colors.filter((c) =>
    ["marker.icon_color", "cluster.symbol.marker.icon_color", "cluster.symbol.label.color"].some((k) =>
      auto(c, k)
    )
  );
  it.each(onColors.map((c) => [c.id, c] as const))(
    "%s: an Auto icon color and a cluster's number are white or dark, read on the color underneath",
    (_id, c) => {
      const wrong: string[] = [];
      const out = toned(c, c.tone!);
      const symbol = symbolOf(c);
      const main = isObject(symbol.marker) ? symbol.marker.color : undefined;
      // The zooms where the marker's color is that of a stop (a color by zoom), else the case's.
      const zooms =
        isObject(main) && Array.isArray(main.zoom)
          ? (main.zoom as Array<[number]>).map(([z]) => z)
          : [c.zoom];
      // Each answer with the color underneath, by what it stands on (a marker's icon, a cluster's icon or number).
      const answers: Record<string, Array<{ label: string; drawn: string; under: string }>> = {};
      let checked = 0;
      let onHalo = 0;
      const check = (group: string, label: string, drawn: unknown, under: unknown, data = false) => {
        checked++;
        const [d, u] = [colorOf(drawn), colorOf(under)];
        if (!d) return wrong.push(`${label}: no color (${String(drawn)})`);
        if (!ON_COLORS.includes(d.hex)) return wrong.push(`${label}: ${d.hex} is not white or dark`);
        if (data) {
          if (d.hex !== WHITE) wrong.push(`${label}: ${d.hex} over a color read from the data, not white`);
          return;
        }
        if (!u) return;
        if (contrastRatio(d.hex, u.hex) < ON_COLOR_CONTRAST)
          wrong.push(
            `${label}: ${d.hex} on ${u.hex} reads at ${contrastRatio(d.hex, u.hex).toFixed(2)} to 1`
          );
        (answers[group] ??= []).push({ label, drawn: d.hex, under: u.hex });
      };
      if (auto(c, "marker.icon_color") && layerOf(out, "marker")?.type === "symbol")
        for (const properties of featuresOf(c))
          for (const zoom of zooms) {
            const name = layerValue(out, "1-marker", "layout", "icon-image", properties, zoom) as string;
            const image = parseMarkerImage(name);
            if (!image) continue;
            check(
              "icon",
              `${JSON.stringify(properties)} at ${zoom}`,
              image.iconColor,
              image.fill,
              readFromData(c, properties)
            );
          }
      const clusterImage = layerOf(out, "cluster-marker")?.type === "symbol";
      // Clusters at the case's zoom and below it, where a halo by zoom may not be drawn.
      const clusters = CLUSTER_COUNTS.flatMap((n) => [6, 8, c.zoom].map((zoom) => [n, zoom] as const));
      for (const [n, zoom] of layerOf(out, "cluster-marker") ? clusters : []) {
        const at = (group: "paint" | "layout", layer: string, key: string) =>
          layerValue(out, `1-${layer}`, group, key, { point_count: n }, zoom);
        const image = clusterImage
          ? parseMarkerImage(at("layout", "cluster-marker", "icon-image") as string)
          : null;
        const under = image ? image.fill : at("paint", "cluster-marker", "circle-color");
        if (auto(c, "cluster.symbol.marker.icon_color") && image)
          check("cluster icon", `cluster icon of ${n} at ${zoom}`, image.iconColor, under);
        // A number on a halo of its own is read on the halo (checked with the labels).
        if (auto(c, "cluster.symbol.label.color") && layerOf(out, "cluster-label")) {
          const width = at("paint", "cluster-label", "text-halo-width") as number;
          const halo = colorOf(at("paint", "cluster-label", "text-halo-color"));
          if (width > 0 && halo && halo.alpha > 0) {
            onHalo++;
            continue;
          }
          check("number", `number of ${n} at ${zoom}`, at("paint", "cluster-label", "text-color"), under);
        }
      }
      // Ordered from the darkest color underneath to the lightest: white first, then dark, switching once at most.
      for (const [group, list] of Object.entries(answers)) {
        const ordered = [...list].sort(
          (a, b) => contrastRatio(a.under, "#000000") - contrastRatio(b.under, "#000000")
        );
        const switches = ordered.slice(1).filter((a, i) => a.drawn !== ordered[i].drawn);
        if (switches.length > 1 || (switches.length === 1 && ordered[0].drawn !== WHITE))
          wrong.push(
            `${group}: ${ordered.map((a) => `${a.drawn} on ${a.under}`).join(", ")} does not switch once from white to dark`
          );
      }
      expect(checked + onHalo).toBeGreaterThan(0);
      expect(wrong).toEqual([]);
    }
  );

  // 4. No missing or invalid color, and MapLibre's validator accepts the layers on both tones.
  const COLOR_WORDS = /"(auto|fill)"/;
  it.each(colors.map((c) => [c.id, c] as const))(
    "%s: every color of the compiled layers is a valid color on both tones, and MapLibre accepts the layers",
    (_id, c) => {
      for (const tone of TONES) {
        const out = toned(c, tone);
        expect(maplibreErrors(out.layers, out.sources, out.state), tone).toEqual([]);
        const wrong: string[] = [];
        for (const layer of out.layers as Array<{ id: string; type: string } & Record<string, unknown>>)
          for (const group of ["paint", "layout"] as const) {
            const values = (layer[group] ?? {}) as Record<string, unknown>;
            for (const key of Object.keys(values)) {
              const isColor = key.endsWith("-color");
              if (!isColor && key !== "icon-image") continue;
              if (isColor && COLOR_WORDS.test(JSON.stringify(values[key])))
                wrong.push(`${layer.id} ${key} holds a word for a color`);
              const points = layer.id.includes("cluster")
                ? CLUSTER_COUNTS.map((n) => ({ point_count: n }))
                : layer.id.includes("h3")
                  ? H3_VALUES.map((value) => ({ value }))
                  : featuresOf(c);
              for (const properties of points)
                for (const zoom of [6, c.zoom, 12.5, 16]) {
                  const value = layerValue(out, layer.id, group, key, properties, zoom);
                  if (isColor) {
                    if (!(value instanceof Color))
                      wrong.push(`${layer.id} ${key} at ${zoom}: ${String(value)}`);
                    continue;
                  }
                  const image = String(value).startsWith("goat-marker:")
                    ? parseMarkerImage(String(value))
                    : null;
                  for (const color of image ? [image.fill, image.stroke, image.iconColor] : [])
                    if (color !== "" && !Color.parse(color))
                      wrong.push(`${layer.id} image ${String(value)} at ${zoom}: ${color}`);
                }
            }
          }
        expect(wrong, tone).toEqual([]);
      }
    }
  );

  // 5. A part whose fixed color is None draws nothing of its own; the document keeps the hue.
  const nones = colors.filter((c) => c.values?.none && c.values.none !== "no" && c.values.none !== "class");
  it.each(nones.map((c) => [c.id, c] as const))(
    "%s: a part whose color is None draws nothing of its own",
    (_id, c) => {
      const part = c.values!.none;
      const geometry = c.geometry!;
      const color = (symbolOf(c)[part] as JsonObject).color;
      // (The stored style holds the None color with its hue: what the Auto edge follows, checked above.)
      expect(color).toMatch(/^#[0-9a-f]{6}00$/i);
      const out = toned(c, c.tone!);
      // The base look draws no such part.
      const look = mapLook(out, {}, c.zoom, geometry);
      const drawn = look[`${part}.color`];
      const width = look[`${part}.width`];
      expect(
        drawn === undefined || width === 0 || !colorOf(drawn) || colorOf(drawn)!.alpha === 0,
        `${part}: ${String(drawn)} at ${String(width)}`
      ).toBe(true);
      // Where no class or rule sets that color, the part has no layer of its own.
      const setElsewhere = JSON.stringify([c.style.classify, c.style.rules]).includes(`"${part}":{"color"`);
      if (setElsewhere) return;
      if (part === "fill") expect(layerOf(out, "fill")).toBeUndefined();
      if (part === "line") expect(layerOf(out, "line")).toBeUndefined();
      if (part === "outline" && geometry === "polygon") {
        expect(layerOf(out, "outline")).toBeUndefined();
        // With the highlight on, only the highlight's edge, at opacity 0 for features that are not active.
        const lit = toned(c, c.tone!, { highlight: true });
        expect(layerValue(lit, "1-outline", "paint", "line-color", {}, c.zoom)).toEqual(
          Color.parse(HIGHLIGHT.color)
        );
        expect(layerValue(lit, "1-outline", "paint", "line-opacity", {}, c.zoom)).toBe(0);
      }
      if (part === "outline" && geometry === "point") {
        const marker = layerOf(out, "marker");
        if (marker?.type === "circle")
          expect(layerValue(out, "1-marker", "paint", "circle-stroke-width", {}, c.zoom)).toBe(0);
        if (marker?.type === "symbol") {
          const name = layerValue(out, "1-marker", "layout", "icon-image", {}, c.zoom) as string;
          expect(parseMarkerImage(name)!.strokeWidth).toBe(0);
        }
      }
      if (part === "marker") {
        // The marker's layer stays only for what else of it shows: an outline or an icon.
        const shows =
          isObject(symbolOf(c).outline) || typeof (symbolOf(c).marker as JsonObject).icon === "string";
        if (!shows) expect(layerOf(out, "marker") ?? layerOf(out, "icon")).toBeUndefined();
      }
    }
  );

  // 5, for one class: a class that sets its own main color None draws none of it; the other classes draw theirs.
  const classNones = colors.filter((c) => c.values?.none === "class");
  it.each(classNones.map((c) => [c.id, c] as const))(
    "%s: a class whose own color is None draws no such part, the other classes draw theirs",
    (_id, c) => {
      const geometry = c.geometry!;
      const part = MAIN_PART[geometry];
      const [own] = list(c.style.classify);
      const classes = list(own.classes);
      const out = toned(c, c.tone!);
      const block = entriesOf(legendOf(c)!.sections).find((s) => s.id === "first");
      let nones = 0;
      const wrong: string[] = [];
      for (const entry of block?.entries ?? []) {
        if (entry.extra) continue;
        const record = classes.find((k, i) => (typeof k.id === "string" ? k.id : String(i)) === entry.id);
        const properties = sampleFor(own, entry, c.fields[own.field as string]);
        if (!record || !properties) continue;
        const none = isNone((record[part] as JsonObject | undefined)?.color);
        nones += none ? 1 : 0;
        const color = colorOf(mapLook(out, properties, c.zoom, geometry)[`${part}.color`]);
        if ((color === undefined || color.alpha === 0) !== none)
          wrong.push(`${entry.id} ${part}: ${color?.hex} at ${color?.alpha}, None: ${none}`);
      }
      expect(nones).toBe(1);
      if (known("map", c)) expect(wrong, known("map", c)!.reason).not.toEqual([]);
      else expect(wrong).toEqual([]);
    }
  );

  // 6. Without the new values nothing depends on the basemap's tone.
  const plain = legendCases().filter(
    (c) =>
      c.values &&
      (c.tone === undefined ||
        (Object.entries(c.values).every(([k, v]) => !k.startsWith("auto:") || v === "no") &&
          c.values.none === "no" &&
          c.values.alpha === "no" &&
          c.values.label_colors !== "none"))
  );
  it("compiles the cases without the new values alike on a light and a dark basemap", () => {
    expect(plain.filter((c) => c.tone !== undefined).length).toBeGreaterThan(0);
    for (const c of plain) expect(toned(c, "dark"), c.id).toEqual(toned(c, "light"));
  });

  // The review's cases.
  const named = (id: string) => colors.find((c) => c.id === id)!;

  it("a class that sets its own fill to None: its Auto outline keeps the class's hue, its legend swatch is an outline, the other classes are untouched", () => {
    const c = named("focus-class-none");
    const classes = list(list(c.style.classify)[0].classes);
    const none = classes.findIndex((k) => isNone((k.fill as JsonObject).color));
    expect(none).toBeGreaterThanOrEqual(0);
    // The same style with that class's fill at its hue, opaque.
    const shown = opaqueCase(c);
    const sample = (k: JsonObject) => ({ category: (k.values as string[])[0] });
    for (const tone of TONES) {
      const [out, plain] = [toned(c, tone), toned(shown, tone)];
      classes.forEach((k, i) => {
        const [look, base] = [
          mapLook(out, sample(k), c.zoom, "polygon"),
          mapLook(plain, sample(k), c.zoom, "polygon"),
        ];
        if (i === none) {
          // No fill drawn, the outline of the class's hue as it is with the fill shown.
          expect(colorOf(look["fill.color"])?.alpha ?? 0, tone).toBe(0);
          expect(look["outline.color"], tone).toEqual(base["outline.color"]);
          expect(
            darker(colorOf(look["outline.color"])!.hex, (k.fill as JsonObject).color!.toString().slice(0, 7))
          ).toBe(true);
        } else expect(look, `${tone} class ${i}`).toEqual(base);
      });
    }
    const block = entriesOf(legendOf(c)!.sections).find((x) => x.id === "first")!;
    block.entries.forEach((entry, i) => {
      const fill = entry.swatch.fill;
      if (i === none) {
        expect(fill === undefined || isNone(fill.color)).toBe(true);
        expect(entry.swatch.outline?.color).toMatch(/^#[0-9a-f]{6}$/i);
      } else expect(isNone(fill?.color)).toBe(false);
    });
  });

  it("a fill read from a field as hex text with an Auto outline and an Auto label draws the documented fallbacks, never an empty color", () => {
    const c = named("focus-data-color");
    const features = [{ color_hex: "#e6ab02" }, { color_hex: "not a color" }, { color_hex: null }, {}];
    for (const tone of TONES) {
      const out = toned(c, tone);
      const fill = layerReader(out, "1-fill", "paint", "fill-color");
      const outline = layerReader(out, "1-outline", "paint", "line-color");
      const text = layerReader(out, "1-label", "paint", "text-color");
      const halo = layerReader(out, "1-label", "paint", "text-halo-color");
      for (const properties of features) {
        const at = `${tone} ${JSON.stringify(properties)}`;
        const [f, o] = [colorOf(fill(properties, c.zoom)), colorOf(outline(properties, c.zoom))];
        expect(f && o, at).toBeTruthy();
        // The data's color stands; where the data holds none, the shade of the read's fallback.
        if (properties.color_hex === "#e6ab02") expect(o!.hex, at).toBe("#e6ab02");
        else expect(darker(o!.hex, f!.hex), at).toBe(true);
        // Every feature's label: the neutral pair of the basemap's tone.
        expect([colorOf(text(properties, c.zoom))?.hex, colorOf(halo(properties, c.zoom))?.hex], at).toEqual([
          LABEL_FALLBACK[tone].text,
          LABEL_FALLBACK[tone].halo,
        ]);
      }
      // Features without a valid color share one outline.
      expect(outline({ color_hex: "not a color" }, c.zoom)).toEqual(outline({}, c.zoom));
    }
  });
});
