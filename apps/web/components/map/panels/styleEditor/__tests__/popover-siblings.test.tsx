import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, renderPanel } from "./renderPanel";

// The label editor's popovers with the real stack: a picker opened from a level closes the levels opened from it
// before, so only the path from the panel to the newest popover is open.

const FIELDS = [{ name: "name", type: "string" as const, label: "name" }];

function render() {
  return renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    {
      document: {
        version: "1.0.0",
        kind: "vector",
        symbol: { label: { text: "{name}", color: "#222222", halo: { color: "#000000", width: 3 } } },
      } as LayerStyle,
      data: {
        geometry: "point",
        fields: FIELDS,
        fieldTypes: { name: "string" },
        sample: { name: "Berlin" },
      },
    }
  );
}

const level = (n: number) => document.querySelector(`[data-popover-level='${n}']`) as HTMLElement | null;
/** The open pickers: the frames without a level. */
const pickers = () => Array.from(document.querySelectorAll("[data-popover-frame]:not([data-popover-level])"));
/** The row of the label editor, not the popover it opened (whose title has the same text). */
const editorRow = (label: string) => within(level(1)!).getAllByText(label)[0].parentElement as HTMLElement;
const openHalo = () => userEvent.click(within(editorRow("style_editor.halo")).getAllByRole("button")[0]);
const pickColorIn = (box: HTMLElement) =>
  userEvent.click(within(box).getByRole("button", { name: "style_editor.pick_color" }));

describe("label editor: a picker closes the popovers its level opened before", () => {
  it("the label's color, picked while Halo is open, closes Halo", async () => {
    render();
    await openGroup("style_editor.part_label");
    await openHalo();
    expect(level(2)).not.toBeNull();
    await pickColorIn(editorRow("style_editor.color"));
    expect(level(2)).toBeNull();
    expect(level(1)).not.toBeNull();
    expect(pickers()).toHaveLength(1);
    expect(within(pickers()[0] as HTMLElement).getByRole("textbox", { name: "color_value" })).toBeDefined();
  });

  it("the Halo's color keeps Halo open", async () => {
    render();
    await openGroup("style_editor.part_label");
    await openHalo();
    await pickColorIn(level(2)!);
    expect(level(2)).not.toBeNull();
    expect(level(1)).not.toBeNull();
    expect(pickers()).toHaveLength(1);
  });

  it("Halo opened while the label's color is open closes the color", async () => {
    render();
    await openGroup("style_editor.part_label");
    await pickColorIn(editorRow("style_editor.color"));
    expect(pickers()).toHaveLength(1);
    await openHalo();
    expect(level(2)).not.toBeNull();
    expect(pickers()).toHaveLength(0);
  });
});
