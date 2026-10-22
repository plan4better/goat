"use client";

import { Box, ButtonBase, Stack, Typography, alpha, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { FetchSource } from "@/hooks/addLayer/useFetchFlow";

export type ConnectKind = "service" | FetchSource;

const KINDS: { kind: ConnectKind; icon: ICON_NAME; titleKey: string }[] = [
  {
    kind: "service",
    icon: ICON_NAME.GLOBE,
    titleKey: "connect_data_ogc",
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
];

/** What Connect service can connect, always beside whatever the chosen one shows. */
export const ConnectRail = ({ kind, onPick }: { kind: ConnectKind; onPick: (kind: ConnectKind) => void }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Stack
      component="nav"
      spacing={1}
      sx={{
        width: { xs: "100%", md: 220 },
        flexShrink: 0,
        p: 3,
        borderRight: { md: `1px solid ${theme.palette.divider}` },
        borderBottom: { xs: `1px solid ${theme.palette.divider}`, md: "none" },
      }}>
      {KINDS.map((option) => {
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
  );
};
