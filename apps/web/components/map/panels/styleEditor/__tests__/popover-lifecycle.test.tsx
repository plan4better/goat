import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { StyleSaver } from "@/lib/style/save";

import { StyleEditor } from "@/components/map/panels/styleEditor/StyleEditor";
import { EMPTY_DATA } from "@/components/map/panels/styleEditor/context";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { echoTransport, openGroup, renderPanel, renderWithProviders } from "./renderPanel";

const FIELDS = [{ name: "traffic", type: "number" as const, label: "traffic" }];

const lineDoc = (width: unknown) =>
  ({ version: 1, kind: "vector", symbol: { line: { width } } }) as LayerStyle;

const BY_ZOOM = {
  zoom: [
    [10, 1],
    [16, 6],
  ],
};

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;

function panel(width: unknown) {
  return renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    { document: lineDoc(width), data: { geometry: "line", fields: FIELDS }, mapZoom: 12 }
  );
}

describe("a popover whose value goes away closes", () => {
  it("the zoom editor closes when its value is made fixed", async () => {
    const { store } = panel(BY_ZOOM);
    await openGroup("style_editor.part_line");
    await userEvent.click(within(rowOf("style_editor.width")).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.by_zoom_title")).toBeDefined();
    act(() => store.set("symbol.line.width", 3));
    expect(screen.queryByText("style_editor.by_zoom_title")).toBeNull();
    expect(screen.queryByText("style_editor.not_by_zoom")).toBeNull();
    // The part's editor it was opened from stays.
    expect(screen.getByText("style_editor.width")).toBeDefined();
  });

  it("the attribute editor closes when its value is made fixed", async () => {
    const { store } = panel({ field: "traffic", range: [1, 8] });
    await openGroup("style_editor.part_line");
    await userEvent.click(within(rowOf("style_editor.width")).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.by_attribute_title")).toBeDefined();
    act(() => store.set("symbol.line.width", 3));
    expect(screen.queryByText("style_editor.by_attribute_title")).toBeNull();
    expect(screen.queryByText("style_editor.not_by_attribute")).toBeNull();
  });

  it("an undo back to a fixed value closes the zoom editor", async () => {
    const { store } = panel(3);
    act(() => store.set("symbol.line.width", BY_ZOOM));
    await openGroup("style_editor.part_line");
    await userEvent.click(within(rowOf("style_editor.width")).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.by_zoom_title")).toBeDefined();
    act(() => store.undo());
    expect(screen.queryByText("style_editor.by_zoom_title")).toBeNull();
  });
});

describe("choosing a mode opens its editor", () => {
  const pickMode = async (label: string, mode: string) => {
    await userEvent.click(within(rowOf(label)).getByRole("button", { name: "style_editor.value_mode_aria" }));
    await userEvent.click(within(screen.getByRole("menu")).getByText(mode));
  };

  it("By zoom opens the zoom editor at once", async () => {
    const { store } = panel(3);
    await openGroup("style_editor.part_line");
    await pickMode("style_editor.width", "style_editor.mode_zoom");
    expect(store.get("symbol.line.width.zoom")).toBeDefined();
    expect(screen.getByText("style_editor.by_zoom_title")).toBeDefined();
  });

  it("By attribute opens the attribute editor at once", async () => {
    const { store } = panel(3);
    await openGroup("style_editor.part_line");
    await pickMode("style_editor.width", "style_editor.mode_attribute");
    expect(store.get("symbol.line.width.field")).toBe("traffic");
    expect(screen.getByText("style_editor.by_attribute_title")).toBeDefined();
  });

  it("By zoom marks the row active while its editor is open, as a click on its field does", async () => {
    panel(3);
    await openGroup("style_editor.part_line");
    expect(rowOf("style_editor.width").hasAttribute("data-active")).toBe(false);
    await pickMode("style_editor.width", "style_editor.mode_zoom");
    expect(screen.getByText("style_editor.by_zoom_title")).toBeDefined();
    expect(rowOf("style_editor.width").hasAttribute("data-active")).toBe(true);
    // Closed and opened again from the field: the same mark.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("style_editor.by_zoom_title")).toBeNull();
    expect(rowOf("style_editor.width").hasAttribute("data-active")).toBe(false);
    await userEvent.click(within(rowOf("style_editor.width")).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.by_zoom_title")).toBeDefined();
    expect(rowOf("style_editor.width").hasAttribute("data-active")).toBe(true);
  });

  it("closing the mode menu without opening an editor leaves the row and its fields at rest", async () => {
    panel(BY_ZOOM);
    await openGroup("style_editor.part_line");
    const modeButton = () =>
      within(rowOf("style_editor.width")).getByRole("button", { name: "style_editor.value_mode_aria" });
    const atRest = () => {
      expect(rowOf("style_editor.width").hasAttribute("data-active")).toBe(false);
      expect(
        within(rowOf("style_editor.width"))
          .getAllByRole("button")
          .some((b) => b.hasAttribute("data-active"))
      ).toBe(false);
    };
    const row = rowOf("style_editor.width");
    const button = modeButton();
    await userEvent.click(button);
    // The menu shows the row's label as its title: the row is the one found before.
    expect(button.hasAttribute("data-active")).toBe(true);
    expect(row.hasAttribute("data-active")).toBe(false);
    await userEvent.keyboard("{Escape}");
    atRest();
    // The current mode picked again opens its editor; closing that editor leaves the row at rest.
    await userEvent.click(modeButton());
    await userEvent.click(within(screen.getByRole("menu")).getByText("style_editor.mode_zoom"));
    expect(screen.getByText("style_editor.by_zoom_title")).toBeDefined();
    // The row and its field show the open editor; the mode button only its own menu.
    expect(rowOf("style_editor.width").hasAttribute("data-active")).toBe(true);
    expect(within(rowOf("style_editor.width")).getAllByRole("button")[0].hasAttribute("data-active")).toBe(
      true
    );
    expect(modeButton().hasAttribute("data-active")).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("style_editor.by_zoom_title")).toBeNull();
    atRest();
    // Opened from the field (which keeps the focus) and closed: at rest too.
    await userEvent.click(within(rowOf("style_editor.width")).getAllByRole("button")[0]);
    expect(within(rowOf("style_editor.width")).getAllByRole("button")[0].hasAttribute("data-active")).toBe(
      true
    );
    await userEvent.keyboard("{Escape}");
    atRest();
  });

  it("Fixed opens nothing", async () => {
    panel(BY_ZOOM);
    await openGroup("style_editor.part_line");
    await pickMode("style_editor.width", "style_editor.mode_fixed");
    expect(screen.queryByText("style_editor.by_zoom_title")).toBeNull();
    expect(document.querySelectorAll("[data-popover-frame]")).toHaveLength(1);
  });
});

describe("a picker whose control goes away closes", () => {
  const points = (marker: object) =>
    renderPanel(
      <PopoverProvider>
        <SymbolSection />
      </PopoverProvider>,
      {
        document: { version: 1, kind: "vector", symbol: { marker } } as LayerStyle,
        data: { geometry: "point" },
      }
    );

  it("stays while its row only shows the new value, closes once the row is gone", async () => {
    const { store } = points({ shape: "icon", icon: "goat:marker", anchor: "bottom" });
    await openGroup("style_editor.part_icon");
    await userEvent.click(within(rowOf("style_editor.icon")).getByText("Marker"));
    await userEvent.click(screen.getByRole("button", { name: "Park" }));
    expect(store.get("symbol.marker.icon")).toBe("goat:park");
    // The part's editor and the picker beside it.
    const frames = () => document.querySelectorAll("[data-popover-frame]").length;
    expect(frames()).toBe(2);
    // The icon switched off another way (an undo, say): its row goes, and the picker with it.
    await act(async () => store.set("symbol.marker", {}));
    expect(frames()).toBe(1);
    expect(store.get("symbol.marker")).toEqual({});
  });
});

describe("another layer or style in the panel", () => {
  const storeOf = (document: LayerStyle) =>
    new EditorStore({ saver: new StyleSaver({ transport: echoTransport(), document, revision: 1 }) });
  const editor = (store: EditorStore, id: string) => (
    <StyleEditor
      layer={{ id, name: id, geometry: "line", kind: "vector" }}
      store={store}
      data={{ ...EMPTY_DATA, geometry: "line", fields: FIELDS }}
      map={null}
      mapZoom={12}>
      <SymbolSection />
    </StyleEditor>
  );

  it("closes every popover of the one before", async () => {
    let show: (store: EditorStore) => void = () => undefined;
    function Host() {
      const [store, setStore] = useState(() => storeOf(lineDoc(BY_ZOOM)));
      show = setStore;
      return editor(store, "layer");
    }
    renderWithProviders(<Host />);
    await openGroup("style_editor.part_line");
    await userEvent.click(within(rowOf("style_editor.width")).getAllByRole("button")[0]);
    expect(document.querySelectorAll("[data-popover-frame]")).toHaveLength(2);
    act(() => show(storeOf(lineDoc(BY_ZOOM))));
    // The panel itself stays, showing the new style.
    expect(screen.getByText("style_editor.part_line")).toBeDefined();
    expect(document.querySelector("[data-popover-frame]")).toBeNull();
  });
});
