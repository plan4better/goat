"use client";

import { Box, IconButton, Skeleton, Stack, alpha, debounce, useTheme } from "@mui/material";
import type { TFunction } from "i18next";
import { parseAsString, useQueryState } from "nuqs";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useOrganizationMembers } from "@/lib/api/organizations";
import type { BreakdownRow, CreditBalance, SortDir } from "@/lib/api/usage";
import { useOrganization } from "@/lib/api/users";
import { formatCreditsDay } from "@/lib/utils/credits";
import { type UsageRange, daySpanLabel, rangeLabel, rangeSpan } from "@/lib/utils/usageRange";

import { useOrganizationId } from "@/hooks/settings/useOrganizationId";

import SurfaceCard from "@/components/dashboard/common/SurfaceCard";
import { personName } from "@/components/settings/common/personName";
import { type OrgRole, roleWords } from "@/components/settings/common/roleWords";
import type { UsageChip } from "@/components/settings/usage/UsageList";

export { GroupToggle } from "@/components/settings/usage/GroupToggle";

/** User text in a translated string: React escapes what it renders, so
 * i18next must not escape a name a second time ("O&#39;Brien"). */
export const PLAIN = { interpolation: { escapeValue: false } } as const;

export interface SortState {
  key: string;
  dir: SortDir;
}

/**
 * The search, the sort and the page of a usage list. `query` is the typed
 * text, `q` the search the requests carry: 300 ms after the last key, at once
 * when the field is emptied. A new search or sort sets the page back to 1, and
 * so does `restart`, which a detail calls when a filter of its own changes: a
 * filter never leaves the list on a page it no longer has.
 */
export function useListControls() {
  const [query, setQueryState] = useState("");
  const [q, setQ] = useState("");
  const debouncedSetQ = useMemo(() => debounce((next: string) => setQ(next), 300), []);
  useEffect(() => () => debouncedSetQ.clear(), [debouncedSetQ]);
  const [sort, setSortState] = useState<SortState | null>(null);
  const [page, setPage] = useState(1);

  return {
    query,
    q,
    setQuery: (next: string) => {
      setQueryState(next);
      setPage(1);
      const trimmed = next.trim();
      if (trimmed) debouncedSetQ(trimmed);
      else {
        debouncedSetQ.clear();
        setQ("");
      }
    },
    /** null: the list's own order. */
    sort,
    /** A column's first click sorts by `firstDir`; the next ones flip it. */
    sortBy: (key: string, current: SortState, firstDir: SortDir) => {
      setSortState(
        current.key === key ? { key, dir: current.dir === "desc" ? "asc" : "desc" } : { key, dir: firstDir }
      );
      setPage(1);
    },
    resetSort: () => setSortState(null),
    page,
    setPage,
    restart: () => setPage(1),
  };
}

/** A member id as core takes it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The state of a credits or AI credits detail: the list's controls, the
 * range, the grouping and the member (in the address, so another tile can
 * open the detail narrowed to one). Every change but a page sets the page
 * back to 1. While a member is chosen there are no members to group by: the
 * grouping falls back to `afterMember`.
 */
export function useUsageDetailState<G extends string>({
  group: initialGroup,
  memberGroup,
  afterMember,
}: {
  group: G;
  memberGroup: G;
  afterMember: G;
}) {
  const list = useListControls();
  const [memberParam, setMemberParam] = useQueryState(
    "member",
    parseAsString.withOptions({ history: "replace" })
  );
  // An address edited by hand may name no member id, which every request
  // would carry to core and have refused: it counts as no member, and leaves
  // the address.
  const member = memberParam && UUID.test(memberParam) ? memberParam : null;
  useEffect(() => {
    if (memberParam && !member) void setMemberParam(null);
  }, [memberParam, member, setMemberParam]);
  const [range, setRangeState] = useState<UsageRange>({ preset: "period" });
  const [chosenGroup, setGroupState] = useState<G>(initialGroup);
  const groupFor = (id: string | null, chosen: G) => (id && chosen === memberGroup ? afterMember : chosen);
  const group = groupFor(member, chosenGroup);

  const setGroup = (next: G) => {
    setGroupState(next);
    list.setQuery("");
    list.resetSort();
  };
  /** A member chosen from the Members grouping moves it to `afterMember`.
   * The search and the sort belong to a grouping: they go when it changes,
   * also when clearing the member brings Members back. */
  const narrowTo = (id: string | null) => {
    void setMemberParam(id);
    const chosen = id && chosenGroup === memberGroup ? afterMember : chosenGroup;
    if (groupFor(id, chosen) !== group) setGroup(chosen);
    else setGroupState(chosen);
    list.restart();
  };

  return {
    ...list,
    range,
    setRange: (next: UsageRange) => {
      setRangeState(next);
      list.restart();
    },
    group,
    setGroup,
    member,
    setMember: narrowTo,
    clearAll: () => {
      narrowTo(null);
      list.setQuery("");
    },
  };
}

