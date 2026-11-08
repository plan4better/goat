"use client";

import { Box, Button, Tooltip, Typography, useTheme } from "@mui/material";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useOrganizationMembers } from "@/lib/api/organizations";
import { useTeamMembers } from "@/lib/api/teams";

import { useOrganizationId } from "@/hooks/settings/useOrganizationId";

import { DialogLoadFailed, orLoadFailed } from "@/components/assistant/LoadFailed";
import UserAvatar from "@/components/dashboard/common/UserAvatar";
import CardSkeleton from "@/components/settings/common/CardSkeleton";
import type { Person } from "@/components/settings/common/PeoplePicker";
import RowMenu from "@/components/settings/common/RowMenu";
import SettingsCard from "@/components/settings/common/SettingsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import { personName } from "@/components/settings/common/personName";
import { orgRoleOf, roleWords } from "@/components/settings/common/roleWords";
import type { TeamPermissions } from "@/components/settings/team/teamPermissions";

// Loaded on first open (L5); a dialog whose code does not load shows a notice.
const AddTeamMembersDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/team/AddTeamMembersDialog"), DialogLoadFailed),
  { ssr: false }
);
const RemoveTeamMemberDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/team/RemoveTeamMemberDialog"), DialogLoadFailed),
  { ssr: false }
);
const PLAIN = { interpolation: { escapeValue: false } } as const;

/**
 * Mitglieder {n}: owner first, then by name; from `md` each one's role in the
 * organization; adding and removing for those who manage members. The rows
 * show as soon as the team's members are read; the role column and the
 * people to add need the organization's members, so until those are there the
 * column is left out and "Mitglieder hinzufügen" is disabled, and a failed
 * read offers a retry beside it. Reloading reads the key the team cards on
 * Teams use too (`GET /teams/{id}/members`), so their count follows.
 */
