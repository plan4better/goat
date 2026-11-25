// Height for polygons (3D spec 8.4): a group row like Fill and Outline with a summary, opening its popover with the
// part's switch, the one way to turn it off and on, as the other parts; on: Fixed, By zoom, By attribute, By classes;
// the first height on a 2D map tilts it once, with Undo; a raw field picks its unit; Base height while Height is set.
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

// The parts' reset reads the dataset's style from core; none here.
vi.mock("@/lib/api/map", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDatasetStyle: () => ({ style: undefined, error: undefined, isLoading: true }),
}));

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
function setup(document: LayerStyle = { version: "1.0.0", kind: "vector" } as LayerStyle) {
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

/** The Height row of the Polygons section (its field shows the summary). */
const sidebarRow = () =>
  screen.getAllByText("Height").find((el) => !el.closest("[data-popover-frame]"))!
    .parentElement as HTMLElement;
const summary = () => within(sidebarRow()).getAllByRole("button")[0].textContent;
const popover = () =>
  screen
    .getByText("Height", { selector: "[data-popover-frame] p" })
    .closest("[data-popover-frame]") as HTMLElement;
const openHeight = async () => {
  if (!document.querySelector("[data-popover-frame]"))
    await userEvent.click(within(sidebarRow()).getAllByRole("button")[0]);
};
const turnOn = async () => {
  await openHeight();
  await userEvent.click(within(popover()).getByRole("checkbox", { name: "Turn height on" }));
};
const pick = async (mode: string) => {
  await openHeight();
  await userEvent.click(
    within(popover()).getByRole("button", { name: /^Height: .*Change how the value is set\.$/ })
  );
  await userEvent.click(within(screen.getByRole("menu")).getByText(mode));
};

describe("HeightRow", () => {
  it("shows the height in the Polygons section and opens it in a popover with the part's switch", async () => {
    const { store } = setup();
    expect(summary()).toBe("None");
    await openHeight();
    // Off, the popover says so as the other parts' editors do: the switch is the way on.
    expect(
      within(popover()).getByText("Off. Turn it on with the switch above; your last settings come back.")
    ).toBeTruthy();
    expect(within(popover()).queryByText("Top")).toBeNull();
    await turnOn();
    expect(store.get("symbol.extrude")).toEqual({});
    expect(summary()).toBe("10 m");
    // The title says Height once; its rows are the top and the bottom, as Fill's first row is Color.
    expect(within(popover()).getAllByText("Height")).toHaveLength(1);
    expect(within(popover()).getByText("Top")).toBeTruthy();
    await pick("By zoom");
    const height = store.get("symbol.extrude.height");
    // Off remembers the height, on brings it back.
    await userEvent.click(within(popover()).getByRole("checkbox", { name: "Turn height off" }));
    expect(store.get("symbol.extrude")).toBe(false);
    expect(summary()).toBe("None");
    await userEvent.click(within(popover()).getByRole("checkbox", { name: "Turn height on" }));
    expect(store.get("symbol.extrude.height")).toEqual(height);
  });

  it("offers no None among the forms of the height: the switch turns it off", async () => {
    setup({ version: "1.0.0", kind: "vector", symbol: { extrude: { height: 10 } } } as LayerStyle);
    await openHeight();
    await userEvent.click(
      within(popover()).getByRole("button", { name: /^Height: .*Change how the value is set\.$/ })
    );
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).not.toContainEqual(expect.stringMatching(/^None/));
    ["Fixed", "By zoom", "By attribute", "Field values", "By classes"].forEach((name, i) =>
      expect(within(items[i]).getByText(name)).toBeTruthy()
    );
  });

  it("in a class while the layer turns heights off, says so as the other parts do", async () => {
    const { store } = setup({
      version: "1.0.0",
      kind: "vector",
      symbol: { extrude: false },
      classify: [{ field: "use", method: "categories", classes: [{ values: ["office"] }] }],
    } as unknown as LayerStyle);
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openHeight();
    expect(within(popover()).getByText(/^Off for the layer\./)).toBeTruthy();
    expect(within(popover()).queryByText("Top")).toBeNull();
  });

  it("in a class with heights of its own while the layer turns them off, says so first and disables the switch", async () => {
    const { store } = setup({
      version: "1.0.0",
      kind: "vector",
      symbol: { extrude: false },
      classify: [
        { field: "use", method: "categories", classes: [{ values: ["office"], extrude: { height: 30 } }] },
      ],
    } as unknown as LayerStyle);
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openHeight();
    expect(within(popover()).getByText(/^Off for the layer\./)).toBeTruthy();
    expect(within(popover()).queryByText("Top")).toBeNull();
    expect((within(popover()).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });

  it("tilts a 2D map once for the first height, with Undo", async () => {
    const { store, redux } = setup();
    await turnOn();
    expect(store.get("symbol.extrude")).toEqual({});
    expect(redux.getState().map.view?.mode).toBe("3d");
    expect(toasts).toHaveLength(1);
    render(<I18nextProvider i18n={english}>{toasts[0]}</I18nextProvider>);
    expect(screen.getByText("Switched to 3D view")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(redux.getState().map.view?.mode).toBe("2d");
    // The row's note under its field: the state in words, then the way back as a text link.
    const note = within(sidebarRow()).getByText(/Viewing in 2D/);
    expect(note.textContent).toBe("Viewing in 2D. Show in 3D");
    expect(within(note).getByRole("button", { name: "Show in 3D" })).toBeTruthy();
    // Declined for this layer: no tilt again.
    await userEvent.click(within(popover()).getByRole("checkbox", { name: "Turn height off" }));
    expect(store.get("symbol.extrude")).toBe(false);
    await userEvent.click(within(popover()).getByRole("checkbox", { name: "Turn height on" }));
    await pick("By zoom");
    expect(redux.getState().map.view?.mode).toBe("2d");
    expect(toasts).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Show in 3D" }));
    expect(redux.getState().map.view?.mode).toBe("3d");
  });

  it("suggests height fields in the field menu, reads levels as storeys and says so in the summary", async () => {
    const { store } = setup();
    await turnOn();
    await pick("Field values");
    const menu = screen.getByRole("listbox");
    const items = within(menu).getAllByRole("option");
    expect(within(menu).getByText("Suggested for height")).toBeTruthy();
    expect(within(items[0]).getByText("levels")).toBeTruthy();
    expect(within(items[1]).getByText("height")).toBeTruthy();
    expect(within(menu).getByText("Other number fields")).toBeTruthy();
    await userEvent.click(items[0]);
    expect(store.get("symbol.extrude")).toEqual({ height: { field: "levels" }, unit: "storeys" });
    expect(screen.getByRole("button", { name: "Storeys × 3 m" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(popover()).getByText("Bottom")).toBeTruthy();
    expect(summary()).toBe("By levels · storeys");
  });

  it("shows the unit while the base reads a field", async () => {
    const { store } = setup({
      version: "1.0.0",
      kind: "vector",
      symbol: { extrude: { height: 10 } },
    } as LayerStyle);
    await openHeight();
    expect(within(popover()).queryByText("Unit")).toBeNull();
    await userEvent.click(
      within(popover()).getByRole("button", { name: /^Base height: .*Change how the value is set\.$/ })
    );
    await userEvent.click(within(screen.getByRole("menu")).getByText("Field values"));
    await userEvent.click(within(screen.getByRole("listbox")).getByText("height"));
    expect(store.get("symbol.extrude.base")).toEqual({ field: "height" });
    expect(within(popover()).getByText("Unit")).toBeTruthy();
  });

  it("raises the polygons in proportion to a field over a range of heights, in metres", async () => {
    const { store, redux } = setup();
    await turnOn();
    await userEvent.click(
      within(popover()).getByRole("button", { name: /^Height: .*Change how the value is set\.$/ })
    );
    const menu = screen.getByRole("menu");
    // A field over a range, and a field's values as the heights: two modes, each with its own words.
    expect(within(menu).getByText("By attribute")).toBeTruthy();
    expect(within(menu).getByText("In proportion to a number field, such as density")).toBeTruthy();
    expect(within(menu).getByText("Field values")).toBeTruthy();
    await userEvent.click(within(menu).getByText("By attribute"));
    expect(store.get("symbol.extrude")).toEqual({
      height: { field: "area", range: [0, 50], scale: "linear" },
    });
    expect(redux.getState().map.view?.mode).toBe("3d");
    // The attribute editor opens at once: the field, then the heights at the ends of its values, in metres.
    const editor = screen
      .getByText("Height by attribute", { selector: "[data-popover-frame] p" })
      .closest("[data-popover-frame]") as HTMLElement;
    expect(within(editor).getByRole("slider", { name: "Largest" }).getAttribute("value")).toBe("50");
    expect(within(editor).getAllByText("m").length).toBeGreaterThan(0);
    expect(summary()).toBe("By area");
  });

  it("By attribute from Field values keeps the field the height reads", async () => {
    const { store } = setup({
      version: "1.0.0",
      kind: "vector",
      symbol: { extrude: { height: { field: "height" } } },
    } as LayerStyle);
    await pick("By attribute");
    expect(store.get("symbol.extrude")).toEqual({
      height: { field: "height", range: [0, 50], scale: "linear" },
    });
    expect(summary()).toBe("By height");
  });

  it("in class scope a height by attribute stays the layer's: its row opens no editor", async () => {
    const { store } = setup({
      version: "1.0.0",
      kind: "vector",
      symbol: { extrude: { height: { field: "area", range: [0, 50], scale: "linear" } } },
      classify: [
        {
          field: "use",
          method: "categories",
          classes: [{ values: ["park"], fill: { color: "#00ff00" } }],
        },
      ],
    } as unknown as LayerStyle);
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openHeight();
    await userEvent.click(within(popover()).getByRole("button", { name: /^By area/ }));
    expect(screen.queryByText("Height by attribute", { selector: "[data-popover-frame] p" })).toBeNull();
  });

  it("offers the base every form of the height but None", async () => {
    const { store } = setup({
      version: "1.0.0",
      kind: "vector",
      symbol: { extrude: { height: 40 } },
    } as LayerStyle);
    await openHeight();
    const base = () =>
      within(popover()).getByRole("button", { name: /^Base height: .*Change how the value is set\.$/ });
    await userEvent.click(base());
    // Every form of the height but None, each with its words.
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items).toHaveLength(5);
    ["Fixed", "By zoom", "By attribute", "Field values", "By classes"].forEach((name, i) =>
      expect(within(items[i]).getByText(name)).toBeTruthy()
    );
    await userEvent.click(within(screen.getByRole("menu")).getByText("By zoom"));
    expect(store.get("symbol.extrude.base")).toEqual({
      zoom: [
        [11, 0],
        [17, 0],
      ],
    });
    await userEvent.click(base());
    await userEvent.click(within(screen.getByRole("menu")).getByText("By attribute"));
    expect(store.get("symbol.extrude.base")).toEqual({ field: "area", range: [0, 10], scale: "linear" });
    // By classes asks for the field, as the height's does.
    await userEvent.click(base());
    await userEvent.click(within(screen.getByRole("menu")).getByText("By classes"));
    expect(within(screen.getByRole("listbox")).getByText("use")).toBeTruthy();
  });

  it("says at which zooms the volumes stand while a height is set, as Fill and Outline do", async () => {
    setup({
      version: "1.0.0",
      kind: "vector",
      symbol: { extrude: { height: 10, min_zoom: 14 } },
    } as LayerStyle);
    await openHeight();
    expect(within(popover()).getByText("Visible")).toBeTruthy();
    expect(within(popover()).getAllByText(/14/).length).toBeGreaterThan(0);
  });

  it("has no zoom row while there is no height", async () => {
    setup();
    await openHeight();
    expect(within(popover()).queryByText("Visible")).toBeNull();
  });

  it("follows a class's own height set from outside the row, in the row and in its editor", async () => {
    const { store } = setup({
      version: "1.0.0",
      kind: "vector",
      symbol: { extrude: { height: 10 } },
      classify: [
        {
          field: "use",
          method: "categories",
          classes: [{ values: ["office"], fill: { color: "#ff0000" } }],
        },
      ],
    } as unknown as LayerStyle);
    expect(summary()).toBe("10 m");
    await openHeight();
    expect(screen.getByRole("slider", { name: "Top" })).toBeTruthy();
    act(() => store.set("classify.0.classes.0.extrude", { height: 30 }));
    expect(summary()).not.toBe("10 m");
    expect(screen.queryByRole("slider", { name: "Top" })).toBeNull();
    act(() => store.undo());
    expect(summary()).toBe("10 m");
    expect(screen.getByRole("slider", { name: "Top" })).toBeTruthy();
  });

  it("shows a class's own height in class scope", async () => {
    const { store } = setup({
      version: "1.0.0",
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
    expect(summary()).toBe("30 m");
    await openHeight();
    expect(screen.getByRole("slider", { name: "Top" }).getAttribute("value")).toBe("30");
  });
});
