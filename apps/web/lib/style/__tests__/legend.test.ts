import { describe, expect, it } from "vitest";

import {
  LEGEND_NEUTRAL,
  type LegendSection,
  type Swatch,
  baseSwatch,
  buildLegend,
  classOf,
  informative,
  rangeText,
  valuesText,
} from "@/lib/style/legend";

import { goldenPairs } from "./fixtures";

const WORDS = { under: "under", to: "to", andMore: "and more" };

describe("H3 legends", () => {
  const STAMP = { at: "2026-10-26T00:00:00Z", data: "ducklake:1", scope: "dataset" };
  const h3 = (render: object) => ({ version: 1, kind: "vector", render: { type: "h3", ...render } });

  it("classes of the resolution the zoom draws, as ranges of the cell value", () => {
    const doc = h3({
      value: { op: "sum", field: "pupils" },
      palette: ["#000001", "#000002", "#000003"],
      classify: { method: "quantile", count: 3 },
      computed: {
        ...STAMP,
        resolutions: { "7": { min: 1, max: 9, breaks: [3, 6] }, "8": { min: 1, max: 4, breaks: [2, 3] } },
      },
    });
    const at10 = buildLegend(doc, { geometry: "point", zoom: 10 })!.sections;
    expect(at10).toHaveLength(1);
    const section = at10[0];
    expect(section.kind === "entries" && section.field).toBe("pupils");
    if (section.kind !== "entries") return;
    expect(section.entries.map((e) => [e.range, e.swatch.fill?.color])).toEqual([
      [{ to: 3 }, "#000001"],
      [{ from: 3, to: 6 }, "#000002"],
      [{ from: 6 }, "#000003"],
    ]);
    const at11 = buildLegend(doc, { geometry: "point", zoom: 11 })!.sections[0];
    expect(at11.kind === "entries" && at11.entries[0].range).toEqual({ to: 2 });
    // The cell values' minimum and maximum at that resolution label the open ends.
    expect(section.domain).toEqual([1, 9]);
    expect(at11.kind === "entries" && at11.domain).toEqual([1, 4]);
  });

  it("manual classes have no data ends", () => {
    const doc = h3({
      classify: { method: "manual", classes: [{ to: 10 }, { from: 10 }] },
    });
    const [section] = buildLegend(doc, { geometry: "point", zoom: 10 })!.sections;
    expect(section.kind === "entries" && section.domain).toBeUndefined();
  });

  it("continuous colors are a ramp over the cell values; counts have no field", () => {
    const doc = h3({
      resolution: 8,
      palette: ["#000001", "#000002"],
      computed: { ...STAMP, resolutions: { "8": { min: 2, max: 40 } } },
    });
    expect(buildLegend(doc, { geometry: "point", zoom: 3 })!.sections).toEqual([
      { kind: "ramp", id: "h3", colors: ["#000001", "#000002"], domain: [2, 40] },
    ]);
  });
});

