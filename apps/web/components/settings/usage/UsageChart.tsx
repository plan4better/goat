"use client";

import { Box, Paper, Skeleton, Stack, Typography, alpha, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, ResponsiveContainer, Tooltip } from "recharts";
import type { TooltipProps } from "recharts";

import type { BreakdownRow } from "@/lib/api/usage";
import {
  aiCreditsText,
  formatCredits,
  formatCreditsDay,
  parseApiDate,
  roundCredits,
} from "@/lib/utils/credits";
import type { RangeWindow } from "@/lib/utils/usageRange";

import SurfaceCard from "@/components/dashboard/common/SurfaceCard";

/** One place on the axis: a day ("2026-11-03") or a month ("2026-11") of
 * the window. A day after today keeps its place with no values: no bar, no
 * tooltip. */
export interface ChartBar {
  key: string;
  compute: number | null;
  traffic: number | null;
  ai: number | null;
  future: boolean;
}

/** The widest a bar gets: a range of a few days draws narrow bars, not blocks. */
export const MAX_BAR_SIZE = 24;

const DAY_MS = 24 * 60 * 60 * 1000;

const utcMidnight = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

const monthKey = (date: Date): string => date.toISOString().slice(0, 7);

/** The last day an exclusive end leaves in the window: the day before a
 * midnight, else the day it falls on (a reset during the day). */
const lastDayBefore = (end: Date): Date => {
  const day = utcMidnight(end);
  return day.getTime() === end.getTime() ? new Date(day.getTime() - DAY_MS) : day;
};

/** The day rows of the ledger summed per month ("2026-11"): the month rows
 * of `/breakdown` carry no compute and traffic, the day rows do. */
export const byMonth = (rows: BreakdownRow[]): BreakdownRow[] => {
  const months = new Map<string, BreakdownRow>();
  for (const row of rows) {
    if (!row.key) continue;
    const key = row.key.slice(0, 7);
    const sum = months.get(key) ?? {
      key,
      credits: 0,
      units: 0,
      count: 0,
      compute: 0,
      traffic: 0,
      ai_answers: 0,
      ai_credits: 0,
    };
    sum.credits += row.credits;
    sum.units += row.units;
    sum.count += row.count;
    sum.compute = (sum.compute ?? 0) + (row.compute ?? 0);
    sum.traffic = (sum.traffic ?? 0) + (row.traffic ?? 0);
    sum.ai_answers = (sum.ai_answers ?? 0) + (row.ai_answers ?? 0);
    sum.ai_credits = (sum.ai_credits ?? 0) + (row.ai_credits ?? 0);
    months.set(key, sum);
  }
  return [...months.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
};

/**
 * Every day (or month) of the window as a place on the axis: from the
 * window's start to the day before its end, or, while it is open, to the end
 * of the period (`periodEnd`, the reset) or else today. Days up to today
 * without usage are zero; days after today carry no values. The days are UTC
 * days, as the ledger's keys are.
 */
export const chartBars = (
  rows: BreakdownRow[] | undefined,
  {
    perMonth,
    window,
    periodEnd,
    now = new Date(),
  }: { perMonth: boolean; window: RangeWindow; periodEnd?: string | null; now?: Date }
): ChartBar[] => {
  const byKey = new Map((rows ?? []).filter((row) => row.key).map((row) => [row.key as string, row]));
  const today = utcMidnight(now);
  const end = window.until ? new Date(window.until) : periodEnd ? parseApiDate(periodEnd) : null;
  const last = end && !Number.isNaN(end.getTime()) ? lastDayBefore(end) : today;
  // Without a start (no period known) the bars begin with the first usage.
  const firstKey = [...byKey.keys()].sort()[0];
  const start = window.since
    ? new Date(window.since)
    : firstKey
      ? new Date(`${perMonth ? `${firstKey.slice(0, 7)}-01` : firstKey}T00:00:00Z`)
      : today;
  const first = utcMidnight(start);

  const keys: string[] = [];
  if (perMonth) {
    const lastMonth = monthKey(last);
    for (
      let month = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
      monthKey(month) <= lastMonth;
      month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1))
    ) {
      keys.push(monthKey(month));
    }
  } else {
    for (let day = first; day <= last; day = new Date(day.getTime() + DAY_MS)) keys.push(dayKey(day));
  }

  const current = perMonth ? monthKey(today) : dayKey(today);
  return keys.map((key) => {
    if (key > current) return { key, compute: null, traffic: null, ai: null, future: true };
    const row = byKey.get(key);
    return {
      key,
      compute: row?.compute ?? 0,
      traffic: row?.traffic ?? 0,
      ai: row?.ai_credits ?? 0,
      future: false,
    };
  });
};

