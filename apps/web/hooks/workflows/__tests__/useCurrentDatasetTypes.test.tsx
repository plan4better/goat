/**
 * A layer's type can change after a workflow picked it: a workflow export
 * that overwrites a table with geometries, or an update from a file, turns
 * it into a feature layer (and back). The canvas validates connections with
 * the nodes `useCurrentDatasetTypes` gives it, so a dataset step offers the
 * layer as it is now, and keeps the stored type only for a layer the
 * project's list does not carry.
 */
import { renderHook } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectLayer } from "@/lib/validations/project";
import type { WorkflowNode } from "@/lib/validations/workflow";

import type { OGCProcessDescription } from "@/types/map/ogc-processes";

import { useConnectionValidator } from "@/hooks/map/useConnectionValidation";
import { useCurrentDatasetTypes } from "@/hooks/workflows/useCurrentDatasetTypes";

const { projectLayers } = vi.hoisted(() => ({ projectLayers: { current: undefined as unknown } }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
}));

vi.mock("@/lib/api/projects", () => ({
  useProjectLayers: (projectId?: string) => ({
    layers: projectId === "p1" ? projectLayers.current : undefined,
  }),
}));

const LAYER_ID = "11111111-1111-4111-8111-111111111111";

const datasetNode = (data: Record<string, unknown>): Node => ({
  id: "dataset-1",
  type: "dataset",
  position: { x: 0, y: 0 },
  data: {
    type: "dataset",
    label: "Stops",
    projectLayerId: 5,
    layerId: LAYER_ID,
    layerName: "Stops",
    ...data,
  },
});

const bufferNode: Node = {
  id: "tool-1",
  type: "tool",
  position: { x: 300, y: 0 },
  data: { type: "tool", processId: "buffer", label: "Buffer", config: {}, status: "idle" },
};

const projectLayer = (type: string, geometry: string | null) =>
  ({ id: 5, layer_id: LAYER_ID, name: "Stops", type, feature_layer_geometry_type: geometry }) as ProjectLayer;

// A geometry tool: its layer input takes vector data only
const buffer = {
  id: "buffer",
  version: "1",
  title: "Buffer",
  inputs: {
    input_layer_id: {
      title: "Input layer",
      schema: { type: "string" },
      minOccurs: 1,
      maxOccurs: 1,
      keywords: [],
      metadata: [
        { role: "constraint", title: "data_type", value: "vector" },
        { role: "constraint", title: "geometry_types", value: "point,line,polygon" },
      ],
    },
  },
  outputs: {},
} as unknown as OGCProcessDescription;

const processMap = new Map([["buffer", buffer]]);

const connectsToBuffer = (stored: Node) => {
  const { result } = renderHook(() => {
    const nodes = useCurrentDatasetTypes([stored, bufferNode]) as WorkflowNode[];
    return useConnectionValidator(nodes, processMap);
  });
  return result.current({ source: "dataset-1", target: "tool-1", targetHandle: "input_layer_id" });
};

describe("connections of a dataset step whose layer changed type", () => {
  beforeEach(() => {
    projectLayers.current = undefined;
  });

  it("allows a geometry tool for a step stored as a table whose layer is now a point layer", () => {
    projectLayers.current = [projectLayer("feature", "point")];
    expect(connectsToBuffer(datasetNode({ layerType: "table" }))).toBe(true);
  });

  it("refuses a geometry tool for a step stored as a point layer whose layer is now a table", () => {
    projectLayers.current = [projectLayer("table", null)];
    expect(connectsToBuffer(datasetNode({ layerType: "feature", geometryType: "point" }))).toBe(false);
  });

  it("keeps the stored type for a layer the project's list does not carry", () => {
    projectLayers.current = [
      { ...projectLayer("feature", "point"), id: 6, layer_id: "22222222-2222-4222-8222-222222222222" },
    ];
    expect(connectsToBuffer(datasetNode({ layerType: "table" }))).toBe(false);
    expect(connectsToBuffer(datasetNode({ layerType: "feature", geometryType: "point" }))).toBe(true);
  });

  it("keeps the stored type while the project's layers load", () => {
    expect(connectsToBuffer(datasetNode({ layerType: "table" }))).toBe(false);
  });
});
