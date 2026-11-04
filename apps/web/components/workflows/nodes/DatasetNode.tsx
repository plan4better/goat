"use client";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import DuplicateIcon from "@mui/icons-material/ContentCopy";
import FilterIcon from "@mui/icons-material/FilterAlt";
import { Box, IconButton, Link, Stack, Tooltip, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import { Handle, type NodeProps, NodeToolbar, Position } from "@xyflow/react";
import { useParams } from "next/navigation";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { v4 as uuidv4 } from "uuid";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDatasetCollectionItems } from "@/lib/api/layers";
import { useProjectLayers } from "@/lib/api/projects";
import type { AppDispatch } from "@/lib/store";
import { selectNodes } from "@/lib/store/workflow/selectors";
import { addNode, removeNodes, selectNode } from "@/lib/store/workflow/slice";
import { createTheCQLBasedOnExpression } from "@/lib/transformers/filter";
import { currentDatasetType } from "@/lib/utils/workflowDatasets";
import type { Expression } from "@/lib/validations/filter";
import type { DatasetNodeData } from "@/lib/validations/workflow";

import useLayerFields from "@/hooks/map/CommonHooks";

import StepIssueBadge from "@/components/workflows/issues/StepIssueBadge";
import { useStepIssues } from "@/components/workflows/issues/WorkflowIssuesContext";

import { useWorkflowExecutionContext } from "../context/WorkflowExecutionContext";
import { IconStatusBadge, NodeParamsSection } from "./shared";

const NodeContainer = styled(Box, {
  shouldForwardProp: (prop) => prop !== "selected" && prop !== "needsLayer",
})<{ selected?: boolean; needsLayer?: boolean }>(({ theme, selected, needsLayer }) => ({
  padding: theme.spacing(1.5),
  borderRadius: theme.shape.borderRadius,
  backgroundColor: theme.palette.background.paper,
  border: `2px solid ${
    selected ? theme.palette.primary.main : needsLayer ? theme.palette.warning.main : theme.palette.divider
  }`,
  // Box-shadow for selection indicator (blue glow)
  boxShadow: selected
    ? `0 0 0 4px ${theme.palette.primary.main}40, 0 2px 8px rgba(0, 0, 0, 0.1)`
    : "0 2px 8px rgba(0, 0, 0, 0.08)",
  minWidth: 160,
  maxWidth: 220,
  transition: "all 0.2s ease",
  position: "relative",
  "&:hover": {
    boxShadow: selected
      ? `0 0 0 4px ${theme.palette.primary.main}40, 0 2px 8px rgba(0, 0, 0, 0.12)`
      : "0 2px 8px rgba(0, 0, 0, 0.12)",
  },
}));

const NodeHeader = styled(Box)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.spacing(1),
  marginBottom: theme.spacing(0.5),
}));

// Icon wrapper with status-based styling
const NodeIconWrapper = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isCompleted",
})<{ isCompleted?: boolean }>(({ theme, isCompleted }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 40,
  height: 40,
  minWidth: 40,
  borderRadius: theme.shape.borderRadius,
  border: `1px solid ${isCompleted ? theme.palette.primary.main : theme.palette.divider}`,
  backgroundColor: "transparent",
  position: "relative",
}));

const StyledHandle = styled(Handle, {
  shouldForwardProp: (prop) => prop !== "selected",
})<{ selected?: boolean }>(({ theme, selected }) => ({
  width: 12,
  height: 12,
  backgroundColor: selected ? theme.palette.primary.main : theme.palette.grey[500],
  border: `2px solid ${theme.palette.background.paper}`,
}));

const ToolbarContainer = styled(Stack)(({ theme }) => ({
  backgroundColor: theme.palette.background.paper,
  borderRadius: theme.shape.borderRadius * 2,
  padding: theme.spacing(1),
  gap: theme.spacing(0.5),
  flexDirection: "row",
  alignItems: "center",
  boxShadow: theme.shadows[4],
  border: `1px solid ${theme.palette.divider}`,
}));

const ToolbarButton = styled(IconButton)(({ theme }) => ({
  width: 36,
  height: 36,
  "&:hover": {
    backgroundColor: theme.palette.action.hover,
  },
}));

const InfoRow = styled(Box)({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
});

interface DatasetNodeProps extends NodeProps {
  data: DatasetNodeData;
}

