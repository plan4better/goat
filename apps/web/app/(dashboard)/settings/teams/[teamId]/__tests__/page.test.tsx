import { type Theme, getContrastRatio } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { ApiError } from "@/lib/api/apiError";

import TeamPage from "@/app/(dashboard)/settings/teams/[teamId]/page";

const api = vi.hoisted(() => {
  const orgMember = (id: string, firstname: string, email: string, role: string, status = "accepted") => ({
    id,
    firstname,
    lastname: firstname ? "Muster" : "",
    email,
    roles: [role],
    invitation_status: status,
    avatar: "",
  });
  return {
    team: undefined as Record<string, unknown> | null | undefined,
    teamError: undefined as unknown,
    profileLoaded: true,
    orgRoles: ["organization-editor"] as string[],
    members: [] as Record<string, unknown>[],
    membersError: undefined as unknown,
    ORG_MEMBERS: [
      orgMember("u1", "Anna", "anna@x.de", "organization-editor"),
      orgMember("u2", "Ben", "ben@x.de", "organization-viewer"),
      orgMember("u3", "", "cara@x.de", "organization-editor"),
      orgMember("i1", "", "invited@x.de", "organization-editor", "pending"),
    ],
    orgMembers: undefined as Record<string, unknown>[] | undefined,
    orgError: undefined as unknown,
    spaces: [] as Record<string, unknown>[],
    push: vi.fn(),
    deleteTeam: vi.fn(),
    deleteTeamMember: vi.fn(),
    updateTeam: vi.fn(),
    mutateTeam: vi.fn(),
    mutateMembers: vi.fn(),
    mutateOrgMembers: vi.fn(),
    mutateTeams: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: api.push, prefetch: vi.fn() }) }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/settings/useOrganizationId", () => ({ useOrganizationId: () => "org-1" }));
vi.mock("@/lib/api/users", () => ({
  useUserProfile: () => ({ userProfile: api.profileLoaded ? { id: "u1", roles: api.orgRoles } : undefined }),
}));
vi.mock("@/lib/api/content", () => ({ useSpaces: () => ({ spaces: api.spaces }) }));
vi.mock("@/lib/api/organizations", () => ({
  useOrganizationMembers: () => ({
    members: api.orgMembers,
    isError: api.orgError,
    mutate: api.mutateOrgMembers,
  }),
}));
vi.mock("@/lib/api/teams", () => ({
  useTeam: () => ({
    team: api.team,
    isLoading: api.team === undefined && !api.teamError,
    isError: api.teamError,
    mutate: api.mutateTeam,
  }),
  useTeams: () => ({
    teams: [
      { id: "t1", name: "Stadtplanung" },
      { id: "t2", name: "Verkehr" },
    ],
    mutate: api.mutateTeams,
  }),
  useTeamMembers: () => ({
    teamMembers: api.members,
    isLoading: false,
    isError: api.membersError,
    mutate: api.mutateMembers,
  }),
  updateTeam: api.updateTeam,
  deleteTeam: api.deleteTeam,
  deleteMember: api.deleteTeamMember,
  createTeamMember: vi.fn(),
}));

const teamMember = (id: string, firstname: string, email: string, role: string) => ({
  id,
  firstname,
  lastname: firstname ? "Muster" : "",
  email,
  role,
  avatar: "",
  invitation_status: "accepted",
});

const renderPage = async (theme?: Theme) => {
  const page = (
    <I18nextProvider i18n={commonI18n("en")}>
      <Suspense fallback={null}>
        <TeamPage params={Promise.resolve({ teamId: "t1" })} />
      </Suspense>
    </I18nextProvider>
  );
  // The page suspends on its params (`use`): an awaited act lets it resume.
  await act(async () => {
    render(theme ? <ThemeProvider theme={theme}>{page}</ThemeProvider> : page);
  });
  await screen.findByRole("navigation", { name: "Path" });
};

