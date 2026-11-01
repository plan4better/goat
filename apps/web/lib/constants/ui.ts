import type { Theme } from "@mui/material/styles";

/** Accent of data widgets (filters, charts, numbers) when the builder has not picked one. */
export const DEFAULT_WIDGET_COLOR = "#0e58ff";

/** Border of the clickable picker fields (colour, marker, scale), matching an outlined input. */
export const pickerBorderColor = (theme: Theme) => (theme.palette.mode === "dark" ? "#464B59" : "#CBCBD1");

/** Hover border of the same picker fields. */
export const pickerBorderHoverColor = (theme: Theme) =>
  theme.palette.mode === "dark" ? "#5B5F6E" : "#B8B7BF";
