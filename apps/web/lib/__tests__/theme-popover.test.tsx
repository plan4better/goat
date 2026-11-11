import { Autocomplete, Menu, MenuItem, Popover, TextField } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";
import { popoverSurface } from "@p4b/ui/theme/popoverSurface";

// Every surface that opens from a trigger is drawn the same way without its
// caller styling it: the theme carries the look of the header's popovers.
describe.each(["light", "dark"] as const)("popup surfaces of the %s theme", (mode) => {
  const theme = createAppTheme({ mode, locale: "en" });
  const surface = popoverSurface(theme);
  const paper = (selector: string) => {
    const found = document.querySelector(selector);
    if (!found) throw new Error(`no ${selector}`);
    return found;
  };

  it("is one rounded, bordered, softly lifted card", () => {
    expect(surface.borderRadius).toBe("12px");
    expect(surface.border).toBe(`1px solid ${theme.palette.divider}`);
    expect(surface.boxShadow).not.toBe(theme.shadows[8]);
  });

  it("draws a menu on it, with rounded rows inside a padded list", () => {
    render(
      <ThemeProvider theme={theme}>
        <Menu open anchorEl={document.body}>
          <MenuItem>One</MenuItem>
        </Menu>
      </ThemeProvider>
    );
    expect(paper(".MuiMenu-paper")).toHaveStyle(surface);
    expect(paper(".MuiMenu-list")).toHaveStyle({ padding: "6px" });
    expect(paper(".MuiMenuItem-root")).toHaveStyle({ borderRadius: "8px" });
  });

  it("draws a popover on it", () => {
    render(
      <ThemeProvider theme={theme}>
        <Popover open anchorEl={document.body}>
          Content
        </Popover>
      </ThemeProvider>
    );
    expect(paper(".MuiPopover-paper")).toHaveStyle(surface);
  });

  it("draws an autocomplete's options on it", () => {
    render(
      <ThemeProvider theme={theme}>
        <Autocomplete open options={["One"]} renderInput={(params) => <TextField {...params} />} />
      </ThemeProvider>
    );
    expect(paper(".MuiAutocomplete-paper")).toHaveStyle(surface);
  });
});
