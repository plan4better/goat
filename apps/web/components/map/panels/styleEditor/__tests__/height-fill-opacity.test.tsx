// Heights draw with one fill opacity for the whole layer (goatlib refuses one by feature, by classes or of a class):
// on a layer with heights the Fill opacity row offers Fixed and By zoom only and a class shows none of its own, and
// switching heights on makes a fill opacity by feature fixed in the same edit.
import { ThemeProvider, createTheme } from "@mui/material";
import { configureStore } from "@reduxjs/toolkit";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { Provider } from "react-redux";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { initView, mapReducer } from "@/lib/store/map/slice";
import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { StyleSaver } from "@/lib/style/save";

import { english } from "@/components/map/controls/__tests__/english";
import { EMPTY_DATA, StyleEditorProvider } from "@/components/map/panels/styleEditor/context";
import { HeightRow } from "@/components/map/panels/styleEditor/editors/HeightRow";
import { PropertyRow } from "@/components/map/panels/styleEditor/editors/PropertyRow";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";

import { echoTransport, renderPanel } from "./renderPanel";

vi.mock("@/lib/api/map", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDatasetStyle: () => ({ style: undefined, error: undefined, isLoading: true }),
}));
vi.mock("react-toastify", () => ({
  toast: Object.assign(() => undefined, { info: () => undefined, dismiss: () => undefined }),
}));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const FIELDS = [
  { name: "pop", type: "number" as const, label: "pop" },
  { name: "use", type: "string" as const, label: "use" },
];
const DATA = {
  geometry: "polygon" as const,
  fields: FIELDS,
  fieldTypes: Object.fromEntries(FIELDS.map((f) => [f.name, f.type])),
  sample: { pop: 50, use: "a" },
};
const OPACITY_ROW = { type: "number" as const, key: "opacity", label: "style_editor.opacity" };
const doc = (symbol: object, extra: object = {}) =>
  ({ version: "1.0.0", kind: "vector", symbol, ...extra }) as LayerStyle;

/** The modes the Fill opacity row's menu offers. */
async function opacityModes(): Promise<string[]> {
  await userEvent.click(screen.getByRole("button", { name: "style_editor.value_mode_aria" }));
  const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
  return items.map((item) => item.textContent ?? "");
}

describe("fill opacity with heights", () => {
  it("offers Fixed and By zoom only on a layer with heights", async () => {
    renderPanel(
      <PopoverProvider>
        <PropertyRow row={OPACITY_ROW} base="symbol.fill" />
      </PopoverProvider>,
      { document: doc({ fill: { color: "#336699" }, extrude: { height: 10 } }), data: DATA }
    );
    const modes = await opacityModes();
    expect(modes.some((m) => m.startsWith("style_editor.mode_zoom"))).toBe(true);
    expect(modes.some((m) => m.startsWith("style_editor.mode_attribute"))).toBe(false);
    expect(modes.some((m) => m.startsWith("style_editor.mode_classes"))).toBe(false);
  });

  it("a style stored with a fill opacity by attribute and heights can still make it fixed", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <PropertyRow row={OPACITY_ROW} base="symbol.fill" />
      </PopoverProvider>,
      {
        document: doc({
          fill: { color: "#336699", opacity: { field: "pop", range: [0.2, 1], scale: "linear" } },
          extrude: { height: 10 },
        }),
        data: DATA,
      }
    );
    await userEvent.click(screen.getByRole("button", { name: "style_editor.value_mode_aria" }));
    const fixed = within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .find((item) => item.textContent?.startsWith("style_editor.mode_fixed"));
    await userEvent.click(fixed!);
    expect(typeof store.get("symbol.fill.opacity")).toBe("number");
  });

  it("offers By attribute and By classes on a flat layer", async () => {
    renderPanel(
      <PopoverProvider>
        <PropertyRow row={OPACITY_ROW} base="symbol.fill" />
      </PopoverProvider>,
      { document: doc({ fill: { color: "#336699" } }), data: DATA }
    );
    const modes = await opacityModes();
    expect(modes.some((m) => m.startsWith("style_editor.mode_attribute"))).toBe(true);
  });

  it("a class shows no fill opacity of its own on a layer with heights", () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <PropertyRow row={OPACITY_ROW} base="symbol.fill" />
      </PopoverProvider>,
      {
        document: doc(
          { fill: { color: "#336699" }, extrude: { height: 10 } },
          { classify: [{ field: "use", method: "categories", classes: [{ value: "a" }, { value: "b" }] }] }
        ),
        data: DATA,
      }
    );
    expect(screen.getByText("style_editor.opacity")).toBeDefined();
    act(() => store.setScope({ classify: 0, key: 1 }));
    expect(screen.queryByText("style_editor.opacity")).toBeNull();
  });

  function heightRow(document: LayerStyle) {
    const redux = configureStore({ reducer: { map: mapReducer } });
    redux.dispatch(initView({ projectId: "p1", mode: "3d", projection: "mercator" }));
    const store = new EditorStore({
      saver: new StyleSaver({ transport: echoTransport(), document, revision: 1 }),
    });
    render(
      <I18nextProvider i18n={english}>
        <ThemeProvider theme={createTheme()}>
          <Provider store={redux}>
            <StyleEditorProvider store={store} data={{ ...EMPTY_DATA, layerId: "l1", ...DATA }} mapZoom={12}>
              <PopoverProvider>
                <div data-style-panel>
                  <HeightRow />
                </div>
              </PopoverProvider>
            </StyleEditorProvider>
          </Provider>
        </ThemeProvider>
      </I18nextProvider>
    );
    return store;
  }
  const openHeight = async () => {
    const row = screen.getAllByText("Height").find((el) => !el.closest("[data-popover-frame]"))!
      .parentElement as HTMLElement;
    await userEvent.click(within(row).getAllByRole("button")[0]);
  };
  const byPop = { field: "pop", range: [0.2, 1], scale: "linear" };

  it("the height switch makes a fill opacity by attribute fixed in the same edit", async () => {
    const store = heightRow(doc({ fill: { color: "#336699", opacity: byPop }, extrude: false }));
    await openHeight();
    await userEvent.click(screen.getByRole("checkbox", { name: "Turn height on" }));
    expect(store.get("symbol.extrude")).toEqual({});
    expect(typeof store.get("symbol.fill.opacity")).toBe("number");
    // One undo step brings both back.
    act(() => store.undo());
    expect(store.get("symbol.fill.opacity")).toEqual(byPop);
    expect(store.get("symbol.extrude")).toBe(false);
  });

  it("a fixed height from None removes the classes of the fill opacity", async () => {
    const store = heightRow(
      doc(
        { fill: { color: "#336699", opacity: 0.8 } },
        {
          classify: [
            { field: "use", target: "fill.opacity", classes: [{ value: "a", fill: { opacity: 0.2 } }] },
          ],
        }
      )
    );
    await openHeight();
    const popover = screen
      .getByText("Height", { selector: "[data-popover-frame] p" })
      .closest("[data-popover-frame]") as HTMLElement;
    await userEvent.click(
      within(popover).getByRole("button", { name: /^Height: .*Change how the value is set\.$/ })
    );
    await userEvent.click(within(screen.getByRole("menu")).getByText("Fixed"));
    expect(store.get("symbol.extrude")).toEqual({ height: 10 });
    expect(store.get("classify")).toBeUndefined();
    expect(store.get("symbol.fill.opacity")).toBe(0.8);
  });
});
