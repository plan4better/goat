import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useMemberDirectory } from "@/components/settings/usage/UsageDetailParts";

const api = vi.hoisted(() => ({ members: [] as Record<string, unknown>[] }));

vi.mock("@/hooks/settings/useOrganizationId", () => ({ useOrganizationId: () => "org1" }));
vi.mock("@/lib/api/users", () => ({ useOrganization: () => ({ isError: undefined }) }));
vi.mock("@/lib/api/organizations", () => ({
  useOrganizationMembers: () => ({ members: api.members, isLoading: false }),
}));

describe("useMemberDirectory", () => {
  it("names people as every settings list does: first and last name, else the address", () => {
    api.members = [
      { id: "u1", firstname: " Anna ", lastname: "Weber", email: "anna@x.de", roles: ["organization-admin"] },
      { id: "u2", firstname: " ", lastname: "", email: "blank@x.de", roles: ["organization-viewer"] },
    ];
    const { result } = renderHook(() => useMemberDirectory());
    expect(result.current.people.get("u1")).toEqual({ name: "Anna Weber", role: "organization-admin" });
    expect(result.current.people.get("u2")).toEqual({ name: "blank@x.de", role: "organization-viewer" });
  });
});
