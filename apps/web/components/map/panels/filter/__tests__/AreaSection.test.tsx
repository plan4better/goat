import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AreaPiece,
  type FilterArea,
  type PolygonCoords,
  type Position,
  areaPolygons,
  pointCount,
  roundPolygons,
  viewPolygon,
} from "@/lib/filter/area";
import { filterIssues } from "@/lib/filter/issues";
import type { Fields, FilterModel } from "@/lib/filter/model";

import { layerSwatchIcon } from "@/components/map/legend/StyleLegend";
import { FilterPanel } from "@/components/map/panels/filter/FilterPanel";

import { renderWithProviders } from "../../styleEditor/__tests__/renderPanel";

// The map: where it is, and the listeners of its moves.
const map = vi.hoisted(() => {
  const state = { bounds: [7, 50, 8, 51] as number[], moved: new Set<() => void>() };
  const fake = {
    getBounds: () => ({
      toArray: () => [
        [state.bounds[0], state.bounds[1]],
        [state.bounds[2], state.bounds[3]],
      ],
    }),
    on: (_: string, listener: () => void) => state.moved.add(listener),
    off: (_: string, listener: () => void) => state.moved.delete(listener),
  };
  return { state, fake };
});
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({ map: map.fake }) }));

// The draw tool: what the panel asked of it, and a shape under way or being edited that the test sets.
const draw = vi.hoisted(() => ({
  available: true,
  drawing: null as "polygon" | "circle" | null,
  editing: false,
  listeners: new Set<() => void>(),
  start: vi.fn(),
  edit: vi.fn(),
  editCircle: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/components/map/panels/filter/area/useAreaDraw", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    draw.listeners.add(listener);
    return () => void draw.listeners.delete(listener);
  };
  return {
    useAreaDraw: () => ({
      available: draw.available,
      drawing: useSyncExternalStore(subscribe, () => draw.drawing),
      editing: useSyncExternalStore(subscribe, () => draw.editing),
      start: draw.start,
      edit: draw.edit,
      editCircle: draw.editCircle,
      finish: draw.finish,
      cancel: draw.cancel,
    }),
  };
});
const outline = vi.hoisted(() => vi.fn());
vi.mock("@/components/map/panels/filter/area/outline", () => ({ useAreaOutline: outline }));

const items = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/layers", () => ({
  useLayerUniqueValues: () => ({ data: undefined, isLoading: false }),
  useLayerQueryables: () => ({
    queryables: { properties: { name: { type: "string" }, size: { type: "number" } } },
    isLoading: false,
  }),
  useDatasetCollectionItems: items,
}));
vi.mock("@/lib/api/projects", async (original) => ({
  ...(await original<object>()),
  useProjectLayerHistogramStats: () => ({ histogramStats: undefined, isLoading: false }),
}));
vi.mock("@/lib/api/processes", () => ({
  useFeatureCount: () => ({ featureCount: 10, isLoading: false, isError: undefined }),
}));
const nuts = vi.hoisted(() => ({ regions: vi.fn(), geometries: vi.fn() }));
vi.mock("@/lib/api/catalog", () => ({ useCatalogNutsRegions: nuts.regions }));
vi.mock("@/hooks/catalog/useCatalogNutsGeometries", () => ({ useCatalogNutsGeometries: nuts.geometries }));

const FIELDS: Fields = { name: "string" };
const square = (x: number): PolygonCoords => [
  [
    [x, 0],
    [x + 1, 0],
    [x + 1, 1],
    [x, 0],
  ],
];
const VIEW: AreaPiece = { kind: "view", polygons: [viewPolygon([7, 50, 8, 51])] };
const shape = (x: number): AreaPiece => ({ kind: "shape", shape: "polygon", polygons: [square(x)] });
const areaOf = (pieces: AreaPiece[], rest: Partial<FilterArea> = {}): FilterArea => ({
  pieces,
  op: "inside",
  enabled: true,
  ...rest,
});

function setup(area: FilterArea | undefined, props: Partial<Parameters<typeof FilterPanel>[0]> = {}) {
  const model: FilterModel = { match: "all", rows: [], ...(area && { area }) };
  const onApply = vi.fn<(model: FilterModel) => Promise<void>>(async () => undefined);
  const view = renderWithProviders(
    <FilterPanel
      model={model}
      fields={FIELDS}
      issues={filterIssues(model, FIELDS)}
      canEdit
      onApply={onApply}
      layerId="dataset-1"
      areaLayers={[
        {
          id: "layer-1",
          name: "Districts",
          icon: layerSwatchIcon({
            style: { document: { version: "1.0.0", kind: "vector", symbol: { fill: { color: "#123456" } } } },
            feature_layer_geometry_type: "polygon",
          }),
        },
        { id: "layer-2", name: "Parks" },
      ]}
      {...props}
    />
  );
  return { ...view, onApply };
}

