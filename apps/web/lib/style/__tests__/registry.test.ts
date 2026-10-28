import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StyleStoreRegistry, editedLayersOf } from "@/lib/style/editor/registry";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { SaveResult, StyleTransport } from "@/lib/style/save";

const DOC = { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;
const KEY = { projectId: "p", layerProjectId: 5, styleId: "s1" };

function transport() {
  const saves: Array<{ base_rev: number; document: LayerStyle; keepalive: boolean }> = [];
  const resolvers: Array<(r: SaveResult) => void> = [];
  const t: StyleTransport = {
    save: (body, opts) => {
      saves.push({ ...body, keepalive: opts.keepalive });
      return new Promise((resolve) => resolvers.push(resolve));
    },
    load: async () => ({ document: DOC, revision: 1 }),
  };
  return { t, saves, answer: (r: SaveResult) => resolvers.shift()?.(r) };
}

describe("StyleStoreRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a store released during a save stays until the reply and the reply lands in the map cache", async () => {
    const { t, saves, answer } = transport();
    const stored = vi.fn();
    const registry = new StyleStoreRegistry({
      createTransport: () => t,
      onStored: stored,
      win: new EventTarget(),
    });
    const store = registry.acquire(KEY, { document: DOC, revision: 1 });
    expect(registry.acquire(KEY, { document: DOC, revision: 1 })).toBe(store);
    registry.release(KEY);
    store.set("symbol.fill.color", "#ff0000");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toHaveLength(1);
    registry.release(KEY);
    expect(registry.get(KEY)).toBe(store);
    const reply = { ...DOC, symbol: { fill: { color: "#ff0000" } } } as LayerStyle;
    answer({ ok: true, document: reply, revision: 2, issues: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(stored).toHaveBeenCalledTimes(1);
    expect(stored).toHaveBeenCalledWith(KEY, { document: reply, revision: 2, issues: [] });
    expect(registry.get(KEY)).toBeUndefined();
  });

  it("leaving with a save pending warns and sends it with keepalive", async () => {
    const { t, saves } = transport();
    const win = new EventTarget();
    const registry = new StyleStoreRegistry({ createTransport: () => t, win });
    const store = registry.acquire(KEY, { document: DOC, revision: 1 });
    store.set("symbol.fill.color", "#00ff00");
    const leaving = new Event("beforeunload", { cancelable: true });
    win.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    win.dispatchEvent(new Event("pagehide"));
    expect(saves).toEqual([
      { base_rev: 1, document: { ...DOC, symbol: { fill: { color: "#00ff00" } } }, keepalive: true },
    ]);
  });

  it("the map draws an open style from its store only while it is the layer's active style", () => {
    const { t } = transport();
    const registry = new StyleStoreRegistry({ createTransport: () => t, win: new EventTarget() });
    const store = registry.acquire(KEY, { document: DOC, revision: 1 });
    registry.acquire({ ...KEY, projectId: "other" }, { document: DOC, revision: 1 });
    const layers = [
      { id: 5, style: { id: "s1" } },
      { id: 6, style: { id: "s9" } },
    ];
    expect(editedLayersOf(registry, "p", layers)).toEqual([{ key: "5", store }]);
    expect(editedLayersOf(registry, "p", [{ id: 5, style: { id: "s2" } }])).toEqual([]);
  });
});
