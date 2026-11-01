/**
 * A tool step shows what the workflow check reports for it: one badge (also
 * after a run) and an amber ring on each input the check found unconnected.
 * The node no longer runs checks of its own.
 */
import { configureStore } from "@reduxjs/toolkit";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import React from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { workflowReducer } from "@/lib/store/workflow/slice";
import type { ToolNodeData } from "@/lib/validations/workflow";

import { makeIssue } from "@/components/workflows/issues/__tests__/issueFixtures";
import ToolNode from "@/components/workflows/nodes/ToolNode";

const { issuesByNode, runState, processState } = vi.hoisted(() => ({
  issuesByNode: new Map<string, unknown[]>(),
  runState: { status: undefined as string | undefined },
  processState: { process: undefined as unknown },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count !== undefined ? `${key}:${options.count}` : key,
  }),
}));

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
    useEdges: () => [],
  };
});

vi.mock("@p4b/ui/assets/svg/ToolIcons", () => ({ toolIconMap: {} }));

vi.mock("@/hooks/map/useOgcProcesses", () => ({
  useProcessDescription: () => ({ process: processState.process }),
}));

vi.mock("@/components/workflows/context/WorkflowExecutionContext", () => ({
  useNodeExecutionStatus: () => ({ status: runState.status, info: undefined }),
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

const layerInput = (title: string, section: string) => ({
  title,
  schema: { type: "string", "x-ui": { widget: "layer-selector", section } },
  minOccurs: 1,
  maxOccurs: 1,
  keywords: [],
  metadata: [],
});

const clip = {
  id: "clip",
  title: "Clip",
  inputs: {
    input_layer_id: layerInput("Input layer", "input"),
    overlay_layer_id: layerInput("Overlay layer", "overlay"),
  },
  outputs: {},
};

const heatmap = {
  id: "heatmap_gravity",
  title: "Heatmap gravity",
  inputs: {
    opportunity_layer_1_id: layerInput("Opportunities 1", "opportunities"),
    opportunity_layer_2_id: layerInput("Opportunities 2", "opportunities"),
    opportunity_layer_3_id: layerInput("Opportunities 3", "opportunities"),
  },
  outputs: {},
};

type ToolNodeProps = ComponentProps<typeof ToolNode>;

const clipData: ToolNodeData = { type: "tool", processId: "clip", label: "Clip", config: {}, status: "idle" };

const renderNode = (data: ToolNodeData = clipData) =>
  render(
    <Provider store={configureStore({ reducer: { workflow: workflowReducer } })}>
      <ToolNode
        {...({
          id: "tool-1",
          type: "tool",
          data,
          selected: false,
          dragging: false,
          zIndex: 0,
          isConnectable: true,
          positionAbsoluteX: 0,
          positionAbsoluteY: 0,
        } as unknown as ToolNodeProps)}
      />
    </Provider>
  );

describe("ToolNode issues", () => {
  beforeEach(() => {
    issuesByNode.clear();
    runState.status = undefined;
    processState.process = clip;
  });

  it("shows no badge while the check reports nothing for the step", () => {
    renderNode();
    expect(screen.queryByTestId("step-issue-badge")).not.toBeInTheDocument();
  });

  it("still draws a step whose tool no longer exists, with its issue on the badge", () => {
    processState.process = undefined;
    issuesByNode.set("tool-1", [makeIssue({ code: "tool_removed", node_ids: ["tool-1"], field: null })]);
    renderNode({ ...clipData, processId: "retired_tool", label: "retired_tool" });
    expect(screen.getByTestId("step-issue-badge")).toBeInTheDocument();
  });

  it("keeps its badge after a run, next to the run status", () => {
    runState.status = "completed";
    issuesByNode.set("tool-1", [
      makeIssue({ code: "setting_required", node_ids: ["tool-1"], field: "distances" }),
    ]);
    renderNode();
    expect(screen.getByTestId("step-issue-badge")).toBeInTheDocument();
  });

  it("rings the handle of the input the check found unconnected, and only that one", async () => {
    issuesByNode.set("tool-1", [
      makeIssue({ code: "input_not_connected", node_ids: ["tool-1"], field: "overlay_layer_id" }),
    ]);
    renderNode();
    await expect(screen.getByTestId("handle-target-overlay_layer_id")).toHaveAttribute("data-issue", "true");
    await expect(screen.getByTestId("handle-target-input_layer_id")).not.toHaveAttribute("data-issue");
  });

  it("rings every opportunity handle while none of them is connected", async () => {
    processState.process = heatmap;
    issuesByNode.set("tool-1", [makeIssue({ code: "opportunity_not_connected", node_ids: ["tool-1"] })]);
    renderNode({ ...clipData, processId: "heatmap_gravity", label: "Heatmap gravity" });
    for (const handle of ["opportunity_layer_1_id", "opportunity_layer_2_id", "opportunity_layer_3_id"]) {
      await expect(screen.getByTestId(`handle-target-${handle}`)).toHaveAttribute("data-issue", "true");
    }
  });
});
