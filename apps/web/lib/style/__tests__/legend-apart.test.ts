// A numeric classification without decimals of its own whose class reads the same number on both ends with the
// default number format ("0 to 0") reads with the fewest fixed decimals, at least four, at which its bounds read
// apart; every other legend reads as the default number format writes it.
import { describe, expect, it, vi } from "vitest";

import { buildLegend, classFormat, rangeText, rasterClassFormat } from "@/lib/style/legend";
import { namedRasterSpec } from "@/lib/style/raster/popup";

import { classLabel } from "@/components/map/panels/styleEditor/editors/ClassList";

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

const words = { under: "under", to: "to", andMore: "and more" };
const labels = (c: object, locale = "en") => {
  const s = section(c);
  return s.entries.map((e) =>
    rangeText(e.range!, { locale, words, unit: s.unit, format: s.format, domain: s.domain })
  );
};

type Bounds = Array<{ from?: number; to?: number }>;

/** A hand-made classification of the classes between `breaks`, open at both ends. */
const contiguous = (breaks: number[]): Bounds =>
  [undefined, ...breaks].map((from, i) => ({
    ...(from !== undefined ? { from } : {}),
    ...(i < breaks.length ? { to: breaks[i] } : {}),
  }));

const manual = (classes: Bounds, extra: { domain?: [number, number]; format?: object } = {}) => ({
  id: "v",
  field: "v",
  method: "manual",
  classes: classes.map((k, i) => ({ id: `c${i}`, ...k, fill: { color: "#999999" } })),
  ...(extra.format ? { format: extra.format } : {}),
  ...(extra.domain ? { computed: { at: "t", data: "f", domain: extra.domain } } : {}),
});

const tiny = manual(contiguous([0.00005, 0.00007, 0.00009]), { domain: [0.00003, 0.00012] });
const close = manual(contiguous([0.00318, 0.004, 0.00681, 0.00718, 0.00858]));

