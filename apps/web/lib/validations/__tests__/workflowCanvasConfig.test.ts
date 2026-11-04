import { describe, expect, it } from "vitest";

import { createEmptyWorkflowConfig, isDrawableWorkflowConfig } from "@/lib/validations/workflow";

const step = (overrides: Record<string, unknown> = {}) => ({
  id: "dataset-1",
  type: "dataset",
  position: { x: 0, y: 0 },
  data: { type: "dataset", label: "Schools", layerId: "42" },
  ...overrides,
});

const config = (overrides: Record<string, unknown> = {}) => ({
  nodes: [step()],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  variables: [],
  ...overrides,
});

describe("isDrawableWorkflowConfig", () => {
  it("draws what the editor writes, and older steps the stricter editor schema refuses", () => {
    expect(isDrawableWorkflowConfig(createEmptyWorkflowConfig())).toBe(true);
    // A dataset step that names its layer by the project layer's number.
    expect(isDrawableWorkflowConfig(config())).toBe(true);
    expect(isDrawableWorkflowConfig({ nodes: [], edges: [] })).toBe(true);
  });

  it.each([
    ["a config that is not an object", "nodes"],
    ["a config without steps", { edges: [] }],
    ["steps that are not a list", { nodes: {}, edges: [] }],
    ["a step without id", config({ nodes: [step({ id: undefined })] })],
    ["a step of an unknown type", config({ nodes: [step({ type: "chart" })] })],
    ["a step without position", config({ nodes: [step({ position: undefined })] })],
    ["two steps with one id", config({ nodes: [step(), step()] })],
    ["a connection without an end", config({ edges: [{ id: "e1", source: "dataset-1" }] })],
    ["variables that are not a list", config({ variables: "radius" })],
  ])("refuses %s", (_case, value) => {
    expect(isDrawableWorkflowConfig(value)).toBe(false);
  });
});
