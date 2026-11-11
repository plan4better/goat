"use client";

import { useMediaQuery, useTheme } from "@mui/material";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useOrganizationMembers } from "@/lib/api/organizations";
import { type CreditBalance, useCreditBreakdown } from "@/lib/api/usage";
import { useOrganization } from "@/lib/api/users";
import { SETTINGS_ROUTES } from "@/lib/settingsRoutes";
import { formatCredits, formatRate } from "@/lib/utils/credits";
import { requestWindow } from "@/lib/utils/usageRange";
import { organizationRoles } from "@/lib/validations/organization";

import { useLocalList } from "@/hooks/settings/useLocalList";
import { useOrganizationId } from "@/hooks/settings/useOrganizationId";

import PillMenu from "@/components/dashboard/common/PillMenu";
import SearchInput from "@/components/dashboard/common/SearchInput";
import ToolPill from "@/components/dashboard/common/ToolPill";
import UserAvatar from "@/components/dashboard/common/UserAvatar";
import { personName } from "@/components/settings/common/personName";
import { DetailFrame, DetailList, figureColumn } from "@/components/settings/usage/UsageDetailFrame";
import type { UsageDetailHeaderProps } from "@/components/settings/usage/UsageDetailHeader";
import {
  PLAIN,
  type SortState,
  roleWord,
  searchChips,
  useListControls,
} from "@/components/settings/usage/UsageDetailParts";
import { type UsageColumn, UsageTitleCell } from "@/components/settings/usage/UsageList";

type RoleFilter = "all" | "admins" | "editors" | "viewers";

/** The organization roles each filter keeps. */
const ROLES: Record<Exclude<RoleFilter, "all">, string[]> = {
  admins: [organizationRoles.OWNER, organizationRoles.ADMIN],
  editors: [organizationRoles.EDITOR],
  viewers: [organizationRoles.VIEWER],
};
const DEFAULT_SORT: SortState = { key: "credits", dir: "desc" };

/** A member, or an open invitation, with what they used this period. */
interface SeatRow {
  id: string;
  name: string;
  email: string;
  role: string | null;
  invited: boolean;
  credits: number;
  ai_credits: number;
}

const searchText = (row: SeatRow) => `${row.name} ${row.email}`;

/** The header: the editor seats against their limit, the viewers beside them. */
const seatsHeader = (balance: CreditBalance, t: TFunction, language: string): UsageDetailHeaderProps => {
  const count = (value: number) => value.toLocaleString(language);
  const editors = balance.total_editors;
  const viewers = balance.total_viewers;
  const editorsText =
    editors === null
      ? t("usage_seats_editors", { count: balance.used_editors })
      : t("usage_seats_editors_of", { limit: count(editors) });
  const viewersText =
    viewers === null
      ? t("usage_seats_viewers", { count: balance.used_viewers, used: count(balance.used_viewers) })
      : t("usage_seats_viewers_of", { used: count(balance.used_viewers), limit: count(viewers) });
  return {
    title: t("usage_seats_title"),
    amount: count(balance.used_editors),
    amountRest: t(editors === null && viewers === null ? "usage_seats_line_no_limit" : "usage_seats_line", {
      editors: editorsText,
      viewers: viewersText,
    }),
    // More editors than seats, as the tile's red dot says.
    amountTone: editors !== null && balance.used_editors > editors ? "error" : undefined,
    explain: [
      t("usage_seats_explain"),
      balance.ai_credits_per_editor
        ? t("usage_seats_explain_ai", { perEditor: formatRate(balance.ai_credits_per_editor, language) })
        : null,
    ]
      .filter(Boolean)
      .join(" "),
    limitLine: editors !== null || viewers !== null ? t("usage_seats_limit") : undefined,
    action: (
      <ToolPill icon={ICON_NAME.USERS} label={t("usage_manage_members")} href={SETTINGS_ROUTES.members} />
    ),
  };
};

/**
 * The editor and viewer seats: who holds them (open invitations too, as they
 * hold a seat) with the credits and AI credits each used this period, found
 * by name or email and filtered by role, all in the browser. A member with
 * credits opens Credits narrowed to them, one with AI credits only opens AI
 * credits. `balance` is undefined until `/credits/balance` answers: the list
 * is there before it, the header's seats fill in with it.
 */
