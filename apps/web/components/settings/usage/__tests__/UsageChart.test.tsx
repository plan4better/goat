import { ThemeProvider } from "@mui/material/styles";
import { render, screen } from "@testing-library/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import type { BreakdownRow } from "@/lib/api/usage";
import { rangeWindow } from "@/lib/utils/usageRange";

import {
  type ChartBar,
  ChartCursor,
  ChartTip,
  MAX_BAR_SIZE,
  UsageChart,
  byMonth,
  chartBars,
} from "@/components/settings/usage/UsageChart";

// jsdom lays nothing out, so the responsive container would draw nothing:
// the chart gets a fixed size instead.
vi.mock("recharts", async (importOriginal) => {
  const recharts = await importOriginal<typeof import("recharts")>();
  const { cloneElement } = await import("react");
  return {
    ...recharts,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 600, height: 110 }),
  };
});

const theme = createAppTheme({ mode: "light", locale: "en" });

const day = (key: string, values: Partial<BreakdownRow> = {}): BreakdownRow => ({
  key,
  credits: 0,
  units: 0,
  count: 0,
  compute: 0,
  traffic: 0,
  ai_answers: 0,
  ai_credits: 0,
  ...values,
});

const NOW = new Date("2026-11-21T12:00:00Z");
// This period: from 31 Oct, reset on 1 Dec at midnight.
const PERIOD = { since: "2026-10-31T00:00:00.000Z", perMonth: false };

