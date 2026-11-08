import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { ApiError } from "@/lib/api/apiError";

import MembersPage from "@/app/(dashboard)/settings/members/page";

const api = vi.hoisted(() => ({
  members: [] as unknown[],
  organization: undefined as Record<string, unknown> | undefined,
  membersCalls: [] as unknown[][],
  mutateMembers: vi.fn(),
  mutateOrganization: vi.fn(),
  updateOrganizationMemberRole: vi.fn(),
  updateOrganizationInvitationRole: vi.fn(),
  deleteMember: vi.fn(),
  deleteInvitation: vi.fn(),
  inviteMember: vi.fn(),
  refreshOrganizationMembers: vi.fn(),
  profile: undefined as Record<string, unknown> | undefined,
}));

vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/settings/useOrganizationId", () => ({ useOrganizationId: () => "org-cookie" }));
vi.mock("@/components/support/SupportMenu", () => ({
  useReportProblemHref: () => "/support/new?from=/settings/members",
}));
vi.mock("@/lib/api/users", () => ({
  useUserProfile: () => ({ userProfile: api.profile }),
  useOrganization: () => ({ organization: api.organization, mutate: api.mutateOrganization }),
}));
vi.mock("@/lib/api/organizations", () => ({
  useOrganizationMembers: (...args: unknown[]) => {
    api.membersCalls.push(args);
    return { members: api.members, isError: undefined, mutate: api.mutateMembers };
  },
  updateOrganizationMemberRole: api.updateOrganizationMemberRole,
  updateOrganizationInvitationRole: api.updateOrganizationInvitationRole,
  deleteMember: api.deleteMember,
  deleteInvitation: api.deleteInvitation,
  inviteMember: api.inviteMember,
  refreshOrganizationMembers: api.refreshOrganizationMembers,
}));

const person = (id: string, firstname: string, role: string, pending = false) => ({
  id,
  firstname,
  lastname: firstname ? "Muster" : "",
  email: `${id}@example.com`,
  roles: [role],
  invitation_status: pending ? "pending" : "accepted",
  avatar: "",
});

const BASE = [
  person("o1", "Otto", "organization-owner"),
  person("a1", "Ada", "organization-admin"),
  person("e1", "Emil", "organization-editor"),
  person("v1", "Vera", "organization-viewer"),
  person("n1", "", "organization-viewer"),
  person("i1", "", "organization-editor", true),
];
const MANY = [
  ...BASE,
  ...Array.from({ length: 8 }, (_, i) => person(`x${i}`, `Xaver${i}`, "organization-viewer")),
];
const ORG = {
  id: "org-1",
  name: "Stadt Musterhausen",
  used_editors: 4,
  total_editors: 5,
  used_viewers: 10,
  total_viewers: 10,
};

const renderPage = () =>
  render(
    <I18nextProvider i18n={commonI18n("en")}>
      <MembersPage />
    </I18nextProvider>
  );
const list = () => screen.getByRole("table", { name: "Members" });
const rowOf = (text: string) =>
  within(list())
    .getAllByRole("row")
    .find((row) => row.textContent?.includes(text))!;

