"use client";

import { useMediaQuery, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import {
  type BreakdownRow,
  type CreditBalance,
  PAGE_SIZE,
  downloadUsageCsv,
  useCreditBreakdown,
} from "@/lib/api/usage";
import { formatCredits, roundCredits, toolTitle } from "@/lib/utils/credits";
import { rangeWindow } from "@/lib/utils/usageRange";

import { useProcessList } from "@/hooks/map/useOgcProcesses";
import { useLocalList } from "@/hooks/settings/useLocalList";

import EmptyState from "@/components/dashboard/common/EmptyState";
import MarkBlock from "@/components/dashboard/common/MarkBlock";
import SearchInput from "@/components/dashboard/common/SearchInput";
import UserAvatar from "@/components/dashboard/common/UserAvatar";
import { UsageChart, byMonth } from "@/components/settings/usage/UsageChart";
import {
  DetailFrame,
  DetailList,
  LoadError,
  TextCell,
  figureColumn,
  personColumn,
  sinceColumn,
} from "@/components/settings/usage/UsageDetailFrame";
import {
  GroupToggle,
  PLAIN,
  PeriodDownload,
  ShareCell,
  type SortState,
  SplitCard,
  amountRest,
  filterChips,
  memberNameOf,
  periodLabel,
  rangePhrase,
  roleWord,
  useMemberDirectory,
  useUsageDetailState,
} from "@/components/settings/usage/UsageDetailParts";
import { type UsageColumn, UsageMark, UsageTitleCell } from "@/components/settings/usage/UsageList";
import { DateRangePill, ExportPill, MemberPill } from "@/components/settings/usage/UsageToolbar";

type Group = "workflow" | "tool" | "layer" | "member" | "period";

/** The order a grouping opens in, and the direction a column sorts in first:
 * names from A, figures from the largest. */
const DEFAULT_SORT: Record<Group, SortState> = {
  workflow: { key: "credits", dir: "desc" },
  layer: { key: "credits", dir: "desc" },
  tool: { key: "credits", dir: "desc" },
  member: { key: "credits", dir: "desc" },
  period: { key: "key", dir: "desc" },
};
const TEXT_KEYS = new Set(["name", "title"]);

/** A tool, a member or a period as the browser's lists sort and search them. */
interface ToolRow {
  key: string;
  title: string;
  runs: number;
  credits: number;
}
interface MemberRow {
  key: string | null;
  name: string;
  role: string | null;
  compute: number;
  traffic: number;
  credits: number;
}

const sum = (rows: BreakdownRow[] | undefined, field: "credits" | "compute" | "traffic") =>
  (rows ?? []).reduce((total, row) => total + (row[field] ?? 0), 0);
const toolTitleOf = (row: ToolRow) => row.title;
const memberNameOfRow = (row: MemberRow) => row.name;
const rowKey = (row: { key: string | null }) => row.key ?? "public";

/**
 * The credits (compute and traffic) of the range chosen: the amount and what
 * counts, compute and traffic apart, the usage per day, and the ledger
 * grouped by workflow, tool, layer, member or period. Workflows and layers
 * are paged on the server; the other groupings are small and paged here.
 */
export const CreditsDetail = ({ balance }: { balance: CreditBalance }) => {
  const { t, i18n } = useTranslation("common");
  const language = i18n.language;
  const theme = useTheme();
  // A phone gives the search a row of its own above the pills.
  const isPhone = useMediaQuery(theme.breakpoints.down("sm"));
  const dateLocale = useDateFnsLocale();
  const state = useUsageDetailState<Group>({
    group: "workflow",
    memberGroup: "member",
    afterMember: "workflow",
  });
  const { range, group, member, q, page } = state;
  const sort = state.sort ?? DEFAULT_SORT[group];
  const bounds = rangeWindow(range, balance);
  const span = { since: bounds.since, until: bounds.until };
  const memberParam = member ?? undefined;
  const directory = useMemberDirectory();
  const { processes } = useProcessList();

  const chart = useCreditBreakdown("day", { ...span, member: memberParam });
  // Everyone's credits in the range: the member pill's options and the Members grouping.
  const members = useCreditBreakdown("member", span);
  const paged = group === "workflow" || group === "layer";
  const pagedList = useCreditBreakdown(
    group === "layer" ? "layer" : "workflow",
    {
      ...span,
      member: memberParam,
      q: q || undefined,
      sort: sort.key,
      dir: sort.dir,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    },
    paged
  );
  const tools = useCreditBreakdown("tool", { ...span, member: memberParam }, group === "tool");
  // Whole periods, whatever the range: a window would cut a period's sums
  // while its row keeps its bounds and its download.
  const periods = useCreditBreakdown("period", { member: memberParam }, group === "period");

  const chartRows =
    chart.breakdown && (bounds.perMonth ? byMonth(chart.breakdown.rows) : chart.breakdown.rows);
  const credits = (value: number | null | undefined) => formatCredits(value, language);
  const creditsText = (value: number) =>
    t("usage_credits_count", { count: roundCredits(value), credits: credits(value) });
  // While a member is chosen the detail says so, named or not: the filter
  // is in force before (or without) the name.
  const memberName = member
    ? memberNameOf(member, { rows: members.breakdown?.rows, isLoading: members.isLoading }, directory, t)
    : null;
  const pickMember = (id: string | null) => state.setMember(id);
  const showOnly = (name: string) => t("usage_show_only", { name, ...PLAIN });

  // Local lists: tools without the assistant's AI credits, members with
  // credits (and the traffic of public pages), periods with entries.
  const toolRows: ToolRow[] | undefined = tools.breakdown?.rows
    .filter((row) => row.category !== "ai")
    .map((row) => ({
      key: row.key ?? "",
      title: toolTitle(row.key, processes, t),
      runs: row.count,
      credits: row.credits,
    }));
  const memberRows: MemberRow[] | undefined = members.breakdown?.rows
    .filter((row) => row.credits > 0)
    .map((row) => ({
      key: row.key,
      name: row.key ? (row.name ?? directory.people.get(row.key)?.name ?? t("unknown")) : t("public_traffic"),
      role: row.key ? (directory.people.get(row.key)?.role ?? null) : null,
      compute: row.compute ?? 0,
      traffic: row.traffic ?? 0,
      credits: row.credits,
    }));
  const periodRows = periods.breakdown?.rows.filter((row) => row.count > 0);
  // Only the grouping shown is sorted; the browser's lists follow every key.
  const local = { query: state.query, sort, page };
  const toolList = useLocalList(group === "tool" ? toolRows : undefined, { ...local, search: toolTitleOf });
  const memberList = useLocalList(group === "member" ? memberRows : undefined, {
    ...local,
    search: memberNameOfRow,
  });
  const periodList = useLocalList(group === "period" ? periodRows : undefined, local);
  const toolTotal = (toolRows ?? []).reduce((total, row) => total + row.credits, 0);

  const usedInPeriod = member === null && range.preset === "period";
  const amount = usedInPeriod ? balance.used_credits : sum(chartRows, "credits");
  // Nothing used yet this period: the chart and the list make way for a
  // word on where credits come from; the toolbar stays for another range.
  const emptyPeriod =
    usedInPeriod && balance.used_credits === 0 && !!chartRows && !chartRows.some((row) => row.credits > 0);
  // This period's axis runs to its reset (a trial's to its end); the days
  // after today stay empty.
  const periodEnd =
    range.preset === "period"
      ? balance.on_trial
        ? balance.plan_renewal_date
        : balance.credits_reset_at
      : null;

  const creditsColumn = <T extends { credits: number }>(): UsageColumn<T> =>
    figureColumn<T>({
      key: "credits",
      label: t("credits"),
      main: true,
      value: (row) => credits(row.credits),
    });
  const workflowColumns: UsageColumn<BreakdownRow>[] = [
    {
      key: "name",
      label: t("workflow"),
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (row) => (
        <UsageTitleCell
          title={row.name ?? t("usage_deleted_workflow")}
          sub={t("usage_runs", { count: row.runs ?? 0, runs: (row.runs ?? 0).toLocaleString(language) })}
          mark={<UsageMark icon={ICON_NAME.WORKFLOW} tone="info" />}
        />
      ),
    },
    {
      key: "project",
      label: t("project"),
      width: "160px",
      // The project of a deleted workflow is unknown: it may live on.
      render: (row) =>
        row.name === null || row.name === undefined ? null : (
          <TextCell>{row.project_name ?? t("usage_deleted_project")}</TextCell>
        ),
    },
    sinceColumn({
      key: "last_run",
      label: t("usage_col_last_run"),
      date: (row) => row.last_run,
      locale: dateLocale,
    }),
    creditsColumn(),
  ];
  const toolColumns: UsageColumn<ToolRow>[] = [
    {
      key: "title",
      label: t("usage_col_tool"),
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (row) => (
        <UsageTitleCell
          title={row.title}
          sub={t("usage_runs", { count: row.runs, runs: row.runs.toLocaleString(language) })}
          mark={<UsageMark icon={ICON_NAME.TOOLBOX} tone="neutral" />}
        />
      ),
    },
    {
      key: "share",
      label: t("usage_col_share"),
      width: "150px",
      render: (row) => <ShareCell value={row.credits} total={toolTotal} />,
    },
    creditsColumn(),
  ];
  const layerColumns: UsageColumn<BreakdownRow>[] = [
    {
      key: "name",
      label: t("layer"),
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (row) => (
        <UsageTitleCell
          title={row.name ?? t("usage_deleted_layer")}
          sub={t("usage_requests", {
            count: row.requests ?? 0,
            requests: (row.requests ?? 0).toLocaleString(language),
          })}
          mark={<MarkBlock kind="vector" />}
        />
      ),
    },
    personColumn({
      label: t("owner"),
      person: (row) => (row.owner_id && row.owner ? { id: row.owner_id, name: row.owner } : null),
      // Only a member of the organization has usage to narrow to.
      onPick: member ? undefined : (who) => pickMember(who.id),
      canPick: (id) => directory.people.has(id),
      hint: showOnly,
    }),
    figureColumn({
      key: "credits",
      label: t("usage_traffic_credits"),
      width: "120px",
      main: true,
      value: (row) => credits(row.credits),
    }),
  ];
  const memberColumns: UsageColumn<MemberRow>[] = [
    {
      key: "name",
      label: t("member"),
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (row) =>
        row.key ? (
          <UsageTitleCell
            title={row.name}
            sub={roleWord(row.role, t)}
            mark={<UserAvatar id={row.key} name={row.name} size={32} />}
            onClick={() => pickMember(row.key)}
            hint={showOnly(row.name)}
          />
        ) : (
          <UsageTitleCell
            title={row.name}
            sub={t("usage_public_pages_sub")}
            mark={<UsageMark icon={ICON_NAME.GLOBE} tone="neutral" />}
          />
        ),
    },
    figureColumn({ key: "compute", label: t("usage_col_compute"), value: (row) => credits(row.compute) }),
    figureColumn({ key: "traffic", label: t("traffic"), value: (row) => credits(row.traffic) }),
    creditsColumn(),
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
          sub={t("usage_entries", { count: row.count, entries: row.count.toLocaleString(language) })}
          mark={<UsageMark icon={ICON_NAME.CALENDAR} tone="neutral" />}
        />
      ),
    },
    creditsColumn(),
    {
      key: "download",
      label: "",
      width: "40px",
      align: "right",
      render: (row) => (
        <PeriodDownload
          label={t("usage_download_period", { period: periodLabel(row, t, language) })}
          onDownload={() =>
            downloadUsageCsv("credits", { since: row.key ?? undefined, until: row.until ?? undefined })
          }
        />
      ),
    },
  ];

  const groups: { key: Group; label: string }[] = [
    { key: "workflow", label: t("workflows") },
    { key: "tool", label: t("tools") },
    { key: "layer", label: t("layers") },
    ...(member ? [] : [{ key: "member" as const, label: t("members") }]),
    { key: "period", label: t("usage_group_periods") },
  ];
  const nouns: Record<Group, string> = {
    workflow: "usage_noun_workflows",
    tool: "usage_noun_tools",
    layer: "usage_noun_layers",
    member: "usage_noun_members",
    period: "usage_noun_periods",
  };
  const noun = (count: number) => t(nouns[group], { count });
  const searchPlaceholder: Partial<Record<Group, string>> = {
    workflow: t("usage_search_workflows"),
    tool: t("usage_search_tools"),
    layer: t("usage_search_layers"),
    member: t("usage_search_members"),
  };
  const memberOptions = (members.breakdown?.rows ?? [])
    .filter((row) => row.key && row.credits > 0)
    .map((row) => ({
      id: row.key as string,
      name: row.name ?? directory.people.get(row.key as string)?.name ?? t("unknown"),
      sub: creditsText(row.credits),
    }));
  const compute = sum(chartRows, "compute");
  const traffic = sum(chartRows, "traffic");
  const split = (key: "usage_split_compute" | "usage_split_traffic", value: number) =>
    t(key, { count: roundCredits(value), amount: credits(value) });

  const listProps = {
    label: `${t("credits")}: ${groups.find((option) => option.key === group)?.label ?? ""}`,
    noun,
    onPage: state.setPage,
    sort,
    onSort: (key: string) => state.sortBy(key, sort, TEXT_KEYS.has(key) ? "asc" : "desc"),
    chips: filterChips(t, {
      member,
      memberName,
      query: state.query,
      onClearMember: () => pickMember(null),
      onClearQuery: () => state.setQuery(""),
    }),
    onClearAll: state.clearAll,
    // What the rows shown were searched for.
    searched: paged ? q : state.query.trim(),
    emptyTitle: t("usage_empty_range", { noun: noun(0) }),
    emptyHint: t("usage_empty_range_hint"),
  };
  // A query that fails takes only its own place: the toolbar and Group by
  // stay, so another grouping or range is one click away.
  const listOf = (shown: Group) => {
    switch (shown) {
      case "workflow":
      case "layer":
        return (
          <DetailList
            {...listProps}
            failed={!!pagedList.isError}
            isLoading={pagedList.isLoading}
            columns={shown === "layer" ? layerColumns : workflowColumns}
            rows={pagedList.breakdown?.rows}
            rowKey={rowKey}
            total={pagedList.breakdown?.total ?? 0}
            page={page}
          />
        );
      case "tool":
        return (
          <DetailList
            {...listProps}
            failed={!!tools.isError}
            isLoading={tools.isLoading}
            columns={toolColumns}
            rows={toolList.pageRows}
            rowKey={rowKey}
            total={toolList.total}
            page={toolList.page}
          />
        );
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
              title: t("credits"),
              amount: credits(amount),
              amountRest: amountRest({
                unit: "credits",
                amount: roundCredits(amount),
                limit: balance.total_credits,
                range,
                balance,
                member,
                memberName,
                limitText: credits(balance.total_credits),
                t,
                language,
              }),
              amountTone: balance.over_budget && usedInPeriod ? "error" : undefined,
              explain: t("usage_credits_explain"),
              limitLine:
                balance.total_credits !== null && !member
                  ? t(balance.on_trial ? "usage_credits_limit_trial" : "usage_credits_limit")
                  : undefined,
            }
          : undefined
      }
      headerFailed={!!chart.isError}
      above={
        chartRows &&
        !emptyPeriod && (
          <SplitCard
            parts={[
              {
                key: "compute",
                label: split("usage_split_compute", compute),
                value: compute,
                color: theme.palette.primary.main,
              },
              {
                key: "traffic",
                label: split("usage_split_traffic", traffic),
                value: traffic,
                color: theme.palette.info.main,
              },
            ]}
          />
        )
      }
      toolbar={
        <>
          {searchPlaceholder[group] && (
            <SearchInput
              size="toolbar"
              fullWidth={isPhone}
              value={state.query}
              onChange={state.setQuery}
              placeholder={searchPlaceholder[group] as string}
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
            onChange={pickMember}
            valueLabel={memberName ?? ""}
          />
          <ExportPill onExport={() => downloadUsageCsv("credits", { ...span, member: memberParam })} />
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
              icon={ICON_NAME.WORKFLOW}
              title={t("usage_credits_empty")}
              hint={t("usage_credits_empty_hint")}
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
              kind="credits"
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
