import { ThemeProvider } from "@mui/material/styles";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import type { BreakdownRow, CreditBalance } from "@/lib/api/usage";

import { CreditsDetail } from "@/components/settings/usage/CreditsDetail";

type Rows = BreakdownRow[] | ((query: Record<string, unknown>) => BreakdownRow[]);

const api = vi.hoisted(() => ({
  rows: {} as Record<string, Rows>,
  totals: {} as Record<string, number>,
  failing: null as string | null,
  loading: null as string | null,
  directoryLoading: false,
  organizationFailing: false,
  breakdown: vi.fn(),
  download: vi.fn(),
}));

vi.mock("@/lib/api/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/usage")>()),
  useCreditBreakdown: (...args: unknown[]) => api.breakdown(...args),
  downloadUsageCsv: (...args: unknown[]) => api.download(...args),
}));
vi.mock("@/hooks/map/useOgcProcesses", () => ({
  useProcessList: () => ({ processes: [{ id: "buffer", title: "Buffer" }] }),
}));
vi.mock("@/lib/api/users", () => ({
  useOrganization: () =>
    api.organizationFailing
      ? { organization: undefined, isLoading: false, isError: new Error("500") }
      : { organization: { id: "org1" }, isLoading: false, isError: undefined },
}));
vi.mock("@/lib/api/organizations", () => ({
  // Without an id there is no request, as SWR's null key.
  useOrganizationMembers: (organizationId: string) =>
    !organizationId
      ? { members: undefined, isLoading: false }
      : api.directoryLoading
        ? { members: undefined, isLoading: true }
        : {
            members: [
              {
                id: "0b6f3c2e-1a4d-4e8b-9c7f-2d5e8a1b4c01",
                firstname: "Anna",
                lastname: "Weber",
                roles: ["organization-admin"],
              },
              {
                id: "0b6f3c2e-1a4d-4e8b-9c7f-2d5e8a1b4c02",
                firstname: "Tim",
                lastname: "Braun",
                roles: ["organization-editor"],
              },
            ],
            isLoading: false,
          },
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
  total_storage: null,
  used_projects: 0,
  total_projects: null,
  used_editors: 2,
  total_editors: 10,
  used_viewers: 0,
  total_viewers: 50,
};

const SINCE_PERIOD = "2026-10-31T12:00:00.000Z";

// Member ids are UUIDs: the detail takes only those from the address.
const ANNA = "0b6f3c2e-1a4d-4e8b-9c7f-2d5e8a1b4c01";
const TIM = "0b6f3c2e-1a4d-4e8b-9c7f-2d5e8a1b4c02";

const row = (key: string | null, values: Partial<BreakdownRow> = {}): BreakdownRow => ({
  key,
  credits: 0,
  units: 0,
  count: 0,
  ...values,
});

/** The last request of a group, as the detail made it. */
const lastCall = (group: string) => {
  const calls = api.breakdown.mock.calls.filter(([g, , enabled]) => g === group && enabled !== false);
  return calls.at(-1)?.[1] as Record<string, unknown> | undefined;
};

const onUrlUpdate = vi.fn();

/** `null`: the balance has not answered yet. */
const renderDetail = (balance: CreditBalance | null = BALANCE, searchParams = "") => {
  const Nuqs = withNuqsTestingAdapter({ searchParams, onUrlUpdate });
  return render(<CreditsDetail balance={balance ?? undefined} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <Nuqs>
        <ThemeProvider theme={theme}>
          <I18nextProvider i18n={commonI18n("en")}>{children}</I18nextProvider>
        </ThemeProvider>
      </Nuqs>
    ),
  });
};

