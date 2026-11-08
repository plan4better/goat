"use client";

import { Box, Skeleton, Typography, useTheme } from "@mui/material";
import NextLink from "next/link";
import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useTeamMembers } from "@/lib/api/teams";
import { settingsTeamPath } from "@/lib/settingsRoutes";
import type { Team } from "@/lib/validations/team";

import { focusRing } from "@/components/assistant/styles";
import SurfaceCard from "@/components/dashboard/common/SurfaceCard";
import UserAvatar from "@/components/dashboard/common/UserAvatar";
import { warningTextInk } from "@/components/modals/content/ContentDialogChrome";
import { personName } from "@/components/settings/common/personName";
import TeamAvatar from "@/components/settings/teams/TeamAvatar";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** A team as a card that opens its page. Phase 1 reads the faces and the count
 * per card (`GET /teams/{id}/members`, the key the team page uses too). */
export default function TeamCard({ team }: { team: Team }) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const { teamMembers, isLoading, isError } = useTeamMembers(team.id);
  // A failed read leaves the faces and the count out rather than saying
  // "0 members": the card is a link, so a retry button cannot sit in it, and
  // SWR retries the read on its own.
  const failed = !!isError && teamMembers.length === 0;
  const collator = useMemo(() => new Intl.Collator(i18n.language), [i18n.language]);
  const faces = [...teamMembers]
    .sort((a, b) =>
      a.role === b.role ? collator.compare(personName(a), personName(b)) : a.role === "team-owner" ? -1 : 1
    )
    .slice(0, 4);
  const owner = team.role === "team-owner";
  // The link keeps the spec's name ("Team {Name} öffnen"); what the card
  // shows besides is its description.
  const id = useId();
  const describedBy = [`${id}-description`, !failed && `${id}-count`, team.role && `${id}-badge`]
    .filter(Boolean)
    .join(" ");

  return (
    <SurfaceCard
      component={NextLink}
      {...{ href: settingsTeamPath(team.id) }}
      aria-label={t("settings_teams_open", { name: team.name, ...PLAIN })}
      aria-describedby={describedBy}
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        p: 4,
        color: "text.primary",
        textDecoration: "none",
        ...focusRing(theme),
      }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 3 }}>
        <TeamAvatar name={team.name} src={team.avatar} />
        <Box sx={{ minWidth: 0 }}>
          <Typography noWrap sx={{ fontWeight: 600 }}>
            {team.name}
          </Typography>
          <Typography
            id={`${id}-description`}
            variant="body2"
            sx={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              color: team.description ? "text.secondary" : "text.disabled",
              fontStyle: team.description ? "normal" : "italic",
            }}>
            {team.description || t("settings_teams_no_description")}
          </Typography>
        </Box>
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mt: "auto", minHeight: 22 }}>
        <Box sx={{ display: "flex" }} aria-hidden>
          {faces.map((face, index) => (
            <UserAvatar
              key={face.id}
              id={face.id}
              name={personName(face)}
              src={face.avatar}
              size={22}
              sx={{ ml: index ? "-6px" : 0, border: `2px solid ${theme.palette.background.paper}` }}
            />
          ))}
        </Box>
        {!failed && (
          <Typography id={`${id}-count`} variant="caption" color="text.secondary">
            {isLoading ? (
              <Skeleton variant="text" width={60} />
            ) : (
              t("settings_teams_member_count", { count: teamMembers.length })
            )}
          </Typography>
        )}
        {team.role && (
          <Box
            id={`${id}-badge`}
            component="span"
            sx={{
              ml: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 1,
              px: 2,
              py: "2px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 700,
              // The owner's amber in its shade that reads as text on the card (warning.main does not).
              border: `1px solid ${owner ? warningTextInk(theme) : theme.palette.divider}`,
              color: owner ? warningTextInk(theme) : "text.secondary",
            }}>
            {owner && <Icon iconName={ICON_NAME.CROWN} style={{ fontSize: 11 }} htmlColor="inherit" />}
            {t(owner ? "settings_teams_badge_owner" : "settings_teams_badge_member")}
          </Box>
        )}
      </Box>
    </SurfaceCard>
  );
}
