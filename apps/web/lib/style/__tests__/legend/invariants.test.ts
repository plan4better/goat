// What holds for the legend of every case (spec 7.2): which entries it lists and in which order, that its texts
// and colors are real, and where each kind of section sits.
import { Color } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import { type JsonObject, isObject } from "@/lib/style/json";
import { type LegendSection, type Swatch, buildLegend, rangeText, valuesText } from "@/lib/style/legend";

import { type LegendCase, legendCases, pointsDrawn } from "./cases";
import { known } from "./known";
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
