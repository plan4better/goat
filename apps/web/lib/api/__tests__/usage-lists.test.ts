import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CREDITS_API_BASE_URL,
  downloadStorageCsv,
  downloadUsageCsv,
  useCreditBreakdown,
  useOrgProjects,
  useStorageLayers,
} from "@/lib/api/usage";

const { swrMock, apiRequestAuthMock } = vi.hoisted(() => ({
  swrMock: vi.fn((_key: unknown, _fetcher?: unknown) => ({})),
  apiRequestAuthMock: vi.fn(),
}));
vi.mock("@/lib/api/fetcher", () => ({ fetcher: vi.fn(), apiRequestAuth: apiRequestAuthMock }));
vi.mock("swr", () => ({
  default: (key: unknown, fetcher: unknown) => swrMock(key, fetcher),
  mutate: vi.fn(),
}));

const lastKey = () => swrMock.mock.calls[swrMock.mock.calls.length - 1][0];

describe("usage lists", () => {
  beforeEach(() => swrMock.mockClear());

  it("asks for one filtered page of layers, or nothing when not allowed", () => {
    renderHook(() => useStorageLayers({ unused: true, offset: 10, limit: 10 }));
    expect(lastKey()).toStrictEqual([
      `${CREDITS_API_BASE_URL}/storage-by-layer`,
      { unused: true, offset: 10, limit: 10 },
    ]);
    renderHook(() => useStorageLayers({ unused: true, offset: 10, limit: 10 }, false));
    expect(lastKey()).toBeNull();
  });

  it("leaves unset filters out of the request", () => {
    renderHook(() => useStorageLayers({ q: "", owner: undefined, type: "polygon", limit: 10, offset: 0 }));
    expect(lastKey()).toStrictEqual([
      `${CREDITS_API_BASE_URL}/storage-by-layer`,
      { type: "polygon", limit: 10, offset: 0 },
    ]);
  });

  it("asks for one page of the organization's projects, or nothing when not allowed", () => {
    renderHook(() => useOrgProjects({ q: "plan", sort: "updated", dir: "desc", limit: 10, offset: 0 }));
    expect(lastKey()).toStrictEqual([
      `${CREDITS_API_BASE_URL}/projects`,
      { q: "plan", sort: "updated", dir: "desc", limit: 10, offset: 0 },
    ]);
    renderHook(() => useOrgProjects({ limit: 10 }, false));
    expect(lastKey()).toBeNull();
  });

  it("asks for a breakdown of the range, or nothing when not allowed", () => {
    const since = "2026-10-31T00:00:00.000Z";
    renderHook(() => useCreditBreakdown("day", { since }));
    expect(lastKey()).toStrictEqual([`${CREDITS_API_BASE_URL}/breakdown`, { group_by: "day", since }]);
    renderHook(() => useCreditBreakdown("member", { since, member: undefined, until: undefined }));
    expect(lastKey()).toStrictEqual([`${CREDITS_API_BASE_URL}/breakdown`, { group_by: "member", since }]);
    renderHook(() => useCreditBreakdown("tool"));
    expect(lastKey()).toStrictEqual([`${CREDITS_API_BASE_URL}/breakdown`, { group_by: "tool" }]);
    renderHook(() => useCreditBreakdown("day", { since }, false));
    expect(lastKey()).toBeNull();
  });
});

describe("CSV downloads", () => {
  const clicked: { href: string; download: string }[] = [];
  const createObjectURL = vi.fn((_blob: Blob) => "blob:usage");
  const revokeObjectURL = vi.fn();
  let click: { mockRestore: () => void };

  beforeEach(() => {
    clicked.length = 0;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    apiRequestAuthMock.mockReset();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
  });
  afterEach(() => click.mockRestore());

  const csv = (headers: Record<string, string> = {}, status = 200) =>
    new Response("date,member\n2026-10-31,Anna", {
      status,
      headers: { "Content-Type": "text/csv", ...headers },
    });

  it("saves the export under the name core gives it", async () => {
    apiRequestAuthMock.mockResolvedValue(
      csv({ "Content-Disposition": 'attachment; filename="goat-usage-credits-2026-10-31-2026-11-21.csv"' })
    );
    await downloadUsageCsv("credits", { since: "2026-10-31T00:00:00.000Z", member: undefined });
    const url = new URL(apiRequestAuthMock.mock.calls[0][0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${CREDITS_API_BASE_URL}/usage/export`);
    expect(Object.fromEntries(url.searchParams)).toStrictEqual({
      kind: "credits",
      since: "2026-10-31T00:00:00.000Z",
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicked).toEqual([
      { href: "blob:usage", download: "goat-usage-credits-2026-10-31-2026-11-21.csv" },
    ]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:usage");
  });

  it("falls back to a plain name when the header is not readable", async () => {
    apiRequestAuthMock.mockResolvedValue(csv());
    await downloadUsageCsv("ai", {});
    expect(clicked.map((c) => c.download)).toEqual(["goat-usage.csv"]);
  });

  it("exports the filtered layers", async () => {
    apiRequestAuthMock.mockResolvedValue(
      csv({ "Content-Disposition": "attachment; filename*=UTF-8''goat-storage%202026.csv" })
    );
    await downloadStorageCsv({ unused: true, type: "table", q: "", sort: "size", dir: "desc" });
    const url = new URL(apiRequestAuthMock.mock.calls[0][0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${CREDITS_API_BASE_URL}/storage-by-layer/export`);
    expect(Object.fromEntries(url.searchParams)).toStrictEqual({
      unused: "true",
      type: "table",
      sort: "size",
      dir: "desc",
    });
    expect(clicked.map((c) => c.download)).toEqual(["goat-storage 2026.csv"]);
  });

  it("fails without saving anything when core refuses", async () => {
    apiRequestAuthMock.mockResolvedValue(csv({}, 403));
    await expect(downloadUsageCsv("credits", {})).rejects.toMatchObject({ status: 403 });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
  });
});