describe("legend", () => {
  it("one section per classification, one entry per class with its range and swatch", () => {
    const legend = buildLegend(goldenPairs()[1].doc, { geometry: "polygon", zoom: 12 });
    expect(legend?.sections).toHaveLength(1);
    const section = legend!.sections[0];
    expect(section.kind).toBe("entries");
    // No title in the document: the legend shows the field's display name, which the app knows.
    expect(section.title).toBeUndefined();
    expect(section.kind === "entries" && section.field).toBe("density");
    if (section.kind !== "entries") return;
    expect(section.entries.map((e) => e.range)).toEqual([
      { to: 2800 },
      { from: 2800, to: 3600 },
      { from: 3600, to: 4300 },
      { from: 4300, to: 6300 },
      { from: 6300 },
    ]);
    expect(section.entries.map((e) => e.swatch.fill?.color)).toEqual([
      "#fef0d9",
      "#fdcc8a",
      "#fc8d59",
      "#e34a33",
      "#b30000",
    ]);
    expect(section.entries[0].swatch).toEqual({
      geometry: "polygon",
      fill: { color: "#fef0d9", opacity: 0.8, pattern: "none" },
      outline: { color: "#ffffff", width: 1, opacity: 1, dash: "solid" },
    });
  });

  it("classifications of one field with the same classes are one list, each class with all it sets", () => {
    const legend = buildLegend(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { shape: "icon", icon: "goat:park", color: "#000000" } },
        classify: [
          {
            id: "colors",
            field: "kind",
            method: "categories",
            classes: [
              { id: "c1", values: ["cafe"], marker: { color: "#ff0000" } },
              { id: "c2", values: ["bar"], marker: { color: "#00ff00" } },
            ],
          },
          {
            id: "icons",
            field: "kind",
            method: "categories",
            target: "marker.icon",
            classes: [
              { id: "c1", values: ["cafe"], marker: { icon: "goat:cafe" } },
              { id: "c2", values: ["bar"], marker: { icon: "goat:bar" } },
            ],
            other: { marker: { icon: "goat:marker" } },
          },
          {
            id: "sizes",
            field: "kind",
            method: "categories",
            target: "marker.size",
            classes: [{ id: "c1", values: ["school"], marker: { size: 30 } }],
          },
        ],
      },
      { geometry: "point", zoom: 12 }
    );
    const sections = legend?.sections ?? [];
    expect(sections.map((section) => section.id)).toEqual(["colors", "sizes"]);
    const merged = sections[0];
    expect(
      merged.kind === "entries" &&
        merged.entries.map((e) => [e.id, e.swatch.marker?.icon, e.swatch.marker?.color])
    ).toEqual([
      ["c1", "goat:cafe", "#ff0000"],
      ["c2", "goat:bar", "#00ff00"],
      ["other", "goat:marker", "#000000"],
    ]);
  });

  it("a layer without classifications is one entry with its base look", () => {
    const legend = buildLegend(
      { version: 1, kind: "vector", symbol: { marker: { color: "#f28e2b", size: 8 } } },
      { geometry: "point", zoom: 12 }
    );
    expect(legend?.sections).toEqual([
      {
        kind: "entries",
        id: "base",
        entries: [
          {
            id: "base",
            swatch: {
              geometry: "point",
              marker: { shape: "circle", color: "#f28e2b", size: 8, opacity: 1, icon_color: "#ffffff" },
            },
          },
        ],
      },
    ]);
  });

  it("hollow markers carry fill: false and their icon takes the marker color; a class may be hollow on its own", () => {
    const legend = buildLegend(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { shape: "pin", color: "#f28e2b", icon: "goat:park" }, outline: { color: "fill" } },
        classify: [
          {
            id: "k",
            field: "kind",
            method: "categories",
            classes: [
              { id: "a", values: ["a"], marker: { fill: false } },
              { id: "b", values: ["b"], marker: { color: "#1a6b4d" } },
            ],
          },
        ],
      },
      { geometry: "point", zoom: 12 }
    );
    const entries = (legend?.sections[0] as { entries: Array<{ id: string; swatch: Swatch }> }).entries;
    const marker = (id: string) => entries.find((e) => e.id === id)?.swatch.marker;
    expect(marker("a")).toMatchObject({ fill: false, color: "#f28e2b", icon_color: "#f28e2b" });
    expect(marker("b")).not.toHaveProperty("fill");
    expect(marker("b")?.icon_color).toBe("#ffffff");
    const set = buildLegend(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { color: "#f28e2b", fill: false, icon: "goat:park", icon_color: "#3a3541" } },
      },
      { geometry: "point", zoom: 12 }
    );
    const base = (set?.sections[0] as { entries: Array<{ swatch: Swatch }> }).entries[0].swatch.marker;
    expect(base).toMatchObject({ fill: false, icon_color: "#3a3541" });
  });

  it("categories with other and no data, classes left out, named rules, values by zoom at the given zoom", () => {
    const legend = buildLegend(
      {
        version: 1,
        kind: "vector",
        symbol: {
          line: {
            color: "#2166ac",
            width: {
              zoom: [
                [10, 2],
                [14, 6],
              ],
            },
          },
        },
        classify: [
          {
            id: "s",
            field: "status",
            method: "categories",
            classes: [
              { id: "a", values: ["existing"], name: "Existing" },
              { id: "b", values: ["planned"], line: { dash: "dashed" } },
              { id: "c", values: ["x"], legend: false },
            ],
            other: { name: "Other", line: { color: "#999999" } },
            no_data: { line: { opacity: 0.3 } },
          },
        ],
        rules: [
          {
            id: "r",
            name: "One-way",
            when: { op: "=", args: [{ property: "oneway" }, true] },
            line: { color: "#000000" },
          },
        ],
      },
      { geometry: "line", zoom: 12 }
    );
    const [classes, rules] = legend!.sections;
    if (classes.kind !== "entries" || rules.kind !== "entries") throw new Error("entries expected");
    expect(classes.entries.map((e) => [e.id, e.name, e.values])).toEqual([
      ["a", "Existing", ["existing"]],
      ["b", undefined, ["planned"]],
      ["other", "Other", undefined],
      ["no_data", undefined, undefined],
    ]);
    expect(classes.entries[1].swatch.line).toEqual({
      color: "#2166ac",
      width: 4,
      opacity: 1,
      dash: "dashed",
    });
    expect(classes.entries[3].swatch.line?.opacity).toBe(0.3);
    expect(rules.entries.map((e) => [e.id, e.name, e.swatch.line?.color])).toEqual([
      ["r", "One-way", "#000000"],
    ]);
  });

  it("ramps for palettes by attribute and size samples for ranges", () => {
    const legend = buildLegend(
      {
        version: 1,
        kind: "vector",
        symbol: {
          marker: {
            color: { field: "d", palette: ["#ffffff", "#000000"], domain: [0, 100] },
            size: { field: "p", range: [4, 20], domain: [0, 1000] },
          },
        },
      },
      { geometry: "point", zoom: 12 }
    );
    expect(legend?.sections.map((s) => s.kind)).toEqual(["ramp", "sizes"]);
    expect(legend?.sections[0]).toMatchObject({
      kind: "ramp",
      colors: ["#ffffff", "#000000"],
      domain: [0, 100],
    });
    const sizes = legend?.sections[1];
    if (sizes?.kind !== "sizes") throw new Error("sizes expected");
    expect(sizes.samples.map((s) => [s.value, s.swatch.marker?.size])).toEqual([
      [0, 4],
      [500, 12],
      [1000, 20],
    ]);
  });

  it("size samples follow the scale (spec 5.8)", () => {
    const legend = buildLegend(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { size: { field: "pupils", range: [0, 24], scale: "sqrt", domain: [0, 1500] } } },
      },
      { geometry: "point", zoom: 12 }
    );
    const sizes = legend?.sections[0];
    if (sizes?.kind !== "sizes") throw new Error("sizes expected");
    expect(sizes.samples.map((s) => s.value)).toEqual([0, 750, 1500]);
    expect(sizes.samples.map((s) => s.swatch.marker?.size)).toEqual([0, 17, 24]);
  });

  it("is null when hidden", () => {
    expect(
      buildLegend({ version: 1, kind: "vector", legend: false }, { geometry: "point", zoom: 12 })
    ).toBeNull();
    expect(
      buildLegend({ version: 1, kind: "vector", legend: { show: false } }, { geometry: "point", zoom: 12 })
    ).toBeNull();
  });
});