/** The organization's people by id: a name for a member the range has no
 * usage of, and the role a member row names below the name. `isLoading`
 * until the organization's id is known and its people are read; an
 * organization that cannot be read leaves no one to wait for. */
export const useMemberDirectory = () => {
  // The cookie's id: the list does not wait for GET /users/organization (L4).
  const organizationId = useOrganizationId();
  const { isError: organizationError } = useOrganization();
  const { members, isLoading } = useOrganizationMembers(organizationId ?? "");
  const people = useMemo(
    () =>
      new Map(
        (members ?? []).map((member) => [
          member.id,
          {
            name: personName(member),
            role: member.roles.find((role) => role.startsWith("organization-")) ?? null,
          },
        ])
      ),
    [members]
  );
  return { people, isLoading: (!organizationId && !organizationError) || !!isLoading };
};

export type MemberDirectory = ReturnType<typeof useMemberDirectory>;

/** A member's organization role in the words every settings page uses; undefined for none. */
export const roleWord = (role: string | null | undefined, t: TFunction): string | undefined => {
  const words = roleWords(t);
  return role && role in words ? words[role as OrgRole].word : undefined;
};

/** The name of the member a detail is narrowed to: from its usage rows, else
 * from the organization's people. null while either is still loading; once
 * both are read without them, "Unknown". */
export const memberNameOf = (
  id: string,
  usage: { rows: BreakdownRow[] | undefined; isLoading: boolean },
  directory: MemberDirectory,
  t: TFunction
): string | null =>
  usage.rows?.find((row) => row.key === id)?.name ??
  directory.people.get(id)?.name ??
  (usage.isLoading || directory.isLoading ? null : t("unknown"));

/** The chips of a detail: the member it is narrowed to (in sight from the
 * moment the filter is in force, a placeholder while `memberName` is null)
 * and the search. */
export const filterChips = (
  t: TFunction,
  {
    member,
    memberName,
    query,
    onClearMember,
    onClearQuery,
  }: {
    member: string | null;
    memberName: string | null;
    query: string;
    onClearMember: () => void;
    onClearQuery: () => void;
  }
): UsageChip[] => [
  ...(member
    ? [
        memberName === null
          ? {
              label: t("usage_member_chip", { name: "", ...PLAIN }).trim(),
              pending: true,
              onRemove: onClearMember,
            }
          : { label: t("usage_member_chip", { name: memberName, ...PLAIN }), onRemove: onClearMember },
      ]
    : []),
  ...searchChips(t, query, onClearQuery),
];

/** The chip of a search, when there is one. */
export const searchChips = (t: TFunction, query: string, onClear: () => void): UsageChip[] =>
  query.trim() ? [{ label: t("usage_search_chip", { q: query.trim(), ...PLAIN }), onRemove: onClear }] : [];

/** How the amount line names the range: "this period", "in the last 7 days". */
export const rangePhrase = (
  range: UsageRange,
  balance: CreditBalance,
  t: TFunction,
  language: string
): string => {
  switch (range.preset) {
    case "period":
      return t(balance.on_trial ? "usage_phrase_trial" : "usage_phrase_period");
    case "last": {
      const span = rangeSpan(range, balance, t, language);
      return span ? t("usage_phrase_last", { span }) : t("usage_phrase_period");
    }
    case "custom":
      return t("usage_phrase_custom", { span: rangeLabel(range, t, language, balance.on_trial) });
    default:
      return t(`usage_phrase_${range.preset}`);
  }
};

/**
 * The rest of a detail's amount line: what was used by the chosen member, or
 * in the range; "out of" the limit only for this period, as the limit holds
 * for it alone. null while the chosen member's name is still loading.
 */
export const amountRest = ({
  unit,
  amount,
  limit,
  range,
  balance,
  member,
  memberName,
  limitText,
  t,
  language,
}: {
  unit: "credits" | "ai";
  /** The amount shown, for the unit's plural. */
  amount: number;
  limit: number | null;
  range: UsageRange;
  balance: CreditBalance;
  /** The member the detail is narrowed to, and their name (null: loading). */
  member: string | null;
  memberName: string | null;
  /** The limit as the detail writes its figures. */
  limitText: string;
  t: TFunction;
  language: string;
}): string | null => {
  const unitText = t(unit === "ai" ? "usage_unit_ai" : "usage_unit_credits", { count: amount });
  const phrase = rangePhrase(range, balance, t, language);
  if (member) {
    return memberName === null
      ? null
      : t("usage_amount_member", { unit: unitText, name: memberName, phrase, ...PLAIN });
  }
  if (limit === null) return t("usage_amount_no_limit", { unit: unitText, phrase });
  if (range.preset !== "period") return t("usage_amount_used", { unit: unitText, phrase });
  if (balance.on_trial) return t("usage_amount_of_trial", { limit: limitText });
  const date = formatCreditsDay(balance.credits_reset_at, language, { year: true });
  return date
    ? t("usage_amount_of_period", { limit: limitText, date })
    : t("usage_amount_of_period_open", { limit: limitText });
};

