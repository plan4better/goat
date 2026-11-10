"use client";

import { Box, Stack, type Theme } from "@mui/material";
import type { ReactNode } from "react";

/** A page's primary button (the heading's action, the empty state's):
 * Content's "Neu" (`ContentAddMenu.tsx`), 38px high, 700 weight, the small
 * shadow at rest and on hover. Its icon is 16px. */
export const pageActionSx = {
  height: 38,
  px: "18px",
  borderRadius: "999px",
  fontSize: 14,
  fontWeight: 700,
  textTransform: "none",
  whiteSpace: "nowrap",
  flexShrink: 0,
  boxShadow: (theme: Theme) => theme.shadows[1],
  "&:hover": { boxShadow: (theme: Theme) => theme.shadows[1] },
} as const;

/**
 * The frame of every settings page: its heading first and then its cards 16px
 * apart. It scrolls with the layout's area (the title scrolls away, the nav
 * stays), as settings areas usually do and as Home and Catalog scroll.
 * Content's feed padding, with the top set so the heading lines up with the
 * nav card.
 */
export default function SettingsPage({
  header,
  children,
}: {
  /** The page's heading: a level 2 `PageHeader`, or a page's own (a team). */
  header?: ReactNode;
  /** The cards, notices and dialogs of the page. */
  children?: ReactNode;
}) {
  return (
    <Box sx={{ flex: 1, padding: { xs: "8px 14px 90px", md: "18px 40px 40px" } }}>
      <Stack spacing={4}>
        {header}
        {children}
      </Stack>
    </Box>
  );
}
