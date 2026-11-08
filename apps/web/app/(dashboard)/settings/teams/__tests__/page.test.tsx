import { getContrastRatio } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import TeamsPage from "@/app/(dashboard)/settings/teams/page";

const api = vi.hoisted(() => ({
  teams: [] as Record<string, unknown>[],
  isLoading: false,
  isError: undefined as unknown,
  roles: ["organization-editor"] as string[] | undefined,
  profileError: undefined as unknown,
  mutateProfile: vi.fn(),
  members: {} as Record<string, unknown[]>,
  memberErrors: {} as Record<string, unknown>,
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
vi.mock("@/lib/api/teams", () => ({
  useTeams: () => ({ teams: api.teams, isLoading: api.isLoading, isError: api.isError, mutate: api.mutate }),
  useTeamMembers: (teamId: string) => ({
    teamMembers: api.members[teamId] ?? [],
    isLoading: false,
    isError: api.memberErrors[teamId],
  }),
  createTeam: api.createTeam,
}));

const member = (id: string, firstname: string, role = "team-member") => ({
  id,
  firstname,
  lastname: "",
  email: `${id}@x.de`,
  role,
  avatar: "",
  invitation_status: "accepted",
});
const TEAMS = [
  { id: "t2", name: "Verkehr", description: "", role: "team-member", avatar: "" },
  {
    id: "t1",
    name: "Stadtplanung",
    description: "Bebauungspläne und Flächen",
    role: "team-owner",
    avatar: "",
  },
];

const renderPage = () =>
  render(
    <I18nextProvider i18n={commonI18n("en")}>
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
    api.members = {
      t1: [member("u1", "Anna", "team-owner"), member("u2", "Ben")],
      t2: [member("u3", "Carl")],
    };
    api.memberErrors = {};
    api.createTeam.mockReset();
    api.mutate.mockReset();
    api.push.mockReset();
    vi.mocked(toast.success).mockReset();
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

  it("leaves out the faces and the count of a team whose members do not load", async () => {
    api.members = { t1: [member("u1", "Anna", "team-owner")] };
    api.memberErrors = { t2: new Error("HTTP 500") };
    renderPage();
    const [stadtplanung, verkehr] = screen.getAllByRole("link", { name: /^Open team / });
    await expect(stadtplanung).toHaveTextContent("1 member");
    await expect(verkehr).not.toHaveTextContent(/\d+ members?/);
    await expect(verkehr).toHaveTextContent("Member");
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

  it("gives no hint and no create action without teams until the role is known", () => {
    api.teams = [];
    api.roles = undefined;
    renderPage();
    expect(screen.getByText("You are not in a team yet")).toBeInTheDocument();
    expect(
      screen.queryByText("A team owner can add you. Then the team appears here and under Content.")
    ).toBeNull();
    expect(screen.queryByText(/Create one or have a team owner add you/)).toBeNull();
    expect(screen.queryByRole("button", { name: "New team" })).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says at the top of the page that the profile could not be read, and retries it", async () => {
    api.roles = undefined;
    api.profileError = new Error("HTTP 500");
    renderPage();
    expect(screen.queryByRole("button", { name: "New team" })).toBeNull();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("That could not be loaded.");
    // Above the teams, which still show.
    expect(alert.compareDocumentPosition(screen.getByRole("link", { name: /Stadtplanung/ }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
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
});
