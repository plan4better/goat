// The marker of polygons and lines in the panel (spec 3.3): a part with its switch, off until turned on, whose editor
// has the point marker's rows.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Geometry } from "@/lib/style/compile/types";
import { classifyTargets } from "@/lib/style/editor/classify";
import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, renderPanel } from "./renderPanel";

const render = (symbol: object, geometry: Geometry) =>
  renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    { document: { version: "1.0.0", kind: "vector", symbol } as LayerStyle, data: { geometry } }
  );

const rowOf = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;

describe.each(["polygon", "line"] as const)("the marker of %ss", (geometry) => {
  const main = geometry === "polygon" ? { fill: {} } : { line: {} };

  it("is a part of the section, off until turned on", async () => {
    const { store } = render(main, geometry);
    expect(within(rowOf("style_editor.part_marker")).getByText("style_editor.none")).toBeDefined();
    await openGroup("style_editor.part_marker");
    expect(screen.getByText("style_editor.part_off_note")).toBeDefined();
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("symbol.marker")).toEqual({});
  });

  it("its editor has the point marker's rows", async () => {
    render({ ...main, marker: { icon: "goat:school", size: 16 } }, geometry);
    await openGroup("style_editor.part_marker");
    for (const label of [
      "style_editor.icon",
      "style_editor.color",
      "style_editor.icon_color",
      "style_editor.size",
      "style_editor.opacity",
      "style_editor.rotation",
      "style_editor.overlap",
    ])
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
  });

  it("turning it off writes false and on brings it back", async () => {
    const { store } = render({ ...main, marker: { color: "#08519c", size: 20 } }, geometry);
    await openGroup("style_editor.part_marker");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("symbol.marker")).toBe(false);
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("symbol.marker")).toEqual({ color: "#08519c", size: 20 });
  });

  it("a plain circle shifts and collides as an image", async () => {
    render({ ...main, marker: { size: 16 } }, geometry);
    await openGroup("style_editor.part_marker");
    expect(screen.getAllByText("style_editor.overlap").length).toBeGreaterThan(0);
    expect(screen.getAllByText("style_editor.offset_x").length).toBeGreaterThan(0);
    expect(screen.queryByText("style_editor.rotation")).toBeNull();
  });

  it("classifications may set the marker", () => {
    expect(classifyTargets(geometry)).toEqual(
      expect.arrayContaining(["marker.size", "marker.color", "marker.icon"])
    );
  });
});
