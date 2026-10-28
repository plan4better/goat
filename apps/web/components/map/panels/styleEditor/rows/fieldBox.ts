// The tool forms' field metrics (TextFieldInput, Selector): 40 px high, 14 px text, 12 px inside the left edge. The
// panel's own fields (the value that opens an editor, the color box) use them so every field in a row list matches.
import { type SxProps, type Theme, alpha } from "@mui/material";

export const FIELD_HEIGHT = 40;

/** The theme's outline of a field at rest and under the pointer (its OutlinedInput override): the text color at 22 and
 * 32 %. */
export const fieldOutline = (theme: Theme, hover?: boolean) =>
  alpha(theme.palette.text.primary, hover ? 0.32 : 0.22);

/** The outline of a focused field (MUI's OutlinedInput). */
export const FOCUSED_OUTLINE = { borderColor: "primary.main", borderWidth: 2 } as const;

/** The keyboard focus ring of a field that opens an editor: as wide as the open outline but in the text color, so a
 * focused field does not read as open. */
export const focusRing = (theme: Theme) => ({
  borderColor: alpha(theme.palette.text.primary, 0.6),
  borderWidth: 2,
});

/** For an `OutlinedInput` or `Select` root (size "small"). */
export const fieldSx: SxProps<Theme> = {
  height: FIELD_HEIGHT,
  minWidth: 0,
  fontSize: "0.875rem",
  "& .MuiInputBase-input": { py: 0, pl: 3, pr: 1 },
  "& .MuiSelect-select": {
    display: "flex",
    alignItems: "center",
    gap: 2,
    minWidth: "0 !important",
    py: 0,
    pl: 3,
  },
  "& .MuiInputAdornment-root": { color: "text.secondary" },
};
