import { describe, expect, it } from "vitest";

import { createExportNode, exportNodeDataSchema, workflowNodeSchema } from "@/lib/validations/workflow";

describe("Save as dataset node", () => {
  it("leaves a saved export node exactly as it was (new dataset)", () => {
    const exportNode = {
      id: "export-1",
      type: "export",
      position: { x: 0, y: 0 },
      data: {
        type: "export",
        label: "Export",
        datasetName: "x",
        addToProject: true,
        overwritePrevious: false,
        status: "idle",
      },
    };
    expect(workflowNodeSchema.parse(exportNode)).toEqual(exportNode);
    expect(createExportNode("e", { x: 0, y: 0 }).data).not.toHaveProperty("destination");
  });

  it("carries the add-to-existing settings", () => {
    const data = exportNodeDataSchema.parse({
      type: "export",
      label: "Save as dataset",
      destination: "existing",
      targetLayerId: "0a1b2c3d-0000-4000-8000-00000000abcd",
      targetLayerName: "Monitoring",
    });
    expect(data.destination).toBe("existing");
    expect(data.targetLayerName).toBe("Monitoring");
    expect(data).not.toHaveProperty("fieldMatching");
    expect(data).not.toHaveProperty("recordProvenance");
  });

  it("refuses an unknown destination", () => {
    expect(() =>
      exportNodeDataSchema.parse({ type: "export", label: "x", destination: "replace" })
    ).toThrow();
  });

  it("knows no separate append node type any more", () => {
    expect(() =>
      workflowNodeSchema.parse({
        id: "a",
        type: "append",
        position: { x: 0, y: 0 },
        data: { type: "append", label: "x" },
      })
    ).toThrow();
  });
});
