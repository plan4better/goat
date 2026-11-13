import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { PopupSection } from "@/components/map/panels/styleEditor/sections/PopupSection";

import { choose, echoTransport, pickColor, renderPanel } from "./renderPanel";

// The parts' reset reads the dataset's style from core; none here.
vi.mock("@/lib/api/map", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDatasetStyle: () => ({ style: undefined, error: undefined, isLoading: true }),
}));

// A field list shows a sample feature's values; none here.
vi.mock("@/components/map/popover/sampleFeature", () => ({
  useSampleFeature: () => ({ feature: undefined }),
}));

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
        fields: [
          { name: "name", type: "string", label: "name" },
          { name: "area", type: "number", label: "area" },
        ],
      },
      transport,
    }
  );
  return { ...result, transport };
}

const openContent = () =>
  userEvent.click(
    within(screen.getByText("style_editor.popup_content").parentElement as HTMLElement).getByRole("button")
  );

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
    // "Preview", on the map: a short label that fits the label column.
    expect(screen.getByText("style_editor.popup_preview_value")).toBeDefined();
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.preview" }));
    expect(screen.getByText("preview of dataset-1")).toBeDefined();
  });

  it("the content's mode is a segmented row; Add block opens the shared menu and adds the block", async () => {
    const { store } = setup({ blocks: [] });
    await openContent();
    const simple = screen.getByRole("button", { name: "popup_mode_simple" });
    expect(simple.getAttribute("aria-pressed")).toBe("true");
    expect(simple.closest(".MuiToggleButtonGroup-root")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "add_block" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(6);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "divider_block" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(store.get("popup.blocks")).toEqual([expect.objectContaining({ type: "divider" })]);
    await userEvent.click(screen.getByRole("button", { name: "popup_mode_html" }));
    expect(store.get("popup.mode")).toBe("html");
  });

  /** Opens the editor of the block named `name` from the content popover. */
  const openBlock = async (name: string) => {
    await openContent();
    const rows = screen.getAllByText(name);
    await userEvent.click(rows[rows.length - 1].closest("button") as HTMLElement);
  };

  it("a block's editor is rows: a color opens the editor's color picker and writes the block", async () => {
    const { store } = setup({ blocks: [{ id: "line", type: "divider", thickness: 2 }] });
    await openBlock("divider_block");
    expect(screen.getByRole("slider", { name: "thickness" })).toBeDefined();
    await pickColor(screen.getByText("color").parentElement as HTMLElement, "#2266aa");
    expect(store.get("popup.blocks.0.color")).toBe("#2266aa");
  });

  it("a badge picks its field from the app's field list, text fields only", async () => {
    const { store } = setup({
      blocks: [{ id: "b", type: "badge", field: "name", mode: "single", palette: {}, full_width: false }],
    });
    await openBlock("badge_block");
    await userEvent.click(screen.getByRole("combobox", { name: "badge_field" }));
    const list = screen.getByRole("listbox");
    const [only] = within(list).getAllByRole("option");
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    expect(only.textContent).toContain("name");
    expect(only.getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "by_value" }));
    expect(store.get("popup.blocks.0.mode")).toBe("per_value");
  });

  it("names the button's link Link and counts the fields a field list shows first", async () => {
    setup({
      blocks: [
        { id: "go", type: "button", label: "Open", url_template: "" },
        { id: "list", type: "field_list", attributes: [] },
      ],
    });
    await openBlock("button_block");
    expect(screen.getByRole("textbox", { name: "popup_link" })).toBeDefined();
    const lists = screen.getAllByText("field_list");
    await userEvent.click(lists[lists.length - 1].closest("button") as HTMLElement);
    // "Show first [n] fields": the number in the box, "fields" as its unit.
    const row = screen.getByText("collapse_after").parentElement as HTMLElement;
    expect(within(row).getByRole("textbox", { name: "collapse_after" })).toBeDefined();
    expect(within(row).getByText("collapse_after_unit")).toBeDefined();
  });
});
