"use client";

import { Box, Typography, useMediaQuery, useTheme } from "@mui/material";
import { format, formatDistance } from "date-fns";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useDateFnsLocale } from "@/i18n/utils";

import { parseApiDate } from "@/lib/utils/credits";

import { useNow } from "@/hooks/assistant/useNow";

import StatusPill from "@/components/common/StatusPill";
import UserAvatar from "@/components/dashboard/common/UserAvatar";
import type { MemberRow, MemberSort } from "@/components/settings/members/memberRows";
import { type UsageChip, type UsageColumn, UsageList } from "@/components/settings/usage/UsageList";

/** "Einladung ausstehend": GOAT's status pill, in amber. */
const PendingPill = () => {
  const { t } = useTranslation("common");
  return <StatusPill tone="warning">{t("settings_members_status_pending")}</StatusPill>;
};

/** An invitation's avatar: a dashed circle with the address's first letter. */
const InviteAvatar = ({ email }: { email: string }) => {
  const theme = useTheme();
  return (
    <Box
      aria-hidden
      sx={{
        width: 32,
        height: 32,
        flexShrink: 0,
        borderRadius: "50%",
        border: `1.5px dashed ${theme.palette.text.secondary}`,
        display: "grid",
        placeItems: "center",
        fontSize: 13,
        fontWeight: 700,
        color: "text.secondary",
      }}>
      {email.charAt(0).toUpperCase()}
    </Box>
  );
};

/**
 * Mitglieder's list, drawn like the Usage lists (decision 17): one page of
 * rows the page filtered and sorted. Below `lg` the Status column goes and the
 * pending pill sits under the name. Below `sm` the list keeps the member and
 * the role (UsageList's phone layout), and the row's ⋮ menu moves beside the
 * role, so a phone can still remove and withdraw.
 */
export default function MembersList({
  rows,
  total,
  page,
  onPage,
  sort,
  onSort,
  chips,
  onClearAll,
  isLoading,
  emptyTitle,
  emptyHint,
  renderRole,
  renderActions,
}: {
  rows: MemberRow[] | undefined;
  total: number;
  page: number;
  onPage: (page: number) => void;
  sort: MemberSort;
  onSort: (key: string) => void;
  chips: UsageChip[];
  onClearAll: () => void;
  isLoading: boolean;
  emptyTitle: string;
  emptyHint: string;
  renderRole: (row: MemberRow) => ReactNode;
  renderActions: (row: MemberRow) => ReactNode;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const locale = useDateFnsLocale();
  // Read again every 30 seconds, so "3 minutes ago" moves on.
  const now = useNow();
  // Core's dates (naive UTC): none for one that does not parse. A browser
  // clock behind core's would put a fresh send in the future ("in less than
  // a minute"): it is never later than now.
  const ago = (value: string | null | undefined) => {
    const date = value ? parseApiDate(value).getTime() : NaN;
    return Number.isNaN(date) ? null : formatDistance(Math.min(date, now), now, { addSuffix: true, locale });
  };
  const monthOf = (value: string | null | undefined) => {
    const date = value ? parseApiDate(value) : null;
    return date && !Number.isNaN(date.getTime()) ? format(date, "LLLL yyyy", { locale }) : null;
  };
  const invitedText = (row: MemberRow) => {
    const time = ago(row.invitedAt);
    return time ? t("settings_members_invited_ago", { time }) : t("settings_members_invited");
  };
  // The Status column shows from `lg`: from `md` the settings nav takes its
  // width, and Rolle, Status and the menu would leave the member no room.
  const narrow = useMediaQuery(theme.breakpoints.down("lg"));
  // UsageList's own breakpoint: below it only the member and the role show.
  const isPhone = useMediaQuery(theme.breakpoints.down("sm"));
  const columns: UsageColumn<MemberRow>[] = [
    {
      key: "member",
      label: t("settings_members_col_member"),
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (row) => (
        <>
          {row.pending ? (
            <InviteAvatar email={row.email} />
          ) : (
            <UserAvatar id={row.id} name={row.name} src={row.avatar} size={32} />
          )}
          <Box sx={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minWidth: 0 }}>
              <Typography data-member-name noWrap sx={{ fontSize: 13.5, fontWeight: 700 }}>
                {row.name}
              </Typography>
              {row.isSelf && (
                <Box
                  component="span"
                  sx={{
                    flexShrink: 0,
                    px: 1.5,
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 700,
                    backgroundColor: "action.selected",
                  }}>
                  {t("settings_members_you")}
                </Box>
              )}
            </Box>
            {/* A member without a name is already named by the address. */}
            {(row.pending || row.email !== row.name) && (
              <Typography noWrap sx={{ fontSize: 11.5, color: "text.secondary" }}>
                {row.pending ? invitedText(row) : row.email}
              </Typography>
            )}
            {row.pending && narrow && (
              <Box>
                <PendingPill />
              </Box>
            )}
          </Box>
        </>
      ),
    },
    {
      key: "role",
      label: t("settings_members_col_role"),
      width: "200px",
      sortable: true,
      main: true,
      render: isPhone
        ? (row) => (
            <>
              {renderRole(row)}
              {renderActions(row)}
            </>
          )
        : renderRole,
    },
    ...(narrow
      ? []
      : [
          {
            key: "status",
            label: t("settings_members_col_status"),
            width: "180px",
            render: (row: MemberRow) => {
              if (row.pending) {
                const sent = ago(row.lastSentAt);
                return (
                  <Box
                    sx={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "2px" }}>
                    <PendingPill />
                    {sent && (
                      <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
                        {t("settings_members_sent_ago", { time: sent })}
                      </Typography>
                    )}
                  </Box>
                );
              }
              const since = monthOf(row.joinedAt);
              return (
                <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                  {since
                    ? t("settings_members_member_since", { date: since })
                    : t("settings_members_status_member")}
                </Typography>
              );
            },
          },
        ]),
    // The header is read out, not shown: the ⋮ buttons say what they are.
    {
      key: "actions",
      label: t("actions"),
      hideLabel: true,
      width: "40px",
      align: "right",
      render: renderActions,
    },
  ];

  return (
    <UsageList<MemberRow>
      label={t("settings_members_list_label")}
      noun={(count) => t("usage_noun_members", { count })}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      total={total}
      page={page}
      onPage={onPage}
      sort={sort}
      onSort={onSort}
      chips={chips}
      onClearAll={onClearAll}
      isLoading={isLoading}
      emptyTitle={emptyTitle}
      emptyHint={emptyHint}
    />
  );
}
