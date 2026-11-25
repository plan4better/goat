// The data panel shows a step's rows and map from geoapi. Workflows take no raster layers: a dataset step that holds
// one has nothing to show, so the panel asks for no fields, rows, extent or tiles of it.
import { describe, expect, it } from "vitest";

import type { ProjectLayer } from "@/lib/validations/project";
import type { WorkflowNode } from "@/lib/validations/workflow";

import { getNodeDataInfo } from "@/components/workflows/panels/WorkflowDataPanel";

const RASTER_ID = "22222222-2222-4222-8222-222222222222";
const STOPS_ID = "11111111-1111-4111-8111-111111111111";

const step = (data: Record<string, unknown>) =>
  ({
    id: "dataset-1",
    type: "dataset",
    position: { x: 0, y: 0 },
    data: { type: "dataset", label: "Dataset", ...data },
  }) as unknown as WorkflowNode;

const NO_DATA = { hasData: false, layerId: null, tempLayerId: null, nodeFilter: null };

describe("getNodeDataInfo", () => {
  it("a feature layer's step shows its layer", () => {
    expect(getNodeDataInfo(step({ layerId: STOPS_ID, layerType: "feature" }))).toMatchObject({
      hasData: true,
      layerId: STOPS_ID,
    });
  });

  it("a raster layer's step has no data to show", () => {
    expect(getNodeDataInfo(step({ layerId: RASTER_ID, layerType: "raster" }))).toEqual(NO_DATA);
  });

  it("a step stored without a type is known as raster by its layer in the project", () => {
    const layers = [{ id: 6, layer_id: RASTER_ID, name: "DEM", type: "raster" }] as unknown as ProjectLayer[];
    expect(getNodeDataInfo(step({ layerId: RASTER_ID }), {}, layers)).toEqual(NO_DATA);
  });
});
