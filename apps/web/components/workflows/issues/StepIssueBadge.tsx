"use client";

import { Box, ButtonBase, Paper, Typography } from "@mui/material";
import { keyframes, useTheme } from "@mui/material/styles";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { issueText } from "@/lib/utils/workflowIssueText";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import IssueIcon from "@/components/workflows/issues/IssueIcon";
import { useStepIssues, useWorkflowIssuesContext } from "@/components/workflows/issues/WorkflowIssuesContext";
import { bySeverity, issueColor, issueSeverity } from "@/components/workflows/issues/issueStyle";

/** How long a pointer, keyboard focus or tap rests on the badge before it opens. */
export const BADGE_OPEN_DELAY_MS = 150;

const appear = keyframes`
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
`;

interface StepIssueBadgeProps {
  nodeId: string;
}

/**
 * The issues of one step, at the bottom right corner of its node: coloured by
 * the most serious one, with a count when there are several. Resting the
 * pointer on it, focusing it or tapping it opens the messages; clicking it, or
 * one of the messages, goes to that issue (the step's settings at the setting
 * concerned). It stays visible after a run, next to the run status icon.
 *
 * `nodrag` keeps React Flow from starting a node drag on the badge, and the
 * click stops at the badge: going to the issue selects the step already.
 */
export default function StepIssueBadge({ nodeId }: StepIssueBadgeProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const issues = useStepIssues(nodeId);
  const { focus } = useWorkflowIssuesContext();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A tap opens the badge first; the tap after that (or on a message) goes to the issue.
  const touched = useRef(false);
  const panelId = useId();

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const openSoon = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => setOpen(true), BADGE_OPEN_DELAY_MS);
  }, [cancel]);
  const close = useCallback(() => {
    cancel();
    setOpen(false);
  }, [cancel]);

  useEffect(() => cancel, [cancel]);
  useEffect(() => {
    if (issues.length === 0) close();
  }, [issues.length, close]);

  if (issues.length === 0) return null;

  const sorted: WorkflowIssue[] = [...issues].sort(bySeverity);
  const top = sorted[0];
  const color = issueColor(theme, top);

  return (
    <Box
      className="nodrag nopan"
      data-testid="step-issue-badge"
      data-severity={issueSeverity(top)}
      onMouseEnter={openSoon}
      onMouseLeave={close}
      onFocus={openSoon}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
      onPointerDown={(event) => {
        touched.current = event.pointerType === "touch";
      }}
      sx={{ position: "absolute", bottom: -14, right: -8, zIndex: 3 }}>
      <ButtonBase
        aria-label={t("workflow_issues_count", { count: issues.length })}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (touched.current && !open) {
            touched.current = false;
            openSoon();
            return;
          }
          focus(top);
        }}
        sx={{
          minWidth: 24,
          height: 24,
          px: issues.length > 1 ? 0.75 : 0,
          gap: 0.25,
          borderRadius: 12,
          backgroundColor: color,
          color: theme.palette.getContrastText(color),
          fontSize: 12,
          fontWeight: 700,
          boxShadow: theme.shadows[1],
        }}>
        <IssueIcon issue={top} sx={{ fontSize: 16 }} />
        {issues.length > 1 && <span>{issues.length}</span>}
      </ButtonBase>
      {open && (
        <Paper
          id={panelId}
          elevation={6}
          sx={{
            position: "absolute",
            top: "100%",
            right: 0,
            mt: 0.5,
            width: 260,
            py: 0.5,
            animation: `${appear} 120ms ease-out`,
            "@media (prefers-reduced-motion: reduce)": { animation: "none" },
          }}>
          {sorted.map((issue, index) => (
            <ButtonBase
              key={`${issue.code}-${issue.field ?? ""}-${index}`}
              data-severity={issueSeverity(issue)}
              onClick={(event) => {
                event.stopPropagation();
                focus(issue);
              }}
              sx={{
                display: "flex",
                width: "100%",
                justifyContent: "flex-start",
                alignItems: "flex-start",
                gap: 1,
                px: 1.5,
                py: 0.75,
                textAlign: "left",
                "&:hover": { backgroundColor: "action.hover" },
              }}>
              <IssueIcon issue={issue} sx={{ fontSize: 16, mt: "2px", color: issueColor(theme, issue) }} />
              <Typography
                variant="caption"
                sx={{
                  lineHeight: 1.4,
                  color: "text.primary",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                }}>
                {issueText(t, issue)}
              </Typography>
            </ButtonBase>
          ))}
        </Paper>
      )}
    </Box>
  );
}
