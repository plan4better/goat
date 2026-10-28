import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/components/map/panels/styleEditor/__tests__/renderPanel";
import { EMPTY_DATA } from "@/components/map/panels/styleEditor/context";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("react-map-gl/maplibre", () => ({
  Map: ({ children }: { children?: React.ReactNode }) => <div data-testid="map">{children}</div>,
}));
const DATASETS: Record<string, object> = {
  l1: {
    id: "l1",
    name: "Districts",
    type: "feature",
    feature_layer_geometry_type: "polygon",
    extent: "POLYGON((7 50, 8 50, 8 51, 7 51, 7 50))",
  },
  r1: { id: "r1", name: "Elevation", type: "raster", data_type: "cog", url: "https://x/dem.tif" },
  w1: {
    id: "w1",
    name: "Aerial",
    type: "raster",
    data_type: "wms",
    url: "https://wms.example/?bbox={bbox-epsg-3857}",
    other_properties: { layers: ["a"], legend_urls: ["https://wms.example/legend.png"] },
  },
};
vi.mock("@/lib/api/layers", async (original) => ({
  ...(await original<typeof import("@/lib/api/layers")>()),
  useDataset: (id: string) => ({ dataset: DATASETS[id], isLoading: false }),
}));
vi.mock("@/hooks/style/useStyleData", () => ({
  useStyleData: (layer: { id: string; name?: string; geometry?: string }) => ({
    ...EMPTY_DATA,
    layerId: layer.id,
    layerName: layer.name,
    geometry: layer.geometry,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("development route", () => {
  it("the route is not found in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: Page } = await import("@/app/dev/style-editor/page");
    await expect(Page({ searchParams: Promise.resolve({ layer: "l1" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("it renders the editor for a layer with the default document", async () => {
    const { DevStyleEditor } = await import("@/app/dev/style-editor/DevStyleEditor");
    renderWithProviders(<DevStyleEditor layerId="l1" />);
    expect(screen.getByRole("heading", { name: "Districts" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "style_editor.geometry_polygon" })).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Document" }));
    expect(screen.getByTestId("style-document").textContent).toContain('"version": 1');
  });

  it("a raster file gets the raster sections and an image document", async () => {
    const { DevStyleEditor } = await import("@/app/dev/style-editor/DevStyleEditor");
    renderWithProviders(<DevStyleEditor layerId="r1" />);
    expect(screen.getByRole("heading", { name: "Elevation" })).toBeDefined();
    expect(screen.getByText("style_editor.draw_as")).toBeDefined();
    expect(screen.getByText("style_editor.no_data")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Document" }));
    expect(screen.getByTestId("style-document").textContent).toContain('"kind": "raster"');
  });

  it("a map service gets the layer section without no data", async () => {
    const { DevStyleEditor } = await import("@/app/dev/style-editor/DevStyleEditor");
    renderWithProviders(<DevStyleEditor layerId="w1" />);
    expect(screen.getByRole("heading", { name: "Aerial" })).toBeDefined();
    expect(screen.getByText("style_editor.resampling")).toBeDefined();
    expect(screen.queryByText("style_editor.no_data")).toBeNull();
  });

  it("a map service address opens without a dataset; a raster file opens as its layer", async () => {
    const { DevStyleEditor } = await import("@/app/dev/style-editor/DevStyleEditor");
    renderWithProviders(
      <DevStyleEditor layerId="" service="https://tiles.example/{z}/{x}/{y}.png" kind="xyz" />
    );
    expect(screen.getByText("style_editor.resampling")).toBeDefined();
    expect(screen.queryByText("style_editor.no_data")).toBeNull();
    // A raster file is drawn by the raster service from its layer, never from an address.
    // @ts-expect-error no cog address any more
    const props: Parameters<typeof DevStyleEditor>[0] = { layerId: "", cog: "https://x/canopy.tif" };
    expect(props.layerId).toBe("");
  });
});
