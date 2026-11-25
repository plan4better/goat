import { ThemeProvider, ToggleButton, ToggleButtonGroup } from "@mui/material";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

// A group of toggle buttons is a switch between options: one soft track, the selected option a chip on it. The look
// comes from the theme, so every switch in the app has it; a toggle button on its own (a toolbar button) keeps its own.
describe.each(["light", "dark"] as const)("a toggle button group in the app theme, %s mode", (mode) => {
  const theme = createAppTheme({ mode, locale: "en" });
  const style = (name: string) => getComputedStyle(screen.getByRole("button", { name }));

  const renderGroup = (color?: "primary") =>
    render(
      <ThemeProvider theme={theme}>
        <ToggleButtonGroup exclusive size="small" value="a" color={color} aria-label="Side">
          <ToggleButton value="a">Left</ToggleButton>
          <ToggleButton value="b">Middle</ToggleButton>
          <ToggleButton value="c">Right</ToggleButton>
        </ToggleButtonGroup>
        <ToggleButton value="bold">Bold</ToggleButton>
      </ThemeProvider>
    );

  it("is a track without lines between the options", () => {
    renderGroup();
    const track = getComputedStyle(screen.getByRole("group", { name: "Side" }));
    expect(track.padding).toBe("2px");
    expect(track.gap).toBe("2px");
    for (const name of ["Left", "Middle", "Right"]) {
      expect(style(name).borderWidth).toBe("0px");
      expect(style(name).marginLeft).toBe("0px");
      // Every option is round on all four corners, also the ones in the middle.
      expect(style(name).borderTopLeftRadius).toBe("6px");
      expect(style(name).borderBottomRightRadius).toBe("6px");
      expect(style(name).textTransform).toBe("none");
    }
  });

  it.each([undefined, "primary"] as const)("shows the selected option as a chip, color %s", (color) => {
    renderGroup(color);
    const chip = mode === "light" ? theme.palette.common.white : "rgba(231, 227, 252, 0.17)";
    expect(screen.getByRole("button", { name: "Left" })).toHaveStyle({
      backgroundColor: chip,
      color: theme.palette.text.primary,
    });
    expect(style("Left").boxShadow).not.toBe("none");
    expect(screen.getByRole("button", { name: "Middle" })).toHaveStyle({
      color: theme.palette.text.secondary,
    });
    expect(style("Middle").boxShadow).toBe("");
  });

  it("leaves a toggle button outside a group as it is", () => {
    renderGroup();
    expect(style("Bold").borderWidth).toBe("1px");
    expect(style("Bold").textTransform).toBe("uppercase");
  });
});
