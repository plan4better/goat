"use client";

import { Box, ButtonBase, Stack, Typography, alpha, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { FetchSource } from "@/hooks/addLayer/useFetchFlow";

export type ConnectKind = "service" | FetchSource;

type ConnectOption = { kind: ConnectKind; icon: ICON_NAME; titleKey: string; subtitleKey: string };

/** GOAT's own sources first, then the services a user connects to themselves. */
const GROUPS: { labelKey: string; options: ConnectOption[] }[] = [
  {
    labelKey: "connect_group_goat",
    options: [
      {
        kind: "osm",
        icon: ICON_NAME.OSM,
        titleKey: "fetch_features_source_osm",
        subtitleKey: "fetch_features_source_osm_hint",
      },
      {
        kind: "overture",
        icon: ICON_NAME.OVERTURE,
        titleKey: "fetch_features_source_overture",
        subtitleKey: "fetch_features_source_overture_hint",
      },
      {
        kind: "street_network",
        icon: ICON_NAME.ROAD_NETWORK,
        titleKey: "fetch_features_source_street_network",
        subtitleKey: "fetch_features_source_street_network_hint",
      },
      // The public transport network ("pt_network") is not offered yet: no server has the
      // tables it is cut from until a public transport version with them is published.
    ],
  },
  {
    labelKey: "connect_group_services",
    options: [
      {
        kind: "service",
        icon: ICON_NAME.GLOBE,
        titleKey: "connect_data_ogc",
        subtitleKey: "connect_data_ogc_hint",
      },
    ],
  },
];

/** What Connect data can connect, always beside whatever the chosen one shows. */
export const ConnectRail = ({
  kind,
  onPick,
  kinds,
}: {
  kind: ConnectKind;
  onPick: (kind: ConnectKind) => void;
  /** Only these entries, e.g. a workflow's; all when absent. */
  kinds?: ConnectKind[];
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const groups = GROUPS.map((group) => ({
    ...group,
    options: group.options.filter((option) => !kinds || kinds.includes(option.kind)),
  })).filter((group) => group.options.length > 0);
  return (
    <Stack
      component="nav"
      spacing={4}
      sx={{
        width: { xs: "100%", md: 248 },
        flexShrink: 0,
        p: 3,
        borderRight: { md: `1px solid ${theme.palette.divider}` },
        borderBottom: { xs: `1px solid ${theme.palette.divider}`, md: "none" },
      }}>
      {groups.map((group) => (
        <Stack key={group.labelKey} spacing={1}>
          <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ px: 2 }}>
            {t(group.labelKey)}
          </Typography>
          {group.options.map((option) => {
            const on = option.kind === kind;
            return (
              <ButtonBase
                key={option.kind}
                aria-current={on}
                onClick={() => onPick(option.kind)}
                sx={{
                  justifyContent: "flex-start",
                  gap: 2.5,
                  p: 2,
                  borderRadius: 2,
                  textAlign: "left",
                  // The row says which is open; only its icon carries the brand colour.
                  backgroundColor: on ? theme.palette.action.selected : "transparent",
                  "&:hover": {
                    backgroundColor: on ? theme.palette.action.selected : theme.palette.action.hover,
                  },
                }}>
                <Box
                  sx={{
                    width: 30,
                    height: 30,
                    flexShrink: 0,
                    borderRadius: 2,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: on ? theme.palette.primary.main : theme.palette.text.secondary,
                    backgroundColor: on
                      ? alpha(theme.palette.primary.main, 0.14)
                      : theme.palette.action.hover,
                  }}>
                  <Icon iconName={option.icon} style={{ fontSize: 17 }} htmlColor="currentColor" />
                </Box>
                <Stack sx={{ minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={700}>
                    {t(option.titleKey)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {t(option.subtitleKey)}
                  </Typography>
                </Stack>
              </ButtonBase>
            );
          })}
        </Stack>
      ))}
    </Stack>
  );
};
