import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import {
  NO_DATA_COLOR,
  addCategoryClass,
  addClassification,
  categoryValue,
  classColorsByHand,
  classValuesByHand,
  classesPending,
  classifyCount,
  classifyTargets,
  clearClassValues,
  isIntentEdit,
  moveCategoryValue,
  moveClassification,
  pickClassPalette,
  pickClassRange,
  rangeValues,
  recolorClasses,
  removeClass,
  removeClassification,
  retarget,
  scopedView,
  setClassificationField,
  setManualBound,
  setMethod,
} from "@/lib/style/editor/classify";
import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type SaveResult, StyleSaver, type StyleTransport } from "@/lib/style/save";

const doc = (extra: object = {}) =>
  ({ version: "1.0.0", kind: "vector", symbol: { fill: { color: "#cccccc" } }, ...extra }) as LayerStyle;
const classified = () => doc({ classify: [{ id: "c1", field: "density", method: "quantile", count: 5 }] });

function setup(document: LayerStyle) {
  const saves: LayerStyle[] = [];
  const resolvers: Array<(r: SaveResult) => void> = [];
  const transport: StyleTransport = {
    save: (body) => {
      saves.push(body.document);
      return new Promise((resolve) => resolvers.push(resolve));
    },
    load: async () => ({ document, revision: 1 }),
  };
  const store = new EditorStore({ saver: new StyleSaver({ transport, document, revision: 1 }) });
  const answer = async (d: LayerStyle) => {
    resolvers.shift()?.({ ok: true, document: d, revision: 2, issues: [] });
    await vi.advanceTimersByTimeAsync(0);
  };
  return { store, saves, answer };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("classification intent", () => {
  it("an intent edit saves at once", () => {
    const { store, saves } = setup(classified());
    store.set("classify.0.method", "equal_interval");
    expect(saves).toHaveLength(1);
  });

  it("a color edit is not an intent edit", async () => {
    const before = classified();
    expect(isIntentEdit(before, { ...before, symbol: { fill: { color: "#ff0000" } } } as LayerStyle)).toBe(
      false
    );
    expect(
      isIntentEdit(before, doc({ classify: [{ id: "c1", field: "density", method: "quantile", count: 7 }] }))
    ).toBe(true);
    expect(
      isIntentEdit(doc(), doc({ symbol: { fill: { color: { field: "d", palette: "goat:green" } } } }))
    ).toBe(true);
    const { store, saves } = setup(before);
    store.set("symbol.fill.color", "#ff0000");
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toHaveLength(1);
  });

  it("a value form's scale and a form inside zoom stops are intent", () => {
    const width = (w: object) => doc({ symbol: { line: { width: w } } });
    expect(
      isIntentEdit(width({ field: "t", range: [1, 8] }), width({ field: "t", range: [1, 8], scale: "log" }))
    ).toBe(true);
    expect(
      isIntentEdit(
        width({
          zoom: [
            [10, { field: "t", range: [1, 4] }],
            [14, 6],
          ],
        }),
        width({
          zoom: [
            [10, { field: "u", range: [1, 4] }],
            [14, 6],
          ],
        })
      )
    ).toBe(true);
    expect(isIntentEdit(width({ field: "t", range: [1, 8] }), width({ field: "t", range: [1, 9] }))).toBe(
      false
    );
  });

  it("classes are pending until the reply", async () => {
    const { store, answer } = setup(classified());
    expect(classesPending(store, 0)).toBe(false);
    store.set("classify.0.count", 3);
    expect(classesPending(store, 0)).toBe(true);
    await answer(
      doc({
        classify: [
          {
            id: "c1",
            field: "density",
            method: "quantile",
            count: 3,
            classes: [{ to: 1 }, { from: 1, to: 2 }, { from: 2 }],
          },
        ],
      })
    );
    expect(classesPending(store, 0)).toBe(false);
  });
});

describe("classification edits", () => {
  const text = { name: "land_use", type: "string" as const };
  const number = { name: "population", type: "integer" as const };
  const classify = (d: LayerStyle) => (d as unknown as { classify: Array<Record<string, unknown>> }).classify;

  it("adds categories on the main color without target, numbers with quantile, count 5 and the target", () => {
    const one = addClassification(doc(), "fill.color", text, "polygon");
    // A color classification draws features without a value in a light grey, not in the layer's color.
    expect(classify(one)).toEqual([
      {
        id: "land_use",
        field: "land_use",
        method: "categories",
        count: 8,
        no_data: { fill: { color: NO_DATA_COLOR } },
      },
    ]);
    const two = addClassification(one, "outline.width", number, "polygon");
    expect(classify(two)[1]).toEqual({
      id: "population",
      field: "population",
      method: "quantile",
      count: 5,
      target: "outline.width",
    });
    expect(classify(addClassification(two, "fill.opacity", text, "polygon"))[2].id).toBe("k1");
    expect(classify(addClassification(two, "outline.color", number, "polygon"))[2].no_data).toEqual({
      outline: { color: NO_DATA_COLOR },
    });
  });

  it("retargets: drops the old key from class records and what no longer fits", () => {
    const d = doc({
      classify: [
        {
          id: "c",
          field: "density",
          method: "quantile",
          palette: "colorbrewer:OrRd",
          classes: [
            { to: 2, fill: { color: "#111111" } },
            { from: 2, fill: { color: "#222222" } },
          ],
        },
      ],
    });
    const out = classify(retarget(d, 0, "outline.width", "polygon"))[0];
    expect(out.target).toBe("outline.width");
    expect(out.palette).toBeUndefined();
    expect(out.classes).toEqual([{ to: 2 }, { from: 2 }]);
    expect(
      classify(retarget(retarget(d, 0, "outline.width", "polygon"), 0, "fill.color", "polygon"))[0].target
    ).toBeUndefined();
  });

  it("retargets a Font classification: its classes lose the style with the weight", () => {
    const d = doc({
      classify: [
        {
          id: "c",
          field: "kind",
          method: "categories",
          target: "label.font.weight",
          classes: [
            { values: ["a"], label: { font: { weight: "regular", style: "italic" }, size: 14 } },
            { values: ["b"], label: { font: { weight: "bold", style: "normal" } } },
          ],
        },
      ],
    });
    expect(classify(retarget(d, 0, "label.size", "point"))[0].classes).toEqual([
      { values: ["a"], label: { size: 14 } },
      { values: ["b"] },
    ]);
  });

  it("a manual bound sets the class's from and the previous class's to", () => {
    const d = doc({
      classify: [
        {
          id: "c",
          field: "density",
          method: "quantile",
          count: 3,
          classes: [{ to: 2 }, { from: 2, to: 5 }, { from: 5 }],
          computed: { at: "x", domain: [0, 9], generated: { target: "fill.color", values: {} } },
        },
      ],
    });
    const out = classify(setManualBound(d, 0, 2, 4))[0];
    expect(out.classes).toEqual([{ to: 2 }, { from: 2, to: 4 }, { from: 4 }]);
    expect(out.method).toBe("manual");
    expect(out.count).toBeUndefined();
    // The field's minimum and maximum stay for the labels until the server answers; what it wrote goes.
    expect(out.computed).toEqual({ at: "x", domain: [0, 9] });
    expect(
      classify(
        setManualBound(doc({ classify: [{ ...classify(d)[0], computed: { at: "x", data: "f" } }] }), 0, 2, 4)
      )[0].computed
    ).toBeUndefined();
  });

  it("removes and moves classifications", () => {
    const d = doc({
      classify: [
        { id: "a", field: "a", method: "categories" },
        { id: "b", field: "b", method: "categories" },
      ],
    });
    expect(classify(moveClassification(d, 1, 0)).map((c) => c.id)).toEqual(["b", "a"]);
    expect(classify(removeClassification(d, 0)).map((c) => c.id)).toEqual(["b"]);
    expect(classify(removeClassification(removeClassification(d, 0), 0))).toBeUndefined();
  });
});

describe("categories picked by hand", () => {
  const classify = (d: LayerStyle) => (d as unknown as { classify: Record<string, unknown>[] }).classify;
  const top = () =>
    doc({
      classify: [
        {
          id: "use",
          field: "use",
          method: "categories",
          count: 8,
          classes: [
            { id: "c1", values: ["home"], fill: { color: "#66c2a5" } },
            { id: "c2", values: ["shop"], fill: { color: "#fc8d62" } },
            { id: "c3", values: ["park"], fill: { color: "#8da0cb" } },
          ],
          computed: { at: "2026-10-27T14:28:39Z", data: "ducklake:1", scope: "dataset" },
        },
      ],
    });

  it("moving a value takes it out of its class and into the other; the classes stop being computed", () => {
    const out = classify(moveCategoryValue(top(), 0, "shop", 0))[0];
    expect(out.classes).toEqual([
      { id: "c1", values: ["home", "shop"], fill: { color: "#66c2a5" } },
      { id: "c2", values: [], fill: { color: "#fc8d62" } },
      { id: "c3", values: ["park"], fill: { color: "#8da0cb" } },
    ]);
    expect(out.method).toBe("categories");
    expect(out.count).toBeUndefined();
    expect(out.computed).toBeUndefined();
  });

  it("a value moved to no class leaves its class; a value of another type matches as text", () => {
    const d = doc({ classify: [{ field: "n", method: "categories", classes: [{ values: [5, 7] }] }] });
    expect(classify(moveCategoryValue(d, 0, "5", null))[0].classes).toEqual([{ values: [7] }]);
  });

  it("on a number field a value matches in goatlib's spelling: a stored 7.0 is the value 7", () => {
    const d = doc({
      classify: [{ field: "n", method: "categories", classes: [{ values: ["7.0"] }, { values: [] }] }],
    });
    expect(classify(moveCategoryValue(d, 0, "7", 1, "number"))[0].classes).toEqual([
      { values: [] },
      { values: ["7"] },
    ]);
    // Without the field's type, as text.
    expect(classify(moveCategoryValue(d, 0, "7", null))[0].classes).toEqual([
      { values: ["7.0"] },
      { values: [] },
    ]);
  });

  it("adds a class with fresh id and its own values, and removes one", () => {
    const added = addCategoryClass(top(), 0, { fill: { color: "#e78ac3" } });
    expect(classify(added)[0].classes).toContainEqual({ id: "c4", values: [], fill: { color: "#e78ac3" } });
    expect(classify(added)[0].count).toBeUndefined();
    const removed = classify(removeClass(top(), 0, 1))[0];
    expect((removed.classes as Array<{ id: string }>).map((k) => k.id)).toEqual(["c1", "c3"]);
    expect(removed.count).toBeUndefined();
  });

  it("recolors the classes in order with the palette's colors", () => {
    const out = classify(recolorClasses(top(), 0, "fill.color", ["#111111", "#222222"]))[0];
    expect((out.classes as Array<{ fill: { color: string } }>).map((k) => k.fill.color)).toEqual([
      "#111111",
      "#222222",
      "#111111",
    ]);
  });

  it("a palette picked for computed classes takes every class, also a color picked by hand", () => {
    const d = top();
    const out = classify(clearClassValues(d, 0, "fill.color"))[0];
    expect(out.classes).toEqual([
      { id: "c1", values: ["home"] },
      { id: "c2", values: ["shop"] },
      { id: "c3", values: ["park"] },
    ]);
  });

  it("reads a value as the field's type", () => {
    expect(categoryValue("42", "integer")).toBe(42);
    // A number field's value as goatlib writes category classes: its text, without a trailing zero.
    expect(categoryValue("2.5", "number")).toBe("2.5");
    expect(categoryValue("2.50", "number")).toBe("2.5");
    expect(categoryValue("1.0", "number")).toBe("1");
    expect(categoryValue("true", "boolean")).toBe(true);
    expect(categoryValue("0042", "string")).toBe("0042");
    expect(categoryValue("x", "integer")).toBe("x");
  });
});

describe("a range picked for a number", () => {
  const classify = (d: LayerStyle) => (d as unknown as { classify: Record<string, unknown>[] }).classify;
  const sizes = (d: LayerStyle) =>
    (classify(d)[0].classes as Array<{ marker?: { size?: number } }>).map((k) => k.marker?.size);
  const breaks = (method: string, typed: number[]) =>
    doc({
      classify: [
        {
          id: "c",
          field: "n",
          target: "marker.size",
          method,
          count: typed.length,
          classes: typed.map((size, i) => ({ id: `c${i + 1}`, marker: { size, color: "#111111" } })),
        },
      ],
    });

  it("spreads values like the server: by position, to 0.1, to 0.01 for opacities", () => {
    expect(rangeValues(4, 14, 5)).toEqual([4, 6.5, 9, 11.5, 14]);
    expect(rangeValues(4, 24, 4)).toEqual([4, 10.7, 17.3, 24]);
    expect(rangeValues(0.2, 1, 4, true)).toEqual([0.2, 0.47, 0.73, 1]);
    expect(rangeValues(4, 24, 1)).toEqual([4]);
  });

  it("computed classes give up the sizes typed by hand: the server writes them all from the range", () => {
    const out = pickClassRange(breaks("heads_and_tails", [1, 2, 3, 4, 5]), 0, "marker.size", [4, 14]);
    expect(classify(out)[0].range).toEqual([4, 14]);
    expect(sizes(out)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    // Only the size goes: the classes keep their colors.
    expect((classify(out)[0].classes as Array<{ marker: { color: string } }>)[0].marker.color).toBe(
      "#111111"
    );
  });

  it("manual classes and categories picked by hand, which the server does not fill, get the range's values", () => {
    expect(sizes(pickClassRange(breaks("manual", [1, 2, 3, 4, 5]), 0, "marker.size", [4, 14]))).toEqual([
      4, 6.5, 9, 11.5, 14,
    ]);
    const byHand = doc({
      classify: [
        {
          field: "use",
          target: "marker.size",
          method: "categories",
          classes: [{ values: ["a"] }, { values: ["b"], marker: { size: 30 } }],
        },
      ],
    });
    expect(sizes(pickClassRange(byHand, 0, "marker.size", [4, 24]))).toEqual([4, 24]);
  });

  it("tells sizes typed by hand from the range's", () => {
    const c = (d: LayerStyle) => classify(d)[0];
    expect(classValuesByHand(c(breaks("quantile", [1, 2, 3, 4, 5])), "marker.size", [4, 24])).toBe(true);
    expect(classValuesByHand(c(breaks("quantile", [4, 9, 14, 19, 24])), "marker.size", [4, 24])).toBe(false);
    // The server hands category values out in any order: a value of the range is never by hand.
    expect(classValuesByHand(c(breaks("categories", [24, 4, 14, 9, 19])), "marker.size", [4, 24])).toBe(
      false
    );
    expect(
      classValuesByHand(c(doc({ classify: [{ field: "n", method: "quantile" }] })), "marker.size", [4, 24])
    ).toBe(false);
  });
});

describe("colors picked by hand", () => {
  const PALETTE = ["#111111", "#222222", "#333333"];
  const computed = (colors: string[], generated?: Record<string, string>) => ({
    field: "n",
    method: "quantile",
    count: colors.length,
    classes: colors.map((color, i) => ({ id: `c${i + 1}`, fill: { color } })),
    computed: generated ? { generated: { target: "fill.color", values: generated } } : {},
  });

  it("classes the server fills: a color other than the one it wrote is picked by hand", () => {
    const written = { c1: "#aaaaaa", c2: "#bbbbbb" };
    expect(classColorsByHand(computed(["#aaaaaa", "#bbbbbb"], written), "fill.color", PALETTE)).toBe(false);
    expect(classColorsByHand(computed(["#aaaaaa", "#ff0000"], written), "fill.color", PALETTE)).toBe(true);
    // Colors the server has no record of writing are not its own: it keeps them on a new palette.
    expect(classColorsByHand(computed(["#aaaaaa", "#bbbbbb"]), "fill.color", PALETTE)).toBe(true);
    expect(classColorsByHand(computed([]), "fill.color", PALETTE)).toBe(false);
  });

  it("manual classes, colored by the panel: a color the palette does not have is picked by hand", () => {
    const manual = (colors: string[]) => ({ ...computed(colors), method: "manual" });
    expect(classColorsByHand(manual(["#111111", "#333333"]), "fill.color", PALETTE)).toBe(false);
    expect(classColorsByHand(manual(["#111111", "#FF0000"]), "fill.color", PALETTE)).toBe(true);
  });

  it("computed classes switched to manual keep the server's colors, which are the palette's", () => {
    // A quantile classification as the server answers it: goatlib's `sample_colors` of GOAT green over 5 classes.
    const server = ["#e6f6ef", "#a7e2c7", "#5fca9b", "#259e72", "#145c42"];
    const classes = server.map((color, i) => ({
      id: `c${i + 1}`,
      ...(i ? { from: i } : {}),
      ...(i < 4 ? { to: i + 1 } : {}),
      fill: { color },
    }));
    const quantile = doc({
      classify: [
        {
          id: "pop",
          field: "pop",
          method: "quantile",
          count: 5,
          palette: "goat:green",
          classes,
          computed: {
            generated: {
              target: "fill.color",
              values: Object.fromEntries(classes.map((k) => [k.id, k.fill.color])),
            },
          },
        },
      ],
    });
    const c = (d: LayerStyle) => (d as unknown as { classify: Record<string, unknown>[] }).classify[0];
    expect(classColorsByHand(c(quantile), "fill.color", "goat:green")).toBe(false);
    expect(classColorsByHand(c(setMethod(quantile, 0, "manual")), "fill.color", "goat:green")).toBe(false);
  });
});

describe("a palette picked for classes the server does not fill", () => {
  const colors = (d: LayerStyle) =>
    (
      d as unknown as { classify: Array<{ classes: Array<{ fill?: { color: string } }> }> }
    ).classify[0].classes.map((k) => k.fill?.color);
  const manual = (n: number) =>
    doc({
      classify: [
        {
          id: "pop",
          field: "pop",
          method: "manual",
          classes: Array.from({ length: n }, (_, i) =>
            i === 0 ? { to: 1 } : i === n - 1 ? { from: i } : { from: i, to: i + 1 }
          ),
        },
      ],
    });

  // The colors goatlib's `sample_colors` gives computed classes of the same count.
  it.each([
    ["goat:green", 5, false, ["#e6f6ef", "#a7e2c7", "#5fca9b", "#259e72", "#145c42"]],
    ["goat:green", 5, true, ["#145c42", "#259e72", "#5fca9b", "#a7e2c7", "#e6f6ef"]],
    [
      "colorbrewer:BuGn",
      13,
      false,
      [
        "#f7fcfd",
        "#ebf7fa",
        "#ddf2f3",
        "#ccece6",
        "#aadfd3",
        "#89d1bd",
        "#66c2a4",
        "#4eb585",
        "#38a265",
        "#238b45",
        "#0e7734",
        "#005f26",
        "#00441b",
      ],
    ],
    ["colorbrewer:YlOrRd", 4, false, ["#ffffb2", "#fecc5c", "#fd8d3c", "#e31a1c"]],
    ["d3:viridis", 6, false, ["#440154", "#424385", "#2e788d", "#30a881", "#82d150", "#fde725"]],
  ] as const)(
    "%s for %i manual classes (reversed: %s) colors them as computed classes",
    (id, n, reversed, want) => {
      const out = pickClassPalette(manual(n), 0, "fill.color", id, reversed);
      expect(colors(out)).toEqual(want);
      const c = (out as unknown as { classify: Record<string, unknown>[] }).classify[0];
      expect(c.palette).toBe(id);
      expect(c.reverse).toBe(reversed || undefined);
      expect(classColorsByHand(c, "fill.color", id)).toBe(false);
    }
  );

  const byHand = () =>
    doc({
      classify: [
        {
          id: "use",
          field: "use",
          method: "categories",
          classes: ["a", "b", "c", "d", "e"].map((v, i) => ({ id: `c${i + 1}`, values: [v] })),
        },
      ],
    });

  it("categories picked by hand: a qualitative palette and a list of colors repeat in order, as the server's", () => {
    const set2 = pickClassPalette(byHand(), 0, "fill.color", "colorbrewer:Set2", false);
    expect(colors(set2)).toEqual(["#66c2a5", "#fc8d62", "#8da0cb", "#e78ac3", "#a6d854"]);
    const list = pickClassPalette(byHand(), 0, "fill.color", ["#111111", "#222222", "#333333"], false);
    expect(colors(list)).toEqual(["#111111", "#222222", "#333333", "#111111", "#222222"]);
  });

  it("categories picked by hand: a sequential palette is spread over the classes, as the server's", () => {
    const out = pickClassPalette(byHand(), 0, "fill.color", "goat:green", false);
    expect(colors(out)).toEqual(["#e6f6ef", "#a7e2c7", "#5fca9b", "#259e72", "#145c42"]);
  });

  it("computed classes lose their colors: the server colors them again", () => {
    const quantile = doc({
      classify: [
        {
          id: "pop",
          field: "pop",
          method: "quantile",
          count: 2,
          classes: [
            { id: "c1", to: 1, fill: { color: "#ff0000" } },
            { id: "c2", from: 1, fill: { color: "#00ff00" } },
          ],
        },
      ],
    });
    const out = pickClassPalette(quantile, 0, "fill.color", "goat:green", true);
    expect(colors(out)).toEqual([undefined, undefined]);
    const c = (out as unknown as { classify: Record<string, unknown>[] }).classify[0];
    expect([c.palette, c.reverse]).toEqual(["goat:green", true]);
  });
});

describe("field and method switches", () => {
  const classify = (d: LayerStyle) => (d as unknown as { classify: Array<Record<string, unknown>> }).classify;
  const base = doc({
    classify: [
      {
        id: "c",
        field: "density",
        method: "quantile",
        count: 4,
        palette: ["#000000", "#ffffff"],
        classes: [{ to: 2 }, { from: 2 }],
        other: { name: "Other" },
        computed: { at: "x" },
      },
    ],
  });

  it("a new field clears the classes and switches the method family by type", () => {
    expect(classify(setClassificationField(base, 0, { name: "land_use", type: "string" }))[0]).toEqual({
      id: "c",
      field: "land_use",
      method: "categories",
      count: 8,
    });
    expect(classify(setClassificationField(base, 0, { name: "area", type: "number" }))[0]).toEqual({
      id: "c",
      field: "area",
      method: "quantile",
      count: 4,
    });
  });

  it("manual keeps the breaks; categories and numeric methods do not share classes", () => {
    const manual = classify(setMethod(base, 0, "manual"))[0];
    expect(manual.classes).toEqual([{ to: 2 }, { from: 2 }]);
    expect(manual.count).toBeUndefined();
    expect(manual.computed).toBeUndefined();
    const withEnds = { ...base, classify: [{ ...classify(base)[0], computed: { at: "x", domain: [1, 3] } }] };
    expect(classify(setMethod(withEnds as typeof base, 0, "manual"))[0].computed).toEqual({
      at: "x",
      domain: [1, 3],
    });
    expect(classify(setMethod(setMethod(base, 0, "manual"), 0, "natural_breaks"))[0].count).toBe(2);
    const categories = classify(setMethod(base, 0, "categories"))[0];
    expect(categories.classes).toBeUndefined();
    expect(categories.count).toBe(8);
    expect(classify(setMethod(base, 0, "equal_interval"))[0]).toMatchObject({
      method: "equal_interval",
      count: 4,
    });
  });
});

describe("classification targets", () => {
  it("every target of every geometry has its label in English and German", () => {
    for (const geometry of ["point", "line", "polygon"] as const)
      for (const key of classifyTargets(geometry)) {
        const label = `prop_${key.replace(/\./g, "_")}`;
        expect(en.style_editor, key).toHaveProperty(label);
        expect(de.style_editor, key).toHaveProperty(label);
      }
    expect(classifyTargets("point")).not.toContain("outline.dash");
    // Only polygon outlines run inside or outside their edge (spec 3.1).
    expect(classifyTargets("point")).not.toContain("outline.position");
    expect(classifyTargets("polygon")).toContain("outline.position");
    expect(classifyTargets("line")).toContain("label.transform");
    // The Font sets the weight and the style as one choice: the style is no target of its own.
    expect(classifyTargets("point")).toContain("label.font.weight");
    expect(classifyTargets("point")).not.toContain("label.font.style");
    // Letter spacing, like the label's width and offset, is a class's own setting, not a classification's target.
    expect(classifyTargets("polygon")).not.toContain("label.letter_spacing");
    // A class draws hollow markers with the Fill switch in its scope.
    expect(classifyTargets("point")).not.toContain("marker.fill");
    expect(classifyTargets("polygon").slice(0, 2)).toEqual(["fill.color", "fill.opacity"]);
  });
});

describe("scoped view", () => {
  it("merges the class's parts over the base and writes into its record", () => {
    const d = doc({
      symbol: {
        fill: { color: "#cccccc", opacity: 0.8 },
        outline: { color: "#ffffff" },
        label: { halo: { width: 1 } },
      },
      classify: [
        {
          id: "c",
          field: "f",
          method: "categories",
          classes: [
            {
              values: ["a"],
              fill: { color: "#ff0000" },
              outline: false,
              label: { halo: { color: "#000000" } },
            },
          ],
          other: { name: "Other" },
        },
      ],
    });
    const view = scopedView(d, { classify: 0, key: 0 });
    expect(view.read("symbol.fill")).toEqual({ color: "#ff0000", opacity: 0.8 });
    expect(view.read("symbol.outline")).toBe(false);
    expect(view.read("symbol.label.halo")).toEqual({ width: 1, color: "#000000" });
    expect(view.writePath("symbol.fill.color")).toBe("classify.0.classes.0.fill.color");
    expect(view.overridden("symbol.fill.color")).toBe(true);
    expect(view.overridden("symbol.fill.opacity")).toBe(false);
    expect(scopedView(d, { classify: 0, key: "other" }).writePath("symbol.fill.color")).toBe(
      "classify.0.other.fill.color"
    );
  });
});

describe("classifyCount", () => {
  const raster = (render: object) => ({ version: "1.0.0", kind: "raster", render }) as unknown as LayerStyle;
  const classes = [{ to: 10 }, { from: 10, to: 20, visible: false }, { from: 20 }];

  it("counts a vector style's classifications", () => {
    expect(classifyCount(classified())).toBe(1);
    expect(classifyCount(doc())).toBe(0);
  });

  it("counts a raster's classes and categories, hidden ones too", () => {
    expect(
      classifyCount(
        raster({ type: "continuous", palette: "goat:elevation", classify: { method: "manual", classes } })
      )
    ).toBe(3);
    expect(
      classifyCount(
        raster({
          type: "categorical",
          classes: [{ value: 1 }, { value: 2, visible: false }],
        })
      )
    ).toBe(2);
    expect(
      classifyCount(
        raster({ type: "hillshade", palette: "goat:elevation", classify: { method: "manual", classes } })
      )
    ).toBe(3);
  });

  it("a classification whose classes are still computed counts its count", () => {
    expect(
      classifyCount(
        raster({
          type: "continuous",
          palette: "goat:elevation",
          classify: { method: "equal_interval", count: 5 },
        })
      )
    ).toBe(5);
  });

  it("own stops, shading without colors and an image have no classes", () => {
    const stops = [
      { value: 0, color: "#000000" },
      { value: 9, color: "#ffffff" },
    ];
    expect(classifyCount(raster({ type: "continuous", stops, classify: { classes } }))).toBe(0);
    expect(classifyCount(raster({ type: "hillshade", classify: { method: "manual", classes } }))).toBe(0);
    expect(classifyCount(raster({ type: "image", classes: [{ value: 1 }] }))).toBe(0);
  });
});
