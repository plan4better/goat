import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/apiError";
import {
  ORG_API_BASE_URL,
  refreshOrganizationMembers,
  resendInvitation,
  useOrganizationMembers,
} from "@/lib/api/organizations";

const { fetcher, apiRequestAuth } = vi.hoisted(() => ({ fetcher: vi.fn(), apiRequestAuth: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ fetcher, apiRequestAuth }));

/** Mitglieder's list (with invitations), the settings nav's badge (without),
 * and another organization's list. */
const Lists = () => {
  useOrganizationMembers("org-1", { include_invitations: true });
  useOrganizationMembers("org-1");
  useOrganizationMembers("org-2");
  return null;
};

describe("refreshOrganizationMembers", () => {
  it("reads every member list of the organization again, with and without invitations, and no other", async () => {
    fetcher.mockResolvedValue([]);
    render(<Lists />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    fetcher.mockClear();

    await refreshOrganizationMembers("org-1");

    const keys = fetcher.mock.calls.map(([key]) => key);
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(
      expect.arrayContaining([
        [`${ORG_API_BASE_URL}/org-1/users`, { include_invitations: true }],
        [`${ORG_API_BASE_URL}/org-1/users`, undefined],
      ])
    );
  });
});

describe("resendInvitation", () => {
  beforeEach(() => apiRequestAuth.mockReset());

  it("posts to the invitation's resend route and answers how the account is set up", async () => {
    apiRequestAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: "i1", account_setup: "manual" }),
    });
    await expect(resendInvitation("org-1", "i1")).resolves.toMatchObject({ account_setup: "manual" });
    expect(apiRequestAuth.mock.calls[0][0]).toBe(`${ORG_API_BASE_URL}/org-1/invitations/i1/resend`);
    expect(apiRequestAuth.mock.calls[0][1].method).toBe("POST");
  });

  it("keeps the 429 of an invitation sent a moment ago", async () => {
    apiRequestAuth.mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ detail: "The invitation was sent less than 10 minutes ago" }),
    });
    const error = await resendInvitation("org-1", "i1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429 });
  });

  it("keeps the 400 of an invitation withdrawn meanwhile and the 409 of an expired one", async () => {
    for (const [status, detail] of [
      [400, "Invitation not found"],
      [409, "The invitation has expired"],
    ] as const) {
      apiRequestAuth.mockResolvedValueOnce({ ok: false, status, json: () => Promise.resolve({ detail }) });
      const error = await resendInvitation("org-1", "i1").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status, detail });
    }
  });
});
