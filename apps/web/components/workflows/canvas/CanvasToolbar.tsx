"use client";

import VariablesIcon from "@mui/icons-material/DataObject";
import SelectIcon from "@mui/icons-material/NearMe";
import RunIcon from "@mui/icons-material/PlayArrow";
import RedoIcon from "@mui/icons-material/Redo";
import TextIcon from "@mui/icons-material/StickyNote2";
import StopIcon from "@mui/icons-material/Stop";
import NotCheckedIcon from "@mui/icons-material/SyncProblem";
import UndoIcon from "@mui/icons-material/Undo";
import IssuesIcon from "@mui/icons-material/WarningAmber";
import { Box, Button, Chip, IconButton, Popover, Tooltip, useTheme } from "@mui/material";
import { styled } from "@mui/material/styles";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import IssueList from "@/components/workflows/issues/IssueList";
import { useWorkflowIssuesContext } from "@/components/workflows/issues/WorkflowIssuesContext";

const ToolbarContainer = styled(Box)(({ theme }) => ({
  position: "absolute",
  bottom: theme.spacing(2),
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  alignItems: "center",
  gap: theme.spacing(1.5),
  zIndex: 10,
}));

const ToolGroup = styled(Box)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.spacing(0.5),
  padding: theme.spacing(0.5),
  backgroundColor: theme.palette.background.paper,
  borderRadius: 28,
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.08)",
  border: `1px solid ${theme.palette.divider}`,
}));

const ToolButton = styled(IconButton, {
  shouldForwardProp: (prop) => prop !== "active",
})<{ active?: boolean }>(({ theme, active }) => ({
  width: 40,
  height: 40,
  backgroundColor: active ? theme.palette.primary.main : "transparent",
  color: active ? theme.palette.primary.contrastText : theme.palette.text.primary,
  "&:hover": {
    backgroundColor: active ? theme.palette.primary.dark : theme.palette.action.hover,
  },
  "&.Mui-disabled": {
    color: theme.palette.text.disabled,
  },
}));

const Divider = styled(Box)(({ theme }) => ({
  width: 1,
  height: 24,
  backgroundColor: theme.palette.divider,
  margin: theme.spacing(0, 0.5),
}));

const RunButton = styled(Button)(({ theme }) => ({
  height: 40,
  paddingLeft: theme.spacing(2),
  paddingRight: theme.spacing(2.5),
  borderRadius: 20,
  backgroundColor: theme.palette.primary.main,
  color: theme.palette.primary.contrastText,
  fontWeight: 600,
  textTransform: "none",
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
  "&:hover": {
    backgroundColor: theme.palette.primary.dark,
  },
  "&.Mui-disabled": {
    backgroundColor: theme.palette.action.disabledBackground,
    color: theme.palette.text.disabled,
  },
  "& .MuiButton-startIcon": {
    marginRight: theme.spacing(0.5),
  },
}));

const StopButton = styled(Button)(({ theme }) => ({
  height: 40,
  paddingLeft: theme.spacing(2),
  paddingRight: theme.spacing(2.5),
  borderRadius: 20,
  backgroundColor: theme.palette.error.main,
  color: theme.palette.error.contrastText,
  fontWeight: 600,
  textTransform: "none",
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
  "&:hover": {
    backgroundColor: theme.palette.error.dark,
  },
  "& .MuiButton-startIcon": {
    marginRight: theme.spacing(0.5),
  },
}));

type CanvasTool = "select" | "text";

/**
 * The issue chip's colour: amber while issues keep Run disabled, red when
 * only the last run's step errors are listed, muted for warnings only.
 */
type IssueTone = "blocking" | "run" | "warning";

interface CanvasToolbarProps {
  activeTool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Starts a run. Resolves true when processes refused it with issues: the
   * list then holds those issues and opens. */
  onRun: () => void | Promise<boolean>;
  onStop?: () => void;
  isRunning?: boolean;
  canRun?: boolean;
  onVariablesClick?: () => void;
}

