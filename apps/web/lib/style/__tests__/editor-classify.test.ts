import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import {
  NO_DATA_COLOR,
  addCategoryClass,
  addClassification,
  categoryValue,
  classesPending,
  classifyTargets,
  isIntentEdit,
  moveCategoryValue,
  moveClassification,
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
  ({ version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } }, ...extra }) as LayerStyle;
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

  it("reads a value as the field's type", () => {
    expect(categoryValue("42", "integer")).toBe(42);
    expect(categoryValue("2.5", "number")).toBe(2.5);
    expect(categoryValue("true", "boolean")).toBe(true);
    expect(categoryValue("0042", "string")).toBe("0042");
    expect(categoryValue("x", "integer")).toBe("x");
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
