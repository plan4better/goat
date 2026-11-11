import { ButtonBase } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { declaredStyle } from "@/lib/__tests__/declaredStyle";

describe("GOAT's theme", () => {
  it("writes a bare button in the app's font, not the browser's button font", () => {
    // The theme's typography only inherits, so a <button> (every ButtonBase:
    // tool pills, toggles, role pickers) took the browser's own font.
    render(
      <ThemeProvider theme={createAppTheme({ mode: "light", locale: "en" })}>
        <ButtonBase>Filter</ButtonBase>
      </ThemeProvider>
    );
    expect(declaredStyle(screen.getByRole("button", { name: "Filter" }), "font-family")).toBe("inherit");
  });
});
