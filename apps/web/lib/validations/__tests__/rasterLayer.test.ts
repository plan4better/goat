import { describe, expect, it } from "vitest";

import { createRasterLayerSchema } from "@/lib/validations/layer";

const layer = (data_type: string, url: string) => ({
  name: "Tiles",
  folder_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  type: "raster",
  data_type,
  url,
  other_properties: {},
});

describe("createRasterLayerSchema", () => {
  it.each([
    "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
    "https://tiles.example.org/{z}/{x}/{-y}.png",
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    "https://{switch:a,b,c}.tile.example.org/{z}/{x}/{-y}.png",
  ])("takes an XYZ template: %s", (url) => {
    expect(createRasterLayerSchema.safeParse(layer("xyz", url)).success).toBe(true);
  });

  it.each([
    "https://{switch:a,evil.example/x?}.tile.example.org/{z}/{x}/{y}.png",
    "https://{switch:a,b#c}.tile.example.org/{z}/{x}/{y}.png",
    "https://{switch:}.tile.example.org/{z}/{x}/{y}.png",
    "{switch:https,ftp}://tiles.example.org/{z}/{x}/{y}.png",
  ])("checks every address of an XYZ template: %s", (url) => {
    expect(createRasterLayerSchema.safeParse(layer("xyz", url)).success).toBe(false);
  });

  it("reads subdomain placeholders in XYZ templates only", () => {
    expect(
      createRasterLayerSchema.safeParse(layer("cog", "https://{switch:a,b}.example.org/x.tif")).success
    ).toBe(false);
    expect(createRasterLayerSchema.safeParse(layer("cog", "https://example.org/x.tif")).success).toBe(true);
  });
});
