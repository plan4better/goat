import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, createElement } from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type MapResponse,
  createMapFetcher,
  datasetStyleUrl,
  projectMapUrl,
  useDatasetStyles,
  useProjectMap,
  withActiveStyle,
  withStyleReply,
} from "@/lib/api/map";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: fetchMock, fetcher: vi.fn() }));
vi.mock("@/lib/providers/PublicProjectProvider", () => ({ useIsPublicProject: () => false }));

const PROJECT = "00000000-0000-0000-0000-000000000001";
const body: MapResponse = {
  map: { version: 1, layers: [{ type: "layer", id: 5, visible: true, style: "s1" }] },
  styles: {
    "5": {
      active: {
        id: "s1",
        name: "Default",
        position: 0,
        revision: 1,
        document: { version: 1, kind: "vector" },
        issues: [],
        stale: false,
      },
      others: [],
    },
  },
  unpublished: [],
};

const reply = (status: number, json?: unknown, etag?: string) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(etag ? { ETag: etag } : {}),
  json: () => Promise.resolve(json),
});

describe("the map request", () => {
  beforeEach(() => fetchMock.mockReset());

  it("a 304 keeps the last body", async () => {
    const fetchMap = createMapFetcher();
    fetchMock.mockResolvedValueOnce(reply(200, body, '"e1"'));
    const url = projectMapUrl(PROJECT);
    expect(await fetchMap(url)).toEqual(body);
    fetchMock.mockResolvedValueOnce(reply(304));
    expect(await fetchMap(url)).toEqual(body);
    const headers = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(headers.get("If-None-Match")).toBe('"e1"');
  });

  it("an optimistic PATCH rolls back on failure", async () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);
    let answer: (value: unknown) => void = () => undefined;
    const patched = new Promise((resolve) => {
      answer = resolve;
    });
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return patched;
      return Promise.resolve(reply(200, body, '"e1"'));
    });
    const { result } = renderHook(() => useProjectMap(PROJECT), { wrapper });
    await waitFor(() => expect(result.current.map).toBeDefined());
    let failed = false;
    await act(async () => {
      const pending = result.current.setLayerState(5, { visible: false }).catch(() => {
        failed = true;
      });
      await waitFor(() =>
        expect((result.current.map?.map.layers?.[0] as { visible?: boolean }).visible).toBe(false)
      );
      answer(reply(500, { detail: "down" }));
      await pending;
    });
    expect(failed).toBe(true);
    expect((result.current.map?.map.layers?.[0] as { visible?: boolean }).visible).toBe(true);
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch?.[0]).toBe(`${projectMapUrl(PROJECT).replace(/\/map$/, "")}/layer/5/map-state`);
    expect(JSON.parse(patch?.[1]?.body as string)).toEqual({ visible: false });
  });

  it("a switched style becomes the active one; the others keep their order, a new style joins", () => {
    const three: MapResponse = {
      ...body,
      styles: {
        "5": {
          active: { ...body.styles["5"].active, id: "s2", name: "Night", position: 1 },
          others: [
            { id: "s1", name: "Default" },
            { id: "s3", name: "Print" },
          ],
        },
      },
    };
    const print = { ...body.styles["5"].active, id: "s3", name: "Print", position: 2 };
    expect(withActiveStyle(three, 5, print).styles["5"]).toEqual({
      active: print,
      others: [
        { id: "s1", name: "Default" },
        { id: "s2", name: "Night" },
      ],
    });
    const fresh = { ...body.styles["5"].active, id: "s4", name: "Style 4", position: 3 };
    expect(withActiveStyle(three, 5, fresh).styles["5"].others.map((o) => o.id)).toEqual(["s1", "s2", "s3"]);
    expect(withActiveStyle(three, 7, fresh)).toBe(three);
  });

  it("a stored reply replaces the active style in the map cache", () => {
    const document = { version: 1, kind: "vector", opacity: 0.5 } as const;
    const next = withStyleReply(body, 5, "s1", { document, revision: 2, issues: [] });
    expect(next.styles["5"].active).toMatchObject({ document, revision: 2, stale: false });
    expect(withStyleReply(body, 5, "other", { document, revision: 2, issues: [] })).toBe(body);
  });
});

describe("dataset default styles", () => {
  beforeEach(() => fetchMock.mockReset());

  it("a bundle's members load their default styles together, by dataset id", async () => {
    const style = (id: string) => ({
      id,
      name: "Default",
      position: 0,
      revision: 1,
      document: { version: 1, kind: "vector" },
      issues: [],
      stale: false,
    });
    // Earlier tests' map hooks may still revalidate: only the style requests are this test's.
    fetchMock.mockImplementation(async (url: unknown) =>
      reply(200, style(String(url).split("/").at(-2) ?? ""))
    );
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { provider: () => new Map() } }, children);
    const { result } = renderHook(() => useDatasetStyles(["a", "b"]), { wrapper });
    await waitFor(() => expect(result.current.styles).toBeDefined());
    expect(Object.keys(result.current.styles ?? {})).toEqual(["a", "b"]);
    expect(result.current.styles?.b.id).toBe("b");
    const styleCalls = fetchMock.mock.calls
      .map(([url]) => url)
      .filter((url) => String(url).endsWith("/style"));
    expect(styleCalls).toEqual([datasetStyleUrl("a"), datasetStyleUrl("b")]);
  });
});
