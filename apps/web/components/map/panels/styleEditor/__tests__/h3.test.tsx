import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { GeneralSection } from "@/components/map/panels/styleEditor/sections/GeneralSection";
import { H3Section } from "@/components/map/panels/styleEditor/sections/H3Section";

import { choose, renderPanel } from "./renderPanel";

const FIELDS = [{ name: "pupils", type: "integer" as const, label: "Pupils" }];

function setup(render: object = { type: "h3" }) {
  return renderPanel(
    <PopoverProvider>
      <GeneralSection />
      <H3Section />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "vector", render } as LayerStyle,
      data: { geometry: "point", fields: FIELDS, fieldTypes: { pupils: "integer" } },
    }
  );
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
});
