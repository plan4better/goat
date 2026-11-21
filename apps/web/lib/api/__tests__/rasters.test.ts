import { describe, expect, it } from "vitest";

import { rasterErrorOf } from "@/lib/api/rasters";

describe("raster service errors", () => {
  it("a refused address and a file that cannot be read are told apart", () => {
    expect(rasterErrorOf(undefined)).toBeUndefined();
    expect(rasterErrorOf({ status: 422 })).toBe("refused");
    expect(rasterErrorOf({ status: 504 })).toBe("unavailable");
    expect(rasterErrorOf(new Error("network"))).toBe("unavailable");
  });
});
