import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Cookies from "js-cookie";
import { signOut } from "next-auth/react";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import OrganizationProfilePage from "@/app/(dashboard)/settings/organization/page";

const ORGANIZATION = { id: "org-1", name: "Stadt Musterhausen", avatar: "" };

const api = vi.hoisted(() => ({
  roles: ["organization-admin"] as string[] | undefined,
  profileError: undefined as unknown,
  mutateProfile: vi.fn(),
  organization: undefined as Record<string, unknown> | undefined,
  organizationError: undefined as unknown,
  billing: true,
  members: undefined as unknown[] | undefined,
  membersError: undefined as unknown,
  membersKeys: [] as string[],
  mutateMembers: vi.fn(),
  mutateOrganization: vi.fn(),
  updateOrganization: vi.fn(),
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
  useUserProfile: () => ({
    userProfile: api.roles && { id: "u-admin", roles: api.roles },
    isError: api.profileError,
    mutate: api.mutateProfile,
  }),
  useOrganization: () => ({
    organization: api.organization,
    isError: api.organizationError,
    mutate: api.mutateOrganization,
  }),
  useFeatures: () => ({ features: { billing: api.billing } }),
}));
vi.mock("@/lib/api/organizations", () => ({
  useOrganizationMembers: (organizationId: string) => {
    api.membersKeys.push(organizationId);
    return { members: api.members, isError: api.membersError, mutate: api.mutateMembers };
  },
  updateOrganization: api.updateOrganization,
  deleteOrganization: api.deleteOrganization,
}));
// Which seed picks an avatar's colour; drawing it is UserAvatar's own business.
vi.mock("@/components/dashboard/common/UserAvatar", () => ({
  default: ({ id }: { id: string }) => <span data-testid="avatar" data-seed={id} />,
}));

const member = (id: string, firstname: string, role: string) => ({
  id,
  firstname,
  lastname: "",
  email: `${id}@example.com`,
  roles: [role],
  invitation_status: "accepted",
  avatar: "",
});
const MEMBERS = [
  member("u-ed", "Eva", "organization-editor"),
  member("u-admin", "Ada", "organization-admin"),
  member("u-own", "Otto", "organization-owner"),
  { ...member("inv", "", "organization-admin"), invitation_status: "pending" },
];