/** Four labels under a week or less, five under anything longer: the first
 * and the last bar always. */
const tickIndexes = (count: number): number[] => {
  if (count === 0) return [];
  const indexes =
    count <= 7
      ? [0, Math.floor(count / 3), Math.floor((2 * count) / 3), count - 1]
      : [0, Math.round(count / 4), Math.round(count / 2), Math.round((3 * count) / 4), count - 1];
  return [...new Set(indexes)];
};

const monthLabel = (key: string, language: string, year: boolean): string =>
  new Intl.DateTimeFormat(language?.startsWith("de") ? "de-DE" : "en-GB", {
    month: "short",
    ...(year ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(`${key}-01T00:00:00Z`));

/** A bar's day ("3 Nov") or month ("Nov"), with its year where asked. */
const barLabel = (key: string, perMonth: boolean, language: string, year: boolean): string =>
  perMonth ? monthLabel(key, language, year) : (formatCreditsDay(key, language, { utc: true, year }) ?? key);

/** The tooltip of a bar: its day and amounts. A day after today has none. */
export const ChartTip = ({
  active,
  payload,
  kind,
  perMonth,
}: TooltipProps<number, string> & { kind: "credits" | "ai"; perMonth: boolean }) => {
  const { t, i18n } = useTranslation("common");
  const language = i18n.language;
  const bar = active ? (payload?.[0]?.payload as ChartBar | undefined) : undefined;
  if (!bar || bar.future) return null;
  const credits = (key: "usage_split_compute" | "usage_split_traffic", value: number | null) =>
    t(key, { count: roundCredits(value), amount: formatCredits(value, language) });
  return (
    <Paper elevation={4} sx={{ px: 2.5, py: 1.5, fontSize: 12 }}>
      <Box sx={{ fontWeight: 700 }}>{barLabel(bar.key, perMonth, language, true)}</Box>
      {kind === "ai" ? (
        <Box>{aiCreditsText(bar.ai, t, language)}</Box>
      ) : (
        <>
          <Box>{credits("usage_split_compute", bar.compute)}</Box>
          <Box>{credits("usage_split_traffic", bar.traffic)}</Box>
        </>
      )}
    </Paper>
  );
};

/** The band under the pointer, recharts' cursor: none over a day after today. */
export const ChartCursor = ({
  bars,
  payloadIndex,
  x,
  y,
  width,
  height,
  fill,
}: {
  bars: ChartBar[];
  payloadIndex?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
}) =>
  payloadIndex === undefined || bars[payloadIndex]?.future ? null : (
    <rect x={x} y={y} width={width} height={height} fill={fill} pointerEvents="none" />
  );

/**
 * A detail's usage per day (per month for the last 12 months): credits as
 * compute (primary) under traffic (blue), AI credits as one series. The axis
 * spans the whole window, so a day keeps its place: a quiet day shows as a
 * zero, a day after today as an empty place without a tooltip. The image is
 * named by its total for assistive tech.
 */
export const UsageChart = ({
  rows,
  kind,
  perMonth,
  window,
  isLoading,
  phrase,
  periodEnd,
}: {
  /** The day rows of the window, or the months of {@link byMonth}. */
  rows: BreakdownRow[] | undefined;
  kind: "credits" | "ai";
  perMonth: boolean;
  window: RangeWindow;
  isLoading: boolean;
  /** What the window is ("this period"), for the image's name. */
  phrase: string;
  /** Where an open window's axis ends: the reset of this period. */
  periodEnd?: string | null;
}) => {
  const { t, i18n } = useTranslation("common");
  const language = i18n.language;
  const theme = useTheme();
  const compute = theme.palette.primary.main;
  const traffic = theme.palette.info.main;
  const bars = chartBars(rows, { perMonth, window, periodEnd });
  const title = t(
    kind === "ai"
      ? perMonth
        ? "usage_chart_ai_month"
        : "usage_chart_ai_day"
      : perMonth
        ? "usage_chart_credits_month"
        : "usage_chart_credits_day"
  );
  const total = (rows ?? []).reduce(
    (sum, row) => sum + (kind === "ai" ? (row.ai_credits ?? 0) : row.credits),
    0
  );
  const amount =
    kind === "ai"
      ? aiCreditsText(total, t, language)
      : t("usage_credits_count", { count: roundCredits(total), credits: formatCredits(total, language) });
  const ticks = tickIndexes(bars.length).map((index) => bars[index]);
  const legend =
    kind === "credits"
      ? [
          { label: t("usage_col_compute"), color: compute },
          { label: t("traffic"), color: traffic },
        ]
      : [];

  return (
    <SurfaceCard hoverable={false} sx={{ p: 4, display: "flex", flexDirection: "column", gap: 2.5 }}>
      <Stack direction="row" alignItems="center" useFlexGap flexWrap="wrap" gap={3.5}>
        <Typography component="h4" sx={{ flex: 1, fontSize: 13.5, fontWeight: 700 }}>
          {title}
        </Typography>
        {legend.map((item) => (
          <Stack
            key={item.label}
            direction="row"
            alignItems="center"
            gap={1.5}
            sx={{ fontSize: 12, color: "text.secondary" }}>
            <Box
              aria-hidden
              sx={{ width: 10, height: 10, borderRadius: "3px", backgroundColor: item.color }}
            />
            {item.label}
          </Stack>
        ))}
      </Stack>
      {isLoading ? (
        <Skeleton variant="rounded" height={110} sx={{ borderRadius: "8px" }} />
      ) : (
        <>
          <Box
            role="img"
            aria-label={t("usage_chart_label", { title, phrase, total: amount })}
            sx={{ height: 110, borderBottom: `1px solid ${theme.palette.divider}` }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={bars}
                margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
                barCategoryGap={bars.length > 40 ? 1 : bars.length <= 12 ? 5 : 2}>
                <Tooltip
                  content={<ChartTip kind={kind} perMonth={perMonth} />}
                  cursor={<ChartCursor bars={bars} fill={alpha(theme.palette.text.primary, 0.06)} />}
                  isAnimationActive={false}
                />
                {kind === "ai"
                  ? [
                      <Bar
                        key="ai"
                        dataKey="ai"
                        fill={compute}
                        radius={[3, 3, 0, 0]}
                        maxBarSize={MAX_BAR_SIZE}
                        isAnimationActive={false}
                      />,
                    ]
                  : [
                      <Bar
                        key="compute"
                        dataKey="compute"
                        stackId="credits"
                        fill={compute}
                        maxBarSize={MAX_BAR_SIZE}
                        isAnimationActive={false}
                      />,
                      <Bar
                        key="traffic"
                        dataKey="traffic"
                        stackId="credits"
                        fill={traffic}
                        radius={[3, 3, 0, 0]}
                        maxBarSize={MAX_BAR_SIZE}
                        isAnimationActive={false}
                      />,
                    ]}
              </BarChart>
            </ResponsiveContainer>
          </Box>
          <Box
            aria-hidden
            sx={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11.5,
              color: "text.secondary",
            }}>
            {ticks.map((bar) => (
              <span key={bar.key}>{barLabel(bar.key, perMonth, language, false)}</span>
            ))}
          </Box>
        </>
      )}
    </SurfaceCard>
  );
};
