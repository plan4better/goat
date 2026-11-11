import { type Theme, getContrastRatio } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { ApiError } from "@/lib/api/apiError";
import { TEAMS_API_BASE_URL } from "@/lib/api/teams";

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
    teams: [] as Record<string, unknown>[],
    teamsCalls: [] as unknown[],
    push: vi.fn(),
    deleteTeam: vi.fn(),
    deleteTeamMember: vi.fn(),
    updateTeam: vi.fn(),
    changeTeamOwner: vi.fn(),
    createTeamMember: vi.fn(),
    globalMutate: vi.fn(),
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
// The bare `GET /teams` key (Home, the share dialogs) is revalidated through SWR's global mutate.
vi.mock("swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("swr")>()),
  mutate: api.globalMutate,
}));
vi.mock("@/lib/api/teams", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/teams")>("@/lib/api/teams");
  return {
    // Which list to read, as the page decides it (tested in lib/api), and the bare key.
    teamsScopeOf: actual.teamsScopeOf,
    TEAMS_API_BASE_URL: actual.TEAMS_API_BASE_URL,
    useTeam: () => ({
      team: api.team,
      isLoading: api.team === undefined && !api.teamError,
      isError: api.teamError,
      mutate: api.mutateTeam,
    }),
    useTeams: (options: unknown) => {
      api.teamsCalls.push(options);
      return { teams: api.teams, mutate: api.mutateTeams };
    },
    useTeamMembers: () => ({
      teamMembers: api.members,
      isLoading: false,
      isError: api.membersError,
      mutate: api.mutateMembers,
    }),
    updateTeam: api.updateTeam,
    deleteTeam: api.deleteTeam,
    deleteMember: api.deleteTeamMember,
    createTeamMember: api.createTeamMember,
    changeTeamOwner: api.changeTeamOwner,
  };
});

const teamMember = (id: string, firstname: string, email: string, role: string) => ({
  id,
  firstname,
  lastname: firstname ? "Muster" : "",
  email,
  role,
  avatar: "",
  invitation_status: "accepted",
});

