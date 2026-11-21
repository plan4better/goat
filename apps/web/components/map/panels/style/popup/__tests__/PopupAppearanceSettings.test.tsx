import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { popupProperties } from "@/lib/validations/layer";

import { choose, renderPanel } from "@/components/map/panels/styleEditor/__tests__/renderPanel";

import { PopupAppearanceSettings } from "../PopupAppearanceSettings";

describe("PopupAppearanceSettings", () => {
  it("is the editor's rows: choices for layout and header, the anchor only when pinned", async () => {
    const onChange = vi.fn();
    const { rerender } = renderPanel(
      <PopupAppearanceSettings popup={popupProperties.parse({})} onChange={onChange} />
    );
    expect(screen.queryByText("anchor")).toBeNull();
    await choose("popup_layout", "popup_layout_popup", "popup_layout_pinned");
    expect(onChange).toHaveBeenLastCalledWith({ layout: "pinned" });
    await choose("popup_header_label", "popup_header_standard", "popup_header_none");
    expect(onChange).toHaveBeenLastCalledWith({ header: "none" });
    rerender(
      <PopupAppearanceSettings popup={popupProperties.parse({ layout: "pinned" })} onChange={onChange} />
    );
    expect(screen.getByText("anchor")).toBeDefined();
  });

  it("width and max height are number rows in px; an empty box is Auto", async () => {
    const onChange = vi.fn();
    renderPanel(
      <PopupAppearanceSettings popup={popupProperties.parse({ width: 300 })} onChange={onChange} />
    );

    const width = screen.getByRole("textbox", { name: "popup_width" }) as HTMLInputElement;
    expect(screen.getByText("popup_width").parentElement?.textContent).toContain("px");
    fireEvent.change(width, { target: { value: "420" } });
    expect(onChange).toHaveBeenLastCalledWith({ width: 420 });
    await userEvent.clear(width);
    expect(onChange).toHaveBeenLastCalledWith({ width: undefined });

    const height = screen.getByRole("textbox", { name: "popup_max_height" }) as HTMLInputElement;
    expect(height.placeholder).toBe("auto");
    fireEvent.change(height, { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith({ max_height: undefined });
  });
});
