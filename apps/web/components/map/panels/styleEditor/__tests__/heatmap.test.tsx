import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { paletteList } from "@/lib/style/editor/paletteList";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";

import type { FieldProfile, ProfileSource } from "@/components/map/panels/styleEditor/context";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { HeatmapSection } from "@/components/map/panels/styleEditor/sections/HeatmapSection";

import { choose, i18n, renderPanel } from "./renderPanel";

const FIELDS = [{ name: "visitors", type: "integer" as const, label: "visitors" }];

function profiles(known: Record<string, FieldProfile>): ProfileSource {
  return { get: (f) => known[f], load: () => undefined, subscribe: () => () => undefined };
}

function setup(
  render: object = { type: "heatmap" },
  known: Record<string, FieldProfile> = {},
  source: ProfileSource = profiles(known)
) {
  return renderPanel(
    <PopoverProvider>
      <HeatmapSection />
    </PopoverProvider>,
    {
      document: { version: "1.0.0", kind: "vector", render } as LayerStyle,
      data: {
        geometry: "point",
        fields: FIELDS,
        fieldTypes: { visitors: "integer" },
        profiles: source,
      },
    }
  );
}

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;
const intensityBox = () =>
  screen.getByRole("textbox", { name: "style_editor.intensity" }) as HTMLInputElement;
const opacityBox = () => screen.getByRole("textbox", { name: "style_editor.opacity" }) as HTMLInputElement;

const sectionRow = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;
const openColors = () => userEvent.click(within(sectionRow("style_editor.colors")).getByRole("button"));
const palette = () => screen.queryByRole("group", { name: "style_editor.palette" });

