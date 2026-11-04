import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import {
  WorkflowIssuesProvider,
  type WorkflowIssuesValue,
  summarizeIssues,
  useStepIssues,
  useWorkflowIssuesContext,
} from "@/components/workflows/issues/WorkflowIssuesContext";

const issue = (
  code: string,
  level: WorkflowIssue["level"],
  nodeIds: string[],
  source: WorkflowIssue["source"] = "check"
): WorkflowIssue => ({ code, level, node_ids: nodeIds, field: null, message: code, params: {}, source });

const ISSUES = [
  issue("node_duplicate_id", "damaged", ["tool-2"]),
  issue("setting_required", "error", ["tool-1"]),
  issue("step_not_connected", "warning", ["dataset-1"]),
  issue("run_failed", "error", ["tool-1"], "run"),
  issue("loop", "error", ["tool-1", "tool-2"]),
];

describe("summarizeIssues", () => {
  it("counts damaged and error issues of the check as blocking, not warnings or run errors", () => {
    const summary = summarizeIssues(ISSUES);
    expect(summary.blockingCount).toBe(3);
    expect(summary.damaged.map((i) => i.code)).toEqual(["node_duplicate_id"]);
  });

  it("files an issue under every step it names", () => {
    const { byNode } = summarizeIssues(ISSUES);
    expect(byNode.get("tool-1")?.map((i) => i.code)).toEqual(["setting_required", "run_failed", "loop"]);
    expect(byNode.get("tool-2")?.map((i) => i.code)).toEqual(["node_duplicate_id", "loop"]);
    expect(byNode.has("dataset-2")).toBe(false);
  });
});

describe("useStepIssues", () => {
  it("returns a step's issues from the provider", () => {
    const value: WorkflowIssuesValue = {
      ...summarizeIssues(ISSUES),
      issues: ISSUES,
      focus: vi.fn(),
      focusRequest: null,
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WorkflowIssuesProvider value={value}>{children}</WorkflowIssuesProvider>
    );
    const { result } = renderHook(() => useStepIssues("dataset-1"), { wrapper });
    expect(result.current.map((i) => i.code)).toEqual(["step_not_connected"]);
  });

  it("is empty and safe to use outside the provider", () => {
    const { result } = renderHook(() => ({ step: useStepIssues("tool-1"), all: useWorkflowIssuesContext() }));
    expect(result.current.step).toEqual([]);
    expect(result.current.all.blockingCount).toBe(0);
    expect(result.current.all.focusRequest).toBeNull();
    expect(() => result.current.all.focus(ISSUES[0])).not.toThrow();
  });
});
