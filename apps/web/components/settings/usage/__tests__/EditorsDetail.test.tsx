import { ThemeProvider } from "@mui/material/styles";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import type { BreakdownRow, CreditBalance } from "@/lib/api/usage";
import { readableText } from "@/lib/utils/credits";

import { EditorsDetail } from "@/components/settings/usage/EditorsDetail";

const api = vi.hoisted(() => ({
  members: [] as Record<string, unknown>[] | undefined,
  membersQuery: vi.fn(),
  usage: [] as BreakdownRow[],
  breakdown: vi.fn(),
  failing: false,
  organizationFailing: false,
  organizationLoading: false,
}));

vi.mock("@/lib/api/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/usage")>()),
  useCreditBreakdown: (...args: unknown[]) => api.breakdown(...args),
}));
vi.mock("@/lib/api/users", () => ({
  useOrganization: () =>
    api.organizationFailing
      ? { organization: undefined, isLoading: false, isError: new Error("500") }
      : api.organizationLoading
        ? { organization: undefined, isLoading: true, isError: undefined }
        : { organization: { id: "org1" }, isLoading: false, isError: undefined },
}));
vi.mock("@/lib/api/organizations", () => ({
  useOrganizationMembers: (...args: unknown[]) => api.membersQuery(...args),
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

const member = (
  id: string,
  firstname: string,
  lastname: string,
  role: string,
  invitation_status = "accepted"
) => ({
  id,
  firstname,
  lastname,
  email: `${(firstname || "new").toLowerCase()}@example.org`,
  roles: [role],
  invitation_status,
  avatar: "",
});

const row = (key: string, values: Partial<BreakdownRow> = {}): BreakdownRow => ({
  key,
  credits: 0,
  units: 0,
  count: 0,
  ...values,
});

const onOpenUsage = vi.fn();

/** `null`: the balance has not answered yet. */
const renderDetail = (balance: CreditBalance | null = BALANCE, language: "en" | "de" = "en") =>
  render(<EditorsDetail balance={balance ?? undefined} onOpenUsage={onOpenUsage} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ThemeProvider theme={theme}>
        <I18nextProvider i18n={commonI18n(language)}>{children}</I18nextProvider>
      </ThemeProvider>
    ),
  });

/** The table's rows below its header. */
const tableRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
  api.members = [
    member("u1", "Anna", "Weber", "organization-admin"),
    member("u2", "Tim", "Braun", "organization-editor"),
    member("u3", "Lea", "Hoffmann", "organization-viewer"),
    member("u4", "Eva", "Lang", "organization-owner"),
    member("u5", "Paul", "Schmidt", "organization-viewer"),
    { ...member("inv1", "", "", "organization-editor", "pending"), email: "neu@example.org" },
  ];
  api.usage = [
    row("u1", { name: "Anna Weber", credits: 590, ai_credits: 168 }),
    row("u2", { name: "Tim Braun", credits: 120, ai_credits: 33 }),
    // AI credits only: answers from GOAT AI, no tools or traffic.
    row("u3", { name: "Lea Hoffmann", credits: 0, ai_credits: 12 }),
    // Someone who left still has usage: not a member to list.
    row("u9", { name: "Max Krüger", credits: 18 }),
    row("", { name: null, credits: 71 }),
  ];
  api.failing = false;
  api.organizationFailing = false;
  api.organizationLoading = false;
  api.membersQuery.mockReset();
  api.membersQuery.mockImplementation(() => ({ members: api.members, isLoading: false, isError: undefined }));
  api.breakdown.mockReset();
  api.breakdown.mockImplementation((group: string) =>
    api.failing
      ? { breakdown: undefined, isLoading: false, isError: new Error("500") }
      : {
          breakdown: { group_by: group, since: null, until: null, total: api.usage.length, rows: api.usage },
          isLoading: false,
          isError: undefined,
        }
  );
  onOpenUsage.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EditorsDetail", () => {
  it("joins members with their usage and filters by role", async () => {
    renderDetail();
    // Invitations count: they hold a seat.
    expect(api.membersQuery).toHaveBeenCalledWith("org1", { include_invitations: true });
    // This period's credits per member: core counts from its start, so the request names none.
    expect(api.breakdown).toHaveBeenCalledWith(
      "member",
      expect.not.objectContaining({ since: expect.anything() })
    );
    expect(screen.getByText("1–6 of 6 members")).toBeInTheDocument();
    const rows = tableRows();
    expect(rows[0]).toHaveTextContent("Anna Weber");
    expect(rows[0]).toHaveTextContent("Admin");
    expect(rows[0]).toHaveTextContent("590");
    expect(rows[0]).toHaveTextContent("168");
    expect(rows[1]).toHaveTextContent("Tim Braun");
    expect(screen.queryByText("Max Krüger")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All roles" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Editors" }));
    expect(screen.getByText("Role: Editors")).toBeInTheDocument();
    expect(screen.getByText("1–2 of 2 members")).toBeInTheDocument();
    expect(tableRows()[0]).toHaveTextContent("Tim Braun");
    expect(tableRows()[1]).toHaveTextContent("neu@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Editors" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Owners and admins" }));
    expect(screen.getByText("1–2 of 2 members")).toBeInTheDocument();
    expect(screen.getByText("Eva Lang")).toBeInTheDocument();
  });

  it("lists the seats before the balance answers, and fills the header in when it does", () => {
    const view = renderDetail(null);
    expect(api.breakdown).toHaveBeenCalledWith(
      "member",
      expect.not.objectContaining({ since: expect.anything() })
    );
    expect(screen.getByText("1–6 of 6 members")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "Editors and viewers" })).not.toBeInTheDocument();
    expect(screen.queryByText(/out of 10 editors/)).not.toBeInTheDocument();
    view.rerender(<EditorsDetail balance={BALANCE} onOpenUsage={onOpenUsage} />);
    expect(screen.getByRole("heading", { level: 3, name: "Editors and viewers" })).toBeInTheDocument();
    expect(screen.getByText("out of 10 editors, 2 out of 50 viewers.")).toBeInTheDocument();
  });

  it("asks for the members with the cookie's organization before the organization answers", () => {
    api.organizationLoading = true;
    document.cookie = "organization=org-cookie; path=/";
    try {
      renderDetail();
      expect(api.membersQuery).toHaveBeenCalledWith("org-cookie", { include_invitations: true });
    } finally {
      document.cookie = "organization=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    }
  });

  it("names a member whose names are only spaces by the address, as every settings list does", () => {
    api.members = [
      member("u1", "Anna", "Weber", "organization-admin"),
      { ...member("u6", " ", "  ", "organization-viewer"), email: "blank@example.org" },
    ];
    renderDetail();
    const blank = tableRows().find((tableRow) => tableRow.textContent?.includes("blank@example.org"));
    expect(blank).toBeDefined();
    expect(within(blank as HTMLElement).getByText("blank@example.org")).toBeInTheDocument();
  });

  it("marks open invitations", () => {
    renderDetail();
    const invited = tableRows().find((tableRow) => tableRow.textContent?.includes("neu@example.org"));
    expect(invited).toHaveTextContent("Editor, invited");
  });

  it("names each member's role in the words of the tile and the header", () => {
    renderDetail(BALANCE, "de");
    const rowOf = (name: string) =>
      tableRows().find((tableRow) => tableRow.textContent?.includes(name)) as HTMLElement;
    expect(screen.getByRole("heading", { level: 3, name: "Bearbeiter und Betrachter" })).toBeInTheDocument();
    expect(within(rowOf("Anna Weber")).getByText("Admin")).toBeInTheDocument();
    expect(within(rowOf("Tim Braun")).getByText("Bearbeiter")).toBeInTheDocument();
    expect(within(rowOf("Lea Hoffmann")).getByText("Betrachter")).toBeInTheDocument();
    expect(within(rowOf("Eva Lang")).getByText("Eigentümer")).toBeInTheDocument();
    expect(within(rowOf("neu@example.org")).getByText("Bearbeiter, eingeladen")).toBeInTheDocument();
  });

  it("opens Credits for a member with credits", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Tim Braun" }));
    expect(onOpenUsage).toHaveBeenCalledWith("credits", "u2");
  });

  it("opens AI credits for a member with AI credits only, and nothing for a member without usage", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Lea Hoffmann" }));
    expect(onOpenUsage).toHaveBeenCalledWith("ai", "u3");
    expect(screen.queryByRole("button", { name: "Paul Schmidt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "neu@example.org" })).not.toBeInTheDocument();
  });

  it("searches the members by name and email", async () => {
    renderDetail();
    await userEvent.type(screen.getByRole("textbox", { name: "Search members" }), "neu@");
    expect(screen.getByText("1–1 of 1 member")).toBeInTheDocument();
    expect(screen.getByText("Search: neu@")).toBeInTheDocument();
  });

  it("names the seats, what they allow and where to manage them", () => {
    renderDetail();
    expect(screen.getByRole("heading", { level: 3, name: "Editors and viewers" })).toBeInTheDocument();
    expect(screen.getByText("out of 10 editors, 2 out of 50 viewers.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Editors create and change projects, workflows, layouts and dashboards. Viewers open what is shared with them. Each editor seat adds 200 AI credits a month."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "At the limit, nobody new can be invited or get a seat of that kind. Open invitations hold a seat too.",
        { exact: false }
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage members" }).getAttribute("href")).toBe(
      "/settings/members"
    );
  });

  it("paints the amount red with more editors than seats", () => {
    renderDetail({ ...BALANCE, used_editors: 11 });
    expect(screen.getByText("11")).toHaveStyle({ color: readableText(theme, theme.palette.error.main) });
  });

  it("names seats without a limit", () => {
    renderDetail({ ...BALANCE, total_editors: null, total_viewers: null, ai_credits_per_editor: null });
    expect(screen.getByText("editors and 2 viewers. No limit.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Editors create and change projects, workflows, layouts and dashboards. Viewers open what is shared with them."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/At the limit/)).not.toBeInTheDocument();
  });

  it("says so when the organization cannot be read", () => {
    api.organizationFailing = true;
    api.membersQuery.mockImplementation(() => ({ members: undefined, isLoading: false, isError: undefined }));
    renderDetail();
    expect(screen.getByRole("alert")).toHaveTextContent("Usage could not be loaded. Please reload the page.");
  });

  it("says so when the members or their usage cannot be read", () => {
    api.failing = true;
    renderDetail();
    expect(screen.getByRole("alert")).toHaveTextContent("Usage could not be loaded. Please reload the page.");
    expect(screen.getByRole("link", { name: "Manage members" })).toBeInTheDocument();
  });
});
