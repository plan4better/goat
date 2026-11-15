"use client";

import { Box, Switch, Typography } from "@mui/material";
import type { ReactNode } from "react";

/** A setting that is on or off and saves at once (decision 15). */
export default function SwitchRow({
  id,
  label,
  line,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  line?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 4 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          component="label"
          htmlFor={id}
          id={`${id}-label`}
          variant="body2"
          fontWeight={700}
          sx={{ display: "block" }}>
          {label}
        </Typography>
        {line && (
          <Typography id={`${id}-line`} variant="body2" color="text.secondary">
            {line}
          </Typography>
        )}
      </Box>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        inputProps={{
          role: "switch",
          "aria-labelledby": `${id}-label`,
          ...(line ? { "aria-describedby": `${id}-line` } : {}),
        }}
      />
    </Box>
  );
}
