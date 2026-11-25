"use client";

import { Box, Stack, Typography, useTheme } from "@mui/material";
import type { ReactNode } from "react";

import type { ICON_NAME } from "@p4b/ui/components/Icon";

import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";

/**
 * A dialog that is a settings column beside a map (Connect data's open data) draws the column
 * from the tool panels' own parts, so it reads as a tool does.
 */

/** One height for the body of a dialog with a map (also the catalog's spatial filter), so
 * changing what is chosen never resizes it. */
export const SETTINGS_PANE_HEIGHT = { md: "min(680px, calc(100vh - 210px))" };

/** The column beside the map: a fixed width that scrolls on its own, ruled off from the map. */
export const SettingsColumn = ({ children }: { children: ReactNode }) => {
  const theme = useTheme();
  return (
    <Box
      sx={{
        width: { xs: "100%", md: 400 },
        flexShrink: 0,
        overflowY: "auto",
        borderRight: { md: `1px solid ${theme.palette.divider}` },
      }}>
      <Stack spacing={1} sx={{ px: 4, py: 3 }}>
        {children}
      </Stack>
    </Box>
  );
};

/**
 * A section of the settings column, drawn as a tool's section is: so the column can move into
 * the toolbox as it is.
 */
export const SettingsSection = ({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ICON_NAME;
  children: ReactNode;
}) => (
  <Box>
    <SectionHeader label={label} icon={icon} active alwaysActive disableAdvanceOptions />
    <SectionOptions active baseOptions={<Stack spacing={3}>{children}</Stack>} />
  </Box>
);

/** A small grey label over a control, as the tool panels label theirs. */
export const FieldLabel = ({ children }: { children: ReactNode }) => (
  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
    {children}
  </Typography>
);
