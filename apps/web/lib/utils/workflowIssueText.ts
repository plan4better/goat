import type { TFunction } from "i18next";

import type { WorkflowNode } from "@/lib/validations/workflow";
import { type WorkflowIssue, isBlockingIssue } from "@/lib/validations/workflowIssues";

/** React escapes the text it renders, so i18next must not escape step and field names a second time. */
const PLAIN = { escapeValue: false };

/** A list param (the steps of a loop) reads as names separated by commas. */
const asText = (value: unknown): unknown => (Array.isArray(value) ? value.map(String).join(", ") : value);

/**
 * The issue in the UI language: `workflow_issue_<code>` filled with the
 * issue's params, or the server's English message for a code without a text.
 * The texts leave the step's name out: the list groups issues under their
 * step, and the step's badge and settings show them on the step.
 */
export function issueText(t: TFunction, issue: WorkflowIssue): string {
  const params = Object.fromEntries(Object.entries(issue.params).map(([key, value]) => [key, asText(value)]));
  // A setting_invalid without a field is a combination of settings the tool rejects.
  const context = issue.code === "setting_invalid" && !issue.field ? "step" : undefined;
  const text = t(`workflow_issue_${issue.code}`, {
    ...params,
    context,
    defaultValue: issue.message,
    interpolation: PLAIN,
  });
  return text || issue.message;
}

/**
 * A step's name as the canvas shows it: a tool step by its tool's name (tool
 * steps keep their process id as label), any other step by its label, or by
 * its kind when it has none.
 */
export function stepName(t: TFunction, node: WorkflowNode): string {
  const { data } = node;
  switch (data.type) {
    case "tool":
      return t(data.processId, { defaultValue: data.label || data.processId });
    case "dataset":
      return data.label || data.layerName || t("dataset");
    case "export":
      return data.label || t("export_dataset");
    case "if":
      return data.label || t("if_node");
    default:
      return node.id;
  }
}

/**
 * The blocking issues of a refused run as one line, each led by its step's
 * name, for a place that shows them without the canvas (a toast).
 */
export function refusalSummary(t: TFunction, issues: WorkflowIssue[], nodes: WorkflowNode[]): string {
  return issues
    .filter(isBlockingIssue)
    .slice(0, 3)
    .map((issue) => {
      const node = issue.node_ids.length === 1 ? nodes.find((n) => n.id === issue.node_ids[0]) : undefined;
      const text = issueText(t, issue);
      return node ? `${stepName(t, node)}: ${text}` : text;
    })
    .join(" ");
}
