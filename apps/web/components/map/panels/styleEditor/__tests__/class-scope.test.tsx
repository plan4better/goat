import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { setClassificationField } from "@/lib/style/editor/classify";
import { setIn } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, pickColor, renderPanel } from "./renderPanel";

const classes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    ...(i > 0 ? { from: i * 10 } : {}),
    ...(i < n - 1 ? { to: (i + 1) * 10 } : {}),
    fill: { color: `#0000${String(i).padStart(2, "0")}` },
  }));

function setup(n = 4, fill: object = { color: "#cccccc", opacity: 0.8 }, extra: object = {}) {
  const document = {
    version: 1,
    kind: "vector",
    symbol: { fill, outline: { color: "#ffffff", width: 1 } },
    classify: [
      { id: "density", field: "density", method: "quantile", count: n, classes: classes(n), ...extra },
    ],
  } as unknown as LayerStyle;
  const result = renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    {
      document,
      data: {
        geometry: "polygon",
        fields: [
          { name: "density", type: "number", label: "density" },
          { name: "land_use", type: "string", label: "land_use" },
        ],
        sample: { density: 50, land_use: "park" },
      },
    }
  );
  return result;
}

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;

describe("class scope", () => {
  it("a scoped color edit writes into the class record", async () => {
    const { store } = setup();
    act(() => store.setScope({ classify: 0, key: 1 }));
    expect(screen.getByText("style_editor.scope_note")).toBeDefined();
    await openGroup("style_editor.part_fill");
    const color = within(rowOf("style_editor.color")).getByRole("button", {
      name: "style_editor.pick_color",
    });
    expect(color.textContent).toBe("#000001".toUpperCase());
    await pickColor(rowOf("style_editor.color"), "#123456");
    expect(store.get("classify.0.classes.1.fill.color")).toBe("#123456");
    expect(store.get("symbol.fill.color")).toBe("#cccccc");
    expect((within(rowOf("style_editor.opacity")).getByRole("textbox") as HTMLInputElement).value).toBe("80");
  });

  const pickMode = async (label: string, mode: string) => {
    await userEvent.click(within(rowOf(label)).getByRole("button", { name: "style_editor.value_mode_aria" }));
    await userEvent.click(within(screen.getByRole("menu")).getByText(mode));
  };

  it("in scope Fixed over a base by zoom gives the class the value at the map zoom", async () => {
    const byZoom = {
      zoom: [
        [9, 0.2],
        [15, 0.8],
      ],
    };
    const { store } = setup(4, { color: "#cccccc", opacity: byZoom });
    act(() => store.setScope({ classify: 0, key: 1 }));
    await openGroup("style_editor.part_fill");
    await pickMode("style_editor.opacity", "style_editor.mode_fixed");
    expect(store.get("classify.0.classes.1.fill.opacity")).toBe(0.5);
    expect(store.get("symbol.fill.opacity")).toEqual(byZoom);
  });

  it("in scope the mode the class already inherits changes nothing", async () => {
    const { store } = setup();
    act(() => store.setScope({ classify: 0, key: 1 }));
    await openGroup("style_editor.part_fill");
    await pickMode("style_editor.opacity", "style_editor.mode_fixed");
    expect(store.get("classify.0.classes.1.fill")).toEqual({ color: "#000001" });
  });

  it("in scope By zoom starts from the value the class shows, not the default", async () => {
    const { store } = setup();
    act(() => store.setScope({ classify: 0, key: 1 }));
    await openGroup("style_editor.part_fill");
    await pickMode("style_editor.opacity", "style_editor.mode_zoom");
    expect(store.get("classify.0.classes.1.fill.opacity")).toEqual({
      zoom: [
        [9, 0.8],
        [15, 0.8],
      ],
    });
  });

  it("in scope a base by zoom opens its editor on a copy in the class, not on all features", async () => {
    const byZoom = {
      zoom: [
        [9, 0.2],
        [15, 0.8],
      ],
    };
    const { store } = setup(4, { color: "#cccccc", opacity: byZoom });
    act(() => store.setScope({ classify: 0, key: 1 }));
    await openGroup("style_editor.part_fill");
    await userEvent.click(within(rowOf("style_editor.opacity")).getAllByRole("button")[0]);
    expect(store.get("classify.0.classes.1.fill.opacity")).toEqual(byZoom);
    expect(screen.getByText("style_editor.by_zoom_title")).toBeDefined();
  });

  it("in scope a base by attribute does not open the editor of all features", async () => {
    const byAttribute = { field: "density", range: [0.2, 1], domain: [0, 100] };
    const { store } = setup(4, { color: "#cccccc", opacity: byAttribute });
    act(() => store.setScope({ classify: 0, key: 1 }));
    await openGroup("style_editor.part_fill");
    await userEvent.click(within(rowOf("style_editor.opacity")).getAllByRole("button")[0]);
    expect(screen.queryByText("style_editor.by_attribute_title")).toBeNull();
    await pickMode("style_editor.opacity", "style_editor.mode_fixed");
    expect(store.get("classify.0.classes.1.fill.opacity")).toBe(0.6);
    expect(store.get("symbol.fill.opacity")).toEqual(byAttribute);
  });

  it("Reset removes the class key and leaves the part on (spec 3)", async () => {
    const { store } = setup();
    act(() => store.setScope({ classify: 0, key: 1 }));
    await openGroup("style_editor.part_fill");
    await userEvent.click(
      within(rowOf("style_editor.color")).getByRole("button", { name: "style_editor.value_mode_aria" })
    );
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByText("style_editor.mode_classes")).toBeNull();
    await userEvent.click(within(menu).getByText("style_editor.mode_reset"));
    expect(store.get("classify.0.classes.1.fill")).toEqual({});
    expect(store.get("classify.0.classes.1.id")).toBe("c2");
  });

  it("in scope a Visible row gives the class its own zoom range (spec 5.5)", () => {
    const { store } = setup();
    expect(screen.queryByRole("slider", { name: "style_editor.zoom_from" })).toBeNull();
    act(() => store.setScope({ classify: 0, key: 1 }));
    fireEvent.change(screen.getByRole("slider", { name: "style_editor.zoom_from" }), {
      target: { value: 13 },
    });
    expect(store.get("classify.0.classes.1.min_zoom")).toBe(13);
    expect(store.get("classify.0.classes.1.fill")).toEqual({ color: "#000001" });
    expect(store.get("min_zoom")).toBeUndefined();
  });

  it("a scoped part switch writes false into the class", async () => {
    const { store } = setup();
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_outline");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("classify.0.classes.0.outline")).toBe(false);
    expect(store.get("symbol.outline")).toEqual({ color: "#ffffff", width: 1 });
  });

  it("the scope falls back to all features when its class disappears", () => {
    const { store } = setup(7);
    act(() => store.setScope({ classify: 0, key: 5 }));
    act(() => store.update((doc) => setIn(doc, "classify.0.classes", classes(5))));
    expect(store.scope).toBeNull();
    expect(screen.queryByText("style_editor.scope_note")).toBeNull();
    act(() => store.setScope({ classify: 0, key: 1 }));
    act(() => store.update((doc) => setClassificationField(doc, 0, { name: "land_use", type: "string" })));
    expect(store.scope).toBeNull();
  });

  it("the scope chip picks a class", async () => {
    const { store } = setup();
    const chip = screen.getByRole("button", {
      name: "style_editor.style_one_class: style_editor.all_features",
    });
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(within(screen.getByRole("menu")).getByText("10 style_editor.range_to 20"));
    expect(store.scope).toEqual({ classify: 0, key: 1 });
  });

  it("the scope menu labels the open classes with the data's minimum and maximum, as the legend does", async () => {
    const { store } = setup(4, undefined, {
      computed: { at: "t", data: "f", scope: "dataset", domain: [0.73, 100] },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "style_editor.style_one_class: style_editor.all_features" })
    );
    const menu = within(screen.getByRole("menu"));
    expect(menu.getByText("0.73 style_editor.range_to 10")).toBeDefined();
    expect(menu.queryByText("style_editor.range_under 10")).toBeNull();
    await userEvent.click(menu.getByText("30 style_editor.range_to 100"));
    expect(store.scope).toEqual({ classify: 0, key: 3 });
    expect(
      screen.getByRole("button", { name: "style_editor.style_one_class: 30 style_editor.range_to 100" })
    ).toBeDefined();
  });
});
