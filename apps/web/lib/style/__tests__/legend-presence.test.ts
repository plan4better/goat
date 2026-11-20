// Which classes the legend lists (spec 7.2 `legend.classes`): the classes present under the filter or in the view,
// Other and No data among them, and the one function that says which class a value is in.
import { describe, expect, it } from "vitest";

import {
  PRESENCE_PENDING,
  type Presence,
  buildLegend,
  classIndexOf,
  classOf,
  informative,
  legendClasses,
} from "@/lib/style/legend";

const STAMP = { at: "2026-01-01T00:00:00Z", data: "synthetic:1", scope: "dataset" };

const KINDS = {
  version: "1.0.0",
  kind: "vector",
  symbol: { marker: { shape: "circle", color: "#9aa3ad", size: 8 } },
  classify: [
    {
      id: "kind",
      field: "kind",
      method: "categories",
      classes: [
        { id: "c1", values: ["alpha"], marker: { color: "#000001" } },
        { id: "c2", values: ["beta", "gamma"], marker: { color: "#000002" } },
        { id: "c3", values: ["delta"], marker: { color: "#000003" } },
      ],
      other: { marker: { color: "#000004" } },
      no_data: { marker: { color: "#000005" } },
      computed: { ...STAMP, other: true, no_data: true },
    },
  ],
};

// Numeric classes without ids: the legend and the counts key them by position.
const SIZES = {
  version: "1.0.0",
  kind: "vector",
  symbol: { fill: { color: "#cccccc" } },
  classify: [
    {
      field: "size",
      method: "manual",
      classes: [
        { to: 10, fill: { color: "#000001" } },
        { from: 10, to: 20, fill: { color: "#000002" } },
        { from: 20, fill: { color: "#000003" } },
      ],
      no_data: { fill: { color: "#000005" } },
      computed: { ...STAMP, other: false, no_data: true },
    },
  ],
};

const present = (classes: string[], other = false, no_data = false) => ({
  classes: new Set(classes),
  other,
  no_data,
});

const idsOf = (
  doc: object,
  ctx: { present?: Presence | typeof PRESENCE_PENDING } = {},
  geometry: "point" | "polygon" = "point"
) =>
  buildLegend(doc as never, { geometry, zoom: 12, ...ctx })!.sections.map((s) =>
    s.kind === "entries" ? s.entries.map((e) => e.id) : s.kind
  );

