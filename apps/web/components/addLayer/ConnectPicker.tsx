"use client";

import { Box, ButtonBase, Stack, Typography, alpha, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { FetchSource } from "@/hooks/addLayer/useFetchFlow";

export type ConnectKind = "service" | FetchSource;

type ConnectOption = { kind: ConnectKind; icon: ICON_NAME; titleKey: string };

/** GOAT's own sources first, then the services a user connects to themselves. */
const GROUPS: { labelKey: string; options: ConnectOption[] }[] = [
  {
    labelKey: "connect_group_goat",
    options: [
      {
        kind: "street_network",
        icon: ICON_NAME.STREET_NETWORK,
        titleKey: "fetch_features_source_street_network",
      },
      {
        kind: "osm",
        icon: ICON_NAME.MAP_LOCATION,
        titleKey: "fetch_features_source_osm",
      },
      {
        kind: "overture",
        icon: ICON_NAME.MAP,
        titleKey: "fetch_features_source_overture",
      },
    ],
  },
  {
    labelKey: "connect_group_services",
    options: [
      {
        kind: "service",
        icon: ICON_NAME.GLOBE,
        titleKey: "connect_data_ogc",
      },
    ],
  },
];

/** What Connect service can connect, always beside whatever the chosen one shows. */
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
      spacing={3}
      sx={{
        width: { xs: "100%", md: 220 },
        flexShrink: 0,
        p: 3,
        borderRight: { md: `1px solid ${theme.palette.divider}` },
        borderBottom: { xs: `1px solid ${theme.palette.divider}`, md: "none" },
      }}>
      {groups.map((group) => (
        <Stack key={group.labelKey} spacing={1}>
          <Typography
            variant="caption"
            fontWeight={700}
            color="text.secondary"
            sx={{ px: 2, textTransform: "uppercase", letterSpacing: "0.07em" }}>
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
                  backgroundColor: on ? alpha(theme.palette.primary.main, 0.12) : "transparent",
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
                    color: on ? theme.palette.common.white : theme.palette.text.secondary,
                    backgroundColor: on ? theme.palette.primary.main : theme.palette.action.hover,
                  }}>
                  <Icon iconName={option.icon} style={{ fontSize: 14 }} htmlColor="currentColor" />
                </Box>
                <Typography variant="body2" fontWeight={700}>
                  {t(option.titleKey)}
                </Typography>
              </ButtonBase>
            );
          })}
        </Stack>
      ))}
    </Stack>
  );
};
