import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { signOut } from "next-auth/react";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { ApiError } from "@/lib/api/apiError";

import ProfilePage from "@/app/(dashboard)/settings/profile/page";

const api = vi.hoisted(() => ({
  profile: undefined as Record<string, unknown> | undefined,
  profileError: undefined as unknown,
  mutateProfile: vi.fn(),
  updateUserProfile: vi.fn(),
  deleteAccount: vi.fn(),
  organization: undefined as Record<string, unknown> | undefined,
  organizationError: undefined as unknown,
  mutateOrganization: vi.fn(),
  teams: [] as { id: string; name: string }[],
  teamsError: undefined as unknown,
  mutateTeams: vi.fn(),
}));

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/users", () => ({
  useUserProfile: () => ({ userProfile: api.profile, isError: api.profileError, mutate: api.mutateProfile }),
  useOrganization: () => ({
    organization: api.organization,
    isError: api.organizationError,
    mutate: api.mutateOrganization,
  }),
  updateUserProfile: api.updateUserProfile,
  deleteAccount: api.deleteAccount,
}));
// As useTeams: `teams` is `[]` until the list arrives, and keeps the last list when a later read fails.
vi.mock("@/lib/api/teams", () => ({
  useTeams: () => ({ teams: api.teams, isLoading: false, isError: api.teamsError, mutate: api.mutateTeams }),
}));

const ORGANIZATION = { id: "org-1", name: "Stadt Musterhausen", avatar: "" };
// Which seed picks an avatar's colour; drawing it is UserAvatar's own business.
vi.mock("@/components/dashboard/common/UserAvatar", () => ({
  default: ({ id }: { id: string }) => <span data-testid="avatar" data-seed={id} />,
}));

const PROFILE = {
  id: "u1",
  firstname: "Anna",
  lastname: "Weber",
  email: "anna@example.com",
  avatar: "",
  roles: ["organization-editor"],
};

const renderPage = () => {
  const i18n = commonI18n("en");
  const page = () => (
    <I18nextProvider i18n={i18n}>
      <ProfilePage />
    </I18nextProvider>
  );
  const view = render(page());
  return { ...view, rerenderPage: () => view.rerender(page()) };
};

/** A promise the test settles by hand, for a request still running. */
const pending = <T,>() => {
  let settle!: { resolve: (value: T) => void; reject: (error: unknown) => void };
  const promise = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
};

const openDeleteDialog = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(
    within(dialog).getByLabelText("Enter anna@example.com to confirm."),
    "anna@example.com"
  );
  return dialog;
};

