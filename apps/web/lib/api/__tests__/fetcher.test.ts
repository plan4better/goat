import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearTokenCache, fetcher, renewAccessToken } from "@/lib/api/fetcher";

const { getSessionMock, signInMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  signInMock: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  getSession: getSessionMock,
  signIn: signInMock,
}));

describe("fetcher auth handling", () => {
  beforeEach(() => {
    clearTokenCache();
    getSessionMock.mockReset();
    signInMock.mockReset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
  });

  it("renewAccessToken asks for a new session even while the cached token lives", async () => {
    getSessionMock.mockResolvedValue({ access_token: "old-token" });
    await fetcher("http://api.test/thing");
    getSessionMock.mockResolvedValue({ access_token: "new-token" });
    expect(await renewAccessToken()).toBe(true);
    await fetcher("http://api.test/thing");
    const headers = vi.mocked(fetch).mock.calls[1][1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer new-token");
    getSessionMock.mockResolvedValue(null);
    expect(await renewAccessToken()).toBe(false);
  });

  it("sends the session access token as bearer", async () => {
    getSessionMock.mockResolvedValue({ access_token: "valid-token" });
    await fetcher("http://api.test/thing");
    const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer valid-token");
  });

  it("does not replay the stale token and re-authenticates when refresh failed", async () => {
    getSessionMock.mockResolvedValue({
      access_token: "stale-token",
      error: "RefreshAccessTokenError",
    });
    await fetcher("http://api.test/thing");
    const options = vi.mocked(fetch).mock.calls[0][1];
    expect(options?.headers?.["Authorization"]).toBeUndefined();
    expect(signInMock).toHaveBeenCalledWith("keycloak");
  });

  it("leaves an unset query value out of the query string", async () => {
    // `URLSearchParams` writes an unset value out as the literal
    // "undefined", which a typed query parameter rejects with a 422.
    getSessionMock.mockResolvedValue(null);
    await fetcher(["http://api.test/thing", { source: "all", kind: undefined, size: 12 }]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://api.test/thing?source=all&size=12");
  });

  it("keeps a query value that is set", async () => {
    getSessionMock.mockResolvedValue(null);
    await fetcher(["http://api.test/thing", { kind: "workflow", page: 1 }]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://api.test/thing?kind=workflow&page=1");
  });

  it("keeps falsy values that are set, only an unset value is dropped", async () => {
    getSessionMock.mockResolvedValue(null);
    await fetcher(["http://api.test/thing", { page: 0, search: "", flag: false, empty: null }]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "http://api.test/thing?page=0&search=&flag=false&empty=null"
    );
  });

  it("sends no auth header without a session", async () => {
    getSessionMock.mockResolvedValue(null);
    await fetcher("http://api.test/thing");
    const options = vi.mocked(fetch).mock.calls[0][1];
    expect(options?.headers?.["Authorization"]).toBeUndefined();
    expect(signInMock).not.toHaveBeenCalled();
  });
});
