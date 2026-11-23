import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type PolygonCoords, areaSum } from "@/lib/filter/area";

import { useLayerTableFilter } from "@/hooks/map/useLayerTableFilter";

const { updateProjectLayer, mutate, queryables, loading } = vi.hoisted(() => ({
  queryables: { properties: { name: { type: "string" }, traffic: { type: "integer" } } },
  updateProjectLayer: vi.fn(),
  mutate: vi.fn(async (run: () => Promise<unknown>) => run()),
  loading: { current: false },
}));

vi.mock("@/lib/api/projects", () => ({
  updateProjectLayer,
  useProjectLayers: () => ({ layers: [], mutate }),
  useProject: () => ({ project: { my_role: "project-owner" } }),
}));
vi.mock("@/lib/api/layers", () => ({
  useLayerQueryables: () =>
    loading.current ? { queryables: undefined, isLoading: true } : { queryables, isLoading: false },
}));

const p = (field: string) => ({ property: field });
const RING: PolygonCoords = [
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ],
];
const AREA = { op: "s_intersects", args: [p("geom"), { type: "Polygon", coordinates: RING }] };
const AREA_NOTES = { pieces: [{ kind: "shape", n: 1 }], sum: areaSum([RING]) };
const OFF = { op: ">", args: [p("traffic"), 10] };
// The area, a condition, and a switched-off row kept in the notes.
const SAVED = {
  cql: { op: "and", args: [AREA, { op: "=", args: [p("name"), "Main"] }] },
  ui: { v: 1, area: AREA_NOTES, off: [{ at: 1, cql: OFF }] },
  metadata: { source: "kept" },
};
const layer = { id: 7, layer_id: "dataset-7", query: SAVED } as never;

describe("useLayerTableFilter", () => {
  beforeEach(() => {
    updateProjectLayer.mockReset();
    updateProjectLayer.mockResolvedValue({});
    loading.current = false;
  });

  it("adds a column's row and sends the whole query: the area, the switched-off row and the metadata stay", async () => {
    const { result } = renderHook(() => useLayerTableFilter("p1", layer, true));
    await act(() =>
      result.current.upsert({ id: "new", field: "traffic", op: "is_at_least", value: 5, enabled: true })
    );
    expect(updateProjectLayer).toHaveBeenCalledTimes(1);
    expect(updateProjectLayer).toHaveBeenCalledWith("p1", 7, {
      query: {
        metadata: { source: "kept" },
        cql: {
          op: "and",
          args: [AREA, { op: "=", args: [p("name"), "Main"] }, { op: ">=", args: [p("traffic"), 5] }],
        },
        ui: SAVED.ui,
      },
    });
  });

  it("replaces a row by its id and removes one, the others as they were", async () => {
    const { result } = renderHook(() => useLayerTableFilter("p1", layer, true));
    await act(() =>
      result.current.upsert({ id: "r0", field: "name", op: "is", value: "Side", enabled: true })
    );
    expect(updateProjectLayer).toHaveBeenLastCalledWith("p1", 7, {
      query: {
        metadata: { source: "kept" },
        cql: { op: "and", args: [AREA, { op: "=", args: [p("name"), "Side"] }] },
        ui: SAVED.ui,
      },
    });
    await act(() => result.current.remove("r0"));
    expect(updateProjectLayer).toHaveBeenLastCalledWith("p1", 7, {
      query: {
        metadata: { source: "kept" },
        cql: { op: "and", args: [AREA] },
        ui: { v: 1, area: AREA_NOTES, off: [{ at: 0, cql: OFF }] },
      },
    });
  });

  it("gives the layer's fields and its rows", () => {
    const { result } = renderHook(() => useLayerTableFilter("p1", layer, true));
    expect(result.current.fields).toEqual({ name: "string", traffic: "integer" });
    // The area is the filter's own part, not a row.
    expect(result.current.model.rows).toHaveLength(2);
    expect(result.current.model.area?.pieces).toHaveLength(1);
  });

  it("may not edit while the fields load, nor for a user who may not edit the project", () => {
    loading.current = true;
    expect(renderHook(() => useLayerTableFilter("p1", layer, true)).result.current.canEdit).toBe(false);
    loading.current = false;
    expect(renderHook(() => useLayerTableFilter("p1", layer, false)).result.current.canEdit).toBe(false);
    expect(renderHook(() => useLayerTableFilter("p1", layer, true)).result.current.canEdit).toBe(true);
  });
});
