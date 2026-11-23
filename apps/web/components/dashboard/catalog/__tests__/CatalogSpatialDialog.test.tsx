import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CatalogSpatialDialog from "@/components/dashboard/catalog/CatalogSpatialDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    i18n: { language: "en" },
  }),
}));

vi.mock("react-map-gl/maplibre", () => ({
  Map: ({ children }: { children?: React.ReactNode }) => <div data-testid="map">{children}</div>,
  MapProvider: ({ children }: { children?: React.ReactNode }) => children,
  Layer: () => null,
  Source: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  useMap: () => ({}),
}));
vi.mock("@/components/map/controls/Draw", () => ({ DrawControl: () => null }));
vi.mock("@/components/dashboard/common/DetailMapAttribution", () => ({
  default: () => <div data-testid="attribution" />,
}));
vi.mock("@/hooks/catalog/useCatalogBasemapStyle", () => ({
  useCatalogBasemapStyle: () => undefined,
}));

const square = (x: number) => ({
  type: "Polygon",
  coordinates: [
    [
      [x, 48],
      [x + 1, 48],
      [x + 1, 49],
      [x, 48],
    ],
  ],
});
const SHAPES: Record<string, { geometry: unknown; name?: string }> = {
  DE1: { geometry: square(8), name: "Baden-Württemberg" },
  DE2: { geometry: square(11) },
};
vi.mock("@/hooks/catalog/useCatalogNutsGeometries", () => ({
  useCatalogNutsGeometries: (ids: string[]) => ({
    shapes: Object.fromEntries(ids.map((id) => [id, SHAPES[id] ?? {}])),
  }),
}));
vi.mock("@/lib/api/catalog", () => ({
  useCatalogNutsRegions: (query?: string) => ({
    regions: query && query.length >= 2 ? [{ nuts_id: "DE2", nuts_name: "Bayern", level: 1 }] : [],
    isLoading: false,
  }),
}));

/** The draw tool on the dialog's map: what was started, and the shape the test finishes. */
const draw = vi.hoisted(() => ({
  target: undefined as unknown,
  start: vi.fn(),
  done: undefined as ((drawn: unknown) => void) | undefined,
  edit: vi.fn(),
  /** Finishes the edit with these polygons. */
  edited: undefined as ((polygons: unknown) => void) | undefined,
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
        start: (shape: string, onDone: (drawn: unknown) => void) => {
          draw.start(shape);
          setDrawing(shape);
          draw.done = (drawn) => {
            setDrawing(null);
            onDone(drawn);
          };
        },
        edit: (polygons: unknown, onDone: (polygons: unknown) => void) => {
          draw.edit(polygons);
          setEditing(true);
          draw.edited = (next) => {
            setEditing(false);
            onDone(next);
          };
        },
        finish: vi.fn(),
        cancel: () => {
          setDrawing(null);
          setEditing(false);
        },
      };
    },
  };
});

const apply = () => screen.getByRole("button", { name: "apply" }) as HTMLButtonElement;
const addToArea = async (way: string) => {
  await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_add" }));
  await userEvent.click(screen.getByRole("menuitem", { name: new RegExp(`filter_panel.area_add_${way}`) }));
};

beforeEach(() => vi.clearAllMocks());