const CanvasToolbar: React.FC<CanvasToolbarProps> = ({
  activeTool,
  onToolChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onRun,
  onStop,
  isRunning = false,
  canRun = true,
  onVariablesClick,
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { issues, blockingCount, focus, checkFailed, recheck } = useWorkflowIssuesContext();
  const [listOpen, setListOpen] = useState(false);
  const [chipEl, setChipEl] = useState<HTMLDivElement | null>(null);

  // The list closes with its last issue, so it does not reopen on the next one.
  if (listOpen && issues.length === 0) setListOpen(false);

  const tone: IssueTone =
    blockingCount > 0 ? "blocking" : issues.some((issue) => issue.source === "run") ? "run" : "warning";
  const toneColor =
    tone === "blocking"
      ? theme.palette.warning.main
      : tone === "run"
        ? theme.palette.error.main
        : theme.palette.text.secondary;
  const countLabel = t("workflow_issues_count", { count: issues.length });

  const handleRun = async () => {
    if ((await onRun()) === true) setListOpen(true);
  };

  const handleSelect = (issue: WorkflowIssue) => {
    setListOpen(false);
    focus(issue);
  };

  return (
    // Named, so the workflow's issue chip is told apart from the steps' issue badges, which read the same.
    <ToolbarContainer role="toolbar" aria-label={t("toolbar")}>
      {/* Tools and History Group */}
      <ToolGroup>
        {/* Selection Tools */}
        <Tooltip title={t("workflow_select_tool")} placement="top">
          <ToolButton active={activeTool === "select"} onClick={() => onToolChange("select")}>
            <SelectIcon fontSize="small" />
          </ToolButton>
        </Tooltip>

        <Tooltip title={t("workflow_text_tool_hint")} placement="top">
          <ToolButton active={activeTool === "text"} onClick={() => onToolChange("text")}>
            <TextIcon fontSize="small" />
          </ToolButton>
        </Tooltip>

        <Divider />

        {/* History Controls */}
        <Tooltip title={t("undo")} placement="top">
          <span>
            <ToolButton disabled={!canUndo} onClick={onUndo}>
              <UndoIcon fontSize="small" />
            </ToolButton>
          </span>
        </Tooltip>

        <Tooltip title={t("redo")} placement="top">
          <span>
            <ToolButton disabled={!canRedo} onClick={onRedo}>
              <RedoIcon fontSize="small" />
            </ToolButton>
          </span>
        </Tooltip>

        {onVariablesClick && (
          <>
            <Divider />
            <Tooltip title={t("workflow_variables")} placement="top">
              <ToolButton onClick={onVariablesClick}>
                <VariablesIcon fontSize="small" />
              </ToolButton>
            </Tooltip>
          </>
        )}
      </ToolGroup>

      {/* Run/Stop Button - Separate for emphasis */}
      {isRunning ? (
        <StopButton
          onClick={onStop}
          startIcon={<StopIcon />}
          variant="contained"
          color="error"
          disableElevation>
          {t("stop")}
        </StopButton>
      ) : blockingCount > 0 ? (
        <Tooltip title={t("workflow_run_fix_issues", { count: blockingCount })} placement="top">
          <span>
            <RunButton disabled startIcon={<RunIcon />} variant="contained" disableElevation>
              {t("workflow_run")}
            </RunButton>
          </span>
        </Tooltip>
      ) : (
        <RunButton
          disabled={!canRun}
          onClick={() => void handleRun()}
          startIcon={<RunIcon />}
          variant="contained"
          disableElevation>
          {t("workflow_run")}
        </RunButton>
      )}

      {/* The check failed: the list may not describe the steps; a click checks again */}
      {checkFailed && (
        <Tooltip title={t("workflow_issues_check_failed")} placement="top" describeChild>
          <Chip
            variant="outlined"
            icon={<NotCheckedIcon />}
            label={t("workflow_issues_not_checked")}
            onClick={recheck}
            sx={{
              height: 40,
              borderRadius: 20,
              px: 0.5,
              fontWeight: 600,
              color: "text.secondary",
              backgroundColor: "background.paper",
              borderColor: "divider",
              boxShadow: "0 2px 8px rgba(0, 0, 0, 0.08)",
              "& .MuiChip-icon": { color: "text.secondary" },
            }}
          />
        </Tooltip>
      )}

      {/* Every issue of the workflow; opens the list */}
      {issues.length > 0 && (
        <Chip
          ref={setChipEl}
          data-tone={tone}
          variant="outlined"
          icon={<IssuesIcon />}
          label={countLabel}
          onClick={() => setListOpen((open) => !open)}
          aria-haspopup="dialog"
          aria-expanded={listOpen}
          sx={{
            height: 40,
            borderRadius: 20,
            px: 0.5,
            fontWeight: 600,
            color: toneColor,
            backgroundColor: "background.paper",
            borderColor: "divider",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.08)",
            "& .MuiChip-icon": { color: toneColor },
          }}
        />
      )}
      <Popover
        open={listOpen && chipEl !== null}
        anchorEl={chipEl}
        onClose={() => setListOpen(false)}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
        transformOrigin={{ vertical: "bottom", horizontal: "center" }}
        slotProps={{
          paper: { role: "dialog", "aria-label": countLabel, sx: { width: 360, maxHeight: 420, mt: -1 } },
        }}>
        <IssueList issues={issues} onSelect={handleSelect} />
      </Popover>
    </ToolbarContainer>
  );
};

export default CanvasToolbar;
