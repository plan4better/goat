"use client";

import { Alert, Button, Skeleton } from "@mui/material";
import { format } from "date-fns";
import dynamic from "next/dynamic";
import NextLink from "next/link";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { detailOf, statusOf } from "@/lib/api/apiError";
import {
  refreshOrganizationMembers,
  resendInvitation,
  updateOrganizationInvitationRole,
  updateOrganizationMemberRole,
  useOrganizationMembers,
} from "@/lib/api/organizations";
import { PAGE_SIZE } from "@/lib/api/usage";
import { useOrganization, useUserProfile } from "@/lib/api/users";
import { undoToast } from "@/lib/toasts";

import { useNow } from "@/hooks/assistant/useNow";
import { useOrganizationId } from "@/hooks/settings/useOrganizationId";

import { DialogLoadFailed, orLoadFailed } from "@/components/assistant/LoadFailed";
import PageHeader from "@/components/dashboard/common/PageHeader";
import PillMenu from "@/components/dashboard/common/PillMenu";
import SearchInput from "@/components/dashboard/common/SearchInput";
import ToolPill from "@/components/dashboard/common/ToolPill";
import RoleMenu from "@/components/settings/common/RoleMenu";
import RolePill from "@/components/settings/common/RolePill";
import RowMenu, { type RowMenuItem } from "@/components/settings/common/RowMenu";
import SeatTiles, { type SeatFilter } from "@/components/settings/common/SeatTiles";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import SettingsPage, { pageActionSx } from "@/components/settings/common/SettingsPage";
import { type AssignableRole, orgRoleOf, roleWords } from "@/components/settings/common/roleWords";
import MembersList from "@/components/settings/members/MembersList";
import {
  type MemberRow,
  type MemberSort,
  type RoleFilter,
  type StatusFilter,
  filterMemberRows,
  sortMemberRows,
  toMemberRows,
} from "@/components/settings/members/memberRows";
import { resendState } from "@/components/settings/members/resend";
import { type Seats, roleOptions, seatLevel, seatsOf } from "@/components/settings/members/seats";
import { UsageToolbar } from "@/components/settings/usage/UsageToolbar";
import { useReportProblemHref } from "@/components/support/SupportMenu";

// Loaded on first open (L5): the page itself needs none of them. A dialog
// whose code does not load (a deploy since the page opened) shows a notice
// instead of taking the page down.
const InviteDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/members/InviteDialog"), DialogLoadFailed),
  { ssr: false }
);
const RemoveMemberDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/members/RemoveMemberDialog"), DialogLoadFailed),
  { ssr: false }
);
const WithdrawInvitationDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/members/WithdrawInvitationDialog"), DialogLoadFailed),
  { ssr: false }
);
const RolesMatrixDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/members/RolesMatrixDialog"), DialogLoadFailed),
  { ssr: false }
);

const PLAIN = { interpolation: { escapeValue: false } } as const;
/** Until the organization answers the role menus are disabled; their options need some seats. */
const NO_LIMIT: Seats = {
  editors: { used: 0, total: null, free: null },
  viewers: { used: 0, total: null, free: null },
};

/**
 * Organisation › Mitglieder (owners and admins): the seats, the members and
 * open invitations in one list read once and paged here (decision 17), role
 * changes with undo (decision 16), remove, withdraw and invite in dialogs.
 */
