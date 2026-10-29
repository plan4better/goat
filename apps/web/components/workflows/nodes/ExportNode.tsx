"use client";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import DeleteIcon from "@mui/icons-material/Delete";
import DuplicateIcon from "@mui/icons-material/ContentCopy";
import WarningIcon from "@mui/icons-material/Warning";
import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import { type NodeProps, NodeToolbar, Position, useEdges } from "@xyflow/react";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { v4 as uuidv4 } from "uuid";

import type { AppDispatch } from "@/lib/store";
import { selectNodes } from "@/lib/store/workflow/selectors";
import { addNode, removeNodes } from "@/lib/store/workflow/slice";
import { useLayerWriteAccess } from "@/lib/api/layers";
import type { ExportNodeData } from "@/lib/validations/workflow";

import { type TOOL_ICON_NAME, toolIconMap } from "@p4b/ui/assets/svg/ToolIcons";

import { useNodeExecutionStatus } from "../context/WorkflowExecutionContext";
import {
  AnimatedBorderWrapper,
  IconStatusBadge,
  NodeContainer,
  NodeHeader,
  NodeIconWrapper,
  NodeParamsSection,
  StyledHandle,
  ToolbarButton,
  ToolbarContainer,
} from "./shared";

const ParamRow = styled(Box)({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
});

const WarningBadge = styled(Box)(({ theme }) => ({
  position: "absolute",
  bottom: -14,
  right: -8,
  width: 24,
  height: 24,
  borderRadius: "50%",
  backgroundColor: theme.palette.warning.main,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: theme.palette.warning.contrastText,
  zIndex: 1,
}));

interface ExportNodeProps extends NodeProps {
  data: ExportNodeData;
}

const ExportNode: React.FC<ExportNodeProps> = ({ id, data, selected }) => {
  const { t } = useTranslation("common");
  const dispatch = useDispatch<AppDispatch>();
  const nodes = useSelector(selectNodes);

  const edges = useEdges();
  const { status: nodeStatus_ } = useNodeExecutionStatus(id);
  const nodeStatus = nodeStatus_ || data.status;

  // "Existing dataset" needs a target dataset instead of a name
  const isExisting = data.destination === "existing";

  const missingDatasetName = !isExisting && !data.datasetName?.trim();
  const missingTarget = isExisting && !data.targetLayerId;
  // Checked before the run too: without edit rights this step fails.
  const { canWrite } = useLayerWriteAccess(isExisting ? data.targetLayerId : undefined);
  const noEditRights = isExisting && !!data.targetLayerId && canWrite === false;
  const missingConnection = !edges.some((e) => e.target === id);
  const hasWarning = missingDatasetName || missingTarget || noEditRights || missingConnection;

  const warningMessage = useMemo(() => {
    const parts: string[] = [];
    if (missingConnection) {
      parts.push(t("missing_layer_connections"));
    }
    if (missingDatasetName) {
      parts.push(t("dataset_name_required"));
    }
    if (missingTarget) {
      parts.push(t("append_target_required"));
    }
    if (noEditRights) {
      parts.push(t("append_no_edit_rights"));
    }
    return parts.join(". ");
  }, [missingConnection, missingDatasetName, missingTarget, noEditRights, t]);

  // Handle duplicate node
  const handleDuplicate = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      const node = nodes.find((n) => n.id === id);
      if (!node) return;

      dispatch(
        addNode({
          ...node,
          id: `export-${uuidv4()}`,
          position: {
            x: node.position.x + 50,
            y: node.position.y + 50,
          },
          data: {
            ...node.data,
            status: "idle",
            exportedLayerId: undefined,
            jobId: undefined,
            error: undefined,
          },
        })
      );
    },
    [id, nodes, dispatch]
  );

  // Handle delete node
  const handleDelete = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      dispatch(removeNodes([id]));
    },
    [id, dispatch]
  );

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
        {/* Warning badge for missing dataset name or connection */}
        {/* New nodes carry status "idle": not run yet, so warn as with none */}
        {hasWarning && !nodeStatus_ && (!data.status || data.status === "idle") && (
          <Tooltip title={warningMessage} arrow>
            <WarningBadge
              aria-label={
                missingDatasetName
                  ? t("dataset_name_required")
                  : missingTarget
                    ? t("append_target_required")
                    : noEditRights
                      ? t("append_no_edit_rights")
                      : warningMessage
              }>
              <WarningIcon sx={{ fontSize: 16 }} />
            </WarningBadge>
          </Tooltip>
        )}

        {/* Input handle - left (receives tool output) */}
        <StyledHandle type="target" position={Position.Left} id="input" selected={selected} />

        <NodeHeader>
          <AnimatedBorderWrapper isRunning={nodeStatus === "running"}>
            <NodeIconWrapper status={nodeStatus}>
              {(() => {
                const ExportIcon = toolIconMap["export_dataset" as TOOL_ICON_NAME];
                return <ExportIcon sx={{ fontSize: 32 }} />;
              })()}
              {/* Checkmark badge — only on completed, same as tool nodes */}
              {nodeStatus === "completed" && (
                <IconStatusBadge status="completed">
                  <CheckCircleIcon sx={{ fontSize: 12 }} />
                </IconStatusBadge>
              )}
              {/* Cross badge on icon */}
              {nodeStatus === "failed" && (
                <IconStatusBadge status="failed">
                  <CancelIcon sx={{ fontSize: 12 }} />
                </IconStatusBadge>
              )}
            </NodeIconWrapper>
          </AnimatedBorderWrapper>
          <Typography variant="caption" fontWeight={700} sx={{ flex: 1, wordBreak: "break-word" }}>
            {t("export_dataset")}
          </Typography>
        </NodeHeader>

        {/* Parameters section — same layout as ToolNode's ParamRow */}
        <NodeParamsSection>
          <Stack spacing={0.25}>
          {isExisting && data.targetLayerName && (
            <ParamRow>
              <Typography variant="caption" color="text.secondary" fontWeight="bold" sx={{ fontSize: 11 }}>
                {t("export_mode_existing")}:
              </Typography>
              <Typography variant="caption" fontWeight="medium" sx={{ fontSize: 11 }}>
                {data.targetLayerName}
              </Typography>
            </ParamRow>
          )}
          {!isExisting && data.datasetName && (
            <ParamRow>
              <Typography variant="caption" color="text.secondary" fontWeight="bold" sx={{ fontSize: 11 }}>
                {t("dataset_name")}:
              </Typography>
              <Typography variant="caption" fontWeight="medium" sx={{ fontSize: 11 }}>
                {data.datasetName}
              </Typography>
            </ParamRow>
          )}
          {data.addToProject && (
            <ParamRow>
              <Typography variant="caption" color="text.secondary" fontWeight="bold" sx={{ fontSize: 11 }}>
                {t("add_to_project")}:
              </Typography>
              <Typography variant="caption" fontWeight="medium" sx={{ fontSize: 11 }}>
                {t("yes")}
              </Typography>
            </ParamRow>
          )}
          {!isExisting && data.overwritePrevious && (
            <ParamRow>
              <Typography variant="caption" color="text.secondary" fontWeight="bold" sx={{ fontSize: 11 }}>
                {t("overwrite")}:
              </Typography>
              <Typography variant="caption" fontWeight="medium" sx={{ fontSize: 11 }}>
                {t("yes")}
              </Typography>
            </ParamRow>
          )}
          </Stack>
        </NodeParamsSection>

        {/* Error */}
        {nodeStatus === "failed" && data.error && (
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

export default memo(ExportNode);
