import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMapView } from "@/components/map/panels/filter/area/useMapView";

type Listener = () => void;

const { fakeMap } = vi.hoisted(() => {
  const listeners = new Set<Listener>();
  const fakeMap = {
    bounds: [10, 48, 12, 49] as number[],
    getBounds: () => ({
      toArray: () => [fakeMap.bounds.slice(0, 2), fakeMap.bounds.slice(2)],
    }),
    on: (_event: string, listener: Listener) => void listeners.add(listener),
    off: (_event: string, listener: Listener) => void listeners.delete(listener),
    moved: () => [...listeners].forEach((listener) => listener()),
    listening: () => listeners.size,
  };
  return { fakeMap };
});

const other = vi.hoisted(() => ({
  getBounds: () => ({
    toArray: () => [
      [1, 2],
      [3, 4],
    ],
  }),
  on: () => undefined,
  off: () => undefined,
}));

vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({ map: fakeMap, preview: other }) }));

describe("useMapView", () => {
  beforeEach(() => {
    fakeMap.bounds = [10, 48, 12, 49];
  });

  it("follows the map's view while it is watched", () => {
    const { result, unmount } = renderHook(() => useMapView(true));
    expect(result.current.bounds).toEqual([10, 48, 12, 49]);
    fakeMap.bounds = [11, 48, 13, 49];
    act(() => fakeMap.moved());
    expect(result.current.bounds).toEqual([11, 48, 13, 49]);
    unmount();
    expect(fakeMap.listening()).toBe(0);
  });

  it("keeps the view it has when a move ends where it began", () => {
    const { result } = renderHook(() => useMapView(true));
    const before = result.current.bounds;
    act(() => fakeMap.moved());
    expect(result.current.bounds).toBe(before);
  });

  it("reads the view on request without watching", () => {
    const { result } = renderHook(() => useMapView(false));
    expect(result.current.bounds).toBeUndefined();
    expect(fakeMap.listening()).toBe(0);
    expect(result.current.read()).toEqual([10, 48, 12, 49]);
  });

  it("reads the map it is given by its id", () => {
    const { result } = renderHook(() => useMapView(false, "preview"));
    expect(result.current.read()).toEqual([1, 2, 3, 4]);
  });
});
