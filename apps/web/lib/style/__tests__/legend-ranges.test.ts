// Classes fitted to the data (`fit`, spec 5.2) read as ranges with shared bounds, a class that holds one value too; a
// single class over one value reads that value.
import { describe, expect, it } from "vitest";

import { type LegendEntry, buildLegend, classFormat, rangeText } from "@/lib/style/legend";

const doc = (c: object) => ({
  version: "1.0.0",
  kind: "vector",
  symbol: { fill: { color: "#cccccc" } },
  classify: [c],
});

const section = (c: object) => {
  const s = buildLegend(doc(c), { geometry: "polygon", zoom: 12 })!.sections[0];
  if (s.kind !== "entries") throw new Error("not a section of entries");
  return s;
};

const entries = (c: object): LegendEntry[] => section(c).entries;

const words = { under: "under", to: "to", andMore: "and more" };
const labels = (c: object, locale = "en") => {
  const s = section(c);
  return s.entries.map((e) =>
    rangeText(e.range!, { locale, words, unit: s.unit, format: s.format, domain: s.domain })
  );
};

/** Travel times fitted to the data: 7, 12 and 13 minutes each hold a class alone. */
const minutes = (computed: object = {}) => ({
  id: "v",
  field: "v",
  method: "quantile",
  count: 7,
  fit: true,
  unit: "min",
  classes: [
    { id: "c1", to: 5 },
    { id: "c2", from: 5, to: 7 },
    { id: "c3", from: 7, to: 8 },
    { id: "c4", from: 8, to: 10 },
    { id: "c5", from: 10, to: 12 },
    { id: "c6", from: 12, to: 13 },
    { id: "c7", from: 13 },
  ].map((k) => ({ ...k, fill: { color: "#999999" } })),
  computed: { at: "t", data: "f", scope: "dataset", domain: [3, 13], decimals: 0, ...computed },
});

describe("fitted classes", () => {
  it("read as ranges with shared bounds, the classes of one value too", () => {
    expect(labels(minutes())).toEqual([
      "3 to 5 min",
      "5 to 7 min",
      "7 to 8 min",
      "8 to 10 min",
      "10 to 12 min",
      "12 to 13 min",
      "13 min and more",
    ]);
  });

  it("a stored document that still holds single values reads the same ranges", () => {
    const stored = minutes({ single: { c3: 7, c6: 12, c7: 13 } });
    expect(entries(stored).map((e) => e.range)).toEqual(entries(minutes()).map((e) => e.range));
    expect(labels(stored)).toEqual(labels(minutes()));
    expect(labels(stored, "de")).toEqual(labels(minutes(), "de"));
  });

  it("a class of zeros alone reads from the data's minimum to its bound", () => {
    const zeros = {
      ...minutes(),
      unit: undefined,
      classes: [
        { id: "c1", to: 1 },
        { id: "c2", from: 1, to: 2 },
        { id: "c3", from: 2 },
      ],
      computed: { at: "t", data: "f", domain: [0, 69], decimals: 0, single: { c1: 0, c2: 1 } },
    };
    expect(labels(zeros)).toEqual(["0 to 1", "1 to 2", "2 to 69"]);
  });

  it("a single class over one value reads that value", () => {
    const one = {
      ...minutes(),
      unit: undefined,
      classes: [{ id: "c1", fill: { color: "#999999" } }],
      computed: { at: "t", data: "f", domain: [0.087, 0.087], decimals: 2 },
    };
    expect(labels(one)).toEqual(["0.09"]);
  });
});

// The decimals the server records for classes fitted to the data (`computed.decimals`, spec 7.2): the labels read them
// where the classification's own format gives no decimals.
describe("the decimals the server records", () => {
  const fitted = (decimals: number | undefined, format?: object) => {
    const c = minutes({ domain: [0.004, 2000], decimals });
    return format ? { ...c, format } : c;
  };

  it("are the format of a fitted classification without one, and follow a recompute", () => {
    expect(section(fitted(3)).format).toEqual({ decimals: 3 });
    expect(labels(fitted(3)).slice(0, 2)).toEqual(["0.004 to 5.000 min", "5.000 to 7.000 min"]);
    // The data changed: the server recorded other decimals, and the labels read them.
    expect(labels(fitted(1)).slice(0, 2)).toEqual(["0.0 to 5.0 min", "5.0 to 7.0 min"]);
  });

  it("a format's own decimals win, also auto; a format without decimals takes them", () => {
    expect(section(fitted(3, { decimals: 1 })).format).toEqual({ decimals: 1 });
    expect(section(fitted(3, { decimals: "auto" })).format).toEqual({ decimals: "auto" });
    expect(section(fitted(3, { suffix: " x" })).format).toEqual({ suffix: " x", decimals: 3 });
    expect(classFormat(fitted(undefined, { suffix: " x" }))).toEqual({ suffix: " x" });
  });

  it("a recorded value outside 0 to 10 is ignored", () => {
    for (const decimals of [-1, 11, 101, 2.5]) expect(classFormat(fitted(decimals))).toBeUndefined();
    expect(() => labels(fitted(101))).not.toThrow();
    expect(classFormat(fitted(10))).toEqual({ decimals: 10 });
  });

  it("a classification without fit reads its format alone", () => {
    const { fit: _fit, ...plain } = fitted(3);
    expect(section(plain).format).toBeUndefined();
    expect(classFormat(plain)).toBeUndefined();
    expect(classFormat({ ...plain, format: { decimals: 2 } })).toEqual({ decimals: 2 });
  });
});
