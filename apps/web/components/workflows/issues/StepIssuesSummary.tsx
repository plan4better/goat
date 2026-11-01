"use client";

import { Stack, Typography } from "@mui/material";
import { type SxProps, type Theme, useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";

import { issueText } from "@/lib/utils/workflowIssueText";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import { STEP_ISSUES_FIELD } from "@/hooks/workflows/useStepFieldFocus";

import IssueIcon from "@/components/workflows/issues/IssueIcon";
import { bySeverity, issueColor, issueSeverity } from "@/components/workflows/issues/issueStyle";

interface StepIssuesSummaryProps {
  /** The step's issues that no setting on screen carries. */
  issues: WorkflowIssue[];
  sx?: SxProps<Theme>;
}

/**
 * The top of a step's settings: its issues that belong to no setting shown
 * below (the whole step, a connection, a setting in a closed section), most
 * serious first.
 */
export default function StepIssuesSummary({ issues, sx }: StepIssuesSummaryProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  if (issues.length === 0) return null;

  return (
    <Stack
      component="ul"
      data-field={STEP_ISSUES_FIELD}
      data-testid="step-issues"
      spacing={0.75}
      sx={[
        { listStyle: "none", m: 0, mb: 2, p: 1.5, borderRadius: 1, border: 1, borderColor: "divider" },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}>
      {[...issues].sort(bySeverity).map((issue, index) => (
        <Stack
          component="li"
          key={`${issue.code}-${issue.field ?? ""}-${index}`}
          direction="row"
          spacing={1}
          alignItems="flex-start"
          data-severity={issueSeverity(issue)}>
          <IssueIcon issue={issue} sx={{ fontSize: 16, mt: "2px", color: issueColor(theme, issue) }} />
          <Typography variant="body2">{issueText(t, issue)}</Typography>
        </Stack>
      ))}
    </Stack>
  );
}