const realMatchMedia = window.matchMedia;
/** A screen `width` px wide: a query matches when its min and max widths take it in. */
const viewport = (width: number) =>
  ((query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    return {
      matches: (!max || width <= Number(max[1])) && (!min || width >= Number(min[1])),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;

const realClipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
/** The browser's clipboard: `undefined` outside a secure context. */
const clipboard = (value: { writeText: (text: string) => Promise<void> } | undefined) =>
  Object.defineProperty(window.navigator, "clipboard", { value, configurable: true });

afterEach(() => {
  window.matchMedia = realMatchMedia;
  if (realClipboard) Object.defineProperty(window.navigator, "clipboard", realClipboard);
  else delete (window.navigator as { clipboard?: unknown }).clipboard;
});

describe("Members page", () => {
  beforeEach(() => {
    api.members = BASE;
    api.organization = ORG;
    api.membersCalls = [];
    api.profile = { id: "a1", roles: ["organization-admin"] };
    for (const fn of [api.mutateMembers, api.mutateOrganization, api.refreshOrganizationMembers]) {
      fn.mockReset().mockResolvedValue(undefined);
    }
    api.inviteMember.mockReset().mockResolvedValue(new Response("{}"));
    for (const fn of [
      api.updateOrganizationMemberRole,
      api.updateOrganizationInvitationRole,
      api.deleteMember,
      api.deleteInvitation,
    ]) {
      fn.mockReset().mockResolvedValue(new Response("{}"));
    }
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("asks for the list at once with the cookie's organization id, before the organization answers", () => {
    api.organization = undefined;
    renderPage();
    expect(api.membersCalls[0]).toEqual(["org-cookie", { include_invitations: true }]);
    expect(document.querySelectorAll(".MuiSkeleton-root").length).toBeGreaterThan(0);
  });

  it("lists owner, admins, editors and viewers in that order, with invitations after members", () => {
    renderPage();
    const names = within(list())
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector("[data-member-name]")?.textContent);
    expect(names).toEqual([
      "Otto Muster",
      "Ada Muster",
      "Emil Muster",
      "i1@example.com",
      "n1@example.com",
      "Vera Muster",
    ]);
    expect(rowOf("i1@example.com")).toHaveTextContent("Invited");
    expect(rowOf("i1@example.com")).toHaveTextContent("Invitation pending");
    expect(rowOf("Ada Muster")).toHaveTextContent("You");
  });

  it("prints the address once for a member without a name, and below the name for everyone else", () => {
    renderPage();
    // n1 has empty first and last names: the address is already the name line.
    expect(within(rowOf("n1@example.com")).getAllByText("n1@example.com")).toHaveLength(1);
    expect(within(rowOf("Emil Muster")).getByText("e1@example.com")).toBeInTheDocument();
    // An invitation keeps "Invited" under its address.
    expect(within(rowOf("i1@example.com")).getAllByText("i1@example.com")).toHaveLength(1);
    expect(within(rowOf("i1@example.com")).getByText("Invited")).toBeInTheDocument();
  });

  it("keeps the owner's and one's own role fixed, and offers no actions on those rows", () => {
    renderPage();
    expect(
      within(rowOf("Otto Muster")).getByLabelText(/^Owner\. The owner's role cannot be changed\./)
    ).toBeInTheDocument();
    expect(
      within(rowOf("Ada Muster")).getByLabelText(/^Admin\. Another admin changes your own role\./)
    ).toBeInTheDocument();
    expect(within(rowOf("Otto Muster")).queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(within(rowOf("Ada Muster")).queryByRole("button", { name: /More actions/ })).toBeNull();
  });

  it("names the actions column for assistive tech", () => {
    renderPage();
    expect(within(list()).getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });

  it("keeps a row's menu on a phone, where the status column goes", () => {
    window.matchMedia = viewport(375);
    renderPage();
    const row = rowOf("i1@example.com");
    expect(within(row).getAllByRole("cell")).toHaveLength(2);
    expect(within(row).getByText("Invitation pending")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "More actions for i1@example.com" })).toBeInTheDocument();
  });

  it("drops the status column below md and puts the pending pill under the name", () => {
    window.matchMedia = viewport(700);
    renderPage();
    expect(within(list()).queryByRole("columnheader", { name: "Status" })).toBeNull();
    const row = rowOf("i1@example.com");
    // Member, role and the row's menu.
    expect(within(row).getAllByRole("cell")).toHaveLength(3);
    expect(within(within(row).getAllByRole("cell")[0]).getByText("Invitation pending")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "More actions for i1@example.com" })).toBeInTheDocument();
  });

  it("keeps the status column out until lg, as the settings nav takes its width from md", () => {
    // 900 to 1199: the desktop nav is there, and the list has no room for Status.
    for (const width of [900, 1000, 1199]) {
      window.matchMedia = viewport(width);
      const view = renderPage();
      expect(within(list()).queryByRole("columnheader", { name: "Status" }), `${width}`).toBeNull();
      const row = rowOf("i1@example.com");
      expect(within(row).getAllByRole("cell"), `${width}`).toHaveLength(3);
      expect(within(within(row).getAllByRole("cell")[0]).getByText("Invitation pending")).toBeInTheDocument();
      view.unmount();
    }
    window.matchMedia = viewport(1200);
    renderPage();
    expect(within(list()).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(within(rowOf("i1@example.com")).getAllByRole("cell")).toHaveLength(4);
  });

  it("shows the seats and a callout for a full viewer pool", async () => {
    renderPage();
    expect(screen.getByRole("button", { name: /^Editors/ })).toHaveTextContent("1 free");
    expect(screen.getByRole("button", { name: /^Viewers/ })).toHaveTextContent("All taken");
    // A standing notice, not an alert that interrupts.
    expect(screen.queryByRole("alert")).toBeNull();
    const callout = screen.getByText(/All 10 viewer seats are taken\./).closest("[role=status]")!;
    await expect(
      within(callout as HTMLElement).getByRole("link", { name: "Ask for more seats" })
    ).toHaveAttribute("href", "/support/new?from=/settings/members");
    expect(screen.queryByText(/editor seats are taken/)).toBeNull();
  });

  it("says a full pool of one editor seat in the singular", () => {
    // The owner holds the one editor seat of a small organization.
    api.organization = { ...ORG, used_editors: 1, total_editors: 1 };
    renderPage();
    expect(
      screen.getByText(/^The only editor seat is taken\. You can invite new people as viewers\./)
    ).toBeInTheDocument();
    expect(screen.queryByText(/All 1 editor seats/)).toBeNull();
  });

  it("shows no callout for a pool of no seats that nobody uses", () => {
    api.organization = { ...ORG, used_viewers: 0, total_viewers: 0 };
    renderPage();
    expect(screen.queryByText(/viewer seats are taken/)).toBeNull();
  });

  it("filters from a seat tile and the status pill, with chips to drop them", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /^Open invitations/ }));
    expect(within(list()).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Status: Invitation pending")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Open invitations/ }));
    expect(within(list()).getAllByRole("row")).toHaveLength(7);
  });

  it("searches by name or address and says when nobody matches", async () => {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText("Search by name or email"), "vera");
    expect(within(list()).getAllByRole("row")).toHaveLength(2);
    await userEvent.type(screen.getByPlaceholderText("Search by name or email"), "zzz");
    expect(screen.getByText("Nobody matches “verazzz”")).toBeInTheDocument();
  });

  it("pages ten rows at a time", async () => {
    api.members = MANY;
    renderPage();
    expect(screen.getByText("1–10 of 14 members")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Go to page 2" }));
    expect(screen.getByText("11–14 of 14 members")).toBeInTheDocument();
  });

  it("goes back to the first page when the sort changes", async () => {
    api.members = MANY;
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Go to page 2" }));
    expect(screen.getByText("11–14 of 14 members")).toBeInTheDocument();
    await userEvent.click(within(list()).getByRole("button", { name: "Member" }));
    expect(screen.getByText("1–10 of 14 members")).toBeInTheDocument();
  });

  it("offers no role change and no row actions until it knows who is reading", async () => {
    api.profile = undefined;
    renderPage();
    for (const name of ["Ada Muster", "Emil Muster", "i1@example.com"]) {
      await expect(
        within(rowOf(name)).getByRole("button", { name: new RegExp(`^Role of ${name}`) })
      ).toBeDisabled();
    }
    expect(within(list()).queryByRole("button", { name: /More actions/ })).toBeNull();
  });

  it("changes a role and undoes it with the old role", async () => {
    renderPage();
    await userEvent.click(within(rowOf("Emil Muster")).getByRole("button", { name: /Role of Emil Muster/ }));
    // The viewer pool is full: Viewer is disabled with the reason.
    expect(screen.getByRole("menuitemradio", { name: /^Viewer/ })).toHaveTextContent("No viewer seat free");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Admin/ }));
    expect(api.updateOrganizationMemberRole).toHaveBeenCalledWith("org-cookie", "e1", "organization-admin");
    expect(api.refreshOrganizationMembers).toHaveBeenCalledWith("org-cookie");
    expect(api.mutateOrganization).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();

    // The toast's undo sends the old role.
    const content = vi.mocked(toast.success).mock.calls[0][0] as unknown as (props: {
      closeToast: () => void;
    }) => ReactElement;
    render(content({ closeToast: vi.fn() }));
    expect(screen.getByText("Emil Muster is now Admin.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(api.updateOrganizationMemberRole).toHaveBeenLastCalledWith(
      "org-cookie",
      "e1",
      "organization-editor"
    );
  });

  it("changes an invitation's role through the invitation route and names core's reason on a 400", async () => {
    api.updateOrganizationInvitationRole.mockRejectedValue(
      new ApiError(400, "Organization has reached the limit of editors")
    );
    api.organization = { ...ORG, used_viewers: 2 };
    renderPage();
    await userEvent.click(
      within(rowOf("i1@example.com")).getByRole("button", { name: /Role of i1@example.com/ })
    );
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Viewer/ }));
    expect(api.updateOrganizationInvitationRole).toHaveBeenCalledWith(
      "org-cookie",
      "i1",
      "organization-viewer"
    );
    expect(toast.error).toHaveBeenCalledWith(
      "The role could not be changed. Organization has reached the limit of editors"
    );
  });

  it("removes a member, handing their personal content to oneself by default", async () => {
    renderPage();
    await userEvent.click(
      within(rowOf("Emil Muster")).getByRole("button", { name: "More actions for Emil Muster" })
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from organization" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Do you want to remove Emil Muster from Stadt Musterhausen?");
    expect(dialog).toHaveTextContent("The editor seat is free at once.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(api.deleteMember).toHaveBeenCalledWith("org-cookie", "e1", "a1");
    // Every member list, so the settings nav's count follows too.
    expect(api.refreshOrganizationMembers).toHaveBeenCalledWith("org-cookie");
    expect(api.mutateOrganization).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Emil Muster was removed from the organization.");
  });

  it("offers active members other than the person as heirs and sends the one chosen", async () => {
    renderPage();
    await userEvent.click(
      within(rowOf("Emil Muster")).getByRole("button", { name: "More actions for Emil Muster" })
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from organization" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox"));
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    // No invitation (i1), not Emil himself; oneself marked.
    expect(options.map((option) => option.textContent)).toEqual([
      "Ada Muster (you)",
      "n1@example.com",
      "Otto Muster",
      "Vera Muster",
    ]);
    await userEvent.click(screen.getByRole("option", { name: "Otto Muster" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(api.deleteMember).toHaveBeenCalledWith("org-cookie", "e1", "o1");
  });

  it("names a member without a name by the address in the remove dialog", async () => {
    renderPage();
    await userEvent.click(
      within(rowOf("n1@example.com")).getByRole("button", { name: "More actions for n1@example.com" })
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from organization" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Do you want to remove n1@example.com from Stadt Musterhausen?"
    );
  });

  const copyEmailOf = async (name: string) => {
    await userEvent.click(within(rowOf(name)).getByRole("button", { name: `More actions for ${name}` }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy email address" }));
  };

  it("copies a member's address and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard({ writeText });
    renderPage();
    await copyEmailOf("Emil Muster");
    expect(writeText).toHaveBeenCalledWith("e1@example.com");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Email address copied."));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says the address could not be copied when there is no clipboard", async () => {
    clipboard(undefined);
    renderPage();
    await copyEmailOf("Emil Muster");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "That could not be copied. Select the value and copy it yourself."
      )
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("says the address could not be copied when the browser refuses", async () => {
    clipboard({ writeText: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")) });
    renderPage();
    await copyEmailOf("Emil Muster");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "That could not be copied. Select the value and copy it yourself."
      )
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("withdraws an invitation", async () => {
    renderPage();
    await userEvent.click(
      within(rowOf("i1@example.com")).getByRole("button", { name: "More actions for i1@example.com" })
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Withdraw invitation" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Editor, invited");
    await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    expect(api.deleteInvitation).toHaveBeenCalledWith("org-cookie", "i1");
    expect(api.refreshOrganizationMembers).toHaveBeenCalledWith("org-cookie");
    expect(toast.success).toHaveBeenCalledWith("Invitation to i1@example.com withdrawn.");
  });

  it("invites from the page and reads every member list again", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Invite members" }));
    await userEvent.type(await screen.findByLabelText("Email addresses"), "neu@x.de,");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(api.inviteMember).toHaveBeenCalledWith("org-cookie", {
      user_email: "neu@x.de",
      role: "organization-editor",
    });
    expect(api.refreshOrganizationMembers).toHaveBeenCalledWith("org-cookie");
    expect(toast.success).toHaveBeenCalledWith("Invitation sent to neu@x.de.");
  });

  it("explains the roles", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Roles explained" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("table")).toHaveTextContent("Delete the organization");
  });
});
