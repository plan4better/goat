/**
 * The area picker as a dialog shows it (the fetch dialog, the catalog's location filter): in place, its lists under
 * it, on a map of the dialog's own, with no limits and no inside or outside.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FilterArea, PolygonCoords } from "@/lib/filter/area";

import { AreaChooser } from "@/components/map/panels/filter/area/AreaChooser";
import { AreaToolsProvider } from "@/components/map/panels/filter/area/AreaTools";
import type { AreaHost, AreaWay } from "@/components/map/panels/filter/area/host";
import type { DrawnShape } from "@/components/map/panels/filter/area/useAreaDraw";

import { renderWithProviders } from "../../../styleEditor/__tests__/renderPanel";

// The dialog's map, by its id; the project's map is not there.
vi.mock("react-map-gl/maplibre", () => ({
  useMap: () => ({
    preview: {
      getBounds: () => ({
        toArray: () => [
          [7, 50],
          [8, 51],
        ],
      }),
      on: () => undefined,
      off: () => undefined,
    },
  }),
}));

const draw = vi.hoisted(() => ({
  target: undefined as unknown,
  drawing: null as string | null,
  done: undefined as ((drawn: DrawnShape) => void) | undefined,
  /** Finishes the edit with these polygons. */
  edited: undefined as ((polygons: PolygonCoords[]) => void) | undefined,
  start: vi.fn(),
  edit: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/components/map/panels/filter/area/useAreaDraw", async () => {
  const { useState } = await import("react");
  return {
    useAreaDraw: (target: unknown) => {
      draw.target = target;
      const [drawing, setDrawing] = useState<string | null>(null);
      const [editing, setEditing] = useState(false);
      return {
        available: true,
        drawing,
        editing,
        start: (shape: string, onDone: (drawn: DrawnShape) => void) => {
          draw.start(shape);
          setDrawing(shape);
          draw.done = (drawn) => {
            setDrawing(null);
            onDone(drawn);
          };
        },
        edit: (polygons: PolygonCoords[], onDone: (polygons: PolygonCoords[]) => void) => {
          draw.edit(polygons);
          setEditing(true);
          draw.edited = (next) => {
            setEditing(false);
            onDone(next);
          };
        },
        finish: draw.finish,
        cancel: () => {
          draw.cancel();
          setDrawing(null);
          setEditing(false);
        },
      };
    },
  };
});

