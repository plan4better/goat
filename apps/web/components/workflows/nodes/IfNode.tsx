"use client";

import CallSplitIcon from "@mui/icons-material/CallSplit";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import DeleteIcon from "@mui/icons-material/Delete";
import DuplicateIcon from "@mui/icons-material/ContentCopy";
import { Box, Tooltip, Typography } from "@mui/material";
import { type NodeProps, NodeToolbar, Position } from "@xyflow/react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { v4 as uuidv4 } from "uuid";

import type { AppDispatch } from "@/lib/store";
import { selectNodes } from "@/lib/store/workflow/selectors";
import { addNode, removeNodes } from "@/lib/store/workflow/slice";
import {
  IF_FALSE_HANDLE,
  IF_TRUE_HANDLE,
  type IfNodeData,
} from "@/lib/validations/workflow";

import StepIssueBadge from "@/components/workflows/issues/StepIssueBadge";
import { useStepIssues } from "@/components/workflows/issues/WorkflowIssuesContext";

import { useNodeExecutionStatus } from "../context/WorkflowExecutionContext";
import {
  AnimatedBorderWrapper,
  IconStatusBadge,
  NodeContainer,
  NodeHeader,
  NodeIconWrapper,
  StyledHandle,
  ToolbarButton,
  ToolbarContainer,
} from "./shared";

interface IfNodeProps extends NodeProps {
  data: IfNodeData;
}

const IfNode: React.FC<IfNodeProps> = ({ id, data, selected }) => {
  const { t } = useTranslation("common");
  const dispatch = useDispatch<AppDispatch>();
  const nodes = useSelector(selectNodes);

  const { status: nodeStatus } = useNodeExecutionStatus(id);
  const isCompleted = nodeStatus === "completed";
  // No incoming connection at all: the input's handle gets the amber ring.
  const inputUnconnected = useStepIssues(id).some(
    (issue) => issue.code === "if_input_count" && issue.params.count === 0
  );

  const handleDuplicate = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      dispatch(
        addNode({
          ...node,
          id: `if-${uuidv4()}`,
          position: { x: node.position.x + 50, y: node.position.y + 50 },
        })
      );
    },
    [id, nodes, dispatch]
  );

  const handleDelete = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      dispatch(removeNodes([id]));
    },
    [id, dispatch]
  );

  // The shared NodeIconWrapper only accepts pending/running/completed/failed.
  const iconStatus =
    nodeStatus === "failed" ||
    nodeStatus === "completed" ||
    nodeStatus === "running" ||
    nodeStatus === "pending"
      ? nodeStatus
      : undefined;

  const trueActive = isCompleted && data.activeHandle === IF_TRUE_HANDLE;

  return (
    <>
      <NodeToolbar position={Position.Top} align="end">
        <ToolbarContainer>
          <Tooltip title={t("duplicate")} placement="top" arrow>
            <ToolbarButton onClick={handleDuplicate}>
              <DuplicateIcon fontSize="small" />
            </ToolbarButton>
          </Tooltip>
          <Tooltip title={t("delete")} placement="top" arrow>
            <ToolbarButton onClick={handleDelete}>
              <DeleteIcon fontSize="small" color="error" />
            </ToolbarButton>
          </Tooltip>
        </ToolbarContainer>
      </NodeToolbar>

      <NodeContainer selected={selected}>
        {/* The step's issues; stays after a run, next to the run status */}
        <StepIssueBadge nodeId={id} />

        {/* Input handle — carries the layer through to the active branch */}
        <Tooltip
          title={t("if_input_handle_tooltip", {
            defaultValue: "Input layer (flows through to the active branch)",
          })}
          placement="top"
          arrow>
          <StyledHandle
            type="target"
            position={Position.Left}
            id="input"
            selected={selected}
            data-issue={inputUnconnected ? "true" : undefined}
          />
        </Tooltip>

        {/* TRUE output handle - upper-right */}
        <Tooltip title={t("true_branch", { defaultValue: "True" })} placement="right" arrow>
          <StyledHandle
            type="source"
            position={Position.Right}
            id={IF_TRUE_HANDLE}
            selected={selected}
            style={{
              top: "33%",
              ...(trueActive && { backgroundColor: undefined }),
            }}
          />
        </Tooltip>
        {/* FALSE output handle - lower-right */}
        <Tooltip title={t("false_branch", { defaultValue: "False" })} placement="right" arrow>
          <StyledHandle
            type="source"
            position={Position.Right}
            id={IF_FALSE_HANDLE}
            selected={selected}
            style={{ top: "66%" }}
          />
        </Tooltip>

        {/* Small text labels next to the right-side handles */}
        <Box
          sx={{
            position: "absolute",
            right: 12,
            top: "33%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
          }}>
          <Typography variant="caption" sx={{ fontSize: 10, color: "text.secondary" }}>
            {t("true_branch", { defaultValue: "True" })}
          </Typography>
        </Box>
        <Box
          sx={{
            position: "absolute",
            right: 12,
            top: "66%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
          }}>
          <Typography variant="caption" sx={{ fontSize: 10, color: "text.secondary" }}>
            {t("false_branch", { defaultValue: "False" })}
          </Typography>
        </Box>

        <NodeHeader>
          <AnimatedBorderWrapper isRunning={nodeStatus === "running"}>
            <NodeIconWrapper status={iconStatus}>
              <CallSplitIcon sx={{ fontSize: 28 }} />
              {nodeStatus === "completed" && (
                <IconStatusBadge status="completed">
                  <CheckCircleIcon sx={{ fontSize: 12 }} />
                </IconStatusBadge>
              )}
              {nodeStatus === "failed" && (
                <IconStatusBadge status="failed">
                  <CancelIcon sx={{ fontSize: 12 }} />
                </IconStatusBadge>
              )}
            </NodeIconWrapper>
          </AnimatedBorderWrapper>
          <Typography variant="caption" fontWeight={700} sx={{ flex: 1, wordBreak: "break-word" }}>
            {data.label || t("if_node", { defaultValue: "Conditional" })}
          </Typography>
        </NodeHeader>

        {data.error && nodeStatus === "failed" && (
          <Typography
            variant="caption"
            color="error.main"
            sx={{
              display: "block",
              mt: 0.5,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={data.error}>
            {data.error}
          </Typography>
        )}
      </NodeContainer>
    </>
  );
};

export default memo(IfNode);