describe("legend of a color by attribute on a scale", () => {
  const ramp = (scale?: string) =>
    buildLegend(
      {
        version: 1,
        kind: "vector",
        symbol: {
          fill: {
            color: { field: "d", palette: "goat:green", domain: [1, 100], ...(scale ? { scale } : {}) },
          },
        },
      },
      { geometry: "polygon", zoom: 12 }
    )!.sections[0] as { kind: string; middle?: number };

  it("names the value in the middle of the ramp when the scale is not linear", () => {
    expect(ramp().middle).toBeUndefined();
    expect(ramp("log").middle).toBe(10);
    expect(ramp("sqrt").middle).toBe(30.3);
  });
});

describe("legend of classes picked by hand", () => {
  it("leaves out a class that has no values yet", () => {
    const legend = buildLegend(
      {
        version: 1,
        kind: "vector",
        classify: [
          {
            id: "u",
            field: "use",
            method: "categories",
            classes: [
              { id: "c1", values: ["home"], fill: { color: "#d7301f" } },
              { id: "c2", values: [], fill: { color: "#fc8d62" } },
            ],
          },
        ],
      },
      { geometry: "polygon", zoom: 12 }
    )!;
    const section = legend.sections[0] as { entries: Array<{ id: string }> };
    expect(section.entries.map((e) => e.id)).toEqual(["c1"]);
  });
});

