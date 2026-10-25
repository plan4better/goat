/**
 * "Save as dataset" in its two modes: a new dataset needs a name; "Add to
 * existing" needs a target dataset instead. A missing name, target or
 * connection is a workflow issue (the step's issue badge); the edit-rights
 * warning is the node's own, as only the browser knows whether the user may
 * edit the target.
 */
import { configureStore } from "@reduxjs/toolkit";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import React from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { workflowReducer } from "@/lib/store/workflow/slice";
import type { ExportNodeData } from "@/lib/validations/workflow";

import { makeIssue } from "@/components/workflows/issues/__tests__/issueFixtures";
import ExportNode from "@/components/workflows/nodes/ExportNode";

const { issuesByNode } = vi.hoisted(() => ({ issuesByNode: new Map<string, unknown[]>() }));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock("@xyflow/react", async () => {
  const { forwardRef } = await import("react");
  return {
    Handle: forwardRef<HTMLDivElement, Record<string, unknown>>(function Handle(props, ref) {
      return (
        <div
          ref={ref}
          data-testid={`handle-${String(props.type)}-${String(props.id)}`}
          data-issue={props["data-issue"] as string | undefined}
        />
      );
    }),
    NodeToolbar: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Position: { Top: "top", Right: "right", Left: "left", Bottom: "bottom" },
  };
});

vi.mock("@p4b/ui/assets/svg/ToolIcons", () => ({ toolIconMap: { export_dataset: () => null } }));

vi.mock("@/components/workflows/context/WorkflowExecutionContext", () => ({
  useNodeExecutionStatus: () => ({ status: undefined, info: undefined }),
}));

vi.mock("@/components/workflows/issues/WorkflowIssuesContext", () => ({
  useStepIssues: (nodeId: string) => issuesByNode.get(nodeId) ?? [],
  useWorkflowIssuesContext: () => ({
    issues: [],
    byNode: issuesByNode,
    blockingCount: 0,
    damaged: [],
    focus: vi.fn(),
    focusRequest: null,
  }),
}));

vi.mock("@/lib/utils/workflowIssueText", () => ({
  issueText: (_t: unknown, issue: { message: string }) => issue.message,
}));

const access = vi.hoisted(() => ({ canWrite: true as boolean | undefined }));
vi.mock("@/lib/api/layers", () => ({
  useLayerWriteAccess: () => ({ canWrite: access.canWrite }),
}));

type ExportNodeProps = ComponentProps<typeof ExportNode>;

const data: ExportNodeData = {
  type: "export",
  label: "Export",
  datasetName: "",
  addToProject: true,
  overwritePrevious: false,
  status: "idle",
};

const existing: ExportNodeData = {
  ...data,
  label: "Save as dataset",
  destination: "existing",
  targetLayerId: "0a1b2c3d-0000-4000-8000-00000000abcd",
  targetLayerName: "Monitoring",
};

// A node that has not run: no status, or the "idle" a new node is created with.
const fresh = (nodeData: ExportNodeData) => ({ ...nodeData, status: undefined }) as unknown as ExportNodeData;

const renderNode = (nodeData: ExportNodeData = data) =>
  render(
    <Provider store={configureStore({ reducer: { workflow: workflowReducer } })}>
      <ExportNode
        {...({
          id: "export-1",
          type: "export",
          data: nodeData,
          selected: false,
          dragging: false,
          zIndex: 0,
          isConnectable: true,
          positionAbsoluteX: 0,
          positionAbsoluteY: 0,
        } as unknown as ExportNodeProps)}
      />
    </Provider>
  );

beforeEach(() => {
  issuesByNode.clear();
  access.canWrite = true;
});

describe("ExportNode issues", () => {
  it("shows its issues although its stored status is idle", () => {
    issuesByNode.set("export-1", [
      makeIssue({ code: "export_name_missing", node_ids: ["export-1"], field: "datasetName" }),
    ]);
    renderNode();
    expect(screen.getByTestId("step-issue-badge")).toBeInTheDocument();
  });

  it("shows a warning, not the amber ring, while nothing is connected to it", async () => {
    issuesByNode.set("export-1", [
      makeIssue({ code: "export_not_connected", level: "warning", node_ids: ["export-1"] }),
    ]);
    renderNode();
    await expect(screen.getByTestId("step-issue-badge")).toHaveAttribute("data-severity", "warning");
    await expect(screen.getByTestId("handle-target-input")).not.toHaveAttribute("data-issue");
  });

  it("shows nothing while the check reports nothing", async () => {
    renderNode();
    expect(screen.queryByTestId("step-issue-badge")).not.toBeInTheDocument();
    await expect(screen.getByTestId("handle-target-input")).not.toHaveAttribute("data-issue");
  });

  it("leaves a missing name to the check: no warning of its own", () => {
    renderNode(fresh(data));
    expect(screen.queryByLabelText("dataset_name_required")).not.toBeInTheDocument();
  });
});

describe("ExportNode adding to an existing dataset", () => {
  it("shows the target dataset instead of a name", () => {
    renderNode(fresh({ ...existing, datasetName: "Old name" }));
    expect(screen.getByText("Monitoring")).toBeInTheDocument();
    expect(screen.queryByText("Old name")).not.toBeInTheDocument();
  });

  it("leaves a missing target to the check: the issue badge, no warning of its own", () => {
    access.canWrite = false;
    issuesByNode.set("export-1", [
      makeIssue({ code: "export_target_missing", node_ids: ["export-1"], field: "targetLayerId" }),
    ]);
    renderNode(fresh({ ...existing, targetLayerId: undefined, targetLayerName: undefined }));
    expect(screen.getByTestId("step-issue-badge")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^append_/)).not.toBeInTheDocument();
  });

  it("shows no warning for a missing target while the check reports nothing", () => {
    renderNode(fresh({ ...existing, targetLayerId: undefined, targetLayerName: undefined }));
    expect(screen.queryByTestId("step-issue-badge")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^append_/)).not.toBeInTheDocument();
  });

  it("warns before the run when the user may not edit the target", () => {
    access.canWrite = false;
    renderNode(fresh(existing));
    expect(screen.getByLabelText("append_no_edit_rights")).toBeInTheDocument();
  });

  it("warns on a new node, which is created with status idle", () => {
    access.canWrite = false;
    renderNode(existing);
    expect(screen.getByLabelText("append_no_edit_rights")).toBeInTheDocument();
  });

  it("does not warn when the user may edit the target", () => {
    renderNode(fresh(existing));
    expect(screen.queryByLabelText(/^append_/)).not.toBeInTheDocument();
  });

  it("shows the target warning next to the step's issues", () => {
    access.canWrite = false;
    issuesByNode.set("export-1", [
      makeIssue({ code: "export_not_connected", level: "warning", node_ids: ["export-1"] }),
    ]);
    renderNode(fresh(existing));
    expect(screen.getByTestId("step-issue-badge")).toBeInTheDocument();
    expect(screen.getByLabelText("append_no_edit_rights")).toBeInTheDocument();
  });
});
