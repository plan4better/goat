import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StyleStoreRegistry, editedLayersOf } from "@/lib/style/editor/registry";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { SaveResult, StyleTransport } from "@/lib/style/save";

const DOC = { version: "1.0.0", kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;
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

describe("StyleStoreRegistry.settle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const KEY2 = { ...KEY, styleId: "s2" };
  const color = (value: string) => ({ ...DOC, symbol: { fill: { color: value } } }) as LayerStyle;
  /** Tracks whether a promise has resolved, without awaiting it. */
  const track = (promise: Promise<void>) => {
    const state = { resolved: false };
    void promise.then(() => (state.resolved = true));
    return state;
  };
  /** Counts the subscriptions made on `target` and those taken back. */
  const countSubscriptions = (target: { subscribe: (listener: () => void) => () => void }) => {
    const counts = { on: 0, off: 0 };
    const subscribe = target.subscribe.bind(target);
    vi.spyOn(target, "subscribe").mockImplementation((listener) => {
      counts.on += 1;
      const off = subscribe(listener);
      return () => {
        counts.off += 1;
        off();
      };
    });
    return counts;
  };

  it("settle sends pending saves and resolves when their replies are in", async () => {
    const { t, saves, answer } = transport();
    const registry = new StyleStoreRegistry({ createTransport: () => t, win: new EventTarget() });
    const a = registry.acquire(KEY, { document: DOC, revision: 1 });
    const b = registry.acquire(KEY2, { document: DOC, revision: 1 });
    // b: a save in flight and an edit made meanwhile; a: an edit whose save waits for the debounce.
    b.set("symbol.fill.color", "#111111");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toHaveLength(1);
    b.set("symbol.fill.color", "#222222");
    a.set("symbol.fill.color", "#ff0000");
    const counts = [countSubscriptions(registry), countSubscriptions(a.saver), countSubscriptions(b.saver)];
    const settled = track(registry.settle());
    // a's save goes at once; b's next save waits for the reply in flight.
    expect(saves.map((save) => save.document)).toEqual([color("#111111"), color("#ff0000")]);
    answer({ ok: true, document: color("#111111"), revision: 2, issues: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toHaveLength(3);
    expect(saves[2]).toMatchObject({ base_rev: 2, document: color("#222222") });
    answer({ ok: true, document: color("#ff0000"), revision: 2, issues: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.resolved).toBe(false);
    answer({ ok: true, document: color("#222222"), revision: 3, issues: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.resolved).toBe(true);
    // Nothing is left behind: no timer, every subscription taken back.
    expect(vi.getTimerCount()).toBe(0);
    for (const count of counts) {
      expect(count.on).toBeGreaterThan(0);
      expect(count.off).toBe(count.on);
    }
  });

  it("settle resolves at once when nothing is pending", async () => {
    const { t, saves } = transport();
    const registry = new StyleStoreRegistry({ createTransport: () => t, win: new EventTarget() });
    await expect(registry.settle()).resolves.toBeUndefined();
    registry.acquire(KEY, { document: DOC, revision: 1 });
    const settled = track(registry.settle());
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.resolved).toBe(true);
    expect(saves).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settle resolves at once for a store that stopped saving, also when it stops during the wait", async () => {
    const { t, saves, answer } = transport();
    const registry = new StyleStoreRegistry({ createTransport: () => t, win: new EventTarget() });
    const store = registry.acquire(KEY, { document: DOC, revision: 1 });
    store.set("symbol.fill.color", "#ff0000");
    const waiting = track(registry.settle());
    expect(saves).toHaveLength(1);
    answer({ ok: false, status: 409, code: "base_too_old" });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.saver.status).toBe("stopped");
    expect(store.saver.pending).toBe(true);
    expect(waiting.resolved).toBe(true);
    // Stopped already: nothing is sent, nothing waited for.
    const again = track(registry.settle());
    await vi.advanceTimersByTimeAsync(0);
    expect(again.resolved).toBe(true);
    expect(saves).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settle resolves when the reply of a store nobody holds any more is in", async () => {
    const { t, answer } = transport();
    const registry = new StyleStoreRegistry({ createTransport: () => t, win: new EventTarget() });
    const store = registry.acquire(KEY, { document: DOC, revision: 1 });
    store.set("symbol.fill.color", "#ff0000");
    // The panel closed with the edit unsaved: the store stays for its save.
    registry.release(KEY);
    const settled = track(registry.settle());
    answer({ ok: true, document: color("#ff0000"), revision: 2, issues: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.get(KEY)).toBeUndefined();
    expect(settled.resolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settle gives up after the timeout and does not reject when a save fails", async () => {
    const { t, saves, answer } = transport();
    const registry = new StyleStoreRegistry({ createTransport: () => t, win: new EventTarget() });
    const store = registry.acquire(KEY, { document: DOC, revision: 1 });
    store.set("symbol.fill.color", "#ff0000");
    const counts = countSubscriptions(store.saver);
    const promise = registry.settle();
    const settled = track(promise);
    // The server fails; the saver retries and stays pending.
    answer({ ok: false, status: 500 });
    await vi.advanceTimersByTimeAsync(2999);
    expect(saves.length).toBeGreaterThan(1);
    expect(store.saver.pending).toBe(true);
    expect(settled.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBeUndefined();
    expect(counts.off).toBe(counts.on);
  });
});