describe("rows that read the same number on both ends", () => {
  it("tiny breaks read five decimals, and the open ends close with the data's ends", () => {
    expect(classFormat(tiny)).toEqual({ decimals: 5 });
    expect(labels(tiny)).toEqual([
      "0.00003 to 0.00005",
      "0.00005 to 0.00007",
      "0.00007 to 0.00009",
      "0.00009 to 0.00012",
    ]);
    expect(labels(tiny, "de")).toEqual([
      "0,00003 to 0,00005",
      "0,00005 to 0,00007",
      "0,00007 to 0,00009",
      "0,00009 to 0,00012",
    ]);
  });

  it("close breaks read four decimals on every row", () => {
    expect(classFormat(close)).toEqual({ decimals: 4 });
    expect(labels(close)).toEqual([
      "under 0.0032",
      "0.0032 to 0.0040",
      "0.0040 to 0.0068",
      "0.0068 to 0.0072",
      "0.0072 to 0.0086",
      "0.0086 and more",
    ]);
  });

  it("no bound but 0 reads 0", () => {
    // At five decimals 0.00000437 and 0.000007 read in order, but the first reads 0.
    const c = manual(contiguous([0.00000437, 0.000007]));
    expect(classFormat(c)).toEqual({ decimals: 6 });
    expect(labels(c)).toEqual(["under 0.000004", "0.000004 to 0.000007", "0.000007 and more"]);
  });

  it("a format with only a suffix or a prefix takes the decimals and keeps its text", () => {
    const suffixed = manual(contiguous([0.00005, 0.00007]), { format: { suffix: " t" } });
    expect(classFormat(suffixed)).toEqual({ suffix: " t", decimals: 5 });
    expect(labels(suffixed)).toEqual(["under 0.00005 t", "0.00005 t to 0.00007 t", "0.00007 t and more"]);
    const prefixed = manual(contiguous([0.00005, 0.00007]), {
      format: { prefix: "~", thousands_separator: false },
    });
    expect(classFormat(prefixed)).toEqual({ prefix: "~", thousands_separator: false, decimals: 5 });
    expect(labels(prefixed)[1]).toBe("~0.00005 to ~0.00007");
  });

  it("a format's own decimals win, also 0 and auto, though rows read the same", () => {
    for (const decimals of [0, 2, "auto"]) {
      const c = manual(contiguous([0.00005, 0.00007]), { format: { decimals } });
      expect(classFormat(c)).toEqual({ decimals });
    }
    expect(labels(manual(contiguous([0.00005, 0.00007]), { format: { decimals: 0 } }))[1]).toBe("0 to 0");
  });

  it("classes fitted to the data keep the decimals the server recorded", () => {
    const fitted = {
      ...tiny,
      method: "quantile",
      fit: true,
      computed: { at: "t", data: "f", domain: [0.00003, 0.00012], decimals: 2 },
    };
    expect(classFormat(fitted)).toEqual({ decimals: 2 });
  });

  it("negative values and values across 0", () => {
    const negative = manual(contiguous([-0.00009, -0.00005, 0.00002, 0.00006]));
    expect(classFormat(negative)).toEqual({ decimals: 5 });
    expect(labels(negative)).toEqual([
      "under -0.00009",
      "-0.00009 to -0.00005",
      "-0.00005 to 0.00002",
      "0.00002 to 0.00006",
      "0.00006 and more",
    ]);
    // Bounds that round to 0 on both sides of it: the fewest decimals at which they read in order, not as -0 and 0.
    const across = manual([{ from: -0.00004, to: 0.00002 }]);
    expect(classFormat(across)).toBeUndefined();
    const twice = manual([
      { from: -0.00004, to: -0.00003 },
      { from: -0.00003, to: 0.00002 },
    ]);
    expect(classFormat(twice)).toEqual({ decimals: 5 });
    expect(labels(twice)).toEqual(["-0.00004 to -0.00003", "-0.00003 to 0.00002"]);
  });

  it("never fewer decimals than the default format shows", () => {
    const third = manual([
      { from: 1.2345, to: 1.2354 },
      { from: 1.2354, to: 2.125 },
    ]);
    expect(classFormat(third)).toEqual({ decimals: 4 });
    expect(labels(third)).toEqual(["1.2345 to 1.2354", "1.2354 to 2.1250"]);
    const half = manual([
      { from: 1.4996, to: 1.5004 },
      { from: 1.5004, to: 2.75 },
    ]);
    expect(classFormat(half)).toEqual({ decimals: 4 });
    expect(labels(half)).toEqual(["1.4996 to 1.5004", "1.5004 to 2.7500"]);
  });

  it("bounds that ten decimals do not read apart read as the default format writes them", () => {
    const c = manual([
      { from: 0, to: 1e-12 },
      { from: 1e-12, to: 5 },
      { from: 5, to: 10 },
    ]);
    expect(classFormat(c)).toBeUndefined();
    expect(labels(c)).toEqual(["0 to 0", "0 to 5", "5 to 10"]);
  });

  it("bounds that are not finite numbers are no trigger", () => {
    const c = manual([
      { from: NaN, to: NaN },
      { from: 1, to: 2 },
    ]);
    expect(classFormat(c)).toBeUndefined();
  });

  it("the classes of one array are searched once", () => {
    const c = manual(contiguous([0.00005, 0.00007, 0.00009]));
    expect(classFormat(c)).toEqual({ decimals: 5 });
    // `format` is a getter of the formatter's prototype: every number formatted reads it.
    const prototype = Intl.NumberFormat.prototype as unknown as { format: unknown };
    const formats = vi.spyOn(prototype, "format", "get");
    try {
      expect(classFormat(c)).toEqual({ decimals: 5 });
      expect(classFormat({ ...c, format: { suffix: " t" } })).toEqual({ suffix: " t", decimals: 5 });
      expect(formats).not.toHaveBeenCalled();
    } finally {
      formats.mockRestore();
    }
  });

  it("manual classes with closed ends and a gap between them", () => {
    const apart = manual([
      { from: 0.00001, to: 0.00002 },
      { from: 0.00004, to: 0.00005 },
    ]);
    expect(classFormat(apart)).toEqual({ decimals: 5 });
    expect(labels(apart)).toEqual(["0.00001 to 0.00002", "0.00004 to 0.00005"]);
  });

  it("a class hidden with the eye counts: the panel lists it, and the format stays when it is shown again", () => {
    const shown = manual(contiguous([0.00005, 0.00007, 1]));
    const hidden = {
      ...shown,
      classes: shown.classes.map((k, i) => (i === 1 ? { ...k, visible: false } : k)),
    };
    expect(classFormat(hidden)).toEqual({ decimals: 5 });
    expect(labels(hidden)).toEqual(["under 0.00005", "0.00007 to 1.00000", "1.00000 and more"]);
  });

  it("the style panel's class list reads the same texts as the legend", () => {
    const t = (key: string) =>
      ({ "style_editor.range_to": "to", "style_editor.range_under": "under" })[key] ?? key;
    for (const c of [tiny, close]) {
      const panel = c.classes.map((k) => classLabel(c, k, t, "en"));
      expect(panel.map((text) => text.replace("style_editor.range_and_more", "and more"))).toEqual(labels(c));
    }
  });
});

