"use client";

import WarningIcon from "@mui/icons-material/Warning";
import { Button, Paper, Stack, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";

import { issueText } from "@/lib/utils/workflowIssueText";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import type { AutosaveStatus } from "@/hooks/workflows/useWorkflowAutosave";

import IssueIcon from "@/components/workflows/issues/IssueIcon";
import { issueColor } from "@/components/workflows/issues/issueStyle";

interface SaveStatusNoticeProps {
  status: AutosaveStatus;
  /** What core found when it refused the config as damaged. */
  issues: WorkflowIssue[];
  onRetry: () => void;
}

/**
 * A small notice at the top of the canvas while the last autosave failed:
 * "Not saved" with Retry, and what core found if it refused the config.
 */
export default function SaveStatusNotice({ status, issues, onRetry }: SaveStatusNoticeProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  if (status !== "failed") return null;

  return (
    <Paper
      role="alert"
      elevation={3}
      sx={{
        position: "absolute",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 11,
        width: "calc(100% - 32px)",
        maxWidth: 420,
        px: 2,
        py: 1,
        borderLeft: `4px solid ${theme.palette.warning.main}`,
      }}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <WarningIcon sx={{ fontSize: 18, color: "warning.main" }} />
        <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>
          {t("workflow_not_saved")}
        </Typography>
        <Button size="small" onClick={onRetry} sx={{ textTransform: "none" }}>
          {t("workflow_save_retry")}
        </Button>
      </Stack>
      {issues.length > 0 && (
        <Stack component="ul" spacing={0.5} sx={{ m: 0, mt: 1, p: 0, listStyle: "none" }}>
          {issues.map((issue, index) => (
            <Stack
              component="li"
              key={`${issue.code}-${index}`}
              direction="row"
              spacing={1}
              alignItems="flex-start">
              <IssueIcon issue={issue} sx={{ fontSize: 16, mt: "2px", color: issueColor(theme, issue) }} />
              <Typography variant="body2">{issueText(t, issue)}</Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
