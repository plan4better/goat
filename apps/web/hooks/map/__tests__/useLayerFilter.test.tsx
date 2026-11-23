import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FilterModel } from "@/lib/filter/model";
import { readFilter } from "@/lib/filter/read";

import { FilterSaveError, useLayerFilter } from "@/hooks/map/useLayerFilter";

const { updateProjectLayer, mutate, role, queryables } = vi.hoisted(() => ({
  // One object, as SWR answers it on every render.
  queryables: { properties: { name: { type: "string" }, traffic: { type: "integer" } } },
  updateProjectLayer: vi.fn(),
  // SWR's mutate with optimistic data: runs the request and throws what it throws.
  mutate: vi.fn(async (run: () => Promise<unknown>) => run()),
  role: { current: "project-owner" as string | undefined },
}));

vi.mock("@/lib/api/projects", () => ({
  updateProjectLayer,
  useProjectLayers: () => ({ layers: [], mutate }),
  useProject: () => ({ project: { my_role: role.current } }),
}));
vi.mock("@/lib/api/layers", () => ({
  useLayerQueryables: () => ({ queryables, isLoading: false }),
}));

const p = (field: string) => ({ property: field });
const SAVED = {
  cql: {
    op: "and",
    args: [
      { op: "=", args: [p("name"), "Main"] },
      { op: ">", args: [p("traffic"), 10] },
    ],
  },
  ui: { v: 1, off: [{ at: 2, cql: { op: "=", args: [p("name"), "Side"] } }] },
};
const layer = (query: unknown) => ({ id: 7, layer_id: "dataset-7", query }) as never;
const FIELDS = { name: "string", traffic: "integer" } as const;

describe("useLayerFilter", () => {
  beforeEach(() => {
    updateProjectLayer.mockReset();
    updateProjectLayer.mockResolvedValue({});
    mutate.mockClear();
    role.current = "project-owner";
  });

  it("reads the saved filter with the layer's fields, the same model on every render", () => {
    const { result, rerender } = renderHook(() => useLayerFilter("p1", layer(SAVED)));
    expect(result.current.fields).toEqual(FIELDS);
    expect(result.current.model).toEqual(readFilter(SAVED.cql, SAVED.ui, FIELDS));
    const first = result.current.model;
    rerender();
    expect(result.current.model).toBe(first);
    expect(result.current.canEdit).toBe(true);
  });

  it("sends nothing for a model that writes the saved filter", async () => {
    const { result } = renderHook(() => useLayerFilter("p1", layer(SAVED)));
    await act(() => result.current.apply(result.current.model));
    expect(updateProjectLayer).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("sends one request with the written CQL and notes for a changed model", async () => {
    const { result } = renderHook(() => useLayerFilter("p1", layer(SAVED)));
    const model = result.current.model;
    const changed: FilterModel = {
      ...model,
      rows: model.rows.map((r, i) => (i === 0 ? { ...r, value: "High" } : r)),
    };
    await act(() => result.current.apply(changed));
    expect(updateProjectLayer).toHaveBeenCalledTimes(1);
    expect(updateProjectLayer).toHaveBeenCalledWith("p1", 7, {
      query: {
        cql: {
          op: "and",
          args: [
            { op: "=", args: [p("name"), "High"] },
            { op: ">", args: [p("traffic"), 10] },
          ],
        },
        ui: SAVED.ui,
      },
    });
  });

  it("leaves out notes it has none of, and sends no query for no rows", async () => {
    const { result } = renderHook(() => useLayerFilter("p1", layer(SAVED)));
    const model = result.current.model;
    await act(() => result.current.apply({ ...model, rows: model.rows.filter((r) => r.enabled) }));
    expect(updateProjectLayer).toHaveBeenLastCalledWith("p1", 7, { query: { cql: SAVED.cql } });
    await act(() => result.current.apply({ match: "all", rows: [] }));
    expect(updateProjectLayer).toHaveBeenLastCalledWith("p1", 7, { query: null });
  });

  it("sends a stored metadata back and drops notes the rows no longer have", async () => {
    const { result } = renderHook(() => useLayerFilter("p1", layer({ ...SAVED, metadata: { a: 1 } })));
    const model = result.current.model;
    await act(() => result.current.apply({ ...model, rows: model.rows.filter((r) => r.enabled) }));
    expect(updateProjectLayer).toHaveBeenLastCalledWith("p1", 7, {
      query: { metadata: { a: 1 }, cql: SAVED.cql },
    });
  });

  it("an unchanged empty filter sends nothing", async () => {
    const { result } = renderHook(() => useLayerFilter("p1", layer(null)));
    await act(() => result.current.apply({ match: "all", rows: [] }));
    expect(updateProjectLayer).not.toHaveBeenCalled();
  });

  it("a refused save throws the server's messages", async () => {
    updateProjectLayer.mockRejectedValue(
      Object.assign(new Error("Failed"), {
        status: 422,
        detail: [{ msg: "Value error, Invalid CQL query: too many conditions" }],
      })
    );
    const { result } = renderHook(() => useLayerFilter("p1", layer(SAVED)));
    const error = await result.current.apply({ match: "all", rows: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FilterSaveError);
    expect((error as FilterSaveError).messages).toEqual(["Invalid CQL query: too many conditions"]);
  });

  it("a viewer may not edit", () => {
    role.current = "project-viewer";
    const { result } = renderHook(() => useLayerFilter("p1", layer(SAVED)));
    expect(result.current.canEdit).toBe(false);
  });

  it("names a row on a field the layer no longer has", () => {
    const cql = { op: "and", args: [{ op: "=", args: [p("gone"), "x"] }] };
    const { result } = renderHook(() => useLayerFilter("p1", layer({ cql })));
    expect(result.current.issues.rows.r0).toEqual([{ code: "unknown_field", field: "gone" }]);
  });
});
