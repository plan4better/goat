"use client";

import { Box, Typography } from "@mui/material";
import { type SxProps, type Theme, useTheme } from "@mui/material/styles";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { issueText } from "@/lib/utils/workflowIssueText";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import { bySeverity, issueColor, issueSeverity } from "@/components/workflows/issues/issueStyle";

interface StepSettingFieldProps {
  /** The setting's name, as the issues' `field` and the step's config name it. */
  name: string;
  /** The step's issues; the ones about this setting show under it. */
  issues: WorkflowIssue[];
  sx?: SxProps<Theme>;
  children: ReactNode;
}

/**
 * One setting in a step's settings panel: marks it with `data-field`, where
 * "go to this setting" finds it, and shows the step's issues about this
 * setting under it, a failed run's in red, the check's in amber or muted.
 */
export default function StepSettingField({ name, issues, sx, children }: StepSettingFieldProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const own = issues.filter((issue) => issue.field === name).sort(bySeverity);

  return (
    <Box data-field={name} sx={sx}>
      {children}
      {own.map((issue, index) => (
        <Typography
          key={`${issue.code}-${index}`}
          variant="caption"
          data-severity={issueSeverity(issue)}
          sx={{ display: "block", mt: 0.5, color: issueColor(theme, issue) }}>
          {issueText(t, issue)}
        </Typography>
      ))}
    </Box>
  );
}
