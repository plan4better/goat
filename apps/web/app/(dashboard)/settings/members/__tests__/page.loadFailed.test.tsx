import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import MembersPage from "@/app/(dashboard)/settings/members/page";

vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/settings/useOrganizationId", () => ({ useOrganizationId: () => "org-1" }));
vi.mock("@/components/support/SupportMenu", () => ({ useReportProblemHref: () => null }));
vi.mock("@/lib/api/users", () => ({
  useUserProfile: () => ({ userProfile: { id: "a1", roles: ["organization-admin"] } }),
  useOrganization: () => ({
    organization: {
      id: "org-1",
      name: "Stadt Musterhausen",
      used_editors: 1,
      total_editors: 5,
      used_viewers: 0,
      total_viewers: null,
    },
    mutate: vi.fn(),
  }),
}));
vi.mock("@/lib/api/organizations", () => ({
  useOrganizationMembers: () => ({ members: [], isError: undefined, mutate: vi.fn() }),
  refreshOrganizationMembers: vi.fn(),
}));
// Code a deploy removed (a tab opened before it): every load of it fails.
vi.mock("@/components/settings/members/RolesMatrixDialog", () => {
  throw new Error("Failed to load chunk");
});

describe("Members page when a dialog's code does not load", () => {
  it("shows a notice in place of the dialog instead of failing the page", async () => {
    render(
      <I18nextProvider i18n={commonI18n("en")}>
        <MembersPage />
      </I18nextProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: "Roles explained" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("This part could not be loaded.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "Members" })).toBeInTheDocument();
  });
});
