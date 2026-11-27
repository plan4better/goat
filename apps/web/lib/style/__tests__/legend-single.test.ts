// A class that holds a single value (`computed.single`, spec 7.2) reads that value in the legend and the class list.
import { describe, expect, it } from "vitest";

import { type LegendEntry, buildLegend, classFormat, classRange, rangeText } from "@/lib/style/legend";

const classification = (computed: object, names: Record<string, string> = {}) => ({
  id: "v",
  field: "v",
  method: "quantile",
  count: 7,
  fit: true,
  unit: "m",
  format: { decimals: 1 },
  classes: [
    { id: "c1", to: 1, fill: { color: "#eeeeee" }, ...(names.c1 ? { name: names.c1 } : {}) },
    { id: "c2", from: 1, to: 1500.5, fill: { color: "#999999" } },
    { id: "c3", from: 1500.5, fill: { color: "#333333" }, ...(names.c3 ? { name: names.c3 } : {}) },
  ],
  computed: { at: "t", data: "f", scope: "dataset", domain: [0, 2000], ...computed },
});

const doc = (c: object) => ({
  version: "1.0.0",
  kind: "vector",
  symbol: { fill: { color: "#cccccc" } },
  classify: [c],
});

const entries = (c: object): LegendEntry[] => {
  const section = buildLegend(doc(c), { geometry: "polygon", zoom: 12 })!.sections[0];
  if (section.kind !== "entries") throw new Error("not a section of entries");
  return section.entries;
};

const words = { under: "under", to: "to", andMore: "and more" };
const text = (entry: LegendEntry, locale: string) =>
  rangeText(entry.range!, { locale, words, unit: "m", format: { decimals: 1 }, domain: [0, 2000] });

describe("a class that holds a single value", () => {
  const single = { single: { c1: 0, c3: 1500.5 } };

  it("reads its one value with the unit, in the reader's language", () => {
    const [first, middle, last] = entries(classification(single));
    expect(first.range).toEqual({ from: 0, to: 0 });
    expect(middle.range).toEqual({ from: 1, to: 1500.5 });
    expect(last.range).toEqual({ from: 1500.5, to: 1500.5 });
    expect([first, middle, last].map((e) => text(e, "en"))).toEqual([
      "0.0 m",
      "1.0 to 1,500.5 m",
      "1,500.5 m",
    ]);
    expect([first, middle, last].map((e) => text(e, "de"))).toEqual([
      "0,0 m",
      "1,0 to 1.500,5 m",
      "1.500,5 m",
    ]);
  });

  it("a class name wins", () => {
    const [first, , last] = entries(classification(single, { c3: "Most" }));
    expect(last.name).toBe("Most");
    expect(first.range).toEqual({ from: 0, to: 0 });
  });

  it("a style without the key reads as before; an id that is no class is ignored", () => {
    const before = entries(classification({}));
    expect(before.map((e) => e.range)).toEqual([{ to: 1 }, { from: 1, to: 1500.5 }, { from: 1500.5 }]);
    expect(entries(classification({ single: { zz: 3 } }))).toEqual(before);
  });

  it("a classification without fit reads its ranges, single values or not", () => {
    const { fit: _fit, ...plain } = classification(single);
    expect(entries(plain).map((e) => e.range)).toEqual([
      { to: 1 },
      { from: 1, to: 1500.5 },
      { from: 1500.5 },
    ]);
    expect(classRange(plain, plain.classes[2])).toEqual({ from: 1500.5 });
  });

  it("classRange reads the class's own bounds without the key", () => {
    const c = classification(single);
    expect(classRange(c, c.classes[1])).toEqual({ from: 1, to: 1500.5 });
    expect(classRange(c, c.classes[2])).toEqual({ from: 1500.5, to: 1500.5 });
    expect(classRange(classification({}), c.classes[0])).toEqual({ to: 1 });
  });
});

// The decimals the server records for classes fitted to the data (`computed.decimals`, spec 7.2): the labels read them
// where the classification's own format gives no decimals.
describe("the decimals the server records", () => {
  const fitted = (computed: object, format?: object) => {
    const { format: _format, ...c } = classification({ single: { c1: 0.004 }, ...computed });
    return format ? { ...c, format } : c;
  };
  const section = (c: object) => {
    const s = buildLegend(doc(c), { geometry: "polygon", zoom: 12 })!.sections[0];
    if (s.kind !== "entries") throw new Error("not a section of entries");
    return s;
  };
  const labels = (c: object) => {
    const s = section(c);
    return s.entries.map((e) =>
      rangeText(e.range!, { locale: "en", words, unit: s.unit, format: s.format, domain: s.domain })
    );
  };

  it("are the format of a fitted classification without one, and follow a recompute", () => {
    expect(section(fitted({ decimals: 3 })).format).toEqual({ decimals: 3 });
    expect(labels(fitted({ decimals: 3 }))).toEqual([
      "0.004 m",
      "1.000 to 1,500.500 m",
      "1,500.500 to 2,000.000 m",
    ]);
    // The data changed: the server recorded other decimals, and the labels read them.
    expect(labels(fitted({ single: { c1: 0 }, decimals: 1 }))).toEqual([
      "0.0 m",
      "1.0 to 1,500.5 m",
      "1,500.5 to 2,000.0 m",
    ]);
  });

  it("a format's own decimals win, also auto; a format without decimals takes them", () => {
    expect(section(fitted({ decimals: 3 }, { decimals: 1 })).format).toEqual({ decimals: 1 });
    expect(section(fitted({ decimals: 3 }, { decimals: "auto" })).format).toEqual({ decimals: "auto" });
    expect(section(fitted({ decimals: 3 }, { suffix: " x" })).format).toEqual({ suffix: " x", decimals: 3 });
    expect(classFormat(fitted({}, { suffix: " x" }))).toEqual({ suffix: " x" });
  });

  it("a classification without fit reads its format alone", () => {
    const { fit: _fit, ...plain } = fitted({ decimals: 3 });
    expect(section(plain).format).toBeUndefined();
    expect(classFormat(plain)).toBeUndefined();
    expect(classFormat({ ...plain, format: { decimals: 2 } })).toEqual({ decimals: 2 });
  });
});
