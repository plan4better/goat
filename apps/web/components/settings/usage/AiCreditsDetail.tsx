"use client";

import { useMediaQuery, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { type BreakdownRow, type CreditBalance, downloadUsageCsv, useCreditBreakdown } from "@/lib/api/usage";
import {
  aiCreditTiersText,
  aiCreditsText,
  formatCredits,
  formatCreditsDay,
  formatRate,
  roundCredits,
} from "@/lib/utils/credits";
import { rangeWindow } from "@/lib/utils/usageRange";

import { useLocalList } from "@/hooks/settings/useLocalList";

import EmptyState from "@/components/dashboard/common/EmptyState";
import SearchInput from "@/components/dashboard/common/SearchInput";
import UserAvatar from "@/components/dashboard/common/UserAvatar";
import { UsageChart, byMonth } from "@/components/settings/usage/UsageChart";
import {
  DetailFrame,
  DetailList,
  LoadError,
  figureColumn,
} from "@/components/settings/usage/UsageDetailFrame";
import {
  GroupToggle,
  PLAIN,
  PeriodDownload,
  ShareCell,
  type SortState,
  amountRest,
  filterChips,
  memberNameOf,
  periodLabel,
  rangePhrase,
  useMemberDirectory,
  useUsageDetailState,
} from "@/components/settings/usage/UsageDetailParts";
import { type UsageColumn, UsageMark, UsageTitleCell } from "@/components/settings/usage/UsageList";
import { DateRangePill, ExportPill, MemberPill } from "@/components/settings/usage/UsageToolbar";

type Group = "member" | "day" | "period";

const DEFAULT_SORT: Record<Group, SortState> = {
  member: { key: "ai_credits", dir: "desc" },
  day: { key: "key", dir: "desc" },
  period: { key: "key", dir: "desc" },
};

/** A member as the browser's list sorts and searches them. */
interface MemberRow {
  key: string;
  name: string;
  ai_answers: number;
  ai_credits: number;
}

const aiSum = (rows: BreakdownRow[] | undefined) =>
  (rows ?? []).reduce((total, row) => total + (row.ai_credits ?? 0), 0);
const answered = (row: BreakdownRow) => (row.ai_credits ?? 0) > 0 || (row.ai_answers ?? 0) > 0;
const memberNameOfRow = (row: MemberRow) => row.name;
const rowKey = (row: { key: string | null }) => row.key ?? "";

/**
 * The AI credits of the range chosen: the amount and how answers are counted,
 * the AI credits per day, and the answers grouped by member, by day (by
 * month for the last 12 months) or by period. All three lists are small and
 * paged here.
 */
export const AiCreditsDetail = ({ balance }: { balance: CreditBalance }) => {
  const { t, i18n } = useTranslation("common");
  const language = i18n.language;
  // A phone gives the search a row of its own above the pills.
  const isPhone = useMediaQuery(useTheme().breakpoints.down("sm"));
  const state = useUsageDetailState<Group>({ group: "member", memberGroup: "member", afterMember: "day" });
  const { range, group, member, page } = state;
  const searched = state.query.trim();
  const sort = state.sort ?? DEFAULT_SORT[group];
  const bounds = rangeWindow(range, balance);
  const span = { since: bounds.since, until: bounds.until };
  const memberParam = member ?? undefined;
  const directory = useMemberDirectory();

  const chart = useCreditBreakdown("day", { ...span, member: memberParam });
  // Everyone's AI credits in the range: the member pill's options and the Members grouping.
  const members = useCreditBreakdown("member", span);
  // Whole periods, whatever the range (see CreditsDetail).
  const periods = useCreditBreakdown("period", { member: memberParam }, group === "period");

  const chartRows =
    chart.breakdown && (bounds.perMonth ? byMonth(chart.breakdown.rows) : chart.breakdown.rows);
  const memberRows: MemberRow[] | undefined = members.breakdown?.rows
    .filter((row) => row.key && (row.ai_credits ?? 0) > 0)
    .map((row) => ({
      key: row.key as string,
      name: row.name ?? directory.people.get(row.key as string)?.name ?? t("unknown"),
      ai_answers: row.ai_answers ?? 0,
      ai_credits: row.ai_credits ?? 0,
    }));
  // Only the grouping shown is sorted; the browser's lists follow every key.
  const local = { query: state.query, sort, page };
  const memberList = useLocalList(group === "member" ? memberRows : undefined, {
    ...local,
    search: memberNameOfRow,
  });
  const dayList = useLocalList(group === "day" ? chartRows?.filter(answered) : undefined, local);
  const periodList = useLocalList(
    group === "period" ? periods.breakdown?.rows.filter(answered) : undefined,
    local
  );
  const memberTotal = (memberRows ?? []).reduce((total, row) => total + row.ai_credits, 0);

  const usedInPeriod = member === null && range.preset === "period";
  const total = balance.total_ai_credits;
  const amount = usedInPeriod ? balance.used_ai_credits : aiSum(chartRows);
  // Nothing used yet this period: the chart and the list make way for a
  // word on how AI credits are used; the toolbar stays for another range.
  const emptyPeriod =
    usedInPeriod &&
    balance.used_ai_credits === 0 &&
    !!chartRows &&
    !chartRows.some((row) => (row.ai_credits ?? 0) > 0);
  // While a member is chosen the detail says so, named or not (see CreditsDetail).
  const memberName = member
    ? memberNameOf(member, { rows: members.breakdown?.rows, isLoading: members.isLoading }, directory, t)
    : null;
  const credits = (value: number | null | undefined) => formatCredits(value, language);
  const answers = (count: number) =>
    t("usage_answers_count", { count, answers: count.toLocaleString(language) });

  const tiers = aiCreditTiersText(balance.ai_credit_tiers, t, language);
  const explain = [
    tiers && t("usage_ai_explain_rule", { tiers }),
    total === null
      ? t("usage_ai_explain_no_limit")
      : balance.on_trial
        ? t("usage_ai_explain_trial", { total: credits(total) })
        : balance.ai_credits_per_editor !== null &&
          t("usage_ai_explain_per_editor", {
            perEditor: formatRate(balance.ai_credits_per_editor, language),
          }),
    t("usage_ai_explain_own"),
  ]
    .filter(Boolean)
    .join(" ");

  const dayLabel = (key: string | null) =>
    bounds.perMonth
      ? new Intl.DateTimeFormat(language?.startsWith("de") ? "de-DE" : "en-GB", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${key}-01T00:00:00Z`))
      : (formatCreditsDay(key, language, { utc: true, year: true }) ?? "");

  const aiColumn = <T extends { ai_credits?: number }>(): UsageColumn<T> =>
    figureColumn<T>({
      key: "ai_credits",
      label: t("usage_ai_credits"),
      width: "110px",
      main: true,
      value: (row) => credits(row.ai_credits),
    });
  const memberColumns: UsageColumn<MemberRow>[] = [
    {
      key: "name",
      label: t("member"),
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (row) => (
        <UsageTitleCell
          title={row.name}
          sub={answers(row.ai_answers)}
          mark={<UserAvatar id={row.key} name={row.name} size={32} />}
          onClick={() => state.setMember(row.key)}
          hint={t("usage_show_only", { name: row.name, ...PLAIN })}
        />
      ),
    },
    {
      key: "share",
      label: t("usage_col_share"),
      width: "150px",
      render: (row) => <ShareCell value={row.ai_credits} total={memberTotal} />,
    },
    aiColumn(),
  ];
  const dayColumns: UsageColumn<BreakdownRow>[] = [
    {
      key: "key",
      label: t(bounds.perMonth ? "month" : "day"),
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (row) => (
        <UsageTitleCell
          title={dayLabel(row.key)}
          sub={answers(row.ai_answers ?? 0)}
          mark={<UsageMark icon={ICON_NAME.CALENDAR} tone="neutral" />}
        />
      ),
    },
    aiColumn(),
  ];
  const periodColumns: UsageColumn<BreakdownRow>[] = [
    {
      key: "key",
      label: t("usage_period"),
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (row) => (
        <UsageTitleCell
          title={periodLabel(row, t, language)}
          sub={answers(row.ai_answers ?? 0)}
          mark={<UsageMark icon={ICON_NAME.CALENDAR} tone="neutral" />}
        />
      ),
    },
    aiColumn(),
    {
      key: "download",
      label: "",
      width: "40px",
      align: "right",
      render: (row) => (
        <PeriodDownload
          label={t("usage_download_period", { period: periodLabel(row, t, language) })}
          onDownload={() =>
            downloadUsageCsv("ai", { since: row.key ?? undefined, until: row.until ?? undefined })
          }
        />
      ),
    },
  ];

  const groups: { key: Group; label: string }[] = [
    ...(member ? [] : [{ key: "member" as const, label: t("members") }]),
    { key: "day", label: t(bounds.perMonth ? "usage_group_months" : "usage_group_days") },
    { key: "period", label: t("usage_group_periods") },
  ];
  const nouns: Record<Group, string> = {
    member: "usage_noun_members",
    day: bounds.perMonth ? "usage_noun_months" : "usage_noun_days",
    period: "usage_noun_periods",
  };
  const noun = (count: number) => t(nouns[group], { count });
  const memberOptions = (members.breakdown?.rows ?? [])
    .filter((row) => row.key && (row.ai_credits ?? 0) > 0)
    .map((row) => ({
      id: row.key as string,
      name: row.name ?? directory.people.get(row.key as string)?.name ?? t("unknown"),
      sub: aiCreditsText(row.ai_credits, t, language),
    }));

  // This period's axis runs to its reset (a trial's to its end); the days
  // after today stay empty.
  const periodEnd =
    range.preset === "period"
      ? balance.on_trial
        ? balance.plan_renewal_date
        : balance.credits_reset_at
      : null;

  const listProps = {
    label: `${t("usage_ai_credits")}: ${groups.find((option) => option.key === group)?.label ?? ""}`,
    noun,
    onPage: state.setPage,
    sort,
    onSort: (key: string) => state.sortBy(key, sort, key === "name" ? "asc" : "desc"),
    chips: filterChips(t, {
      member,
      memberName,
      query: state.query,
      onClearMember: () => state.setMember(null),
      onClearQuery: () => state.setQuery(""),
    }),
    onClearAll: state.clearAll,
    searched,
    emptyTitle: t("usage_empty_range", { noun: noun(0) }),
    emptyHint: t("usage_empty_range_hint"),
  };
  // A query that fails takes only its own place (see CreditsDetail). The days
  // are the chart's rows: a failed chart already says so in its place.
  const listOf = (shown: Group) => {
    switch (shown) {
      case "member":
        return (
          <DetailList
            {...listProps}
            failed={!!members.isError}
            isLoading={members.isLoading}
            columns={memberColumns}
            rows={memberList.pageRows}
            rowKey={rowKey}
            total={memberList.total}
            page={memberList.page}
          />
        );
      case "day":
        return chart.isError ? null : (
          <DetailList
            {...listProps}
            isLoading={chart.isLoading}
            columns={dayColumns}
            rows={dayList.pageRows}
            rowKey={rowKey}
            total={dayList.total}
            page={dayList.page}
          />
        );
      case "period":
        return (
          <DetailList
            {...listProps}
            failed={!!periods.isError}
            isLoading={periods.isLoading}
            columns={periodColumns}
            rows={periodList.pageRows}
            rowKey={rowKey}
            total={periodList.total}
            page={periodList.page}
          />
        );
    }
  };
  const groupToggle = <GroupToggle value={group} options={groups} onChange={state.setGroup} />;

  return (
    <DetailFrame
      header={
        usedInPeriod || chartRows
          ? {
              title: t("usage_ai_credits"),
              amount: credits(amount),
              amountRest: amountRest({
                unit: "ai",
                amount: roundCredits(amount),
                limit: total,
                range,
                balance,
                member,
                memberName,
                limitText: credits(total),
                t,
                language,
              }),
              // A pool of nothing is not used up by using nothing.
              amountTone:
                usedInPeriod && total !== null && total > 0 && amount >= total ? "error" : undefined,
              explain,
              limitLine:
                total !== null && !member
                  ? t(balance.on_trial ? "usage_ai_limit_trial" : "usage_ai_limit")
                  : undefined,
            }
          : undefined
      }
      headerFailed={!!chart.isError}
      toolbar={
        <>
          {group === "member" && (
            <SearchInput
              size="toolbar"
              fullWidth={isPhone}
              value={state.query}
              onChange={state.setQuery}
              placeholder={t("usage_search_members")}
            />
          )}
          <DateRangePill
            value={range}
            onChange={state.setRange}
            onTrial={balance.on_trial}
            hasPeriod={balance.period_start !== null}
            periodStart={balance.period_start}
            disabled={group === "period"}
            disabledHint={t("usage_periods_whole")}
          />
          <MemberPill
            value={member}
            options={memberOptions}
            onChange={state.setMember}
            valueLabel={memberName ?? ""}
          />
          <ExportPill onExport={() => downloadUsageCsv("ai", { ...span, member: memberParam })} />
        </>
      }>
      {emptyPeriod ? (
        <>
          {groupToggle}
          {/* Whole periods do not follow the range: the earlier ones still list. */}
          {group === "period" ? (
            listOf(group)
          ) : (
            <EmptyState
              icon={ICON_NAME.SPARKLES}
              title={t("usage_ai_empty")}
              hint={t("usage_ai_empty_hint")}
            />
          )}
        </>
      ) : (
        <>
          {chart.isError ? (
            <LoadError />
          ) : (
            <UsageChart
              rows={chartRows}
              kind="ai"
              perMonth={bounds.perMonth}
              window={bounds}
              isLoading={chart.isLoading}
              periodEnd={periodEnd}
              phrase={rangePhrase(range, balance, t, language)}
            />
          )}
          {groupToggle}
          {listOf(group)}
        </>
      )}
    </DetailFrame>
  );
};
