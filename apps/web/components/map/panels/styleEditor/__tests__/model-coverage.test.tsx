// Keys of the style model the panel had no row for: a line's blur, a marker's offset (a circle's in Fill, an image's
// in Icon) and every anchor, the columns' base, a value by attribute's no-data value and legend title, and how a
// number classification's bounds read in the legend.
import { configureStore } from "@reduxjs/toolkit";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { describe, expect, it } from "vitest";

import { mapReducer } from "@/lib/store/map/slice";
import type { LayerStyle } from "@/lib/style/generated/types";

import { AttributeEditor } from "@/components/map/panels/styleEditor/editors/AttributeEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { H3Section } from "@/components/map/panels/styleEditor/sections/H3Section";
import { LegendSection } from "@/components/map/panels/styleEditor/sections/LegendSection";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, renderPanel } from "./renderPanel";

const FIELDS = [
  { name: "traffic", type: "number" as const, label: "traffic" },
  { name: "name", type: "string" as const, label: "name" },
];
const data = (geometry: "line" | "point" | "polygon") => ({
  geometry,
  fields: FIELDS,
  fieldTypes: Object.fromEntries(FIELDS.map((f) => [f.name, f.type])),
});

const symbol = (doc: object, geometry: "line" | "point") =>
  renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    { document: { version: 1, kind: "vector", ...doc } as LayerStyle, data: data(geometry) }
  );

/** The last row with this label: the open popover's, after the section's. */
const rowOf = (label: string) => screen.getAllByText(label).at(-1)!.parentElement as HTMLElement;
const slide = (label: string, value: number) =>
  fireEvent.change(within(rowOf(label)).getByRole("slider"), { target: { value } });

describe("rows for every key of the model", () => {
  it("a line's blur", async () => {
    const { store } = symbol({ symbol: { line: { color: "#2166ac" } } }, "line");
    await openGroup("style_editor.part_line");
    slide("style_editor.blur", 3);
    expect(store.get("symbol.line.blur")).toBe(3);
  });

  it("a circle's offset in Fill, written as [x, y]; none back to the start writes nothing", async () => {
    const { store } = symbol({ symbol: { marker: { color: "#1a6b4d" } } }, "point");
    await openGroup("style_editor.part_fill");
    slide("style_editor.offset_x", 4);
    expect(store.get("symbol.marker.offset")).toEqual([4, 0]);
    slide("style_editor.offset_y", -2);
    expect(store.get("symbol.marker.offset")).toEqual([4, -2]);
  });

  it("an icon's offset in Icon, and every anchor the style takes", async () => {
    const { store } = symbol({ symbol: { marker: { shape: "icon", icon: "goat:park" } } }, "point");
    await openGroup("style_editor.part_icon");
    slide("style_editor.offset_y", 6);
    expect(store.get("symbol.marker.offset")).toEqual([0, 6]);
    // Every anchor the style takes, center and bottom first, each with its position's picture; no search.
    await userEvent.click(within(rowOf("style_editor.anchor")).getByRole("combobox"));
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => o.textContent?.replace(/style_editor\.\S+_sub$/, ""))).toEqual([
      "center",
      "bottom",
      "top_left",
      "top",
      "top_right",
      "left",
      "right",
      "bottom_left",
      "bottom_right",
    ]);
    expect(options.every((o) => o.querySelectorAll("circle").length === 9)).toBe(true);
    expect(screen.queryByRole("textbox", { name: "search_placeholder_short" })).toBeNull();
    await userEvent.click(within(screen.getByRole("listbox")).getByText("top_left"));
    // The field shows the chosen anchor's picture before its name.
    expect(
      within(rowOf("style_editor.anchor")).getByRole("combobox").querySelectorAll("circle")
    ).toHaveLength(9);
    expect(store.get("symbol.marker.anchor")).toBe("top_left");
  });

  it("the columns' base", async () => {
    const redux = configureStore({ reducer: { map: mapReducer } });
    const { store } = renderPanel(
      <Provider store={redux}>
        <PopoverProvider>
          <H3Section />
        </PopoverProvider>
      </Provider>,
      {
        document: { version: 1, kind: "vector", render: { type: "h3", extrude: {} } } as LayerStyle,
        data: data("point"),
      }
    );
    await userEvent.click(
      within(screen.getAllByText("style_editor.height")[0].parentElement!).getByRole("button")
    );
    slide("style_editor.base_height", 2000);
    expect(store.get("render.extrude.base")).toBe(2000);
  });

  it("a value by attribute: what features without a value draw, and its title in the legend", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <AttributeEditor path="symbol.line.width" />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { line: { width: { field: "traffic", range: [1, 8] } } },
        } as LayerStyle,
        data: data("line"),
      }
    );
    slide("style_editor.no_data", 5);
    expect(store.get("symbol.line.width.no_data")).toBe(5);
    fireEvent.change(screen.getByRole("textbox", { name: "style_editor.legend_heading" }), {
      target: { value: "Traffic" },
    });
    expect(store.get("symbol.line.width.title")).toBe("Traffic");
  });

  it("how a number classification's bounds read in the legend; categories have no such row", async () => {
    renderPanel(
      <PopoverProvider>
        <LegendSection />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { fill: {} },
          classify: [
            { id: "a", field: "traffic", method: "quantile", classes: [] },
            { id: "b", field: "name", method: "categories", classes: [] },
          ],
        } as unknown as LayerStyle,
        data: data("polygon"),
      }
    );
    await userEvent.click(within(rowOf("style_editor.contents")).getByRole("button"));
    expect(screen.getAllByText("style_editor.numbers")).toHaveLength(1);
    await userEvent.click(within(rowOf("style_editor.numbers")).getByRole("button"));
    expect(screen.getByText("style_editor.number_format")).toBeDefined();
  });
});