describe("buildLegend with the classes present", () => {
  it("without counts every class is listed, as before", () => {
    expect(idsOf(KINDS)).toEqual([["c1", "c2", "c3", "other", "no_data"]]);
  });

  it("categories: only the classes present, Other and No data among them", () => {
    expect(idsOf(KINDS, { present: { kind: present(["c1", "c3"], false, true) } })).toEqual([
      ["c1", "c3", "no_data"],
    ]);
    expect(idsOf(KINDS, { present: { kind: present(["c2"], true, false) } })).toEqual([["c2", "other"]]);
  });

  it("numeric classes: keyed by position where they have no ids", () => {
    expect(idsOf(SIZES, { present: { "0": present(["1", "2"]) } }, "polygon")).toEqual([["1", "2"]]);
    expect(idsOf(SIZES, { present: { "0": present(["0"], false, true) } }, "polygon")).toEqual([
      ["0", "no_data"],
    ]);
  });

  it("the data's own facts still hold: Other the data has none of stays out though counted", () => {
    expect(idsOf(SIZES, { present: { "0": present(["0"], true, false) } }, "polygon")).toEqual([["0"]]);
  });

  it("a classification whose classes are all gone leaves no block, and a legend the counts emptied says so", () => {
    const legend = buildLegend(KINDS as never, {
      geometry: "point",
      zoom: 12,
      present: { kind: present([]) },
    })!;
    // No swatch in the base look: no feature on the map has it.
    expect(legend.sections).toEqual([{ kind: "empty", id: "empty", classes: "filter" }]);
    expect(informative(legend)).toBe(true);
    const inView = { ...KINDS, legend: { classes: "view" } };
    expect(
      buildLegend(inView as never, { geometry: "point", zoom: 12, present: { kind: present([]) } })!.sections
    ).toEqual([{ kind: "empty", id: "empty", classes: "view" }]);
    const two = { ...KINDS, classify: [...KINDS.classify, { ...SIZES.classify[0], id: "size" }] };
    expect(
      buildLegend(two as never, {
        geometry: "point",
        zoom: 12,
        present: { kind: present([]), size: present(["2"]) },
      })!.sections.map((s) => s.id)
    ).toEqual(["size"]);
  });

  it("a legend whose classes were never counted keeps the base swatch", () => {
    const hidden = {
      ...KINDS,
      classify: [{ ...KINDS.classify[0], legend: false }],
    };
    for (const style of [hidden, { ...KINDS, legend: { classes: "all" } }]) {
      const legend = buildLegend(style as never, {
        geometry: "point",
        zoom: 12,
        present: { kind: present([]) },
      })!;
      expect(legend.sections.map((s) => s.id)).toEqual(style === hidden ? ["base"] : ["kind"]);
    }
    // Classes all hidden with the eye: the count removed nothing, the base look stays.
    const eyes = {
      ...KINDS,
      classify: [
        {
          ...KINDS.classify[0],
          classes: KINDS.classify[0].classes.map((k) => ({ ...k, visible: false })),
          other: { visible: false },
          no_data: { visible: false },
        },
      ],
    };
    expect(
      buildLegend(eyes as never, {
        geometry: "point",
        zoom: 12,
        present: { kind: present([]) },
      })!.sections.map((s) => s.id)
    ).toEqual(["base"]);
  });

  it("a classification without counts lists every class beside one with counts", () => {
    const two = { ...KINDS, classify: [...KINDS.classify, { ...SIZES.classify[0], id: "size" }] };
    expect(idsOf(two, { present: { size: present(["2"]) } })).toEqual([
      ["c1", "c2", "c3", "other", "no_data"],
      ["2"],
    ]);
  });

  it("classifications of one field with the same classes share the first one's counts", () => {
    const twin = {
      ...KINDS,
      classify: [
        KINDS.classify[0],
        { ...KINDS.classify[0], id: "kind_size", target: "marker.size", computed: undefined },
      ],
    };
    expect(idsOf(twin, { present: { kind: present(["c2"]) } })).toEqual([["c2"]]);
  });

  it("the block keeps the first one's class ids where the others' classes have ids of their own", () => {
    // The panel gives each class of each classification its own id.
    const sizes = KINDS.classify[0].classes.map((k, i) => ({
      ...k,
      id: `s${i + 1}`,
      marker: { size: 6 + i },
    }));
    const twin = {
      ...KINDS,
      classify: [
        KINDS.classify[0],
        { ...KINDS.classify[0], id: "kind_size", target: "marker.size", classes: sizes, computed: undefined },
      ],
    };
    expect(idsOf(twin)).toEqual([["c1", "c2", "c3", "other", "no_data"]]);
    expect(
      idsOf(twin, { present: { kind: present(["c2"]), kind_size: present(["s1", "s2", "s3"]) } })
    ).toEqual([["c2"]]);
  });

  it("`all` lists every class whatever the counts say", () => {
    const all = { ...KINDS, legend: { classes: "all" } };
    expect(idsOf(all, { present: { kind: present([]) } })).toEqual([["c1", "c2", "c3", "other", "no_data"]]);
  });

  it("while the counts are on their way a classification shows placeholder rows, never every class", () => {
    const legend = buildLegend(KINDS as never, { geometry: "point", zoom: 12, present: PRESENCE_PENDING })!;
    expect(legend.sections).toHaveLength(1);
    const [section] = legend.sections;
    expect(section.kind === "entries" && section.entries).toEqual([]);
    expect(section.kind === "entries" && section.pending).toBe(3);
  });

  it("a placeholder has as many rows as classes, at most three", () => {
    const one = { ...KINDS, classify: [{ ...KINDS.classify[0], classes: [KINDS.classify[0].classes[0]] }] };
    const doc = {
      ...one,
      classify: [{ ...one.classify[0], other: undefined, no_data: undefined, computed: STAMP }],
    };
    const [section] = buildLegend(doc as never, {
      geometry: "point",
      zoom: 12,
      present: PRESENCE_PENDING,
    })!.sections;
    expect(section.kind === "entries" && section.pending).toBe(1);
  });

  it("`all` never waits for counts", () => {
    const all = { ...KINDS, legend: { classes: "all" } };
    expect(idsOf(all, { present: PRESENCE_PENDING })).toEqual([["c1", "c2", "c3", "other", "no_data"]]);
  });

  it("ramps, size samples and rules do not change", () => {
    const doc = {
      version: "1.0.0",
      kind: "vector",
      symbol: { marker: { color: { field: "size", palette: ["#000000", "#ffffff"], domain: [0, 10] } } },
      classify: [KINDS.classify[0]],
      rules: [{ id: "r1", name: "Closed", when: { op: "=", args: [{ property: "open" }, false] } }],
    };
    expect(idsOf(doc, { present: { kind: present([]) } })).toEqual([["r1"], "ramp"]);
  });
});

