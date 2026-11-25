// The app's tabs write their labels as they are given (sentence case), as its buttons do: the theme sets it once
// for every Tab, so a tab bar needs no textTransform of its own.
import { Tab, Tabs, ThemeProvider } from "@mui/material";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

describe("the app's tabs", () => {
  it.each(["light", "dark"] as const)("keep their labels' case, %s mode", (mode) => {
    render(
      <ThemeProvider theme={createAppTheme({ mode, locale: "en" })}>
        <Tabs value={0}>
          <Tab label="Style" />
          <Tab label="Metadata" />
        </Tabs>
      </ThemeProvider>
    );
    for (const tab of screen.getAllByRole("tab")) expect(getComputedStyle(tab).textTransform).toBe("none");
  });
});
