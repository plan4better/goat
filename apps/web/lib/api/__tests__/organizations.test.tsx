import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ORG_API_BASE_URL,
  refreshOrganizationMembers,
  useOrganizationMembers,
} from "@/lib/api/organizations";

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ fetcher, apiRequestAuth: vi.fn() }));

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