const renderPage = async (theme?: Theme, language: "en" | "de" = "en") => {
  const params = Promise.resolve({ teamId: "t1" });
  const tree = () => {
    const page = (
      <I18nextProvider i18n={commonI18n(language)}>
        <Suspense fallback={null}>
          <TeamPage params={params} />
        </Suspense>
      </I18nextProvider>
    );
    return theme ? <ThemeProvider theme={theme}>{page}</ThemeProvider> : page;
  };
  // The page suspends on its params (`use`): an awaited act lets it resume.
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(tree());
  });
  await screen.findByRole("navigation", { name: language === "de" ? "Pfad" : "Path" });
  /** Draws the page again with what the mocks answer now (as SWR after a mutate). */
  return {
    rerender: async () => {
      await act(async () => view!.rerender(tree()));
    },
  };
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
    api.team = {
      id: "t1",
      name: "Stadtplanung",
      description: "",
      avatar: "",
      role: "team-owner",
      members_preview: [{ id: "u1", firstname: "Anna", role: "team-owner" }],
    };
    api.teams = [
      { id: "t1", name: "Stadtplanung" },
      { id: "t2", name: "Verkehr" },
    ];
    api.teamsCalls = [];
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
      api.changeTeamOwner,
      api.createTeamMember,
      api.globalMutate,
    ]) {
      fn.mockReset();
    }
    api.changeTeamOwner.mockResolvedValue([]);
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
    // The Teams cards' count and faces follow.
    expect(api.mutateTeams).toHaveBeenCalled();
    // The list shows it: the dialog closes, no toast says so.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("adds a member and reads the team list again, so the cards follow", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Add members" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "cara@x.de" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(api.createTeamMember).toHaveBeenCalledWith("t1", "u3");
    expect(api.mutateMembers).toHaveBeenCalled();
    expect(api.mutateTeams).toHaveBeenCalled();
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
    // The card's save bar says so; no toast.
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Team profile" })).getByRole("status")
      ).toHaveTextContent("All saved")
    );
    expect(toast.success).not.toHaveBeenCalled();
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
    // Back on Teams, without the team: no toast says so.
    expectTeamDroppedBeforePush();
    expect(toast.success).not.toHaveBeenCalled();
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
    expect(screen.getByText("The team's owner or an admin adds members.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete team" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    // The profile, read-only: the owner named.
    const profile = screen.getByRole("region", { name: "Team profile" });
    expect(profile).toHaveTextContent("Only the team's owner and admins can change the profile.");
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
    // Back on Teams, without the team: no toast says so.
    expectTeamDroppedBeforePush();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows an organization admin who is a member both delete and leave, and lets them manage members", async () => {
    api.team = { id: "t1", name: "Stadtplanung", description: "", avatar: "", role: "team-member" };
    api.orgRoles = ["organization-admin"];
    await renderPage();
    expect(screen.getByText("You are a member")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete team" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave team" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Team name/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add members" })).toBeInTheDocument();
    expect(api.teamsCalls.at(-1)).toEqual({ scope: "organization", enabled: true });
  });

  it("lets a team owner who is a viewer manage members but not rename or delete the team", async () => {
    api.orgRoles = ["organization-viewer"];
    await renderPage();
    expect(screen.getByRole("button", { name: "Add members" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Team name/)).toBeNull();
    const profile = screen.getByRole("region", { name: "Team profile" });
    expect(profile).toHaveTextContent("As a viewer you cannot change the team's profile.");
    expect(profile).not.toHaveTextContent("Only the team's owner and admins can change the profile.");
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
    expect(screen.queryByText("Only the team's owner and admins can change the profile.")).toBeNull();
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

  it("keeps the path and the head in the page with the cards while the team loads, when it is missing and when it is shown", async () => {
    // The page's frame (its `SettingsPage`, the outermost element it draws):
    // what sits in it scrolls with the cards in the layout's area.
    const frameOf = (element: Element) => {
      let node = element;
      while (node.parentElement && node.parentElement.parentElement !== document.body)
        node = node.parentElement;
      return node;
    };
    // Nothing in the frame scrolls on its own.
    const ownScroller = (element: Element) => {
      for (
        let node = element.parentElement;
        node && node.parentElement !== document.body;
        node = node.parentElement
      ) {
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
    const path = await screen.findByRole("navigation", { name: "Path" });
    // The head's placeholder sits with the path, where the head will be.
    const head = screen.getAllByRole("status", { name: "Loading" })[0];
    const profile = screen.getByRole("region", { name: "Team profile" });
    expect(frameOf(head)).toBe(frameOf(path));
    expect(frameOf(profile)).toBe(frameOf(path));
    for (const element of [path, head, profile]) expect(ownScroller(element)).toBe(false);
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
    expect(ownScroller(await screen.findByRole("navigation", { name: "Path" }))).toBe(false);
    missing.unmount();

    api.team = { id: "t1", name: "Stadtplanung", description: "", avatar: "", role: "team-owner" };
    await renderPage();
    const shownPath = screen.getByRole("navigation", { name: "Path" });
    const heading = screen.getByRole("heading", { level: 2, name: "Stadtplanung" });
    const shownProfile = screen.getByRole("region", { name: "Team profile" });
    expect(frameOf(heading)).toBe(frameOf(shownPath));
    expect(frameOf(shownProfile)).toBe(frameOf(shownPath));
    for (const element of [shownPath, heading, shownProfile]) expect(ownScroller(element)).toBe(false);
  });

  it("says the same when core answers 404", async () => {
    api.team = undefined;
    api.teamError = Object.assign(new Error("HTTP 404"), { status: 404 });
    await renderPage();
    expect(screen.getByText("This team no longer exists, or you do not belong to it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Path" })).queryByText("/")).toBeNull();
  });

  it("reads the caller's own teams for the name check, once their role is known", async () => {
    await renderPage();
    expect(api.teamsCalls.at(-1)).toEqual({ scope: "mine", enabled: true });
    cleanup();
    api.teamsCalls = [];
    api.profileLoaded = false;
    await renderPage();
    expect(api.teamsCalls.every((call) => (call as { enabled: boolean }).enabled === false)).toBe(true);
  });

  it("saves a new description of a team whose name another team shares from before names were checked", async () => {
    api.teams = [
      { id: "t1", name: "Stadtplanung" },
      { id: "t7", name: "Stadtplanung" },
    ];
    await renderPage();
    await userEvent.type(screen.getByLabelText(/^Description/), "Bebauungspläne");
    expect(screen.queryByText("A team with this name already exists.")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.updateTeam).toHaveBeenCalledWith("t1", {
      name: "Stadtplanung",
      description: "Bebauungspläne",
    });
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Team profile" })).getByRole("status")
      ).toHaveTextContent("All saved")
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows a name core refuses as taken as the name's error, as Neues Team does", async () => {
    api.updateTeam.mockRejectedValue(
      new ApiError(409, "A team with this name already exists in the organization")
    );
    await renderPage();
    const name = screen.getByLabelText(/^Team name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Umwelt");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("A team with this name already exists.")).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    await expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // Another name is checked again.
    await userEvent.type(name, " Nord");
    expect(screen.queryByText("A team with this name already exists.")).toBeNull();
  });

  it("has an admin's rename reach the lists of Home and the share dialogs too", async () => {
    api.orgRoles = ["organization-admin"];
    await renderPage();
    const name = screen.getByLabelText(/^Team name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Stadtplanung Nord");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.mutateTeams).toHaveBeenCalled();
    expect(api.globalMutate).toHaveBeenCalledWith(TEAMS_API_BASE_URL);
  });

  it("reads the caller's own list once when it is the list Teams shows", async () => {
    await renderPage();
    const name = screen.getByLabelText(/^Team name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Stadtplanung Nord");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.mutateTeams).toHaveBeenCalled();
    expect(api.globalMutate).not.toHaveBeenCalled();
  });

  it("lets an organization admin outside the team manage it", async () => {
    api.team = {
      id: "t1",
      name: "Stadtplanung",
      // Core sends no description as null.
      description: null,
      avatar: "",
      role: null,
      members_preview: [{ id: "u4", firstname: "Dora", role: "team-owner" }],
    };
    api.orgRoles = ["organization-admin"];
    // The caller (u1) is not in the team; Dora owns it.
    api.members = [
      teamMember("u2", "Ben", "ben@x.de", "team-member"),
      teamMember("u4", "Dora", "dora@x.de", "team-owner"),
    ];
    await renderPage();
    expect(screen.getByText("You manage the team as an admin")).toBeInTheDocument();
    expect(screen.queryByText("You manage the team as the organization's owner")).toBeNull();
    expect(screen.getByRole("button", { name: "Add members" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete team" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Team name/)).toBeInTheDocument();
    await expect(screen.getByLabelText(/^Description/)).toHaveValue("");
    expect(screen.getAllByText("No description").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Leave team" })).toBeNull();
    expect(screen.queryByText(/This team has no owner\./)).toBeNull();
    const rows = within(screen.getByRole("region", { name: /^Members/ })).getAllByRole("listitem");
    expect(within(rows[0]).queryByRole("button", { name: /More actions/ })).toBeNull(); // the team's owner
    await userEvent.click(within(rows[1]).getByRole("button", { name: "More actions for Ben Muster" }));
    expect(screen.getByRole("menuitem", { name: /^Make owner/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove from the team" })).toBeInTheDocument();
  });

  it("names the organization's owner as its owner, not as an admin, in a team they are not in", async () => {
    api.team = {
      id: "t1",
      name: "Stadtplanung",
      description: "",
      avatar: "",
      role: null,
      members_preview: [{ id: "u4", firstname: "Dora", role: "team-owner" }],
    };
    api.orgRoles = ["organization-owner"];
    api.members = [
      teamMember("u2", "Ben", "ben@x.de", "team-member"),
      teamMember("u4", "Dora", "dora@x.de", "team-owner"),
    ];
    await renderPage();
    expect(screen.getByText("You manage the team as the organization's owner")).toBeInTheDocument();
    expect(screen.queryByText("You manage the team as an admin")).toBeNull();
    cleanup();

    await renderPage(undefined, "de");
    expect(screen.getByText("Sie verwalten das Team als Eigentümer der Organisation")).toBeInTheDocument();
    expect(screen.queryByText("Sie verwalten das Team als Admin")).toBeNull();
    cleanup();

    // An admin keeps the admin's words.
    api.orgRoles = ["organization-admin"];
    await renderPage(undefined, "de");
    expect(screen.getByText("Sie verwalten das Team als Admin")).toBeInTheDocument();
  });

  it("tells owners and admins that a team has no owner, and lets them name one", async () => {
    api.team = {
      id: "t1",
      name: "Stadtplanung",
      description: "",
      avatar: "",
      role: null,
      members_preview: [{ id: "u3", firstname: "", role: "team-member" }],
    };
    api.orgRoles = ["organization-owner"];
    api.members = [teamMember("u3", "", "cara@x.de", "team-member")];
    await renderPage();
    const alert = screen.getByRole("note");
    await expect(alert).toHaveTextContent(/^This team has no owner\./);
    // Above the members.
    expect(alert.compareDocumentPosition(screen.getByRole("region", { name: /^Members/ }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await userEvent.click(screen.getByRole("button", { name: "More actions for cara@x.de" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /^Make owner/ }));
    const dialog = await screen.findByRole("dialog");
    await expect(dialog).toHaveTextContent("cara@x.de becomes the owner of Stadtplanung.");
    await expect(dialog).not.toHaveTextContent("You stay a member of the team.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change owner" }));
    expect(api.changeTeamOwner).toHaveBeenCalledWith("t1", "u3");
    // The members read again show the new owner: no toast says so.
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.mutateMembers).toHaveBeenCalled();
    expect(api.mutateTeam).toHaveBeenCalled();
  });

  it("shows a plain member neither the ownerless alert nor any member action", async () => {
    api.team = {
      id: "t1",
      name: "Stadtplanung",
      description: "",
      avatar: "",
      role: "team-member",
      members_preview: [{ id: "u2", firstname: "Ben", role: "team-member" }],
    };
    await renderPage();
    expect(screen.queryByText(/This team has no owner\./)).toBeNull();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
  });

  it("lets the owner hand the team over, says they stay a member and reloads their permissions", async () => {
    api.members = [...api.members, teamMember("u3", "", "cara@x.de", "team-member")];
    const page = await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for cara@x.de" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /^Make owner/ }));
    const dialog = await screen.findByRole("dialog");
    await expect(dialog).toHaveTextContent("cara@x.de becomes the owner of Stadtplanung.");
    await expect(dialog).toHaveTextContent("You stay a member of the team.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change owner" }));
    expect(api.changeTeamOwner).toHaveBeenCalledWith("t1", "u3");
    expect(api.mutateTeam).toHaveBeenCalled(); // the caller's role in the team, and so their permissions
    expect(api.mutateTeams).toHaveBeenCalled();
    expect(api.mutateMembers).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    // What the reads answer: the caller is a member now, cara the owner.
    api.team = {
      ...api.team,
      role: "team-member",
      members_preview: [{ id: "u3", firstname: "", role: "team-owner" }],
    };
    api.members = [
      teamMember("u1", "Anna", "anna@x.de", "team-member"),
      teamMember("u2", "Ben", "ben@x.de", "team-member"),
      teamMember("u3", "", "cara@x.de", "team-owner"),
    ];
    await page.rerender();
    expect(screen.getByText("You are a member")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete team" })).toBeNull();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^Make owner/ })).toBeNull();
    expect(screen.queryByLabelText(/^Team name/)).toBeNull();
    expect(screen.getByRole("button", { name: "Leave team" })).toBeInTheDocument();
  });

  it("does not offer a viewer of the organization the ownership, and says why", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for Ben Muster" }));
    const item = screen.getByRole("menuitem", { name: /^Make owner/ });
    await expect(item).toHaveAttribute("aria-disabled", "true");
    expect(within(item).getByText("Viewers cannot own a team.")).toBeInTheDocument();
  });

  it("offers no ownership to a team owner who is a viewer, who may not rename the team either", async () => {
    api.orgRoles = ["organization-viewer"];
    api.members = [...api.members, teamMember("u3", "", "cara@x.de", "team-member")];
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for cara@x.de" }));
    expect(screen.queryByRole("menuitem", { name: /^Make owner/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Remove from the team" })).toBeInTheDocument();
  });

  it("says so when the new owner became a viewer meanwhile, and reads the people again", async () => {
    api.changeTeamOwner.mockRejectedValue(new ApiError(400, "A viewer cannot own a team"));
    api.members = [...api.members, teamMember("u3", "", "cara@x.de", "team-member")];
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for cara@x.de" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /^Make owner/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change owner" }));
    expect(toast.error).toHaveBeenCalledWith(
      "The owner could not be changed. cara@x.de is a viewer in the organization and cannot own a team."
    );
    expect(api.mutateOrgMembers).toHaveBeenCalled();
    expect(api.mutateMembers).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says so when the new owner left the team before the click (core's 400), and reads everything again", async () => {
    api.changeTeamOwner.mockRejectedValue(
      new ApiError(400, "Only a member of the team can become its owner")
    );
    api.members = [...api.members, teamMember("u3", "", "cara@x.de", "team-member")];
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for cara@x.de" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /^Make owner/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change owner" }));
    expect(toast.error).toHaveBeenCalledWith(
      "The owner could not be changed. cara@x.de is no longer in the team."
    );
    expect(toast.success).not.toHaveBeenCalled();
    for (const read of [api.mutateMembers, api.mutateOrgMembers, api.mutateTeam, api.mutateTeams]) {
      expect(read).toHaveBeenCalled();
    }
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers the ownership only once the organization's roles are known", async () => {
    api.orgMembers = undefined;
    api.members = [...api.members, teamMember("u3", "", "cara@x.de", "team-member")];
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for cara@x.de" }));
    await expect(screen.getByRole("menuitem", { name: /^Make owner/ })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.queryByText("Viewers cannot own a team.")).toBeNull();
  });

  it("says when the new owner left the team meanwhile, and reads the members again", async () => {
    api.changeTeamOwner.mockRejectedValue(new ApiError(409, "The person is no longer a member of the team"));
    api.members = [...api.members, teamMember("u3", "", "cara@x.de", "team-member")];
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for cara@x.de" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /^Make owner/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change owner" }));
    expect(toast.error).toHaveBeenCalledWith(
      "The owner could not be changed. cara@x.de is no longer in the team."
    );
    expect(toast.success).not.toHaveBeenCalled();
    for (const read of [api.mutateMembers, api.mutateOrgMembers, api.mutateTeam, api.mutateTeams]) {
      expect(read).toHaveBeenCalled();
    }
    // The person it named is gone: the dialog closes.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has an admin who leaves a team read the organization's list again, where the team stays", async () => {
    api.team = { id: "t1", name: "Stadtplanung", description: "", avatar: "", role: "team-member" };
    api.orgRoles = ["organization-admin"];
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Leave team" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Leave team" }));
    expect(api.deleteTeamMember).toHaveBeenCalledWith("t1", "u1");
    // Read again, not dropped: the admin still sees the team, now without a role in it.
    expect(api.mutateTeams).toHaveBeenCalledWith();
    expect(api.globalMutate).toHaveBeenCalledWith(TEAMS_API_BASE_URL);
    expect(api.push).toHaveBeenCalledWith("/settings/teams");
  });

  it("has an admin who deletes a team drop it from both lists", async () => {
    api.orgRoles = ["organization-admin"];
    api.deleteTeam.mockResolvedValue({});
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Delete team" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete team" }));
    expectTeamDroppedBeforePush();
    expect(api.globalMutate).toHaveBeenCalledWith(TEAMS_API_BASE_URL);
  });
});
