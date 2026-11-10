import type { Theme } from "@mui/material/styles";

import { popoverSurface } from "../popoverSurface";

/**
 * What opens from a trigger is drawn on one card (`popoverSurface`), whoever
 * opens it: `MuiPopover` covers popovers, menus and the dropdowns of selects,
 * `MuiAutocomplete` its options. Rows are rounded inside a padded list, as in
 * the header's popovers. The gap to the trigger is the caller's: a popup may
 * open upward or sideways.
 */
const Menu = (theme: Theme) => {
  const surface = popoverSurface(theme);
  return {
    MuiPopover: { styleOverrides: { paper: surface } },
    MuiMenu: { styleOverrides: { list: { padding: "6px" } } },
    MuiMenuItem: { styleOverrides: { root: { borderRadius: "8px" } } },
    MuiAutocomplete: {
      styleOverrides: {
        paper: surface,
        listbox: { padding: "6px" },
        option: { borderRadius: "8px" },
      },
    },
  };
};

export default Menu;
