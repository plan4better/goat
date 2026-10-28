import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { choose, openGroup, renderPanel } from "./renderPanel";

const render = (symbol: object, geometry: Geometry) =>
  renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    { document: { version: 1, kind: "vector", symbol } as LayerStyle, data: { geometry } }
  );

describe("polygon and line parts", () => {
  it("the row whose editor is open shows it as expanded until the editor closes", async () => {
    render({ fill: {}, outline: { color: "#000000" } }, "polygon");
    // The first match is the panel's row; an open popover's title repeats the part's name.
    const rowButton = (part: string) =>
      within(screen.getAllByText(part)[0].parentElement as HTMLElement).getAllByRole("button")[0];
    const button = () => rowButton("style_editor.part_fill");
    expect(button().getAttribute("aria-expanded")).toBe("false");
    await openGroup("style_editor.part_fill");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    await openGroup("style_editor.part_outline");
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(rowButton("style_editor.part_outline").getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(rowButton("style_editor.part_outline").getAttribute("aria-expanded")).toBe("false");
  });

  it("turning the outline off writes false and on restores it", async () => {
    const { store } = render({ fill: {}, outline: { color: "#000000", width: 2 } }, "polygon");
    await openGroup("style_editor.part_outline");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("symbol.outline")).toBe(false);
    expect(screen.getByText("style_editor.part_off_note")).toBeDefined();
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("symbol.outline")).toEqual({ color: "#000000", width: 2 });
  });

  it("Same as fill writes fill", async () => {
    const { store } = render({ fill: {}, outline: { color: "#000000" } }, "polygon");
    await openGroup("style_editor.part_outline");
    const field = screen.getByRole("button", { name: "style_editor.pick_color" });
    expect(field.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(field);
    // The field draws as open while its picker shows, as the other fields that open an editor.
    expect(field.getAttribute("aria-expanded")).toBe("true");
    expect(field.hasAttribute("data-active")).toBe(true);
    const option = screen.getByRole("button", { name: "style_editor.same_as_fill" });
    expect(option.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(option);
    expect(store.get("symbol.outline.color")).toBe("fill");
    expect(option.getAttribute("aria-pressed")).toBe("true");
    expect(field.textContent).toBe("style_editor.same_as_fill");
  });

  it("line cap, join and dash write butt|round|square, miter|round|bevel and dash names", async () => {
    const { store } = render({ line: {} }, "line");
    await openGroup("style_editor.part_line");
    await choose("style_editor.ends", "butt", "square");
    expect(store.get("symbol.line.cap")).toBe("square");
    await choose("style_editor.corners", "round", "miter");
    expect(store.get("symbol.line.join")).toBe("miter");
    await choose("style_editor.dash", "solid", "dashed");
    expect(store.get("symbol.line.dash")).toBe("dashed");
  });

  it("arrows placement repeat shows spacing, others hide it", async () => {
    const { store } = render({ line: {}, arrows: { placement: "repeat" } }, "line");
    await openGroup("style_editor.part_arrows");
    expect(screen.getByText("style_editor.spacing")).toBeDefined();
    await choose("style_editor.placement", "repeat", "center");
    expect(store.get("symbol.arrows.placement")).toBe("center");
    expect(screen.queryByText("style_editor.spacing")).toBeNull();
  });

  it("Visible writes the part zooms", async () => {
    const { store } = render({ fill: {} }, "polygon");
    await openGroup("style_editor.part_fill");
    const [low, high] = screen.getAllByRole("slider", { name: /style_editor.zoom_(from|until)/ });
    fireEvent.change(low, { target: { value: 12 } });
    expect(store.get("symbol.fill.min_zoom")).toBe(12);
    fireEvent.change(high, { target: { value: 18 } });
    expect(store.get("symbol.fill.max_zoom")).toBe(18);
  });

  it("every row's value comes from DEFAULTS when unset", async () => {
    render({ line: {}, casing: {} }, "line");
    await openGroup("style_editor.part_line");
    expect((screen.getByRole("textbox", { name: "style_editor.width" }) as HTMLInputElement).value).toBe("2");
    await openGroup("style_editor.part_casing");
    expect((screen.getByRole("textbox", { name: "style_editor.width" }) as HTMLInputElement).value).toBe("1");
  });
});