describe("a raster's classes", () => {
  const raster = (classes: Bounds) => ({
    version: "1.0.0",
    kind: "raster",
    render: { type: "continuous", palette: ["#000000", "#ffffff"], classify: { method: "manual", classes } },
  });
  const rows = (style: ReturnType<typeof raster>) => {
    const s = buildLegend(style, { zoom: 12 })!.sections[0];
    if (s.kind !== "entries") throw new Error("not a section of entries");
    return s.entries.map((e) =>
      rangeText(e.range!, { locale: "en", words, format: s.format, domain: s.domain })
    );
  };
  const names = (style: ReturnType<typeof raster>) =>
    (namedRasterSpec(style, { locale: "en" }) as { classes: Array<{ name?: string }> }).classes.map(
      (c) => c.name
    );

  it("read their bounds apart in the legend and the popup", () => {
    const tinyRaster = raster(contiguous([0.00005, 0.00007]));
    expect(rasterClassFormat(tinyRaster.render)).toEqual({ decimals: 5 });
    expect(rows(tinyRaster)).toEqual(["under 0.00005", "0.00005 to 0.00007", "0.00007 and more"]);
    expect(names(tinyRaster)).toEqual(["Under 0.00005", "0.00005 to 0.00007", "0.00007 and more"]);
  });

  it("read as before where they read apart, and the outer ends the map leaves out do not count", () => {
    const plain = raster(contiguous([10, 20.5]));
    expect(rasterClassFormat(plain.render)).toBeUndefined();
    expect(rows(plain)).toEqual(["under 10", "10 to 20.5", "20.5 and more"]);
    // With the end colors outside, the first class is open: its written lower end is no bound of a row.
    const outer = raster([
      { from: 0.00001, to: 0.00002 },
      { from: 0.00002, to: 1 },
    ]);
    expect(rasterClassFormat(outer.render)).toBeUndefined();
  });
});

describe("H3 classes", () => {
  const h3 = (breaks: number[], min: number, max: number) => ({
    version: "1.0.0",
    kind: "vector",
    render: {
      type: "h3",
      classify: { method: "quantile", count: breaks.length + 1 },
      computed: { at: "t", data: "f", scope: "dataset", resolutions: { "7": { min, max, breaks } } },
    },
  });
  const rows = (style: ReturnType<typeof h3>) => {
    const s = buildLegend(style, { geometry: "point", zoom: 10 })!.sections[0];
    if (s.kind !== "entries") throw new Error("not a section of entries");
    return s.entries.map((e) =>
      rangeText(e.range!, { locale: "en", words, format: s.format, domain: s.domain })
    );
  };

  it("read their bounds apart, and read as before where they read apart", () => {
    expect(rows(h3([0.00005, 0.00007], 0.00003, 0.00012))).toEqual([
      "0.00003 to 0.00005",
      "0.00005 to 0.00007",
      "0.00007 to 0.00012",
    ]);
    expect(rows(h3([3, 6], 1, 9))).toEqual(["1 to 3", "3 to 6", "6 to 9"]);
  });
});

