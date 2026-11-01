"use client";

import React, { type ReactNode, createContext, useContext } from "react";

import { type WorkflowIssue, isBlockingIssue } from "@/lib/validations/workflowIssues";

/** A request to the step settings panel to show `field`; `seq` grows with every request. */
export type FocusRequest = { nodeId: string; field: string | null; seq: number };

export type WorkflowIssuesValue = {
  issues: WorkflowIssue[];
  /** Each step's issues; an issue of several steps (a loop) is under each of them. */
  byNode: Map<string, WorkflowIssue[]>;
  /** Damaged and error issues of the check: they keep Run disabled. */
  blockingCount: number;
  damaged: WorkflowIssue[];
  /** Centres the canvas on the issue's step, selects it and opens its settings at `field`. */
  focus: (issue: WorkflowIssue) => void;
  focusRequest: FocusRequest | null;
  /** The check of the current steps failed, so `issues` may not describe them. */
  checkFailed?: boolean;
  /** Checks the current steps again at once. */
  recheck?: () => void;
};

const NO_ISSUES: WorkflowIssue[] = [];

/** The derived parts of the context value. */
export function summarizeIssues(
  issues: WorkflowIssue[]
): Pick<WorkflowIssuesValue, "byNode" | "blockingCount" | "damaged"> {
  const byNode = new Map<string, WorkflowIssue[]>();
  for (const issue of issues) {
    for (const nodeId of issue.node_ids) byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), issue]);
  }
  return {
    byNode,
    blockingCount: issues.filter(isBlockingIssue).length,
    damaged: issues.filter((issue) => issue.level === "damaged"),
  };
}

const EMPTY_VALUE: WorkflowIssuesValue = {
  issues: NO_ISSUES,
  byNode: new Map(),
  blockingCount: 0,
  damaged: NO_ISSUES,
  focus: () => undefined,
  focusRequest: null,
};

const WorkflowIssuesContext = createContext<WorkflowIssuesValue>(EMPTY_VALUE);

export function WorkflowIssuesProvider({
  value,
  children,
}: {
  value: WorkflowIssuesValue;
  children: ReactNode;
}) {
  return <WorkflowIssuesContext.Provider value={value}>{children}</WorkflowIssuesContext.Provider>;
}

/** The issue list of the open workflow; empty outside the Workflows editor. */
export function useWorkflowIssuesContext(): WorkflowIssuesValue {
  return useContext(WorkflowIssuesContext);
}

/** One step's issues; the same empty array for a step without any. */
export function useStepIssues(nodeId: string): WorkflowIssue[] {
  return useContext(WorkflowIssuesContext).byNode.get(nodeId) ?? NO_ISSUES;
}
