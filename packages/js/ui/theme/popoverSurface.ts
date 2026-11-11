import type { Theme } from "@mui/material/styles";

/** The shadow of a surface lifted off the page: one soft, wide blur. */
export const liftedShadow = (theme: Theme): string => {
  const ink = theme.palette.mode === "light" ? "58, 53, 65" : "19, 17, 32";
  return `0px 6px 20px 0px rgba(${ink}, 0.16)`;
};

/** The space between a trigger and what it opens, in px. */
export const POPOVER_GAP = 6;

/**
 * The card everything that opens from a trigger is drawn on (menus, popovers,
 * the dropdowns of selects and autocompletes): rounded, a hairline border and
 * a soft shadow. The theme applies it to MUI's own popups; a hand-built one
 * spreads it into its paper.
 */
export const popoverSurface = (
  theme: Theme
): { borderRadius: string; border: string; boxShadow: string } => ({
  borderRadius: "12px",
  border: `1px solid ${theme.palette.divider}`,
  boxShadow: liftedShadow(theme),
});