describe("legends whose rows read apart read as before", () => {
  it("ordinary breaks, in English and German", () => {
    const cases: Array<[ReturnType<typeof manual>, string[], string[]]> = [
      [
        manual(contiguous([2800, 3600, 6300]), { domain: [800, 9000] }),
        ["800 to 2,800", "2,800 to 3,600", "3,600 to 6,300", "6,300 to 9,000"],
        ["800 to 2.800", "2.800 to 3.600", "3.600 to 6.300", "6.300 to 9.000"],
      ],
      [
        manual(contiguous([0.5, 1.25, 2])),
        ["under 0.5", "0.5 to 1.25", "1.25 to 2", "2 and more"],
        ["under 0,5", "0,5 to 1,25", "1,25 to 2", "2 and more"],
      ],
      [
        manual(contiguous([10.5, 12]), { domain: [3.25, 40.125] }),
        ["3.25 to 10.5", "10.5 to 12", "12 to 40.125"],
        ["3,25 to 10,5", "10,5 to 12", "12 to 40,125"],
      ],
    ];
    for (const [c, en, de] of cases) {
      expect(classFormat(c)).toBeUndefined();
      expect(labels(c)).toEqual(en);
      expect(labels(c, "de")).toEqual(de);
    }
  });

  it("an open end that reads like the break stays open", () => {
    const c = manual(contiguous([2.5, 4]), { domain: [2.4996, 7] });
    expect(classFormat(c)).toBeUndefined();
    expect(labels(c)).toEqual(["under 2.5", "2.5 to 4", "4 to 7"]);
  });

  it("a class of one value, and a class from below 0 to above it that reads -0 to 0", () => {
    const one = manual([{ to: 5 }, { from: 5, to: 5 }, { from: 5, to: 10 }, { from: 10 }]);
    expect(classFormat(one)).toBeUndefined();
    expect(labels(one)).toEqual(["under 5", "5", "5 to 10", "10 and more"]);
    const signs = manual([{ from: -0.0001, to: 0.0001 }]);
    expect(classFormat(signs)).toBeUndefined();
    expect(labels(signs)).toEqual(["-0 to 0"]);
  });

  it("classes with a gap whose neighbouring ends read the same, no class itself", () => {
    const c = manual([
      { from: 1, to: 2.0001 },
      { from: 2.0002, to: 3 },
    ]);
    expect(classFormat(c)).toBeUndefined();
    expect(labels(c)).toEqual(["1 to 2", "2 to 3"]);
  });

  it("negative breaks that read apart", () => {
    const c = manual(contiguous([-10, -2.5, 0, 3]));
    expect(classFormat(c)).toBeUndefined();
    expect(labels(c)).toEqual(["under -10", "-10 to -2.5", "-2.5 to 0", "0 to 3", "3 and more"]);
  });

  it("categories keep their format", () => {
    const c = {
      id: "v",
      field: "v",
      method: "categories",
      format: { suffix: " t" },
      classes: [{ id: "a", values: [0.00005, 0.00007], fill: { color: "#999999" } }],
    };
    expect(classFormat(c)).toEqual({ suffix: " t" });
  });

  it("a seeded set of classifications without such a row keep their format as given", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const scales = [1e-6, 1e-3, 0.1, 1, 100, 1e5];
    let kept = 0;
    for (let n = 0; n < 300; n++) {
      const scale = scales[n % scales.length];
      const breaks = [
        ...new Set(
          Array.from({ length: 2 + (n % 5) }, () => Math.round((random() - 0.3) * scale * 1e6) / 1e6)
        ),
      ].sort((a, b) => a - b);
      const format = n % 3 === 0 ? { suffix: " u" } : undefined;
      const c = manual(contiguous(breaks), format ? { format } : {});
      const plain = new Intl.NumberFormat("en");
      const same = c.classes.some(
        (k) =>
          k.from !== undefined &&
          k.to !== undefined &&
          k.from !== k.to &&
          plain.format(k.from) === plain.format(k.to)
      );
      if (same) continue;
      kept++;
      expect(classFormat(c)).toEqual(format);
    }
    expect(kept).toBeGreaterThan(100);
  });
});
