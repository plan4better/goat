// The classes drawn in a map's view (spec 7.2 `legend.classes: view`): counted after a move ends, never during one,
// from the features the map drew on the layer's own MapLibre layers, and kept per map and layer for the legends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  subscribeViewPresence,
  viewCounted,
  viewPresence,
  watchViewPresence,
} from "@/lib/style/render/viewPresence";

const STAMP = { at: "2026-01-01T00:00:00Z", data: "synthetic:1", scope: "dataset" };

const kinds = (classes: "view" | "filter" | "all" = "view") => ({
  version: "1.0.0",
  kind: "vector",
  classify: [
    {
      id: "kind",
      field: "kind",
      method: "categories",
      classes: [
        { id: "c1", values: ["alpha"] },
        { id: "c2", values: ["beta"] },
      ],
      computed: { ...STAMP, other: false, no_data: false },
    },
  ],
  legend: { classes },
});

type Listener = () => void;

/** A map that draws invented features per MapLibre layer and tells when it moves and when its tiles are in. */
function fakeMap(drawn: Record<string, Array<Record<string, unknown>>>) {
  const listeners = new Map<string, Set<Listener>>();
  const map = {
    moving: false,
    tilesIn: true,
    queried: [] as string[],
    on: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    off: (type: string, listener: Listener) => listeners.get(type)?.delete(listener),
    once: (type: string, listener: Listener) => {
      const wrapped = () => {
        map.off(type, wrapped);
        listener();
      };
      map.on(type, wrapped);
    },
    fire: (type: string) => [...(listeners.get(type) ?? [])].forEach((listener) => listener()),
    listening: (type: string) => listeners.get(type)?.size ?? 0,
    isMoving: () => map.moving,
    loaded: () => map.tilesIn,
    getLayer: (id: string) => (id in drawn ? { id } : undefined),
    queryRenderedFeatures: (options: { layers: string[] }) => {
      map.queried.push(...options.layers);
      return options.layers.flatMap((id) => (drawn[id] ?? []).map((properties) => ({ properties })));
    },
  };
  return map;
}

const ids: Record<string, string[]> = { "1": ["1-fill", "1-outline"], "2": ["2-marker"], "3": ["3-marker"] };
const layerIds = (key: string) => ids[key] ?? [];

const classesOf = (scope: string, key: string) => {
  const presence = viewPresence(scope, key);
  return presence ? [...presence.kind.classes] : undefined;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("watchViewPresence", () => {
  it("counts after a move ends, on the layer's own MapLibre layers", () => {
    const map = fakeMap({
      "1-fill": [{ kind: "beta" }],
      "1-outline": [{ kind: "beta" }],
      "9-fill": [{ kind: "alpha" }],
    });
    const watch = watchViewPresence(map, "main", () => [{ key: "1", style: kinds() }], { layerIds });
    map.fire("moveend");
    expect(map.queried).toEqual([]);
    vi.runAllTimers();
    expect(map.queried).toEqual(["1-fill", "1-outline"]);
    expect(classesOf("main", "1")).toEqual(["c2"]);
    watch.dispose();
  });

  it("stops querying once every class was seen", () => {
    const map = fakeMap({ "1-fill": [{ kind: "alpha" }, { kind: "beta" }], "1-outline": [{ kind: "beta" }] });
    const watch = watchViewPresence(map, "main", () => [{ key: "1", style: kinds() }], { layerIds });
    watch.refresh();
    vi.runAllTimers();
    expect(map.queried).toEqual(["1-fill"]);
    expect(classesOf("main", "1")).toEqual(["c1", "c2"]);
    watch.dispose();
  });

  it("does not count while the map moves: a new move cancels, a moving map waits for its moveend", () => {
    const map = fakeMap({ "1-fill": [{ kind: "alpha" }] });
    const watch = watchViewPresence(map, "main", () => [{ key: "1", style: kinds() }], { layerIds });
    map.fire("moveend");
    map.fire("movestart");
    vi.runAllTimers();
    expect(map.queried).toEqual([]);
    map.moving = true;
    watch.refresh();
    vi.runAllTimers();
    expect(map.queried).toEqual([]);
    map.moving = false;
    map.fire("moveend");
    vi.runAllTimers();
    expect(map.queried).toEqual(["1-fill"]);
    watch.dispose();
  });

  it("waits for the tiles of the new view before counting", () => {
    const map = fakeMap({ "1-fill": [{ kind: "alpha" }] });
    const watch = watchViewPresence(map, "main", () => [{ key: "1", style: kinds() }], { layerIds });
    map.tilesIn = false;
    map.fire("moveend");
    map.fire("moveend");
    vi.runAllTimers();
    expect(map.queried).toEqual([]);
    expect(map.listening("idle")).toBe(1);
    map.tilesIn = true;
    map.fire("idle");
    expect(map.queried).toEqual(["1-fill"]);
    watch.dispose();
  });

  it("leaves layers whose legend lists every class or the filter's alone", () => {
    const map = fakeMap({ "1-fill": [{ kind: "alpha" }], "2-marker": [{ kind: "alpha" }], "3-marker": [] });
    const layers = [
      { key: "1", style: kinds("filter") },
      { key: "2", style: kinds("all") },
      { key: "3", style: kinds() },
    ];
    const watch = watchViewPresence(map, "main", () => layers, { layerIds });
    watch.refresh();
    vi.runAllTimers();
    expect(map.queried).toEqual(["3-marker"]);
    expect(classesOf("main", "1")).toBeUndefined();
    expect(classesOf("main", "3")).toEqual([]);
    // Switched away from `view`: its counts go.
    layers[2] = { key: "3", style: kinds("all") };
    watch.refresh();
    vi.runAllTimers();
    expect(classesOf("main", "3")).toBeUndefined();
    watch.dispose();
  });

  it("tells until a map's first count that its legends wait, and tells when it has counted", () => {
    const map = fakeMap({});
    const heard = vi.fn();
    const unsubscribe = subscribeViewPresence(heard);
    expect(viewCounted("first")).toBe(false);
    const watch = watchViewPresence(map, "first", () => [], { layerIds });
    watch.refresh();
    vi.runAllTimers();
    // No layer of it lists the classes in view: its listeners still hear the map has counted.
    expect(viewCounted("first")).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    watch.dispose();
    expect(viewCounted("first")).toBe(false);
    unsubscribe();
  });

  it("keeps each map's counts apart, tells listeners of changes only, and forgets them when it stops", () => {
    const main = fakeMap({ "1-fill": [{ kind: "alpha" }] });
    const print = fakeMap({ "1-fill": [{ kind: "beta" }] });
    const heard = vi.fn();
    const unsubscribe = subscribeViewPresence(heard);
    const a = watchViewPresence(main, "main", () => [{ key: "1", style: kinds() }], { layerIds });
    const b = watchViewPresence(print, "print:p1", () => [{ key: "1", style: kinds() }], { layerIds });
    a.refresh();
    b.refresh();
    vi.runAllTimers();
    expect(classesOf("main", "1")).toEqual(["c1"]);
    expect(classesOf("print:p1", "1")).toEqual(["c2"]);
    expect(heard).toHaveBeenCalledTimes(2);
    a.refresh();
    vi.runAllTimers();
    expect(heard).toHaveBeenCalledTimes(2);
    b.dispose();
    expect(classesOf("print:p1", "1")).toBeUndefined();
    expect(print.listening("moveend")).toBe(0);
    a.dispose();
    unsubscribe();
  });
});