const groupBy = () => within(screen.getByRole("group", { name: "Group by" }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  // Only the clock: the search waits for its debounce on real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
  api.rows = {
    day: [
      row("2026-11-03", { compute: 10, traffic: 3, credits: 13 }),
      row("2026-11-20", { compute: 5, traffic: 2, credits: 7 }),
    ],
    workflow: Array.from({ length: 10 }, (_, i) =>
      row(`w${i}`, {
        name: `Workflow ${i}`,
        project_id: "p1",
        project_name: "Radnetz",
        runs: 3,
        credits: 100 - i,
        last_run: "2026-11-19T12:00:00",
      })
    ),
    member: [
      row(ANNA, { name: "Anna Weber", compute: 540, traffic: 50, credits: 590 }),
      row(TIM, { name: "Tim Braun", compute: 0, traffic: 0, credits: 0, ai_credits: 5 }),
      row(null, { name: null, compute: null, traffic: 71, credits: 71 }),
    ],
  };
  api.totals = { workflow: 48 };
  api.failing = null;
  api.loading = null;
  api.directoryLoading = false;
  api.organizationFailing = false;
  api.breakdown.mockReset();
  api.breakdown.mockImplementation((group: string, query: Record<string, unknown> = {}, enabled = true) => {
    if (enabled === false) return { breakdown: undefined, isLoading: false, isError: undefined };
    if (api.failing === group) return { breakdown: undefined, isLoading: false, isError: new Error("500") };
    if (api.loading === group) return { breakdown: undefined, isLoading: true, isError: undefined };
    const source = api.rows[group] ?? [];
    const rows = typeof source === "function" ? source(query) : source;
    return {
      breakdown: { group_by: group, since: null, until: null, total: api.totals[group] ?? rows.length, rows },
      isLoading: false,
      isError: undefined,
    };
  });
  api.download.mockReset();
  api.download.mockResolvedValue(undefined);
  onUrlUpdate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CreditsDetail", () => {
  it("asks for one page of workflows in the chosen range", () => {
    renderDetail();
    expect(lastCall("workflow")).toEqual(
      expect.objectContaining({ limit: 10, offset: 0, sort: "credits", dir: "desc" })
    );
    // This period: core counts from its start, so the request names none.
    expect(lastCall("workflow")?.since).toBeUndefined();
    // The chart reads the days of the same range.
    expect(lastCall("day")?.since).toBeUndefined();
    expect(screen.getByText("1–10 of 48 workflows")).toBeInTheDocument();
    expect(screen.getAllByText("Radnetz")).toHaveLength(10);
    expect(screen.getAllByText("3 runs")).toHaveLength(10);
  });

  it("asks for this period's breakdowns before the balance answers, and draws the frame meanwhile", async () => {
    const view = renderDetail(null);
    expect(lastCall("day")).toBeDefined();
    expect(lastCall("day")?.since).toBeUndefined();
    expect(lastCall("workflow")).toEqual(expect.objectContaining({ limit: 10, offset: 0 }));
    // The figures fill in with the balance: the amount, the split and the chart.
    expect(screen.queryByText("2,204")).toBeNull();
    expect(screen.queryByText(/^Compute \d/)).toBeNull();
    expect(screen.queryByRole("img", { name: /^Credits per day/ })).toBeNull();
    // The chart's heading names days, as a period with a start reads, not months first.
    expect(screen.getByText("Credits per day")).toBeInTheDocument();
    expect(screen.queryByText("Credits per month")).toBeNull();
    // The range pill names no range yet: a trial's period is the whole trial.
    expect(screen.queryByRole("button", { name: "This period" })).toBeNull();
    const pill = screen.getByRole("button", { name: "Period" });
    await expect(pill).toBeDisabled();
    // Nothing to describe: the pill waits for the period, it is not whole periods.
    expect(pill.getAttribute("aria-describedby")).toBeNull();
    // Without the period's start the export would hold the whole ledger.
    await expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    view.rerender(<CreditsDetail balance={BALANCE} />);
    expect(screen.getByText("2,204")).toBeInTheDocument();
    expect(screen.getByText("Compute 15 credits")).toBeInTheDocument();
    // The balance changes no request: what was asked for is what is shown.
    const queries = (group: string) =>
      new Set(
        api.breakdown.mock.calls.filter(([g]) => g === group).map(([, query]) => JSON.stringify(query))
      );
    expect(queries("day").size).toBe(1);
    expect(queries("workflow").size).toBe(1);
  });

  it("names a trial's range only once the balance says it is one", () => {
    const view = renderDetail(null);
    expect(screen.queryByRole("button", { name: "This period" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Whole trial" })).toBeNull();
    view.rerender(
      <CreditsDetail balance={{ ...BALANCE, on_trial: true, plan_renewal_date: "2026-11-14T12:00:00" }} />
    );
    expect(screen.getByRole("button", { name: "Whole trial" })).toBeInTheDocument();
  });

  it("holds an empty list of this period until the balance says whether the period is empty", () => {
    api.rows.day = [];
    api.rows.workflow = [];
    api.totals = {};
    const view = renderDetail(null);
    expect(screen.queryByText("No workflows in this range")).toBeNull();
    view.rerender(<CreditsDetail balance={{ ...BALANCE, used_credits: 0 }} />);
    expect(screen.getByText("No credits used in this period yet")).toBeInTheDocument();
    expect(screen.queryByText("No workflows in this range")).toBeNull();
  });

  it("starts again on page 1 when the range changes", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Go to page 3" }));
    expect(lastCall("workflow")).toEqual(expect.objectContaining({ offset: 20 }));
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Last 7 days/ }));
    expect(lastCall("workflow")).toEqual(
      expect.objectContaining({
        since: "2026-11-15T00:00:00.000Z",
        until: "2026-11-22T00:00:00.000Z",
        offset: 0,
      })
    );
  });

  it("starts again on page 1 when the search or the sort changes", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Go to page 2" }));
    expect(lastCall("workflow")).toEqual(expect.objectContaining({ offset: 10 }));
    await userEvent.click(screen.getByRole("button", { name: "Workflow" }));
    expect(lastCall("workflow")).toEqual(expect.objectContaining({ sort: "name", dir: "asc", offset: 0 }));
    await userEvent.click(screen.getByRole("button", { name: "Go to page 2" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Search workflows" }), "Rad");
    await waitFor(() =>
      expect(lastCall("workflow")).toEqual(expect.objectContaining({ q: "Rad", offset: 0 }))
    );
    expect(screen.getByText("Search: Rad")).toBeInTheDocument();
  });

  it("narrows to a member and hides Members in Group by", async () => {
    renderDetail();
    await userEvent.click(groupBy().getByRole("button", { name: "Members" }));
    // The public pages are a row of their own, not a member to narrow to.
    expect(screen.getByText("Public pages")).toBeInTheDocument();
    expect(screen.getByText("Traffic of shared links and embeds")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Public pages" })).not.toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Anna Weber" }));
    expect(screen.getByText("Member: Anna Weber")).toBeInTheDocument();
    expect(groupBy().queryByRole("button", { name: "Members" })).not.toBeInTheDocument();
    expect(groupBy().getByRole("button", { name: "Workflows" }).getAttribute("aria-pressed")).toBe("true");
    expect(lastCall("workflow")).toEqual(expect.objectContaining({ member: ANNA, offset: 0 }));
    expect(lastCall("day")).toEqual(expect.objectContaining({ member: ANNA }));
    expect(screen.getByText("credits used by Anna Weber this period.")).toBeInTheDocument();
    // The member is in the address, so Editors can open Credits for them.
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].searchParams.get("member")).toBe(ANNA);
  });

  it("opens on the member named in the address and clears it with the chip", async () => {
    renderDetail(BALANCE, `?member=${ANNA}`);
    expect(screen.getByText("Member: Anna Weber")).toBeInTheDocument();
    expect(lastCall("workflow")).toEqual(expect.objectContaining({ member: ANNA }));
    await userEvent.click(screen.getByTitle("Remove the filter Member: Anna Weber"));
    expect(screen.queryByText("Member: Anna Weber")).not.toBeInTheDocument();
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].searchParams.has("member")).toBe(false);
    expect(lastCall("workflow")?.member).toBeUndefined();
  });

  it("drops a member in the address that is no member id", async () => {
    renderDetail(BALANCE, "?member=anna");
    expect(screen.queryByText(/^Member:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All members" })).toBeInTheDocument();
    expect(lastCall("workflow")?.member).toBeUndefined();
    expect(lastCall("day")?.member).toBeUndefined();
    expect(api.breakdown.mock.calls.some(([, query]) => query?.member === "anna")).toBe(false);
    // It leaves the address too, once nuqs writes it.
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].searchParams.has("member")).toBe(false);
  });

  it("clears the member in the address with All members", async () => {
    renderDetail(BALANCE, `?member=${ANNA}`);
    await userEvent.click(screen.getByRole("button", { name: "Anna Weber" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "All members" }));
    expect(screen.queryByText("Member: Anna Weber")).not.toBeInTheDocument();
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].searchParams.has("member")).toBe(false);
  });

  it("names deleted workflows", () => {
    api.rows.workflow = [
      row("w1", { name: null, project_id: null, project_name: null, runs: 2, credits: 40 }),
    ];
    api.totals.workflow = 1;
    renderDetail();
    expect(screen.getByText("Deleted workflow")).toBeInTheDocument();
    expect(screen.getByText("2 runs")).toBeInTheDocument();
  });

  it("names deleted layers and lets the owner narrow the detail", async () => {
    api.rows.layer = [
      row("l1", { name: null, owner_id: null, owner: null, requests: 12, credits: 4 }),
      row("l2", { name: "Radwege", owner_id: TIM, owner: "Tim Braun", requests: 1, credits: 2 }),
      row("l3", { name: "Kitas", owner_id: "u7", owner: "Lea Alt", requests: 3, credits: 1 }),
    ];
    renderDetail();
    await userEvent.click(groupBy().getByRole("button", { name: "Layers" }));
    expect(screen.getByText("Deleted layer")).toBeInTheDocument();
    expect(screen.getByText("12 requests")).toBeInTheDocument();
    expect(screen.getByText("1 request")).toBeInTheDocument();
    // An owner who is no longer a member is a name, not a filter.
    expect(screen.getByText("Lea Alt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lea Alt" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Tim Braun" }));
    expect(screen.getByText("Member: Tim Braun")).toBeInTheDocument();
    expect(lastCall("layer")).toEqual(expect.objectContaining({ member: TIM, offset: 0 }));
  });

  it("pages tools in the browser", async () => {
    api.rows.tool = [
      ...Array.from({ length: 23 }, (_, i) =>
        row(`tool_${i}`, { category: "compute", credits: 50 - i, count: 2 })
      ),
      // The assistant's row counts AI credits, not credits.
      row("assistant", { category: "ai", credits: 400, count: 300 }),
    ];
    renderDetail();
    await userEvent.click(groupBy().getByRole("button", { name: "Tools" }));
    expect(screen.getByText("1–10 of 23 tools")).toBeInTheDocument();
    expect(screen.queryByText("assistant")).not.toBeInTheDocument();
    expect(lastCall("tool")?.since).toBeUndefined();
    expect(lastCall("tool")?.limit).toBeUndefined();
    await userEvent.click(screen.getByRole("button", { name: "Go to page 3" }));
    expect(screen.getByText("21–23 of 23 tools")).toBeInTheDocument();
    expect(screen.getAllByText("2 runs")).toHaveLength(3);
  });

  it("says out of the limit only for this period", async () => {
    renderDetail();
    expect(screen.getByText("2,204")).toBeInTheDocument();
    expect(screen.getByText("out of 10,000 this period. Resets on 30 Nov 2026.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Last 7 days/ }));
    // The amount of another range is the sum of its days.
    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("credits used in the last 7 days.")).toBeInTheDocument();
  });

  it("shows compute and traffic of the range apart", () => {
    renderDetail();
    expect(screen.getByText("Compute 15 credits")).toBeInTheDocument();
    expect(screen.getByText("Traffic 5 credits")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Compute 15 credits, Traffic 5 credits" })).toBeInTheDocument();
  });

  it("exports the range as CSV", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(api.download).toHaveBeenCalledWith("credits", {
      since: SINCE_PERIOD,
      until: undefined,
      member: undefined,
    });
  });

  it("lists whole periods, whatever the range, and downloads one", async () => {
    api.rows.period = [
      row("2026-11-15", { until: null, credits: 2204, count: 289 }),
      row("2026-10-15", { until: "2026-11-15", credits: 8912, count: 1018 }),
    ];
    renderDetail();
    await userEvent.click(groupBy().getByRole("button", { name: "Periods" }));
    expect(lastCall("period")).toEqual({ member: undefined });
    expect(screen.getByText("15 Nov 2026 to now")).toBeInTheDocument();
    expect(screen.getByText("15 Oct to 14 Nov 2026")).toBeInTheDocument();
    expect(screen.getByText("1,018 entries")).toBeInTheDocument();
    // The date pill does not narrow whole periods.
    const pill = screen.getByRole("button", { name: "This period" }) as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    // The reason reaches assistive tech too, not only a mouse's tooltip.
    const description = document.getElementById(pill.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Periods always show whole periods");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Download the entries of 15 Oct to 14 Nov 2026" })
    );
    expect(api.download).toHaveBeenCalledWith("credits", { since: "2026-10-15", until: "2026-11-15" });
  });

  it("shows the empty list, not an error, for a range with nothing in it", async () => {
    api.rows.day = [];
    api.rows.workflow = [];
    api.totals.workflow = 0;
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2020-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2020-01-31" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(lastCall("workflow")).toEqual(
      expect.objectContaining({
        since: "2020-01-01T00:00:00.000Z",
        until: "2020-02-01T00:00:00.000Z",
        offset: 0,
      })
    );
    expect(screen.getByText("No workflows in this range")).toBeInTheDocument();
    expect(screen.getByText("credits used from 1 to 31 Jan 2020.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("tells an organization without usage where credits come from, and keeps the way to another range", async () => {
    // Nothing in this period; the last one has workflows.
    const inThisPeriod = (query: Record<string, unknown>) => query.since === undefined;
    const days = api.rows.day as BreakdownRow[];
    const workflows = api.rows.workflow as BreakdownRow[];
    api.rows.day = (query) => (inThisPeriod(query) ? [] : days);
    api.rows.workflow = (query) => (inThisPeriod(query) ? [] : workflows);
    api.totals = {};
    renderDetail({ ...BALANCE, used_credits: 0 });
    expect(screen.getByText("No credits used in this period yet")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /^Credits per day/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Compute \d/)).not.toBeInTheDocument();
    // The header, the toolbar and Group by stay.
    expect(screen.getByText("out of 10,000 this period. Resets on 30 Nov 2026.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Group by" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Last period/ }));
    expect(screen.queryByText("No credits used in this period yet")).not.toBeInTheDocument();
    expect(screen.getByText("1–10 of 10 workflows")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Credits per day, in the last period/ })).toBeInTheDocument();
  });

  it("lists whole periods even when this one is empty", async () => {
    api.rows.day = [];
    api.rows.period = [row("2026-10-15", { until: "2026-11-15", credits: 8912, count: 1018 })];
    renderDetail({ ...BALANCE, used_credits: 0 });
    await userEvent.click(groupBy().getByRole("button", { name: "Periods" }));
    expect(screen.getByText("15 Oct to 14 Nov 2026")).toBeInTheDocument();
  });

  it("says so when the usage cannot be read, in place of what failed", async () => {
    api.failing = "workflow";
    renderDetail();
    expect(screen.getByRole("alert")).toHaveTextContent("Usage could not be loaded. Please reload the page.");
    // The chart and the way to another grouping stay.
    expect(screen.getByRole("img", { name: /^Credits per day/ })).toBeInTheDocument();
    await userEvent.click(groupBy().getByRole("button", { name: "Layers" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the other groupings when the members cannot be read", async () => {
    api.failing = "member";
    renderDetail();
    expect(screen.getByText("1–10 of 48 workflows")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(groupBy().getByRole("button", { name: "Members" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Group by" })).toBeInTheDocument();
  });

  it("puts the chart's failure in the chart's place", () => {
    api.failing = "day";
    renderDetail();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("1–10 of 48 workflows")).toBeInTheDocument();
  });

  it("keeps the member filter in sight when the member's name is unknown", () => {
    renderDetail(BALANCE, "?member=0b6f3c2e-1a4d-4e8b-9c7f-2d5e8a1b4c09");
    expect(screen.getByText("Member: Unknown")).toBeInTheDocument();
    expect(screen.getByText("credits used by Unknown this period.")).toBeInTheDocument();
    expect(screen.queryByText(/out of/)).not.toBeInTheDocument();
    expect(screen.queryByText(/When the credits are used up/)).not.toBeInTheDocument();
  });

  it("names a chosen member Unknown when the organization cannot be read", () => {
    api.organizationFailing = true;
    renderDetail(BALANCE, "?member=0b6f3c2e-1a4d-4e8b-9c7f-2d5e8a1b4c09");
    expect(screen.getByText("Member: Unknown")).toBeInTheDocument();
  });

  it("holds the member's place while the names load, and says Unknown only once they have", () => {
    api.loading = "member";
    api.directoryLoading = true;
    const view = renderDetail(BALANCE, `?member=${ANNA}`);
    // The filter is in force and in sight before its name.
    expect(lastCall("workflow")).toEqual(expect.objectContaining({ member: ANNA }));
    expect(screen.getByTitle("Remove the filter Member:")).toBeInTheDocument();
    expect(screen.queryByText(/Unknown/)).not.toBeInTheDocument();
    expect(screen.queryByText(/out of/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All members" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Member" })).toBeInTheDocument();
    api.loading = null;
    api.directoryLoading = false;
    view.rerender(<CreditsDetail balance={BALANCE} />);
    expect(screen.getByText("Member: Anna Weber")).toBeInTheDocument();
    expect(screen.getByText("credits used by Anna Weber this period.")).toBeInTheDocument();
  });

  it("starts again on page 1 when a member is chosen in the pill, and keeps the search", async () => {
    renderDetail();
    await userEvent.type(screen.getByRole("textbox", { name: "Search workflows" }), "Rad");
    await waitFor(() => expect(lastCall("workflow")).toEqual(expect.objectContaining({ q: "Rad" })));
    await userEvent.click(screen.getByRole("button", { name: "Go to page 2" }));
    expect(lastCall("workflow")).toEqual(expect.objectContaining({ offset: 10 }));
    await userEvent.click(screen.getByRole("button", { name: "All members" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Anna Weber/ }));
    expect(lastCall("workflow")).toEqual(expect.objectContaining({ member: ANNA, q: "Rad", offset: 0 }));
    expect(screen.getByText("Member: Anna Weber")).toBeInTheDocument();
    expect(screen.getByText("Search: Rad")).toBeInTheDocument();
  });

  it("starts again on page 1 when the grouping changes", async () => {
    api.rows.layer = Array.from({ length: 10 }, (_, i) => row(`l${i}`, { name: `Layer ${i}`, credits: 10 }));
    api.totals.layer = 30;
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Go to page 2" }));
    await userEvent.click(groupBy().getByRole("button", { name: "Layers" }));
    expect(lastCall("layer")).toEqual(expect.objectContaining({ offset: 0, sort: "credits", dir: "desc" }));
  });
});
