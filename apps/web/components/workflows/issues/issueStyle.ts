import type { Theme } from "@mui/material/styles";

import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

/**
 * How serious an issue is where several sit on one step (its badge, its
 * settings): damaged, then a step that failed in the last run, then a check
 * error, then a warning. A run error outranks a check error of the same level:
 * the step already failed once, and its badge turns red.
 */
export type IssueSeverity = "damaged" | "run" | "error" | "warning";

export const issueSeverity = (issue: WorkflowIssue): IssueSeverity => {
  if (issue.level === "damaged") return "damaged";
  if (issue.source === "run") return "run";
  return issue.level;
};

const SEVERITY_RANK: Record<IssueSeverity, number> = { damaged: 3, run: 2, error: 1, warning: 0 };

/** Sort order: most serious first; issues of equal severity keep their order. */
export const bySeverity = (a: WorkflowIssue, b: WorkflowIssue): number =>
  SEVERITY_RANK[issueSeverity(b)] - SEVERITY_RANK[issueSeverity(a)];

export const mostSerious = (issues: WorkflowIssue[]): WorkflowIssue | undefined =>
  [...issues].sort(bySeverity)[0];

/**
 * The colour an issue is shown in: a step's error from the last run red, as
 * the editor marks failed steps; damaged and error issues amber; warnings
 * muted.
 */
export const issueColor = (theme: Theme, issue: WorkflowIssue): string => {
  if (issue.source === "run") return theme.palette.error.main;
  return issue.level === "warning" ? theme.palette.text.secondary : theme.palette.warning.main;
};