const DatasetNode: React.FC<DatasetNodeProps> = ({ id, data, selected }) => {
  const { t } = useTranslation("common");
  const dispatch = useDispatch<AppDispatch>();
  const nodes = useSelector(selectNodes);
  const { projectId } = useParams() as { projectId?: string };
  // The workflow check reports a step without a layer (a template's open
  // input, or an empty step) as `layer_not_chosen`; the node keeps its
  // "Pick a layer" action for it.
  const needsLayer = useStepIssues(id).some((issue) => issue.code === "layer_not_chosen");

  // Get execution status - dataset nodes are "completed" when any execution is active
  const { isExecuting: hasAnyExecution } = useWorkflowExecutionContext();

  // Get layer fields for CQL generation
  const { layerFields } = useLayerFields(data.layerId || "", undefined);

  // Live-lookup the display name from the project layers SWR cache so layer renames
  // propagate without having to update every workflow node.
  // - Primary key: projectLayerId (set for nodes added from "from project")
  // - Fallback: match by dataset UUID (older nodes that pre-date projectLayerId)
  // - Final fallback: the snapshotted label (e.g. dataset-explorer nodes not in the project)
  const { layers: projectLayers } = useProjectLayers(projectId);
  const displayName = useMemo(() => {
    if (!data.layerId) return t("no_dataset");
    const byProjectLayerId =
      data.projectLayerId != null ? projectLayers?.find((pl) => pl.id === data.projectLayerId) : undefined;
    const byLayerId = byProjectLayerId
      ? undefined
      : projectLayers?.find((pl) => pl.layer_id === data.layerId);
    return byProjectLayerId?.name ?? byLayerId?.name ?? data.label;
  }, [data.layerId, data.projectLayerId, data.label, projectLayers, t]);

  // Build CQL filter from node's workflow filter
  const cqlFilter = useMemo(() => {
    const nodeFilter = data.filter as { op?: string; expressions?: Expression[] } | undefined;
    if (!nodeFilter || !nodeFilter.expressions || nodeFilter.expressions.length === 0) {
      return null;
    }
    try {
      return createTheCQLBasedOnExpression(
        nodeFilter.expressions,
        layerFields,
        (nodeFilter.op || "and") as "and" | "or"
      );
    } catch {
      return null;
    }
  }, [data.filter, layerFields]);

  // Check if filter is applied
  const hasFilter = useMemo(() => {
    const nodeFilter = data.filter as { op?: string; expressions?: Expression[] } | undefined;
    return nodeFilter?.expressions && nodeFilter.expressions.length > 0;
  }, [data.filter]);

  // Fetch feature count with filter applied (use limit=1 to minimize data transfer)
  const queryParams = useMemo(() => {
    const params: { limit: number; offset: number; filter?: string } = {
      limit: 1,
      offset: 0,
    };
    if (cqlFilter) {
      params.filter = JSON.stringify(cqlFilter);
    }
    return params;
  }, [cqlFilter]);

  const { data: collectionData } = useDatasetCollectionItems(data.layerId || "", queryParams);

  // Format feature count with thousands separator
  const formatCount = (count: number) => {
    return count.toLocaleString();
  };

  // Get geometry icon based on the layer's current type
  const getGeometryIcon = () => {
    switch (currentDatasetType(data, projectLayers).geometryType) {
      case "point":
        return ICON_NAME.POINT_FEATURE;
      case "line":
        return ICON_NAME.LINE_FEATURE;
      case "polygon":
        return ICON_NAME.POLYGON_FEATURE;
      default:
        return ICON_NAME.TABLE;
    }
  };

  // Handle duplicate node
  const handleDuplicate = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      const node = nodes.find((n) => n.id === id);
      if (!node) return;

      dispatch(
        addNode({
          ...node,
          id: `dataset-${uuidv4()}`,
          position: {
            x: node.position.x + 50,
            y: node.position.y + 50,
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

  // Select this node so the sidebar opens on its Dataset settings panel — the
  // same picker (from project / dataset explorer) used to fill it in normally.
  const handlePickLayer = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      dispatch(selectNode(id));
    },
    [id, dispatch]
  );

  return (
    <>
      {/* NodeToolbar - automatically shown when selected */}
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

      <NodeContainer selected={selected} needsLayer={needsLayer}>
        {/* The step's issues; stays after a run */}
        <StepIssueBadge nodeId={id} />

        {/* Output handle - right */}
        <StyledHandle type="source" position={Position.Right} selected={selected} />

        <NodeHeader>
          <NodeIconWrapper isCompleted={hasAnyExecution}>
            <Icon
              iconName={getGeometryIcon()}
              sx={{ fontSize: 32, color: hasAnyExecution ? "primary.main" : "text.secondary" }}
            />
            {/* Checkmark badge on icon */}
            {hasAnyExecution && (
              <IconStatusBadge status="completed">
                <CheckCircleIcon sx={{ fontSize: 12 }} />
              </IconStatusBadge>
            )}
          </NodeIconWrapper>
          <Typography variant="caption" fontWeight={700} sx={{ wordBreak: "break-word" }}>
            {displayName}
          </Typography>
        </NodeHeader>

        {/* Feature info - only show when layer is selected */}
        {data.layerId && collectionData && (
          <NodeParamsSection>
            <Stack spacing={0.5}>
              <InfoRow>
                <Typography variant="caption" color="text.secondary" fontWeight="bold" sx={{ fontSize: 11 }}>
                  {t("features")}:
                </Typography>
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  {hasFilter && (
                    <Tooltip title={t("filter_applied")} placement="top" arrow>
                      <FilterIcon sx={{ fontSize: 12, color: "primary.main" }} />
                    </Tooltip>
                  )}
                  <Typography variant="caption" sx={{ fontSize: 11 }}>
                    {formatCount(collectionData.numberMatched)}
                  </Typography>
                </Stack>
              </InfoRow>
            </Stack>
          </NodeParamsSection>
        )}

        {/* No layer yet: send the user to the same picker used when adding a
            dataset normally (the sidebar's Dataset settings) */}
        {needsLayer && (
          <NodeParamsSection>
            <InfoRow>
              <Typography variant="caption" color="text.secondary" fontWeight="bold" sx={{ fontSize: 11 }}>
                {t("layer")}:
              </Typography>
              <Link
                component="button"
                type="button"
                variant="caption"
                color="warning.main"
                underline="hover"
                onClick={handlePickLayer}
                sx={{ fontSize: 11, fontWeight: 600 }}>
                {t("pick_a_layer")}
              </Link>
            </InfoRow>
          </NodeParamsSection>
        )}
      </NodeContainer>
    </>
  );
};

export default memo(DatasetNode);
