"use client";

import { Box, Button, Link, Skeleton, Stack, Typography, useTheme } from "@mui/material";
import dynamic from "next/dynamic";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { statusOf } from "@/lib/api/apiError";
import { useSpaces } from "@/lib/api/content";
import { useTeam, useTeams } from "@/lib/api/teams";
import { useUserProfile } from "@/lib/api/users";
import { SETTINGS_ROUTES } from "@/lib/settingsRoutes";
import { readableText } from "@/lib/utils/credits";

import { contentPath } from "@/hooks/dashboard/content/useContentPageState";

import { DialogLoadFailed, orLoadFailed } from "@/components/assistant/LoadFailed";
import CardSkeleton from "@/components/settings/common/CardSkeleton";
import DangerCard from "@/components/settings/common/DangerCard";
import SettingsCard from "@/components/settings/common/SettingsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import SettingsPage from "@/components/settings/common/SettingsPage";
import TeamMembersCard from "@/components/settings/team/TeamMembersCard";
import TeamProfileCard from "@/components/settings/team/TeamProfileCard";
import { teamPermissions } from "@/components/settings/team/teamPermissions";
import TeamAvatar from "@/components/settings/teams/TeamAvatar";

// Loaded on first open (L5); a dialog whose code does not load shows a notice.
const DeleteTeamDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/team/DeleteTeamDialog"), DialogLoadFailed),
  { ssr: false }
);
const LeaveTeamDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/team/LeaveTeamDialog"), DialogLoadFailed),
  { ssr: false }
);

/**
 * One team as one page: the path back to Teams, the head with the way to the
 * team's space, its members, its profile, and deleting or leaving it. What
 * depends on the caller's organization role (editing, deleting, leaving)
 * waits for the profile, so nothing turns editable later or opens a dialog
 * that a click queued before it loaded.
 */