describe("CatalogSpatialDialog", () => {
  it("shows the title and keeps Apply disabled with no area and no existing filter", () => {
    render(<CatalogSpatialDialog open initial={null} onClose={vi.fn()} onApply={vi.fn()} />);

    expect(screen.getByText("catalog_set_spatial_filter")).toBeInTheDocument();
    expect(screen.getByText("fetch_features_area_none")).toBeInTheDocument();
    expect(apply().disabled).toBe(true);
  });

  it("picks the area with the area picker on its own map: a polygon, a point with a radius or regions", async () => {
    render(<CatalogSpatialDialog open initial={null} onClose={vi.fn()} onApply={vi.fn()} />);
    expect(draw.target).toEqual({ id: "catalog-spatial-dialog", main: false });
    await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_add" }));
    expect(screen.getAllByRole("menuitem").map((row) => row.textContent)).toEqual([
      "filter_panel.area_add_polygon",
      "filter_panel.area_add_point",
      "filter_panel.area_add_regions",
    ]);
    expect(screen.queryByText("filter_panel.area_inside")).toBeNull();
  });

  it("enables Apply once a region is in force, and applies null once it is removed", async () => {
    const onApply = vi.fn();
    render(
      <CatalogSpatialDialog
        open
        initial={{ kind: "region", nutsIds: ["DE1"], names: { DE1: "Baden-Württemberg" } }}
        onClose={vi.fn()}
        onApply={onApply}
      />
    );
    expect(apply().disabled).toBe(false);
    expect(screen.getByRole("button", { name: /Baden-Württemberg/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_remove_piece" }));
    await userEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith(null);
  });

  it("names a region read from the address by the name its outline brings", () => {
    render(
      <CatalogSpatialDialog
        open
        initial={{ kind: "region", nutsIds: ["DE1"] }}
        onClose={vi.fn()}
        onApply={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /Baden-Württemberg/ })).toBeInTheDocument();
  });

  it("applies a point placed on the map with the radius set beside it", async () => {
    const onApply = vi.fn();
    render(<CatalogSpatialDialog open initial={null} onClose={vi.fn()} onApply={onApply} />);
    await addToArea("point");
    expect(draw.start).toHaveBeenCalledWith("point");
    act(() => draw.done?.({ shape: "point", at: [11.5, 48.1] }));
    fireEvent.change(screen.getByRole("slider"), { target: { value: 5 } });
    await userEvent.click(apply());

    expect(onApply).toHaveBeenCalledWith({ kind: "point", lng: 11.5, lat: 48.1, km: 5 });
  });

  it("shows a point filter as its circle with its radius", () => {
    render(
      <CatalogSpatialDialog
        open
        initial={{ kind: "point", lng: 11.5, lat: 48.1, km: 3 }}
        onClose={vi.fn()}
        onApply={vi.fn()}
      />
    );
    expect(screen.getByText("filter_panel.area_shape_circle")).toBeInTheDocument();
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("3");
  });

  it("applies a drawn polygon as its corners", async () => {
    const onApply = vi.fn();
    render(<CatalogSpatialDialog open initial={null} onClose={vi.fn()} onApply={onApply} />);
    await addToArea("polygon");
    act(() =>
      draw.done?.({
        shape: "polygon",
        polygons: [
          [
            [
              [1, 1],
              [2, 1],
              [2, 2],
              [1, 1],
            ],
          ],
        ],
      })
    );
    await userEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith({
      kind: "polygon",
      ring: [
        [1, 1],
        [2, 1],
        [2, 2],
      ],
    });
  });

  it("applies a saved polygon with the corners it was edited to", async () => {
    const onApply = vi.fn();
    render(
      <CatalogSpatialDialog
        open
        initial={{
          kind: "polygon",
          ring: [
            [1, 1],
            [2, 1],
            [2, 2],
          ],
        }}
        onClose={vi.fn()}
        onApply={onApply}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "filter_panel.area_edit_piece" }));
    expect(draw.edit).toHaveBeenCalledExactlyOnceWith([
      [
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 1],
        ],
      ],
    ]);
    act(() =>
      draw.edited?.([
        [
          [
            [1, 1],
            [3, 1],
            [2, 2],
            [1, 2],
            [1, 1],
          ],
        ],
      ])
    );
    await userEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith({
      kind: "polygon",
      ring: [
        [1, 1],
        [3, 1],
        [2, 2],
        [1, 2],
      ],
    });
  });

  it("filters by one kind of area: a point placed replaces the regions", async () => {
    const onApply = vi.fn();
    render(
      <CatalogSpatialDialog
        open
        initial={{ kind: "region", nutsIds: ["DE1"], names: { DE1: "Baden-Württemberg" } }}
        onClose={vi.fn()}
        onApply={onApply}
      />
    );
    await addToArea("point");
    act(() => draw.done?.({ shape: "point", at: [11.5, 48.1] }));
    expect(screen.queryByRole("button", { name: /Baden-Württemberg/ })).toBeNull();
    await userEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith({ kind: "point", lng: 11.5, lat: 48.1, km: 3 });
  });

  it("applies a region picked from the list, and Cancel applies nothing", async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<CatalogSpatialDialog open initial={null} onClose={onClose} onApply={onApply} />);

    await addToArea("regions");
    await userEvent.type(screen.getByRole("textbox", { name: "filter_panel.area_search_regions" }), "Bay");
    await userEvent.click(await screen.findByRole("option", { name: /Bayern/ }));
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();

    await userEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith({ kind: "region", nutsIds: ["DE2"], names: { DE2: "Bayern" } });
  });
});
