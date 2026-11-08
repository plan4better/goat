import { getContrastRatio } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { ApiError } from "@/lib/api/apiError";

import TeamsPage from "@/app/(dashboard)/settings/teams/page";

const api = vi.hoisted(() => ({
  teams: [] as Record<string, unknown>[],
  isLoading: false,
  isError: undefined as unknown,
  roles: ["organization-editor"] as string[] | undefined,
  profileError: undefined as unknown,
  mutateProfile: vi.fn(),
  teamsCalls: [] as unknown[],
  createTeam: vi.fn(),
  mutate: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: api.push, prefetch: vi.fn() }) }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/users", () => ({
  useUserProfile: () => ({
    userProfile: api.roles ? { id: "u1", roles: api.roles } : undefined,
    isError: api.profileError,
    mutate: api.mutateProfile,
  }),
}));
vi.mock("@/lib/api/teams", async () => ({
  // Which list to read, as the page decides it (tested in lib/api).
  teamsScopeOf: (await vi.importActual<typeof import("@/lib/api/teams")>("@/lib/api/teams")).teamsScopeOf,
  useTeams: (options: { enabled?: boolean } = {}) => {
    api.teamsCalls.push(options);
    // As SWR without a key: nothing is read, nothing comes back.
    const enabled = options.enabled !== false;
    return {
      teams: enabled ? api.teams : [],
      isLoading: enabled && api.isLoading,
      isError: enabled ? api.isError : undefined,
      mutate: api.mutate,
    };
  },
  createTeam: api.createTeam,
}));

// The list carries each team's faces (owner first) and its count; no read per card.
const face = (id: string, firstname: string, role = "team-member") => ({
  id,
  firstname,
  lastname: "",
  avatar: "",
  role,
});
const TEAMS = [
  {
    id: "t2",
    name: "Verkehr",
    description: "",
    role: "team-member",
    avatar: "",
    member_count: 1,
    members_preview: [face("u3", "Carl", "team-owner")],
  },
  {
    id: "t1",
    name: "Stadtplanung",
    description: "Bebauungspläne und Flächen",
    role: "team-owner",
    avatar: "",
    member_count: 2,
    members_preview: [face("u1", "Anna", "team-owner"), face("u2", "Ben")],
  },
];
// A team the admin is not in, whose owner has left; core sends no description as null.
const UMWELT = {
  id: "t3",
  name: "Umwelt",
  description: null,
  role: null,
  avatar: "",
  member_count: 1,
  members_preview: [face("u5", "Eva")],
};

const renderPage = (language: "en" | "de" = "en") =>
  render(
    <I18nextProvider i18n={commonI18n(language)}>
      <TeamsPage />
    </I18nextProvider>
  );

