import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getExtent } from "@/lib/api/processes";
import { fetchRasterBounds } from "@/lib/api/rasters";
import { MAP_PANEL_ATTR } from "@/lib/constants";
import { clearLayerBoundsCache } from "@/lib/utils/map/layerExtent";
import { cameraForBounds, panelInsets, zoomPadding, zoomToProjectLayer } from "@/lib/utils/map/navigate";
import type { ProjectLayer } from "@/lib/validations/project";

vi.mock("@/lib/api/processes", () => ({ getExtent: vi.fn() }));
vi.mock("@/lib/api/rasters", () => ({ fetchRasterBounds: vi.fn() }));

const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
const VIEW = { width: 1000, height: 800 };
const BERLIN: [number, number, number, number] = [13.088345, 52.3382448, 13.7611609, 52.6755087];

/** Web Mercator pixels of a point at `zoom`, as MapLibre lays out its 512 px world. */
const px = ([lng, lat]: [number, number], zoom: number) => {
  const size = 512 * 2 ** zoom;
  const phi = (lat * Math.PI) / 180;
  return [
    ((lng + 180) / 360) * size,
    ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * size,
  ];
};

/** Where the bounds land on a viewport looking at `camera`: left, top, right, bottom in screen pixels. */
const onScreen = (
  bounds: [number, number, number, number],
  camera: { center: [number, number]; zoom: number },
  view = VIEW
) => {
  const [cx, cy] = px(camera.center, camera.zoom);
  const [x0, y1] = px([bounds[0], bounds[1]], camera.zoom);
  const [x1, y0] = px([bounds[2], bounds[3]], camera.zoom);
  return {
    left: x0 - cx + view.width / 2,
    right: x1 - cx + view.width / 2,
    top: y0 - cy + view.height / 2,
    bottom: y1 - cy + view.height / 2,
  };
};

describe("cameraForBounds", () => {
  it("fits the bounds into the viewport, touching it on one axis", () => {
    const camera = cameraForBounds(BERLIN, VIEW, NONE);
    const box = onScreen(BERLIN, camera);
    expect(box.left).toBeGreaterThanOrEqual(-0.5);
    expect(box.top).toBeGreaterThanOrEqual(-0.5);
    expect(box.right).toBeLessThanOrEqual(VIEW.width + 0.5);
    expect(box.bottom).toBeLessThanOrEqual(VIEW.height + 0.5);
    const touches =
      Math.abs(box.left) < 0.5 || Math.abs(box.top) < 0.5 || Math.abs(box.right - VIEW.width) < 0.5;
    expect(touches).toBe(true);
  });

  it("keeps the bounds clear of a panel: centred in what the padding leaves", () => {
    const padding = { top: 40, right: 40, bottom: 40, left: 400 };
    const camera = cameraForBounds(BERLIN, VIEW, padding);
    const box = onScreen(BERLIN, camera);
    expect(box.left).toBeGreaterThanOrEqual(400 - 0.5);
    expect(box.right).toBeLessThanOrEqual(VIEW.width - 40 + 0.5);
    // The bounds' centre sits in the middle of the free area.
    expect((box.left + box.right) / 2).toBeCloseTo((400 + VIEW.width - 40) / 2, 0);
  });

  it("zooms to a single point at street level, not into the ground", () => {
    const camera = cameraForBounds([13.4, 52.5, 13.4, 52.5], VIEW, NONE);
    expect(camera.zoom).toBe(16);
    expect(camera.center[0]).toBeCloseTo(13.4, 6);
    expect(camera.center[1]).toBeCloseTo(52.5, 6);
  });

  it("caps a tiny box at the maximum zoom", () => {
    const camera = cameraForBounds([13.4, 52.5, 13.40001, 52.50001], VIEW, NONE);
    expect(camera.zoom).toBe(18);
  });

  it("zooms in to where the layer starts to show", () => {
    const camera = cameraForBounds(BERLIN, VIEW, NONE, { minZoom: 14 });
    expect(camera.zoom).toBe(14);
    // Still centred on the bounds.
    expect(camera.center[0]).toBeCloseTo((BERLIN[0] + BERLIN[2]) / 2, 6);
  });

  it("stays below the zoom where the layer stops showing", () => {
    const camera = cameraForBounds([13.4, 52.5, 13.401, 52.501], VIEW, NONE, { maxZoom: 9 });
    expect(camera.zoom).toBeLessThan(9);
    expect(camera.zoom).toBeGreaterThan(8.9);
  });

  it("goes the short way across the antimeridian", () => {
    const camera = cameraForBounds([170, -20, -170, -10], VIEW, NONE);
    expect(Math.abs(camera.center[0])).toBeCloseTo(180, 6);
    expect(camera.zoom).toBeGreaterThan(3);
  });

  it("fits the whole world without leaving Web Mercator", () => {
    const camera = cameraForBounds([-180, -90, 180, 90], VIEW, NONE);
    expect(Number.isFinite(camera.zoom)).toBe(true);
    expect(Number.isFinite(camera.center[1])).toBe(true);
  });
});

