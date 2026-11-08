"use client";

import { Box, alpha, useTheme } from "@mui/material";
import type { Theme } from "@mui/material";
import type { ReactNode } from "react";

import { readableText, solidOn } from "@/lib/utils/credits";

export type StatusTone = "primary" | "info" | "success" | "warning" | "error" | "neutral";

/** How strongly a pill is tinted with its tone. */
const TINT = 0.12;

/** A pill's background: its tone at 12 %, over the card it sits on. */
export const statusTint = (theme: Theme, tone: StatusTone): string =>
  alpha(tone === "neutral" ? theme.palette.text.secondary : theme.palette[tone].main, TINT);

/** The ink of a status's label: the tone's nearest shade that reads at 4.5:1
 * on the pill's own tint (12px text), in both modes; neutral is the body
 * text, as the muted ink stays under that on a tint. */
export const statusInk = (theme: Theme, tone: StatusTone): string =>
  tone === "neutral"
    ? theme.palette.text.primary
    : readableText(
        theme,
        theme.palette[tone].main,
        solidOn(statusTint(theme, tone), theme.palette.background.paper)
      );

/**
 * A status as a small tinted pill with a dot: the shape the support pages
 * introduced for a ticket's status (`components/support/StatusChip.tsx`, which
 * renders through this one), for every status in GOAT: a domain's state, a
 * pending invitation, a connection's test. Its label is small text, so the
 * ink reaches 4.5:1 on the tint in every tone (`statusInk`).
 */
export default function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const theme = useTheme();
  const color = statusInk(theme, tone);
  const dot = tone === "neutral" ? theme.palette.text.secondary : color;
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        maxWidth: "100%",
        height: 22,
        px: "9px",
        borderRadius: "999px",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.2,
        lineHeight: 1,
        whiteSpace: "nowrap",
        color,
        backgroundColor: statusTint(theme, tone),
      }}>
      <Box
        component="span"
        aria-hidden
        sx={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, backgroundColor: dot }}
      />
      <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {children}
      </Box>
    </Box>
  );
}
