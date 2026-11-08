import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreditBalance } from "@/lib/api/usage";
import { ASSISTANT_BASE_URL } from "@/lib/constants";

import { useSettingsNavInput } from "@/components/settings/nav/useSettingsNavInput";

const state = vi.hoisted(() => ({
  roles: undefined as string[] | undefined,
  billing: undefined as boolean | undefined,
  organization: undefined as { id: string; extras?: string[] | null } | undefined,
  members: undefined as { invitation_status: string }[] | undefined,
  balance: undefined as unknown,
  errors: {
    profile: undefined as unknown,
    features: undefined as unknown,
    organization: undefined as unknown,
  },
  /** The organization id each render asked members for ("" asks nothing). */
  membersFor: [] as string[],
  /** Whether each render asked for the balance. */
  balanceFor: [] as boolean[],
}));

vi.mock("@/lib/api/users", () => ({
  useUserProfile: () => ({
    userProfile: state.roles ? { roles: state.roles } : undefined,
    isError: state.errors.profile,
  }),
  useFeatures: () => ({
    features: state.billing === undefined ? undefined : { billing: state.billing },
    isError: state.errors.features,
  }),
  useOrganization: () => ({ organization: state.organization, isError: state.errors.organization }),
}));
vi.mock("@/lib/api/organizations", () => ({
  useOrganizationMembers: (organizationId: string) => {
    state.membersFor.push(organizationId);
    return { members: organizationId ? state.members : undefined };
  },
}));
vi.mock("@/lib/api/usage", () => ({
  useCreditBalance: (enabled: boolean) => {
    state.balanceFor.push(enabled);
    return { balance: enabled ? state.balance : undefined };
  },
}));

const setCookie = (id: string) => {
  document.cookie = `organization=${id}; path=/`;
};
const clearCookie = () => {
  document.cookie = "organization=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
};

/** A balance with every quota at zero and no limit, `over` laid on top. */
const balanceOf = (over: Partial<CreditBalance>): CreditBalance =>
  ({
    used_credits: 0,
    total_credits: null,
    used_ai_credits: 0,
    total_ai_credits: null,
    used_storage: 0,
    total_storage: null,
    used_projects: 0,
    total_projects: null,
    used_editors: 0,
    total_editors: null,
    ...over,
  }) as CreditBalance;

describe("useSettingsNavInput", () => {
  beforeEach(() => {
    state.roles = undefined;
    state.billing = true;
    state.organization = undefined;
    state.members = undefined;
    state.balance = undefined;
    state.errors = { profile: undefined, features: undefined, organization: undefined };
    state.membersFor.length = 0;
    state.balanceFor.length = 0;
    clearCookie();
  });
  afterEach(clearCookie);

  it("asks owners' and admins' members on the cookie's id from the first render, and their balance", () => {
    setCookie("org-cookie");
    for (const role of ["organization-owner", "organization-admin"]) {
      state.roles = [role];
      state.membersFor.length = 0;
      state.balanceFor.length = 0;
      const { unmount } = renderHook(() => useSettingsNavInput());
      expect(state.membersFor[0], role).toBe("org-cookie");
      expect(state.balanceFor[0], role).toBe(true);
      unmount();
    }
  });

  it("asks nothing for editors, viewers, or while the roles are unknown", () => {
    setCookie("org-cookie");
    for (const roles of [["organization-editor"], ["organization-viewer"], undefined]) {
      state.roles = roles;
      state.membersFor.length = 0;
      state.balanceFor.length = 0;
      const { unmount } = renderHook(() => useSettingsNavInput());
      expect(
        state.membersFor.every((id) => id === ""),
        String(roles)
      ).toBe(true);
      expect(
        state.balanceFor.every((enabled) => !enabled),
        String(roles)
      ).toBe(true);
      unmount();
    }
  });

  it("keys the members on the organization's answer once it is there", () => {
    setCookie("org-old");
    state.roles = ["organization-owner"];
    state.organization = { id: "org-1" };
    renderHook(() => useSettingsNavInput());
    expect(state.membersFor.at(-1)).toBe("org-1");
  });

  it("asks for the balance only with billing on", () => {
    state.roles = ["organization-admin"];
    for (const billing of [false, undefined]) {
      state.billing = billing;
      state.balanceFor.length = 0;
      const { unmount } = renderHook(() => useSettingsNavInput());
      expect(
        state.balanceFor.every((enabled) => !enabled),
        String(billing)
      ).toBe(true);
      unmount();
    }
  });

  it("counts members without pending invitations and raises the dot from the balance", () => {
    setCookie("org-cookie");
    state.roles = ["organization-owner"];
    state.members = [
      { invitation_status: "accepted" },
      { invitation_status: "pending" },
      { invitation_status: "accepted" },
    ];
    state.balance = balanceOf({ used_credits: 95, total_credits: 100 });
    const { result, rerender } = renderHook(() => useSettingsNavInput());
    expect(result.current.memberCount).toBe(2);
    expect(result.current.needsAttention).toBe(true);
    state.balance = balanceOf({ used_credits: 10, total_credits: 100 });
    rerender();
    expect(result.current.needsAttention).toBe(false);
  });

  it("passes on billing, White Label from the organization's extras and the assistant", () => {
    state.roles = ["organization-owner"];
    state.organization = { id: "org-1", extras: [] };
    const { result } = renderHook(() => useSettingsNavInput());
    expect(result.current.input).toEqual({
      roles: ["organization-owner"],
      features: { billing: true, whiteLabel: false },
      assistant: Boolean(ASSISTANT_BASE_URL),
    });
  });

  it("reports a failed profile, features or organization as isError", () => {
    expect(renderHook(() => useSettingsNavInput()).result.current.isError).toBe(false);
    for (const source of ["profile", "features", "organization"] as const) {
      state.errors = { profile: undefined, features: undefined, organization: undefined };
      state.errors[source] = new Error("500");
      expect(renderHook(() => useSettingsNavInput()).result.current.isError, source).toBe(true);
    }
  });
});
