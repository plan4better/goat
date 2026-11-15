"use client";

import { Box, alpha, useTheme } from "@mui/material";

import { type ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { toneColorOf } from "@/lib/catalog/kind";

/** The tones of {@link UsageMark}: `neutral` is the grey `MarkBlock` gives tables. */
const MARK_TONE = { primary: "primary", info: "info", neutral: "secondary" } as const;

/** The 32px tinted square for rows MarkBlock has no kind for (workflow, tool, period, public pages):
 * same size, corner and tint as MarkBlock (tone at alpha 0.12, glyph in the tone). On its own so a page
 * that needs only the mark (KI, Analytics) does not load the Usage list. */
export const UsageMark = ({ icon, tone }: { icon: ICON_NAME; tone: "primary" | "info" | "neutral" }) => {
  const theme = useTheme();
  const color = toneColorOf(theme, MARK_TONE[tone]);
  return (
    <Box
      aria-hidden
      sx={{
        width: 32,
        height: 32,
        flexShrink: 0,
        borderRadius: "8px",
        backgroundColor: alpha(color, 0.12),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
      <Icon iconName={icon} style={{ fontSize: 16 }} htmlColor={color} />
    </Box>
  );
};
