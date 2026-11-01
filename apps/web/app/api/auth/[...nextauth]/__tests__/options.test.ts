import type { JWT } from "next-auth/jwt";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOKEN_REFRESH_BUFFER_MS } from "@/lib/utils/token-refresh";

import { options } from "@/app/api/auth/[...nextauth]/options";

type JwtCallback = (params: { token: JWT }) => Promise<JWT>;
const jwt = options.callbacks?.jwt as unknown as JwtCallback;

/** A session's token with this many seconds left before it expires. */
const tokenWith = (secondsLeft: number): JWT =>
  ({
    access_token: "old-access",
    refresh_token: "old-refresh",
    id_token: "id",
    provider: "keycloak",
    expires_at: Math.floor(Date.now() / 1000) + secondsLeft,
  }) as JWT;

/** Keycloak's token endpoint, answering a refresh. */
const keycloak = () =>
  vi.fn(
    async () =>
      new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 300 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
  );

/** Keycloak's token endpoint, refusing a refresh as it does while briefly unavailable. */
const keycloakRefusing = () =>
  new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

describe("the session's access token", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is kept while more than the refresh buffer is left", async () => {
    const fetchMock = keycloak();
    vi.stubGlobal("fetch", fetchMock);

    const token = await jwt({ token: tokenWith((TOKEN_REFRESH_BUFFER_MS / 1000) * 6) });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(token.access_token).toBe("old-access");
  });

  it("is refreshed while still valid once less than the refresh buffer is left", async () => {
    const fetchMock = keycloak();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const token = await jwt({ token: tokenWith(TOKEN_REFRESH_BUFFER_MS / 1000 / 2) });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(token.access_token).toBe("new-access");
    expect(token.refresh_token).toBe("new-refresh");
  });

  it("is refreshed once expired", async () => {
    const fetchMock = keycloak();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const token = await jwt({ token: tokenWith(-1) });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(token.access_token).toBe("new-access");
  });

  it("is kept without an error when a refresh fails while it is still valid", async () => {
    const fetchMock = vi.fn(async () => keycloakRefusing());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const token = await jwt({ token: tokenWith(TOKEN_REFRESH_BUFFER_MS / 1000 / 2) });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(token.access_token).toBe("old-access");
    expect(token.error).toBeUndefined();
  });

  it("carries the refresh error when a refresh fails once expired", async () => {
    const fetchMock = vi.fn(async () => keycloakRefusing());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const token = await jwt({ token: tokenWith(-1) });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(token.error).toBe("RefreshAccessTokenError");
  });

  it("is refreshed on the next call after a refresh failed while it was still valid", async () => {
    const fetchMock = keycloak().mockImplementationOnce(async () => keycloakRefusing());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const kept = await jwt({ token: tokenWith(TOKEN_REFRESH_BUFFER_MS / 1000 / 2) });
    const token = await jwt({ token: kept });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(token.access_token).toBe("new-access");
    expect(token.error).toBeUndefined();
  });
});
