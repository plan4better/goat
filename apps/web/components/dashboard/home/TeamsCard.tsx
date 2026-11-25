"use client";

import { Box, Button, Typography, useTheme } from "@mui/material";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useSpaces } from "@/lib/api/content";
import { useTeams } from "@/lib/api/teams";
import { SETTINGS_ROUTES } from "@/lib/settingsRoutes";
import type { Space } from "@/lib/validations/content";
import type { Team } from "@/lib/validations/team";

import { contentPath } from "@/hooks/dashboard/content/useContentPageState";

import SurfaceCard from "@/components/dashboard/common/SurfaceCard";
import HomeSection from "@/components/dashboard/home/HomeSection";

/** H6: the caller's teams, each linking into that team's space on Content.
 * A team whose space cannot be resolved is skipped rather than rendered as a
 * dead link. Renders nothing when the caller has no teams; `HomePage`
 * decides whether this band exists at all (Getting started stage on). */
const TeamsCard = () => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const router = useRouter();

  const { teams } = useTeams();
  const { spaces } = useSpaces();

  const spaceFor = (team: Team): Space | undefined => spaces.find((space) => space.team_id === team.id);
  const rows = teams
    .map((team) => ({ team, space: spaceFor(team) }))
    .filter((row): row is { team: Team; space: Space } => row.space !== undefined);

  if (rows.length === 0) return null;

  return (
    <HomeSection
      title={t("your_teams")}
      action={
        <Button
          variant="text"
          size="small"
          endIcon={<Icon iconName={ICON_NAME.CHEVRON_RIGHT} style={{ fontSize: 12 }} />}
          onClick={() => router.push(SETTINGS_ROUTES.teams)}
          sx={{ borderRadius: 0 }}>
          {`${t("all_teams")} · ${teams.length}`}
        </Button>
      }>
      <SurfaceCard hoverable={false} sx={{ p: "6px" }}>
        {rows.map(({ team, space }) => (
          <Box
            key={team.id}
            onClick={() => router.push(contentPath({ spaceId: space.id }))}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "8px 10px",
              borderRadius: "8px",
              cursor: "pointer",
              "&:hover": { backgroundColor: theme.palette.action.hover },
            }}>
            <Icon
              iconName={ICON_NAME.USERS}
              style={{ fontSize: 14 }}
              htmlColor={theme.palette.text.secondary}
            />
            <Typography component="div" noWrap sx={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600 }}>
              {team.name}
            </Typography>
            <Icon
              iconName={ICON_NAME.CHEVRON_RIGHT}
              style={{ fontSize: 11 }}
              htmlColor={theme.palette.text.secondary}
            />
          </Box>
        ))}
      </SurfaceCard>
    </HomeSection>
  );
};

export default TeamsCard;
