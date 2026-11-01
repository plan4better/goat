import { configureStore } from "@reduxjs/toolkit";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { mapReducer } from "@/lib/store/map/slice";
import type { ProjectLayer } from "@/lib/validations/project";
import type { FilterDataSchema } from "@/lib/validations/widget";

import { FilterDataWidget } from "@/components/builder/widgets/data/WidgetFilter";

vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({ map: undefined }) }));
vi.mock("@/lib/api/layers", () => ({ useDatasetCollectionItems: () => ({ data: undefined }) }));
vi.mock("@/hooks/map/CommonHooks", () => ({
  default: () => ({ layerFields: [{ name: "category", type: "string" }] }),
}));
vi.mock("@/components/builder/widgets/common/WidgetStatusContainer", () => ({
  WidgetStatusContainer: () => null,
}));
vi.mock("@/components/builder/widgets/data/ChipsFilter", () => ({
  default: ({
    selectedValues,
    onSelectedValuesChange,
  }: {
    selectedValues: string[];
    onSelectedValuesChange: (values: string[]) => void;
  }) => (
    <div>
      <span data-testid="selected">{selectedValues.join(",")}</span>
      <button onClick={() => onSelectedValuesChange(["A", "B"])}>pick</button>
    </div>
  ),
}));
vi.mock("@/components/builder/widgets/data/RangeFilter", () => ({
  default: ({
    selectedRange,
    onSelectedRangeChange,
  }: {
    selectedRange: [number, number] | null;
    onSelectedRangeChange: (range: [number, number]) => void;
  }) => (
    <div>
      <span data-testid="range">{selectedRange ? selectedRange.join("-") : ""}</span>
      <button onClick={() => onSelectedRangeChange([10, 20])}>pick-range</button>
    </div>
  ),
}));

const layer = { id: 1, layer_id: "layer-uuid" } as unknown as ProjectLayer;

const chipsConfig = {
  setup: { layout: "chips", layer_project_id: 1, column_name: "category", multiple: true },
  options: {},
} as unknown as FilterDataSchema;

const rangeConfig = {
  setup: { layout: "range", layer_project_id: 1, column_name: "population" },
  options: {},
} as unknown as FilterDataSchema;

const renderWidget = (store: ReturnType<typeof makeStore>, config: FilterDataSchema) =>
  render(
    <Provider store={store}>
      <FilterDataWidget id="filter-1" config={config} projectLayers={[layer]} />
    </Provider>
  );

const makeStore = () => configureStore({ reducer: { map: mapReducer } });

describe("FilterDataWidget remount", () => {
  it("keeps the filter and the selection when the widget remounts (tab switch)", () => {
    const store = makeStore();
    const first = renderWidget(store, chipsConfig);

    fireEvent.click(screen.getByText("pick"));
    const applied = store.getState().map.temporaryFilters;
    expect(applied).toHaveLength(1);

    // Switching to another tab unmounts the widget, switching back mounts it again.
    first.unmount();
    renderWidget(store, chipsConfig);

    expect(store.getState().map.temporaryFilters).toEqual(applied);
    expect(screen.getByTestId("selected").textContent).toBe("A,B");
  });

  it("keeps a range filter when the widget remounts", () => {
    const store = makeStore();
    const first = renderWidget(store, rangeConfig);

    fireEvent.click(screen.getByText("pick-range"));
    const applied = store.getState().map.temporaryFilters;
    expect(applied).toHaveLength(1);

    first.unmount();
    renderWidget(store, rangeConfig);

    expect(store.getState().map.temporaryFilters).toEqual(applied);
    expect(screen.getByTestId("range").textContent).toBe("10-20");
  });

  it("still clears the filter when the column is changed in the config", () => {
    const store = makeStore();
    const view = renderWidget(store, chipsConfig);

    fireEvent.click(screen.getByText("pick"));
    expect(store.getState().map.temporaryFilters).toHaveLength(1);

    const changed = {
      ...chipsConfig,
      setup: { ...chipsConfig.setup, column_name: "other" },
    } as FilterDataSchema;
    act(() => {
      view.rerender(
        <Provider store={store}>
          <FilterDataWidget id="filter-1" config={changed} projectLayers={[layer]} />
        </Provider>
      );
    });

    expect(store.getState().map.temporaryFilters).toHaveLength(0);
    expect(screen.getByTestId("selected").textContent).toBe("");
  });
});
