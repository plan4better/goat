"use client";

import { Box, Button, Stack, Typography } from "@mui/material";
import { type ReactNode, useId } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import SettingsCard from "@/components/settings/common/SettingsCard";

/** A destructive action as a card of its own; the confirmation is the page's dialog. */
export default function DangerCard({
  title,
  text,
  buttonLabel,
  icon = ICON_NAME.TRASH,
  onClick,
  disabledReason,
}: {
  title: string;
  text: ReactNode;
  buttonLabel: string;
  icon?: ICON_NAME;
  onClick: () => void;
  /** The caller may not: the button is disabled and this says why. */
  disabledReason?: string;
}) {
  const reasonId = useId();
  return (
    <SettingsCard title={title} tone="danger">
      <Stack direction={{ xs: "column", sm: "row" }} spacing={4} alignItems={{ xs: "stretch", sm: "center" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" component="div">
            {text}
          </Typography>
          {disabledReason && (
            <Typography id={reasonId} variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {disabledReason}
            </Typography>
          )}
        </Box>
        <Button
          variant="outlined"
          color="error"
          startIcon={<Icon iconName={icon} style={{ fontSize: 14 }} htmlColor="inherit" />}
          onClick={onClick}
          disabled={!!disabledReason}
          aria-describedby={disabledReason ? reasonId : undefined}
          sx={{ flexShrink: 0, borderRadius: 999 }}>
          {buttonLabel}
        </Button>
      </Stack>
    </SettingsCard>
  );
}
