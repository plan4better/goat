// The style compiler's sources read a layer's stored extent without the app's API clients: compiling a style loads no
// data fetching, no SWR and no capability parsers.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/rasters", () => {
  throw new Error("the style compiler imported lib/api/rasters");
});
vi.mock("@/lib/api/processes", () => {
  throw new Error("the style compiler imported lib/api/processes");
});
vi.mock("@/lib/utils/externalService", () => {
  throw new Error("the style compiler imported lib/utils/externalService");
});

describe("layerSource", () => {
  it("imports none of the app's API clients or capability parsers", async () => {
    const { compileSourceFor } = await import("@/lib/style/layerSource");
    const extent = "POLYGON((13 52,14 52,14 53,13 53,13 52))";
    const cog = {
      id: 3,
      layer_id: "r1",
      type: "raster",
      data_type: "cog",
      url: "https://files/a.tif",
      extent,
    };
    expect(compileSourceFor(cog, { kind: "raster", geoapiUrl: "https://geo" })).toMatchObject({
      bounds: [13, 52, 14, 53],
    });
  });
});