export default function TeamPage(props: { params: Promise<{ teamId: string }> }) {
  const { teamId } = use(props.params);
  const { t } = useTranslation("common");
  const theme = useTheme();
  const router = useRouter();
  const { team, isLoading, isError, mutate } = useTeam(teamId);
  const { mutate: mutateTeams } = useTeams();
  const { userProfile, isError: profileError, mutate: mutateProfile } = useUserProfile();
  const { spaces } = useSpaces();
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const space = spaces.find((candidate) => candidate.team_id === teamId);
  const spaceHref = space ? contentPath({ spaceId: space.id }) : undefined;
  const permissions = teamPermissions({ teamRole: team?.role, orgRoles: userProfile?.roles });
  // Core answers null for a team the caller is not in (F3).
  const missing = team === null || statusOf(isError) === 404;
  const profileTitle = t("settings_team_profile_title");

  const path = (
    <Box
      component="nav"
      aria-label={t("settings_team_path")}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        minWidth: 0,
        fontSize: 13,
        color: "text.secondary",
      }}>
      <Link component={NextLink} href={SETTINGS_ROUTES.teams} underline="hover" color="inherit">
        {t("settings_nav_teams")}
      </Link>
      {/* A missing team has no name to go after the separator. */}
      {!missing && <span aria-hidden>/</span>}
      {team ? (
        <Box
          component="span"
          aria-current="page"
          sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {team.name}
        </Box>
      ) : (
        !missing && <Skeleton variant="text" width={120} />
      )}
    </Box>
  );

  if (missing) {
    return (
      <SettingsPage header={path}>
        <Typography>{t("settings_team_missing")}</Typography>
        <Box>
          <Link component={NextLink} href={SETTINGS_ROUTES.teams} sx={{ fontWeight: 700 }}>
            {t("settings_team_back_to_teams")}
          </Link>
        </Box>
      </SettingsPage>
    );
  }
  if (!team) {
    return (
      <SettingsPage
        header={
          // While the team loads: the path and the head's placeholder, where
          // the loaded heading will be.
          <Stack spacing={4}>
            {path}
            {!(isError && !isLoading) && (
              <Box
                role="status"
                aria-busy="true"
                aria-label={t("settings_nav_loading")}
                sx={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
                <Skeleton
                  variant="rounded"
                  width={56}
                  height={56}
                  sx={{ borderRadius: "14px", flexShrink: 0 }}
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Skeleton variant="text" width={200} height={36} />
                  <Skeleton variant="text" width="50%" />
                </Box>
              </Box>
            )}
          </Stack>
        }>
        {isError && !isLoading ? (
          <SettingsLoadError onRetry={() => void mutate()} />
        ) : (
          <>
            <CardSkeleton title={t("settings_team_members_title")} rows={2} variant="list" />
            <CardSkeleton title={profileTitle} rows={2} help footer />
          </>
        )}
      </SettingsPage>
    );
  }

  const refresh = () => Promise.all([mutate(), mutateTeams()]);
  // Teams opens without the team at once; the list is read again behind it.
  const backToTeams = () => {
    void mutateTeams((list) => list?.filter((other) => other.id !== teamId), { revalidate: true });
    router.push(SETTINGS_ROUTES.teams);
  };
  // The head sits on the page's background, not on a card.
  const ownerInk = readableText(theme, theme.palette.warning.main, theme.palette.background.default);
  const badge = permissions.isTeamOwner
    ? t("settings_team_you_own")
    : permissions.isMember
      ? t("settings_team_you_member")
      : null;

  return (
    <SettingsPage
      header={
        <Stack spacing={4}>
          {path}
          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 4 }}>
            <TeamAvatar name={team.name} src={team.avatar} size={56} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
                <Typography
                  component="h2"
                  sx={{
                    m: 0,
                    minWidth: 0,
                    overflowWrap: "anywhere",
                    fontSize: { xs: 21, md: 24 },
                    fontWeight: 600,
                    letterSpacing: "-0.3px",
                  }}>
                  {team.name}
                </Typography>
                {badge && (
                  <Box
                    component="span"
                    sx={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 1,
                      px: 2,
                      py: "2px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 700,
                      // The owner's amber in its shade that reads as text on the page (warning.main does not).
                      border: `1px solid ${permissions.isTeamOwner ? ownerInk : theme.palette.divider}`,
                      color: permissions.isTeamOwner ? ownerInk : "text.secondary",
                    }}>
                    {permissions.isTeamOwner && (
                      <Icon iconName={ICON_NAME.CROWN} style={{ fontSize: 11 }} htmlColor="inherit" />
                    )}
                    {badge}
                  </Box>
                )}
              </Box>
              <Typography
                variant="body2"
                sx={{
                  mt: 1,
                  overflowWrap: "anywhere",
                  color: team.description ? "text.secondary" : "text.disabled",
                  fontStyle: team.description ? "normal" : "italic",
                }}>
                {team.description || t("settings_team_no_description")}
              </Typography>
            </Box>
            {spaceHref && (
              <Button
                component={NextLink}
                href={spaceHref}
                variant="outlined"
                startIcon={<Icon iconName={ICON_NAME.FOLDER} style={{ fontSize: 14 }} htmlColor="inherit" />}
                sx={{ borderRadius: 999, whiteSpace: "nowrap" }}>
                {t("settings_team_space_link")}
              </Button>
            )}
          </Box>
        </Stack>
      }>
      <TeamMembersCard
        teamId={team.id}
        teamName={team.name}
        selfId={userProfile?.id}
        permissions={permissions}
      />
      {userProfile ? (
        <TeamProfileCard
          team={team}
          canEdit={permissions.canEditTeam}
          isTeamOwner={permissions.isTeamOwner}
          onSaved={refresh}
        />
      ) : profileError ? (
        <SettingsCard title={profileTitle}>
          <SettingsLoadError onRetry={() => void mutateProfile()} />
        </SettingsCard>
      ) : (
        <CardSkeleton title={profileTitle} rows={2} help footer />
      )}
      {userProfile && permissions.canEditTeam && (
        <DangerCard
          title={t("settings_team_delete_title")}
          text={t("settings_team_delete_text")}
          buttonLabel={t("settings_team_delete_confirm")}
          onClick={() => setDeleting(true)}
        />
      )}
      {userProfile && permissions.canLeave && (
        <DangerCard
          title={t("settings_team_leave_title")}
          text={t("settings_team_leave_text")}
          buttonLabel={t("settings_team_leave_confirm")}
          icon={ICON_NAME.SIGNOUT}
          onClick={() => setLeaving(true)}
        />
      )}
      {deleting && (
        <DeleteTeamDialog
          teamId={team.id}
          teamName={team.name}
          spaceHref={spaceHref}
          onClose={() => setDeleting(false)}
          onDeleted={backToTeams}
        />
      )}
      {leaving && userProfile && (
        <LeaveTeamDialog
          teamId={team.id}
          teamName={team.name}
          selfId={userProfile.id}
          onClose={() => setLeaving(false)}
          onLeft={backToTeams}
        />
      )}
    </SettingsPage>
  );
}
