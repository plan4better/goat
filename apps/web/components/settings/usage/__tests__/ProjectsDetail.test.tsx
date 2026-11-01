import { ThemeProvider } from "@mui/material/styles";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import type { CreditBalance, OrgProject } from "@/lib/api/usage";
import { readableText } from "@/lib/utils/credits";

import { ProjectsDetail } from "@/components/settings/usage/ProjectsDetail";

const api = vi.hoisted(() => ({
  rows: [] as OrgProject[],
  total: 0,
  trash: 0,
  failing: false,
  projects: vi.fn(),
}));

vi.mock("@/lib/api/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/usage")>()),
  useOrgProjects: (...args: unknown[]) => api.projects(...args),
}));
vi.mock("@/lib/api/users", () => ({ useOrganization: () => ({ organization: { id: "org1" } }) }));
vi.mock("@/lib/api/organizations", () => ({
  useOrganizationMembers: () => ({
    members: [
      { id: "u1", firstname: "Anna", lastname: "Weber", email: "anna@example.org", roles: [] },
      { id: "u2", firstname: "Tim", lastname: "Braun", email: "tim@example.org", roles: [] },
    ],
  }),
}));
vi.mock("@/components/support/SupportMenu", () => ({ useReportProblemHref: () => null }));

const theme = createAppTheme({ mode: "light", locale: "en" });

const BALANCE: CreditBalance = {
  rates: [],
  used_credits: 2204,
  total_credits: 10000,
  over_budget: false,
  used_ai_credits: 412,
  total_ai_credits: 2000,
  ai_credits_per_editor: 200,
  ai_credit_tiers: [],
  plan_renewal_date: null,
  on_trial: false,
  credits_reset_at: "2026-11-30T12:00:00",
  period_start: "2026-10-31T12:00:00",
  used_storage: 0,
  total_storage: 51200,
  used_projects: 661,
  total_projects: 1000,
  used_editors: 3,
  total_editors: 10,
  used_viewers: 2,
  total_viewers: 50,
};

const project = (i: number, values: Partial<OrgProject> = {}): OrgProject => ({
  project_id: `p${i}`,
  name: `Project ${i}`,
  owner_id: "u1",
  owner: "Anna Weber",
  layers: 3,
  updated_at: "2026-11-20T12:00:00+00:00",
  ...values,
});

const lastCall = () => api.projects.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;

