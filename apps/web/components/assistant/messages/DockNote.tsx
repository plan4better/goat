"use client";

import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import InfoOutlined from "@mui/icons-material/InfoOutlined";
import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import WarningAmberRounded from "@mui/icons-material/WarningAmberRounded";
import { Box, Stack, Typography, alpha } from "@mui/material";
import type { ReactNode } from "react";

import { CARD_RADIUS, mutedText } from "@/components/assistant/styles";

export type DockNoteTone = "neutral" | "info" | "warning" | "error";

const ICONS = {
  neutral: StopCircleOutlined,
  info: InfoOutlined,
  warning: WarningAmberRounded,
  error: ErrorOutlineRounded,
};

/**
 * A short note inside an answer: a caveat or how a run ended. Information,
 * warnings and errors sit in a tinted card like the prototype's caveat; a neutral note
 * ("Stopped.") is a plain line, since nothing went wrong.
 */
export default function DockNote({ tone, children }: { tone: DockNoteTone; children: ReactNode }) {
  const IconComponent = ICONS[tone];
  if (tone === "neutral") {
    return (
      <Stack direction="row" alignItems="center" gap="6px" role="status" sx={{ color: mutedText }}>
        <IconComponent sx={{ fontSize: 15, color: "inherit" }} />
        <Typography sx={{ fontSize: 12.5, color: "inherit" }}>{children}</Typography>
      </Stack>
    );
  }
  return (
    <Stack
      direction="row"
      alignItems="flex-start"
      gap="9px"
      role="alert"
      sx={(theme) => ({
        px: "12px",
        py: "10px",
        borderRadius: CARD_RADIUS,
        border: `1px solid ${alpha(theme.palette[tone].main, 0.4)}`,
        bgcolor: alpha(theme.palette[tone].main, 0.08),
      })}>
      <Box sx={{ display: "flex", flexShrink: 0, pt: "1px", color: `${tone}.main` }}>
        <IconComponent sx={{ fontSize: 16, color: "inherit" }} />
      </Box>
      <Typography sx={{ fontSize: 12.5, lineHeight: 1.5, color: "text.primary" }}>{children}</Typography>
    </Stack>
  );
}
