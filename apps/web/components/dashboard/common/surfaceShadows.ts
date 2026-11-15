import type { Theme } from "@mui/material";

import { liftedShadow } from "@p4b/ui/theme/popoverSurface";

/**
 * The one elevation recipe every dashboard surface (Home bands, Content and
 * Catalog cards and rows, side panels, search fields) rests on: a single soft
 * 10px blur at low opacity, so a surface reads as sitting on the page rather
 * than as a hard edge under it. Hover keeps the same recipe, only deeper and
 * a touch further away, so lifting a card continues its resting shadow instead
 * of switching to a different one. It is the shadow popovers float on too.
 */
export const surfaceShadows = (theme: Theme): { rest: string; hover: string } => {
  return { rest: theme.shadows[6], hover: liftedShadow(theme) };
};
