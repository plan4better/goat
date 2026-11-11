import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import ProfilePage from "@/app/(dashboard)/settings/profile/page";

// Stable objects, as SWR hands out: a new profile on every render would reset the card's form each time.
const api = vi.hoisted(() => ({
  profile: {
    id: "u1",
    firstname: "Anna",
    lastname: "Weber",
    email: "anna@example.com",
    avatar: "",
    roles: ["organization-editor"],
  },
  organization: { id: "org-1", name: "Stadt Musterhausen", avatar: "" },
  teams: [],
  updateUserProfile: vi.fn(),
  deleteAccount: vi.fn(),
}));

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/users", () => ({
  useUserProfile: () => ({ userProfile: api.profile, mutate: vi.fn() }),
  useOrganization: () => ({ organization: api.organization }),
  updateUserProfile: api.updateUserProfile,
  deleteAccount: api.deleteAccount,
}));
vi.mock("@/lib/api/teams", () => ({ useTeams: () => ({ teams: api.teams, isLoading: false }) }));
vi.mock("@/components/dashboard/common/UserAvatar", () => ({ default: () => <span /> }));
// Code a deploy removed (a tab opened before it): every load of it fails.
vi.mock("@/components/modals/Confirm", () => {
  throw new Error("Failed to load chunk");
});
vi.mock("@/components/settings/profile/EmailChangeDialog", () => {
  throw new Error("Failed to load chunk");
});

const renderPage = () =>
  render(
    <I18nextProvider i18n={commonI18n("en")}>
      <ProfilePage />
    </I18nextProvider>
  );

/** The notice in place of a dialog: closing it leaves the page as it was. */
const closeNotice = async () => {
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("alert")).toHaveTextContent("This part could not be loaded.");
  await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("heading", { level: 2, name: "Profile" })).toBeInTheDocument();
};

describe("Profile page when a dialog's code does not load", () => {
  it("shows a notice in place of the delete dialog instead of failing the page", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await closeNotice();
    expect(api.deleteAccount).not.toHaveBeenCalled();
  });

  it("shows a notice in place of the address dialog, and saves nothing", async () => {
    renderPage();
    const email = screen.getByLabelText(/^Email/);
    await userEvent.clear(email);
    await userEvent.type(email, "anna.weber@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await closeNotice();
    expect(api.updateUserProfile).not.toHaveBeenCalled();
  });
});
