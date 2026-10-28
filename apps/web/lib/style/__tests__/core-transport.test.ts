import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROJECTS_API_BASE_URL } from "@/lib/api/projects";
import type { LayerStyle } from "@/lib/style/generated/types";
import { createCoreTransport } from "@/lib/style/transports/core";

const apiRequestAuth = vi.fn();
vi.mock("@/lib/api/fetcher", () => ({
  apiRequestAuth: (...args: unknown[]) => apiRequestAuth(...args),
}));

const DOC = { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;
const URL_OF = `${PROJECTS_API_BASE_URL}/p1/layer/7/style/s1`;
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const transport = () => createCoreTransport({ projectId: "p1", layerProjectId: 7, styleId: "s1" });

beforeEach(() => {
  apiRequestAuth.mockReset();
});

describe("core transport", () => {
  it("a stored save maps to ok", async () => {
    const issue = { level: "warning", code: "x", path: "/symbol", message: "m" };
    apiRequestAuth.mockResolvedValue(reply(200, { id: "s1", revision: 4, document: DOC, issues: [issue] }));
    const result = await transport().save({ base_rev: 3, document: DOC }, { keepalive: false });
    expect(result).toEqual({ ok: true, document: DOC, revision: 4, issues: [issue] });
    const [url, init] = apiRequestAuth.mock.calls[0];
    expect(url).toBe(URL_OF);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ base_rev: 3, document: DOC });
  });

  it("409 carries base_too_old", async () => {
    apiRequestAuth.mockResolvedValue(reply(409, { detail: { code: "base_too_old" } }));
    expect(await transport().save({ base_rev: 1, document: DOC }, { keepalive: false })).toEqual({
      ok: false,
      status: 409,
      code: "base_too_old",
    });
    apiRequestAuth.mockResolvedValue(new Response("Bad gateway", { status: 502 }));
    expect(await transport().save({ base_rev: 1, document: DOC }, { keepalive: false })).toEqual({
      ok: false,
      status: 502,
    });
  });

  it("a network failure is status 0", async () => {
    apiRequestAuth.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await transport().save({ base_rev: 1, document: DOC }, { keepalive: false })).toEqual({
      ok: false,
      status: 0,
    });
  });

  it("keepalive reaches fetch", async () => {
    apiRequestAuth.mockResolvedValue(reply(200, { revision: 2, document: DOC, issues: [] }));
    await transport().save({ base_rev: 1, document: DOC }, { keepalive: true });
    expect(apiRequestAuth.mock.calls[0][1].keepalive).toBe(true);
  });

  it("load asks for a check and hands its issues on", async () => {
    const damaged = { level: "damaged", code: "field_missing", path: "/symbol", message: "gone" };
    apiRequestAuth.mockResolvedValue(
      reply(200, { revision: 9, document: DOC, issues: [damaged], stale: false })
    );
    expect(await transport().load()).toEqual({ document: DOC, revision: 9, issues: [damaged], stale: false });
    expect(apiRequestAuth.mock.calls[0][0]).toBe(`${URL_OF}?check=true`);
  });
});
