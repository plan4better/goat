import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { setClassificationField } from "@/lib/style/editor/classify";
import { setIn } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { LayerSection } from "@/components/map/panels/styleEditor/sections/LayerSection";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, pickColor, renderPanel } from "./renderPanel";

/** The dot's tooltip, as its label. */
const DOT = "style_editor.differs_for_some_features";

const classes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    ...(i > 0 ? { from: i * 10 } : {}),
    ...(i < n - 1 ? { to: (i + 1) * 10 } : {}),
    fill: { color: `#0000${String(i).padStart(2, "0")}` },
  }));

function setup(n = 4, fill: object = { color: "#cccccc", opacity: 0.8 }, extra: object = {}) {
  const document = {
    version: "1.0.0",
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
/** A group row of the section, also while its editor (titled with the same label) is open. */
const groupRowOf = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;

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

  it("Reset of the class's last key in a part that is on removes the emptied part (spec 3)", async () => {
    const { store } = setup();
    act(() => store.setScope({ classify: 0, key: 1 }));
    await openGroup("style_editor.part_fill");
    await userEvent.click(
      within(rowOf("style_editor.color")).getByRole("button", { name: "style_editor.value_mode_aria" })
    );
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByText("style_editor.mode_classes")).toBeNull();
    await userEvent.click(within(menu).getByText("style_editor.mode_reset"));
    expect(store.get("classify.0.classes.1.fill")).toBeUndefined();
    expect(store.get("classify.0.classes.1.id")).toBe("c2");
    expect(within(groupRowOf("style_editor.part_fill")).queryByLabelText(DOT)).toBeNull();
  });

  it("Reset keeps the emptied part that switches on, for the class, a part the layer leaves out", async () => {
    const { store } = setup();
    act(() =>
      store.update((doc) =>
        setIn(setIn(doc, "symbol.outline", undefined), "classify.0.classes.1.outline", { color: "#ff0000" })
      )
    );
    act(() => store.setScope({ classify: 0, key: 1 }));
    await openGroup("style_editor.part_outline");
    await userEvent.click(
      within(rowOf("style_editor.color")).getByRole("button", { name: "style_editor.value_mode_aria" })
    );
    await userEvent.click(within(screen.getByRole("menu")).getByText("style_editor.mode_reset"));
    expect(store.get("classify.0.classes.1.outline")).toEqual({});
    // The class draws an outline all features do not have.
    expect(within(groupRowOf("style_editor.part_outline")).getByLabelText(DOT)).toBeDefined();
  });

  describe("the group row's dot says what differs from all features", () => {
    const scoped = (path?: string, value?: unknown) => {
      const { store } = setup();
      if (path) act(() => store.set(path, value));
      act(() => store.setScope({ classify: 0, key: 1 }));
      return store;
    };
    const dotOn = (label: string) => within(rowOf(label)).queryByLabelText(DOT);

    it("none for the color the classification gives the class; the Color control keeps its own", async () => {
      scoped();
      expect(dotOn("style_editor.part_fill")).toBeNull();
      expect(dotOn("style_editor.part_outline")).toBeNull();
      await openGroup("style_editor.part_fill");
      expect(within(rowOf("style_editor.color")).getByLabelText(DOT)).toBeDefined();
    });

    it("one for the class's own opacity or pattern beside the color", () => {
      scoped("classify.0.classes.1.fill.opacity", 0.4);
      expect(dotOn("style_editor.part_fill")).not.toBeNull();
      cleanup();
      scoped("classify.0.classes.1.fill.pattern", "hatch_45");
      expect(dotOn("style_editor.part_fill")).not.toBeNull();
    });

    it("none for an empty part object over a part that is on", () => {
      scoped("classify.0.classes.1.fill", {});
      expect(dotOn("style_editor.part_fill")).toBeNull();
      cleanup();
      scoped("classify.0.classes.1.outline", {});
      expect(dotOn("style_editor.part_outline")).toBeNull();
    });

    it("one for a part the class switches off", () => {
      scoped("classify.0.classes.1.outline", false);
      expect(dotOn("style_editor.part_outline")).not.toBeNull();
    });

    it("points: none for the marker color the classification gives, one for any other key of the marker", () => {
      const { store } = renderPanel(
        <PopoverProvider>
          <SymbolSection />
        </PopoverProvider>,
        {
          document: {
            version: "1.0.0",
            kind: "vector",
            symbol: { marker: { color: "#cccccc", size: 8 } },
            classify: [
              {
                id: "kind",
                field: "kind",
                method: "categories",
                classes: [
                  { id: "a", values: ["a"], marker: { color: "#ff0000" } },
                  { id: "b", values: ["b"], marker: { color: "#00ff00" } },
                ],
              },
            ],
          } as unknown as LayerStyle,
          data: { geometry: "point", fields: [{ name: "kind", type: "string", label: "kind" }] },
        }
      );
      act(() => store.setScope({ classify: 0, key: 0 }));
      expect(dotOn("style_editor.part_fill")).toBeNull();
      expect(dotOn("style_editor.part_icon")).toBeNull();
      act(() => store.set("classify.0.classes.0.marker.min_zoom", 12));
      expect(dotOn("style_editor.part_fill")).not.toBeNull();
      expect(dotOn("style_editor.part_icon")).not.toBeNull();
    });

    it("none for a key set once for the layer that the class holds (spec 6.1)", () => {
      const store = scoped("symbol.label", { text: "{density}" });
      act(() => store.set("classify.0.classes.1.label", { priority: 3 }));
      expect(dotOn("style_editor.part_label")).toBeNull();
    });

    it("none for keys of a part the layer switches off", () => {
      const store = scoped("symbol.outline", false);
      act(() => store.set("classify.0.classes.1.outline", { width: 3 }));
      expect(dotOn("style_editor.part_outline")).toBeNull();
    });

    it("one for any key of a rule", () => {
      const { store } = setup();
      act(() =>
        store.set("rules", [{ id: "r1", when: { op: "isNull", args: [{ property: "density" }] }, fill: {} }])
      );
      act(() => store.setScope({ rule: "r1", index: 0 }));
      expect(dotOn("style_editor.part_fill")).toBeNull();
      act(() => store.set("rules.0.fill.color", "#ff0000"));
      expect(dotOn("style_editor.part_fill")).not.toBeNull();
    });
  });

  describe("a row at All features follows the class records' values at its key", () => {
    const opacityShowsValue = () =>
      within(rowOf("style_editor.opacity")).queryByRole("textbox") as HTMLInputElement | null;

    it("after Fixed on the row", async () => {
      const { store } = setup();
      act(() => store.set("classify.0.classes.1.fill.opacity", 0.4));
      await openGroup("style_editor.part_fill");
      expect(opacityShowsValue()).toBeNull();
      await pickMode("style_editor.opacity", "style_editor.mode_fixed");
      expect(store.get("classify.0.classes.1.fill.opacity")).toBeUndefined();
      expect(opacityShowsValue()?.value).toBe("80");
    });

    it("after a change from outside the row", async () => {
      const { store } = setup();
      await openGroup("style_editor.part_fill");
      expect(opacityShowsValue()?.value).toBe("80");
      act(() => store.set("classify.0.classes.1.fill.opacity", 0.4));
      expect(opacityShowsValue()).toBeNull();
      act(() => store.undo());
      expect(opacityShowsValue()?.value).toBe("80");
    });

    it("the Fill editor's Pattern row too", async () => {
      const { store } = setup();
      await openGroup("style_editor.part_fill");
      const pattern = () => rowOf("style_editor.pattern").textContent;
      const before = pattern();
      act(() => store.set("classify.0.classes.1.fill.pattern", "hatch_45"));
      expect(pattern()).not.toBe(before);
      expect(pattern()).toContain("style_editor.by_field");
      act(() => store.undo());
      expect(pattern()).toBe(before);
    });

    it("the group row too, for a key of its part", () => {
      const { store } = setup();
      act(() =>
        store.set("classify", [
          {
            id: "width",
            field: "density",
            method: "manual",
            target: "outline.width",
            classes: [
              { id: "a", to: 10, outline: { width: 1 } },
              { id: "b", from: 10, outline: { width: 2 } },
            ],
          },
        ])
      );
      const fill = () => rowOf("style_editor.part_fill").textContent;
      expect(fill()).toContain("80%");
      act(() => store.set("classify.0.classes.1.fill", { opacity: 0.4 }));
      expect(fill()).not.toContain("80%");
    });
  });

  describe("the Layer section says it is layer wide while a class or a rule is scoped", () => {
    const NOTE = "style_editor.section_layer_scope_note";
    const renderBoth = () =>
      renderPanel(
        <PopoverProvider>
          <LayerSection />
          <SymbolSection />
        </PopoverProvider>,
        {
          document: {
            version: "1.0.0",
            kind: "vector",
            symbol: { fill: { color: "#cccccc" } },
            classify: [
              { id: "density", field: "density", method: "quantile", count: 4, classes: classes(4) },
            ],
            rules: [{ id: "r1", when: { op: "isNull", args: [{ property: "density" }] } }],
          } as unknown as LayerStyle,
          data: { geometry: "polygon", fields: [{ name: "density", type: "number", label: "density" }] },
        }
      ).store;

    it("in class and rule scope, not at All features", () => {
      const store = renderBoth();
      expect(screen.queryByText(NOTE)).toBeNull();
      act(() => store.setScope({ classify: 0, key: 1 }));
      expect(screen.getByText(NOTE)).toBeDefined();
      act(() => store.setScope({ rule: "r1", index: 0 }));
      expect(screen.getByText(NOTE)).toBeDefined();
      act(() => store.setScope(null));
      expect(screen.queryByText(NOTE)).toBeNull();
    });
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

  it("in scope a part the layer switches off shows off, its switch disabled, with a note", async () => {
    const { store } = setup(4, false as unknown as object);
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_fill");
    const toggle = screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText("style_editor.part_off_for_layer")).toBeDefined();
    // The class keeps its fill color, for when the layer has its fill again.
    expect(store.get("classify.0.classes.0.fill")).toEqual({ color: "#000000" });
  });

  it("the layer's main part switched off stays locked in a class: absent would draw it for all", async () => {
    const { store } = setup(4, false as unknown as object);
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_fill");
    expect(screen.queryByRole("button", { name: "style_editor.allow_per_class" })).toBeNull();
  });

  it("Allow per class turns a part off for the layer into absent, in one undo step", async () => {
    const { store } = setup();
    act(() => store.set("symbol.outline", false));
    act(() => store.setScope({ classify: 0, key: 1 }));
    await openGroup("style_editor.part_outline");
    expect(screen.getByText("style_editor.part_off_for_layer_allow")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.allow_per_class" }));
    // Still off for every feature: absent is off for a part that is not the geometry's main part.
    expect(store.get("symbol.outline")).toBeUndefined();
    expect(screen.queryByText("style_editor.part_off_for_layer_allow")).toBeNull();
    expect(screen.getByText("style_editor.part_off_note")).toBeDefined();
    const toggle = screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    await userEvent.click(toggle);
    expect(store.get("classify.0.classes.1.outline")).toEqual({});
    expect(store.get("symbol.outline")).toBeUndefined();
    act(() => store.undo());
    act(() => store.undo());
    expect(store.get("symbol.outline")).toBe(false);
  });

  it("a class's own part comes back on the map once the layer allows it per class", async () => {
    const { store } = setup();
    act(() =>
      store.update((doc) =>
        setIn(setIn(doc, "symbol.outline", false), "classify.0.classes.0.outline", { width: 3 })
      )
    );
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_outline");
    await userEvent.click(screen.getByRole("button", { name: "style_editor.allow_per_class" }));
    const toggle = screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(store.get("classify.0.classes.0.outline")).toEqual({ width: 3 });
  });

  it("the row of a part off for the layer reads None for all features and Off for all in a class", () => {
    const { store } = setup();
    act(() => store.set("symbol.outline", false));
    expect(within(rowOf("style_editor.part_outline")).getByText("style_editor.none")).toBeDefined();
    expect(
      within(rowOf("style_editor.part_outline")).queryByText("style_editor.part_off_for_all")
    ).toBeNull();
    // In class scope: the class cannot draw it.
    act(() => store.setScope({ classify: 0, key: 0 }));
    expect(
      within(rowOf("style_editor.part_outline")).getByText("style_editor.part_off_for_all")
    ).toBeDefined();
    act(() => store.setScope(null));
    act(() => store.set("symbol.outline", undefined));
    expect(within(rowOf("style_editor.part_outline")).getByText("style_editor.none")).toBeDefined();
    // A class that switches the part off itself reads None in its scope.
    act(() => store.set("symbol.outline", { width: 1 }));
    act(() => store.set("classify.0.classes.0.outline", false));
    act(() => store.setScope({ classify: 0, key: 0 }));
    expect(within(rowOf("style_editor.part_outline")).getByText("style_editor.none")).toBeDefined();
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
