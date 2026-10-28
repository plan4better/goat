import { describe, expect, it } from "vitest";

import { compileLayer, sourceKind } from "@/lib/style/compile";
import type { LayerStyle } from "@/lib/style/generated/types";

const TILES = { type: "tiles" as const, id: "s7", tiles: ["https://t/{z}/{x}/{y}"] };

describe("compileLayer", () => {
  it("names the source and defaults the position", () => {
    const out = compileLayer({
      id: "7",
      style: { version: 1, kind: "vector" } as LayerStyle,
      geometry: "point",
      source: TILES,
    });
    expect(out.sources).toEqual({ s7: { type: "vector", tiles: ["https://t/{z}/{x}/{y}"], maxzoom: 14 } });
    expect(out.position).toBe("top");
    expect(out.unsupported).toEqual([]);
  });

  it("passes the position through and says which source a style needs", () => {
    const out = compileLayer({
      id: "7",
      style: { version: 1, kind: "vector" } as LayerStyle,
      source: TILES,
      entry: { position: "below_labels" },
    });
    expect(out.position).toBe("below_labels");
    expect(sourceKind({ version: 1, kind: "vector", render: { type: "cluster" } } as LayerStyle)).toBe(
      "points"
    );
    expect(sourceKind({ version: 1, kind: "vector" } as LayerStyle)).toBe("tiles");
    expect(sourceKind({ version: 1, kind: "raster", render: { type: "image" } } as LayerStyle)).toBe(
      "raster"
    );
  });
});
