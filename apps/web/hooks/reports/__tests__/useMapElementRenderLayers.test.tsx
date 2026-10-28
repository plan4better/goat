import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useMapElementRenderLayers } from "@/hooks/reports/useMapElementRenderLayers";

vi.mock("@/lib/api/layers", () => ({
  getLayerUniqueValues: vi.fn(async () => ({
    items: ["2010", "2024", "2016"].map((value) => ({ value, count: 1 })),
    total: 3,
  })),
}));

const TIMED = {
  version: 1,
  kind: "vector",
  symbol: { fill: { color: "#cccccc" } },
  time: { field: "year", step: 1 },
};
const layer = {
  id: 4,
  layer_id: "d4",
  type: "feature",
  feature_layer_geometry_type: "polygon",
  visible: true,
  entry: { type: "layer", id: 4 },
  style: {
    id: "s4",
    name: "Default",
    position: 0,
    revision: 1,
    document: TIMED as LayerStyle,
    issues: [],
    stale: false,
  },
  otherStyles: [],
} as unknown as MapLayer;

describe("the print map element's layers", () => {
  it("a time-enabled layer without a stored slider value prints at its latest step, like the map", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    );
    const { result } = renderHook(() => useMapElementRenderLayers([layer], {}), { wrapper });
    await waitFor(() => expect(result.current[0]?.entry.time).toEqual({ value: 2024 }));
  });
});
