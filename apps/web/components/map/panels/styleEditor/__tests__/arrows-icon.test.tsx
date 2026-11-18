// The arrows' icon in the panel (spec 3.2 `arrows.icon`): an Icon row in the Arrows editor that opens the marker's icon
// picker, without the marker's shape, with GOAT's arrow as its first choice; uploads and emoji keep their own colors,
// so their arrows have no color row.
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, renderPanel } from "./renderPanel";

const render = (doc: object) =>
  renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "vector", ...doc } as LayerStyle,
      data: { geometry: "line", fields: [{ name: "status", type: "string", label: "status" }] },
    }
  );

/** The last row with this label: the open popover's, after the section's. */
const rowOf = (label: string) => screen.getAllByText(label).at(-1)!.parentElement as HTMLElement;
/** GOAT's arrow as the picker's choice (the row's field has the same name). */
const arrowChoice = () =>
  screen
    .getAllByRole("button", { name: "style_editor.goat_arrow" })
    .find((button) => button.hasAttribute("aria-pressed"))!;

describe("the arrows' icon", () => {
  it("shows GOAT's arrow until an icon is picked, and goes back to it", async () => {
    const { store } = render({ symbol: { line: {}, arrows: {} } });
    await openGroup("style_editor.part_arrows");
    const row = rowOf("style_editor.icon");
    await userEvent.click(within(row).getByText("style_editor.goat_arrow"));
    // The marker's picker, without the marker's shape.
    expect(screen.queryByText("style_editor.shape")).toBeNull();
    expect(arrowChoice().getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Rail light" }));
    expect(store.get("symbol.arrows.icon")).toBe("goat:rail-light");
    // Any other icon than the arrow stays upright (spec 3.2 `turn_with_line`); the arrow turns with the line again.
    expect(store.get("symbol.arrows.turn_with_line")).toBe(false);
    expect(within(row).getByText("Rail light")).toBeDefined();
    expect(arrowChoice().getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(arrowChoice());
    expect(store.get("symbol.arrows")).toEqual({});
  });

  it("a library icon takes the arrows' color; an upload or an emoji keeps its own", async () => {
    const { store } = render({ symbol: { line: {}, arrows: { icon: "goat:rail-light" } } });
    await openGroup("style_editor.part_arrows");
    expect(screen.queryByText("style_editor.color")).not.toBeNull();
    expect(screen.queryByText("style_editor.note_icon_own_colors")).toBeNull();
    act(() => store.set("symbol.arrows.icon", "emoji:1f525"));
    expect(screen.queryByText("style_editor.color")).toBeNull();
    expect(screen.getByText("style_editor.note_icon_own_colors")).toBeDefined();
  });

  it("is the layer's: a class has no icon row of its own", async () => {
    const { store } = render({
      symbol: { line: {}, arrows: { icon: "goat:rail-light" } },
      classify: [{ field: "status", method: "categories", classes: [{ values: ["planned"] }] }],
    });
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_arrows");
    expect(screen.queryByText("style_editor.icon")).toBeNull();
    expect(screen.getByText("style_editor.size")).toBeDefined();
  });

  it("turns with the line until switched off; upright, it has no direction", async () => {
    const { store } = render({ symbol: { line: {}, arrows: { icon: "goat:rail-light" } } });
    await openGroup("style_editor.part_arrows");
    const turn = () =>
      screen.getByRole("checkbox", { name: "style_editor.turn_with_line" }) as HTMLInputElement;
    expect(turn().checked).toBe(true);
    expect(screen.queryByText("style_editor.direction")).not.toBeNull();
    await userEvent.click(turn());
    expect(store.get("symbol.arrows.turn_with_line")).toBe(false);
    expect(turn().checked).toBe(false);
    expect(screen.queryByText("style_editor.direction")).toBeNull();
    await userEvent.click(turn());
    expect(store.get("symbol.arrows.turn_with_line")).toBe(true);
  });

  it("picking GOAT's arrow turns it with the line again", async () => {
    const { store } = render({
      symbol: { line: {}, arrows: { icon: "goat:rail-light", turn_with_line: true } },
    });
    await openGroup("style_editor.part_arrows");
    await userEvent.click(within(rowOf("style_editor.icon")).getByText("Rail light"));
    await userEvent.click(arrowChoice());
    expect(store.get("symbol.arrows")).toEqual({});
    expect(screen.getByRole("checkbox", { name: "style_editor.turn_with_line" })).toHaveProperty(
      "checked",
      true
    );
  });

  it("is the layer's: a class has no switch of its own", async () => {
    const { store } = render({
      symbol: { line: {}, arrows: { icon: "goat:rail-light" } },
      classify: [{ field: "status", method: "categories", classes: [{ values: ["planned"] }] }],
    });
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_arrows");
    expect(screen.queryByText("style_editor.turn_with_line")).toBeNull();
  });
});
