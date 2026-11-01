"use client";

import WorkflowIcon from "@mui/icons-material/AccountTree";
import { Box, Button, Link, Paper, Stack, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useTemplates } from "@/lib/api/templates";
import { DOCS_URL } from "@/lib/constants";

import type { WorkflowCreation } from "@/hooks/workflows/useWorkflowCreation";

/** The workflows page of the user docs, in German for a German UI. */
export const workflowDocsUrl = (language: string): string =>
  `${DOCS_URL}${language === "de" ? "/de" : ""}/workflows/workflow_interface`;

interface WorkflowsEmptyStateProps {
  creation: Pick<WorkflowCreation, "canCreate" | "isCreating" | "createFromScratch" | "openTemplateBrowser">;
}

/**
 * What the canvas shows while the project has no workflow: what a workflow
 * is, the two ways to start one (the same as the list's New menu) and a link
 * to the docs. "Start from a template" shows only when the user can see a
 * workflow template, since a new installation ships none.
 */
export default function WorkflowsEmptyState({ creation }: WorkflowsEmptyStateProps) {
  const { t, i18n } = useTranslation("common");
  const { page } = useTemplates({ source: "all", kind: "workflow", size: 1 });
  const hasTemplates = (page?.total ?? 0) > 0;

  return (
    <Box sx={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", p: 2 }}>
      <Paper
        variant="outlined"
        sx={{ width: "100%", maxWidth: 400, p: 4, textAlign: "center", borderRadius: 2 }}>
        <Stack spacing={2} alignItems="center">
          <Box
            sx={{
              width: 56,
              height: 56,
              borderRadius: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "action.hover",
              color: "text.secondary",
            }}>
            <WorkflowIcon sx={{ fontSize: 28 }} />
          </Box>
          <Typography variant="h6" component="h2">
            {t("workflow_empty_title")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("workflow_empty_body")}
          </Typography>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            sx={{ width: "100%", justifyContent: "center" }}>
            <Button
              variant="contained"
              disabled={!creation.canCreate || creation.isCreating}
              onClick={() => void creation.createFromScratch()}
              startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 12 }} />}
              sx={{ textTransform: "none" }}>
              {t("workflow_empty_new")}
            </Button>
            {hasTemplates && (
              <Button
                variant="outlined"
                disabled={!creation.canCreate}
                onClick={creation.openTemplateBrowser}
                startIcon={<Icon iconName={ICON_NAME.CLONE} style={{ fontSize: 12 }} />}
                sx={{ textTransform: "none" }}>
                {t("workflow_empty_template")}
              </Button>
            )}
          </Stack>
          <Link
            href={workflowDocsUrl(i18n.language)}
            target="_blank"
            rel="noopener noreferrer"
            variant="body2">
            {t("workflow_empty_learn")}
          </Link>
        </Stack>
      </Paper>
    </Box>
  );
}
