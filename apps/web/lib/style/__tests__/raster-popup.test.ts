import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchRasterPoint } from "@/lib/api/rasters";
import type { LayerStyle } from "@/lib/style/generated/types";
import { rasterPopupLayer, rasterValuesAt } from "@/lib/style/raster/popup";

import { layerPopup } from "@/components/map/popover/normalizePopup";

vi.mock("@/lib/api/rasters", () => ({
  fetchRasterPoint: vi.fn(async () => ({ values: [10, 250.5, 30], styled: null })),
}));

const cog = (id: number, document: object, visible = true) => ({
  id,
  layer_id: `d${id}`,
  name: `Raster ${id}`,
  type: "raster",
  data_type: "cog",
  url: `https://files.example/${id}.tif`,
  visible,
  style: { id: `s${id}`, document: document as LayerStyle },
});

const ELEVATION = {
  version: 1,
  kind: "raster",
  render: { type: "continuous", band: 2, palette: "goat:elevation", domain: [181, 440] },
  legend: { unit: "m" },
};

describe("raster popups", () => {
  beforeEach(() => vi.mocked(fetchRasterPoint).mockClear());

  it("a click on a COG layer shows the band values the style's popup names", async () => {
    const elevation = cog(1, ELEVATION);
    const hidden = cog(2, ELEVATION, false);
    // The topmost drawn file whose popup opens on click.
    expect(rasterPopupLayer([hidden, elevation], "click")).toBe(elevation);
    expect(rasterPopupLayer([elevation], "hover")).toBeUndefined();

    const values = await rasterValuesAt(elevation, { lng: 7.1, lat: 50.7 });
    // The raster service's point route of the layer's dataset.
    expect(fetchRasterPoint).toHaveBeenCalledWith("d1", { lng: 7.1, lat: 50.7 }, undefined);
    expect(values).toEqual({ band_2: 250.5 });
    const popup = layerPopup(elevation, values ?? undefined);
    expect(popup?.trigger).toBe("click");
    expect(popup?.blocks).toEqual([
      expect.objectContaining({
        type: "fieldList",
        attributes: [{ name: "band_2", label: "Band 2", type: "number", suffix: " m" }],
      }),
    ]);

    // Every band, while hovering; an image's styled bands are its three.
    const satellite = cog(3, {
      version: 1,
      kind: "raster",
      render: { type: "image" },
      popup: { trigger: "hover", bands: "all" },
    });
    expect(rasterPopupLayer([satellite], "hover")).toBe(satellite);
    expect(await rasterValuesAt(satellite, { lng: 7.1, lat: 50.7 })).toEqual({
      band_1: 10,
      band_2: 250.5,
      band_3: 30,
    });
    const image = cog(4, { version: 1, kind: "raster", render: { type: "image", bands: [3, 1, 2] } });
    expect(await rasterValuesAt(image, { lng: 7.1, lat: 50.7 })).toEqual({
      band_3: 30,
      band_1: 10,
      band_2: 250.5,
    });

    // Outside the file: no popup.
    vi.mocked(fetchRasterPoint).mockResolvedValueOnce({ values: [null, null, null], styled: null });
    expect(await rasterValuesAt(elevation, { lng: 0, lat: 0 })).toBeNull();
    vi.mocked(fetchRasterPoint).mockResolvedValueOnce(null);
    expect(await rasterValuesAt(elevation, { lng: 0, lat: 0 })).toBeNull();
  });

  it("the raster popup reads the point route and shows a formula's value under its name", async () => {
    vi.mocked(fetchRasterPoint).mockResolvedValueOnce({ values: [100, 200, 300, 500], styled: 0.666 });
    const ndvi = cog(8, {
      version: 1,
      kind: "raster",
      render: {
        type: "continuous",
        band: { name: "NDVI", expression: "(b4 - b1) / (b4 + b1)" },
        palette: "goat:green",
        domain: [-1, 1],
      },
    });
    const values = await rasterValuesAt(ndvi, { lng: 7.1, lat: 50.7 });
    const [, , token] = vi.mocked(fetchRasterPoint).mock.calls[0];
    expect(typeof token).toBe("string");
    expect(values).toEqual({ formula: 0.666 });
    expect(layerPopup(ndvi, values ?? undefined)?.blocks).toEqual([
      expect.objectContaining({ attributes: [{ name: "formula", label: "NDVI", type: "number" }] }),
    ]);
  });

  it("services show no popup", () => {
    const wms = {
      ...cog(5, { version: 1, kind: "raster", render: { type: "image" }, popup: { trigger: "click" } }),
      data_type: "wms",
    };
    expect(rasterPopupLayer([wms], "click")).toBeUndefined();
    expect(layerPopup(wms, { band_1: 1 })).toBeUndefined();
    const off = cog(6, { ...ELEVATION, popup: false });
    const disabled = cog(7, { ...ELEVATION, popup: { enabled: false } });
    expect(rasterPopupLayer([off, disabled], "click")).toBeUndefined();
    expect(layerPopup(off, { band_2: 1 })).toBeUndefined();
  });
});
