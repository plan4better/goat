import { describe, expect, it } from "vitest";

import {
  type WorkflowIssue,
  isBlockingIssue,
  issueRank,
  workflowCheckResponseSchema,
  workflowIssueSchema,
} from "@/lib/validations/workflowIssues";

const serverIssue = {
  code: "input_not_connected",
  level: "error",
  node_ids: ["tool-1"],
  field: "input_layer_id",
  message: "Buffer: the input layer is not connected.",
  params: { step: "Buffer", label: "Input layer" },
  source: "check",
};

const issue = (level: WorkflowIssue["level"], source: WorkflowIssue["source"] = "check"): WorkflowIssue => ({
  ...(serverIssue as WorkflowIssue),
  level,
  source,
});

describe("workflow issue schema", () => {
  it("reads an issue as processes sends it", () => {
    expect(workflowIssueSchema.parse(serverIssue)).toEqual(serverIssue);
  });

  it("fills in what an answer leaves out", () => {
    expect(
      workflowIssueSchema.parse({ code: "loop", level: "error", message: "Steps form a loop." })
    ).toEqual({
      code: "loop",
      level: "error",
      node_ids: [],
      field: null,
      message: "Steps form a loop.",
      params: {},
      source: "check",
    });
  });

  it("refuses a level the editor cannot show", () => {
    expect(workflowIssueSchema.safeParse({ ...serverIssue, level: "fatal" }).success).toBe(false);
  });

  it("reads the check answer", () => {
    expect(workflowCheckResponseSchema.parse({ issues: [serverIssue] }).issues).toEqual([serverIssue]);
  });
});

describe("issue severity", () => {
  it("orders damaged before errors before warnings", () => {
    const sorted = [issue("warning"), issue("error"), issue("damaged")].sort(
      (a, b) => issueRank(a) - issueRank(b)
    );
    expect(sorted.map((i) => i.level)).toEqual(["damaged", "error", "warning"]);
  });

  it("blocks Run for damaged and error issues of the check, not for warnings or the last run's errors", () => {
    expect(isBlockingIssue(issue("damaged"))).toBe(true);
    expect(isBlockingIssue(issue("error"))).toBe(true);
    expect(isBlockingIssue(issue("warning"))).toBe(false);
    expect(isBlockingIssue(issue("error", "run"))).toBe(false);
  });
});
