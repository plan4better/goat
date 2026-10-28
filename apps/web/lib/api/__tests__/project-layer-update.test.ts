import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROJECTS_API_BASE_URL, updateProjectLayer } from "@/lib/api/projects";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: fetchMock, fetcher: vi.fn() }));
vi.mock("swr", () => ({ default: vi.fn(() => ({})), mutate: vi.fn() }));

describe("updateProjectLayer", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });

  it("a layer PUT carries only the fields it changes", async () => {
    // A whole row as the page holds it: styles and map state live in their own routes now.
    const row = {
      id: 5,
      name: "Roads",
      layer_id: "d5",
      properties: { color: [1, 2, 3] },
      style: { id: "s5" },
      entry: { type: "layer", id: 5 },
      visible: true,
    };
    await updateProjectLayer("p1", 5, { ...row, name: "Streets" } as never);
    expect(fetchMock.mock.calls[0][0]).toBe(`${PROJECTS_API_BASE_URL}/p1/layer/5`);
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "Streets" });

    await updateProjectLayer("p1", 5, { query: { cql: { op: "=", args: [{ property: "a" }, 1] } } });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      query: { cql: { op: "=", args: [{ property: "a" }, 1] } },
    });
    await updateProjectLayer("p1", 5, { query: null, other_properties: { table_config: {} } });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      query: null,
      other_properties: { table_config: {} },
    });
  });
});
