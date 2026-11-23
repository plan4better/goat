import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { catalogPreviewRequest, setCatalogPreviewToken } from "@/lib/catalog/preview";

/**
 * The gate in front of a catalog item's data: geoapi answers it to signed-in users only, so the detail map asks for
 * it only when this hook says so, and its requests carry the sign-in the hook keeps.
 */

const state = vi.hoisted(() => ({ authDisabled: false, token: null as string | null }));

vi.mock("@/lib/constants", async (original) => ({
  ...(await original<typeof import("@/lib/constants")>()),
  GEOAPI_BASE_URL: "https://geoapi.example",
  get AUTH_DISABLED() {
    return state.authDisabled;
  },
}));

vi.mock("@/lib/api/fetcher", () => ({ getAccessToken: vi.fn(async () => state.token) }));

const TILE = "https://geoapi.example/collections/catalog:x/tiles/WebMercatorQuad/3/4/2";

const fresh = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const access = async () => {
  const { useCatalogPreviewAccess } = await import("@/hooks/catalog/useCatalogPreviewAccess");
  const { getAccessToken } = await import("@/lib/api/fetcher");
  const hook = renderHook(() => useCatalogPreviewAccess(), { wrapper: fresh });
  return { hook, getAccessToken: vi.mocked(getAccessToken) };
};

beforeEach(() => {
  state.authDisabled = false;
  state.token = null;
  setCatalogPreviewToken(null);
});

afterEach(() => vi.clearAllMocks());

describe("useCatalogPreviewAccess", () => {
  it("asks for no data without a sign-in, and signs nothing", async () => {
    const { hook, getAccessToken } = await access();
    // Before the sign-in is known, and once it is known to be none.
    expect(hook.result.current).toBe(false);
    await waitFor(() => expect(getAccessToken).toHaveBeenCalled());
    expect(hook.result.current).toBe(false);
    expect(catalogPreviewRequest(TILE)).toBeUndefined();
  });

  it("allows the data with a sign-in, which the preview requests then carry", async () => {
    state.token = "token";
    const { hook } = await access();
    await waitFor(() => expect(hook.result.current).toBe(true));
    expect(catalogPreviewRequest(TILE)?.headers).toEqual({ Authorization: "Bearer token" });
  });

  it("stops signing when the sign-in is gone", async () => {
    state.token = "token";
    const { hook } = await access();
    await waitFor(() => expect(hook.result.current).toBe(true));
    state.token = null;
    hook.unmount();
    const again = await access();
    await waitFor(() => expect(again.getAccessToken).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(catalogPreviewRequest(TILE)).toBeUndefined());
    expect(again.hook.result.current).toBe(false);
  });

  it("allows the data where sign-in is off, without asking for a token", async () => {
    state.authDisabled = true;
    const { hook, getAccessToken } = await access();
    expect(hook.result.current).toBe(true);
    expect(getAccessToken).not.toHaveBeenCalled();
  });
});
