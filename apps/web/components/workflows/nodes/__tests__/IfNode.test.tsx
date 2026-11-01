import { configureStore } from "@reduxjs/toolkit";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import React from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { workflowReducer } from "@/lib/store/workflow/slice";
import type { IfNodeData } from "@/lib/validations/workflow";

import { makeIssue } from "@/components/workflows/issues/__tests__/issueFixtures";
import IfNode from "@/components/workflows/nodes/IfNode";

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

type IfNodeProps = ComponentProps<typeof IfNode>;

const data: IfNodeData = {
  type: "if",
  label: "Conditional",
  mode: "simple",
  customExpression: "",
  status: "idle",
};

const renderNode = () =>
  render(
    <Provider store={configureStore({ reducer: { workflow: workflowReducer } })}>
      <IfNode
        {...({
          id: "if-1",
          type: "if",
          data,
          selected: false,
          dragging: false,
          zIndex: 0,
          isConnectable: true,
          positionAbsoluteX: 0,
          positionAbsoluteY: 0,
        } as unknown as IfNodeProps)}
      />
    </Provider>
  );

describe("IfNode issues", () => {
  beforeEach(() => {
    issuesByNode.clear();
  });

  it("shows an incomplete condition on its badge", () => {
    issuesByNode.set("if-1", [makeIssue({ code: "if_condition_incomplete", node_ids: ["if-1"] })]);
    renderNode();
    expect(screen.getByTestId("step-issue-badge")).toBeInTheDocument();
  });

  it("rings its input while nothing is connected to it", async () => {
    issuesByNode.set("if-1", [
      makeIssue({ code: "if_input_count", node_ids: ["if-1"], params: { count: 0 } }),
    ]);
    renderNode();
    await expect(screen.getByTestId("handle-target-input")).toHaveAttribute("data-issue", "true");
  });

  it("does not ring an input that has too many connections", async () => {
    issuesByNode.set("if-1", [
      makeIssue({ code: "if_input_count", node_ids: ["if-1"], params: { count: 2 } }),
    ]);
    renderNode();
    await expect(screen.getByTestId("handle-target-input")).not.toHaveAttribute("data-issue");
  });
});
