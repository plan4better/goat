import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { moveClassification } from "@/lib/style/editor/classify";
import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type SaveResult, StyleSaver, type StyleTransport } from "@/lib/style/save";

const doc = (extra: object = {}) =>
  ({
    version: 1,
    kind: "vector",
    symbol: { fill: { color: "#cccccc", opacity: 0.5 }, outline: { width: 1 } },
    ...extra,
  }) as LayerStyle;

/** A transport whose answers the test hands out one by one. */
function fakeTransport() {
  const saves: LayerStyle[] = [];
  const resolvers: Array<(r: SaveResult) => void> = [];
  const transport: StyleTransport = {
    save: (body) => {
      saves.push(body.document);
      return new Promise((resolve) => resolvers.push(resolve));
    },
    load: async () => ({ document: doc(), revision: 1 }),
  };
  const ok = async (document: LayerStyle, revision: number) => {
    resolvers.shift()?.({ ok: true, document, revision, issues: [] });
    await vi.advanceTimersByTimeAsync(0);
  };
  return { transport, saves, ok };
}

const storeOf = (document: LayerStyle = doc()) => {
  const t = fakeTransport();
  const saver = new StyleSaver({ transport: t.transport, document, revision: 1 });
  return { store: new EditorStore({ saver }), saver, t };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EditorStore", () => {
  it("set and get by path, numeric segments index arrays", () => {
    const { store } = storeOf(
      doc({ classify: [{ field: "a", method: "categories", classes: [{ values: ["x"] }] }] })
    );
    store.set("classify.0.classes.0.fill.color", "#ff0000");
    expect(store.get("classify.0.classes.0")).toEqual({ values: ["x"], fill: { color: "#ff0000" } });
    store.set("rules.0.visible", false);
    expect(store.get("rules")).toEqual([{ visible: false }]);
    expect(store.get("symbol.fill.color")).toBe("#cccccc");
    expect(store.get("")).toBe(store.document);
  });

  it("undefined deletes and prunes empty parents, but an emptied part stays on (spec 3)", () => {
    const { store } = storeOf({
      version: 1,
      kind: "vector",
      symbol: { fill: { color: "#cccccc" } },
      legend: { title: "x" },
    } as LayerStyle);
    store.set("symbol.fill.color", undefined);
    store.set("legend.title", undefined);
    expect(store.document).toEqual({ version: 1, kind: "vector", symbol: { fill: {} } });
  });

  it("a raster's emptied no_data goes: only a classification's other and no_data are kept", () => {
    const { store } = storeOf({
      version: 1,
      kind: "raster",
      render: { type: "continuous", domain: [0, 9], no_data: { values: [-9999] } },
    } as unknown as LayerStyle);
    store.set("render.no_data.values", undefined);
    expect(store.get("render")).toEqual({ type: "continuous", domain: [0, 9] });
  });

  it("emptying a key keeps parts, other, no_data and class positions", () => {
    const { store } = storeOf({
      version: 1,
      kind: "vector",
      symbol: { line: { color: "#000000" }, arrows: { color: "#ff0000" }, casing: { min_zoom: 12 } },
      classify: [
        {
          field: "a",
          method: "categories",
          classes: [{ name: "x" }, { values: ["y"], casing: { color: "#00ff00" } }],
          other: { visible: false },
          no_data: { line: { color: "#999999" } },
        },
      ],
    } as LayerStyle);
    store.set("symbol.arrows.color", undefined);
    store.set("symbol.casing.min_zoom", undefined);
    store.set("classify.0.classes.0.name", undefined);
    store.set("classify.0.classes.1.casing.color", undefined);
    store.set("classify.0.other.visible", undefined);
    store.set("classify.0.no_data.line.color", undefined);
    expect(store.get("symbol.arrows")).toEqual({});
    expect(store.get("symbol.casing")).toEqual({});
    expect(store.get("classify.0.classes")).toEqual([{}, { values: ["y"], casing: {} }]);
    expect(store.get("classify.0.other")).toEqual({});
    expect(store.get("classify.0.no_data")).toEqual({ line: {} });
    // Removing an item itself still takes it out.
    store.set("classify.0.classes.0", undefined);
    expect(store.get("classify.0.classes")).toEqual([{ values: ["y"], casing: {} }]);
  });

  it("unchanged subtrees keep their identity", () => {
    const { store } = storeOf();
    const outline = store.get("symbol.outline");
    store.set("symbol.fill.color", "#ff0000");
    expect(store.get("symbol.outline")).toBe(outline);
    expect(store.get("symbol.fill.color")).toBe("#ff0000");
  });

  it("undo coalesces edits of one path within 600 ms", async () => {
    const { store } = storeOf();
    store.set("symbol.fill.opacity", 0.6);
    await vi.advanceTimersByTimeAsync(200);
    store.set("symbol.fill.opacity", 0.7);
    await vi.advanceTimersByTimeAsync(200);
    store.set("symbol.fill.opacity", 0.8);
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.get("symbol.fill.opacity")).toBe(0.5);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.get("symbol.fill.opacity")).toBe(0.8);
  });

  it("a save reply's computed classes arrive without an undo step", async () => {
    const { store, t } = storeOf(doc({ classify: [{ field: "density", method: "quantile", count: 2 }] }));
    store.set("classify.0.count", 3);
    store.saver.saveNow();
    const classes = [{ to: 10 }, { from: 10, to: 20 }, { from: 20 }];
    const reply = doc({ classify: [{ field: "density", method: "quantile", count: 3, classes }] });
    await t.ok(reply, 2);
    expect(store.get("classify.0.classes")).toEqual(classes);
    store.undo();
    expect(store.get("classify.0.count")).toBe(2);
    expect(store.canUndo).toBe(false);
  });

  it("a reply during a drag keeps the user's value", async () => {
    const { store, t } = storeOf(doc({ classify: [{ field: "a", method: "quantile", count: 3 }] }));
    store.set("classify.0.field", "b");
    store.saver.saveNow();
    store.set("symbol.fill.opacity", 0.3);
    const classes = [{ to: 1 }, { from: 1, to: 2 }, { from: 2 }];
    const reply = doc({ classify: [{ field: "b", method: "quantile", count: 3, classes }] });
    (reply as unknown as { symbol: { fill: { opacity: number } } }).symbol.fill.opacity = 0.8;
    await t.ok(reply, 2);
    expect(store.get("symbol.fill.opacity")).toBe(0.3);
    expect(store.get("classify.0.classes")).toEqual(classes);
  });

  it("undo after classes arrived restores the intent", async () => {
    const classesA = [{ to: 5 }, { from: 5 }];
    const { store, t } = storeOf(
      doc({ classify: [{ field: "a", method: "quantile", count: 2, classes: classesA }] })
    );
    store.set("classify.0.field", "b");
    store.saver.saveNow();
    const classesB = [{ to: 100 }, { from: 100 }];
    await t.ok(doc({ classify: [{ field: "b", method: "quantile", count: 2, classes: classesB }] }), 2);
    expect(store.get("classify.0.classes")).toEqual(classesB);
    store.undo();
    expect(store.get("classify.0.field")).toBe("a");
    expect(store.get("classify.0.classes")).toEqual(classesA);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.saves).toHaveLength(2);
    expect((t.saves[1] as unknown as { classify: Array<{ field: string }> }).classify[0].field).toBe("a");
  });

  it("a disposed store follows the saver again once subscribed (React remounts the shell)", async () => {
    const { store, t } = storeOf();
    store.dispose();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set("classify", [{ id: "d", field: "density", method: "quantile", count: 2 }]);
    await t.ok(
      doc({
        classify: [
          { id: "d", field: "density", method: "quantile", count: 2, classes: [{ to: 1 }, { from: 1 }] },
        ],
      }),
      2
    );
    expect(store.get("classify.0.classes")).toHaveLength(2);
  });

  it("dispose leaves other subscribers alone", () => {
    const { store } = storeOf();
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispose();
    store.set("symbol.fill.color", "#ff0000");
    expect(listener).toHaveBeenCalled();
  });

  it("a scope follows its class by id when classifications move or a reply reorders the classes", () => {
    const c1 = { id: "c1", values: ["p"] };
    const c2 = { id: "c2", values: ["q"] };
    const { store } = storeOf(
      doc({
        classify: [
          { id: "a", field: "kind", method: "categories", classes: [{ id: "x1", values: ["x"] }] },
          { id: "b", field: "status", method: "categories", classes: [c1, c2] },
        ],
      })
    );
    store.setScope({ classify: 1, key: 1 });
    store.update((d) => moveClassification(d, 1, 0));
    expect(store.scope).toEqual({ classify: 0, key: 1 });
    store.set("classify.0.classes", [c2, c1]);
    expect(store.scope).toEqual({ classify: 0, key: 0 });
    store.set("classify.0.classes", [c1]);
    expect(store.scope).toBeNull();
  });

  it("a rule scope follows its rule by id and ends when the rule goes", () => {
    const rule = (id: string) => ({ id, when: { op: "isNull", args: [{ property: "name" }] } });
    const { store } = storeOf(doc({ rules: [rule("r1"), rule("r2")] }));
    store.setScope({ rule: "r2", index: 1 });
    store.set("rules", [rule("r2"), rule("r1")]);
    expect(store.scope).toEqual({ rule: "r2", index: 0 });
    store.set("rules", [rule("r1")]);
    expect(store.scope).toBeNull();
  });

  it("tells subscribers about edits and the scope", () => {
    const { store } = storeOf();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set("symbol.fill.color", "#000000");
    store.setScope({ classify: 0, key: 1 });
    expect(store.scope).toEqual({ classify: 0, key: 1 });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.set("symbol.fill.color", "#111111");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
