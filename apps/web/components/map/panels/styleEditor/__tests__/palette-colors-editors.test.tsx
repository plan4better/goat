import { configureStore } from "@reduxjs/toolkit";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { initView, mapReducer } from "@/lib/store/map/slice";
import type { LayerStyle } from "@/lib/style/generated/types";
import { paletteSteps } from "@/lib/style/palettes";

import { AttributeEditor } from "@/components/map/panels/styleEditor/editors/AttributeEditor";
import { ClassificationEditor } from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { H3Section } from "@/components/map/panels/styleEditor/sections/H3Section";

import { renderPanel } from "./renderPanel";

vi.mock("@/lib/api/projects", async (original) => ({
  ...(await original<typeof import("@/lib/api/projects")>()),
  useProjectLayerHistogramStats: () => ({ histogramStats: undefined }),
}));
vi.mock("@/lib/api/processes", async (original) => ({
  ...(await original<typeof import("@/lib/api/processes")>()),
  useUniqueValues: () => ({ data: undefined }),
}));
vi.mock("react-toastify", () => ({ toast: Object.assign(() => 0, { info: () => 0, dismiss: () => 0 }) }));

const list = () => screen.getByRole("group", { name: "style_editor.palette" });
const swatches = () => within(list()).getAllByRole("button", { name: "style_editor.palette_color" });
const bins = () => within(list()).getAllByRole("button", { name: "style_editor.remove_color" });
const addColor = () => screen.getByRole("button", { name: "style_editor.add_color" });
/** Opens the editor of the section's Colors row. */
const openColors = () =>
  userEvent.click(within(screen.getByText("style_editor.colors").parentElement!).getByRole("button"));

const FIELDS = [{ name: "population", type: "integer" as const, label: "population" }];
const DATA = {
  geometry: "polygon" as const,
  layerId: "l1",
  fields: FIELDS,
  fieldTypes: { population: "integer" as const },
};

const classification = (count: number) => ({
  id: "population",
  field: "population",
  method: "quantile",
  count,
  palette: "colorbrewer:OrRd",
  reverse: true,
  classes: Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    ...(i > 0 ? { from: i * 100 } : {}),
    ...(i < count - 1 ? { to: (i + 1) * 100 } : {}),
  })),
});

function classes(count: number) {
  return renderPanel(
    <PopoverProvider>
      <ClassificationEditor ci={0} />
    </PopoverProvider>,
    {
      document: {
        version: "1.0.0",
        kind: "vector",
        symbol: { fill: { color: "#cccccc" } },
        classify: [classification(count)],
      } as unknown as LayerStyle,
      data: DATA,
    }
  );
}

describe("a palette's colors under its Palette row", () => {
  it("a classification has no palette list: its class rows are the colors to edit", () => {
    classes(4);
    expect(screen.getByText("style_editor.palette")).toBeDefined();
    expect(screen.queryByRole("group", { name: "style_editor.palette" })).toBeNull();
  });

  it("a color by attribute lists its palette's colors; an edit writes an inline palette", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <AttributeEditor path="symbol.fill.color" />
      </PopoverProvider>,
      {
        document: {
          version: "1.0.0",
          kind: "vector",
          symbol: { fill: { color: { field: "population", palette: "goat:green" } } },
        } as unknown as LayerStyle,
        data: DATA,
      }
    );
    // At the bottom of the editor, after its other rows.
    const scale = screen.getByText("style_editor.scale");
    expect(scale.compareDocumentPosition(list()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const green = paletteSteps("goat:green", swatches().length);
    await userEvent.click(bins()[0]);
    expect(store.get("symbol.fill.color.palette")).toEqual(green.slice(1));
    expect(store.get("symbol.fill.color.field")).toBe("population");
  });

  it("a color's open picker closes when a color before it is removed: no pick lands on another color", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <AttributeEditor path="symbol.fill.color" />
      </PopoverProvider>,
      {
        document: {
          version: "1.0.0",
          kind: "vector",
          symbol: {
            fill: { color: { field: "population", palette: ["#000000", "#808080", "#ffffff", "#ff0000"] } },
          },
        } as unknown as LayerStyle,
        data: DATA,
      }
    );
    await userEvent.click(swatches()[1]);
    expect(screen.getByRole("button", { name: "#D7301F" })).toBeDefined();
    await userEvent.click(bins()[0]);
    expect(store.get("symbol.fill.color.palette")).toEqual(["#808080", "#ffffff", "#ff0000"]);
    expect(screen.queryByRole("button", { name: "#D7301F" })).toBeNull();
  });

  it("a reversed inline palette by attribute draws reversed and stays as written", () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <AttributeEditor path="symbol.fill.color" />
      </PopoverProvider>,
      {
        document: {
          version: "1.0.0",
          kind: "vector",
          symbol: {
            fill: {
              color: { field: "population", palette: ["#000000", "#ff0000", "#ffffff"], reverse: true },
            },
          },
        } as unknown as LayerStyle,
        data: DATA,
      }
    );
    expect(
      Array.from(list().querySelectorAll("[data-class-row]")).map((row) => row.getAttribute("title"))
    ).toEqual(["#FFFFFF", "#FF0000", "#000000"]);
    expect(store.get("symbol.fill.color.palette")).toEqual(["#000000", "#ff0000", "#ffffff"]);
  });

  it("H3 hexagons list their palette's colors in the Colors editor; an edit writes an inline palette", async () => {
    const redux = configureStore({ reducer: { map: mapReducer } });
    redux.dispatch(initView({ projectId: "p1", mode: "2d", projection: "mercator" }));
    const { store } = renderPanel(
      <Provider store={redux}>
        <PopoverProvider>
          <H3Section />
        </PopoverProvider>
      </Provider>,
      {
        document: {
          version: "1.0.0",
          kind: "vector",
          render: { type: "h3", palette: ["#000000", "#ffffff"], reverse: true },
        } as LayerStyle,
        data: { geometry: "point", fields: FIELDS, fieldTypes: { population: "integer" } },
      }
    );
    await openColors();
    // An inline palette, reversed as it draws.
    // Drawing it reversed leaves the stored list as written.
    expect(store.get("render.palette")).toEqual(["#000000", "#ffffff"]);
    expect(
      Array.from(list().querySelectorAll("[data-class-row]")).map((row) => row.getAttribute("title"))
    ).toEqual(["#FFFFFF", "#000000"]);
    await userEvent.click(addColor());
    expect(store.get("render.palette")).toEqual(["#ffffff", "#000000", "#000000"]);
    expect(store.get("render.reverse")).toBeUndefined();
  });

  it("H3 hexagons in classes have no palette list", async () => {
    const redux = configureStore({ reducer: { map: mapReducer } });
    redux.dispatch(initView({ projectId: "p1", mode: "2d", projection: "mercator" }));
    renderPanel(
      <Provider store={redux}>
        <PopoverProvider>
          <H3Section />
        </PopoverProvider>
      </Provider>,
      {
        document: {
          version: "1.0.0",
          kind: "vector",
          render: { type: "h3", classify: { method: "quantile", count: 5 } },
        } as LayerStyle,
        data: { geometry: "point", fields: FIELDS, fieldTypes: { population: "integer" } },
      }
    );
    await openColors();
    expect(screen.getByText("style_editor.count")).toBeDefined();
    expect(screen.queryByRole("group", { name: "style_editor.palette" })).toBeNull();
  });
});
