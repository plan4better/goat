import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { modesFor } from "@/lib/style/editor/forms";
import type { LayerStyle } from "@/lib/style/generated/types";

import { ClassificationEditor } from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, renderPanel } from "./renderPanel";

const render = (fill: object) =>
  renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "vector", symbol: { fill } } as LayerStyle,
      data: { geometry: "polygon", fields: [{ name: "use", type: "string", label: "use" }] },
    }
  );

const rowOf = (label: string) => screen.getAllByText(label).at(-1)?.parentElement as HTMLElement;

describe("pattern editor", () => {
  it("the Pattern row opens the patterns; a pattern brings its color, spacing and thickness", async () => {
    const { store } = render({ color: "#cccccc" });
    await openGroup("style_editor.part_fill");
    await userEvent.click(within(rowOf("style_editor.pattern")).getByText("none"));
    // Without a pattern, only the patterns.
    expect(screen.queryByText("style_editor.pattern_spacing")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "vertical" }));
    expect(store.get("symbol.fill.pattern")).toBe("vertical");
    expect(screen.getByRole("radio", { name: "vertical" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("style_editor.pattern_color")).toBeDefined();
    expect(screen.getByText("style_editor.pattern_spacing")).toBeDefined();
    expect(screen.getByText("style_editor.pattern_width")).toBeDefined();
    // The defaults show until set.
    expect(
      (screen.getByRole("textbox", { name: "style_editor.pattern_spacing" }) as HTMLInputElement).value
    ).toBe("10");
  });

  it("dots are worded as dots", async () => {
    render({ color: "#cccccc", pattern: "dots" });
    await openGroup("style_editor.part_fill");
    await userEvent.click(within(rowOf("style_editor.pattern")).getByText("dots"));
    expect(screen.getByText("style_editor.pattern_dot_color")).toBeDefined();
    expect(screen.getByText("style_editor.pattern_dot_size")).toBeDefined();
  });

  it("spacing and thickness go by zoom and by classes, not by a continuous mapping", () => {
    for (const key of ["fill.pattern_spacing", "fill.pattern_width"])
      expect(modesFor(key, { scoped: false, hasNumberField: true })).toEqual(["fixed", "zoom", "classes"]);
  });

  it("by zoom: pictures in the summaries, tiles for a stop, and back to the pattern editor", async () => {
    const { store } = render({
      color: "#cccccc",
      pattern: {
        zoom: [
          [8, "hatch_45"],
          [14, "grid"],
        ],
        interpolate: "step",
      },
    });
    await openGroup("style_editor.part_fill");
    // The Fill editor's row shows the patterns, their names on hover.
    await userEvent.click(screen.getByRole("img", { name: "hatch_45 → grid" }));
    expect(screen.getByText("style_editor.pattern_spacing")).toBeDefined();
    // The pattern editor's row opens the zoom editor in its place, which can go back to it.
    await userEvent.click(screen.getAllByRole("img", { name: "hatch_45 → grid" }).at(-1) as HTMLElement);
    expect(screen.getByText("style_editor.by_zoom_title")).toBeDefined();
    // The stop nearest the map zoom (12) is selected: zoom 14.
    await userEvent.click(screen.getByRole("radio", { name: "dots" }));
    expect(store.get("symbol.fill.pattern.zoom")).toEqual([
      [8, "hatch_45"],
      [14, "dots"],
    ]);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.back_to" }));
    expect(screen.queryByText("style_editor.by_zoom_title")).toBeNull();
    expect(screen.getByText("style_editor.pattern_spacing")).toBeDefined();
  });

  it("by classes: each class's pattern is its picture, picked from the tiles", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <ClassificationEditor ci={0} />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { fill: { color: "#cccccc" } },
          classify: [
            {
              id: "use",
              field: "use",
              method: "categories",
              target: "fill.pattern",
              classes: [
                { id: "c1", values: ["park"], fill: { pattern: "hatch_45" } },
                { id: "c2", values: ["forest"] },
              ],
            },
          ],
        } as LayerStyle,
        data: { geometry: "polygon", fields: [{ name: "use", type: "string", label: "use" }] },
      }
    );
    const buttons = screen.getAllByRole("button", { name: "style_editor.class_pattern" });
    expect(buttons[0].getAttribute("title")).toBe("hatch_45");
    await userEvent.click(buttons[1]);
    await userEvent.click(screen.getByRole("radio", { name: "grid" }));
    expect(store.get("classify.0.classes.1.fill.pattern")).toBe("grid");
  });

  it("the Fill editor's Pattern row says when classes decide the pattern", async () => {
    renderPanel(
      <PopoverProvider>
        <SymbolSection />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { fill: { color: "#cccccc", pattern: "hatch_45" } },
          classify: [
            {
              id: "use",
              field: "use",
              method: "categories",
              target: "fill.pattern",
              classes: [{ id: "c1", values: ["park"], fill: { pattern: "grid" } }],
            },
          ],
        } as LayerStyle,
        data: { geometry: "polygon", fields: [{ name: "use", type: "string", label: "use" }] },
      }
    );
    await openGroup("style_editor.part_fill");
    expect(within(rowOf("style_editor.pattern")).getByText("style_editor.by_field")).toBeDefined();
    expect(within(rowOf("style_editor.pattern")).queryByText("hatch_45")).toBeNull();
  });
});
