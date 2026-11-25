"use client";

import { useMediaQuery, useTheme } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useDateFnsLocale } from "@/i18n/utils";

import { type CreditBalance, type OrgProject, PAGE_SIZE, useOrgProjects } from "@/lib/api/usage";

import MarkBlock from "@/components/dashboard/common/MarkBlock";
import SearchInput from "@/components/dashboard/common/SearchInput";
import {
  DetailFrame,
  DetailList,
  figureColumn,
  personColumn,
  sinceColumn,
} from "@/components/settings/usage/UsageDetailFrame";
import {
  PLAIN,
  type SortState,
  searchChips,
  useListControls,
  useMemberDirectory,
} from "@/components/settings/usage/UsageDetailParts";
import { type UsageColumn, UsageTitleCell } from "@/components/settings/usage/UsageList";
import { MemberPill } from "@/components/settings/usage/UsageToolbar";

/** Newest first; a name sorts from A, a figure or a date from the top. */
const DEFAULT_SORT: SortState = { key: "updated", dir: "desc" };

interface Person {
  id: string;
  name: string;
}

/**
 * The organization's projects against the plan's limit, newest first,
 * searched, filtered by owner and paged on the server. Each opens as the
 * content page opens it. `balance` is undefined until `/credits/balance`
 * answers: the list is there before it, the amount fills in with it.
 */
export const ProjectsDetail = ({ balance }: { balance?: CreditBalance }) => {
  const { t, i18n } = useTranslation("common");
  const language = i18n.language;
  // A phone gives the search a row of its own above the pills.
  const isPhone = useMediaQuery(useTheme().breakpoints.down("sm"));
  const dateLocale = useDateFnsLocale();
  const list = useListControls();
  const [owner, setOwner] = useState<Person | null>(null);
  const directory = useMemberDirectory();
  const sort = list.sort ?? DEFAULT_SORT;
  const projects = useOrgProjects({
    q: list.q || undefined,
    owner: owner?.id,
    sort: sort.key,
    dir: sort.dir,
    limit: PAGE_SIZE,
    offset: (list.page - 1) * PAGE_SIZE,
  });

  /** The owner filter: the list starts on page 1 again. */
  const pickOwner = (person: Person | null) => {
    setOwner(person);
    list.restart();
  };
  const people = [...directory.people.entries()].map(([id, person]) => ({ id, name: person.name }));
  const count = (value: number) => value.toLocaleString(language);
  const used = balance?.used_projects ?? 0;
  const limit = balance?.total_projects ?? null;
  // The amount counts the projects in the trash, the list does not: the line
  // under the amount says how the two part. A core without `trash` names none.
  const trash = projects.projects?.trash?.count ?? 0;
  const live = Math.max(used - trash, 0);

  const columns: UsageColumn<OrgProject>[] = [
    {
      key: "name",
      label: t("project"),
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (row) => (
        <UsageTitleCell
          title={row.name}
          sub={t("usage_layers_count", { count: row.layers, layers: count(row.layers) })}
          mark={<MarkBlock kind="project" />}
          href={`/map/${row.project_id}`}
        />
      ),
    },
    personColumn({
      label: t("owner"),
      // A creator whose account was removed leaves no owner: the row stays
      // the organization's through its space, and there is no one to filter by.
      person: (row) =>
        row.owner_id === null
          ? null
          : {
              id: row.owner_id,
              name: row.owner ?? directory.people.get(row.owner_id)?.name ?? t("unknown"),
            },
      absent: t("usage_owner_removed"),
      onPick: pickOwner,
      hint: (name) => t("usage_show_projects_of", { name, ...PLAIN }),
    }),
    figureColumn({ key: "layers", label: t("layers"), value: (row) => count(row.layers) }),
    sinceColumn({
      key: "updated",
      label: t("usage_col_updated"),
      date: (row) => row.updated_at,
      locale: dateLocale,
      main: true,
    }),
  ];
  const noun = (value: number) => t("usage_noun_projects", { count: value });

  return (
    <DetailFrame
      // The amount is the balance's: the header waits for it, the list does not.
      header={
        balance
          ? {
              title: t("projects"),
              amount: count(used),
              amountRest:
                limit === null
                  ? t("usage_projects_no_limit", { count: used })
                  : t(balance.on_trial ? "usage_amount_of_trial_limit" : "usage_amount_of_plan", {
                      limit: count(limit),
                    }),
              amountTone: limit !== null && used > limit ? "error" : undefined,
              note:
                trash > 0
                  ? t("usage_projects_trash", { count: live, live: count(live), trash: count(trash) })
                  : undefined,
              explain: t("usage_projects_explain"),
              limitLine: limit !== null ? t("usage_projects_limit") : undefined,
            }
          : undefined
      }
      toolbar={
        <>
          <SearchInput
            size="toolbar"
            fullWidth={isPhone}
            value={list.query}
            onChange={list.setQuery}
            placeholder={t("search_projects")}
          />
          <MemberPill
            value={owner?.id ?? null}
            options={people}
            onChange={(id) => pickOwner(id ? (people.find((person) => person.id === id) ?? null) : null)}
            allLabel={t("usage_all_owners")}
            valueLabel={owner?.name}
          />
        </>
      }>
      <DetailList
        label={t("projects")}
        noun={noun}
        columns={columns}
        rows={projects.projects?.rows}
        rowKey={(row) => row.project_id}
        total={projects.projects?.total ?? 0}
        page={list.page}
        onPage={list.setPage}
        sort={sort}
        onSort={(key) => list.sortBy(key, sort, key === "name" ? "asc" : "desc")}
        chips={[
          ...(owner
            ? [
                {
                  label: t("usage_owner_chip", { name: owner.name, ...PLAIN }),
                  onRemove: () => pickOwner(null),
                },
              ]
            : []),
          ...searchChips(t, list.query, () => list.setQuery("")),
        ]}
        onClearAll={() => {
          setOwner(null);
          list.setQuery("");
        }}
        isLoading={projects.isLoading}
        failed={!!projects.isError}
        searched={list.q}
        emptyTitle={owner ? t("usage_empty_filters", { noun: noun(0) }) : t("usage_projects_empty")}
        emptyHint={owner ? t("usage_empty_filters_hint") : t("usage_projects_empty_hint")}
      />
    </DetailFrame>
  );
};