describe("classIndexOf", () => {
  const categories = KINDS.classify[0];
  const numeric = SIZES.classify[0];

  it("categories match values as text; values in no class are Other, a missing value is No data", () => {
    expect(classIndexOf(categories, "alpha")).toBe(0);
    expect(classIndexOf(categories, "gamma")).toBe(1);
    expect(classIndexOf(categories, "omega")).toBe("other");
    expect(classIndexOf(categories, "")).toBe("other");
    expect(classIndexOf(categories, null)).toBe("no_data");
    expect(classIndexOf(categories, undefined)).toBe("no_data");
    const numbers = { method: "categories", classes: [{ values: [5] }, { values: ["true"] }] };
    expect(classIndexOf(numbers, "5")).toBe(0);
    expect(classIndexOf(numbers, 5)).toBe(0);
    expect(classIndexOf(numbers, true)).toBe(1);
  });

  it("numeric classes by from and to: from included, to not, as the map steps through them", () => {
    expect(classIndexOf(numeric, -100)).toBe(0);
    expect(classIndexOf(numeric, 9.99)).toBe(0);
    expect(classIndexOf(numeric, 10)).toBe(1);
    expect(classIndexOf(numeric, 1e9)).toBe(2);
    expect(classIndexOf(numeric, null)).toBe("no_data");
    expect(classIndexOf(numeric, "many")).toBe("other");
    const closed = {
      method: "manual",
      classes: [
        { from: 0, to: 5 },
        { from: 5, to: 10 },
      ],
    };
    expect(classIndexOf(closed, 9.99)).toBe(1);
    expect(classIndexOf(closed, 10)).toBe("other");
    expect(classIndexOf(closed, -1)).toBe("other");
  });

  it("the popup header reads the class the same way", () => {
    const at = (value: unknown) =>
      classOf(KINDS as never, { kind: value }, { geometry: "point", zoom: 12 }).marker?.color;
    expect([at("beta"), at("omega"), at(null)]).toEqual(["#000002", "#000004", "#000005"]);
  });
});

describe("legendClasses", () => {
  it("filter by default, else what the style says; rasters list every class", () => {
    expect(legendClasses({ version: "1.0.0", kind: "vector" })).toBe("filter");
    expect(legendClasses({ version: "1.0.0", kind: "vector", legend: { classes: "view" } })).toBe("view");
    expect(legendClasses({ version: "1.0.0", kind: "vector", legend: { classes: "all" } })).toBe("all");
    expect(legendClasses({ version: "1.0.0", kind: "vector", legend: { classes: "nearby" } })).toBe("filter");
    expect(legendClasses({ version: "1.0.0", kind: "raster", legend: { classes: "view" } })).toBe("all");
  });
});
