"use client";

import { Box, ButtonBase, Stack, Typography, alpha, useTheme } from "@mui/material";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { focusRing } from "@/components/assistant/styles";

/** A choice as one pill of segments, the one in force filled, as the content
 * page's layout toggle. `label` defaults to "Group by"; null shows none, and
 * `ariaLabel` names the group instead (Teams: "Teams filtern"). */
export const GroupToggle = <G extends string>({
  value,
  options,
  onChange,
  label,
  ariaLabel,
}: {
  value: G;
  options: { key: G; label: string }[];
  onChange: (key: G) => void;
  label?: string | null;
  ariaLabel?: string;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const labelId = useId();
  const shown = label === undefined ? t("group_by") : label;
  return (
    <Stack direction="row" alignItems="center" useFlexGap flexWrap="wrap" gap="10px">
      {shown && (
        <Typography id={labelId} sx={{ fontSize: 13, fontWeight: 600, color: "text.secondary" }}>
          {shown}
        </Typography>
      )}
      <Box
        role="group"
        aria-labelledby={shown ? labelId : undefined}
        aria-label={shown ? undefined : ariaLabel}
        sx={{
          display: "inline-flex",
          flexWrap: "wrap",
          gap: "2px",
          p: "3px",
          borderRadius: "999px",
          border: `1px solid ${theme.palette.divider}`,
          backgroundColor: theme.palette.background.paper,
        }}>
        {options.map((option) => {
          const on = option.key === value;
          return (
            <ButtonBase
              key={option.key}
              aria-pressed={on}
              onClick={() => onChange(option.key)}
              sx={{
                // The app's font: a bare button would fall back to the browser's.
                fontFamily: "inherit",
                height: 32,
                px: "14px",
                borderRadius: "999px",
                fontSize: 13.5,
                fontWeight: 600,
                backgroundColor: on ? alpha(theme.palette.primary.main, 0.12) : "transparent",
                color: on ? theme.palette.primary.main : theme.palette.text.primary,
                ...focusRing(theme),
              }}>
              {option.label}
            </ButtonBase>
          );
        })}
      </Box>
    </Stack>
  );
};
