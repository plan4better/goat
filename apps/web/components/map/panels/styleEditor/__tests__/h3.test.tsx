import { configureStore } from "@reduxjs/toolkit";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { initView, mapReducer } from "@/lib/store/map/slice";
import { shade } from "@/lib/style/colors";
import { paletteList } from "@/lib/style/editor/paletteList";
import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { GeneralSection } from "@/components/map/panels/styleEditor/sections/GeneralSection";
import { H3Section } from "@/components/map/panels/styleEditor/sections/H3Section";

import { choose, pickColor, renderPanel } from "./renderPanel";

const FIELDS = [{ name: "pupils", type: "integer" as const, label: "Pupils" }];

vi.mock("react-toastify", () => ({ toast: Object.assign(() => 0, { info: () => 0, dismiss: () => 0 }) }));

function setup(render: object = { type: "h3" }) {
  const redux = configureStore({ reducer: { map: mapReducer } });
  redux.dispatch(initView({ projectId: "p1", mode: "2d", projection: "mercator" }));
  const result = renderPanel(
    <Provider store={redux}>
      <PopoverProvider>
        <GeneralSection />
        <H3Section />
      </PopoverProvider>
    </Provider>,
    {
      document: { version: "1.0.0", kind: "vector", render } as LayerStyle,
      data: { geometry: "point", fields: FIELDS, fieldTypes: { pupils: "integer" } },
    }
  );
  return { ...result, redux };
}

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;
/** The section's row of `label` (an open popover's title says it too, after it in the page). */
const sectionRow = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;
const openColors = () => userEvent.click(within(sectionRow("style_editor.colors")).getByRole("button"));
const openOutline = () =>
  userEvent.click(within(sectionRow("style_editor.part_outline")).getByRole("button"));
const palette = () => screen.queryByRole("group", { name: "style_editor.palette" });

/** The CSS background of a swatch element, as its style rule writes it. */
function backgroundOf(el: Element): string {
  const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("");
  const own = [...el.classList].filter((c) => c.startsWith("css-"));
  for (const name of own) {
    const rule = new RegExp(`\\.${name}\\{[^}]*?background:([^;}]*)`).exec(css);
    if (rule) return rule[1];
  }
  return "";
}

/** The option at `index` of a row's list (options share their label key under the test translations). */
async function pick(label: string, index: number): Promise<void> {
  await userEvent.click(within(rowOf(label)).getByRole("combobox"));
  await userEvent.click(within(screen.getByRole("listbox")).getAllByRole("option")[index]);
}