const renderDetail = (balance: CreditBalance = BALANCE, language: "en" | "de" = "en") =>
  render(<ProjectsDetail balance={balance} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ThemeProvider theme={theme}>
        <I18nextProvider i18n={commonI18n(language)}>{children}</I18nextProvider>
      </ThemeProvider>
    ),
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
  api.rows = [
    project(1, { name: "Radnetz Konzept", layers: 12, owner: "Tim Braun", owner_id: "u2" }),
    project(2, { name: "Schulwege", layers: 1, updated_at: "2026-11-14T12:00:00+00:00" }),
  ];
  api.total = 527;
  api.trash = 134;
  api.failing = false;
  api.projects.mockReset();
  api.projects.mockImplementation(() =>
    api.failing
      ? { projects: undefined, isLoading: false, isError: new Error("500") }
      : {
          projects: { rows: api.rows, total: api.total, trash: { count: api.trash } },
          isLoading: false,
          isError: undefined,
        }
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectsDetail", () => {
  it("lists projects newest first and links them", () => {
    renderDetail();
    expect(lastCall()).toEqual({ sort: "updated", dir: "desc", limit: 10, offset: 0 });
    expect(screen.getByText("1–10 of 527 projects")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Radnetz Konzept" }).getAttribute("href")).toBe("/map/p1");
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("12 layers");
    expect(rows[0]).toHaveTextContent("1 day ago");
    expect(rows[1]).toHaveTextContent("1 layer");
    expect(rows[1]).toHaveTextContent("7 days ago");
    expect(screen.getByRole("columnheader", { name: /Updated/ }).getAttribute("aria-sort")).toBe(
      "descending"
    );
  });

  it("says how many projects the plan allows", () => {
    renderDetail();
    expect(screen.getByText("661")).toBeInTheDocument();
    expect(screen.getByText("out of 1,000. Fixed by your plan.")).toBeInTheDocument();
    expect(
      screen.getByText("Every project of the organization counts, private or shared.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("At the limit, no new projects can be created.", { exact: false })
    ).toBeInTheDocument();
  });

  it("says how many of the projects are in the trash, and that they count", () => {
    const { unmount } = renderDetail();
    expect(
      screen.getByText(
        "527 projects in the list, 134 in the trash. Projects in the trash count until they are removed for good, 30 days after deletion."
      )
    ).toBeInTheDocument();
    unmount();
    renderDetail({ ...BALANCE, used_projects: 135 }, "de");
    expect(
      screen.getByText(
        "1 Projekt in der Liste, 134 im Papierkorb. Projekte im Papierkorb zählen, bis sie endgültig entfernt sind, 30 Tage nach dem Löschen."
      )
    ).toBeInTheDocument();
  });

  it("leaves the trash unnamed while it is empty", () => {
    api.trash = 0;
    renderDetail();
    expect(screen.queryByText(/in the trash/)).not.toBeInTheDocument();
  });

  it("reads a response without the trash, as a core that predates it sends", () => {
    api.projects.mockImplementation(() => ({
      projects: { rows: api.rows, total: api.total },
      isLoading: false,
      isError: undefined,
    }));
    renderDetail();
    expect(screen.getByText("1–10 of 527 projects")).toBeInTheDocument();
    expect(screen.queryByText(/in the trash/)).not.toBeInTheDocument();
  });

  it("names a removed owner without offering them as a filter", () => {
    api.rows = [project(1, { name: "Altlast", owner: null, owner_id: null })];
    renderDetail();
    const row = within(screen.getByRole("table")).getAllByRole("row")[1];
    expect(row).toHaveTextContent("Owner removed");
    expect(within(row).queryByRole("button", { name: "Owner removed" })).not.toBeInTheDocument();
  });

  it("names a trial's limit and an organization without one", () => {
    const { unmount } = renderDetail({ ...BALANCE, on_trial: true, used_projects: 8, total_projects: 10 });
    expect(screen.getByText("out of 10. Trial limit.")).toBeInTheDocument();
    unmount();
    renderDetail({ ...BALANCE, total_projects: null });
    expect(screen.getByText("projects. No limit.")).toBeInTheDocument();
    expect(screen.queryByText(/At the limit/)).not.toBeInTheDocument();
  });

  it("paints the amount red over the limit", () => {
    const { unmount } = renderDetail({ ...BALANCE, used_projects: 1001 });
    expect(screen.getByText("1,001")).toHaveStyle({ color: readableText(theme, theme.palette.error.main) });
    unmount();
    renderDetail();
    expect(screen.getByText("661")).not.toHaveStyle({ color: readableText(theme, theme.palette.error.main) });
  });

  it("searches on the server", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Go to page 3" }));
    expect(lastCall()).toEqual(expect.objectContaining({ offset: 20 }));
    await userEvent.type(screen.getByRole("textbox", { name: "Search projects" }), "Rad");
    await waitFor(() => expect(lastCall()).toEqual(expect.objectContaining({ q: "Rad", offset: 0 })));
    expect(screen.getByText("Search: Rad")).toBeInTheDocument();
  });

  it("filters by owner from a row and from the pill", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Tim Braun" }));
    expect(screen.getByText("Owner: Tim Braun")).toBeInTheDocument();
    expect(lastCall()).toEqual(expect.objectContaining({ owner: "u2", offset: 0 }));
    await userEvent.click(screen.getAllByRole("button", { name: "Tim Braun" })[0]);
    await userEvent.click(screen.getByRole("menuitem", { name: "All owners" }));
    expect(lastCall()?.owner).toBeUndefined();
  });

  it("sorts by name from A", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: /^Project/ }));
    expect(lastCall()).toEqual(expect.objectContaining({ sort: "name", dir: "asc", offset: 0 }));
  });

  it("says so when the projects cannot be read", () => {
    api.failing = true;
    renderDetail();
    expect(screen.getByRole("alert")).toHaveTextContent("Usage could not be loaded. Please reload the page.");
  });

  it("names a search that finds nothing", async () => {
    api.rows = [];
    api.total = 0;
    renderDetail();
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Search projects" }), "xyz");
    await waitFor(() => expect(screen.getByText("No projects match “xyz”")).toBeInTheDocument());
  });
});
