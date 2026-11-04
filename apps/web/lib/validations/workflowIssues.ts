import * as z from "zod";

/**
 * The issues of a workflow as the processes service reports them (the answer
 * of `POST /workflows/check`, and the 422 of a refused run), and as the
 * editor builds them from a failed run's step errors (`source: "run"`).
 * `message` is English; the editor shows it for a code it has no text for.
 */
export const workflowIssueLevelSchema = z.enum(["damaged", "error", "warning"]);

export type WorkflowIssueLevel = z.infer<typeof workflowIssueLevelSchema>;

export const workflowIssueSchema = z.object({
  code: z.string(),
  level: workflowIssueLevelSchema,
  /** The steps it concerns: none for the whole workflow, several for a loop. */
  node_ids: z.array(z.string()).default([]),
  /** The tool input or setting it concerns, or null. */
  field: z.string().nullable().default(null),
  message: z.string(),
  /** The values the translated text is built from (step, label, ...). */
  params: z.record(z.unknown()).default({}),
  source: z.enum(["check", "run"]).default("check"),
});

export type WorkflowIssue = z.infer<typeof workflowIssueSchema>;

/** The answer of `POST /workflows/check`. */
export const workflowCheckResponseSchema = z.object({ issues: z.array(workflowIssueSchema) });

/** The body of a run `POST /workflows/{id}/execute` refuses with 422. */
export const workflowRefusalSchema = z.object({
  detail: z.object({ message: z.string(), issues: z.array(workflowIssueSchema) }),
});

const LEVEL_RANK: Record<WorkflowIssueLevel, number> = { damaged: 0, error: 1, warning: 2 };

/** Orders issues from the most serious: damaged, then errors, then warnings. */
export const issueRank = (issue: WorkflowIssue): number => LEVEL_RANK[issue.level];

/**
 * Whether the issue keeps Run disabled: damaged and error issues of the
 * check. A step's error from the last run does not, so a run that failed for
 * a passing reason can be started again without editing the step.
 */
export const isBlockingIssue = (issue: WorkflowIssue): boolean =>
  issue.source === "check" && issue.level !== "warning";
