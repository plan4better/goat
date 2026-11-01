import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useLocalList } from "@/hooks/settings/useLocalList";

const rows = Array.from({ length: 23 }, (_, i) => ({ name: `Tool ${i}`, credits: i }));

describe("useLocalList", () => {
  it("pages, sorts and searches", () => {
    const { result } = renderHook(() =>
      useLocalList(rows, { search: (r) => r.name, query: "", sort: { key: "credits", dir: "desc" }, page: 3 })
    );
    expect(result.current.total).toBe(23);
    expect(result.current.pageCount).toBe(3);
    expect(result.current.pageRows.map((r) => r.credits)).toEqual([2, 1, 0]);
  });

  it("clamps the page when a search leaves fewer pages", () => {
    const { result } = renderHook(() =>
      useLocalList(rows, {
        search: (r) => r.name,
        query: "tool 2",
        sort: { key: "name", dir: "asc" },
        page: 3,
      })
    );
    expect(result.current.pageCount).toBe(1);
    expect(result.current.page).toBe(1);
    expect(result.current.pageRows.map((r) => r.name)).toEqual(["Tool 2", "Tool 20", "Tool 21", "Tool 22"]);
  });

  it("returns the page it shows, so the range text and the pager follow it", () => {
    const { result } = renderHook(() =>
      useLocalList(rows, { query: "", sort: { key: "credits", dir: "asc" }, page: 2 })
    );
    expect(result.current.page).toBe(2);
    const below = renderHook(() =>
      useLocalList(rows, { query: "", sort: { key: "credits", dir: "asc" }, page: 0 })
    );
    expect(below.result.current.page).toBe(1);
  });

  it("ignores a blank search and the case of the search", () => {
    const { result } = renderHook(() =>
      useLocalList(rows, {
        search: (r) => r.name,
        query: "  ",
        sort: { key: "credits", dir: "asc" },
        page: 1,
      })
    );
    expect(result.current.total).toBe(23);
    const upper = renderHook(() =>
      useLocalList(rows, {
        search: (r) => r.name,
        query: " TOOL 1 ",
        sort: { key: "credits", dir: "asc" },
        page: 1,
      })
    );
    expect(upper.result.current.total).toBe(11);
  });

  it("keeps rows without a value last in both directions", () => {
    const people = [
      { name: "Bea", credits: 2 as number | null },
      { name: null as string | null, credits: 9 as number | null },
      { name: "anna", credits: null },
      { name: "Carl", credits: 5 },
    ];
    const sorted = (key: "name" | "credits", dir: "asc" | "desc") =>
      renderHook(() =>
        useLocalList(people, { query: "", sort: { key, dir }, page: 1 })
      ).result.current.pageRows.map((r) => r[key]);
    expect(sorted("credits", "asc")).toEqual([2, 5, 9, null]);
    expect(sorted("credits", "desc")).toEqual([9, 5, 2, null]);
    expect(sorted("name", "asc")).toEqual(["anna", "Bea", "Carl", null]);
    expect(sorted("name", "desc")).toEqual(["Carl", "Bea", "anna", null]);
  });

  it("takes a page size and has one empty page without rows", () => {
    const sized = renderHook(() =>
      useLocalList(rows, { query: "", sort: { key: "credits", dir: "asc" }, page: 2, pageSize: 20 })
    );
    expect(sized.result.current.pageCount).toBe(2);
    expect(sized.result.current.pageRows.map((r) => r.credits)).toEqual([20, 21, 22]);
    const none = renderHook(() =>
      useLocalList<{ name: string }>(undefined, { query: "x", sort: { key: "name", dir: "asc" }, page: 4 })
    );
    expect(none.result.current).toEqual({ pageRows: [], total: 0, pageCount: 1, page: 1 });
  });

  it("does not reorder the rows it is given", () => {
    const given = [{ credits: 1 }, { credits: 3 }, { credits: 2 }];
    renderHook(() => useLocalList(given, { query: "", sort: { key: "credits", dir: "desc" }, page: 1 }));
    expect(given.map((r) => r.credits)).toEqual([1, 3, 2]);
  });
});
