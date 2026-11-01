import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

/** An issue as the check or a failed run reports it, with the fields a test
 * does not care about filled in. */
export const makeIssue = (
  overrides: Partial<WorkflowIssue> & Pick<WorkflowIssue, "code">
): WorkflowIssue => ({
  level: "error",
  node_ids: [],
  field: null,
  message: `${overrides.code} message`,
  params: {},
  source: "check",
  ...overrides,
});
