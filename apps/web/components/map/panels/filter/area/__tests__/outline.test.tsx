import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type FilterArea, type PolygonCoords, areaGeometry } from "@/lib/filter/area";

import {
  areaOutlineStore,
  showSavedArea,
  useAreaOutline,
  useShownAreaOutline,
} from "@/components/map/panels/filter/area/outline";

const square = (x: number, y: number, size = 1): PolygonCoords => [
  [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ],
];

const area = (polygons: PolygonCoords[], rest: Partial<FilterArea> = {}): FilterArea => ({
  pieces: [{ kind: "shape", polygons }],
  op: "inside",
  enabled: true,
  ...rest,
});

const shown = () => areaOutlineStore.getSnapshot();

const renderOutline = (initial: FilterArea | undefined) =>
  renderHook(({ area }: { area: FilterArea | undefined }) => useAreaOutline(area), {
    initialProps: { area: initial },
  });

describe("useAreaOutline", () => {
  afterEach(() => {
    expect(shown()).toBeNull();
  });

  it("shows the area's polygons while the caller is mounted", () => {
    const first = area([square(0, 0)]);
    const { unmount } = renderOutline(first);
    expect(shown()).toEqual({ geometry: areaGeometry(first), enabled: true });
    unmount();
    expect(shown()).toBeNull();
  });

  it("shows every piece as one geometry", () => {
    const both: FilterArea = {
      pieces: [
        { kind: "view", polygons: [square(0, 0)] },
        { kind: "shape", polygons: [square(5, 5)] },
      ],
      op: "outside",
      enabled: true,
    };
    const { unmount } = renderOutline(both);
    expect(shown()?.geometry).toEqual({ type: "MultiPolygon", coordinates: [square(0, 0), square(5, 5)] });
    unmount();
  });

  it("replaces the outline when the polygons change", () => {
    const { rerender, unmount } = renderOutline(area([square(0, 0)]));
    const before = shown();
    const next = area([square(0, 0), square(3, 3)]);
    rerender({ area: next });
    expect(shown()).not.toBe(before);
    expect(shown()?.geometry).toEqual(areaGeometry(next));
    unmount();
  });

  it("keeps the geometry when only the switch changes", () => {
    const polygons = [square(0, 0)];
    const { rerender, unmount } = renderOutline(area(polygons));
    const before = shown();
    rerender({ area: area(polygons, { enabled: false }) });
    expect(shown()?.enabled).toBe(false);
    expect(shown()?.geometry).toBe(before?.geometry);
    unmount();
  });

  it("tells nobody when the same polygons come in a new area", () => {
    const polygon = square(0, 0);
    const { rerender, unmount } = renderOutline(area([polygon]));
    const before = shown();
    const listener = vi.fn();
    const unsubscribe = areaOutlineStore.subscribe(listener);
    rerender({ area: area([polygon], { op: "outside" }) });
    expect(shown()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    unmount();
  });

  it("shows nothing for no area and for an area without polygons", () => {
    const { rerender, unmount } = renderOutline(undefined);
    expect(shown()).toBeNull();
    rerender({ area: area([]) });
    expect(shown()).toBeNull();
    rerender({ area: area([square(0, 0)]) });
    expect(shown()).not.toBeNull();
    rerender({ area: undefined });
    expect(shown()).toBeNull();
    unmount();
  });

  it("leaves another caller's outline when an earlier one unmounts", () => {
    const earlier = renderOutline(area([square(0, 0)]));
    const later = renderOutline(area([square(9, 9)]));
    earlier.unmount();
    expect(shown()?.geometry).toEqual({ type: "Polygon", coordinates: square(9, 9) });
    later.unmount();
  });
});

describe("areaOutlineStore", () => {
  it("shows a later owner's outline over an earlier one and gives it back when cleared", () => {
    const panel = {};
    const hover = {};
    act(() => areaOutlineStore.show(panel, area([square(0, 0)])));
    const before = shown();
    act(() => areaOutlineStore.show(hover, area([square(5, 5)])));
    expect(shown()?.geometry).toEqual({ type: "Polygon", coordinates: square(5, 5) });
    act(() => areaOutlineStore.clear(hover));
    expect(shown()).toBe(before);
    act(() => areaOutlineStore.clear(panel));
    expect(shown()).toBeNull();
  });

  it("keeps a later owner's outline on top when an earlier one changes", () => {
    const panel = {};
    const hover = {};
    act(() => areaOutlineStore.show(panel, area([square(0, 0)])));
    act(() => areaOutlineStore.show(hover, area([square(5, 5)])));
    act(() => areaOutlineStore.show(panel, area([square(1, 1)])));
    expect(shown()?.geometry).toEqual({ type: "Polygon", coordinates: square(5, 5) });
    act(() => areaOutlineStore.clear(hover));
    expect(shown()?.geometry).toEqual({ type: "Polygon", coordinates: square(1, 1) });
    act(() => areaOutlineStore.clear(panel));
  });
});

describe("showSavedArea", () => {
  const owner = {};
  afterEach(() => act(() => areaOutlineStore.clear(owner)));

  it("shows the area of a saved filter", () => {
    const cql = {
      op: "and",
      args: [
        { op: "s_intersects", args: [{ property: "geom" }, { type: "Polygon", coordinates: square(2, 2) }] },
        { op: "=", args: [{ property: "name" }, "a"] },
      ],
    };
    act(() => showSavedArea(owner, { cql }));
    expect(shown()?.geometry).toEqual({ type: "Polygon", coordinates: square(2, 2) });
  });

  it("shows nothing for a filter without an area", () => {
    act(() => showSavedArea(owner, { cql: { op: "=", args: [{ property: "name" }, "a"] } }));
    expect(shown()).toBeNull();
    act(() => showSavedArea(owner, null));
    expect(shown()).toBeNull();
  });
});

describe("useShownAreaOutline", () => {
  it("follows the store", () => {
    const { result } = renderHook(() => useShownAreaOutline());
    expect(result.current).toBeNull();
    const owner = {};
    act(() => areaOutlineStore.show(owner, area([square(1, 1)])));
    expect(result.current).toEqual({
      geometry: { type: "Polygon", coordinates: square(1, 1) },
      enabled: true,
    });
    act(() => areaOutlineStore.clear(owner));
    expect(result.current).toBeNull();
  });
});
