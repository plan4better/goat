import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureStore } from "@reduxjs/toolkit";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { initView, mapReducer } from "@/lib/store/map/slice";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { GeneralSection } from "@/components/map/panels/styleEditor/sections/GeneralSection";
import { H3Section } from "@/components/map/panels/styleEditor/sections/H3Section";

import { choose, renderPanel } from "./renderPanel";

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
      document: { version: 1, kind: "vector", render } as LayerStyle,
      data: { geometry: "point", fields: FIELDS, fieldTypes: { pupils: "integer" } },
    }
  );
  return { ...result, redux };
}

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;

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

  it("classes take a method and a count; continuous drops them", async () => {
    const { store } = setup();
    expect(screen.queryByText("style_editor.count")).toBeNull();
    await choose("style_editor.classes", "style_editor.h3_continuous", "style_editor.method_quantile");
    expect(store.get("render.classify")).toEqual({ method: "quantile", count: 5 });
    await pick("style_editor.count", 0);
    expect(store.get("render.classify")).toEqual({ method: "quantile", count: 3 });
    await choose("style_editor.classes", "style_editor.method_quantile", "style_editor.h3_continuous");
    expect(store.get("render.classify")).toBeUndefined();
  });

  it("opacity, outline width and the points' zoom write the render", async () => {
    const { store } = setup();
    fireEvent.change(within(rowOf("style_editor.opacity")).getByRole("slider"), { target: { value: 0.5 } });
    expect(store.get("render.opacity")).toBe(0.5);
    fireEvent.change(screen.getByRole("textbox", { name: "style_editor.width" }), { target: { value: "2" } });
    expect(store.get("render.outline.width")).toBe(2);
    await pick("style_editor.points", 1);
    expect(store.get("render.points_from_zoom")).toBe(10);
  });

  /** The section's Height row (the popover's title says Height too, after it in the page). */
  const heightRow = () => screen.getAllByText("style_editor.height")[0].parentElement as HTMLElement;

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
    fireEvent.change(within(rowOf("style_editor.h3_tallest")).getByRole("slider"), { target: { value: 1500 } });
    expect(store.get("render.extrude.tallest")).toBe(1500);
    await userEvent.click(within(rowOf("style_editor.h3_scale")).getAllByRole("button")[0]);
    expect(store.get("render.extrude.scale")).toBe("linear");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("render.extrude")).toBeUndefined();
    expect(screen.getByText("style_editor.part_outline")).toBeDefined();
  });
});