const row = () => document.querySelector("[data-filter-row='area']") as HTMLElement;
const applied = (onApply: ReturnType<typeof setup>["onApply"]) =>
  onApply.mock.calls.at(-1)?.[0] as FilterModel;
const openPicker = () => userEvent.click(within(row()).getAllByRole("button")[0]);
const openAddMenu = async () => {
  await openPicker();
  await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_add" }));
};
const menuItem = (name: string) => screen.getByRole("menuitem", { name: new RegExp(name) });

describe("the filter's area", () => {
  beforeEach(() => {
    map.state.bounds = [7, 50, 8, 51];
    map.state.moved.clear();
    draw.available = true;
    draw.drawing = null;
    draw.editing = false;
    draw.start.mockReset();
    draw.edit.mockReset();
    draw.editCircle.mockReset();
    draw.finish.mockReset();
    draw.cancel.mockReset();
    outline.mockClear();
    items.mockReset();
    items.mockReturnValue({ data: undefined, isLoading: false });
    nuts.regions.mockReset();
    nuts.regions.mockReturnValue({ regions: [], isLoading: false });
    nuts.geometries.mockReset();
    nuts.geometries.mockReturnValue({ shapes: {}, geometries: {}, isLoading: false });
  });

  it("without an area the row says the whole layer and opens the picker", async () => {
    const { onApply } = setup(undefined);
    expect(within(row()).getByText("filter_panel.area_whole")).toBeDefined();
    expect(within(row()).queryByRole("checkbox")).toBeNull();
    expect(within(row()).queryByRole("button", { name: "filter_panel.area_remove" })).toBeNull();
    await openPicker();
    expect(screen.getByRole("button", { name: "filter_panel.area_add" })).toBeDefined();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a set area says its pieces, the shapes counted together", () => {
    setup(areaOf([VIEW, shape(0), shape(2)]));
    expect(within(row()).getByText("filter_panel.area_view, filter_panel.area_shapes")).toBeDefined();
    expect(within(row()).queryByText("filter_panel.area_whole")).toBeNull();
  });

  it("makes room on hover only for a remove button the row has: the whole layer's row has none", () => {
    setup(undefined);
    expect(row().hasAttribute("data-removable")).toBe(false);
  });

  it("an area's row keeps room for its remove button", () => {
    setup(areaOf([VIEW]));
    expect(row().hasAttribute("data-removable")).toBe(true);
  });

  it("shows the draft's area on the map", () => {
    const area = areaOf([VIEW]);
    setup(area);
    expect(outline).toHaveBeenLastCalledWith(area);
  });

  it("draws no area on the map while the panel is off screen (another tab)", () => {
    setup(areaOf([VIEW]), { shown: false });
    expect(outline).toHaveBeenLastCalledWith(undefined);
  });

  it("the row names the layer the features are of, while the project has it", () => {
    const features = (source: string): AreaPiece => ({
      kind: "features",
      source,
      features: [
        { id: "1", n: 1 },
        { id: "2", n: 1 },
      ],
      polygons: [square(0), square(2)],
    });
    setup(areaOf([features("layer-1")]));
    expect(within(row()).getByText("filter_panel.area_features_of")).toBeDefined();
    cleanup();
    setup(areaOf([features("layer-9")]));
    expect(within(row()).getByText("filter_panel.area_features")).toBeDefined();
  });

  describe("under the row, while the area is outlined on the map", () => {
    const OUTLINED = "filter_panel.area_outlined";
    const OUTLINED_OFF = "filter_panel.area_outlined_off";

    it("says so", () => {
      setup(areaOf([VIEW]));
      expect(screen.getByText(OUTLINED)).toBeDefined();
      expect(screen.queryByText(OUTLINED_OFF)).toBeNull();
    });

    it("says it is switched off", () => {
      setup(areaOf([VIEW], { enabled: false }));
      expect(screen.getByText(OUTLINED_OFF)).toBeDefined();
      expect(screen.queryByText(OUTLINED)).toBeNull();
    });

    it("says nothing while the tab is not the open one, or without an area", () => {
      setup(areaOf([VIEW]), { shown: false });
      expect(screen.queryByText(OUTLINED)).toBeNull();
      cleanup();
      setup(undefined);
      expect(screen.queryByText(OUTLINED)).toBeNull();
      expect(screen.queryByText(OUTLINED_OFF)).toBeNull();
    });
  });

  it("the switch turns the area off and on", async () => {
    const { onApply } = setup(areaOf([VIEW]));
    const toggle = within(row()).getByRole("checkbox", { name: "filter_panel.area_switch" });
    await userEvent.click(toggle);
    expect(applied(onApply).area).toMatchObject({ enabled: false, pieces: [VIEW] });
    await userEvent.click(toggle);
    expect(applied(onApply).area?.enabled).toBe(true);
  });

  it("the trash removes the area", async () => {
    const { onApply } = setup(areaOf([VIEW, shape(0)]));
    await userEvent.click(within(row()).getByRole("button", { name: "filter_panel.area_remove" }));
    expect(applied(onApply)).toEqual({ match: "all", rows: [] });
    expect(within(row()).getByText("filter_panel.area_whole")).toBeDefined();
  });

  it("keeps the features inside or outside", async () => {
    const { onApply } = setup(areaOf([VIEW]));
    await openPicker();
    await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_outside" }));
    expect(applied(onApply).area?.op).toBe("outside");
    expect(within(row()).getByText("filter_panel.area_outside_of")).toBeDefined();
  });

  it("adds the map view as the first piece", async () => {
    map.state.bounds = [11, 48, 12, 49];
    const { onApply } = setup(undefined);
    await openAddMenu();
    await userEvent.click(menuItem("filter_panel.area_add_view"));
    expect(applied(onApply).area).toEqual({
      pieces: [{ kind: "view", polygons: [viewPolygon([11, 48, 12, 49])] }],
      op: "inside",
      enabled: true,
    });
  });

  it("removes a piece in the picker, and the area with its last one", async () => {
    const { onApply } = setup(areaOf([VIEW, shape(0)]));
    await openPicker();
    const remove = () => screen.getAllByRole("button", { name: "filter_panel.area_remove_piece" });
    expect(remove()).toHaveLength(2);
    await userEvent.click(remove()[0]);
    expect(applied(onApply).area?.pieces).toEqual([shape(0)]);
    await userEvent.click(remove()[0]);
    expect(applied(onApply).area).toBeUndefined();
  });

  it("offers nothing the limits leave no room for", async () => {
    const features: AreaPiece = {
      kind: "features",
      source: "region",
      features: Array.from({ length: 200 }, (_, i) => ({ id: `R${i}`, name: `Region ${i}`, n: 1 })),
      polygons: Array.from({ length: 200 }, (_, i) => square(10 + i)),
    };
    setup(areaOf([VIEW, shape(0), shape(2), shape(4), features]));
    await openAddMenu();
    for (const name of ["add_view", "add_polygon", "add_circle", "add_regions", "add_features"]) {
      expect(menuItem(`filter_panel.area_${name}`).getAttribute("aria-disabled")).toBe("true");
    }
    expect(screen.getAllByText("filter_panel.area_limit_shapes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("filter_panel.area_limit_features").length).toBeGreaterThan(0);
  });

  it("offers no drawing while the map's draw tool is not free", async () => {
    draw.available = false;
    setup(undefined);
    await openAddMenu();
    expect(menuItem("filter_panel.area_add_polygon").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("filter_panel.area_add_circle").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("filter_panel.area_add_view").getAttribute("aria-disabled")).toBeNull();
  });

  it("draws a shape on the map: the picker closes, the section says so, the shape joins the area", async () => {
    const { onApply } = setup(areaOf([shape(0), VIEW]));
    await openAddMenu();
    await userEvent.click(menuItem("filter_panel.area_add_circle"));
    expect(draw.start).toHaveBeenCalledWith("circle", expect.any(Function));
    expect(screen.queryByRole("button", { name: "filter_panel.area_add" })).toBeNull();

    act(() => {
      draw.drawing = "circle";
      draw.listeners.forEach((listener) => listener());
    });
    expect(screen.getByText("filter_panel.area_drawing")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(draw.cancel).toHaveBeenCalled();

    const done = draw.start.mock.calls[0][1] as (drawn: unknown) => void;
    await act(async () => done({ shape: "circle", center: [11, 48], km: 2 }));
    // After the other shape, before the map view; it keeps its centre and radius.
    const [first, circle, last] = applied(onApply).area?.pieces ?? [];
    expect(first).toEqual(shape(0));
    expect(circle).toMatchObject({ kind: "shape", shape: "circle", center: [11, 48], km: 2 });
    expect(circle.polygons[0][0]).toHaveLength(65);
    expect(last).toEqual(VIEW);
  });

  describe("a drawn circle", () => {
    const circle = (center: Position, km: number, label?: string): AreaPiece => ({
      kind: "shape",
      shape: "circle",
      center,
      km,
      ...(label && { label }),
      polygons: [square(8)],
    });
    const radiusField = () =>
      screen.getByRole("textbox", { name: "filter_panel.area_radius" }) as HTMLInputElement;
    const setEditing = (editing: boolean) =>
      act(() => {
        draw.editing = editing;
        draw.listeners.forEach((listener) => listener());
      });

    it("saved before circles kept their centre is the polygon it is: no edit and no radius", async () => {
      setup(areaOf([{ kind: "shape", shape: "circle", polygons: [square(8)] }]));
      await openPicker();
      expect(screen.queryByRole("button", { name: "filter_panel.area_edit_circle" })).toBeNull();
      expect(screen.queryByRole("textbox", { name: "filter_panel.area_radius" })).toBeNull();
    });

    it("is moved and resized on the map: the picker closes, the section says how, the new circle takes its place", async () => {
      const { onApply } = setup(areaOf([shape(0), circle([11, 48], 2, "School"), VIEW]));
      await openPicker();
      await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_edit_circle" }));

      expect(draw.editCircle).toHaveBeenCalledExactlyOnceWith(
        { center: [11, 48], km: 2 },
        expect.any(Function)
      );
      expect(screen.queryByRole("button", { name: "filter_panel.area_add" })).toBeNull();
      setEditing(true);
      expect(screen.getByText("filter_panel.area_editing_circle")).toBeDefined();
      // The draw tool shows the circle being edited; the outline leaves its ring and its centre out meanwhile.
      const drawn = outline.mock.lastCall?.[0] as FilterArea;
      expect(areaPolygons(drawn)).toEqual([square(0), VIEW.polygons[0]]);
      expect(drawn.pieces[1]).not.toHaveProperty("center");

      const finished = draw.editCircle.mock.calls[0][1] as (circle: { center: Position; km: number }) => void;
      await act(async () => finished({ center: [11.5, 48.5], km: 0.8 }));
      setEditing(false);

      const [first, moved, last] = applied(onApply).area?.pieces ?? [];
      expect(first).toEqual(shape(0));
      expect(moved).toMatchObject({ shape: "circle", center: [11.5, 48.5], km: 0.8, label: "School" });
      expect(moved.polygons[0][0]).toHaveLength(65);
      expect(last).toEqual(VIEW);
    });

    it("takes a radius typed in its row, in meters below a kilometer", async () => {
      const { onApply } = setup(areaOf([circle([11, 48], 0.5)]));
      await openPicker();
      expect(radiusField().value).toBe("500");
      await userEvent.clear(radiusField());
      await userEvent.type(radiusField(), "750");
      expect(applied(onApply).area?.pieces[0]).toMatchObject({ center: [11, 48], km: 0.75 });
    });
  });

  describe("editing a drawn polygon", () => {
    const CIRCLE: AreaPiece = { kind: "shape", shape: "circle", polygons: [square(8)] };
    const editButtons = () => screen.getAllByRole("button", { name: "filter_panel.area_edit_piece" });
    /** The draw tool takes the shape on, or lets it go. */
    const setEditing = (editing: boolean) =>
      act(() => {
        draw.editing = editing;
        draw.listeners.forEach((listener) => listener());
      });
    /** What the edit hands back once it is finished. */
    const finished = () => draw.edit.mock.calls[0][1] as (polygons: PolygonCoords[]) => void;

    it("offers an edit for drawn polygons only, not for a circle, the map view or picked features", async () => {
      setup(areaOf([VIEW, CIRCLE, shape(0), shape(2)]));
      await openPicker();
      expect(editButtons()).toHaveLength(2);
    });

    it("loads the shape into the draw tool: the picker closes, the section says what to do", async () => {
      setup(areaOf([VIEW, shape(0), shape(2)]));
      await openPicker();
      await userEvent.click(editButtons()[1]);

      expect(draw.edit).toHaveBeenCalledExactlyOnceWith([square(2)], expect.any(Function));
      expect(screen.queryByRole("button", { name: "filter_panel.area_add" })).toBeNull();
      setEditing(true);
      expect(screen.getByText("filter_panel.area_editing")).toBeDefined();
      await userEvent.click(screen.getByRole("button", { name: "done" }));
      expect(draw.finish).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole("button", { name: "cancel" }));
      expect(draw.cancel).toHaveBeenCalled();
    });

    it("draws the area without the old shape while it is edited, and whole again after", async () => {
      setup(areaOf([VIEW, shape(0), shape(2)]));
      await openPicker();
      await userEvent.click(editButtons()[0]);
      setEditing(true);
      const drawn = () => areaPolygons(outline.mock.lastCall?.[0] as FilterArea);
      expect(drawn()).toEqual([VIEW.polygons[0], square(2)]);
      setEditing(false);
      expect(drawn()).toEqual([VIEW.polygons[0], square(0), square(2)]);
    });

    it("puts the finished shape where the old one was", async () => {
      const { onApply } = setup(areaOf([shape(0), shape(2), VIEW]));
      await openPicker();
      await userEvent.click(editButtons()[0]);
      setEditing(true);

      await act(async () => finished()([square(6)]));
      setEditing(false);

      expect(applied(onApply).area?.pieces).toEqual([shape(6), shape(2), VIEW]);
      expect(within(row()).getByText("filter_panel.area_shapes, filter_panel.area_view")).toBeDefined();
    });

    it("keeps the area as it was when the edit is given up", async () => {
      const { onApply } = setup(areaOf([shape(0), VIEW]));
      await openPicker();
      await userEvent.click(editButtons()[0]);
      setEditing(true);
      await userEvent.click(screen.getByRole("button", { name: "cancel" }));
      setEditing(false);

      expect(draw.cancel).toHaveBeenCalled();
      expect(onApply).not.toHaveBeenCalled();
      expect(areaPolygons(outline.mock.lastCall?.[0] as FilterArea)).toEqual([square(0), VIEW.polygons[0]]);
    });

    it("asks about an edited outline too big for the filter, and puts it in simplified where the old one was", async () => {
      // 6000 points, more than one filter holds.
      const ring = Array.from({ length: 6000 }, (_, i): Position => {
        const a = (i / 6000) * 2 * Math.PI;
        return [10 + Math.cos(a), 50 + Math.sin(a)];
      });
      const { onApply } = setup(areaOf([shape(0), shape(2)]));
      await openPicker();
      await userEvent.click(editButtons()[0]);
      setEditing(true);
      // Rounded, as the draw tool hands an edit back.
      await act(async () => finished()(roundPolygons([[[...ring, ring[0]]]])));
      setEditing(false);

      expect(screen.getByText("filter_panel.area_simplify_question")).toBeInTheDocument();
      expect(onApply).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_add_simplified" }));
      const [edited, other] = applied(onApply).area?.pieces ?? [];
      expect(edited).toMatchObject({ kind: "shape", shape: "polygon" });
      expect(pointCount(edited.polygons)).toBeLessThanOrEqual(2000);
      expect(pointCount(edited.polygons)).toBeGreaterThan(1500);
      expect(other).toEqual(shape(2));
    });

    it("lets nothing else be drawn or edited meanwhile; the edited row has its Done", async () => {
      setup(areaOf([shape(0), shape(2)]));
      await openPicker();
      await userEvent.click(editButtons()[0]);
      setEditing(true);

      await openAddMenu();
      expect(menuItem("filter_panel.area_add_polygon").getAttribute("aria-disabled")).toBe("true");
      expect(menuItem("filter_panel.area_add_circle").getAttribute("aria-disabled")).toBe("true");
      await userEvent.keyboard("{Escape}");
      // The other polygon waits; the edited one's row is marked and says Done.
      expect(editButtons()).toHaveLength(1);
      expect((editButtons()[0] as HTMLButtonElement).disabled).toBe(true);
      const removes = screen.getAllByRole("button", { name: "filter_panel.area_remove_piece" });
      const edited = removes[0].closest("[data-active]") as HTMLElement;
      expect(removes[1].closest("[data-active]")).toBeNull();
      await userEvent.click(within(edited).getByRole("button", { name: "done" }));
      expect(draw.finish).toHaveBeenCalledTimes(1);
    });

    it("gives the edit up once the shape is no longer in the area", async () => {
      setup(areaOf([shape(0), VIEW]));
      await openPicker();
      await userEvent.click(editButtons()[0]);
      setEditing(true);
      expect(draw.cancel).not.toHaveBeenCalled();
      await userEvent.click(within(row()).getByRole("button", { name: "filter_panel.area_remove" }));
      expect(draw.cancel).toHaveBeenCalled();
    });

    it("gives the edit up when the panel goes off screen (another tab)", async () => {
      const panel: { show?: (shown: boolean) => void } = {};
      function Switchable() {
        const [shown, setShown] = useState(true);
        panel.show = setShown;
        return (
          <FilterPanel
            model={{ match: "all", rows: [], area: areaOf([shape(0)]) }}
            fields={FIELDS}
            issues={filterIssues({ match: "all", rows: [] }, FIELDS)}
            canEdit
            onApply={async () => undefined}
            layerId="dataset-1"
            shown={shown}
          />
        );
      }
      renderWithProviders(<Switchable />);
      await openPicker();
      await userEvent.click(editButtons()[0]);
      setEditing(true);
      expect(draw.cancel).not.toHaveBeenCalled();
      act(() => panel.show?.(false));
      expect(draw.cancel).toHaveBeenCalled();
    });
  });

  it("offers the current view once the map has moved off the map view piece", async () => {
    const { onApply } = setup(areaOf([VIEW]));
    expect(within(row()).queryByRole("button", { name: "filter_panel.area_use_view" })).toBeNull();
    act(() => {
      map.state.bounds = [9, 50, 10, 51];
      map.state.moved.forEach((listener) => listener());
    });
    await userEvent.click(within(row()).getByRole("button", { name: "filter_panel.area_use_view" }));
    expect(applied(onApply).area?.pieces).toEqual([
      { kind: "view", polygons: [viewPolygon([9, 50, 10, 51])] },
    ]);
    expect(within(row()).queryByRole("button", { name: "filter_panel.area_use_view" })).toBeNull();
  });

  it("picks a region: its outline joins the area once it is loaded", async () => {
    nuts.regions.mockImplementation((query?: string) => ({
      regions: query === "bay" ? [{ nuts_id: "DE2", nuts_name: "Bayern", level: 1 }] : [],
      isLoading: false,
    }));
    const geometry = { type: "MultiPolygon", coordinates: [square(0), square(2)] };
    nuts.geometries.mockImplementation((ids: string[]) =>
      ids.includes("DE2")
        ? { shapes: { DE2: { geometry } }, geometries: { DE2: geometry }, isLoading: false }
        : { shapes: {}, geometries: {}, isLoading: false }
    );
    const { onApply } = setup(undefined);
    await openAddMenu();
    await userEvent.click(menuItem("filter_panel.area_add_regions"));
    await userEvent.type(screen.getByRole("textbox", { name: "filter_panel.area_search_regions" }), "bay");
    await userEvent.click(await screen.findByRole("option", { name: /Bayern/ }));
    expect(applied(onApply).area?.pieces).toEqual([
      {
        kind: "features",
        source: "region",
        features: [{ id: "DE2", name: "Bayern", n: 2 }],
        polygons: [square(0), square(2)],
      },
    ]);
    expect(screen.getByRole("option", { name: /Bayern/ }).getAttribute("aria-selected")).toBe("true");
    // Unticked, it leaves with its polygons: the area had nothing else.
    await userEvent.click(screen.getByRole("option", { name: /Bayern/ }));
    expect(applied(onApply).area).toBeUndefined();
  });

  describe("an outline too big for the filter", () => {
    // A circle of 6000 points as region DE.
    const ring = Array.from({ length: 6000 }, (_, i): Position => {
      const a = (i / 6000) * 2 * Math.PI;
      return [10 + Math.cos(a), 50 + Math.sin(a)];
    });
    const circle = { type: "Polygon", coordinates: [[...ring, ring[0]]] };
    // 600 small squares: four positions each are already more than the limit.
    const crumbs = {
      type: "MultiPolygon",
      coordinates: Array.from({ length: 600 }, (_, i) => square(i * 0.01)),
    };
    const pickRegion = async (geometry: unknown) => {
      nuts.regions.mockReturnValue({
        regions: [{ nuts_id: "DE", nuts_name: "Deutschland", level: 0 }],
        isLoading: false,
      });
      nuts.geometries.mockImplementation((ids: string[]) =>
        ids.length
          ? { shapes: { DE: { geometry } }, geometries: { DE: geometry }, isLoading: false }
          : { shapes: {}, geometries: {}, isLoading: false }
      );
      const view = setup(undefined);
      await openAddMenu();
      await userEvent.click(menuItem("filter_panel.area_add_regions"));
      await userEvent.type(screen.getByRole("textbox", { name: "filter_panel.area_search_regions" }), "de");
      await userEvent.click(await screen.findByRole("option", { name: /Deutschland/ }));
      return view;
    };
    const option = () => screen.getByRole("option", { name: /Deutschland/ });
    // The list's popover: the box around its listbox.
    const regionList = () =>
      screen.getByRole("listbox", { name: "filter_panel.area_search_regions" }).parentElement as HTMLElement;

    it("is asked about in the list it was picked from, and only there", async () => {
      await pickRegion(circle);
      expect(
        await within(regionList()).findByText("filter_panel.area_simplify_question")
      ).toBeInTheDocument();
      expect(screen.getAllByText("filter_panel.area_simplify_question")).toHaveLength(1);
    });

    it("is forgotten when its list closes", async () => {
      const { onApply } = await pickRegion(circle);
      await screen.findByText("filter_panel.area_simplify_question");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("listbox", { name: "filter_panel.area_search_regions" })).toBeNull();
      expect(screen.queryByText("filter_panel.area_simplify_question")).not.toBeInTheDocument();
      expect(applied(onApply)?.area).toBeUndefined();
    });

    it("drawn on the map, is asked about under the area", async () => {
      const { onApply } = setup(undefined);
      await openAddMenu();
      await userEvent.click(menuItem("filter_panel.area_add_polygon"));
      const done = draw.start.mock.calls[0][1] as (drawn: unknown) => void;
      await act(async () => done({ shape: "polygon", polygons: [[ring]] }));
      expect(screen.getByText("filter_panel.area_simplify_question")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_add_simplified" }));
      expect(pointCount(applied(onApply).area?.pieces[0].polygons ?? [])).toBeLessThanOrEqual(2000);
    });

    it("is added only after the person agrees to simplify it", async () => {
      const { onApply } = await pickRegion(circle);
      expect(await screen.findByText("filter_panel.area_simplify_question")).toBeInTheDocument();
      expect(applied(onApply)?.area).toBeUndefined();
      expect(option().getAttribute("aria-selected")).toBe("false");

      await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_add_simplified" }));
      const [piece] = applied(onApply).area?.pieces ?? [];
      expect(piece).toMatchObject({ kind: "features", source: "region", features: [{ id: "DE" }] });
      expect(pointCount(piece.polygons)).toBeLessThanOrEqual(2000);
      expect(pointCount(piece.polygons)).toBeGreaterThan(1500);
      expect(screen.queryByText("filter_panel.area_simplify_question")).not.toBeInTheDocument();
      expect(option().getAttribute("aria-selected")).toBe("true");
    });

    it("is not added when the person says no", async () => {
      const { onApply } = await pickRegion(circle);
      await userEvent.click(await screen.findByRole("button", { name: "cancel" }));
      expect(applied(onApply)?.area).toBeUndefined();
      expect(screen.queryByText("filter_panel.area_simplify_question")).not.toBeInTheDocument();
      expect(option().getAttribute("aria-selected")).toBe("false");
    });

    it("is refused when even simplified it does not fit", async () => {
      const { onApply } = await pickRegion(crumbs);
      expect(await screen.findByText("filter_panel.area_over_limit")).toBeInTheDocument();
      expect(screen.queryByText("filter_panel.area_simplify_question")).not.toBeInTheDocument();
      expect(applied(onApply)?.area).toBeUndefined();
    });
  });

  it("shows each polygon layer with its legend, else a polygon", async () => {
    setup(areaOf([VIEW]));
    await openAddMenu();
    await userEvent.click(menuItem("filter_panel.area_add_features"));
    const districts = await screen.findByRole("option", { name: /Districts/ });
    expect(districts.innerHTML).toContain("#123456");
    const parks = screen.getByRole("option", { name: /Parks/ });
    expect(parks.innerHTML).not.toContain("#123456");
    expect(parks.querySelector("svg")).not.toBeNull();
  });

  it("picks features of another polygon layer of the project", async () => {
    // The same answer every time, as SWR keeps it.
    const answer = {
      numberMatched: 2,
      features: [
        {
          id: "1",
          properties: { name: "Altstadt" },
          geometry: { type: "Polygon", coordinates: square(0) },
        },
        {
          id: "2",
          properties: { name: "Neustadt" },
          geometry: { type: "Polygon", coordinates: square(2) },
        },
      ],
    };
    items.mockImplementation((layerId: string) => ({ data: layerId ? answer : undefined, isLoading: false }));
    const { onApply } = setup(areaOf([VIEW]));
    await openAddMenu();
    await userEvent.click(menuItem("filter_panel.area_add_features"));
    await userEvent.click(await screen.findByRole("option", { name: /Districts/ }));
    expect(items).toHaveBeenLastCalledWith("layer-1", { limit: 50, offset: 0, properties: "name" });
    await userEvent.click(await screen.findByRole("option", { name: /Neustadt/ }));
    expect(applied(onApply).area?.pieces).toEqual([
      VIEW,
      {
        kind: "features",
        source: "layer-1",
        features: [{ id: "2", name: "Neustadt", n: 1 }],
        polygons: [square(2)],
      },
    ]);
  });

  describe("the features of another layer", () => {
    const DISTRICTS = { op: "=", args: [{ property: "kind" }, "district"] };
    /** `total` features named "Area 1" and on, of which the items request answers the page it is asked for: the
     * same answer for the same request, as SWR keeps it. */
    const layerOf = (total: number) => {
      const answers = new Map<string, unknown>();
      items.mockImplementation((layerId: string, params?: { limit: number; offset: number }) => {
        if (!layerId || !params) return { data: undefined, isLoading: false };
        const key = JSON.stringify([layerId, params]);
        if (!answers.has(key)) {
          const count = Math.max(0, Math.min(params.limit, total - params.offset));
          const features = Array.from({ length: count }, (_, i) => {
            const n = params.offset + i + 1;
            return {
              id: String(n),
              properties: { name: `Area ${n}` },
              geometry: { type: "Polygon", coordinates: square(n) },
            };
          });
          answers.set(key, { data: { numberMatched: total, features }, isLoading: false });
        }
        return answers.get(key);
      });
    };
    const openList = async () => {
      const view = setup(areaOf([VIEW]), {
        areaLayers: [{ id: "layer-1", name: "Districts", filter: DISTRICTS }],
      });
      await openAddMenu();
      await userEvent.click(menuItem("filter_panel.area_add_features"));
      await userEvent.click(await screen.findByRole("option", { name: /Districts/ }));
      return view;
    };
    const list = () => screen.getByRole("listbox", { name: "filter_panel.area_search_features" });
    const listed = () => within(list()).getAllByRole("option");
    const lastParams = () => items.mock.lastCall?.[1] as Record<string, unknown>;

    it("lists only the features the layer's saved filter keeps, as the map shows them", async () => {
      layerOf(3);
      await openList();
      expect(JSON.parse(lastParams().filter as string)).toEqual(DISTRICTS);
      expect(listed()).toHaveLength(3);
    });

    it("searches within the features the saved filter keeps", async () => {
      layerOf(3);
      await openList();
      await userEvent.type(screen.getByRole("textbox", { name: "filter_panel.area_search_features" }), "Alt");
      await waitFor(() =>
        expect(JSON.parse(lastParams().filter as string)).toEqual({
          op: "and",
          args: [DISTRICTS, { op: "like", args: [{ property: "name" }, "%Alt%"] }],
        })
      );
      expect(lastParams().offset).toBe(0);
    });

    it("loads the next page once the list is scrolled to its end, and stops at the last", async () => {
      layerOf(120);
      await openList();
      expect(listed()).toHaveLength(50);
      expect(screen.getByText("filter_panel.area_more")).toBeDefined();

      fireEvent.scroll(list());
      expect(lastParams()).toMatchObject({ limit: 50, offset: 50 });
      await waitFor(() => expect(listed()).toHaveLength(100));
      fireEvent.scroll(list());
      expect(lastParams()).toMatchObject({ limit: 50, offset: 100 });
      await waitFor(() => expect(listed()).toHaveLength(120));
      expect(screen.queryByText("filter_panel.area_more")).toBeNull();

      const asked = items.mock.calls.length;
      fireEvent.scroll(list());
      expect(
        items.mock.calls.slice(asked).every((call) => (call[1] as { offset: number }).offset === 100)
      ).toBe(true);
    });

    it("picks a feature of a later page, with its outline", async () => {
      layerOf(60);
      const { onApply } = await openList();
      fireEvent.scroll(list());
      await userEvent.click(await within(list()).findByRole("option", { name: /Area 55/ }));
      expect(applied(onApply).area?.pieces[1]).toEqual({
        kind: "features",
        source: "layer-1",
        features: [{ id: "55", name: "Area 55", n: 1 }],
        polygons: [square(55)],
      });
    });
  });

  it("a viewer reads the area and changes nothing", () => {
    setup(areaOf([VIEW]), { canEdit: false });
    expect(within(row()).getByText("filter_panel.area_view")).toBeDefined();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("where the area is hidden a saved one shows as a line that can only be removed", async () => {
    const { onApply } = setup(areaOf([VIEW, shape(0)]), { area: false, canSwitch: false });
    expect(within(row()).getByText("filter_panel.area_view, filter_panel.area_shape_polygon")).toBeDefined();
    expect(within(row()).queryByRole("checkbox")).toBeNull();
    expect(within(row()).getAllByRole("button")).toHaveLength(1);
    expect(outline).not.toHaveBeenCalled();
    await userEvent.click(within(row()).getByRole("button", { name: "filter_panel.area_remove" }));
    expect(applied(onApply)).toEqual({ match: "all", rows: [] });
    // Gone, the section goes with it.
    expect(row()).toBeNull();
    expect(screen.queryByText("filter_panel.area")).toBeNull();
  });

  it("where the area is hidden and there is none, nothing says area", () => {
    setup(undefined, { area: false });
    expect(row()).toBeNull();
    expect(screen.queryByText("filter_panel.area")).toBeNull();
  });
});
