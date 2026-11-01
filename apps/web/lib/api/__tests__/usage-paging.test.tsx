import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCreditBreakdown, useOrgProjects, useStorageLayers } from "@/lib/api/usage";

/** The fetcher's pending answers, by the query's offset or grouping. */
const { fetcherMock, pending } = vi.hoisted(() => {
  const pending = new Map<string, (value: unknown) => void>();
  return {
    pending,
    fetcherMock: vi.fn(
      ([, query]: [string, Record<string, unknown>]) =>
        new Promise((resolve) => pending.set(String(query.group_by ?? query.offset), resolve))
    ),
  };
});
vi.mock("@/lib/api/fetcher", () => ({ fetcher: fetcherMock, apiRequestAuth: vi.fn() }));

// A cache of its own per test, and no deduping of the same key.
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const answer = async (key: string, value: unknown) => {
  await waitFor(() => expect(pending.has(key)).toBe(true));
  await act(async () => {
    pending.get(key)?.(value);
    pending.delete(key);
  });
};

const page = (offset: number) => ({
  rows: [{ name: `Row ${offset}` }],
  total: 48,
  trash: { count: 0, size_mb: 0 },
  split: { in_projects_mb: 0, unused_mb: 0, trash_mb: 0 },
});

beforeEach(() => {
  pending.clear();
  fetcherMock.mockClear();
});

describe("server-paged usage lists", () => {
  it("keep the page in sight while the next one loads", async () => {
    const { result, rerender } = renderHook(
      ({ offset }) => useStorageLayers({ sort: "size", dir: "desc", limit: 10, offset }),
      { wrapper, initialProps: { offset: 0 } }
    );
    expect(result.current.storage).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    await answer("0", page(0));
    expect(result.current.storage?.rows).toEqual([{ name: "Row 0" }]);

    rerender({ offset: 10 });
    await waitFor(() => expect(pending.has("10")).toBe(true));
    // Loading, with the last page still there to show.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.storage?.rows).toEqual([{ name: "Row 0" }]);
    await answer("10", page(10));
    expect(result.current.storage?.rows).toEqual([{ name: "Row 10" }]);
    expect(result.current.isLoading).toBe(false);
  });

  it("keep the projects' page too", async () => {
    const { result, rerender } = renderHook(({ offset }) => useOrgProjects({ limit: 10, offset }), {
      wrapper,
      initialProps: { offset: 0 },
    });
    await answer("0", { rows: [{ name: "Plan A" }], total: 12 });
    rerender({ offset: 10 });
    await waitFor(() => expect(pending.has("10")).toBe(true));
    expect(result.current.projects?.rows).toEqual([{ name: "Plan A" }]);
  });

  it("keep a page of the same grouping only", async () => {
    const workflows = { group_by: "workflow", since: null, until: null, total: 1, rows: [{ key: "w1" }] };
    const { result, rerender } = renderHook(
      ({ group, offset }: { group: "workflow" | "layer"; offset: number }) =>
        useCreditBreakdown(group, { limit: 10, offset }),
      { wrapper, initialProps: { group: "workflow", offset: 0 } }
    );
    await answer("workflow", workflows);
    expect(result.current.breakdown?.rows).toEqual([{ key: "w1" }]);

    // Another page of workflows: the rows stay.
    rerender({ group: "workflow", offset: 10 });
    await waitFor(() => expect(fetcherMock).toHaveBeenCalledTimes(2));
    expect(result.current.breakdown?.rows).toEqual([{ key: "w1" }]);
    await answer("workflow", { ...workflows, rows: [{ key: "w11" }] });

    // The layers: no workflow rows under the layers' columns.
    rerender({ group: "layer", offset: 0 });
    await waitFor(() => expect(pending.has("layer")).toBe(true));
    expect(result.current.breakdown).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    await answer("layer", { ...workflows, group_by: "layer", rows: [{ key: "l1" }] });
    expect(result.current.breakdown?.rows).toEqual([{ key: "l1" }]);
  });

  it("do not keep the rows of a list read whole: a chart keeps no days of another range", async () => {
    const { result, rerender } = renderHook(({ since }) => useCreditBreakdown("member", { since }), {
      wrapper,
      initialProps: { since: "2026-10-01T00:00:00.000Z" },
    });
    await answer("member", { group_by: "member", since: null, until: null, total: 1, rows: [{ key: "a" }] });
    expect(result.current.breakdown?.rows).toEqual([{ key: "a" }]);
    rerender({ since: "2026-11-01T00:00:00.000Z" });
    await waitFor(() => expect(pending.has("member")).toBe(true));
    expect(result.current.breakdown).toBeUndefined();
  });
});
