import { ThemeProvider } from "@mui/material/styles";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import type { BreakdownRow, CreditBalance } from "@/lib/api/usage";
import { readableText } from "@/lib/utils/credits";

import { AiCreditsDetail } from "@/components/settings/usage/AiCreditsDetail";

const api = vi.hoisted(() => ({
  rows: {} as Record<string, BreakdownRow[]>,
  failing: null as string | null,
  breakdown: vi.fn(),
  download: vi.fn(),
}));

vi.mock("@/lib/api/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/usage")>()),
  useCreditBreakdown: (...args: unknown[]) => api.breakdown(...args),
  downloadUsageCsv: (...args: unknown[]) => api.download(...args),
}));
vi.mock("@/lib/api/users", () => ({ useOrganization: () => ({ organization: { id: "org1" } }) }));
vi.mock("@/lib/api/organizations", () => ({ useOrganizationMembers: () => ({ members: [] }) }));
vi.mock("@/components/support/SupportMenu", () => ({ useReportProblemHref: () => null }));

const theme = createAppTheme({ mode: "light", locale: "en" });

const TIERS = [
  { max_steps: 10, credits: 1 },
  { max_steps: 20, credits: 2 },
  { max_steps: null, credits: 3 },
];

const BALANCE: CreditBalance = {
  rates: [],
  used_credits: 2204,
  total_credits: 10000,
  over_budget: false,
  used_ai_credits: 412,
  total_ai_credits: 2000,
  ai_credits_per_editor: 200,
  ai_credit_tiers: TIERS,
  plan_renewal_date: null,
  on_trial: false,
  credits_reset_at: "2026-11-30T12:00:00",
  period_start: "2026-10-31T12:00:00",
  used_storage: 0,
  total_storage: null,
  used_projects: 0,
  total_projects: null,
  used_editors: 10,
  total_editors: 10,
  used_viewers: 0,
  total_viewers: 50,
};

const ANNA = "0b6f3c2e-1a4d-4e8b-9c7f-2d5e8a1b4c01";
const JONAS = "0b6f3c2e-1a4d-4e8b-9c7f-2d5e8a1b4c02";
const MAX = "0b6f3c2e-1a4d-4e8b-9c7f-2d5e8a1b4c03";

const row = (key: string | null, values: Partial<BreakdownRow> = {}): BreakdownRow => ({
  key,
  credits: 0,
  units: 0,
  count: 0,
  ...values,
});

const lastCall = (group: string) =>
  api.breakdown.mock.calls.filter(([g, , enabled]) => g === group && enabled !== false).at(-1)?.[1] as
    | Record<string, unknown>
    | undefined;

