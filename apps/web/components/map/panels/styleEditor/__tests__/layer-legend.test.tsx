import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { MAP_SCOPE, watchViewPresence } from "@/lib/style/render/viewPresence";

import type { StyleData } from "@/components/map/panels/styleEditor/context";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { LayerSection } from "@/components/map/panels/styleEditor/sections/LayerSection";
import { LegendSection } from "@/components/map/panels/styleEditor/sections/LegendSection";

import { choose, echoTransport, renderPanel } from "./renderPanel";

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
        version: "1.0.0",
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

  it("Classes shown: kept by the filter by default, all or in view written, the default written as nothing", async () => {
    const { store } = setup({ classify: CLASSIFY });
    await userEvent.click(within(rowOf("style_editor.contents")).getByRole("button"));
    await choose("style_editor.classes_shown", "style_editor.classes_filter", "style_editor.classes_view");
    expect(store.get("legend")).toEqual({ classes: "view" });
    await choose("style_editor.classes_shown", "style_editor.classes_view", "style_editor.classes_all");
    expect(store.get("legend.classes")).toBe("all");
    await choose("style_editor.classes_shown", "style_editor.classes_all", "style_editor.classes_filter");
    expect(store.get("legend")).toBeUndefined();
  });

  it("the legend's contents edited for a legend hidden as `legend: false` keep it hidden", async () => {
    const { store } = setup({ classify: CLASSIFY, legend: false });
    await userEvent.click(within(rowOf("style_editor.contents")).getAllByRole("button")[0]);
    await choose("style_editor.classes_shown", "style_editor.classes_filter", "style_editor.classes_view");
    expect(store.get("legend")).toEqual({ show: false, classes: "view" });
    fireEvent.change(screen.getByRole("textbox", { name: "style_editor.caption" }), {
      target: { value: "Source: census" },
    });
    expect(store.get("legend")).toEqual({ show: false, classes: "view", caption: "Source: census" });
  });

  it("one change of Classes shown saves once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const transport = echoTransport();
    renderPanel(
      <PopoverProvider>
        <LayerSection />
        <LegendSection />
      </PopoverProvider>,
      {
        document: {
          version: "1.0.0",
          kind: "vector",
          symbol: { fill: { color: "#cccccc" } },
          classify: CLASSIFY,
        } as LayerStyle,
        data: { geometry: "polygon", fields: FIELDS, layerName: "Districts" },
        transport,
      }
    );
    await userEvent.click(within(rowOf("style_editor.contents")).getByRole("button"));
    await choose("style_editor.classes_shown", "style_editor.classes_filter", "style_editor.classes_view");
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(transport.saves).toHaveLength(1);
    vi.useRealTimers();
  });

  it("Classes shown offers the three choices, and only where the legend has classes", async () => {
    setup({ classify: CLASSIFY });
    await userEvent.click(within(rowOf("style_editor.contents")).getByRole("button"));
    await userEvent.click(within(rowOf("style_editor.classes_shown")).getByRole("combobox"));
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["style_editor.classes_all", "style_editor.classes_filter", "style_editor.classes_view"]);
  });

  it("Classes shown is not offered without classifications", async () => {
    setup();
    await userEvent.click(within(rowOf("style_editor.contents")).getByRole("button"));
    expect(screen.queryByText("style_editor.classes_shown")).toBeNull();
  });

  it("the preview lists the classes the map shows when the legend lists those in view", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const named = {
      ...CLASSIFY[0],
      classes: [
        { to: 10, name: "Sparse", fill: { color: "#ff0000" } },
        { from: 10, name: "Dense" },
      ],
    };
    const doc = { classify: [named], legend: { classes: "view" } };
    setup(doc, { legendLayer: { key: "7", dataset: "dataset-1" } });
    await userEvent.click(within(rowOf("style_editor.contents")).getByRole("button"));
    const preview = screen.getByTestId("legend-preview");
    // Until the map has counted its view the preview waits, rather than list every class and then shrink.
    expect(within(preview).queryByText("Sparse")).toBeNull();
    expect(preview.querySelector("[data-legend-pending]")).not.toBeNull();
    const map = {
      on: () => undefined,
      off: () => undefined,
      once: () => undefined,
      isMoving: () => false,
      loaded: () => true,
      getLayer: () => ({}),
      queryRenderedFeatures: () => [{ properties: { density: 25 } }],
    };
    const style = { version: "1.0.0", kind: "vector", ...doc };
    const watch = watchViewPresence(map, MAP_SCOPE, () => [{ key: "7", style }], {
      layerIds: () => ["7-fill"],
    });
    act(() => {
      watch.refresh();
      vi.runOnlyPendingTimers();
    });
    expect(within(preview).queryByText("Sparse")).toBeNull();
    expect(within(preview).getByText("Dense")).toBeDefined();
    expect(preview.querySelector("[data-legend-pending]")).toBeNull();
    act(() => watch.dispose());
    vi.useRealTimers();
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