/** Delete and leave drop the team from the list at once, then read it again, before going back. */
const expectTeamDroppedBeforePush = () => {
  expect(api.mutateTeams).toHaveBeenCalledWith(expect.any(Function), { revalidate: true });
  const update = api.mutateTeams.mock.calls[0][0] as (list?: { id: string }[]) => unknown;
  expect(update([{ id: "t1" }, { id: "t2" }])).toEqual([{ id: "t2" }]);
  expect(update(undefined)).toBeUndefined();
  expect(api.mutateTeams.mock.invocationCallOrder[0]).toBeLessThan(api.push.mock.invocationCallOrder[0]);
  expect(api.push).toHaveBeenCalledWith("/settings/teams");
};

describe("Team page", () => {
  beforeEach(() => {
    api.team = { id: "t1", name: "Stadtplanung", description: "", avatar: "", role: "team-owner" };
    api.teamError = undefined;
    api.membersError = undefined;
    api.orgMembers = api.ORG_MEMBERS;
    api.orgError = undefined;
    api.spaces = [{ id: "s1", kind: "team", team_id: "t1" }];
    api.profileLoaded = true;
    api.orgRoles = ["organization-editor"];
    api.members = [
      teamMember("u2", "Ben", "ben@x.de", "team-member"),
      teamMember("u1", "Anna", "anna@x.de", "team-owner"),
    ];
    for (const fn of [
      api.push,
      api.deleteTeam,
      api.deleteTeamMember,
      api.updateTeam,
      api.mutateTeam,
      api.mutateMembers,
      api.mutateOrgMembers,
      api.mutateTeams,
    ]) {
      fn.mockReset();
    }
    api.deleteTeamMember.mockResolvedValue(new Response("{}"));
    api.updateTeam.mockResolvedValue(new Response("{}"));
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("shows the team's head with the owner badge and the link to its space", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Stadtplanung" })).toBeInTheDocument();
    expect(screen.getByText("You are the owner")).toBeInTheDocument();
    await expect(screen.getByRole("link", { name: "Team space under Content" })).toHaveAttribute(
      "href",
      "/content/s1"
    );
    const path = screen.getByRole("navigation", { name: "Path" });
    await expect(within(path).getByRole("link", { name: "Teams" })).toHaveAttribute(
      "href",
      "/settings/teams"
    );
    await expect(within(path).getByText("Stadtplanung")).toHaveAttribute("aria-current", "page");
  });

  it.each(["light", "dark"] as const)(
    "writes the owner badge in an ink that reads on the page (%s)",
    async (mode) => {
      const theme = createAppTheme({ mode, locale: "en" });
      await renderPage(theme);
      const ink = getComputedStyle(screen.getByText("You are the owner")).color;
      expect(getContrastRatio(ink, theme.palette.background.default)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it("lists the owner first, lets the owner remove members but never the owner row", async () => {
    await renderPage();
    const card = screen.getByRole("region", { name: /^Members/ });
    expect(card).toHaveAccessibleName("Members 2");
    const rows = within(card).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Anna Muster");
    expect(rows[0]).toHaveTextContent("You");
    expect(rows[0]).toHaveTextContent("Owner");
    expect(within(rows[0]).queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(rows[1]).toHaveTextContent("Viewer in the organization");
    await userEvent.click(within(rows[1]).getByRole("button", { name: "More actions for Ben Muster" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from the team" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Ben Muster loses access to the space of Stadtplanung.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(api.deleteTeamMember).toHaveBeenCalledWith("t1", "u2");
    expect(api.mutateMembers).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Ben Muster is no longer in the team.");
  });

  it("names a member without a name by their address", async () => {
    api.members = [...api.members, teamMember("u3", "", "cara@x.de", "team-member")];
    await renderPage();
    const rows = within(screen.getByRole("region", { name: /^Members/ })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent("cara@x.de");
    expect(within(rows[2]).getByRole("button", { name: "More actions for cara@x.de" })).toBeInTheDocument();
  });

  it("shows the rows while the organization's members load, without their roles and with Add disabled", async () => {
    api.orgMembers = undefined;
    await renderPage();
    const card = screen.getByRole("region", { name: /^Members/ });
    expect(within(card).getAllByRole("listitem")).toHaveLength(2);
    expect(card).not.toHaveTextContent("in the organization");
    await expect(within(card).getByRole("button", { name: "Add members" })).toBeDisabled();
  });

  it("keeps the rows when the organization's members do not load, and offers to try again", async () => {
    api.orgMembers = undefined;
    api.orgError = new Error("HTTP 500");
    await renderPage();
    const card = screen.getByRole("region", { name: /^Members/ });
    expect(within(card).getAllByRole("listitem")).toHaveLength(2);
    expect(card).not.toHaveTextContent("in the organization");
    await expect(within(card).getByRole("button", { name: "Add members" })).toBeDisabled();
    await userEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(api.mutateOrgMembers).toHaveBeenCalled();
  });

  it("says when the team's members do not load and reads them again on request", async () => {
    api.members = [];
    api.membersError = new Error("HTTP 500");
    await renderPage();
    const card = screen.getByRole("region", { name: /^Members/ });
    expect(within(card).queryAllByRole("listitem")).toHaveLength(0);
    expect(card).toHaveTextContent("That could not be loaded.");
    await userEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(api.mutateMembers).toHaveBeenCalled();
  });

  it("offers the people of the organization who are not in the team, nameless ones by their address", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Add members" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("checkbox", { name: "cara@x.de" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox", { name: "Ben Muster" })).toBeNull();
    // Invitations cannot be added to a team.
    expect(within(dialog).queryByRole("checkbox", { name: "invited@x.de" })).toBeNull();
  });

  it("renames the team, refusing the name of another team the caller sees", async () => {
    await renderPage();
    const name = screen.getByLabelText(/^Team name/);
    await userEvent.clear(name);
    await userEvent.type(name, "verkehr");
    expect(screen.getByText("A team with this name already exists.")).toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, "Stadtplanung Nord");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    // Without a picture the avatar is left out: core keeps NULL instead of storing "".
    expect(api.updateTeam).toHaveBeenCalledWith("t1", { name: "Stadtplanung Nord", description: "" });
    expect(api.mutateTeam).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Team profile saved.");
  });

  it("counts the team's name as it is saved, without the spaces around it", async () => {
    await renderPage();
    const name = screen.getByLabelText(/^Team name/);
    await userEvent.clear(name);
    await userEvent.type(name, "  Umwelt  ");
    expect(screen.getByText("6/50")).toBeInTheDocument();
  });

  it("keeps the delete dialog open on a 409 and says why, with the way to the space", async () => {
    api.deleteTeam.mockRejectedValue(new ApiError(409, "The team still owns content"));
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Delete team" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete team" }));
    expect(api.deleteTeam).toHaveBeenCalledWith("t1");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "There is still content in the team's space."
    );
    await expect(within(dialog).getByRole("link", { name: "Open the team's space" })).toHaveAttribute(
      "href",
      "/content/s1"
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(api.push).not.toHaveBeenCalled();
  });

  it("leaves out the way to the space when the team's space is not among the caller's spaces", async () => {
    api.spaces = [{ id: "s9", kind: "team", team_id: "t9" }];
    api.deleteTeam.mockRejectedValue(new ApiError(409, "The team still owns content"));
    await renderPage();
    expect(screen.queryByRole("link", { name: "Team space under Content" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Delete team" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete team" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "There is still content in the team's space."
    );
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("deletes a team without content and goes back to Teams", async () => {
    api.deleteTeam.mockResolvedValue({});
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Delete team" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Do you really want to delete Stadtplanung?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete team" }));
    expect(toast.success).toHaveBeenCalledWith("Team “Stadtplanung” deleted.");
    expectTeamDroppedBeforePush();
  });

  it("lets a member who is not the owner leave, removing only themselves", async () => {
    api.team = { id: "t1", name: "Stadtplanung", description: "", avatar: "", role: "team-member" };
    api.members = [
      teamMember("u1", "Anna", "anna@x.de", "team-member"),
      teamMember("u2", "Ben", "ben@x.de", "team-owner"),
    ];
    await renderPage();
    expect(screen.getByText("You are a member")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add members" })).toBeNull();
    expect(screen.getByText("The team's owner adds members.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete team" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    // The profile, read-only: the owner named.
    const profile = screen.getByRole("region", { name: "Team profile" });
    expect(profile).toHaveTextContent("Only the team's owner can change the profile.");
    expect(within(profile).getByText("Owner", { selector: "dt" }).nextElementSibling).toHaveTextContent(
      "Ben Muster"
    );
    expect(screen.queryByLabelText(/^Team name/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Leave team" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Do you really want to leave Stadtplanung?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Leave team" }));
    expect(api.deleteTeamMember).toHaveBeenCalledWith("t1", "u1");
    expect(api.deleteTeam).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("You left Stadtplanung.");
    expectTeamDroppedBeforePush();
  });

  it("shows an organization admin who is a member both delete and leave", async () => {
    api.team = { id: "t1", name: "Stadtplanung", description: "", avatar: "", role: "team-member" };
    api.orgRoles = ["organization-admin"];
    await renderPage();
    expect(screen.getByRole("button", { name: "Delete team" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave team" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Team name/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add members" })).toBeNull();
  });

  it("lets a team owner who is a viewer manage members but not rename or delete the team", async () => {
    api.orgRoles = ["organization-viewer"];
    await renderPage();
    expect(screen.getByRole("button", { name: "Add members" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Team name/)).toBeNull();
    const profile = screen.getByRole("region", { name: "Team profile" });
    expect(profile).toHaveTextContent("As a viewer you cannot change the team's profile.");
    expect(profile).not.toHaveTextContent("Only the team's owner can change the profile.");
    expect(screen.queryByRole("button", { name: "Delete team" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Leave team" })).toBeNull();
  });

  it("waits for the profile before the cards that depend on the caller's role", async () => {
    api.team = { id: "t1", name: "Stadtplanung", description: "", avatar: "", role: "team-member" };
    api.profileLoaded = false;
    await renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Stadtplanung" })).toBeInTheDocument();
    const profile = screen.getByRole("region", { name: "Team profile" });
    expect(within(profile).getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("Only the team's owner can change the profile.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Leave team" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete team" })).toBeNull();
  });

  it("says when the team is gone or the caller is not in it", async () => {
    api.team = null;
    await renderPage();
    expect(screen.getByText("This team no longer exists, or you do not belong to it.")).toBeInTheDocument();
    await expect(screen.getByRole("link", { name: "Back to teams" })).toHaveAttribute(
      "href",
      "/settings/teams"
    );
    expect(within(screen.getByRole("navigation", { name: "Path" })).queryByText("/")).toBeNull();
  });

  it("scrolls the path and the head with the cards while the team loads, when it is missing and when it is shown", async () => {
    const scrolls = (element: Element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (getComputedStyle(node).overflowY === "auto") return true;
      }
      return false;
    };
    api.team = undefined;
    const loading = await act(async () =>
      render(
        <I18nextProvider i18n={commonI18n("en")}>
          <Suspense fallback={null}>
            <TeamPage params={Promise.resolve({ teamId: "t1" })} />
          </Suspense>
        </I18nextProvider>
      )
    );
    expect(scrolls(await screen.findByRole("navigation", { name: "Path" }))).toBe(true);
    // The head's placeholder sits with the path, where the head will be.
    expect(scrolls(screen.getAllByRole("status", { name: "Loading" })[0])).toBe(true);
    expect(scrolls(screen.getByRole("region", { name: "Team profile" }))).toBe(true);
    loading.unmount();

    api.team = null;
    const missing = await act(async () =>
      render(
        <I18nextProvider i18n={commonI18n("en")}>
          <Suspense fallback={null}>
            <TeamPage params={Promise.resolve({ teamId: "t1" })} />
          </Suspense>
        </I18nextProvider>
      )
    );
    expect(scrolls(await screen.findByRole("navigation", { name: "Path" }))).toBe(true);
    missing.unmount();

    api.team = { id: "t1", name: "Stadtplanung", description: "", avatar: "", role: "team-owner" };
    await renderPage();
    expect(scrolls(screen.getByRole("navigation", { name: "Path" }))).toBe(true);
    expect(scrolls(screen.getByRole("heading", { level: 2, name: "Stadtplanung" }))).toBe(true);
    expect(scrolls(screen.getByRole("region", { name: "Team profile" }))).toBe(true);
  });

  it("says the same when core answers 404", async () => {
    api.team = undefined;
    api.teamError = Object.assign(new Error("HTTP 404"), { status: 404 });
    await renderPage();
    expect(screen.getByText("This team no longer exists, or you do not belong to it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Path" })).queryByText("/")).toBeNull();
  });
});