describe("legend blocks by property", () => {
  const STAMP = { at: "2026-10-26T00:00:00Z", data: "ducklake:1", scope: "dataset" };
  const SIZE = {
    id: "size",
    field: "share",
    method: "categories",
    count: 2,
    target: "marker.size",
    classes: [
      { id: "s1", values: [100], marker: { size: 12 } },
      { id: "s2", values: [50], marker: { size: 6 } },
    ],
  };
  const COLOR = {
    id: "color",
    field: "share",
    method: "quantile",
    count: 2,
    classes: [
      { id: "c1", to: 9.52, marker: { color: "#e5f5e0" } },
      { id: "c2", from: 9.52, marker: { color: "#31a354" } },
    ],
    no_data: { marker: { color: "#cccccc" } },
    computed: { ...STAMP, domain: [0.73, 100] },
  };
  const points = (classify: object[]) =>
    buildLegend(
      { version: 1, kind: "vector", symbol: { marker: { color: "#e01903", size: 8 } }, classify },
      { geometry: "point", zoom: 12 }
    )!.sections as Array<Extract<LegendSection, { kind: "entries" }>>;

  it("with more than one block, each names the property it sets", () => {
    const [size, color] = points([SIZE, COLOR]);
    expect(size.properties).toEqual(["style_editor.size"]);
    expect(color.properties).toEqual(["style_editor.color"]);
    expect(size.field).toBe("share");
  });

  it("a single block names only its field", () => {
    const [size] = points([SIZE]);
    expect(size.properties).toBeUndefined();
    expect(size.field).toBe("share");
  });

  it("a property off the main part names its part", () => {
    const [, width] = points([COLOR, { ...SIZE, id: "w", target: "outline.width", classes: [] }]);
    expect(width.properties).toEqual(["style_editor.prop_outline_width"]);
  });

  it("a block that sets no color draws its symbols in neutral grey, a class's own color stays", () => {
    for (const sections of [points([SIZE]), points([SIZE, COLOR])]) {
      expect(sections[0].entries.map((e) => [e.swatch.marker?.color, e.swatch.marker?.size])).toEqual([
        [LEGEND_NEUTRAL, 12],
        [LEGEND_NEUTRAL, 6],
      ]);
    }
    const own = { ...SIZE, classes: [{ ...SIZE.classes[0], marker: { size: 12, color: "#123456" } }] };
    expect(points([own])[0].entries[0].swatch.marker?.color).toBe("#123456");
    const [, color] = points([SIZE, COLOR]);
    expect(color.entries.map((e) => e.swatch.marker?.color)).toEqual(["#e5f5e0", "#31a354", "#cccccc"]);
  });

  it("Other and No data entries say which they are", () => {
    const [color] = points([{ ...COLOR, other: { marker: { color: "#999999" } } }]);
    expect(color.entries.slice(-2).map((e) => [e.id, e.extra])).toEqual([
      ["other", "other"],
      ["no_data", "no_data"],
    ]);
  });
});

