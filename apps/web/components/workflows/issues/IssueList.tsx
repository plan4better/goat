"use client";

import DotIcon from "@mui/icons-material/FiberManualRecord";
import { List, ListItemButton, ListItemIcon, ListItemText, ListSubheader, useTheme } from "@mui/material";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";

import { selectNodes } from "@/lib/store/workflow/selectors";
import { issueText, stepName } from "@/lib/utils/workflowIssueText";
import type { WorkflowNode } from "@/lib/validations/workflow";
import { type WorkflowIssue, issueRank } from "@/lib/validations/workflowIssues";

import StepIcon from "@/components/workflows/issues/StepIcon";
import { issueColor } from "@/components/workflows/issues/issueStyle";

export interface StepIssues {
  nodeId: string;
  /** The step on the canvas, or undefined when it is gone (an answer to an older state). */
  node: WorkflowNode | undefined;
  issues: WorkflowIssue[];
}

export interface IssueGroups {
  /** Issues of no single step: the whole workflow, or several steps such as a loop. */
  workflow: WorkflowIssue[];
  steps: StepIssues[];
}

const bySeverity = (issues: WorkflowIssue[]): WorkflowIssue[] =>
  [...issues].sort((a, b) => issueRank(a) - issueRank(b));

/**
 * The list's groups: issues of no single step first, then one group per step
 * in canvas order, steps no longer on the canvas last. Within a group the
 * most serious come first; the sort is stable, so the server's order holds
 * otherwise.
 */
export function groupIssues(issues: WorkflowIssue[], nodes: WorkflowNode[]): IssueGroups {
  const byStep = new Map<string, WorkflowIssue[]>();
  for (const issue of issues) {
    if (issue.node_ids.length !== 1) continue;
    const [nodeId] = issue.node_ids;
    byStep.set(nodeId, [...(byStep.get(nodeId) ?? []), issue]);
  }
  const position = new Map(nodes.map((node, index) => [node.id, index]));
  const place = (nodeId: string) => position.get(nodeId) ?? Number.MAX_SAFE_INTEGER;
  return {
    workflow: bySeverity(issues.filter((issue) => issue.node_ids.length !== 1)),
    steps: [...byStep.entries()]
      .map(([nodeId, stepIssues]) => ({
        nodeId,
        node: nodes.find((node) => node.id === nodeId),
        issues: bySeverity(stepIssues),
      }))
      .sort((a, b) => place(a.nodeId) - place(b.nodeId)),
  };
}

interface IssueListProps {
  issues: WorkflowIssue[];
  /** A row was clicked: take the editor to its step. */
  onSelect: (issue: WorkflowIssue) => void;
}

/** The issues of the open workflow, grouped by step, one row per issue. */
const IssueList: React.FC<IssueListProps> = ({ issues, onSelect }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const nodes = useSelector(selectNodes) as WorkflowNode[];
  const { workflow, steps } = useMemo(() => groupIssues(issues, nodes), [issues, nodes]);

  const stepLabel = (group: StepIssues): string => {
    if (group.node) return stepName(t, group.node);
    const named = group.issues[0]?.params.step;
    return typeof named === "string" ? named : group.nodeId;
  };

  const heading = (content: React.ReactNode) => (
    <ListSubheader
      component="div"
      role="heading"
      aria-level={3}
      disableSticky
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        pt: 1,
        lineHeight: "32px",
        fontWeight: 600,
        color: "text.primary",
      }}>
      {content}
    </ListSubheader>
  );

  const rows = (group: WorkflowIssue[]) =>
    group.map((issue, index) => (
      <ListItemButton
        key={`${issue.code}-${issue.field ?? ""}-${index}`}
        onClick={() => onSelect(issue)}
        sx={{ alignItems: "flex-start", py: 0.5 }}>
        <ListItemIcon sx={{ minWidth: 20, mt: "7px" }}>
          <DotIcon sx={{ fontSize: 10, color: issueColor(theme, issue) }} />
        </ListItemIcon>
        <ListItemText primary={issueText(t, issue)} primaryTypographyProps={{ variant: "body2" }} />
      </ListItemButton>
    ));

  return (
    <List dense disablePadding sx={{ pb: 1 }}>
      {workflow.length > 0 && (
        <>
          {heading(t("workflow_issues_workflow"))}
          {rows(workflow)}
        </>
      )}
      {steps.map((group) => (
        <React.Fragment key={group.nodeId}>
          {heading(
            <>
              <StepIcon node={group.node} />
              <span>{stepLabel(group)}</span>
            </>
          )}
          {rows(group.issues)}
        </React.Fragment>
      ))}
    </List>
  );
};

export default IssueList;
