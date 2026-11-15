import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOrganizationId } from "@/hooks/settings/useOrganizationId";

const state = vi.hoisted(() => ({ organization: undefined as { id: string } | undefined }));
vi.mock("@/lib/api/users", () => ({ useOrganization: () => ({ organization: state.organization }) }));

const clearCookie = () => {
  document.cookie = "organization=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
};

describe("useOrganizationId", () => {
  beforeEach(() => {
    state.organization = undefined;
    clearCookie();
  });
  afterEach(clearCookie);

  it("knows the id on the first render from the cookie the middleware sets", () => {
    document.cookie = "organization=org-cookie; path=/";
    const { result } = renderHook(() => useOrganizationId());
    expect(result.current).toBe("org-cookie");
  });

  it("takes the organization's answer over a stale cookie", () => {
    document.cookie = "organization=org-old; path=/";
    const { result, rerender } = renderHook(() => useOrganizationId());
    expect(result.current).toBe("org-old");
    state.organization = { id: "org-new" };
    rerender();
    expect(result.current).toBe("org-new");
  });

  it("is undefined with neither", () => {
    const { result } = renderHook(() => useOrganizationId());
    expect(result.current).toBeUndefined();
  });
});