export default function TeamMembersCard({
  teamId,
  teamName,
  selfId,
  permissions,
}: {
  teamId: string;
  teamName: string;
  /** Unknown until the profile answers: no "Sie" and no menus till then. */
  selfId?: string;
  permissions: TeamPermissions;
}) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const words = useMemo(() => roleWords(t), [t]);
  const organizationId = useOrganizationId();
  const { teamMembers, isLoading, isError, mutate } = useTeamMembers(teamId);
  const {
    members: orgMembers,
    isError: orgError,
    mutate: mutateOrgMembers,
  } = useOrganizationMembers(organizationId ?? "");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  const collator = useMemo(() => new Intl.Collator(i18n.language), [i18n.language]);
  const rows = useMemo(
    () =>
      teamMembers
        .map((member) => ({ ...member, name: personName(member) }))
        .sort((a, b) =>
          a.role === b.role ? collator.compare(a.name, b.name) : a.role === "team-owner" ? -1 : 1
        ),
    [teamMembers, collator]
  );
  const orgRoleById = useMemo(
    () => new Map((orgMembers ?? []).map((member) => [member.id, orgRoleOf(member.roles)])),
    [orgMembers]
  );
  const candidates = useMemo<Person[]>(
    () =>
      (orgMembers ?? [])
        .filter(
          (member) =>
            member.invitation_status !== "pending" && !teamMembers.some((other) => other.id === member.id)
        )
        .map((member) => {
          const role = orgRoleOf(member.roles);
          return {
            id: member.id,
            name: personName(member),
            email: member.email,
            avatar: member.avatar,
            roleWord: role && words[role].word,
          };
        }),
    [orgMembers, teamMembers, words]
  );

  const title = t("settings_team_members_title");
  const hint = permissions.canManageMembers ? undefined : t("settings_team_members_by_owner");
  const membersFailed = !!isError && teamMembers.length === 0;
  // Without an organization id (its key is null) the read never starts: the
  // rows show without the role column and Add stays disabled.
  const orgFailed = !!orgError && !orgMembers;

  if (membersFailed) {
    return (
      <SettingsCard title={title} hint={hint}>
        <SettingsLoadError onRetry={() => void mutate()} />
      </SettingsCard>
    );
  }
  if (isLoading) {
    return <CardSkeleton title={title} hint={hint} rows={2} variant="list" />;
  }

  const orgRetry = orgFailed && (
    <Tooltip title={t("settings_card_load_error")} describeChild>
      <Button
        variant="text"
        size="small"
        color="error"
        startIcon={<Icon iconName={ICON_NAME.REFRESH} style={{ fontSize: 12 }} htmlColor="inherit" />}
        onClick={() => void mutateOrgMembers()}
        sx={{ whiteSpace: "nowrap" }}>
        {t("settings_card_retry")}
      </Button>
    </Tooltip>
  );
  const addButton = permissions.canManageMembers && (
    <Button
      size="small"
      variant="outlined"
      startIcon={<Icon iconName={ICON_NAME.ADD_USER} style={{ fontSize: 14 }} htmlColor="inherit" />}
      disabled={!orgMembers}
      onClick={() => setAdding(true)}
      sx={{ borderRadius: 999, whiteSpace: "nowrap" }}>
      {t("settings_team_add_members")}
    </Button>
  );

  return (
    <SettingsCard
      title={`${title} ${rows.length}`}
      hint={hint}
      action={
        orgRetry || addButton ? (
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: 2,
            }}>
            {orgRetry}
            {addButton}
          </Box>
        ) : undefined
      }>
      <Box
        component="ul"
        sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        {rows.map((row) => {
          const owner = row.role === "team-owner";
          const orgRole = orgRoleById.get(row.id);
          return (
            <Box component="li" key={row.id} sx={{ display: "flex", alignItems: "center", gap: 3 }}>
              <UserAvatar id={row.id} name={row.name} src={row.avatar} size={32} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minWidth: 0 }}>
                  <Typography noWrap sx={{ fontSize: 13.5, fontWeight: 700 }}>
                    {row.name}
                  </Typography>
                  {row.id === selfId && (
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
                {/* A person without a name is already named by the address. */}
                {row.email !== row.name && (
                  <Typography noWrap sx={{ fontSize: 11.5, color: "text.secondary" }}>
                    {row.email}
                  </Typography>
                )}
              </Box>
              <Box
                component="span"
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 1,
                  flexShrink: 0,
                  fontSize: 13,
                  fontWeight: 600,
                }}>
                {owner && (
                  <Icon
                    iconName={ICON_NAME.CROWN}
                    style={{ fontSize: 12 }}
                    htmlColor={theme.palette.warning.main}
                  />
                )}
                {t(owner ? "team-owner" : "team-member")}
              </Box>
              {orgMembers && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ display: { xs: "none", md: "block" }, width: 200, flexShrink: 0 }}>
                  {orgRole && t("settings_team_org_role", { role: words[orgRole].word })}
                </Typography>
              )}
              {/* The row menu's button: 40px below `md`, 28px from it. */}
              <Box sx={{ width: { xs: 40, md: 34 }, flexShrink: 0 }}>
                {permissions.canManageMembers && !owner && selfId && row.id !== selfId && (
                  <RowMenu
                    label={t("settings_more_actions_for", { name: row.name, ...PLAIN })}
                    items={[
                      {
                        key: "remove",
                        label: t("settings_team_remove_member"),
                        icon: ICON_NAME.TRASH,
                        danger: true,
                        onClick: () => setRemoving({ id: row.id, name: row.name }),
                      },
                    ]}
                  />
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
      {adding && orgMembers && (
        <AddTeamMembersDialog
          teamId={teamId}
          teamName={teamName}
          candidates={candidates}
          onClose={() => setAdding(false)}
          onChanged={() => mutate()}
        />
      )}
      {removing && (
        <RemoveTeamMemberDialog
          teamId={teamId}
          teamName={teamName}
          person={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => mutate()}
        />
      )}
    </SettingsCard>
  );
}
