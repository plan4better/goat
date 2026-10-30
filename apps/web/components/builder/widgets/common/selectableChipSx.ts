import type { Theme } from "@mui/material/styles";

/**
 * A chip a dashboard viewer picks: a quiet pill until selected, then filled
 * with the widget's colour. Shared by the chips filter and the layer switcher.
 */
export const selectableChipSx = (theme: Theme, selected: boolean, color: string) => ({
  borderRadius: 4,
  fontStyle: "normal",
  fontWeight: selected ? 600 : 400,
  backgroundColor: selected ? color : theme.palette.action.hover,
  color: selected ? theme.palette.getContrastText(color) : theme.palette.text.primary,
  borderColor: selected ? color : theme.palette.divider,
  "&:hover": {
    backgroundColor: selected ? color : theme.palette.action.selected,
    filter: selected ? "brightness(0.9)" : "none",
  },
  transition: "all 0.15s ease-in-out",
});