beforeAll(() => {
  // jsdom measures nothing; the container only needs to exist.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const renderChart = (props: Partial<ComponentProps<typeof UsageChart>> = {}) =>
  render(
    <ThemeProvider theme={theme}>
      <I18nextProvider i18n={commonI18n("en")}>
        <UsageChart
          rows={[]}
          kind="credits"
          perMonth={false}
          window={PERIOD}
          isLoading={false}
          phrase="this period"
          {...props}
        />
      </I18nextProvider>
    </ThemeProvider>
  );

describe("chartBars", () => {
  it("keeps the whole period on the axis, with bars only up to today", () => {
    // A period that started 3 days ago and resets in a month.
    const bars = chartBars([day("2026-11-19", { compute: 2, traffic: 1, credits: 3 })], {
      perMonth: false,
      window: { since: "2026-11-18T12:00:00.000Z", perMonth: false },
      periodEnd: "2026-12-18T12:00:00",
      now: NOW,
    });
    expect([bars[0].key, bars.at(-1)?.key]).toEqual(["2026-11-18", "2026-12-18"]);
    expect(bars.filter((bar) => !bar.future).map((bar) => bar.key)).toEqual([
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
    ]);
    expect(bars[1]).toEqual({ key: "2026-11-19", compute: 2, traffic: 1, ai: 0, future: false });
    // A day after today keeps its place but has no bar.
    expect(bars[4]).toEqual({ key: "2026-11-22", compute: null, traffic: null, ai: null, future: true });
  });

  it("fills the past days without usage with zero", () => {
    const rows = [
      day("2026-11-03", { compute: 10, traffic: 3, credits: 13 }),
      day("2026-11-20", { compute: 5, traffic: 2, credits: 7 }),
    ];
    const bars = chartBars(rows, {
      perMonth: false,
      window: PERIOD,
      periodEnd: "2026-12-01T00:00:00",
      now: NOW,
    });
    expect(bars).toHaveLength(31);
    expect(bars[0]).toEqual({ key: "2026-10-31", compute: 0, traffic: 0, ai: 0, future: false });
    expect(bars[3]).toMatchObject({ key: "2026-11-03", compute: 10, traffic: 3 });
    expect(bars.filter((bar) => !bar.future).at(-1)?.key).toBe("2026-11-21");
    expect(bars[30]).toMatchObject({ key: "2026-11-30", compute: null, future: true });
  });

  it("keeps a reset during the day as the period's last day", () => {
    const bars = chartBars([], {
      perMonth: false,
      window: { since: "2026-10-30T14:30:00.000Z", perMonth: false },
      periodEnd: "2026-11-30T14:30:00",
      now: NOW,
    });
    expect([bars[0].key, bars.at(-1)?.key]).toEqual(["2026-10-30", "2026-11-30"]);
  });

  it("ends a closed range on the day before its end, and an open one today", () => {
    const week = chartBars([], {
      perMonth: false,
      window: { since: "2026-11-15T00:00:00.000Z", until: "2026-11-22T00:00:00.000Z", perMonth: false },
      now: NOW,
    });
    expect(week.map((bar) => bar.key)).toEqual([
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
    ]);
    expect(week.every((bar) => !bar.future)).toBe(true);
    const open = chartBars([], { perMonth: false, window: PERIOD, now: NOW });
    expect(open.at(-1)?.key).toBe("2026-11-21");
  });

  it("counts the AI credits of each day", () => {
    const bars = chartBars([day("2026-11-21", { ai_credits: 4, ai_answers: 3 })], {
      perMonth: false,
      window: { since: "2026-11-21T00:00:00.000Z", until: "2026-11-22T00:00:00.000Z", perMonth: false },
      now: NOW,
    });
    expect(bars).toEqual([{ key: "2026-11-21", compute: 0, traffic: 0, ai: 4, future: false }]);
  });

  it("draws a custom range of years per month, not per day", () => {
    const window = rangeWindow(
      { preset: "custom", from: "2023-11-01", to: "2026-11-01" },
      { period_start: "2026-10-31T00:00:00", credits_reset_at: null, on_trial: false },
      NOW
    );
    const bars = chartBars(byMonth([day("2025-06-14", { compute: 3, traffic: 1, credits: 4 })]), {
      perMonth: window.perMonth,
      window,
      now: NOW,
    });
    // November 2023 up to and with November 2026.
    expect(bars).toHaveLength(37);
    expect([bars[0].key, bars.at(-1)?.key]).toEqual(["2023-11", "2026-11"]);
    expect(bars.find((bar) => bar.key === "2025-06")).toMatchObject({ compute: 3, traffic: 1 });
  });

  it("sums the days per month for the last 12 months", () => {
    const months = byMonth([
      day("2026-10-02", { compute: 4, traffic: 1, credits: 5, count: 2, ai_credits: 1, ai_answers: 1 }),
      day("2026-10-20", { compute: 6, traffic: 0, credits: 6, count: 1 }),
      day("2026-11-01", { compute: 1, traffic: 1, credits: 2, count: 1 }),
    ]);
    expect(months).toEqual([
      expect.objectContaining({
        key: "2026-10",
        compute: 10,
        traffic: 1,
        credits: 11,
        count: 3,
        ai_credits: 1,
      }),
      expect.objectContaining({
        key: "2026-11",
        compute: 1,
        traffic: 1,
        credits: 2,
        count: 1,
        ai_credits: 0,
      }),
    ]);
    const bars = chartBars(months, {
      perMonth: true,
      window: { since: "2025-12-01T00:00:00.000Z", perMonth: true },
      now: NOW,
    });
    // Up to this month, none after it.
    expect(bars).toHaveLength(12);
    expect(bars.every((bar) => !bar.future)).toBe(true);
    expect(bars[0].key).toBe("2025-12");
    expect(bars.at(-1)).toMatchObject({ key: "2026-11", compute: 1, traffic: 1 });
  });
});

describe("UsageChart", () => {
  it("names the chart with its total", () => {
    renderChart({
      rows: [
        day("2026-11-03", { compute: 10, traffic: 3, credits: 13 }),
        day("2026-11-20", { compute: 5, traffic: 2, credits: 7 }),
      ],
      periodEnd: "2026-12-01T00:00:00",
    });
    expect(screen.getByText("Credits per day")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Credits per day, this period: 20 credits" })).toBeInTheDocument();
    // Compute and traffic have a legend; the axis spans the whole period.
    expect(screen.getByText("Compute")).toBeInTheDocument();
    expect(screen.getByText("Traffic")).toBeInTheDocument();
    expect(screen.getByText("31 Oct")).toBeInTheDocument();
    expect(screen.getByText("30 Nov")).toBeInTheDocument();
  });

  it("names the AI credits per month without a legend", () => {
    renderChart({
      kind: "ai",
      perMonth: true,
      window: { since: "2025-12-01T00:00:00.000Z", perMonth: true },
      rows: [day("2026-11", { ai_credits: 12, ai_answers: 9 })],
      phrase: "in the last 12 months",
    });
    expect(
      screen.getByRole("img", { name: "AI credits per month, in the last 12 months: 12 AI credits" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Compute")).not.toBeInTheDocument();
    expect(screen.getByText("Dec")).toBeInTheDocument();
  });

  it("keeps a bar of a short range narrow", () => {
    const { container } = renderChart({
      window: { since: "2026-11-20T00:00:00.000Z", until: "2026-11-22T00:00:00.000Z", perMonth: false },
      rows: [
        day("2026-11-20", { compute: 4, traffic: 1, credits: 5 }),
        day("2026-11-21", { compute: 2, traffic: 2, credits: 4 }),
      ],
      phrase: "in the last 2 days",
    });
    const widths = [...container.querySelectorAll(".recharts-bar-rectangle path")].map((path) =>
      Number(path.getAttribute("width"))
    );
    // Two days, compute and traffic each: four parts, none wider than the cap.
    expect(widths).toHaveLength(4);
    for (const width of widths) expect(width).toBeLessThanOrEqual(MAX_BAR_SIZE);
  });

  it("draws no bar after today", () => {
    const { container } = renderChart({
      rows: [day("2026-11-20", { compute: 5, traffic: 2, credits: 7 })],
      periodEnd: "2026-12-01T00:00:00",
    });
    // One day with usage: its compute and its traffic; the 9 days after today have none.
    expect(container.querySelectorAll(".recharts-bar-rectangle path")).toHaveLength(2);
  });

  it("shows no tooltip and no hover band over a day after today", () => {
    const past: ChartBar = { key: "2026-11-20", compute: 5, traffic: 2, ai: 0, future: false };
    const future: ChartBar = { key: "2026-11-25", compute: null, traffic: null, ai: null, future: true };
    const wrap = (node: ReactNode) =>
      render(
        <ThemeProvider theme={theme}>
          <I18nextProvider i18n={commonI18n("en")}>
            <svg>{node}</svg>
          </I18nextProvider>
        </ThemeProvider>
      );
    const payload = (bar: ChartBar) => [{ payload: bar }] as never;
    const shown = wrap(<ChartTip kind="credits" perMonth={false} active payload={payload(past)} />);
    expect(shown.container).toHaveTextContent("20 Nov 2026");
    expect(shown.container).toHaveTextContent("Compute 5 credits");
    shown.unmount();
    const hidden = wrap(<ChartTip kind="credits" perMonth={false} active payload={payload(future)} />);
    expect(hidden.container.textContent).toBe("");
    hidden.unmount();
    const bars = [past, future];
    const band = wrap(<ChartCursor bars={bars} payloadIndex={0} x={0} y={0} width={10} height={100} />);
    expect(band.container.querySelector("rect")).not.toBeNull();
    band.unmount();
    const none = wrap(<ChartCursor bars={bars} payloadIndex={1} x={0} y={0} width={10} height={100} />);
    expect(none.container.querySelector("rect")).toBeNull();
  });

  it("holds the chart's place while it loads", () => {
    const { container } = renderChart({ isLoading: true });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector(".MuiSkeleton-root")).not.toBeNull();
  });
});