/** `null`: the balance has not answered yet. */
const renderDetail = (balance: CreditBalance | null = BALANCE, searchParams = "") => {
  const Nuqs = withNuqsTestingAdapter({ searchParams });
  return render(<AiCreditsDetail balance={balance ?? undefined} />, {
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
  api.rows = {
    day: [
      row("2026-11-03", { compute: 10, credits: 10, ai_credits: 6, ai_answers: 4 }),
      row("2026-11-05", { compute: 2, credits: 2 }),
      row("2026-11-20", { ai_credits: 2, ai_answers: 2 }),
    ],
    member: [
      row(ANNA, { name: "Anna Weber", credits: 590, ai_credits: 300, ai_answers: 121 }),
      row(JONAS, { name: "Jonas Keller", credits: 900, ai_credits: 100, ai_answers: 80 }),
      row(MAX, { name: "Max Krüger", credits: 18, ai_credits: 0, ai_answers: 0 }),
      row(null, { name: null, traffic: 71, credits: 71 }),
    ],
  };
  api.breakdown.mockReset();
  api.failing = null;
  api.breakdown.mockImplementation((group: string, _query: unknown, enabled = true) =>
    enabled === false
      ? { breakdown: undefined, isLoading: false, isError: undefined }
      : api.failing === group
        ? { breakdown: undefined, isLoading: false, isError: new Error("500") }
        : {
            breakdown: {
              group_by: group,
              since: null,
              until: null,
              total: (api.rows[group] ?? []).length,
              rows: api.rows[group] ?? [],
            },
            isLoading: false,
            isError: undefined,
          }
  );
  api.download.mockReset();
  api.download.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AiCreditsDetail", () => {
  it("lists members by AI credits with their share", () => {
    renderDetail();
    // This period: core counts from its start, so the requests name none.
    expect(lastCall("member")?.since).toBeUndefined();
    expect(lastCall("day")?.since).toBeUndefined();
    expect(screen.getByText("1–2 of 2 members")).toBeInTheDocument();
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Anna Weber");
    expect(rows[0]).toHaveTextContent("121 answers");
    expect(rows[0]).toHaveTextContent("75 %");
    expect(rows[0]).toHaveTextContent("300");
    expect(rows[1]).toHaveTextContent("Jonas Keller");
    expect(rows[1]).toHaveTextContent("25 %");
    // Who used no AI credits is not in the list.
    expect(screen.queryByText("Max Krüger")).not.toBeInTheDocument();
    expect(screen.getByText("412")).toBeInTheDocument();
    expect(screen.getByText("out of 2,000 this period. Resets on 30 Nov 2026.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Each answer of GOAT AI uses 1 AI credit up to 10 steps, 2 up to 20 steps, 3 above. Each editor seat adds 200 AI credits a month, shared by everyone in the organization. Answers from your own AI connection don't use any."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "When the AI credits are used up, GOAT AI answers again after the reset. An own AI connection keeps working.",
        { exact: false }
      )
    ).toBeInTheDocument();
  });

  it("asks for this period's breakdowns before the balance answers, and draws the frame meanwhile", async () => {
    renderDetail(null);
    expect(lastCall("day")).toBeDefined();
    expect(lastCall("day")?.since).toBeUndefined();
    expect(lastCall("member")).toBeDefined();
    expect(lastCall("member")?.since).toBeUndefined();
    // The members list is there; the figures wait for the balance.
    expect(screen.getByText("1–2 of 2 members")).toBeInTheDocument();
    expect(screen.queryByText("412")).toBeNull();
    expect(screen.queryByText(/out of/)).toBeNull();
    // The range pill names no range yet: a trial's period is the whole trial.
    expect(screen.queryByRole("button", { name: "This period" })).toBeNull();
    const pill = screen.getByRole("button", { name: "Period" });
    await expect(pill).toBeDisabled();
    // Nothing to describe: the pill waits for the period, it is not whole periods.
    expect(pill.getAttribute("aria-describedby")).toBeNull();
    // Without the period's start the export would hold the whole ledger.
    await expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });

  it("names the days by day while the balance loads, and lists them once it is there", () => {
    const view = renderDetail(null, `?member=${ANNA}`);
    expect(groupBy().getByRole("button", { name: "Days" }).getAttribute("aria-pressed")).toBe("true");
    expect(groupBy().queryByRole("button", { name: "Months" })).not.toBeInTheDocument();
    expect(screen.queryByText("November 2026")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    view.rerender(<AiCreditsDetail balance={BALANCE} />);
    expect(screen.getByText("1–2 of 2 days")).toBeInTheDocument();
    expect(screen.getByText("20 Nov 2026")).toBeInTheDocument();
  });

  it("holds an empty list of this period until the balance says whether the period is empty", () => {
    api.rows.day = [];
    api.rows.member = [];
    const view = renderDetail(null);
    expect(screen.queryByText("No members in this range")).toBeNull();
    view.rerender(<AiCreditsDetail balance={{ ...BALANCE, used_ai_credits: 0 }} />);
    expect(screen.getByText("No answers from GOAT AI in this period yet")).toBeInTheDocument();
  });

  it("searches the members as one types and names a search that finds none", async () => {
    renderDetail();
    await userEvent.type(screen.getByRole("textbox", { name: "Search members" }), "jon");
    expect(screen.getByText("1–1 of 1 member")).toBeInTheDocument();
    expect(screen.getByText("Search: jon")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Search members" }), "x");
    expect(screen.getByText("No members match “jonx”")).toBeInTheDocument();
  });

  it("shows days for a chosen member", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Anna Weber" }));
    expect(screen.getByText("Member: Anna Weber")).toBeInTheDocument();
    expect(groupBy().queryByRole("button", { name: "Members" })).not.toBeInTheDocument();
    expect(groupBy().getByRole("button", { name: "Days" }).getAttribute("aria-pressed")).toBe("true");
    expect(lastCall("day")).toEqual(expect.objectContaining({ member: ANNA }));
    // The days with AI credits, newest first.
    expect(screen.getByText("1–2 of 2 days")).toBeInTheDocument();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("20 Nov 2026");
    expect(rows[0]).toHaveTextContent("2 answers");
    expect(rows[1]).toHaveTextContent("3 Nov 2026");
    // The amount is the member's own: the sum of the days.
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("AI credits used by Anna Weber this period.")).toBeInTheDocument();
  });

  it("lists whole periods with their answers and downloads their AI answers", async () => {
    api.rows.period = [
      row("2026-10-31", { until: null, credits: 2204, ai_credits: 412, ai_answers: 289 }),
      row("2026-10-15", { until: "2026-10-31", credits: 8912, ai_credits: 0, ai_answers: 0 }),
    ];
    renderDetail();
    await userEvent.click(groupBy().getByRole("button", { name: "Periods" }));
    expect(lastCall("period")).toEqual({ member: undefined });
    expect(screen.getByText("31 Oct 2026 to now")).toBeInTheDocument();
    expect(screen.getByText("289 answers")).toBeInTheDocument();
    // A period without answers has nothing to list.
    expect(screen.queryByText("15 to 30 Oct 2026")).not.toBeInTheDocument();
    expect(screen.getByText("1–1 of 1 period")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download the entries of 31 Oct 2026 to now" }));
    expect(api.download).toHaveBeenCalledWith("ai", { since: "2026-10-31", until: undefined });
  });

  it("exports the AI answers of the range", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(api.download).toHaveBeenCalledWith("ai", {
      since: "2026-10-31T12:00:00.000Z",
      until: undefined,
      member: undefined,
    });
  });

  it("tells a trial its AI credits last the whole trial", () => {
    renderDetail({
      ...BALANCE,
      on_trial: true,
      total_ai_credits: 100,
      used_ai_credits: 34,
      ai_credits_per_editor: null,
      plan_renewal_date: "2026-11-14T12:00:00",
    });
    expect(screen.getByText("out of 100 for the whole trial.")).toBeInTheDocument();
    expect(
      screen.getByText("During the trial the organization has 100 AI credits in total.", { exact: false })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "When the AI credits are used up, GOAT AI stops answering until the organization has a plan. An own AI connection keeps working.",
        { exact: false }
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Whole trial" })).toBeInTheDocument();
  });

  it("says when an organization has no limit", () => {
    renderDetail({ ...BALANCE, total_ai_credits: null, ai_credits_per_editor: null });
    expect(screen.getByText("AI credits used this period. No limit.")).toBeInTheDocument();
    expect(screen.getByText("Your organization has no limit.", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/When the AI credits are used up/)).not.toBeInTheDocument();
  });

  it("goes back to Members in their own order when the member is cleared", async () => {
    renderDetail(BALANCE, `?member=${ANNA}`);
    expect(groupBy().getByRole("button", { name: "Days" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(screen.getByRole("columnheader", { name: /Day/ }).getAttribute("aria-sort")).toBe("ascending");
    await userEvent.click(screen.getByTitle("Remove the filter Member: Anna Weber"));
    expect(groupBy().getByRole("button", { name: "Members" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("columnheader", { name: /AI credits/ }).getAttribute("aria-sort")).toBe(
      "descending"
    );
  });

  it("lists months for the last 12 months", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Last 12 months/ }));
    expect(lastCall("day")).toEqual(expect.objectContaining({ since: "2025-12-01T00:00:00.000Z" }));
    await userEvent.click(groupBy().getByRole("button", { name: "Months" }));
    expect(screen.getByText("1–1 of 1 month")).toBeInTheDocument();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("November 2026");
    expect(rows[0]).toHaveTextContent("6 answers");
    expect(rows[0]).toHaveTextContent("8");
    expect(screen.getByRole("columnheader", { name: /Month/ })).toBeInTheDocument();
  });

  it("goes per month for a custom range of years: the chart and Group by together", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "This period" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2023-11-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(lastCall("day")).toEqual(
      expect.objectContaining({ since: "2023-11-01T00:00:00.000Z", until: "2026-11-02T00:00:00.000Z" })
    );
    expect(screen.getByText("AI credits per month")).toBeInTheDocument();
    expect(groupBy().queryByRole("button", { name: "Days" })).not.toBeInTheDocument();
    await userEvent.click(groupBy().getByRole("button", { name: "Months" }));
    expect(screen.getByRole("columnheader", { name: /Month/ })).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getAllByRole("row")[1]).toHaveTextContent("November 2026");
  });

  it("says so when the AI credits cannot be read, and keeps Group by", async () => {
    api.failing = "day";
    renderDetail();
    expect(screen.getByRole("alert")).toHaveTextContent("Usage could not be loaded. Please reload the page.");
    expect(screen.getByText("1–2 of 2 members")).toBeInTheDocument();
    await userEvent.click(groupBy().getByRole("button", { name: "Days" }));
    // The days list reads the chart's query: one failure, one alert.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText(/^No days/)).not.toBeInTheDocument();
  });

  it("does not paint an empty pool of nothing red", () => {
    api.rows.day = [];
    renderDetail({ ...BALANCE, used_ai_credits: 0, total_ai_credits: 0 });
    expect(screen.getByText("0")).not.toHaveStyle({ color: readableText(theme, theme.palette.error.main) });
  });

  it("tells an organization without answers how AI credits are used", () => {
    api.rows.day = [row("2026-11-05", { compute: 2, credits: 2 })];
    renderDetail({ ...BALANCE, used_ai_credits: 0 });
    expect(screen.getByText("No answers from GOAT AI in this period yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    // The way to another range or grouping stays.
    expect(screen.getByRole("button", { name: "This period" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Group by" })).toBeInTheDocument();
  });
});