export default function MembersPage() {
  const { t, i18n } = useTranslation("common");
  const words = roleWords(t);
  // The cookie's id until the organization answers, so the list starts at once (L4).
  const organizationId = useOrganizationId();
  const { userProfile, isError: profileError, mutate: mutateProfile } = useUserProfile();
  const { organization, isError: organizationError, mutate: mutateOrganization } = useOrganization();
  const {
    members,
    isError,
    mutate: mutateMembers,
  } = useOrganizationMembers(organizationId ?? "", {
    include_invitations: true,
  });
  const supportHref = useReportProblemHref();
  // The resend item turns on 10 minutes after a send without a reload: the
  // shared 30-second clock (epoch ms).
  const now = useNow();

  const [query, setQuery] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<MemberSort>({ key: "role", dir: "asc" });
  const [page, setPage] = useState(1);
  const [inviting, setInviting] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const [withdrawing, setWithdrawing] = useState<MemberRow | null>(null);

  const seats = organization ? seatsOf(organization) : undefined;
  const collator = useMemo(() => new Intl.Collator(i18n.language), [i18n.language]);
  const rows = useMemo(
    () => (members ? toMemberRows(members, userProfile?.id) : undefined),
    [members, userProfile?.id]
  );
  const shown = useMemo(
    () =>
      rows ? sortMemberRows(filterMemberRows(rows, { query, role, status }), sort, collator) : undefined,
    [rows, query, role, status, sort, collator]
  );
  const total = shown?.length ?? 0;
  const pageRows = shown?.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pending = rows?.filter((row) => row.pending).length;
  const known = useMemo(() => new Set((rows ?? []).map((row) => row.email.trim().toLowerCase())), [rows]);
  // Every member list (the settings nav counts members too) and the seats.
  const refresh = () =>
    Promise.all([
      organizationId ? refreshOrganizationMembers(organizationId) : mutateMembers(),
      mutateOrganization(),
    ]);
  // A narrower or wider list starts on its first page.
  const restart =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPage(1);
    };

  const ROLE_OPTIONS: { value: RoleFilter; label: string }[] = [
    { value: "all", label: t("settings_members_role_all") },
    { value: "admins", label: t("settings_members_role_admins") },
    { value: "editors", label: t("settings_members_role_editors") },
    { value: "viewers", label: t("settings_members_role_viewers") },
    { value: "editorSeats", label: t("settings_members_role_editor_seats") },
  ];
  const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
    { value: "all", label: t("settings_members_status_all") },
    { value: "members", label: t("settings_members_status_members") },
    { value: "pending", label: t("settings_members_status_pending") },
  ];
  // A tile is the filter it sets: Bearbeiter "Auf Bearbeiter-Plätzen",
  // Betrachter "Betrachter", Offene Einladungen "Einladung ausstehend".
  const seatFilter: SeatFilter | null =
    status === "pending"
      ? "invitations"
      : role === "editorSeats"
        ? "editors"
        : role === "viewers"
          ? "viewers"
          : null;
  const onSeatFilter = (next: SeatFilter | null) => {
    setPage(1);
    if (next === "invitations") setStatus("pending");
    else if (seatFilter === "invitations") setStatus("all");
    if (next === "editors") setRole("editorSeats");
    else if (next === "viewers") setRole("viewers");
    else if (seatFilter === "editors" || seatFilter === "viewers") setRole("all");
  };

  const chips = [
    ...(role !== "all"
      ? [
          {
            label: t("settings_members_chip_role", {
              value: ROLE_OPTIONS.find((option) => option.value === role)?.label,
              ...PLAIN,
            }),
            onRemove: () => restart(setRole)("all"),
          },
        ]
      : []),
    ...(status !== "all"
      ? [
          {
            label: t("settings_members_chip_status", {
              value: STATUS_OPTIONS.find((option) => option.value === status)?.label,
              ...PLAIN,
            }),
            onRemove: () => restart(setStatus)("all"),
          },
        ]
      : []),
    ...(query.trim()
      ? [
          {
            label: t("settings_members_chip_search", { value: query.trim(), ...PLAIN }),
            onRemove: () => restart(setQuery)(""),
          },
        ]
      : []),
  ];

  const changeRole = async (row: MemberRow, next: AssignableRole) => {
    if (!organizationId) return;
    const previous = row.role as AssignableRole;
    const apply = (to: AssignableRole) =>
      row.pending
        ? updateOrganizationInvitationRole(organizationId, row.id, to)
        : updateOrganizationMemberRole(organizationId, row.id, to);
    try {
      await apply(next);
      await refresh();
      // The undo sends the old role; a seat taken meanwhile makes it fail.
      undoToast(
        t("settings_members_role_changed", { name: row.name, role: words[next].word, ...PLAIN }),
        async () => {
          await apply(previous);
          await refresh();
        },
        t
      );
    } catch (error) {
      // A 400 is the seat limit: core's detail says which.
      const detail = statusOf(error) === 400 ? detailOf(error) : undefined;
      toast.error([t("settings_members_role_error"), detail].filter(Boolean).join(" "));
    }
  };

  const renderRole = (row: MemberRow) => {
    if (row.role === "organization-owner")
      return <RolePill role={row.role} reason={t("settings_members_owner_role_fixed")} />;
    if (row.isSelf) return <RolePill role={row.role} reason={t("settings_members_own_role_fixed")} />;
    return (
      <RoleMenu
        value={row.role}
        label={t("settings_members_role_of", { name: row.name, ...PLAIN })}
        // Rebuilt on every render, so a role change or a refreshed
        // organization moves the seats the options are checked against.
        options={roleOptions(row.role, seats ?? NO_LIMIT, t)}
        // Until the profile answers, one's own row is not known as such.
        disabled={!seats || !userProfile}
        onChange={(next) => void changeRole(row, next)}
      />
    );
  };

  // As the domain help's CopyButton: says so, or says that it could not (no
  // clipboard outside a secure context, or the browser refused).
  const copyEmail = async (email: string) => {
    try {
      if (!navigator.clipboard) throw new Error("No clipboard");
      await navigator.clipboard.writeText(email);
      toast.success(t("settings_members_email_copied"));
    } catch {
      toast.error(t("settings_card_copy_failed"));
    }
  };

  const resend = async (row: MemberRow) => {
    if (!organizationId) return;
    try {
      const answer = await resendInvitation(organizationId, row.id);
      // Only this list: a resend moves no seat and no member, but the
      // invitation's new last send turns the item off for 10 minutes.
      await mutateMembers();
      // The setup mail failed and a resend sends one mail only, so nothing
      // went out (the 10 minutes still run): only the warning, which says so.
      if (answer?.account_setup === "manual") {
        toast.warning(t("settings_members_resend_manual", { email: row.email, ...PLAIN }));
      } else {
        toast.success(t("settings_members_resent", { email: row.email, ...PLAIN }));
      }
    } catch (error) {
      const status = statusOf(error);
      // Another admin (or a clock that runs differently) sent it a moment ago:
      // reload, so the item shows from when it can go out again.
      if (status === 429) void mutateMembers();
      // Withdrawn meanwhile ("Invitation not found"): the invitation leaves
      // the list and its seat the tiles.
      if (status === 400) void refresh();
      toast.error(
        t(
          status === 429
            ? "settings_members_resend_too_soon"
            : status === 409
              ? "settings_members_resend_expired"
              : "settings_members_resend_error"
        )
      );
    }
  };

  // Disabled until 10 minutes after the last send, with the time it can go
  // out again under its label (a disabled item opens no tooltip).
  const resendItem = (row: MemberRow): RowMenuItem => {
    const state = resendState(row.lastSentAt, new Date(now));
    return {
      key: "resend",
      label: t("settings_members_resend"),
      icon: ICON_NAME.EMAIL,
      disabled: !state.allowed,
      reason:
        !state.allowed && state.from
          ? t("settings_members_resend_from", { time: format(state.from, "HH:mm") })
          : undefined,
      onClick: () => void resend(row),
    };
  };

  // None until the profile answers: one's own row could not be told apart.
  const renderActions = (row: MemberRow) =>
    !userProfile || row.role === "organization-owner" || row.isSelf ? null : (
      <RowMenu
        label={t("settings_more_actions_for", { name: row.name, ...PLAIN })}
        items={
          row.pending
            ? [
                resendItem(row),
                {
                  key: "withdraw",
                  label: t("settings_members_withdraw"),
                  icon: ICON_NAME.TRASH,
                  danger: true,
                  onClick: () => setWithdrawing(row),
                },
              ]
            : [
                {
                  key: "copy",
                  label: t("settings_members_copy_email"),
                  icon: ICON_NAME.COPY,
                  onClick: () => void copyEmail(row.email),
                },
                {
                  key: "remove",
                  label: t("settings_members_remove"),
                  icon: ICON_NAME.TRASH,
                  danger: true,
                  onClick: () => setRemoving(row),
                },
              ]
        }
      />
    );

  const supportLink = supportHref ? (
    <Button
      variant="text"
      size="small"
      color="inherit"
      href={supportHref}
      LinkComponent={supportHref.startsWith("/") ? NextLink : "a"}
      sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>
      {t("settings_members_ask_seats")}
    </Button>
  ) : undefined;

  return (
    <SettingsPage
      header={
        <PageHeader
          level={2}
          responsive
          eyebrow={t("settings_nav_group_organization")}
          title={t("settings_members_title")}
          subtitle={
            organization ? (
              t("settings_members_subtitle", { organization: organization.name, ...PLAIN })
            ) : (
              <Skeleton
                variant="text"
                component="span"
                sx={{ display: "block", width: 360, maxWidth: "100%" }}
              />
            )
          }
          action={
            <Button
              variant="contained"
              startIcon={<Icon iconName={ICON_NAME.ADD_USER} style={{ fontSize: 16 }} htmlColor="inherit" />}
              disabled={!seats || !organizationId}
              onClick={() => setInviting(true)}
              sx={pageActionSx}>
              {t("settings_members_invite")}
            </Button>
          }
        />
      }>
      {organizationError && !organization ? (
        <SettingsLoadError onRetry={() => void mutateOrganization()} />
      ) : (
        <SeatTiles seats={seats} pendingInvitations={pending} value={seatFilter} onChange={onSeatFilter} />
      )}
      {/* Standing notices of a full pool: `status`, so they are not read out as alerts.
          Counted on the pool's size, so a pool of one reads in the singular
          (a pool without limit is never full: `?? 0` is for the type). */}
      {seats && seatLevel(seats.editors) !== "ok" && (
        <Alert severity="warning" role="status" action={supportLink}>
          {t("settings_members_editors_full_callout", { count: seats.editors.total ?? 0 })}
        </Alert>
      )}
      {seats && seatLevel(seats.viewers) !== "ok" && (
        <Alert severity="warning" role="status" action={supportLink}>
          {t("settings_members_viewers_full_callout", { count: seats.viewers.total ?? 0 })}
        </Alert>
      )}
      <UsageToolbar>
        <SearchInput
          size="toolbar"
          value={query}
          onChange={restart(setQuery)}
          onClear={() => restart(setQuery)("")}
          placeholder={t("settings_members_search")}
          ariaLabel={t("settings_members_search")}
        />
        <PillMenu<RoleFilter>
          value={role}
          options={ROLE_OPTIONS}
          onChange={restart(setRole)}
          icon={ICON_NAME.USERS}
          active={role !== "all"}
          label={t("settings_members_role_filter")}
        />
        <PillMenu<StatusFilter>
          value={status}
          options={STATUS_OPTIONS}
          onChange={restart(setStatus)}
          icon={ICON_NAME.FILTER}
          active={status !== "all"}
          label={t("settings_members_status_filter")}
        />
        <ToolPill
          icon={ICON_NAME.LOCK}
          label={t("settings_members_roles_explained")}
          onClick={() => setExplaining(true)}
        />
      </UsageToolbar>
      {/* Without the profile no row can be told to be one's own: the role
          menus stay disabled and no row has a menu. SWR retries on its own;
          a profile that keeps failing says so here, once, with its retry. */}
      {!!profileError && !userProfile && <SettingsLoadError onRetry={() => void mutateProfile()} />}
      {isError && !members ? (
        <SettingsLoadError onRetry={() => void mutateMembers()} />
      ) : (
        <MembersList
          rows={pageRows}
          total={total}
          page={page}
          onPage={setPage}
          sort={sort}
          onSort={(key) => {
            setSort((current) =>
              current.key === key
                ? { key: current.key, dir: current.dir === "asc" ? "desc" : "asc" }
                : { key: key as MemberSort["key"], dir: "asc" }
            );
            setPage(1);
          }}
          chips={chips}
          onClearAll={() => {
            setRole("all");
            setStatus("all");
            setQuery("");
            setPage(1);
          }}
          isLoading={!members}
          emptyTitle={
            query.trim()
              ? t("settings_members_empty_search", { query: query.trim(), ...PLAIN })
              : t("settings_members_empty_filters")
          }
          emptyHint={t("settings_members_empty_hint")}
          renderRole={renderRole}
          renderActions={renderActions}
        />
      )}

      {inviting && organizationId && seats && (
        <InviteDialog
          organizationId={organizationId}
          organizationName={organization?.name ?? ""}
          seats={seats}
          known={known}
          onClose={() => setInviting(false)}
          onChanged={refresh}
        />
      )}
      {removing && organizationId && userProfile && rows && (
        <RemoveMemberDialog
          organizationId={organizationId}
          organizationName={organization?.name ?? ""}
          person={removing}
          heirs={sortMemberRows(
            rows.filter((row) => !row.pending && row.id !== removing.id),
            { key: "member", dir: "asc" },
            collator
          )}
          selfId={userProfile.id}
          onClose={() => setRemoving(null)}
          onRemoved={refresh}
        />
      )}
      {withdrawing && organizationId && (
        <WithdrawInvitationDialog
          organizationId={organizationId}
          invitation={withdrawing}
          onClose={() => setWithdrawing(null)}
          onWithdrawn={refresh}
        />
      )}
      {explaining && (
        <RolesMatrixDialog callerRole={orgRoleOf(userProfile?.roles)} onClose={() => setExplaining(false)} />
      )}
    </SettingsPage>
  );
}
