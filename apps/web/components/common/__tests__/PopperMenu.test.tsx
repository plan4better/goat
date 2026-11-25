import { ThemeProvider } from "@mui/material/styles";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";
import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";
import { popoverSurface } from "@p4b/ui/theme/popoverSurface";

import PopperMenu from "@/components/common/PopperMenu";

const theme = createAppTheme({ mode: "light", locale: "en" });
const onRename = vi.fn();

const openMenu = () => {
  render(
    <ThemeProvider theme={theme}>
      <PopperMenu
        menuButton={<button type="button">More</button>}
        menuItems={[
          { id: "rename", label: "Rename", icon: ICON_NAME.EDIT, onClick: onRename },
          { id: "delete", label: "Delete", icon: ICON_NAME.TRASH, group: "danger" },
        ]}
      />
    </ThemeProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "More" }));
};

describe("PopperMenu", () => {
  it("opens on the card every popover is drawn on", () => {
    openMenu();
    const paper = screen.getByText("Rename").closest(".MuiPaper-root");
    expect(paper).toHaveStyle(popoverSurface(theme));
  });

  it("draws its rows as the header's popovers do", () => {
    openMenu();
    const row = screen.getByRole("button", { name: "Rename" });
    expect(row).toHaveStyle({ borderRadius: "8px", padding: "9px 10px" });
    expect(screen.getByText("Rename")).toHaveStyle({ fontSize: "13.5px", fontWeight: "600" });
  });

  it("runs a pick and closes", () => {
    onRename.mockReset();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("says why a disabled item is off, and does not run it", async () => {
    const onSelect = vi.fn();
    render(
      <PopperMenu
        menuButton={<button type="button">more</button>}
        onSelect={onSelect}
        menuItems={[
          { id: "zoomTo", label: "Zoom to", disabled: true, tooltip: "Reading the area of this layer" },
        ]}
      />
    );
    fireEvent.click(screen.getByText("more"));
    const item = await screen.findByText("Zoom to");

    // The disabled button takes no pointer events; its wrapper does.
    await userEvent.hover(item.closest(".MuiListItemButton-root")?.parentElement as HTMLElement);
    expect(await screen.findByText("Reading the area of this layer")).toBeTruthy();

    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
