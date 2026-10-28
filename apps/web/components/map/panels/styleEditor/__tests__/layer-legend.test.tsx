import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import type { StyleData } from "@/components/map/panels/styleEditor/context";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { LayerSection } from "@/components/map/panels/styleEditor/sections/LayerSection";
import { LegendSection } from "@/components/map/panels/styleEditor/sections/LegendSection";

import { choose, renderPanel } from "./renderPanel";

const FIELDS = [
  { name: "year", type: "integer" as const, label: "year" },
  { name: "built", type: "date" as const, label: "built" },
  { name: "density", type: "number" as const, label: "density" },
];

function setup(extra: object = {}, data: Partial<StyleData> = {}) {
  return renderPanel(
    <PopoverProvider>
      <LayerSection />
      <LegendSection />
    </PopoverProvider>,
    {
      document: {
        version: 1,
        kind: "vector",
        symbol: { fill: { color: "#cccccc" } },
        ...extra,
      } as LayerStyle,
      data: { geometry: "polygon", fields: FIELDS, layerName: "Districts", ...data },
      mapZoom: 12,
    }
  );
}

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;

const CLASSIFY = [
  {
    id: "a",
    field: "density",
    method: "manual",
    classes: [{ to: 10, fill: { color: "#ff0000" } }, { from: 10 }],
  },
  {
    id: "b",
    field: "year",
    method: "manual",
    target: "outline.width",
    classes: [{ to: 2000 }, { from: 2000 }],
  },
];

describe("layer section", () => {
  it("Visible writes top-level zooms", async () => {
    const { store } = setup();
    expect(within(rowOf("style_editor.visible")).getByText("style_editor.all_zooms")).toBeDefined();
    await userEvent.click(within(rowOf("style_editor.visible")).getByRole("button"));
    const [low] = screen.getAllByRole("slider", { name: "style_editor.zoom_from" });
    fireEvent.change(low, { target: { value: 8 } });
    expect(store.get("min_zoom")).toBe(8);
    expect(store.get("symbol.min_zoom")).toBeUndefined();
  });

  it("Draw order by classes appears only with a classification", async () => {
    setup();
    await userEvent.click(within(rowOf("style_editor.draw_order")).getByRole("combobox"));
    expect(within(screen.getByRole("listbox")).queryByText("style_editor.order_classes")).toBeNull();
    expect(within(screen.getByRole("listbox")).getAllByText("style_editor.order_smallest")).toHaveLength(2);
  });

  it("Draw order by classes writes by: classes", async () => {
    const { store } = setup({ classify: CLASSIFY });
    await choose("style_editor.draw_order", "style_editor.order_data", "style_editor.order_classes");
    expect(store.get("order")).toEqual({ by: "classes" });
  });

  it("Time offers integer and date fields with their steps", async () => {
    const { store } = setup();
    await userEvent.click(within(rowOf("style_editor.time")).getByRole("combobox"));
    const menu = screen.getByRole("listbox");
    expect(within(menu).getAllByText("style_editor.time_one")).toHaveLength(1);
    expect(within(menu).getAllByText("style_editor.time_date")).toHaveLength(3);
    await userEvent.click(within(menu).getAllByText("style_editor.time_date")[1]);
    expect(store.get("time")).toEqual({ field: "built", step: "month" });
  });
});

describe("legend section", () => {
  it("legend Order moves the classification", async () => {
    const { store } = setup({ classify: CLASSIFY });
    await userEvent.click(within(rowOf("style_editor.contents")).getByRole("button"));
    const second = screen.getAllByText("style_editor.order")[1].parentElement as HTMLElement;
    const order = within(second).getByRole("combobox");
    expect(order.textContent).toBe("style_editor.order_last");
    await userEvent.click(order);
    await userEvent.click(within(screen.getByRole("listbox")).getByText("style_editor.order_first"));
    expect((store.get("classify") as Array<{ id: string }>).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("two classifications are headed by the property each sets with the field, as the legend titles them", async () => {
    setup({ classify: CLASSIFY });
    await userEvent.click(within(rowOf("style_editor.contents")).getByRole("button"));
    const headings = ["style_editor.color · density", "style_editor.prop_outline_width · year"];
    const preview = screen.getByTestId("legend-preview");
    for (const heading of headings) {
      // The legend above titles the block so, the group below heads its rows and fills the Heading placeholder.
      expect(within(preview).getByText(heading)).toBeDefined();
      expect(screen.getAllByText(heading)).toHaveLength(2);
      expect(screen.getByPlaceholderText(heading)).toBeDefined();
    }
  });

  it("one classification is headed by its field", async () => {
    setup({ classify: CLASSIFY.slice(0, 1) });
    await userEvent.click(within(rowOf("style_editor.contents")).getByRole("button"));
    expect(screen.getAllByText("density")).toHaveLength(2);
    expect(screen.getByPlaceholderText("density")).toBeDefined();
  });

  it("the legend preview is in the legend's popover, not the panel, and follows an edit", async () => {
    const { store } = setup({ classify: CLASSIFY });
    expect(screen.queryByTestId("legend-preview")).toBeNull();
    await userEvent.click(within(rowOf("style_editor.contents")).getAllByRole("button")[0]);
    const preview = screen.getByTestId("legend-preview");
    expect(within(preview).getByText("Districts")).toBeDefined();
    act(() => store.set("classify.0.classes.0.name", "Sparse"));
    expect(within(preview).getByText("Sparse")).toBeDefined();
  });

  it("Show off hides the legend and an empty title removes it", async () => {
    const { store } = setup({ legend: { title: "Areas" } });
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.show" }));
    expect(store.get("legend.show")).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: "style_editor.legend_title" }), {
      target: { value: "" },
    });
    expect(store.get("legend.title")).toBeUndefined();
  });
});
