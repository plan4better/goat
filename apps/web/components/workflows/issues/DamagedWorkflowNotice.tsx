"use client";

import WarningIcon from "@mui/icons-material/Warning";
import { Box, Paper, Stack, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { issueText } from "@/lib/utils/workflowIssueText";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import IssueIcon from "@/components/workflows/issues/IssueIcon";
import { issueColor } from "@/components/workflows/issues/issueStyle";

interface DamagedWorkflowNoticeProps {
  /** The damaged issues the check found; empty when it could not name any. */
  issues: WorkflowIssue[];
  /** What went wrong when there is no issue to list: the saved config, or drawing a step. */
  cause?: "saved" | "drawing";
}

/**
 * Takes the canvas's place for a workflow the editor cannot draw: read-only,
 * with what is broken. Run goes with the canvas (the toolbar is part of it)
 * and the layout stops autosaving it; the workflow list, the other workflows
 * and the panels keep working. A later "Fix with AI" action belongs here.
 */
export default function DamagedWorkflowNotice({ issues, cause = "saved" }: DamagedWorkflowNoticeProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const titleId = useId();

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 2,
        backgroundColor: "background.default",
      }}>
      <Paper
        variant="outlined"
        role="region"
        aria-labelledby={titleId}
        sx={{ maxWidth: 480, width: "100%", p: 3 }}>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center">
            <WarningIcon sx={{ color: "warning.main" }} />
            <Typography id={titleId} variant="subtitle1" component="h2" fontWeight={600}>
              {t("workflow_damaged_title")}
            </Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {t("workflow_damaged_body")}
          </Typography>
          <Stack component="ul" spacing={0.75} sx={{ m: 0, p: 0, listStyle: "none" }}>
            {issues.length > 0 ? (
              issues.map((issue, index) => (
                <Stack
                  component="li"
                  key={`${issue.code}-${index}`}
                  direction="row"
                  spacing={1}
                  alignItems="flex-start">
                  <IssueIcon
                    issue={issue}
                    sx={{ fontSize: 16, mt: "2px", color: issueColor(theme, issue) }}
                  />
                  <Typography variant="body2">{issueText(t, issue)}</Typography>
                </Stack>
              ))
            ) : (
              <Typography component="li" variant="body2">
                {t(cause === "drawing" ? "workflow_damaged_drawing" : "workflow_damaged_saved")}
              </Typography>
            )}
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
}
