import { createTheme } from "@mui/material/styles";
import { configureStore } from "@reduxjs/toolkit";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Node } from "@xyflow/react";
import React from "react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { workflowReducer } from "@/lib/store/workflow/slice";
import type { WorkflowNode } from "@/lib/validations/workflow";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import IssueList, { groupIssues } from "@/components/workflows/issues/IssueList";
import { issueColor } from "@/components/workflows/issues/issueStyle";

vi.mock("react-i18next", async () => {
  const { commonI18n } = await import("@/i18n/__tests__/commonI18n");
  const i18n = commonI18n("en");
  const t = i18n.getFixedT("en", "common");
  return { useTranslation: () => ({ t, i18n }) };
});

const NODES: Node[] = [
  { id: "dataset-1", type: "dataset", position: { x: 0, y: 0 }, data: { type: "dataset", label: "Schools" } },
  {
    id: "tool-1",
    type: "tool",
    position: { x: 300, y: 0 },
    data: { type: "tool", processId: "buffer", label: "buffer", config: {} },
  },
  {
    id: "tool-2",
    type: "tool",
    position: { x: 600, y: 0 },
    data: { type: "tool", processId: "clip", label: "clip", config: {} },
  },
];

const make = (
  code: string,
  level: WorkflowIssue["level"],
  nodeIds: string[],
  params: Record<string, unknown> = {},
  source: WorkflowIssue["source"] = "check"
): WorkflowIssue => ({ code, level, node_ids: nodeIds, field: null, message: code, params, source });

const noDistance = make("setting_required", "error", ["tool-1"], { step: "Buffer", label: "Distance" });
const notConnected = make("input_not_connected", "error", ["tool-2"], {
  step: "Clip",
  label: "Overlay layer",
});
const lonely = make("step_not_connected", "warning", ["dataset-1"], { step: "Schools" });
const removedStep = make("connection_to_removed_step", "error", []);
const loop = make("loop", "error", ["tool-2", "tool-1"], { steps: ["Clip", "Buffer"] });

const renderList = (issues: WorkflowIssue[], onSelect = vi.fn()) => {
  const store = configureStore({
    reducer: { workflow: workflowReducer },
    preloadedState: { workflow: { ...workflowReducer(undefined, { type: "init" }), nodes: NODES } },
  });
  render(
    <Provider store={store}>
      <IssueList issues={issues} onSelect={onSelect} />
    </Provider>
  );
  return onSelect;
};

describe("groupIssues", () => {
  it("puts issues of no single step first, then the steps in canvas order", () => {
    const groups = groupIssues(
      [notConnected, loop, lonely, noDistance, removedStep],
      NODES as WorkflowNode[]
    );
    expect(groups.workflow.map((i) => i.code)).toEqual(["loop", "connection_to_removed_step"]);
    expect(groups.steps.map((g) => g.nodeId)).toEqual(["dataset-1", "tool-1", "tool-2"]);
  });

  it("orders a step's issues from the most serious and keeps the server's order otherwise", () => {
    const maybeMissing = make("field_maybe_missing", "warning", ["tool-1"], {
      label: "Field",
      field_name: "x",
    });
    const runError = make("run_failed", "error", ["tool-1"], { step: "Buffer", error: "boom" }, "run");
    const groups = groupIssues([maybeMissing, noDistance, runError], NODES as WorkflowNode[]);
    expect(groups.steps[0].issues.map((i) => i.code)).toEqual([
      "setting_required",
      "run_failed",
      "field_maybe_missing",
    ]);
  });

  it("keeps a step that is no longer on the canvas, after the others", () => {
    const gone = make("tool_removed", "error", ["tool-9"], { step: "Old tool", tool: "old_tool" });
    const groups = groupIssues([gone, noDistance], NODES as WorkflowNode[]);
    expect(groups.steps.map((g) => g.nodeId)).toEqual(["tool-1", "tool-9"]);
    expect(groups.steps[1].node).toBeUndefined();
  });
});

describe("IssueList", () => {
  it("shows the whole-workflow group, then each step under its name", () => {
    renderList([notConnected, lonely, removedStep, noDistance]);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Whole workflow",
      "Schools",
      "Buffer",
      "Clip",
    ]);
    expect(
      screen.getByRole("button", { name: "A connection leads to a step that no longer exists." })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Distance needs a value." })).toBeInTheDocument();
  });

  it("names a step that is gone by the name the server sent", () => {
    renderList([make("tool_removed", "error", ["tool-9"], { step: "Old tool", tool: "old_tool" })]);
    expect(screen.getByRole("heading", { name: "Old tool" })).toBeInTheDocument();
  });

  it("hands the clicked issue on", async () => {
    const onSelect = renderList([noDistance, notConnected]);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Overlay layer is not connected." }));
    expect(onSelect).toHaveBeenCalledWith(notConnected);
  });
});

describe("issueColor", () => {
  it("shows errors amber, warnings muted and the last run's errors red", () => {
    const theme = createTheme();
    expect(issueColor(theme, noDistance)).toBe(theme.palette.warning.main);
    expect(issueColor(theme, make("node_without_id", "damaged", []))).toBe(theme.palette.warning.main);
    expect(issueColor(theme, lonely)).toBe(theme.palette.text.secondary);
    expect(issueColor(theme, make("run_failed", "error", ["tool-1"], {}, "run"))).toBe(
      theme.palette.error.main
    );
  });
});
