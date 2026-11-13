import { configureStore } from "@reduxjs/toolkit";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { layerReducer, setStyleClipboard } from "@/lib/store/layer/slice";
import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { StyleSaver } from "@/lib/style/save";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import { NamedStyles } from "@/components/map/panels/styleEditor/NamedStyles";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";

import { echoTransport, renderPanel } from "./renderPanel";

const api = vi.hoisted(() => ({
  createNamedStyle: vi.fn(async () => ({ id: "n1" })),
  updateNamedStyle: vi.fn(async () => ({})),
  deleteNamedStyle: vi.fn(async () => undefined),
  setStyleAsDefault: vi.fn(async () => ({})),
}));
/** The dataset's default style and the other styles' stored documents. */
const ds = vi.hoisted(() => ({ dataset: undefined as unknown, others: {} as Record<string, unknown> }));
vi.mock("@/lib/api/map", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
  useDatasetStyle: () => ({ style: ds.dataset ? { document: ds.dataset } : undefined, error: undefined }),
  useProjectStyles: () => ({
    styles: Object.fromEntries(Object.entries(ds.others).map(([id, document]) => [id, { document }])),
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("react-toastify", () => ({ toast }));

const POLYGON = { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;
const POINT = { version: 1, kind: "vector", symbol: { marker: { color: "#ff0000" } } } as LayerStyle;

const layerWith = (others: string[], position = 0) =>
  ({
    id: 5,
    layer_id: "dataset-5",
    name: "Districts",
    type: "feature",
    feature_layer_geometry_type: "polygon",
    visible: true,
    entry: { type: "layer", id: 5 },
    style: { id: "a", name: "Default", position, revision: 1, document: POLYGON, issues: [], stale: false },
    otherStyles: others.map((name, i) => ({ id: `o${i}`, name })),
  }) as unknown as MapLayer;

function setup(layer: MapLayer, opts: { canSetDefault?: boolean } = {}) {
  const reduxStore = configureStore({ reducer: { layers: layerReducer } });
  const editor = new EditorStore({
    saver: new StyleSaver({ transport: echoTransport(), document: POLYGON, revision: 1 }),
  });
  const onSwitch = vi.fn(async () => undefined);
  const onChanged = vi.fn(async () => undefined);
  const view = renderPanel(
    <Provider store={reduxStore}>
      <PopoverProvider>
        <NamedStyles
          projectId="p1"
          layer={layer}
          store={editor}
          kind="vector"
          geometry="polygon"
          canSetDefault={opts.canSetDefault ?? false}
          onSwitch={onSwitch}
          onChanged={onChanged}
        />
      </PopoverProvider>
    </Provider>
  );
  return { reduxStore, editor, onSwitch, onChanged, unmount: view.unmount };
}

/** The pill names the active style; it opens the styles beside the panel. */
const openStyles = () =>
  userEvent.click(screen.getByRole("button", { name: "style_editor.styles: Default" }));
const button = (name: string | RegExp) => screen.getByRole("button", { name });
/** An item of a style's menu (the layer list's menu: its items are buttons). */
const item = (name: string) => screen.getByRole("button", { name });
/** A style's own menu, from its row's ⋯. */
const openMenu = () => userEvent.click(screen.getAllByRole("button", { name: "style_editor.style_more" })[0]);

describe("named styles", () => {
  beforeEach(() => {
    [...Object.values(api), ...Object.values(toast)].forEach((fn) => fn.mockClear());
    ds.dataset = undefined;
    ds.others = {};
  });

  it("the toolbar shows the active style, the save state and undo/redo", () => {
    setup(layerWith(["Other"]));
    expect(button("style_editor.styles: Default")).toBeDefined();
    expect(screen.getByRole("status", { name: "style_editor.status_saved" })).toBeDefined();
    expect(button("style_editor.undo")).toBeDefined();
  });

  it("the pill is the panel's pill: it says it opens the styles and whether they show", async () => {
    setup(layerWith(["Night"]));
    const pill = button("style_editor.styles: Default");
    expect(pill.getAttribute("aria-haspopup")).toBe("dialog");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    await openStyles();
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    await openStyles();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
  });

  it("the popover lists the styles, the active one selected; a click switches", async () => {
    const { onSwitch } = setup(layerWith(["Night"]));
    await openStyles();
    expect(screen.getByRole("list", { name: "style_editor.styles" })).toBeDefined();
    expect(button("Default").classList.contains("Mui-selected")).toBe(true);
    // As the app's menus mark the option in force: a check, no fill.
    expect(button("Default").querySelectorAll("svg")).toHaveLength(1);
    expect(button("Night").querySelectorAll("svg")).toHaveLength(0);
    expect(getComputedStyle(button("Default")).backgroundColor).toMatch(/^(rgba\(0, 0, 0, 0\)|transparent)$/);
    await userEvent.click(button("Night"));
    // Selected at once, while the switch is on its way.
    expect(button("Night").classList.contains("Mui-selected")).toBe(true);
    expect(button("Default").classList.contains("Mui-selected")).toBe(false);
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith("o0");
  });

  it("a new style becomes the active one with its name ready to type", async () => {
    const { onSwitch, onChanged } = setup(layerWith(["Other"]));
    await openStyles();
    await userEvent.click(button("style_editor.new_style"));
    expect(api.createNamedStyle).toHaveBeenCalledWith("p1", 5, { name: "style_editor.new_style_name" });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("n1"));
    // The switch brings the new list along: no second map request.
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("each style's menu: rename, duplicate, move, delete (not the last)", async () => {
    const { onChanged } = setup(layerWith(["Other"]));
    await openStyles();
    await openMenu();
    await userEvent.click(item("rename"));
    const field = screen.getByRole("textbox", { name: "name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Night{Enter}");
    expect(api.updateNamedStyle).toHaveBeenLastCalledWith("p1", 5, "a", { name: "Night" });
    await openMenu();
    await userEvent.click(item("duplicate"));
    expect(api.createNamedStyle).toHaveBeenLastCalledWith("p1", 5, {
      name: "style_editor.copy_of",
      copy_from: "a",
    });
    await openMenu();
    expect(item("style_editor.move_style_up").getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(item("style_editor.move_style_down"));
    expect(api.updateNamedStyle).toHaveBeenLastCalledWith("p1", 5, "a", { position: 1 });
    await openMenu();
    await userEvent.click(item("delete"));
    expect(api.deleteNamedStyle).toHaveBeenCalledWith("p1", 5, "a");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(4));
  });

  it("a double click renames in place; Escape keeps the name", async () => {
    setup(layerWith(["Other"]));
    await openStyles();
    await userEvent.dblClick(button("Other"));
    const field = screen.getByRole("textbox", { name: "name" });
    await userEvent.type(field, "x{Escape}");
    expect(api.updateNamedStyle).not.toHaveBeenCalled();
    expect(button("Other")).toBeDefined();
  });

  it("the last style cannot be deleted; at ten styles none can be added", async () => {
    const first = setup(layerWith([]));
    await openStyles();
    await openMenu();
    expect(item("delete").getAttribute("aria-disabled")).toBe("true");
    first.unmount();
    setup(layerWith(Array.from({ length: 9 }, (_, i) => `S${i}`)));
    await openStyles();
    expect((button("style_editor.new_style") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("style_editor.styles_full")).toBeDefined();
    await openMenu();
    expect(item("duplicate").getAttribute("aria-disabled")).toBe("true");
  });

  it("paste only for the same kind and geometry, as one undo step", async () => {
    const { reduxStore, editor } = setup(layerWith([]));
    act(() => {
      reduxStore.dispatch(
        setStyleClipboard({ sourceLayerName: "Trees", document: POINT, kind: "vector", geometry: "point" })
      );
    });
    await openStyles();
    expect((button("style_editor.paste_style") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("style_editor.copy_note")).toBeDefined();
    const pasted = { ...POLYGON, symbol: { fill: { color: "#00ff00" } } } as LayerStyle;
    act(() => {
      reduxStore.dispatch(
        setStyleClipboard({ sourceLayerName: "Parks", document: pasted, kind: "vector", geometry: "polygon" })
      );
    });
    expect(screen.getByText("style_editor.paste_note")).toBeDefined();
    await userEvent.click(button("style_editor.paste_style"));
    expect(editor.document).toEqual(pasted);
    act(() => editor.undo());
    expect(editor.document).toEqual(POLYGON);
    await userEvent.click(button("style_editor.copy_style"));
    expect(reduxStore.getState().layers.styleClipboard).toMatchObject({
      sourceLayerName: "Districts",
      document: POLYGON,
      geometry: "polygon",
    });
  });

  it("set as default only when allowed, without a toast", async () => {
    const first = setup(layerWith([]));
    await openStyles();
    await openMenu();
    expect(screen.queryByRole("button", { name: "style_editor.set_default_style" })).toBeNull();
    first.unmount();
    setup(layerWith([]), { canSetDefault: true });
    await openStyles();
    await openMenu();
    await userEvent.click(item("style_editor.set_default_style"));
    expect(api.setStyleAsDefault).toHaveBeenCalledWith("p1", 5, "a");
    await waitFor(() => expect(api.setStyleAsDefault).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("a failed set as default says so", async () => {
    api.setStyleAsDefault.mockRejectedValueOnce(new Error("forbidden"));
    setup(layerWith([]), { canSetDefault: true });
    await openStyles();
    await openMenu();
    await userEvent.click(item("style_editor.set_default_style"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("style_editor.default_style_failed"));
  });

  it("a style the same as the dataset's default style says so in its row, the active one as edited", async () => {
    ds.dataset = { ...POLYGON, symbol: { fill: { color: "#cccccc", computed: { by: "server" } } } };
    ds.others = { o0: POINT, o1: POLYGON };
    const { editor } = setup(layerWith(["Night", "Copy"]));
    await openStyles();
    expect(button(/^Default/).textContent).toContain("style_editor.dataset_default");
    expect(button(/^Night/).textContent).not.toContain("style_editor.dataset_default");
    expect(button(/^Copy/).textContent).toContain("style_editor.dataset_default");
    act(() => editor.set("symbol.fill.color", "#00ff00"));
    expect(button(/^Default/).textContent).not.toContain("style_editor.dataset_default");
  });

  it("the active style's menu puts the whole style back as the dataset's, as one undo step", async () => {
    const dataset = {
      ...POLYGON,
      symbol: { fill: { color: "#2bb381" }, label: { text: "x" } },
    } as LayerStyle;
    ds.dataset = dataset;
    const { editor } = setup(layerWith(["Night"]));
    await openStyles();
    await openMenu();
    await userEvent.click(item("style_editor.reset_to_dataset"));
    expect(editor.document).toEqual(dataset);
    expect(button(/^Default/).textContent).toContain("style_editor.dataset_default");
    act(() => editor.undo());
    expect(editor.document).toEqual(POLYGON);
    // Only the active style's menu has it.
    await userEvent.click(screen.getAllByRole("button", { name: "style_editor.style_more" })[1]);
    expect(screen.queryByRole("button", { name: "style_editor.reset_to_dataset" })).toBeNull();
  });

  it("no whole-style reset while the style is the dataset's, or while the dataset's style is not there", async () => {
    ds.dataset = POLYGON;
    const first = setup(layerWith([]));
    await openStyles();
    await openMenu();
    expect(screen.queryByRole("button", { name: "style_editor.reset_to_dataset" })).toBeNull();
    first.unmount();
    ds.dataset = undefined;
    setup(layerWith([]));
    await openStyles();
    await openMenu();
    expect(screen.queryByRole("button", { name: "style_editor.reset_to_dataset" })).toBeNull();
  });

  it("copy and paste are the panel's text buttons, not outlined boxes", async () => {
    setup(layerWith([]));
    await openStyles();
    for (const name of ["style_editor.copy_style", "style_editor.paste_style"])
      expect(button(name).classList.contains("MuiButton-text")).toBe(true);
  });
});