const renderPage = () => {
  const i18n = commonI18n("en");
  const page = () => (
    <I18nextProvider i18n={i18n}>
      <OrganizationProfilePage />
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
  await userEvent.click(screen.getByRole("button", { name: "Delete organization" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(
    within(dialog).getByLabelText("Enter “Stadt Musterhausen” to confirm."),
    "Stadt Musterhausen"
  );
  return dialog;
};

describe("Organization profile", () => {
  beforeEach(() => {
    api.roles = ["organization-admin"];
    api.profileError = undefined;
    api.organization = { ...ORGANIZATION };
    api.organizationError = undefined;
    api.billing = true;
    api.members = MEMBERS;
    api.membersError = undefined;
    api.membersKeys = [];
    api.updateOrganization.mockReset().mockResolvedValue(new Response("{}"));
    api.deleteOrganization.mockReset().mockResolvedValue(new Response("{}"));
    api.mutateMembers.mockReset();
    api.mutateProfile.mockReset();
    api.mutateOrganization.mockReset().mockResolvedValue(undefined);
    vi.mocked(signOut).mockReset();
    vi.mocked(Cookies.remove).mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("is a level two page under the Organization group", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Profile" })).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
  });

  it("lets an admin rename the organization from the card's save bar", async () => {
    renderPage();
    expect(
      screen.getByText("The name and logo of your organization. All members see them.")
    ).toBeInTheDocument();
    const name = screen.getByLabelText(/^Organization name/);
    await expect(name).toHaveValue("Stadt Musterhausen");
    await userEvent.clear(name);
    await userEvent.type(name, "Stadt Neuhausen ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    // No logo: the field is left out, so core keeps a NULL instead of writing "".
    expect(api.updateOrganization).toHaveBeenCalledWith("org-1", { name: "Stadt Neuhausen" });
    expect(api.mutateOrganization).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Organization saved.");
  });

  it("sends the logo along when there is one", async () => {
    api.organization = { ...ORGANIZATION, avatar: "https://assets.example.com/logo.png" };
    renderPage();
    await userEvent.type(screen.getByLabelText(/^Organization name/), " Nord");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.updateOrganization).toHaveBeenCalledWith("org-1", {
      name: "Stadt Musterhausen Nord",
      avatar: "https://assets.example.com/logo.png",
    });
  });

  it("refuses an empty name and keeps the draft when saving fails", async () => {
    renderPage();
    const name = screen.getByLabelText(/^Organization name/);
    await userEvent.clear(name);
    expect(screen.getByText("Enter a name.")).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    api.updateOrganization.mockRejectedValue({ detail: "500" });
    await userEvent.type(name, "Stadt Neuhausen");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(toast.error).toHaveBeenCalledWith("The organization could not be saved.");
    expect(
      within(screen.getByRole("region", { name: "Name and logo" })).getByRole("status")
    ).toHaveTextContent("Unsaved changes");
  });

  it("colours the organization's avatar by its id, as the settings nav does", async () => {
    renderPage();
    const card = screen.getByRole("region", { name: "Name and logo" });
    await expect(within(card).getByTestId("avatar")).toHaveAttribute("data-seed", "org-1");
  });

  it("lists the owner first, then the admins, with a mail link each, and no invitations", async () => {
    renderPage();
    const card = screen.getByRole("region", { name: "Owners and admins" });
    const rows = within(card).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Otto"),
      expect.stringContaining("Ada"),
    ]);
    expect(rows[0]).toHaveTextContent("Owner");
    expect(rows[1]).toHaveTextContent("Admin");
    const mail = within(rows[0]).getByRole("link", { name: "Email Otto" });
    await expect(mail).toHaveAttribute("href", "mailto:u-own@example.com");
    await expect(mail).toHaveAttribute("title", "u-own@example.com");
    await expect(within(card).getByRole("link", { name: "All members" })).toHaveAttribute(
      "href",
      "/settings/members"
    );
    await expect(within(card).getByRole("link", { name: "Seats and usage" })).toHaveAttribute(
      "href",
      "/settings/usage?quota=editors"
    );
  });

  it("names a contact without a name by the address", async () => {
    api.members = [...MEMBERS, member("u-anon", "", "organization-admin")];
    renderPage();
    const card = screen.getByRole("region", { name: "Owners and admins" });
    const rows = within(card).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent("u-anon@example.com");
    await expect(within(rows[2]).getByRole("link", { name: "Email u-anon@example.com" })).toHaveAttribute(
      "href",
      "mailto:u-anon@example.com"
    );
  });

  it("puts the crown after the owner's name only", () => {
    renderPage();
    const rows = within(screen.getByRole("region", { name: "Owners and admins" })).getAllByRole("listitem");
    expect(within(rows[0]).getByText("Otto").nextElementSibling?.tagName.toLowerCase()).toBe("svg");
    expect(within(rows[1]).getByText("Ada").nextElementSibling).toBeNull();
  });

  it("holds the cards as skeletons until the role is known, while the members request already runs", () => {
    api.roles = undefined;
    const view = renderPage();
    const first = screen.getByRole("region", { name: "Name and logo" });
    expect(within(first).getByRole("status")).toBeInTheDocument();
    const contacts = screen.getByRole("region", { name: "Owners and admins" });
    expect(within(contacts).getByRole("status")).toBeInTheDocument();
    expect(within(contacts).queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByText("These people answer questions about roles, seats, domains or AI.")).toBeNull();
    expect(screen.queryByRole("link", { name: "All members" })).toBeNull();
    expect(api.membersKeys).toContain("org-1");
    api.roles = ["organization-admin"];
    view.rerenderPage();
    expect(
      screen.getByText("Members find these people here when they have questions about seats, domains or AI.")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All members" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Seats and usage" })).toBeInTheDocument();
  });

  it("leaves out Seats and usage where billing is off", () => {
    api.billing = false;
    renderPage();
    expect(screen.queryByRole("link", { name: "Seats and usage" })).toBeNull();
  });

  it("offers an admin the delete card disabled, with the reason", async () => {
    renderPage();
    const button = screen.getByRole("button", { name: "Delete organization" });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription("Only the owner can delete the organization.");
  });

  it("lets the owner delete after typing the name: suspends, drops the cookie, signs out", async () => {
    api.roles = ["organization-owner"];
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Delete organization" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Download first what you want to keep. Deleting does this:");
    expect(dialog).toHaveTextContent("All 3 members lose access at once.");
    await userEvent.type(
      within(dialog).getByLabelText("Enter “Stadt Musterhausen” to confirm."),
      "Stadt Musterhausen"
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete for good" }));
    expect(api.deleteOrganization).toHaveBeenCalledWith("org-1");
    expect(Cookies.remove).toHaveBeenCalledWith("organization");
    expect(signOut).toHaveBeenCalled();
  });

  it("names no member count in the delete dialog while the members are unknown", async () => {
    api.roles = ["organization-owner"];
    api.members = undefined;
    api.membersError = new Error("500");
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Delete organization" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("You are signed out.");
    expect(dialog).not.toHaveTextContent("lose access");
    expect(dialog).not.toHaveTextContent("loses access");
  });

  it("keeps the delete dialog busy until core answers, then signs out", async () => {
    api.roles = ["organization-owner"];
    const request = pending<Response>();
    api.deleteOrganization.mockReturnValue(request.promise);
    renderPage();
    const dialog = await openDeleteDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete for good" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await expect(within(dialog).getByRole("button", { name: "Delete for good" })).toBeDisabled();
    for (const cancel of within(dialog).getAllByRole("button", { name: "Cancel" })) {
      await expect(cancel).toBeDisabled();
    }
    expect(signOut).not.toHaveBeenCalled();
    await act(async () => request.resolve(new Response(null, { status: 204 })));
    expect(Cookies.remove).toHaveBeenCalledWith("organization");
    expect(signOut).toHaveBeenCalled();
  });

  it("keeps the delete dialog open and says so when deleting fails", async () => {
    api.roles = ["organization-owner"];
    api.deleteOrganization.mockRejectedValue({ detail: "500" });
    renderPage();
    const dialog = await openDeleteDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete for good" }));
    expect(toast.error).toHaveBeenCalledWith("The organization could not be deleted.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await expect(within(dialog).getByRole("button", { name: "Delete for good" })).toBeEnabled();
    expect(Cookies.remove).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("draws the delete card's skeleton until the organization is there, and opens the dialog only on a click", async () => {
    api.roles = ["organization-owner"];
    api.organization = undefined;
    const view = renderPage();
    const loading = screen.getByRole("region", { name: "Delete organization" });
    expect(within(loading).getByRole("status")).toBeInTheDocument();
    expect(within(loading).queryByRole("button")).not.toBeInTheDocument();
    api.organization = { ...ORGANIZATION };
    view.rerenderPage();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete organization" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Delete for good");
  });

  it("offers a retry in the delete card when the organization cannot be read", async () => {
    api.roles = ["organization-owner"];
    api.organization = undefined;
    api.organizationError = new Error("500");
    renderPage();
    const danger = screen.getByRole("region", { name: "Delete organization" });
    expect(within(danger).queryByRole("button", { name: "Delete organization" })).not.toBeInTheDocument();
    await userEvent.click(within(danger).getByRole("button", { name: "Try again" }));
    expect(api.mutateOrganization).toHaveBeenCalled();
  });

  it("shows editors and viewers the organization read-only, without save or delete", () => {
    api.roles = ["organization-viewer"];
    renderPage();
    expect(
      screen.getByText("Your organization in GOAT. Owners and admins can change it.")
    ).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "Your organization" });
    expect(summary).toHaveTextContent("Stadt Musterhausen");
    expect(summary).toHaveTextContent("3 members");
    expect(summary).toHaveTextContent("You are Viewer in this organization.");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete organization" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Delete organization" })).toBeNull();
    expect(
      screen.getByText("These people answer questions about roles, seats, domains or AI.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "All members" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Seats and usage" })).toBeNull();
  });

  it("names an editor's own role in the summary", () => {
    api.roles = ["organization-editor"];
    renderPage();
    expect(screen.getByRole("region", { name: "Your organization" })).toHaveTextContent(
      "You are Editor in this organization."
    );
  });

  it("colours the summary's avatar by the organization's id", async () => {
    api.roles = ["organization-viewer"];
    renderPage();
    const summary = screen.getByRole("region", { name: "Your organization" });
    await expect(within(summary).getByTestId("avatar")).toHaveAttribute("data-seed", "org-1");
  });

  it("fails only the contacts card when the members cannot be read, and retries that request", async () => {
    api.members = undefined;
    api.membersError = new Error("500");
    renderPage();
    await expect(screen.getByLabelText(/^Organization name/)).toHaveValue("Stadt Musterhausen");
    const card = screen.getByRole("region", { name: "Owners and admins" });
    expect(card).toHaveTextContent("That could not be loaded.");
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    await userEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(api.mutateMembers).toHaveBeenCalledTimes(1);
    expect(api.mutateOrganization).not.toHaveBeenCalled();
  });

  it("keeps the read-only summary without a count, and without an error, when the members cannot be read", () => {
    api.roles = ["organization-viewer"];
    api.members = undefined;
    api.membersError = new Error("500");
    renderPage();
    const summary = screen.getByRole("region", { name: "Your organization" });
    expect(summary).toHaveTextContent("Stadt Musterhausen");
    expect(summary).not.toHaveTextContent("members");
    expect(within(summary).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });

  it("offers a retry in place of the first card when the profile cannot be read", async () => {
    api.roles = undefined;
    api.profileError = new Error("500");
    renderPage();
    expect(screen.queryByRole("button", { name: "Delete organization" })).toBeNull();
    // The contacts card's hint and links depend on the role: the page's retry stands for it too.
    expect(screen.queryByRole("region", { name: "Owners and admins" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(api.mutateProfile).toHaveBeenCalled();
    expect(api.mutateOrganization).not.toHaveBeenCalled();
  });
});
