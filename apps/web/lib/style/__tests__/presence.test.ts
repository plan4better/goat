// The counts behind `legend.classes` (spec 7.2): which classes the features drawn in the view fall in, and which the
// server's counts under the layer's filter hold. Invented data only.
import { describe, expect, it } from "vitest";

import { countPresence, presenceFromCounts, presenceRequests } from "@/lib/style/presence";

const STAMP = { at: "2026-01-01T00:00:00Z", data: "synthetic:1", scope: "dataset" };

const KINDS = {
  id: "kind",
  field: "kind",
  method: "categories",
  classes: [
    { id: "c1", values: ["alpha"] },
    { id: "c2", values: ["beta", "gamma"] },
    { id: "c3", values: ["delta"] },
  ],
  other: { marker: { color: "#000004" } },
  no_data: { marker: { color: "#000005" } },
  computed: { ...STAMP, other: true, no_data: true },
};

const SIZES = {
  field: "size",
  method: "manual",
  classes: [{ to: 10 }, { from: 10, to: 20 }, { from: 20 }],
  computed: { ...STAMP, other: false, no_data: false },
};

const style = (...classify: object[]) => ({ version: 1, kind: "vector", classify });

const feature = (properties: Record<string, unknown>) => ({ properties });

/** The features one by one, counting how many were read. */
function reading(features: Array<{ properties: Record<string, unknown> }>) {
  const seen = { count: 0 };
  return {
    seen,
    *[Symbol.iterator]() {
      for (const f of features) {
        seen.count += 1;
        yield f;
      }
    },
  };
}

const plain = (presence: object) =>
  JSON.parse(JSON.stringify(presence, (_, v) => (v instanceof Set ? [...v] : v)));

describe("countPresence", () => {
  it("each classification's classes, Other and No data among the features", () => {
    const counter = countPresence(style(KINDS, SIZES));
    counter.add([
      feature({ kind: "beta", size: 15 }),
      feature({ kind: "omega", size: 3 }),
      feature({ kind: "gamma", size: null }),
    ]);
    expect(plain(counter.result())).toEqual({
      kind: { classes: ["c2"], other: true, no_data: false },
      "1": { classes: ["0", "1"], other: false, no_data: true },
    });
  });

  it("stops reading once every class the legend could list was seen", () => {
    const counter = countPresence(style({ ...KINDS, computed: { ...STAMP, other: false, no_data: true } }));
    const features = reading([
      feature({ kind: "alpha" }),
      feature({ kind: "beta" }),
      feature({}),
      feature({ kind: "delta" }),
      ...Array.from({ length: 1000 }, () => feature({ kind: "alpha" })),
    ]);
    expect(counter.add(features)).toBe(true);
    expect(features.seen.count).toBe(4);
    expect(counter.done).toBe(true);
    expect(plain(counter.result()).kind).toEqual({
      classes: ["c1", "c2", "c3"],
      other: false,
      no_data: true,
    });
  });

  it("classes hidden with the eye or left out are not waited for", () => {
    const hidden = {
      ...KINDS,
      classes: [
        KINDS.classes[0],
        { ...KINDS.classes[1], visible: false },
        { ...KINDS.classes[2], legend: false },
      ],
      other: { visible: false },
      computed: { ...STAMP, other: true, no_data: false },
    };
    const counter = countPresence(style(hidden));
    expect(counter.add([feature({ kind: "alpha" })])).toBe(true);
  });

  it("reads every feature while a class is missing, across several reads", () => {
    const counter = countPresence(style(KINDS));
    const first = reading([feature({ kind: "alpha" }), feature({ kind: "beta" })]);
    expect(counter.add(first)).toBe(false);
    expect(first.seen.count).toBe(2);
    expect(counter.add([feature({ kind: "delta" }), feature({ kind: "x" }), feature({ kind: null })])).toBe(
      true
    );
  });

  it("a layer without classifications has nothing to count", () => {
    const counter = countPresence({ version: 1, kind: "vector" });
    expect(counter.done).toBe(true);
    expect(counter.result()).toEqual({});
  });
});

describe("presenceRequests", () => {
  it("categories ask for the values, numeric classes for a histogram over their bounds", () => {
    expect(presenceRequests(style(KINDS, SIZES, { field: "", method: "categories", classes: [] }))).toEqual([
      { key: "kind", request: { kind: "values", field: "kind" } },
      { key: "1", request: { kind: "histogram", field: "size", breaks: [10, 20] } },
    ]);
  });

  it("classifications left out of the legend ask for nothing", () => {
    expect(presenceRequests(style({ ...KINDS, legend: false }))).toEqual([]);
  });
});

describe("presenceFromCounts", () => {
  it("categories: the values the filter keeps, features without a value from their own count", () => {
    const presence = presenceFromCounts(style(KINDS), {
      kind: {
        kind: "values",
        values: [
          { value: "gamma", count: 3 },
          { value: "omega", count: 1 },
          { value: "alpha", count: 0 },
        ],
        total: 3,
        missing: 2,
      },
    });
    expect(plain(presence)).toEqual({ kind: { classes: ["c2"], other: true, no_data: true } });
  });

  it("categories: values cut off by the request's limit cannot tell what is absent", () => {
    const presence = presenceFromCounts(style(KINDS), {
      kind: { kind: "values", values: [{ value: "alpha", count: 9 }], total: 1001, missing: 0 },
    });
    expect(presence).toEqual({});
  });

  it("numeric classes: each bin with features marks the class it lies in, and the data's ends theirs", () => {
    // The filter keeps values from 12 to 20: the server drops the break at 10, the bins are [12, 20) and [20, 20].
    const presence = presenceFromCounts(style(SIZES), {
      "0": {
        kind: "histogram",
        bins: [
          { range: [12, 20], count: 4 },
          { range: [20, 20], count: 1 },
        ],
        missing: 0,
      },
    });
    expect(plain(presence)).toEqual({ "0": { classes: ["1", "2"], other: false, no_data: false } });
    const narrow = presenceFromCounts(style(SIZES), {
      "0": { kind: "histogram", bins: [{ range: [3, 7], count: 2 }], missing: 1 },
    });
    expect(plain(narrow)).toEqual({ "0": { classes: ["0"], other: false, no_data: true } });
  });

  it("numeric classes: empty bins mark nothing, no values at all no class", () => {
    const presence = presenceFromCounts(style(SIZES), {
      "0": {
        kind: "histogram",
        bins: [
          { range: [3, 10], count: 2 },
          { range: [10, 20], count: 0 },
          { range: [20, 25], count: 2 },
        ],
        missing: 0,
      },
    });
    expect(plain(presence)).toEqual({ "0": { classes: ["0", "2"], other: false, no_data: false } });
    expect(
      plain(presenceFromCounts(style(SIZES), { "0": { kind: "histogram", bins: [], missing: 0 } }))
    ).toEqual({ "0": { classes: [], other: false, no_data: false } });
  });

  it("a classification whose count failed lists every class", () => {
    expect(presenceFromCounts(style(KINDS, SIZES), {})).toEqual({});
  });
});
