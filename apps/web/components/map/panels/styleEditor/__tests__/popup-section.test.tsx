import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { PopupSection } from "@/components/map/panels/styleEditor/sections/PopupSection";

import { choose, echoTransport, renderPanel } from "./renderPanel";

// The preview controller pins a sample feature's popup on the project map (through the store); here it only shows
// which dataset it was given.
vi.mock("@/components/map/panels/style/popup/PopupPreviewController", () => ({
  PopupPreviewController: ({ layerId }: { layerId: string }) => <p>preview of {layerId}</p>,
}));

function setup(popup?: unknown) {
  const transport = echoTransport();
  const result = renderPanel(
    <PopoverProvider>
      <PopupSection />
    </PopoverProvider>,
    {
      document: {
        version: 1,
        kind: "vector",
        symbol: { fill: {} },
        ...(popup === undefined ? {} : { popup }),
      } as LayerStyle,
      data: {
        layerId: "dataset-1",
        geometry: "polygon",
        fields: [{ name: "name", type: "string", label: "name" }],
      },
      transport,
    }
  );
  return { ...result, transport };
}

describe("popup section", () => {
  it("Show on Off writes popup false and on brings the blocks back", async () => {
    const blocks = [{ id: "line", type: "divider", thickness: 2 }];
    const { store } = setup({ blocks });
    await choose("style_editor.popup_show_on", "style_editor.popup_on_click", "style_editor.popup_off");
    expect(store.get("popup")).toBe(false);
    expect(screen.queryByText("style_editor.popup_content")).toBeNull();
    await choose("style_editor.popup_show_on", "style_editor.popup_off", "style_editor.popup_on_hover");
    expect(store.get("popup")).toEqual({ blocks, trigger: "hover" });
  });

  it("typing in a block editor makes no request", async () => {
    const { store, transport } = setup({
      blocks: [{ id: "go", type: "button", label: "Open", url_template: "https://example.org" }],
    });
    await userEvent.click(
      within(screen.getByText("style_editor.popup_content").parentElement as HTMLElement).getByRole("button")
    );
    // The block row in the content popover (the content row's summary names the block too).
    const rows = screen.getAllByText("button_block");
    await userEvent.click(rows[rows.length - 1]);
    const label = screen.getByDisplayValue("Open");
    await userEvent.type(label, " map");
    expect((store.get("popup.blocks.0") as { label: string }).label).toBe("Open map");
    expect(transport.saves).toHaveLength(0);
  });

  it("Show preview pins a sample feature's popup on the map, for the layer's dataset", async () => {
    setup({ blocks: [] });
    expect(screen.queryByText("preview of dataset-1")).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "show_preview" }));
    expect(screen.getByText("preview of dataset-1")).toBeDefined();
  });
});
