"use client";

import { Box, Stack, useTheme } from "@mui/material";

import { type ICON_NAME, Icon } from "@p4b/ui/components/Icon";

/** The segmented choice of how an area is picked; the caller says which modes it offers. */
const SpatialModeSwitch = <Id extends string>({
  modes,
  value,
  onChange,
}: {
  modes: { id: Id; label: string; icon: ICON_NAME }[];
  value: Id;
  onChange: (mode: Id) => void;
}) => {
  const theme = useTheme();
  return (
    <Stack
      direction="row"
      role="radiogroup"
      sx={{
        mt: 1.5,
        borderRadius: 2.5,
        overflow: "hidden",
        border: `1.5px solid ${theme.palette.primary.main}`,
      }}>
      {modes.map((mode, index) => (
        <Box
          key={mode.id}
          component="button"
          type="button"
          role="radio"
          aria-checked={mode.id === value}
          onClick={() => onChange(mode.id)}
          sx={{
            flex: 1,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 2.5,
            py: 3,
            px: 2.5,
            cursor: "pointer",
            font: "inherit",
            fontSize: 14,
            fontWeight: 600,
            border: "none",
            borderLeft: index > 0 ? `1.5px solid ${theme.palette.primary.main}` : undefined,
            color: theme.palette.primary.main,
            backgroundColor: mode.id === value ? theme.palette.action.selected : "transparent",
          }}>
          <Icon iconName={mode.icon} style={{ fontSize: 15 }} htmlColor={theme.palette.primary.main} />
          {mode.label}
        </Box>
      ))}
    </Stack>
  );
};

export default SpatialModeSwitch;
