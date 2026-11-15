"use client";

import { Box, Typography, useTheme } from "@mui/material";
import NextLink from "next/link";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { settingsTeamPath } from "@/lib/settingsRoutes";
import type { Team } from "@/lib/validations/team";

import { focusRing } from "@/components/assistant/styles";
import SurfaceCard from "@/components/dashboard/common/SurfaceCard";
import UserAvatar from "@/components/dashboard/common/UserAvatar";
import { warningTextInk } from "@/components/modals/content/ContentDialogChrome";
import { personName } from "@/components/settings/common/personName";
import TeamAvatar from "@/components/settings/teams/TeamAvatar";
import { isOwnerless } from "@/components/settings/teams/teamName";

const PLAIN = { interpolation: { escapeValue: false } } as const;

const Badge = ({ label, owner = false }: { label: string; owner?: boolean }) => {
  const theme = useTheme();
  return (
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
        whiteSpace: "nowrap",
        // The owner's amber in its shade that reads as text on the card (warning.main does not).
        border: `1px solid ${owner ? warningTextInk(theme) : theme.palette.divider}`,
        color: owner ? warningTextInk(theme) : "text.secondary",
      }}>
      {owner && <Icon iconName={ICON_NAME.CROWN} style={{ fontSize: 11 }} htmlColor="inherit" />}
      {label}
    </Box>
  );
};

/** A team as a card that opens its page. The faces (owner first, at most four)
 * and the count come with the list (core's `members_preview`, `member_count`),
 * so no card reads its members. `adminView` (owners and admins, who see every
 * team) adds the badge of a team without an owner. */
export default function TeamCard({ team, adminView = false }: { team: Team; adminView?: boolean }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const faces = team.members_preview ?? [];
  // An answer without the count (an older core) leaves it out rather than
  // saying "0 members".
  const counted = team.member_count !== undefined;
  const ownerless = adminView && isOwnerless(team);
  const hasBadge = ownerless || !!team.role;
  // The link keeps the spec's name ("Team {Name} öffnen"); what the card
  // shows besides is its description.
  const id = useId();
  const describedBy = [`${id}-description`, counted && `${id}-count`, hasBadge && `${id}-badge`]
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
        {counted && (
          <Typography id={`${id}-count`} variant="caption" color="text.secondary">
            {t("settings_teams_member_count", { count: team.member_count })}
          </Typography>
        )}
        {hasBadge && (
          <Box
            id={`${id}-badge`}
            sx={{ ml: "auto", display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 1 }}>
            {ownerless && <Badge label={t("settings_teams_badge_ownerless")} />}
            {team.role && (
              <Badge
                owner={team.role === "team-owner"}
                label={t(
                  team.role === "team-owner" ? "settings_teams_badge_owner" : "settings_teams_badge_member"
                )}
              />
            )}
          </Box>
        )}
      </Box>
    </SurfaceCard>
  );
}
