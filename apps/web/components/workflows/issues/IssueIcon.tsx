"use client";

import ErrorIcon from "@mui/icons-material/Error";
import InfoIcon from "@mui/icons-material/Info";
import WarningIcon from "@mui/icons-material/Warning";
import type { SvgIconProps } from "@mui/material";

import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import { issueSeverity } from "@/components/workflows/issues/issueStyle";

/** The icon of an issue's severity, for step badges, step settings and notices. */
export default function IssueIcon({ issue, ...props }: { issue: WorkflowIssue } & SvgIconProps) {
  const severity = issueSeverity(issue);
  if (severity === "run") return <ErrorIcon {...props} />;
  if (severity === "warning") return <InfoIcon {...props} />;
  return <WarningIcon {...props} />;
}
