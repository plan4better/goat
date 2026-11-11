import { Menu } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";
import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { readableText } from "@/lib/utils/credits";

import { MenuHeading, MenuRow } from "@/components/common/MenuRow";

const theme = createAppTheme({ mode: "light", locale: "en" });
const onPick = vi.fn();

const renderMenu = () =>
  render(
    <ThemeProvider theme={theme}>
      <Menu open anchorEl={document.body}>
        <MenuHeading>New data</MenuHeading>
        <MenuRow icon={ICON_NAME.UPLOAD} label="Upload" onClick={onPick} />
        <MenuRow label="Newest first" selected />
        <MenuRow label="Editor" secondary="Can change the content" />
        <MenuRow icon={ICON_NAME.TRASH} label="Delete" danger />
      </Menu>
    </ThemeProvider>
  );

describe("MenuRow", () => {
  it("draws a row in the popovers' measures: semibold 13.5px, a muted icon, rounded", () => {
    renderMenu();
    const row = screen.getByRole("menuitem", { name: "Upload" });
    expect(row).toHaveStyle({
      fontSize: "13.5px",
      fontWeight: "600",
      borderRadius: "8px",
      padding: "9px 10px",
      gap: "11px",
      color: theme.palette.text.primary,
    });
    expect(row.querySelector("svg")).toHaveStyle({ fontSize: "15px", color: theme.palette.text.secondary });
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("marks the option in force with readable primary ink and a check, not with a fill", () => {
    renderMenu();
    const ink = readableText(theme, theme.palette.primary.main);
    const row = screen.getByRole("menuitem", { name: /^Newest first/ });
    expect(row).toHaveStyle({ color: ink, backgroundColor: "rgba(0, 0, 0, 0)" });
    // It has no icon of its own: the one mark in it is the check.
    expect(row.querySelectorAll("svg")).toHaveLength(1);
    expect(row.querySelector("svg")).toHaveStyle({ color: ink });
    // A row that is not in force has only its own icon.
    expect(screen.getByRole("menuitem", { name: "Upload" }).querySelectorAll("svg")).toHaveLength(1);
  });

  it("puts a muted second line under the label", () => {
    renderMenu();
    const line = screen.getByText("Can change the content");
    expect(line).toHaveStyle({ fontSize: "11.5px", fontWeight: "400", color: theme.palette.text.secondary });
    expect(screen.getByRole("menuitem", { name: /^Editor/ })).toContainElement(line);
  });

  it("writes a destructive row, icon included, in the error colour", () => {
    renderMenu();
    const row = screen.getByRole("menuitem", { name: "Delete" });
    expect(row).toHaveStyle({ color: theme.palette.error.main });
    expect(row.querySelector("svg")).toHaveStyle({ color: theme.palette.error.main });
  });

  it("heads a group with a small bold muted line that is not a menu item", () => {
    renderMenu();
    const heading = screen.getByText("New data");
    expect(heading).toHaveStyle({
      fontSize: "11.5px",
      fontWeight: "700",
      color: theme.palette.text.secondary,
    });
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });
});