const square = (x: number): PolygonCoords => [
  [
    [x, 0],
    [x + 1, 0],
    [x + 1, 1],
    [x, 0],
  ],
];
const geometry = { type: "Polygon", coordinates: square(4) };
vi.mock("@/lib/api/catalog", () => ({
  useCatalogNutsRegions: (query?: string) => ({
    regions: query === "bay" ? [{ nuts_id: "DE2", nuts_name: "Bayern", level: 1 }] : [],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/catalog/useCatalogNutsGeometries", () => ({
  useCatalogNutsGeometries: (ids: string[]) =>
    ids.includes("DE2") ? { shapes: { DE2: { geometry } } } : { shapes: {} },
}));

const WAYS: AreaWay[] = ["view", "polygon", "point", "regions"];

/** The area as the dialog keeps it. */
let latest: FilterArea | undefined;

function Dialog({ initial }: { initial?: FilterArea }) {
  const [area, setShown] = useState(initial);
  const now = useRef(initial);
  const host = useMemo<AreaHost>(
    () => ({
      area,
      read: () => now.current,
      setArea: (next) => {
        now.current = latest = next;
        setShown(next);
      },
      ops: false,
      ways: WAYS,
      map: { id: "preview", main: false },
    }),
    [area]
  );
  return (
    <AreaToolsProvider host={host}>
      <AreaChooser emptyText="nothing chosen" />
    </AreaToolsProvider>
  );
}

const openAdd = () => userEvent.click(screen.getByRole("button", { name: "filter_panel.area_add" }));
const item = (name: string) => screen.getByRole("menuitem", { name: new RegExp(name) });

beforeEach(() => {
  latest = undefined;
  vi.clearAllMocks();
});

describe("the area picker in a dialog", () => {
  it("draws on the dialog's map, and offers the host's ways without inside or outside", async () => {
    renderWithProviders(<Dialog />);
    expect(draw.target).toEqual({ id: "preview", main: false });
    expect(screen.getByText("nothing chosen")).toBeDefined();
    await openAdd();
    const offered = screen.getAllByRole("menuitem").map((row) => row.textContent);
    expect(offered).toEqual([
      "filter_panel.area_add_view",
      "filter_panel.area_add_polygon",
      "filter_panel.area_add_point",
      "filter_panel.area_add_regions",
    ]);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByText("filter_panel.area_inside")).toBeNull();
  });

  it("places a point: a circle of three kilometers around it, whose radius is set with a slider", async () => {
    renderWithProviders(<Dialog />);
    await openAdd();
    await userEvent.click(item("filter_panel.area_add_point"));
    expect(draw.start).toHaveBeenCalledWith("point");
    // The picker stays: it says what to do on the map, and how to stop.
    expect(screen.getByText("fetch_features_area_pick_on_map")).toBeDefined();
    expect(screen.getByRole("button", { name: "cancel" })).toBeDefined();

    act(() => draw.done?.({ shape: "point", at: [11, 48] }));
    expect(latest?.pieces).toHaveLength(1);
    expect(latest?.pieces[0]).toMatchObject({ kind: "shape", shape: "circle", center: [11, 48], km: 3 });
    expect(screen.getByText("filter_panel.area_shape_circle")).toBeDefined();
    expect(screen.queryByText("fetch_features_area_pick_on_map")).toBeNull();

    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuenow")).toBe("3");
    fireEvent.change(slider, { target: { value: 3.5 } });
    expect(latest?.pieces[0]).toMatchObject({ center: [11, 48], km: 3.5 });
  });

  it("opens the regions under the picker, adds a picked one and says no limit", async () => {
    renderWithProviders(<Dialog />);
    await openAdd();
    await userEvent.click(item("filter_panel.area_add_regions"));
    const list = screen.getByRole("region", { name: "filter_panel.area_add_regions" });
    await userEvent.type(
      within(list).getByRole("textbox", { name: "filter_panel.area_search_regions" }),
      "bay"
    );
    await userEvent.click(await within(list).findByRole("option", { name: /Bayern/ }));

    expect(latest?.pieces).toEqual([
      {
        kind: "features",
        source: "region",
        features: [{ id: "DE2", name: "Bayern", n: 1 }],
        polygons: [square(4)],
      },
    ]);
    expect(screen.queryByText(/filter_panel.picked/)).toBeNull();
    // Its row opens and closes the same list.
    const row = screen.getByRole("button", { name: /Bayern/ });
    await userEvent.click(row);
    expect(screen.queryByRole("region", { name: "filter_panel.area_add_regions" })).toBeNull();
    await userEvent.click(row);
    expect(screen.getByRole("region", { name: "filter_panel.area_add_regions" })).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.close" }));
    expect(screen.queryByRole("region", { name: "filter_panel.area_add_regions" })).toBeNull();
  });

  describe("editing a drawn polygon", () => {
    const polygonArea = (): FilterArea => ({
      pieces: [
        { kind: "shape", shape: "polygon", polygons: [square(0)] },
        { kind: "shape", shape: "circle", center: [11, 48], km: 3, polygons: [square(2)] },
      ],
      op: "inside",
      enabled: true,
    });

    it("loads it into the dialog map's draw tool; the picker stays and its row says Done", async () => {
      renderWithProviders(<Dialog initial={polygonArea()} />);
      // The circle keeps its radius slider instead.
      const edit = screen.getByRole("button", { name: "filter_panel.area_edit_piece" });
      await userEvent.click(edit);

      expect(draw.edit).toHaveBeenCalledExactlyOnceWith([square(0)]);
      expect(screen.getByText("filter_panel.area_editing")).toBeDefined();
      expect(screen.queryByRole("button", { name: "filter_panel.area_edit_piece" })).toBeNull();
      const dones = screen.getAllByRole("button", { name: "done" });
      // The row's and the line's under the picker.
      expect(dones).toHaveLength(2);
      await userEvent.click(dones[0]);
      expect(draw.finish).toHaveBeenCalledTimes(1);
    });

    it("puts the finished polygon where the old one was, the circle as it was", async () => {
      renderWithProviders(<Dialog initial={polygonArea()} />);
      await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_edit_piece" }));

      act(() => draw.edited?.([square(6)]));

      expect(latest?.pieces).toEqual([
        { kind: "shape", shape: "polygon", polygons: [square(6)] },
        { kind: "shape", shape: "circle", center: [11, 48], km: 3, polygons: [square(2)] },
      ]);
      expect(screen.queryByText("filter_panel.area_editing")).toBeNull();
    });

    it("moves a circle around a point: one click places its centre, its radius kept", async () => {
      renderWithProviders(<Dialog initial={polygonArea()} />);
      await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_move_circle" }));
      expect(draw.start).toHaveBeenCalledExactlyOnceWith("point");
      expect(screen.getByText("fetch_features_area_pick_on_map")).toBeDefined();

      act(() => draw.done?.({ shape: "point", at: [12, 49] }));

      expect(latest?.pieces[0]).toEqual({ kind: "shape", shape: "polygon", polygons: [square(0)] });
      expect(latest?.pieces[1]).toMatchObject({ kind: "shape", shape: "circle", center: [12, 49], km: 3 });
      expect(latest?.pieces[1].polygons[0][0][0]).not.toEqual(square(2)[0][0]);
    });

    it("leaves the area alone when the edit is given up", async () => {
      renderWithProviders(<Dialog initial={polygonArea()} />);
      await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_edit_piece" }));
      await userEvent.click(screen.getByRole("button", { name: "cancel" }));
      expect(draw.cancel).toHaveBeenCalled();
      expect(latest).toBeUndefined();
      expect(screen.getByRole("button", { name: "filter_panel.area_edit_piece" })).toBeDefined();
    });
  });

  it("removes a piece, and says nothing is chosen once the last is gone", async () => {
    renderWithProviders(
      <Dialog
        initial={{
          pieces: [{ kind: "shape", shape: "polygon", polygons: [square(0)] }],
          op: "inside",
          enabled: true,
        }}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_remove_piece" }));
    expect(latest).toBeUndefined();
    expect(screen.getByText("nothing chosen")).toBeDefined();
  });
});