describe("H3 hexagons", () => {
  it("draw as offers H3 hexagons, which shows their section", async () => {
    const { store } = setup({ type: "features" });
    expect(screen.queryByText("style_editor.section_h3")).toBeNull();
    await pick("style_editor.draw_as", 3);
    expect(store.get("render")).toEqual({ type: "h3" });
    expect(screen.getByText("style_editor.section_h3")).toBeDefined();
  });

  it("the size is automatic until a resolution is picked", async () => {
    const { store } = setup();
    await pick("style_editor.h3_size", 4);
    expect(store.get("render.resolution")).toBe(8);
    await pick("style_editor.h3_size", 0);
    expect(store.get("render.resolution")).toBeUndefined();
  });

  it("a hexagon's value is its points, or a numeric field's sum or mean", async () => {
    const { store } = setup();
    await choose("style_editor.h3_value", "style_editor.h3_value_count", "style_editor.h3_value_mean");
    expect(store.get("render.value")).toEqual({ op: "mean", field: "pupils" });
    await choose("style_editor.h3_value", "style_editor.h3_value_mean", "style_editor.h3_value_count");
    expect(store.get("render.value")).toBeUndefined();
  });

  it("the panel shows one Colors row; its editor holds the Palette, Classes and the ramp's colors", async () => {
    const { store } = setup();
    expect(palette()).toBeNull();
    expect(screen.queryByText("style_editor.classes")).toBeNull();
    expect(screen.queryByText("style_editor.palette")).toBeNull();
    await openColors();
    const order = [
      screen.getByText("style_editor.palette"),
      screen.getByText("style_editor.classes"),
      palette()!,
    ];
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Opening the panel and the editor writes nothing.
    expect(store.get("render")).toEqual({ type: "h3" });
  });

  it("the ramp's colors are edited, added and deleted in the Colors editor, writing render.palette", async () => {
    const { store } = setup();
    await openColors();
    const steps = paletteList("colorbrewer:OrRd");
    const list = palette()!;
    const swatches = () => within(list).getAllByRole("button", { name: "style_editor.palette_color" });
    expect(swatches()).toHaveLength(steps.length);
    await userEvent.click(within(list).getAllByRole("button", { name: "style_editor.remove_color" })[0]);
    expect(store.get("render.palette")).toEqual(steps.slice(1));
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_color" }));
    expect(store.get("render.palette")).toEqual([...steps.slice(1), steps[steps.length - 1]]);
    window.localStorage.removeItem("goat.color-format");
    await userEvent.click(swatches()[0]);
    const box = screen.getAllByRole("textbox", { name: "color_value" }).at(-1) as HTMLElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "#123456" } });
    expect((store.get("render.palette") as string[])[0]).toBe("#123456");
  });

  it("a palette picked in the Colors editor writes render.palette and drops the classes' own palette", async () => {
    const { store } = setup({
      type: "h3",
      classify: { method: "quantile", count: 5, palette: "goat:green" },
    });
    await openColors();
    await userEvent.click(within(sectionRow("style_editor.palette")).getByRole("button"));
    await userEvent.click(screen.getByRole("button", { name: "Blues" }));
    expect(store.get("render.palette")).toBe("colorbrewer:Blues");
    expect(store.get("render.classify")).toEqual({ method: "quantile", count: 5 });
  });

  it("with classes the Colors editor lists no ramp colors", async () => {
    setup({ type: "h3", classify: { method: "quantile", count: 5 } });
    await openColors();
    expect(screen.getByText("style_editor.count")).toBeDefined();
    expect(palette()).toBeNull();
  });

  it("classes take a method and a count; continuous drops them", async () => {
    const { store } = setup();
    await openColors();
    expect(screen.queryByText("style_editor.count")).toBeNull();
    await choose("style_editor.classes", "style_editor.h3_continuous", "style_editor.method_quantile");
    expect(store.get("render.classify")).toEqual({ method: "quantile", count: 5 });
    await pick("style_editor.count", 0);
    expect(store.get("render.classify")).toEqual({ method: "quantile", count: 2 });
    await pick("style_editor.count", 10);
    expect(store.get("render.classify")).toEqual({ method: "quantile", count: 12 });
    await choose("style_editor.classes", "style_editor.method_quantile", "style_editor.h3_continuous");
    expect(store.get("render.classify")).toBeUndefined();
  });

  it("geometric intervals are a method of the hexagons' classes too", async () => {
    const { store } = setup();
    await openColors();
    await choose(
      "style_editor.classes",
      "style_editor.h3_continuous",
      "style_editor.method_geometric_interval"
    );
    expect(store.get("render.classify")).toEqual({ method: "geometric_interval", count: 5 });
  });

  it("a stored count outside 2 to 13 shows as picked and stays", async () => {
    const { store } = setup({ type: "h3", classify: { method: "quantile", count: 20 } });
    await openColors();
    await userEvent.click(within(rowOf("style_editor.count")).getByRole("combobox"));
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(13);
    expect(options[12].getAttribute("aria-selected")).toBe("true");
    expect(store.get("render.classify.count")).toBe(20);
  });

  it("opacity and the points' zoom write the render", async () => {
    const { store } = setup();
    fireEvent.change(within(rowOf("style_editor.opacity")).getByRole("slider"), { target: { value: 0.5 } });
    expect(store.get("render.opacity")).toBe(0.5);
    await userEvent.click(within(sectionRow("style_editor.points")).getByRole("button"));
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("render.points_from_zoom")).toBe(10);
  });

  /** The Outline row's summary and the CSS background of its swatch. */
  const outlineRow = () => {
    const button = within(sectionRow("style_editor.part_outline")).getByRole("button");
    const swatch = button.querySelector("div");
    return { text: button.textContent, swatch: swatch ? backgroundOf(swatch) : "" };
  };

  it("the outline row sums up a fixed color as its swatch and width", () => {
    setup({ type: "h3", outline: { color: "#ff0000", width: 2 } });
    expect(outlineRow()).toEqual({ text: "2 px", swatch: "#ff0000" });
  });

  /** The Outline editor's header switch. */
  const outlineSwitch = () => screen.getByRole("checkbox", { name: /style_editor.turn_part_/ });

  it("an outline left unset is off: the row reads None, the editor's switch is off, and opening writes nothing", async () => {
    const { store } = setup();
    expect(outlineRow()).toEqual({ text: "style_editor.none", swatch: "" });
    await openOutline();
    expect((outlineSwitch() as HTMLInputElement).checked).toBe(false);
    expect(outlineSwitch().getAttribute("aria-label")).toBe("style_editor.turn_part_on");
    expect(screen.getByText("style_editor.part_off_note")).toBeDefined();
    expect(screen.queryByText("style_editor.color")).toBeNull();
    expect(store.document).toEqual({ version: "1.0.0", kind: "vector", render: { type: "h3" } });
    expect(store.canUndo).toBe(false);
  });

  it("switching the outline on writes an empty outline (white, 1 px); off removes it; one undo step each", async () => {
    const { store } = setup();
    await openOutline();
    await userEvent.click(outlineSwitch());
    expect(store.get("render.outline")).toEqual({});
    expect(outlineRow()).toEqual({ text: "1 px", swatch: "#ffffff" });
    expect(screen.getByText("style_editor.color")).toBeDefined();
    act(() => store.undo());
    expect(store.get("render")).toEqual({ type: "h3" });
    expect(store.canUndo).toBe(false);
    act(() => store.redo());
    expect(store.get("render.outline")).toEqual({});
    await userEvent.click(outlineSwitch());
    expect(store.get("render")).toEqual({ type: "h3" });
    expect(outlineRow().text).toBe("style_editor.none");
    expect(screen.getByText("style_editor.part_off_note")).toBeDefined();
    act(() => store.undo());
    expect(store.get("render.outline")).toEqual({});
  });

  it("switched off and on again, the outline comes back with its color and width", async () => {
    const { store } = setup({ type: "h3", outline: { color: "#ff0000", width: 2 } });
    await openOutline();
    expect((outlineSwitch() as HTMLInputElement).checked).toBe(true);
    await pickColor(rowOf("style_editor.color"), "#336699");
    fireEvent.change(within(rowOf("style_editor.width")).getByRole("slider"), { target: { value: 3 } });
    await userEvent.click(outlineSwitch());
    expect(store.get("render.outline")).toBeUndefined();
    await userEvent.click(outlineSwitch());
    expect(store.get("render.outline")).toEqual({ color: "#336699", width: 3 });
    expect(outlineRow()).toEqual({ text: "3 px", swatch: "#336699" });
  });

  it("an Auto outline reads Auto before the width over the shade of each hexagon's color", () => {
    // Cells with computed values draw the ramp; until then one hexagon color, and its shade.
    const { unmount } = setup({ type: "h3", palette: ["#7f3c8d", "#e68310"], outline: { color: "auto" } });
    expect(outlineRow()).toEqual({ text: "style_editor.auto · 1 px", swatch: shade("#e68310") });
    unmount();
    setup({
      type: "h3",
      resolution: 8,
      palette: ["#7f3c8d", "#e68310"],
      outline: { color: "auto" },
      computed: { resolutions: { "8": { min: 0, max: 10 } } },
    });
    expect(outlineRow()).toEqual({
      text: "style_editor.auto · 1 px",
      swatch: `linear-gradient(90deg, ${shade("#7f3c8d")}, ${shade("#e68310")})`,
    });
  });

  it("a None outline reads None", () => {
    setup({ type: "h3", outline: { color: "#ffffff00", width: 1 } });
    expect(outlineRow().text).toBe("style_editor.none");
  });

  it("the outline's editor writes its color and width", async () => {
    const { store } = setup({ type: "h3", outline: {} });
    await openOutline();
    await pickColor(rowOf("style_editor.color"), "#336699");
    expect(store.get("render.outline.color")).toBe("#336699");
    fireEvent.change(within(rowOf("style_editor.width")).getByRole("slider"), { target: { value: 2.5 } });
    expect(store.get("render.outline.width")).toBe(2.5);
    expect(outlineRow().text).toBe("2.5 px");
  });

  it("the outline's width takes a number past the slider's end", async () => {
    const { store } = setup({ type: "h3", outline: {} });
    await openOutline();
    const box = within(rowOf("style_editor.width")).getByRole("textbox");
    fireEvent.change(box, { target: { value: "12" } });
    fireEvent.blur(box);
    expect(store.get("render.outline.width")).toBe(12);
  });

  it("in a class's or a rule's scope the outline's editor still writes the layer's render", async () => {
    const records = {
      classify: [
        { field: "pupils", method: "categories", classes: [{ values: ["1"], marker: { color: "#ff0000" } }] },
      ],
      rules: [{ id: "r1", when: { field: "pupils", op: "eq", value: 1 }, marker: { color: "#00ff00" } }],
    };
    const { store, unmount } = setup({ type: "h3", points_from_zoom: 14, outline: {} });
    act(() => store.update((doc) => ({ ...doc, ...records }) as LayerStyle));
    for (const scope of [
      { classify: 0, key: 0 },
      { rule: "r1", index: 0 },
    ]) {
      act(() => store.setScope(scope));
      await openOutline();
      await pickColor(rowOf("style_editor.color"), "#336699");
      fireEvent.change(within(rowOf("style_editor.width")).getByRole("slider"), { target: { value: 3 } });
      expect(store.get("render.outline")).toEqual({ color: "#336699", width: 3 });
      expect(store.get("classify")).toEqual(records.classify);
      expect(store.get("rules")).toEqual(records.rules);
      await userEvent.click(screen.getAllByRole("button", { name: "style_editor.close" })[0]);
      act(() =>
        store.update(
          (doc) => ({ ...doc, render: { type: "h3", points_from_zoom: 14, outline: {} } }) as LayerStyle
        )
      );
    }
    unmount();
  });

  /** Opens the Colors editor, its palette picker and back, then the Outline editor. */
  async function openEverything() {
    await openColors();
    const paletteRow = () => within(sectionRow("style_editor.palette")).getByRole("button");
    await userEvent.click(paletteRow());
    expect(screen.getByRole("button", { name: "Blues" })).toBeDefined();
    await userEvent.click(paletteRow());
    expect(screen.queryByRole("button", { name: "Blues" })).toBeNull();
    await openOutline();
    expect(screen.getByText("style_editor.color")).toBeDefined();
  }

  it("opening the panel and every editor leaves a stored style as written", async () => {
    const stored = [
      {
        type: "h3",
        palette: ["#000000", "#ff0000", "#ffffff"],
        reverse: true,
        classify: { method: "quantile", count: 5, palette: "goat:green" },
        outline: { color: "#336699", width: 12 },
      },
      {
        type: "h3",
        palette: ["#000000", "#ff0000", "#ffffff"],
        reverse: true,
        outline: { color: "auto", width: 1.25 },
      },
    ];
    const reads = ["12 px", "style_editor.auto · 1.25 px"];
    for (const [i, render] of stored.entries()) {
      const { store, unmount } = setup(structuredClone(render));
      const before = structuredClone(store.document);
      expect(outlineRow().text).toBe(reads[i]);
      await openEverything();
      expect(store.document).toEqual(before);
      expect(store.canUndo).toBe(false);
      expect(outlineRow().text).toBe(reads[i]);
      unmount();
    }
  });

  it("the Colors editor closes when Draw as changes and its row goes", async () => {
    const { store } = setup();
    await openColors();
    expect(screen.getByText("style_editor.palette")).toBeDefined();
    act(() => store.set("render", { type: "heatmap" }));
    expect(screen.queryByText("style_editor.section_h3")).toBeNull();
    expect(screen.queryByText("style_editor.palette")).toBeNull();
    expect(screen.queryByText("style_editor.colors")).toBeNull();
  });

  it("the Outline editor closes when the hexagons are extruded and its row goes", async () => {
    const { store } = setup({ type: "h3", outline: {} });
    await openOutline();
    expect(screen.getByText("style_editor.color")).toBeDefined();
    act(() => store.set("render.extrude", {}));
    expect(screen.queryByText("style_editor.part_outline")).toBeNull();
    expect(screen.queryByText("style_editor.color")).toBeNull();
  });

  it("the outline's color offers Auto and None", async () => {
    const { store } = setup({ type: "h3", outline: {} });
    await openOutline();
    await userEvent.click(
      within(rowOf("style_editor.color")).getByRole("button", { name: "style_editor.pick_color" })
    );
    await userEvent.click(screen.getByRole("button", { name: "style_editor.auto" }));
    expect(store.get("render.outline.color")).toBe("auto");
    const none = screen
      .getAllByRole("button", { name: "style_editor.none" })
      .find((b) => b.hasAttribute("aria-pressed"));
    await userEvent.click(none!);
    // None keeps the hue the outline draws, at 0 %.
    expect(store.get("render.outline.color")).toMatch(/^#[0-9a-f]{6}00$/);
  });

  /** The section's Height row (the popover's title says Height too, after it in the page). */
  const heightRow = () => screen.getAllByText("style_editor.height")[0].parentElement as HTMLElement;

  it("the Height editor closes when Draw as changes and its row goes", async () => {
    const { store } = setup({ type: "h3", extrude: { tallest: 1500 } });
    await userEvent.click(within(heightRow()).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.h3_scale")).toBeDefined();
    act(() => store.set("render", { type: "heatmap" }));
    expect(screen.queryByText("style_editor.section_h3")).toBeNull();
    expect(screen.queryByText("style_editor.h3_scale")).toBeNull();
    expect(screen.queryByText("style_editor.height")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "style_editor.turn_part_off" })).toBeNull();
  });

  it("height switched off and on again brings back Tallest and the scale; opening writes nothing", async () => {
    const { store } = setup({ type: "h3", extrude: { tallest: 1500 } });
    // The row's own button (on a 2D map a link to show 3D follows it).
    await userEvent.click(within(heightRow()).getAllByRole("button")[0]);
    expect(store.get("render")).toEqual({ type: "h3", extrude: { tallest: 1500 } });
    expect(store.canUndo).toBe(false);
    await userEvent.click(within(rowOf("style_editor.h3_scale")).getAllByRole("button")[0]);
    expect(store.get("render.extrude")).toEqual({ tallest: 1500, scale: "linear" });
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("render")).toEqual({ type: "h3" });
    expect(screen.getByText("style_editor.part_off_note")).toBeDefined();
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("render.extrude")).toEqual({ tallest: 1500, scale: "linear" });
  });

  it("height: a group row whose popover switches columns on (tilting once), writes Tallest and Scale, and off", async () => {
    const { store, redux } = setup();
    expect(screen.getByText("style_editor.part_outline")).toBeDefined();
    expect(within(heightRow()).getByText("style_editor.none")).toBeDefined();
    await userEvent.click(within(heightRow()).getByRole("button"));
    expect(screen.getByText("style_editor.part_off_note")).toBeDefined();
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("render.extrude")).toEqual({});
    expect(redux.getState().map.view?.mode).toBe("3d");
    expect(within(heightRow()).getByText("style_editor.h3_height_value")).toBeDefined();
    // The outline is not drawn under columns.
    expect(screen.queryByText("style_editor.part_outline")).toBeNull();
    fireEvent.change(within(rowOf("style_editor.h3_tallest")).getByRole("slider"), {
      target: { value: 1500 },
    });
    expect(store.get("render.extrude.tallest")).toBe(1500);
    await userEvent.click(within(rowOf("style_editor.h3_scale")).getAllByRole("button")[0]);
    expect(store.get("render.extrude.scale")).toBe("linear");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("render.extrude")).toBeUndefined();
    expect(screen.getByText("style_editor.part_outline")).toBeDefined();
  });
});
