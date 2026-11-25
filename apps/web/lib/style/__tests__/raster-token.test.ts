import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { RasterColorSpec } from "@/lib/style/raster/color";
import { rasterToken } from "@/lib/style/raster/token";

// Shared with goatlib's tests (tests/unit/raster/test_token.py decodes every token): the browser encodes, the
// raster service decodes.
const CASES = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../../packages/python/goatlib/tests/unit/raster/fixtures/web_tokens.json"),
    "utf8"
  )
) as Array<{ spec: RasterColorSpec; token: string }>;

describe("raster tokens", () => {
  it("are base64url of the coloring's canonical JSON, the same for the same coloring", () => {
    const a = rasterToken({ kind: "rgb", bands: null, noData: [] });
    const b = rasterToken({ noData: [], bands: null, kind: "rgb" } as RasterColorSpec);
    expect(a).toBe(b);
    expect(a).toMatch(/^[\w-]+$/);
    expect(JSON.parse(atob(a.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
      bands: null,
      kind: "rgb",
      noData: [],
      v: 1,
    });
  });

  it("match the cases the raster service decodes", () => {
    expect(CASES.length).toBeGreaterThan(4);
    for (const { spec, token } of CASES) expect(rasterToken(spec)).toBe(token);
  });
});