describe("Profile page", () => {
  beforeEach(() => {
    api.profile = { ...PROFILE };
    api.profileError = undefined;
    api.organization = ORGANIZATION;
    api.organizationError = undefined;
    api.mutateOrganization.mockReset().mockResolvedValue(undefined);
    api.teams = [
      { id: "t2", name: "Verkehr" },
      { id: "t1", name: "Stadtplanung" },
    ];
    api.teamsError = undefined;
    api.mutateTeams.mockReset().mockResolvedValue(undefined);
    api.updateUserProfile.mockReset().mockResolvedValue(new Response("{}"));
    api.mutateProfile.mockReset().mockResolvedValue(undefined);
    api.deleteAccount.mockReset().mockResolvedValue(new Response("{}"));
    vi.mocked(signOut).mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("is a level two page under the Account group", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Profile" })).toBeInTheDocument();
    expect(screen.getByText("Account")).toBeInTheDocument();
  });

  it("saves the trimmed names from the card's save bar", async () => {
    renderPage();
    const first = screen.getByLabelText(/^First name/);
    await userEvent.clear(first);
    await userEvent.type(first, "  Anne ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    // No picture: the field is left out, so core keeps a NULL instead of writing "".
    expect(api.updateUserProfile).toHaveBeenCalledWith({
      firstname: "Anne",
      lastname: "Weber",
      email: "anna@example.com",
    });
    expect(toast.success).toHaveBeenCalledWith("Profile saved.");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("sends the picture along when there is one", async () => {
    api.profile = { ...PROFILE, avatar: "https://assets.example.com/anna.png" };
    renderPage();
    await userEvent.type(screen.getByLabelText(/^Last name/), "-Klein");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.updateUserProfile).toHaveBeenCalledWith({
      avatar: "https://assets.example.com/anna.png",
      firstname: "Anna",
      lastname: "Weber-Klein",
      email: "anna@example.com",
    });
  });

  it("asks before a new email address, then saves and signs out", async () => {
    renderPage();
    const email = screen.getByLabelText(/^Email/);
    await userEvent.clear(email);
    await userEvent.type(email, "anna.weber@example.com");
    expect(
      screen.getByText("After saving we sign you out. Then sign in with the new address.")
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Change email address");
    expect(dialog).toHaveTextContent("Your new address is anna.weber@example.com.");
    expect(api.updateUserProfile).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Change and sign out" }));
    expect(api.updateUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({ email: "anna.weber@example.com" })
    );
    expect(signOut).toHaveBeenCalled();
  });

  it("says nothing was saved when Keycloak refuses the write (502), and keeps the draft", async () => {
    api.updateUserProfile.mockRejectedValue(new ApiError(502));
    renderPage();
    await userEvent.type(screen.getByLabelText(/^Last name/), "-Klein");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(toast.error).toHaveBeenCalledWith(
      "Name and email cannot be changed right now. Nothing was saved."
    );
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
  });

  it("keeps the e-mail dialog and the draft when Keycloak refuses the new address (502)", async () => {
    api.updateUserProfile.mockRejectedValue(new ApiError(502));
    renderPage();
    const email = screen.getByLabelText(/^Email/);
    await userEvent.clear(email);
    await userEvent.type(email, "anna.weber@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change and sign out" }));
    expect(toast.error).toHaveBeenCalledWith(
      "Name and email cannot be changed right now. Nothing was saved."
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
    await expect(screen.getByLabelText(/^Email/)).toHaveValue("anna.weber@example.com");
  });

  it("refuses an empty first name and an address that is none", async () => {
    renderPage();
    await userEvent.clear(screen.getByLabelText(/^First name/));
    await userEvent.clear(screen.getByLabelText(/^Email/));
    await userEvent.type(screen.getByLabelText(/^Email/), "anna@");
    expect(screen.getByText("Enter your first name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the organization, the role with its line and the teams", async () => {
    renderPage();
    const card = screen.getByRole("region", { name: "Your organization" });
    expect(card).toHaveTextContent("Stadt Musterhausen");
    expect(card).toHaveTextContent("Editor");
    expect(card).toHaveTextContent("Creates and edits projects, workflows, layouts and dashboards.");
    expect(card).toHaveTextContent("Stadtplanung, Verkehr");
    await expect(within(card).getByRole("link", { name: "Open teams" })).toHaveAttribute(
      "href",
      "/settings/teams"
    );
  });

  it("colours the organization's avatar by its id, as the settings nav does", async () => {
    renderPage();
    const card = screen.getByRole("region", { name: "Your organization" });
    await expect(within(card).getByTestId("avatar")).toHaveAttribute("data-seed", "org-1");
  });

  it("says when the user is in no team", () => {
    api.teams = [];
    renderPage();
    expect(screen.getByRole("region", { name: "Your organization" })).toHaveTextContent("Not in a team yet");
  });

  it("keeps the organization card when a later read fails while its data is there", () => {
    // SWR keeps the data and sets the error when a revalidation fails (focus, reconnect).
    api.profileError = new Error("500");
    api.organizationError = new Error("500");
    api.teamsError = new Error("500");
    renderPage();
    const card = screen.getByRole("region", { name: "Your organization" });
    expect(card).toHaveTextContent("Stadt Musterhausen");
    expect(card).toHaveTextContent("Editor");
    expect(card).toHaveTextContent("Stadtplanung, Verkehr");
    expect(within(card).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows the load error in the organization card when the organization cannot be read", async () => {
    api.organization = undefined;
    api.organizationError = new Error("500");
    renderPage();
    const card = screen.getByRole("region", { name: "Your organization" });
    expect(card).not.toHaveTextContent("Editor");
    await userEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(api.mutateOrganization).toHaveBeenCalled();
  });

  it("shows the load error in the organization card when the profile cannot be read", async () => {
    api.profile = undefined;
    api.profileError = new Error("500");
    renderPage();
    const card = screen.getByRole("region", { name: "Your organization" });
    expect(card).not.toHaveTextContent("Stadt Musterhausen");
    await userEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(api.mutateProfile).toHaveBeenCalled();
  });

  it("keeps the organization and the role, and the teams row with its own retry, when the teams cannot be read", async () => {
    // A user in no team, or a list that never arrived: `teams` is `[]` either way.
    api.teams = [];
    api.teamsError = new Error("500");
    renderPage();
    const card = screen.getByRole("region", { name: "Your organization" });
    expect(card).toHaveTextContent("Stadt Musterhausen");
    expect(card).toHaveTextContent("Editor");
    // The row stays, but does not claim "Not in a team yet" for a list it does not have.
    expect(within(card).getByText("Teams")).toBeInTheDocument();
    expect(card).not.toHaveTextContent("Not in a team yet");
    expect(card).toHaveTextContent("That could not be loaded.");
    await userEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(api.mutateTeams).toHaveBeenCalledTimes(1);
  });

  it("deletes the sign-in account after the address is typed, then signs out", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("What you put in teams and in the organization stays there.");
    await userEvent.type(
      within(dialog).getByLabelText("Enter anna@example.com to confirm."),
      "anna@example.com"
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete account for good" }));
    expect(api.deleteAccount).toHaveBeenCalled();
    expect(signOut).toHaveBeenCalled();
  });

  it("keeps the delete dialog busy until core answers, then signs out", async () => {
    const request = pending<Response>();
    api.deleteAccount.mockReturnValue(request.promise);
    renderPage();
    const dialog = await openDeleteDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete account for good" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await expect(within(dialog).getByRole("button", { name: "Delete account for good" })).toBeDisabled();
    for (const cancel of within(dialog).getAllByRole("button", { name: "Cancel" })) {
      await expect(cancel).toBeDisabled();
    }
    expect(signOut).not.toHaveBeenCalled();
    await act(async () => request.resolve(new Response(null, { status: 204 })));
    expect(signOut).toHaveBeenCalled();
  });

  it("keeps the delete dialog open and says so when deleting fails", async () => {
    api.deleteAccount.mockRejectedValue(new ApiError(500));
    renderPage();
    const dialog = await openDeleteDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete account for good" }));
    expect(toast.error).toHaveBeenCalledWith("The account could not be deleted.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await expect(within(dialog).getByRole("button", { name: "Delete account for good" })).toBeEnabled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("draws the delete card's skeleton until the roles are known, so an owner never gets the dialog", async () => {
    api.profile = undefined;
    const view = renderPage();
    const loading = screen.getByRole("region", { name: "Delete account" });
    expect(within(loading).getByRole("status")).toBeInTheDocument();
    expect(within(loading).queryByRole("button")).not.toBeInTheDocument();
    api.profile = { ...PROFILE, roles: ["organization-owner"] };
    view.rerenderPage();
    await expect(screen.getByRole("button", { name: "Delete account" })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the delete dialog only on a click once the profile is there", async () => {
    api.profile = undefined;
    const view = renderPage();
    expect(
      within(screen.getByRole("region", { name: "Delete account" })).queryByRole("button")
    ).not.toBeInTheDocument();
    api.profile = { ...PROFILE };
    view.rerenderPage();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Delete account for good");
  });

  it("keeps the owner from deleting the account while the organization exists", async () => {
    api.profile = { ...PROFILE, roles: ["organization-owner"] };
    renderPage();
    const button = screen.getByRole("button", { name: "Delete account" });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription(
      "As the owner you can delete your account only once the organization is deleted."
    );
  });

  it("offers a retry when the profile cannot be read", async () => {
    api.profile = undefined;
    api.profileError = new Error("500");
    renderPage();
    const personal = screen.getByRole("region", { name: "Personal details" });
    await userEvent.click(within(personal).getByRole("button", { name: "Try again" }));
    expect(api.mutateProfile).toHaveBeenCalled();
  });

  it("offers a retry in the delete card when the profile cannot be read", async () => {
    api.profile = undefined;
    api.profileError = new Error("500");
    renderPage();
    const danger = screen.getByRole("region", { name: "Delete account" });
    expect(within(danger).queryByRole("button", { name: "Delete account" })).not.toBeInTheDocument();
    await userEvent.click(within(danger).getByRole("button", { name: "Try again" }));
    expect(api.mutateProfile).toHaveBeenCalled();
  });
});