describe("legend data ends", () => {
  const STAMP = { at: "2026-10-26T00:00:00Z", data: "ducklake:1", scope: "dataset" };
  const classified = (c: object) =>
    buildLegend(
      { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } }, classify: [c] },
      { geometry: "polygon", zoom: 12 }
    )!.sections[0];

  it("numeric classes carry the data's minimum and maximum the server computed", () => {
    const section = classified({
      field: "density",
      method: "quantile",
      count: 2,
      classes: [{ to: 9.52 }, { from: 9.52 }],
      computed: { ...STAMP, domain: [0.73, 100] },
    });
    expect(section.kind === "entries" && section.domain).toEqual([0.73, 100]);
  });

  it("without computed ends, for categories, or with a malformed domain there are none", () => {
    const none = [
      classified({ field: "density", method: "manual", classes: [{ to: 5 }, { from: 5 }] }),
      classified({
        field: "kind",
        method: "categories",
        classes: [{ values: ["a"] }],
        computed: { ...STAMP, domain: [0, 1] },
      }),
      classified({
        field: "density",
        method: "quantile",
        classes: [{ to: 5 }, { from: 5 }],
        computed: { ...STAMP, domain: [9, 1] },
      }),
    ];
    expect(none.map((section) => section.kind === "entries" && section.domain)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("rangeText", () => {
  it("open ends read the data's minimum and maximum when they are known", () => {
    const opts = { locale: "en-US", words: WORDS, domain: [0.73, 100] as [number, number] };
    expect(rangeText({ to: 9.52 }, opts)).toBe("0.73 to 9.52");
    expect(rangeText({ from: 9.52, to: 14.81 }, opts)).toBe("9.52 to 14.81");
    expect(rangeText({ from: 33.85 }, opts)).toBe("33.85 to 100");
    expect(rangeText({ from: 6300 }, { ...opts, domain: [1000, 9000], unit: "inhabitants" })).toBe(
      "6,300 to 9,000 inhabitants"
    );
  });

  it("an end that would read the same as the class's bound, or lies past it, stays open", () => {
    const opts = { locale: "en-US", words: WORDS, format: { decimals: 2 } };
    expect(rangeText({ to: 0.731 }, { ...opts, domain: [0.73, 100] })).toBe("under 0.73");
    expect(rangeText({ from: 99.996 }, { ...opts, domain: [0.73, 100] })).toBe("100.00 and more");
    expect(rangeText({ to: 5 }, { ...opts, domain: [7, 100] })).toBe("under 5.00");
    expect(rangeText({ from: 120 }, { ...opts, domain: [7, 100] })).toBe("120.00 and more");
  });

  it("a single class reads the data's range, or its one value", () => {
    const opts = { locale: "en-US", words: WORDS };
    expect(rangeText({}, { ...opts, domain: [1, 9] })).toBe("1 to 9");
    expect(rangeText({}, { ...opts, domain: [4.5, 4.5] })).toBe("4.5");
    expect(rangeText({}, opts)).toBe("");
  });

  it("formats ranges with the locale, the format and the unit", () => {
    expect(rangeText({ from: 2800, to: 3600 }, { locale: "en-US", words: WORDS })).toBe("2,800 to 3,600");
    expect(rangeText({ to: 2800 }, { locale: "en-US", words: WORDS })).toBe("under 2,800");
    expect(rangeText({ from: 6300 }, { locale: "en-US", words: WORDS, unit: "inhabitants" })).toBe(
      "6,300 and more inhabitants"
    );
    expect(
      rangeText(
        { from: 1.25, to: 2.5 },
        { locale: "de-DE", words: { ...WORDS, to: "bis" }, format: { decimals: 1 } }
      )
    ).toBe("1,3 bis 2,5");
  });
});

describe("classes hidden with the eye", () => {
  const doc = (classify: object[]) =>
    buildLegend(
      { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } }, classify },
      {
        geometry: "polygon",
        zoom: 12,
      }
    )!;
  const ids = (legend: ReturnType<typeof doc>) =>
    legend.sections.map((s) => (s.kind === "entries" ? [s.id, s.entries.map((e) => e.id)] : [s.id]));

  it("a hidden class, Other and No data draw nothing on the map and stay out of the legend", () => {
    const legend = doc([
      {
        id: "ranges",
        field: "density",
        method: "quantile",
        classes: [
          { id: "r1", to: 10, fill: { color: "#ff0000" } },
          { id: "r2", from: 10, to: 20, visible: false },
          { id: "r3", from: 20 },
        ],
        no_data: { fill: { color: "#eeeeee" }, visible: false },
      },
      {
        id: "cats",
        field: "use",
        method: "categories",
        target: "outline.color",
        classes: [
          { id: "a", values: ["housing"], visible: false },
          { id: "b", values: ["park"] },
        ],
        other: { visible: false },
        no_data: {},
      },
    ]);
    expect(ids(legend)).toEqual([
      ["ranges", ["r1", "r3"]],
      ["cats", ["b", "no_data"]],
    ]);
  });

  it("a classification whose entries are all hidden leaves no block", () => {
    const legend = doc([
      {
        id: "hidden",
        field: "use",
        method: "categories",
        classes: [{ id: "a", values: ["housing"], visible: false }],
        no_data: { visible: false },
      },
      {
        id: "shown",
        field: "density",
        method: "manual",
        classes: [
          { id: "r1", to: 10 },
          { id: "r2", from: 10 },
        ],
      },
    ]);
    expect(ids(legend)).toEqual([["shown", ["r1", "r2"]]]);
    // With one block left, it needs no property word to tell it apart.
    expect(legend.sections[0].kind === "entries" && legend.sections[0].properties).toBeFalsy();
  });

  it("a raster whose classes are all hidden has no legend", () => {
    const raster = buildLegend(
      {
        version: 1,
        kind: "raster",
        render: { type: "categorical", band: 1, classes: [{ value: 1, color: "#ff0000", visible: false }] },
      },
      { zoom: 10 }
    );
    expect(raster).toBeNull();
  });
});

describe("valuesText", () => {
  it("a category's values with the classification's unit, numbers with its format where one is set", () => {
    expect(valuesText([100], { locale: "en-US", unit: "pixels" })).toBe("100 pixels");
    expect(valuesText([16.67, 2020], { locale: "en-US" })).toBe("16.67, 2020");
    expect(valuesText([1.25, 2500], { locale: "de-DE", format: { decimals: 1 } })).toBe("1,3, 2.500,0");
    expect(valuesText(["residential", true], { locale: "en-US", unit: "ha" })).toBe("residential, true ha");
  });
});

describe("raster legends", () => {
  const raster = (render: object, legend?: object) =>
    buildLegend({ version: 1, kind: "raster", render, ...(legend ? { legend } : {}) }, { zoom: 10 });

  it("a palette over a range is a ramp with its unit and end labels", () => {
    expect(
      raster(
        { type: "continuous", palette: ["#000000", "#ffffff"], reverse: true, domain: [200, 450] },
        { unit: "m", min_label: "Low" }
      )
    ).toEqual({
      sections: [
        {
          kind: "ramp",
          id: "raster",
          colors: ["#ffffff", "#000000"],
          domain: [200, 450],
          unit: "m",
          labels: ["Low", undefined],
        },
      ],
    });
  });

  it("a palette without a domain shows the computed domain, and no ramp until it is computed", () => {
    const computed = raster({
      type: "continuous",
      palette: ["#000000", "#ffffff"],
      computed: { at: "t", data: "url:x", domain: [181, 440] },
    });
    expect(computed?.sections[0]).toMatchObject({ kind: "ramp", domain: [181, 440] });
    expect(raster({ type: "continuous", palette: ["#000000", "#ffffff"] })).toBeNull();
  });

  it("own colors are a ramp over their stops", () => {
    const legend = raster({
      type: "continuous",
      stops: [
        { value: 0, color: "#000000" },
        { value: 9, color: "#ffffff" },
      ],
    });
    expect(legend?.sections[0]).toMatchObject({
      kind: "ramp",
      colors: ["#000000", "#ffffff"],
      domain: [0, 9],
    });
  });

  it("manual classes and categories list their visible classes with colors", () => {
    const classes = raster({
      type: "continuous",
      palette: "colorbrewer:BuGn",
      domain: [0, 30],
      classify: {
        method: "manual",
        classes: [{ to: 10 }, { from: 10, to: 20, visible: false }, { from: 20, name: "High" }],
      },
    });
    expect(classes?.sections[0]).toMatchObject({
      kind: "entries",
      entries: [
        { range: { to: 10 }, swatch: { geometry: "polygon", fill: { color: "#e5f5f9" } } },
        { name: "High", range: { from: 20 }, swatch: { fill: { color: "#2ca25f" } } },
      ],
    });
    const categories = raster({
      type: "categorical",
      classes: [
        { value: 1, name: "Water", color: "#4a90c2" },
        { value: 6, color: "#7a87c6", visible: false },
      ],
    });
    expect(categories?.sections[0]).toMatchObject({
      kind: "entries",
      entries: [{ name: "Water", values: [1], swatch: { fill: { color: "#4a90c2" } } }],
    });
  });

  it("an image or shading without colors has no legend; a map service shows its legend image", () => {
    expect(raster({ type: "image" })).toBeNull();
    expect(raster({ type: "terrain" })).toBeNull();
    expect(
      buildLegend(
        { version: 1, kind: "raster", render: { type: "image" } },
        { zoom: 10, serviceLegendUrl: "https://wms/l.png" }
      )
    ).toEqual({ sections: [{ kind: "image", id: "service", url: "https://wms/l.png" }] });
    expect(
      buildLegend(
        { version: 1, kind: "raster", legend: false },
        { zoom: 10, serviceLegendUrl: "https://wms/l.png" }
      )
    ).toBeNull();
  });
});

describe("classOf", () => {
  const STATUS = {
    version: 1,
    kind: "vector",
    symbol: { line: { color: "#2166ac", width: 2 } },
    classify: [
      {
        id: "s",
        field: "status",
        method: "categories",
        classes: [
          { id: "a", values: ["existing"] },
          { id: "b", values: ["planned"], line: { dash: "dashed" } },
        ],
        other: { line: { color: "#999999" } },
        no_data: { line: { opacity: 0.3 } },
      },
    ],
  };

  it("a popup header shows the clicked feature's class", () => {
    const doc = goldenPairs()[1].doc;
    const at = (density: unknown) => classOf(doc, { density }, { geometry: "polygon", zoom: 12 }).fill?.color;
    expect([at(100), at(2800), at(3000), at(6300), at(99999)]).toEqual([
      "#fef0d9",
      "#fdcc8a",
      "#fdcc8a",
      "#b30000",
      "#b30000",
    ]);
    const line = (status: unknown) => classOf(STATUS, { status }, { geometry: "line", zoom: 12 }).line;
    expect(line("planned")?.dash).toBe("dashed");
    expect(line("demolished")?.color).toBe("#999999");
    expect(line(null)?.opacity).toBe(0.3);
    expect(line(undefined)?.opacity).toBe(0.3);
  });

  it("without classifications the base look", () => {
    const doc = { version: 1, kind: "vector", symbol: { marker: { color: "#ff0000" } } };
    expect(classOf(doc, { any: 1 }, { geometry: "point", zoom: 10 })).toEqual(
      baseSwatch(doc, { geometry: "point", zoom: 10 })
    );
    expect(baseSwatch(doc, { geometry: "point", zoom: 10 }).marker?.color).toBe("#ff0000");
  });
});

describe("informative", () => {
  const legendOf = (doc: object, geometry?: "point" | "line" | "polygon") =>
    buildLegend(doc as never, { geometry, zoom: 12 });

  it("a legend that is only the base look says nothing a swatch does not", () => {
    expect(
      informative(legendOf({ version: 1, kind: "vector", symbol: { fill: { color: "#000000" } } }, "polygon"))
    ).toBe(false);
    expect(informative(null)).toBe(false);
  });

  it("classes, ramps and rasters are worth showing", () => {
    expect(informative(legendOf(goldenPairs()[1].doc, "polygon"))).toBe(true);
    expect(
      informative(
        legendOf(
          { version: 1, kind: "vector", render: { type: "heatmap", palette: ["#000000", "#ffffff"] } },
          "point"
        )
      )
    ).toBe(true);
    expect(
      informative(
        legendOf({
          version: 1,
          kind: "raster",
          render: { type: "continuous", palette: ["#000000", "#ffffff"], domain: [0, 1] },
        })
      )
    ).toBe(true);
  });
});