/** A period row by its days: "30 Sep to 30 Oct 2026", the open one "31 Oct
 * 2026 to now". Its key is its first day, `until` the day after its last. */
export const periodLabel = (row: BreakdownRow, t: TFunction, language: string): string => {
  const from = new Date(`${row.key}T00:00:00Z`);
  if (!row.until) {
    return t("usage_period_open", { from: formatCreditsDay(row.key, language, { utc: true, year: true }) });
  }
  const last = new Date(new Date(`${row.until}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000);
  return daySpanLabel(from, last, t, language);
};

/** A row's share of the list's total: a short bar and the whole percent. */
export const ShareCell = ({ value, total }: { value: number; total: number }) => {
  const theme = useTheme();
  const percent = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <>
      <Box
        aria-hidden
        sx={{
          flex: 1,
          maxWidth: 100,
          height: 6,
          borderRadius: "3px",
          overflow: "hidden",
          backgroundColor: alpha(theme.palette.text.primary, 0.08),
        }}>
        <Box sx={{ width: `${percent}%`, height: "100%", backgroundColor: "primary.main" }} />
      </Box>
      <Box
        component="span"
        sx={{
          width: 36,
          textAlign: "right",
          fontSize: 12.5,
          color: "text.secondary",
          fontVariantNumeric: "tabular-nums",
        }}>
        {percent} %
      </Box>
    </>
  );
};

/** Saves one period's entries as CSV; a failed export says so. */
export const PeriodDownload = ({ label, onDownload }: { label: string; onDownload: () => Promise<void> }) => {
  const { t } = useTranslation("common");
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try {
      await onDownload();
    } catch {
      toast.error(t("usage_export_failed"));
    } finally {
      setRunning(false);
    }
  };
  return (
    <IconButton size="small" aria-label={label} title={label} disabled={running} onClick={() => void run()}>
      <Icon iconName={ICON_NAME.DOWNLOAD} style={{ fontSize: 16 }} />
    </IconButton>
  );
};

/** Two or more parts of one amount as a 12px bar with a legend below; the
 * bar is an image named by the legend. */
export const SplitCard = ({
  parts,
}: {
  parts: { key: string; label: string; value: number; color: string }[];
}) => {
  const theme = useTheme();
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
  return (
    <SurfaceCard hoverable={false} sx={{ p: 4, display: "flex", flexDirection: "column", gap: 2.5 }}>
      <Box
        role="img"
        aria-label={parts.map((part) => part.label).join(", ")}
        sx={{
          display: "flex",
          height: 12,
          borderRadius: "6px",
          overflow: "hidden",
          backgroundColor: alpha(theme.palette.text.primary, 0.08),
        }}>
        {total > 0 &&
          parts.map((part) => (
            <Box
              key={part.key}
              sx={{ width: `${(Math.max(0, part.value) / total) * 100}%`, backgroundColor: part.color }}
            />
          ))}
      </Box>
      <Stack
        direction="row"
        useFlexGap
        flexWrap="wrap"
        gap={4}
        sx={{ fontSize: 12.5, color: "text.secondary" }}>
        {parts.map((part) => (
          <Stack key={part.key} direction="row" alignItems="center" gap={1.5}>
            <Box
              aria-hidden
              sx={{ width: 10, height: 10, borderRadius: "3px", backgroundColor: part.color }}
            />
            {part.label}
          </Stack>
        ))}
      </Stack>
    </SurfaceCard>
  );
};

/** The detail's head while its amount loads. */
export const DetailHeaderSkeleton = () => (
  <Stack spacing={2}>
    <Skeleton variant="rounded" height={20} width={160} sx={{ borderRadius: "6px" }} />
    <Skeleton variant="rounded" height={14} sx={{ borderRadius: "6px", width: 360, maxWidth: "100%" }} />
  </Stack>
);

/** The body of a detail: its parts one under the other. */
export const DetailBody = ({ children }: { children: ReactNode }) => <Stack spacing={4}>{children}</Stack>;
