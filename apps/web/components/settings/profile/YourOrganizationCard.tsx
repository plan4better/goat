"use client";

import { Box, Link, Skeleton, Typography } from "@mui/material";
import NextLink from "next/link";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useTeams } from "@/lib/api/teams";
import { useOrganization, useUserProfile } from "@/lib/api/users";
import { SETTINGS_ROUTES } from "@/lib/settingsRoutes";

import UserAvatar from "@/components/dashboard/common/UserAvatar";
import CardSkeleton from "@/components/settings/common/CardSkeleton";
import SettingsCard from "@/components/settings/common/SettingsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import { orgRoleOf, roleWords } from "@/components/settings/common/roleWords";

const Term = ({ children }: { children: ReactNode }) => (
  <Typography component="dt" variant="body2" sx={{ fontWeight: 700, color: "text.secondary" }}>
    {children}
  </Typography>
);
const Detail = ({ children }: { children: ReactNode }) => (
  <Typography component="dd" variant="body2" sx={{ m: 0, mb: { xs: 3, md: 0 } }}>
    {children}
  </Typography>
);

/** Ihre Organisation: the organization, one's role with its line, one's teams. Read-only. */
export default function YourOrganizationCard() {
  const { t, i18n } = useTranslation("common");
  const { userProfile, isError: profileError, mutate: mutateProfile } = useUserProfile();
  const { organization, isError: organizationError, mutate: mutateOrganization } = useOrganization();
  const { teams, isLoading: teamsLoading, isError: teamsError, mutate: mutateTeams } = useTeams();
  const title = t("settings_profile_org_title");
  const hint = t("settings_profile_org_hint");

  // An error counts only where its record is missing: SWR keeps the data and
  // sets the error when a later read fails (focus, reconnect).
  if ((!userProfile && profileError) || (!organization && organizationError)) {
    return (
      <SettingsCard title={title} hint={hint}>
        <SettingsLoadError
          onRetry={() => {
            if (profileError) void mutateProfile();
            if (organizationError) void mutateOrganization();
            if (teamsError) void mutateTeams();
          }}
        />
      </SettingsCard>
    );
  }
  if (!userProfile || !organization) return <CardSkeleton title={title} hint={hint} rows={3} />;

  const role = orgRoleOf(userProfile.roles);
  const words = roleWords(t);
  const collator = new Intl.Collator(i18n.language);
  const teamNames = teams.map((team) => team.name).sort(collator.compare);
  // `teams` is `[]` until the list arrives (as on the Teams page): a list that
  // never came leaves its row out rather than say "Noch in keinem Team".
  const teamsMissing = Boolean(teamsError) && teams.length === 0;

  return (
    <SettingsCard title={title} hint={hint}>
      <Box
        component="dl"
        sx={{
          m: 0,
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "160px minmax(0, 1fr)" },
          columnGap: 6,
          rowGap: { xs: 1, md: 4 },
        }}>
        <Term>{t("settings_profile_org_label")}</Term>
        <Detail>
          <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <UserAvatar id={organization.id} name={organization.name} src={organization.avatar} size={24} />
            {organization.name}
          </Box>
        </Detail>
        <Term>{t("settings_profile_role_label")}</Term>
        <Detail>
          {role && (
            <>
              <Box component="strong">{words[role].word}</Box>
              <Box component="span" sx={{ display: "block", color: "text.secondary" }}>
                {words[role].description}
              </Box>
            </>
          )}
        </Detail>
        {!teamsMissing && (
          <>
            <Term>{t("settings_profile_teams_label")}</Term>
            <Detail>
              {teamsLoading ? (
                <Skeleton variant="text" width={200} />
              ) : teamNames.length ? (
                teamNames.join(", ")
              ) : (
                t("settings_profile_no_teams")
              )}{" "}
              <Link
                component={NextLink}
                href={SETTINGS_ROUTES.teams}
                underline="hover"
                sx={{ fontWeight: 700 }}>
                {t("settings_profile_open_teams")}
              </Link>
            </Detail>
          </>
        )}
      </Box>
    </SettingsCard>
  );
}
