"use client";

import { Paper, useTheme } from "@mui/material";
import type { PaperProps } from "@mui/material";

import { popoverSurface } from "@p4b/ui/theme/popoverSurface";

/**
 * The card of a hand-built popup (one opened with `ArrowPopper` or a bare
 * `Popper`): the surface the theme gives MUI's own menus and popovers.
 */
const PopoverPaper = ({ sx, ...rest }: Omit<PaperProps, "elevation" | "variant">) => {
  const theme = useTheme();
  return (
    <Paper
      elevation={0}
      sx={[{ ...popoverSurface(theme), overflow: "hidden" }, ...(Array.isArray(sx) ? sx : [sx])]}
      {...rest}
    />
  );
};

export default PopoverPaper;
