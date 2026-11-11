import { type Theme, alpha } from "@mui/material";

import { readableText, solidOn } from "@/lib/utils/credits";

/**
 * How the app's navigation marks where you are (the rail, the phone menu): a
 * soft tint of the primary colour, and the primary colour as ink that reads
 * on that tint. One recipe, so the two never drift apart.
 */
export const currentPlaceColors = (theme: Theme): { fill: string; ink: string } => {
  const fill = alpha(theme.palette.primary.main, 0.2);
  return {
    fill,
    ink: readableText(theme, theme.palette.primary.main, solidOn(fill, theme.palette.background.paper)),
  };
};

/** The primary colour as ink on a selected row's neutral fill (Content's and
 * the settings' left menus): the theme's green alone is too faint as text. */
export const selectedRowInk = (theme: Theme): string =>
  readableText(
    theme,
    theme.palette.primary.main,
    solidOn(theme.palette.action.selected, theme.palette.background.paper)
  );