describe("Teams page", () => {
  beforeEach(() => {
    api.teams = TEAMS;
    api.isLoading = false;
    api.isError = undefined;
    api.roles = ["organization-editor"];
    api.profileError = undefined;
    api.mutateProfile.mockReset().mockResolvedValue(undefined);
    api.teamsCalls = [];
    api.createTeam.mockReset();
    api.mutate.mockReset();
    api.push.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("shows the teams as cards by name, each a link to its page", async () => {
    renderPage();
    const cards = screen.getAllByRole("link", { name: /^Open team / });
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Open team Stadtplanung",
      "Open team Verkehr",
    ]);
    await expect(cards[0]).toHaveAttribute("href", "/settings/teams/t1");
    await expect(cards[0]).toHaveTextContent("Bebauungspläne und Flächen");
    await expect(cards[0]).toHaveTextContent("2 members");
    await expect(cards[0]).toHaveTextContent("Owner");
    await expect(cards[1]).toHaveTextContent("No description");
    await expect(cards[1]).toHaveTextContent("1 member");
    await expect(cards[1]).toHaveTextContent("Member");
    // The link is named by the spec's "Open team …"; what else it shows is its description.
    await expect(cards[0]).toHaveAccessibleDescription("Bebauungspläne und Flächen 2 members Owner");
    await expect(cards[1]).toHaveAccessibleDescription("No description 1 member Member");
  });

  it.each(["light", "dark"] as const)(
    "writes the owner badge in an ink that reads on the card (%s)",
    (mode) => {
      const theme = createAppTheme({ mode, locale: "en" });
      render(
        <ThemeProvider theme={theme}>
          <I18nextProvider i18n={commonI18n("en")}>
            <TeamsPage />
          </I18nextProvider>
        </ThemeProvider>
      );
      const ink = getComputedStyle(screen.getByText("Owner")).color;
      expect(getContrastRatio(ink, theme.palette.background.paper)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it("leaves out the count of a team the list gives none for, rather than saying 0 members", async () => {
    // An answer without the phase 2 fields (an older core).
    api.teams = [{ id: "t2", name: "Verkehr", description: "", role: "team-member", avatar: "" }];
    renderPage();
    const verkehr = screen.getByRole("link", { name: "Open team Verkehr" });
    await expect(verkehr).not.toHaveTextContent(/\d+ members?/);
    await expect(verkehr).toHaveAccessibleDescription("No description Member");
  });

  it("offers a retry of the teams read when it fails", async () => {
    api.teams = [];
    api.isError = new Error("HTTP 500");
    renderPage();
    expect(screen.getByText("That could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("You are not in a team yet")).toBeNull();
    expect(screen.queryByPlaceholderText("Search teams")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(api.mutate).toHaveBeenCalledTimes(1);
  });

  it("filters to the teams the caller owns and searches names and descriptions", async () => {
    renderPage();
    await userEvent.click(
      within(screen.getByRole("group", { name: "Filter teams" })).getByRole("button", { name: "I am owner" })
    );
    expect(screen.getAllByRole("link", { name: /^Open team / })).toHaveLength(1);
    await userEvent.click(
      within(screen.getByRole("group", { name: "Filter teams" })).getByRole("button", { name: "All" })
    );
    await userEvent.type(screen.getByPlaceholderText("Search teams"), "flächen");
    expect(
      screen.getAllByRole("link", { name: /^Open team / }).map((c) => c.getAttribute("aria-label"))
    ).toEqual(["Open team Stadtplanung"]);
    await userEvent.type(screen.getByPlaceholderText("Search teams"), "zzz");
    expect(screen.getByText("No team matches “flächenzzz”")).toBeInTheDocument();
  });

  it("says when the caller owns no team", async () => {
    api.teams = [TEAMS[0]];
    renderPage();
    await userEvent.click(
      within(screen.getByRole("group", { name: "Filter teams" })).getByRole("button", { name: "I am owner" })
    );
    expect(screen.getByText("You own no team")).toBeInTheDocument();
  });

  it("invites an editor without teams to create one", () => {
    api.teams = [];
    renderPage();
    expect(screen.getByText("You are not in a team yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New team" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByPlaceholderText("Search teams")).toBeNull();
  });

  it("tells a viewer why they cannot create a team", async () => {
    api.teams = [];
    api.roles = ["organization-viewer"];
    renderPage();
    await expect(screen.getByRole("note")).toHaveTextContent(
      "As a viewer you can be a member of teams but not create any."
    );
    expect(
      screen.getByText("A team owner can add you. Then the team appears here and under Content.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New team" })).toBeNull();
  });

  it("asks for nothing until the caller's role is known, and shows skeletons meanwhile", () => {
    api.roles = undefined;
    renderPage();
    expect(api.teamsCalls[0]).toEqual({ scope: undefined, enabled: false });
    expect(api.teamsCalls.every((call) => (call as { enabled: boolean }).enabled === false)).toBe(true);
    expect(document.querySelectorAll(".MuiSkeleton-root").length).toBeGreaterThan(0);
    expect(screen.queryByText("You are not in a team yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "New team" })).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    // Nor a subtitle that the admin's would replace: a placeholder holds its line.
    expect(screen.queryByText(/^Teams you are a member of\./)).toBeNull();
    expect(screen.queryByText(/^All teams of the organization\./)).toBeNull();
    const header = screen.getByRole("heading", { name: "Teams" }).parentElement!.parentElement!;
    expect(header.querySelector(".MuiSkeleton-root")).not.toBeNull();
  });

  it("says at the top of the page that the profile could not be read, and retries it", async () => {
    api.roles = undefined;
    api.profileError = new Error("HTTP 500");
    renderPage();
    expect(screen.queryByRole("button", { name: "New team" })).toBeNull();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("That could not be loaded.");
    // Which list to read waits for the role: no teams and no empty state guessed meanwhile.
    expect(screen.queryByRole("link", { name: /^Open team / })).toBeNull();
    expect(screen.queryByText("You are not in a team yet")).toBeNull();
    expect(screen.queryByText(/^Teams you are a member of\./)).toBeNull();
    expect(document.querySelectorAll(".MuiSkeleton-root")).toHaveLength(0);
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(api.mutateProfile).toHaveBeenCalledTimes(1);
  });

  it("draws card skeletons while the teams load", () => {
    api.teams = [];
    api.isLoading = true;
    renderPage();
    expect(document.querySelectorAll(".MuiSkeleton-root").length).toBeGreaterThan(0);
    expect(screen.queryByText("You are not in a team yet")).toBeNull();
  });

  it("counts the name as it is saved, without the spaces around it", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "New team" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^Team name/), "  Umwelt  ");
    expect(within(dialog).getByText("6/50")).toBeInTheDocument();
  });

  it("creates a team, refusing a name the caller sees already, and opens it", async () => {
    api.createTeam.mockResolvedValue({ id: "t9", name: "Umwelt" });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "New team" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText(/^Team name/);
    await userEvent.type(name, "stadtplanung");
    expect(within(dialog).getByText("A team with this name already exists.")).toBeInTheDocument();
    await expect(within(dialog).getByRole("button", { name: "Create team" })).toBeDisabled();
    await userEvent.clear(name);
    await userEvent.type(name, "Umwelt{Enter}");
    expect(api.createTeam).toHaveBeenCalledTimes(1);
    expect(api.createTeam).toHaveBeenCalledWith({ name: "Umwelt", description: undefined });
    expect(toast.success).toHaveBeenCalledWith("Team “Umwelt” created.");
    expect(api.push).toHaveBeenCalledWith("/settings/teams/t9");
  });

  it("asks owners and admins for every team of the organization and says so", async () => {
    api.roles = ["organization-admin"];
    api.teams = [UMWELT, ...TEAMS];
    renderPage();
    expect(api.teamsCalls.at(-1)).toEqual({ scope: "organization", enabled: true });
    expect(screen.getByText(/^All teams of the organization\./)).toBeInTheDocument();
    const umwelt = screen.getByRole("link", { name: "Open team Umwelt" });
    expect(within(umwelt).getByText("No owner")).toBeInTheDocument();
    expect(within(umwelt).queryByText("Owner")).toBeNull();
    expect(within(umwelt).queryByText("Member")).toBeNull();
    await expect(umwelt).toHaveTextContent("1 member");
    await expect(umwelt).toHaveAccessibleDescription("No description 1 member No owner");
    expect(
      within(screen.getByRole("link", { name: "Open team Stadtplanung" })).queryByText("No owner")
    ).toBeNull();
  });

  it("keeps everyone else on their own teams, without the ownerless badge", () => {
    api.teams = [UMWELT];
    renderPage();
    expect(api.teamsCalls.at(-1)).toEqual({ scope: "mine", enabled: true });
    expect(screen.getByText(/^Teams you are a member of\./)).toBeInTheDocument();
    expect(screen.queryByText("No owner")).toBeNull();
  });

  it("shows a name core refuses as taken as the name's error and keeps the dialog open", async () => {
    api.createTeam.mockRejectedValue(
      new ApiError(409, "A team with this name already exists in the organization")
    );
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "New team" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^Team name/), "Umwelt{Enter}");
    expect(await within(dialog).findByText("A team with this name already exists.")).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(api.push).not.toHaveBeenCalled();
  });

  it("gives a team the admin is not in, but which has an owner, no badge", async () => {
    api.roles = ["organization-owner"];
    api.teams = [{ ...UMWELT, members_preview: [face("u5", "Eva", "team-owner")] }];
    renderPage();
    const umwelt = screen.getByRole("link", { name: "Open team Umwelt" });
    for (const badge of ["No owner", "Owner", "Member"]) expect(within(umwelt).queryByText(badge)).toBeNull();
    await expect(umwelt).toHaveAccessibleDescription("No description 1 member");
  });

  it("names both badges of an ownerless team the admin is in, one after the other", async () => {
    api.roles = ["organization-admin"];
    api.teams = [{ ...UMWELT, role: "team-member" }];
    renderPage();
    const umwelt = screen.getByRole("link", { name: "Open team Umwelt" });
    expect(within(umwelt).getByText("No owner")).toBeInTheDocument();
    expect(within(umwelt).getByText("Member")).toBeInTheDocument();
    await expect(umwelt).toHaveAccessibleDescription("No description 1 member No owner Member");
  });

  it("tells an admin of an organization without teams so, and offers to create one", () => {
    api.roles = ["organization-admin"];
    api.teams = [];
    renderPage();
    expect(screen.getByText("This organization has no teams yet")).toBeInTheDocument();
    expect(screen.queryByText("You are not in a team yet")).toBeNull();
    // The editor's line says to have a team owner add you: not for an admin.
    expect(screen.queryByText(/Create one or have a team owner add you/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "New team" }).length).toBeGreaterThanOrEqual(1);
  });

  it("gives no hint and no create action to a profile without an organization role", () => {
    api.roles = [];
    api.teams = [];
    renderPage();
    expect(api.teamsCalls.at(-1)).toEqual({ scope: "mine", enabled: true });
    expect(screen.getByText("You are not in a team yet")).toBeInTheDocument();
    expect(screen.queryByText(/Create one or have a team owner add you/)).toBeNull();
    expect(
      screen.queryByText("A team owner can add you. Then the team appears here and under Content.")
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "New team" })).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("names the team space's area in the German admin subtitle as the other team texts do", () => {
    api.roles = ["organization-owner"];
    renderPage("de");
    expect(screen.getByText(/^Alle Teams der Organisation\./)).toHaveTextContent(
      "unter „Inhalt“ einen eigenen Bereich"
    );
  });
});