describe("heatmap", () => {
  it("the panel shows one Colors row; its editor holds the Palette and the ramp's colors, no Classes", async () => {
    const { store } = setup();
    expect(palette()).toBeNull();
    expect(screen.queryByText("style_editor.palette")).toBeNull();
    await openColors();
    const row = screen.getByText("style_editor.palette");
    expect(row.compareDocumentPosition(palette()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("style_editor.classes")).toBeNull();
    expect(store.get("render")).toEqual({ type: "heatmap" });
  });

  it("the ramp's colors are added and deleted in the Colors editor, writing render.palette", async () => {
    const { store } = setup({ type: "heatmap", palette: ["#000000", "#808080", "#ffffff"] });
    await openColors();
    await userEvent.click(
      within(palette()!).getAllByRole("button", { name: "style_editor.remove_color" })[1]
    );
    expect(store.get("render.palette")).toEqual(["#000000", "#ffffff"]);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_color" }));
    expect(store.get("render.palette")).toEqual(["#000000", "#ffffff", "#ffffff"]);
    // Edits of the list in quick succession are one undo step, as edits of one key are.
    act(() => store.undo());
    expect(store.get("render.palette")).toEqual(["#000000", "#808080", "#ffffff"]);
  });

  it("opening the panel, the Colors editor and its palette picker leaves a stored style as written", async () => {
    const { store } = setup({ type: "heatmap", palette: ["#000000", "#ff0000", "#ffffff"], reverse: true });
    const before = structuredClone(store.document);
    await openColors();
    const paletteRow = () => within(sectionRow("style_editor.palette")).getByRole("button");
    await userEvent.click(paletteRow());
    expect(screen.getByRole("button", { name: "Blues" })).toBeDefined();
    await userEvent.click(paletteRow());
    expect(screen.queryByRole("button", { name: "Blues" })).toBeNull();
    expect(store.document).toEqual(before);
    expect(store.canUndo).toBe(false);
  });

  it("the Colors editor closes when Draw as changes and its row goes", async () => {
    const { store } = setup();
    await openColors();
    expect(screen.getByText("style_editor.palette")).toBeDefined();
    act(() => store.set("render", { type: "h3" }));
    expect(screen.queryByText("style_editor.section_heatmap")).toBeNull();
    expect(screen.queryByText("style_editor.palette")).toBeNull();
    expect(screen.queryByText("style_editor.colors")).toBeNull();
  });

  it("the Palette row opens the palette picker, which writes render.palette", async () => {
    const { store } = setup();
    await openColors();
    expect(within(palette()!).getAllByRole("button", { name: "style_editor.palette_color" })).toHaveLength(
      paletteList(DEFAULTS["heatmap.palette"] as string).length
    );
    await userEvent.click(within(sectionRow("style_editor.palette")).getByRole("button"));
    await userEvent.click(screen.getByRole("button", { name: "Blues" }));
    expect(store.get("render.palette")).toBe("colorbrewer:Blues");
  });

  it("opacity writes render.opacity", () => {
    const { store } = setup();
    fireEvent.change(within(rowOf("style_editor.opacity")).getByRole("slider"), { target: { value: 0.6 } });
    expect(store.get("render.opacity")).toBe(0.6);
  });

  it("the Opacity row reads a percent", () => {
    setup();
    expect(opacityBox().value).toBe("100");
    expect(within(rowOf("style_editor.opacity")).getByText("%")).toBeDefined();
  });

  it("the Intensity row reads the stored number, with no unit", () => {
    setup();
    expect(intensityBox().value).toBe("1");
    expect(within(rowOf("style_editor.intensity")).queryByText("%")).toBeNull();
  });

  it("the Intensity row reads its number in the panel's language", async () => {
    await act(() => i18n.changeLanguage("de"));
    try {
      setup({ type: "heatmap", intensity: 1.6 });
      expect(intensityBox().value).toBe("1,6");
    } finally {
      await act(() => i18n.changeLanguage("en"));
    }
  });

  it("a drag, a step or a typed number writes render.intensity as the number shown", () => {
    const { store } = setup({ type: "heatmap", intensity: 1.6 });
    const slider = within(rowOf("style_editor.intensity")).getByRole("slider");
    // A press on the track at 1.45 / 2.8 of its width: 0.2 + 29 steps of 0.05, which floating point adds up to
    // 1.6500000000000001; the slider lands on the step.
    const track = rowOf("style_editor.intensity").querySelector(".MuiSlider-root") as HTMLElement;
    track.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 280, bottom: 20, width: 280, height: 20, x: 0, y: 0 }) as DOMRect;
    fireEvent.mouseDown(track, { button: 0, clientX: 145, clientY: 10 });
    fireEvent.mouseUp(document, { button: 0, clientX: 145, clientY: 10 });
    expect(store.get("render.intensity")).toBe(1.65);
    expect(intensityBox().value).toBe("1.65");
    fireEvent.change(slider, { target: { value: 2.5 } });
    expect(store.get("render.intensity")).toBe(2.5);
    expect(intensityBox().value).toBe("2.5");
    fireEvent.change(intensityBox(), { target: { value: "0.8" } });
    expect(store.get("render.intensity")).toBe(0.8);
    fireEvent.change(intensityBox(), { target: { value: "2.5" } });
    expect(store.get("render.intensity")).toBe(2.5);
  });

  it("an intensity by zoom shows its stops and its summary as plain numbers", async () => {
    const { store } = setup({
      type: "heatmap",
      intensity: {
        zoom: [
          [0, 1],
          [12, 2.5],
        ],
      },
    });
    const opener = within(rowOf("style_editor.intensity"))
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("→"))!;
    expect(opener.textContent).toBe("1 → 2.5");
    await userEvent.click(opener);
    // The stop nearest the map's zoom (12) is selected.
    const value = screen.getByRole("textbox", { name: "style_editor.value" }) as HTMLInputElement;
    expect(value.value).toBe("2.5");
    expect(within(rowOf("style_editor.value")).queryByText("%")).toBeNull();
    fireEvent.change(value, { target: { value: "1.8" } });
    expect(store.get("render.intensity.zoom")).toEqual([
      [0, 1],
      [12, 1.8],
    ]);
  });

  it("a weight field writes its range from the field's profile; the range can be typed", async () => {
    const { store } = setup({ type: "heatmap" }, { visitors: { min: 0, max: 50000 } });
    await choose("style_editor.weight", "style_editor.weight_once", "style_editor.by_field");
    await waitFor(() =>
      expect(store.get("render.weight")).toEqual({ field: "visitors", domain: [0, 50000] })
    );
    const highest = screen.getByRole("textbox", { name: "style_editor.range_highest" });
    fireEvent.change(highest, { target: { value: "20000" } });
    // The range's boxes take their number when left.
    fireEvent.blur(highest);
    expect(store.get("render.weight.domain")).toEqual([0, 20000]);
  });

  it("a range that arrives after the pick never comes back after undo", async () => {
    const listeners = new Set<() => void>();
    let known: Record<string, FieldProfile> = {};
    const source: ProfileSource = {
      get: (f) => known[f],
      load: () => undefined,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const { store } = setup({ type: "heatmap" }, {}, source);
    await choose("style_editor.weight", "style_editor.weight_once", "style_editor.by_field");
    expect(store.get("render.weight")).toEqual({ field: "visitors" });
    act(() => {
      known = { visitors: { min: 0, max: 50000 } };
      listeners.forEach((listener) => listener());
    });
    await waitFor(() =>
      expect(store.get("render.weight")).toEqual({ field: "visitors", domain: [0, 50000] })
    );
    for (let i = 0; i < 5 && store.canUndo; i++) act(() => store.undo());
    expect(store.get("render.weight")).toBeUndefined();
    expect(store.canRedo).toBe(true);
  });
});