export const EditorsDetail = ({
  balance,
  onOpenUsage,
}: {
  balance?: CreditBalance;
  onOpenUsage: (quota: "credits" | "ai", memberId: string) => void;
}) => {
  const { t, i18n } = useTranslation("common");
  const language = i18n.language;
  // A phone gives the search a row of its own above the pills.
  const isPhone = useMediaQuery(useTheme().breakpoints.down("sm"));
  const list = useListControls();
  const [role, setRole] = useState<RoleFilter>("all");
  const { isError: organizationError } = useOrganization();
  // The cookie's id: the members do not wait for GET /users/organization (L4).
  const organizationId = useOrganizationId();
  const members = useOrganizationMembers(organizationId ?? "", { include_invitations: true });
  // This period: core counts from its start, so the usage does not wait for the balance.
  const usage = useCreditBreakdown("member", requestWindow({ preset: "period" }, balance) ?? {});
  const sort = list.sort ?? DEFAULT_SORT;

  const usageOf = new Map((usage.breakdown?.rows ?? []).map((row) => [row.key, row]));
  const rows: SeatRow[] | undefined =
    members.members && usage.breakdown
      ? members.members
          .filter((member) => role === "all" || member.roles.some((name) => ROLES[role].includes(name)))
          .map((member) => {
            const used = usageOf.get(member.id);
            return {
              id: member.id,
              name: personName(member),
              email: member.email,
              role: member.roles.find((name) => name.startsWith("organization-")) ?? null,
              invited: member.invitation_status === "pending",
              credits: used?.credits ?? 0,
              ai_credits: used?.ai_credits ?? 0,
            };
          })
      : undefined;
  const local = useLocalList(rows, { search: searchText, query: list.query, sort, page: list.page });
  // Without the organization there are no members to ask for.
  const failed = !!organizationError || !!members.isError || !!usage.isError;

  const credits = (value: number) => formatCredits(value, language);
  const roleLabels: Record<RoleFilter, string> = {
    all: t("usage_all_roles"),
    admins: t("usage_role_admins"),
    editors: t("editors"),
    viewers: t("viewers"),
  };
  const pickRole = (next: RoleFilter) => {
    setRole(next);
    list.restart();
  };

  const columns: UsageColumn<SeatRow>[] = [
    {
      key: "name",
      label: t("member"),
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (row) => {
        const roleText = roleWord(row.role, t);
        // The usage they have to show: credits first; without any, nothing to open.
        const opens = row.credits > 0 ? "credits" : row.ai_credits > 0 ? "ai" : null;
        return (
          <UsageTitleCell
            title={row.name}
            sub={row.invited && roleText ? t("usage_role_invited", { role: roleText }) : roleText}
            mark={<UserAvatar id={row.id} name={row.name} size={32} />}
            {...(opens
              ? {
                  onClick: () => onOpenUsage(opens, row.id),
                  hint: t(opens === "credits" ? "usage_show_credits_of" : "usage_show_ai_credits_of", {
                    name: row.name,
                    ...PLAIN,
                  }),
                }
              : {})}
          />
        );
      },
    },
    figureColumn({ key: "credits", label: t("credits"), value: (row) => credits(row.credits) }),
    figureColumn({
      key: "ai_credits",
      label: t("usage_ai_credits"),
      width: "110px",
      main: true,
      value: (row) => credits(row.ai_credits),
    }),
  ];

  const noun = (value: number) => t("usage_noun_members", { count: value });

  return (
    <DetailFrame
      // The seats are the balance's: the header waits for it, the list does not.
      header={balance ? seatsHeader(balance, t, language) : undefined}
      toolbar={
        <>
          <SearchInput
            size="toolbar"
            fullWidth={isPhone}
            value={list.query}
            onChange={list.setQuery}
            placeholder={t("usage_search_members")}
          />
          <PillMenu<RoleFilter>
            value={role}
            options={(Object.keys(roleLabels) as RoleFilter[]).map((value) => ({
              value,
              label: roleLabels[value],
            }))}
            onChange={pickRole}
            icon={ICON_NAME.USERS}
            active={role !== "all"}
            label={t("role")}
          />
        </>
      }>
      <DetailList
        label={t("usage_seats_title")}
        noun={noun}
        columns={columns}
        rows={local.pageRows}
        rowKey={(row) => row.id}
        total={local.total}
        page={local.page}
        onPage={list.setPage}
        sort={sort}
        onSort={(key) => list.sortBy(key, sort, key === "name" ? "asc" : "desc")}
        chips={[
          ...(role === "all"
            ? []
            : [{ label: t("usage_role_chip", { role: roleLabels[role] }), onRemove: () => pickRole("all") }]),
          ...searchChips(t, list.query, () => list.setQuery("")),
        ]}
        onClearAll={() => {
          setRole("all");
          list.setQuery("");
        }}
        // Both the people and their usage: until then (and while the
        // organization loads) there is nothing to join.
        isLoading={rows === undefined && !failed}
        failed={failed}
        searched={list.query.trim()}
        emptyTitle={t("usage_empty_filters", { noun: noun(0) })}
        emptyHint={t("usage_empty_filters_hint")}
      />
    </DetailFrame>
  );
};
