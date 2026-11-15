import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import OrganizationProfilePage from "@/app/(dashboard)/settings/organization/page";

// Stable objects, as SWR hands out: a new organization on every render would reset the card's form each time.
const api = vi.hoisted(() => ({
  profile: { id: "u-own", roles: ["organization-owner"] },
  organization: { id: "org-1", name: "Stadt Musterhausen", avatar: "" },
  features: { billing: true },
  members: [],
  deleteOrganization: vi.fn(),
}));

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("js-cookie", () => ({ default: { remove: vi.fn(), get: vi.fn(() => "org-1") } }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/settings/useOrganizationId", () => ({
  ORGANIZATION_COOKIE: "organization",
  useOrganizationId: () => "org-1",
}));
vi.mock("@/lib/api/users", () => ({
  useUserProfile: () => ({ userProfile: api.profile }),
  useOrganization: () => ({ organization: api.organization }),
  useFeatures: () => ({ features: api.features }),
}));
vi.mock("@/lib/api/organizations", () => ({
  useOrganizationMembers: () => ({ members: api.members }),
  updateOrganization: vi.fn(),
  deleteOrganization: api.deleteOrganization,
}));
vi.mock("@/components/dashboard/common/UserAvatar", () => ({ default: () => <span /> }));
// Code a deploy removed (a tab opened before it): every load of it fails.
vi.mock("@/components/modals/Confirm", () => {
  throw new Error("Failed to load chunk");
});

describe("Organization profile when the delete dialog's code does not load", () => {
  it("shows a notice in place of the dialog instead of failing the page", async () => {
    render(
      <I18nextProvider i18n={commonI18n("en")}>
        <OrganizationProfilePage />
      </I18nextProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete organization" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("This part could not be loaded.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { level: 2, name: "Profile" })).toBeInTheDocument();
    expect(api.deleteOrganization).not.toHaveBeenCalled();
  });
});
