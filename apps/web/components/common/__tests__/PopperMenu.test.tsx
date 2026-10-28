import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import PopperMenu from "@/components/common/PopperMenu";

describe("PopperMenu", () => {
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
