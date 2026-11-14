import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { FilterRow } from "@/lib/filter/model";

import { combineCqlFilters, useTableViewFilterController } from "@/hooks/useTableViewFilterController";

const FIELDS = { status: "string", height: "number" } as const;

const row = (partial: Partial<FilterRow>): FilterRow => ({
  id: "e1",
  field: "status",
  op: "is",
  value: "open",
  enabled: true,
  ...partial,
});

describe("useTableViewFilterController", () => {
  it("starts with nothing filtered and no query filter", () => {
    const { result } = renderHook(() => useTableViewFilterController(FIELDS));
    expect(result.current.controller.model.rows).toEqual([]);
    expect(result.current.cqlFilter).toBeUndefined();
  });

  it("adds a row and writes it as the filter's CQL for the query", () => {
    const { result } = renderHook(() => useTableViewFilterController(FIELDS));
    act(() => result.current.controller.upsert(row({})));

    expect(result.current.controller.model.rows).toHaveLength(1);
    expect(JSON.parse(result.current.cqlFilter!)).toEqual({
      op: "and",
      args: [{ op: "=", args: [{ property: "status" }, "open"] }],
    });
  });

  it("replaces by id rather than accumulating duplicates", () => {
    const { result } = renderHook(() => useTableViewFilterController(FIELDS));
    act(() => result.current.controller.upsert(row({ id: "e1", value: "open" })));
    act(() => result.current.controller.upsert(row({ id: "e1", value: "closed" })));

    expect(result.current.controller.model.rows).toHaveLength(1);
    expect((result.current.controller.model.rows[0] as FilterRow).value).toBe("closed");
  });

  it("keeps filters on different columns side by side, written with the fields' types", () => {
    const { result } = renderHook(() => useTableViewFilterController(FIELDS));
    act(() => result.current.controller.upsert(row({ id: "e1" })));
    act(() =>
      result.current.controller.upsert(row({ id: "e2", field: "height", op: "is_at_least", value: "5" }))
    );
    expect(result.current.controller.model.rows.map((r) => (r as FilterRow).field)).toEqual([
      "status",
      "height",
    ]);
    expect(JSON.parse(result.current.cqlFilter!).args[1]).toEqual({
      op: ">=",
      args: [{ property: "height" }, 5],
    });
  });

  it("removes one and clears all", () => {
    const { result } = renderHook(() => useTableViewFilterController(FIELDS));
    act(() => result.current.controller.upsert(row({ id: "e1" })));
    act(() => result.current.controller.upsert(row({ id: "e2", field: "height" })));

    act(() => result.current.controller.remove("e1"));
    expect(result.current.controller.model.rows.map((r) => r.id)).toEqual(["e2"]);

    act(() => result.current.clear());
    expect(result.current.controller.model.rows).toEqual([]);
    expect(result.current.cqlFilter).toBeUndefined();
  });

  it("matches all of its rows and hands its fields on", () => {
    const { result } = renderHook(() => useTableViewFilterController(FIELDS));
    expect(result.current.controller.model.match).toBe("all");
    expect(result.current.controller.fields).toBe(FIELDS);
  });

  it("can be marked read-only for viewers who may not filter", () => {
    const { result } = renderHook(() => useTableViewFilterController(FIELDS, { canEdit: false }));
    expect(result.current.controller.canEdit).toBe(false);
  });
});

describe("combineCqlFilters", () => {
  const author = JSON.stringify({ op: "=", args: [{ property: "city" }, "Hamburg"] });
  const viewer = JSON.stringify({ op: "=", args: [{ property: "status" }, "open"] });

  it("returns undefined when there is nothing to apply", () => {
    expect(combineCqlFilters(undefined, undefined)).toBeUndefined();
  });

  it("passes a single filter through untouched", () => {
    expect(combineCqlFilters(author, undefined)).toBe(author);
    expect(combineCqlFilters(undefined, viewer)).toBe(viewer);
  });

  it("ANDs the author's filter with the viewer's, narrowing rather than replacing", () => {
    const combined = JSON.parse(combineCqlFilters(author, viewer)!);
    expect(combined.op).toBe("and");
    expect(combined.args).toHaveLength(2);
    expect(combined.args[0]).toEqual(JSON.parse(author));
    expect(combined.args[1]).toEqual(JSON.parse(viewer));
  });
});