describe("panel insets and padding", () => {
  const rect = (left: number, top: number, right: number, bottom: number) =>
    ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top }) as DOMRect;

  let container: HTMLDivElement;
  const panel = (r: DOMRect) => {
    const el = document.createElement("div");
    el.setAttribute(MAP_PANEL_ATTR, "");
    el.getBoundingClientRect = () => r;
    document.body.appendChild(el);
    return el;
  };

  beforeEach(() => {
    container = document.createElement("div");
    container.getBoundingClientRect = () => rect(0, 50, 1440, 900);
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("measures the side each floating panel covers", () => {
    panel(rect(10, 60, 320, 600)); // the layer tree, top left
    panel(rect(1100, 60, 1430, 890)); // the style panel, right
    panel(rect(0, 700, 1440, 900)); // a data table along the bottom
    expect(panelInsets(container)).toEqual({ top: 0, right: 340, bottom: 200, left: 320 });
  });

  it("ignores a panel off the map or not shown", () => {
    panel(rect(0, 0, 0, 0));
    panel(rect(2000, 60, 2300, 600));
    expect(panelInsets(container)).toEqual(NONE);
  });

  it("pads each side by a margin past the panel, and never by more than 40 percent", () => {
    expect(zoomPadding({ width: 1440, height: 850 }, { top: 0, right: 340, bottom: 0, left: 320 })).toEqual({
      top: 40,
      right: 380,
      bottom: 40,
      left: 360,
    });
    expect(zoomPadding({ width: 500, height: 400 }, { top: 0, right: 0, bottom: 0, left: 320 }).left).toBe(
      200
    );
  });
});

describe("zoomToProjectLayer", () => {
  const layer = (overrides: Partial<ProjectLayer>): ProjectLayer =>
    ({
      id: 1,
      layer_id: "layer-1",
      type: "feature",
      extent: "MULTIPOLYGON (((-61.8 -21.4, -61.8 78.9, 55.8 78.9, 55.8 -21.4, -61.8 -21.4)))",
      ...overrides,
    }) as ProjectLayer;

  const map = () => {
    const container = document.createElement("div");
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }) as DOMRect;
    return { getContainer: () => container, flyTo: vi.fn() };
  };

  beforeEach(() => {
    clearLayerBoundsCache();
    vi.mocked(getExtent).mockReset();
    vi.mocked(fetchRasterBounds).mockReset();
  });

  it("asks the data for a catalog layer's extent instead of trusting the published bbox", async () => {
    vi.mocked(getExtent).mockResolvedValue({ bbox: [10.9, 49.3, 11.2, 49.6] } as never);
    const m = map();

    expect(await zoomToProjectLayer(m as never, layer({ other_properties: { catalog_item: {} } }))).toBe(
      true
    );

    expect(getExtent).toHaveBeenCalledWith("layer-1", undefined);
    const [{ center }] = m.flyTo.mock.calls[0];
    expect(center[0]).toBeCloseTo(11.05, 5);
  });

  it("uses the stored extent for an unfiltered layer of the user's own", async () => {
    const m = map();
    await zoomToProjectLayer(m as never, layer({ other_properties: {} }));
    expect(getExtent).not.toHaveBeenCalled();
    expect(m.flyTo).toHaveBeenCalledTimes(1);
  });

  it("zooms to a COG stored without an extent by the file's bounds", async () => {
    vi.mocked(fetchRasterBounds).mockResolvedValue([13.53, 51.36, 15.17, 52.37]);
    const m = map();
    const ok = await zoomToProjectLayer(
      m as never,
      layer({ type: "raster", data_type: "cog", extent: undefined, url: "https://x/tci.tif" } as never)
    );
    expect(ok).toBe(true);
    const [{ center, zoom }] = m.flyTo.mock.calls[0];
    expect(center[0]).toBeCloseTo(14.35, 5);
    expect(zoom).toBeGreaterThan(6);
  });

  it("clamps into the style's visible zooms", async () => {
    const m = map();
    await zoomToProjectLayer(
      m as never,
      layer({ other_properties: {}, style: { document: { min_zoom: 12 } } } as never)
    );
    expect(m.flyTo.mock.calls[0][0].zoom).toBe(12);
  });

  it("does not move the map, and says so, when the layer's area is unknown", async () => {
    const m = map();
    const ok = await zoomToProjectLayer(
      m as never,
      layer({
        type: "raster",
        data_type: "xyz",
        extent: undefined,
        url: "https://t/{z}/{x}/{y}.png",
      } as never)
    );
    expect(ok).toBe(false);
    expect(m.flyTo).not.toHaveBeenCalled();
  });
});
