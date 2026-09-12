import { beforeEach, describe, expect, it, vi } from "vitest";

import { getExtent } from "@/lib/api/processes";
import type { ProjectLayer } from "@/lib/validations/project";

import { zoomToProjectLayer } from "@/lib/utils/map/navigate";

vi.mock("@/lib/api/processes", () => ({ getExtent: vi.fn() }));

/** A layer whose published bbox is the provider's whole territory. */
const layer = (overrides: Partial<ProjectLayer>): ProjectLayer =>
  ({
    id: 1,
    layer_id: "layer-1",
    extent: "MULTIPOLYGON (((-61.8 -21.4, -61.8 78.9, 55.8 78.9, 55.8 -21.4, -61.8 -21.4)))",
    ...overrides,
  }) as ProjectLayer;

const map = () => ({ fitBounds: vi.fn() });

describe("zoomToProjectLayer", () => {
  beforeEach(() => {
    vi.mocked(getExtent).mockReset();
  });

  it("asks the data for a catalog layer's extent instead of trusting the published bbox", async () => {
    vi.mocked(getExtent).mockResolvedValue({ bbox: [10.9, 49.3, 11.2, 49.6] } as never);
    const m = map();

    await zoomToProjectLayer(m as never, layer({ in_catalog: true }));

    expect(getExtent).toHaveBeenCalledWith("layer-1", undefined);
    expect(m.fitBounds).toHaveBeenCalledWith([10.9, 49.3, 11.2, 49.6], expect.anything());
  });

  it("falls back to the stored extent when the data has no rows to measure", async () => {
    vi.mocked(getExtent).mockResolvedValue({ bbox: null } as never);
    const m = map();

    await zoomToProjectLayer(m as never, layer({ in_catalog: true }));

    expect(m.fitBounds).toHaveBeenCalledWith([-61.8, -21.4, 55.8, 78.9], expect.anything());
  });

  it("uses the stored extent for an unfiltered layer of the user's own", async () => {
    const m = map();

    await zoomToProjectLayer(m as never, layer({ in_catalog: false }));

    expect(getExtent).not.toHaveBeenCalled();
    expect(m.fitBounds).toHaveBeenCalledTimes(1);
  });
});
