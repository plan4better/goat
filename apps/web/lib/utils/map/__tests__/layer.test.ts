import { describe, expect, it } from "vitest";

import { filterSelectableProjectLayers, resolveProjectLayer } from "../layer";
import type { ProjectLayer } from "@/lib/validations/project";

const SYSTEM_ID = "903ecdca-b717-48db-bbce-0219e41439cf";

const layer = (overrides: {
  id: number;
  layer_id: string;
  type?: string;
  locked?: boolean;
}): ProjectLayer =>
  ({
    type: "feature",
    name: "layer",
    ...overrides,
  }) as unknown as ProjectLayer;

describe("filterSelectableProjectLayers", () => {
  it("keeps an ordinary layer", () => {
    const layers = [layer({ id: 1, layer_id: "a" })];
    expect(filterSelectableProjectLayers(layers, [], [])).toEqual(layers);
  });

  it("drops a locked layer — a picker must never offer one", () => {
    const visible = layer({ id: 1, layer_id: "a" });
    const locked = layer({ id: 2, layer_id: "b", locked: true });
    expect(filterSelectableProjectLayers([visible, locked], [], [])).toEqual([visible]);
  });

  it("drops an excluded type", () => {
    const feature = layer({ id: 1, layer_id: "a", type: "feature" });
    const table = layer({ id: 2, layer_id: "b", type: "table" });
    expect(filterSelectableProjectLayers([feature, table], ["table"], [])).toEqual([feature]);
  });

  it("drops an excluded dataset id", () => {
    const visible = layer({ id: 1, layer_id: "a" });
    const system = layer({ id: 2, layer_id: SYSTEM_ID });
    expect(filterSelectableProjectLayers([visible, system], [], [SYSTEM_ID])).toEqual([visible]);
  });

  it("returns an empty array for undefined input", () => {
    expect(filterSelectableProjectLayers(undefined, [], [])).toEqual([]);
  });
});

describe("resolveProjectLayer", () => {
  const unlocked = layer({ id: 1, layer_id: "dataset-a" });
  const locked = layer({ id: 2, layer_id: "dataset-b", locked: true });
  const layers = [unlocked, locked];

  it("resolves an unlocked layer's dataset id", () => {
    expect(resolveProjectLayer(layers, 1)).toEqual({
      layer: unlocked,
      layerId: "dataset-a",
      isLayerLocked: false,
    });
  });

  it("withholds layerId for a locked layer, but still reports the layer and the flag", () => {
    const result = resolveProjectLayer(layers, 2);
    expect(result.layer).toBe(locked);
    expect(result.layerId).toBeUndefined();
    expect(result.isLayerLocked).toBe(true);
  });

  it("resolves nothing for an unset layerProjectId", () => {
    expect(resolveProjectLayer(layers, undefined)).toEqual({
      layer: undefined,
      layerId: undefined,
      isLayerLocked: false,
    });
  });

  it("resolves nothing for a layerProjectId not present in the list", () => {
    expect(resolveProjectLayer(layers, 999)).toEqual({
      layer: undefined,
      layerId: undefined,
      isLayerLocked: false,
    });
  });

  it("resolves nothing for undefined layers", () => {
    expect(resolveProjectLayer(undefined, 1)).toEqual({
      layer: undefined,
      layerId: undefined,
      isLayerLocked: false,
    });
  });
});
