// Height for polygons (3D spec 8.4): None, Fixed, By zoom, By attribute, By classes; the first height on a 2D map
// tilts it once, with Undo; a raw field picks its unit; Base height while Height is set.
import { ThemeProvider, createTheme } from "@mui/material";
import { configureStore } from "@reduxjs/toolkit";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { Provider } from "react-redux";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { initView, mapReducer } from "@/lib/store/map/slice";
import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { StyleSaver } from "@/lib/style/save";

import { english } from "@/components/map/controls/__tests__/english";
import { EMPTY_DATA, StyleEditorProvider } from "@/components/map/panels/styleEditor/context";
import { HeightRow } from "@/components/map/panels/styleEditor/editors/HeightRow";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";

import { echoTransport } from "./renderPanel";

const { toasts } = vi.hoisted(() => ({ toasts: [] as ReactElement[] }));
vi.mock("react-toastify", () => ({
  toast: Object.assign((content: ReactElement) => toasts.push(content), {
    info: (content: ReactElement) => toasts.push(content),
    dismiss: () => undefined,
  }),
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
beforeEach(() => {
  toasts.length = 0;
});

const FIELDS = [
  { name: "area", type: "number" as const, label: "area" },
  { name: "levels", type: "integer" as const, label: "levels" },
  { name: "height", type: "number" as const, label: "height" },
  { name: "use", type: "string" as const, label: "use" },
];

let layerCount = 0;
function setup(document: LayerStyle = { version: 1, kind: "vector" } as LayerStyle) {
  const redux = configureStore({ reducer: { map: mapReducer } });
  redux.dispatch(initView({ projectId: "p1", mode: "2d", projection: "mercator" }));
  const saver = new StyleSaver({ transport: echoTransport(), document, revision: 1 });
  const store = new EditorStore({ saver });
  layerCount += 1;
  render(
    <I18nextProvider i18n={english}>
      <ThemeProvider theme={createTheme()}>
        <Provider store={redux}>
          <StyleEditorProvider
            store={store}
            data={{
              ...EMPTY_DATA,
              layerId: `layer-${layerCount}`,
              geometry: "polygon",
              fields: FIELDS,
              fieldTypes: Object.fromEntries(FIELDS.map((f) => [f.name, f.type])),
            }}
            mapZoom={14}>
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
  return { store, redux };
}

const pick = async (mode: string) => {
  await userEvent.click(screen.getByRole("button", { name: /^Height: .*Change how the value is set\.$/ }));
  await userEvent.click(within(screen.getByRole("menu")).getByText(mode));
};

describe("HeightRow", () => {
  it("tilts a 2D map once for the first height, with Undo", async () => {
    const { store, redux } = setup();
    await pick("Fixed");
    expect(store.get("symbol.extrude")).toEqual({ height: 10 });
    expect(redux.getState().map.view?.mode).toBe("3d");
    expect(toasts).toHaveLength(1);
    render(<I18nextProvider i18n={english}>{toasts[0]}</I18nextProvider>);
    expect(screen.getByText("Switched to 3D view")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(redux.getState().map.view?.mode).toBe("2d");
    expect(screen.getByText(/Viewing in 2D/)).toBeTruthy();
    // Declined for this layer: no tilt again.
    await pick("None");
    expect(store.get("symbol.extrude")).toBeUndefined();
    await pick("By zoom");
    expect(redux.getState().map.view?.mode).toBe("2d");
    expect(toasts).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Show in 3D" }));
    expect(redux.getState().map.view?.mode).toBe("3d");
  });

  it("suggests height fields and reads levels as storeys", async () => {
    const { store } = setup();
    await pick("By attribute");
    const picker = screen.getByText("Suggested for height").closest("[data-popover-frame]") as HTMLElement;
    const items = within(picker).getAllByRole("menuitem");
    expect(within(items[0]).getByText("levels")).toBeTruthy();
    expect(within(items[1]).getByText("height")).toBeTruthy();
    expect(within(picker).getByText("Other number fields")).toBeTruthy();
    await userEvent.click(items[0]);
    expect(store.get("symbol.extrude")).toEqual({ height: { field: "levels" }, unit: "storeys" });
    expect(screen.getByRole("button", { name: "Storeys × 3 m" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Base height")).toBeTruthy();
  });

  it("shows a class's own height in class scope", () => {
    const { store } = setup({
      version: 1,
      kind: "vector",
      symbol: { extrude: { height: 10 } },
      classify: [
        {
          field: "use",
          method: "categories",
          classes: [{ values: ["office"], extrude: { height: 30 } }],
        },
      ],
    } as unknown as LayerStyle);
    act(() => store.setScope({ classify: 0, key: 0 }));
    expect(screen.getByRole("slider", { name: "Height" }).getAttribute("value")).toBe("30");
  });
});
