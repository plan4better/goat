/**
 * "Save as dataset" in its two modes: a new dataset needs a name; "Add to
 * existing" needs a target dataset instead.
 */
import { configureStore } from "@reduxjs/toolkit";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import React from "react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { workflowReducer } from "@/lib/store/workflow/slice";
import type { ExportNodeData } from "@/lib/validations/workflow";

import { WorkflowExecutionProvider } from "@/components/workflows/context/WorkflowExecutionContext";
import ExportNode from "@/components/workflows/nodes/ExportNode";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  NodeToolbar: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Position: { Top: "top", Right: "right", Left: "left", Bottom: "bottom" },
  useEdges: () => [{ id: "e", source: "tool-1", target: "export-1" }],
}));

const access = vi.hoisted(() => ({ canWrite: true as boolean | undefined }));
vi.mock("@/lib/api/layers", () => ({
  useLayerWriteAccess: () => ({ canWrite: access.canWrite }),
}));

type Props = ComponentProps<typeof ExportNode>;

const renderNode = (data: ExportNodeData) =>
  render(
    <Provider store={configureStore({ reducer: { workflow: workflowReducer } })}>
      <WorkflowExecutionProvider
        isExecuting={false}
        nodeStatuses={{}}
        nodeExecutionInfo={{}}
        tempLayerIds={{}}
        exportedLayerIds={{}}
        tempLayerProperties={{}}>
        <ExportNode {...({ id: "export-1", type: "export", data, selected: false } as unknown as Props)} />
      </WorkflowExecutionProvider>
    </Provider>
  );

const existing: ExportNodeData = {
  type: "export",
  label: "Save as dataset",
  datasetName: "",
  addToProject: true,
  overwritePrevious: false,
  status: "idle",
  destination: "existing",
  targetLayerId: "0a1b2c3d-0000-4000-8000-00000000abcd",
  targetLayerName: "Monitoring",
};

// A node that has not run: no status, or the "idle" a new node is created with.
const fresh = (data: ExportNodeData) => ({ ...data, status: undefined }) as unknown as ExportNodeData;

describe("ExportNode", () => {
  it("asks for a name for a new dataset", () => {
    renderNode(
      fresh({ ...existing, destination: undefined, targetLayerId: undefined, targetLayerName: undefined })
    );
    expect(screen.getByLabelText("dataset_name_required")).toBeInTheDocument();
  });

  it("needs no name when adding to an existing dataset", () => {
    renderNode(fresh(existing));
    expect(screen.queryByLabelText("dataset_name_required")).not.toBeInTheDocument();
    expect(screen.getByText("Monitoring")).toBeInTheDocument();
  });

  it("asks for a target when adding to an existing dataset without one", () => {
    renderNode(fresh({ ...existing, targetLayerId: undefined, targetLayerName: undefined }));
    expect(screen.getByLabelText("append_target_required")).toBeInTheDocument();
  });

  it("warns before the run when the user may not edit the target", () => {
    access.canWrite = false;
    renderNode(fresh(existing));
    expect(screen.getByLabelText("append_no_edit_rights")).toBeInTheDocument();
    access.canWrite = true;
  });

  it("warns on a new node, which is created with status idle", () => {
    renderNode({ ...existing, destination: undefined, targetLayerId: undefined, targetLayerName: undefined });
    expect(screen.getByLabelText("dataset_name_required")).toBeInTheDocument();
  });

  it("does not warn when the user may edit the target", () => {
    access.canWrite = true;
    renderNode(fresh(existing));
    expect(screen.queryByLabelText("append_no_edit_rights")).not.toBeInTheDocument();
  });
});
