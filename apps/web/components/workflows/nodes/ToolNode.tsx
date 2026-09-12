"use client";

import {
  Block as BlockIcon,
  Cancel as CancelIcon,
  CheckCircle as CheckCircleIcon,
  Delete as DeleteIcon,
  ContentCopy as DuplicateIcon,
  Settings as SettingsIcon,
  Warning as WarningIcon,
} from "@mui/icons-material";
import { Box, Chip, Stack, Tooltip, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import { type NodeProps, NodeToolbar, Position, useEdges } from "@xyflow/react";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { v4 as uuidv4 } from "uuid";

import { type TOOL_ICON_NAME, toolIconMap } from "@p4b/ui/assets/svg/ToolIcons";
import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { AppDispatch } from "@/lib/store";
import { selectNodes } from "@/lib/store/workflow/selectors";
import { addNode, removeNodes } from "@/lib/store/workflow/slice";
import {
  evaluateCondition,
  extractInputDataType,
  extractOutputDataType,
  formatDataType,
  hasOpportunityHandles,
} from "@/lib/utils/ogc-utils";
import { isDatasetNode, isToolNode, missingFieldRefs } from "@/lib/utils/workflowDatasets";
import { edgeDerivedInputHandles } from "@/lib/utils/workflowHandles";
import type { ToolNodeData } from "@/lib/validations/workflow";

import { OPPORTUNITY_LAYER_HANDLES } from "@/types/map/ogc-processes";

import { useLayerFieldNames } from "@/hooks/map/useLayerFieldNames";
import { useProcessDescription } from "@/hooks/map/useOgcProcesses";

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

/**
 * Format duration in milliseconds to human-readable string
 * e.g., 1234 -> "1.2s", 65000 -> "1m 5.0s"
 */
const formatDuration = (ms: number): string => {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(1)}s`;
};

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

interface ToolNodeProps extends NodeProps {
  data: ToolNodeData;
}

const ToolNode: React.FC<ToolNodeProps> = ({ id, data, selected }) => {
  const { t } = useTranslation("common");
  const dispatch = useDispatch<AppDispatch>();
  const nodes = useSelector(selectNodes);
  const edges = useEdges();

  // Get execution status for this specific node
  const { status: nodeStatus, info: executionInfo } = useNodeExecutionStatus(id);

  // Fetch process description to determine inputs
  const { process } = useProcessDescription(data.processId);

  // Identify layer inputs (inputs with widget: "layer-selector")
  const layerInputs = useMemo(() => {
    if (!process?.inputs) return [];

    return Object.entries(process.inputs)
      .filter(([, input]) => {
        const widget = input.schema?.["x-ui"]?.widget;
        // Include layer-selector and starting-points widgets as layer inputs
        return widget === "layer-selector" || widget === "starting-points";
      })
      .map(([name, input]) => {
        // Extract data type info from metadata
        const dataTypeInfo = extractInputDataType(input);
        return {
          name,
          title: input.title,
          section: input.schema?.["x-ui"]?.section || "input",
          required: input.minOccurs > 0,
          dataTypeInfo,
        };
      })
      .sort((a, b) => {
        // Sort by section order: input first, then overlay
        if (a.section === "input" && b.section !== "input") return -1;
        if (b.section === "input" && a.section !== "input") return 1;
        return 0;
      });
  }, [process]);

  // Get output data type info
  const outputDataType = useMemo(() => {
    if (!process?.outputs?.result) return undefined;
    return extractOutputDataType(process.outputs.result);
  }, [process]);

  // Check which inputs are missing connections
  const missingLayerInputs = useMemo(() => {
    if (layerInputs.length === 0) return [];

    // Get edges targeting this node
    const incomingEdges = edges.filter((e) => e.target === id);

    return layerInputs.filter((input) => {
      // Check if there's an edge connected to this input handle
      const isConnected = incomingEdges.some(
        (e) => e.targetHandle === input.name || (!e.targetHandle && layerInputs.length === 1)
      );
      return !isConnected && input.required;
    });
  }, [layerInputs, edges, id]);

  // Check which required config fields are missing values
  const missingConfig = useMemo(() => {
    if (!process?.inputs) return [];
    const config = data.config || {};

    const missing: { name: string; label: string }[] = [];

    for (const [name, input] of Object.entries(process.inputs)) {
      const uiMeta = input.schema?.["x-ui"];

      // Skip hidden fields and layer-related inputs
      if (uiMeta?.hidden) continue;
      if (uiMeta?.widget === "layer-selector") continue;
      if (uiMeta?.widget === "layer-name-input") continue;
      if (uiMeta?.widget === "starting-points") continue;
      if (uiMeta?.section === "output") continue;
      if (uiMeta?.section === "result") continue;
      if (uiMeta?.section === "starting") continue;
      if (uiMeta?.section === "opportunities") continue;

      // Check visible_when - skip if not visible
      if (uiMeta?.visible_when && !evaluateCondition(uiMeta.visible_when, config)) {
        continue;
      }
      // Check hidden_when - skip if hidden
      if (uiMeta?.hidden_when && evaluateCondition(uiMeta.hidden_when, config)) {
        continue;
      }

      // Check if required and missing
      const isRequired = input.minOccurs > 0;
      const value = config[name];
      const isEmpty =
        value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

      if (isRequired && isEmpty) {
        const label = uiMeta?.label ? t(uiMeta.label) : input.title;
        missing.push({ name, label });
      }
    }

    return missing;
  }, [process, data.config, t]);

  // For tools taking opportunity layers from numbered canvas handles, check
  // that at least one is connected.
  const takesOpportunityHandles = hasOpportunityHandles(process);
  const missingOpportunities = useMemo(() => {
    if (!takesOpportunityHandles) return false;
    const incomingEdges = edges.filter((e) => e.target === id);
    return !incomingEdges.some((e) => e.targetHandle && OPPORTUNITY_LAYER_HANDLES.includes(e.targetHandle));
  }, [takesOpportunityHandles, edges, id]);

  // Field names this tool's config points at must exist on the dataset
  // wired into the matching input; a dataset swapped for another layer is
  // what usually breaks this, so the node keeps flagging it until fixed.
  const upstreamLayerIds = useMemo(
    () =>
      edges
        .filter((e) => e.target === id)
        .map((e) => nodes.find((n) => n.id === e.source))
        .flatMap((n) => {
          const layerId = n && isDatasetNode(n) ? n.data.layerId : undefined;
          return layerId ? [layerId] : [];
        }),
    [edges, id, nodes]
  );
  const { fieldsByLayerId } = useLayerFieldNames(upstreamLayerIds);
  const missingFields = useMemo(() => {
    const self = nodes.find((n) => n.id === id);
    if (!self || !isToolNode(self)) return [];
    return missingFieldRefs(self, process, edges, nodes, fieldsByLayerId);
  }, [nodes, id, process, edges, fieldsByLayerId]);

  const hasWarning =
    missingLayerInputs.length > 0 ||
    missingConfig.length > 0 ||
    missingOpportunities ||
    missingFields.length > 0;

  // Get display parameters (non-layer, non-hidden parameters with values)
  const displayParams = useMemo(() => {
    if (!process?.inputs || !data.config) return [];

    const params: { name: string; label: string; value: string }[] = [];
    const seenLabels = new Set<string>(); // Track seen labels to avoid duplicates

    for (const [name, input] of Object.entries(process.inputs)) {
      const uiMeta = input.schema?.["x-ui"];

      // Skip hidden fields
      if (uiMeta?.hidden) continue;

      // Skip layer-related widgets
      if (uiMeta?.widget === "layer-selector") continue;
      if (uiMeta?.widget === "layer-name-input") continue;
      if (uiMeta?.widget === "starting-points") continue;
      if (typeof uiMeta?.widget === "string" && uiMeta.widget.includes("layer")) continue;

      // Skip layer-related sections
      if (uiMeta?.section === "output") continue;
      if (uiMeta?.section === "result") continue;
      if (uiMeta?.section === "starting") continue;
      if (uiMeta?.section === "opportunities") continue;

      // Skip inputs with layer-related keywords or opportunities
      const keywords = (input.schema as { keywords?: string[] })?.keywords;
      if (
        keywords?.some((k) => {
          const lower = k.toLowerCase();
          return lower.includes("layer") || lower.includes("opportunit");
        })
      )
        continue;

      // Skip fields named with layer/opportunity patterns
      const nameLower = name.toLowerCase();
      if (nameLower.includes("layer") || nameLower.includes("opportunit")) continue;

      // Check visible_when condition - only show if condition is met
      if (uiMeta?.visible_when && !evaluateCondition(uiMeta.visible_when, data.config)) {
        continue;
      }

      // Check hidden_when condition - hide if condition is met
      if (uiMeta?.hidden_when && evaluateCondition(uiMeta.hidden_when, data.config)) {
        continue;
      }

      // Get value from config
      const value = data.config[name];
      if (value === undefined || value === null || value === "") continue;

      // Get label for this input
      const label = uiMeta?.label ? t(uiMeta.label) : input.title;

      // Skip if we've already seen this label (mutually exclusive fields)
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);

      // Format the value for display
      let displayValue: string;
      if (typeof value === "boolean") {
        displayValue = value ? t("enabled") : t("disabled");
      } else if (Array.isArray(value)) {
        if (value.length === 0) continue; // Skip empty arrays
        // For arrays, join and truncate if too long
        const joined = value
          .map((v) => {
            // Translate enum labels for array items if available
            const enumLabels = uiMeta?.enum_labels as Record<string, string> | undefined;
            if (enumLabels && enumLabels[String(v)]) {
              return t(enumLabels[String(v)], { defaultValue: enumLabels[String(v)] });
            }
            return String(v);
          })
          .join(", ");
        displayValue = joined.length > 40 ? `${joined.substring(0, 37)}...` : joined;
      } else if (typeof value === "object") {
        continue; // Skip complex objects
      } else {
        // Check for enum labels
        const enumLabels = uiMeta?.enum_labels as Record<string, string> | undefined;
        if (enumLabels && enumLabels[String(value)]) {
          displayValue = t(enumLabels[String(value)], { defaultValue: enumLabels[String(value)] });
        } else {
          displayValue = String(value);
        }
      }

      // Truncate long values
      if (displayValue.length > 40) {
        displayValue = `${displayValue.substring(0, 37)}...`;
      }

      params.push({
        name,
        label,
        value: displayValue,
      });
    }

    // Limit to first 5 parameters to avoid huge nodes
    return params.slice(0, 5);
  }, [process, data.config, t]);

  // Handle duplicate node
  const handleDuplicate = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      const node = nodes.find((n) => n.id === id);
      if (!node) return;

      dispatch(
        addNode({
          ...node,
          id: `tool-${uuidv4()}`,
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

  // Get expected input handles from incoming edges (for when process hasn't loaded yet)
  const edgeDerivedHandles = useMemo(() => edgeDerivedInputHandles(edges, id), [edges, id]);

  // Combine layer inputs with edge-derived handles for rendering
  // This ensures handles exist even before process description loads
  const effectiveInputHandles = useMemo(() => {
    if (layerInputs.length > 0) {
      return layerInputs;
    }
    // If no process loaded yet, create placeholder handles from edges
    if (edgeDerivedHandles.length > 0) {
      return edgeDerivedHandles.map((name) => ({
        name,
        title: name,
        section: "input" as const,
        required: true,
        dataTypeInfo: undefined,
      }));
    }
    return [];
  }, [layerInputs, edgeDerivedHandles]);

  // Calculate handle positions for multiple inputs
  const inputHandleCount = effectiveInputHandles.length || 1; // Default to 1 if no process loaded yet

  // Warning message for tooltip - combine missing layers and missing config
  const warningMessage = useMemo(() => {
    const parts: string[] = [];

    if (missingLayerInputs.length > 0) {
      parts.push(
        t("missing_layer_connections") + ": " + missingLayerInputs.map((input) => input.title).join(", ")
      );
    }

    if (missingConfig.length > 0) {
      parts.push(t("missing_required_config") + ": " + missingConfig.map((c) => c.label).join(", "));
    }

    if (missingOpportunities) {
      parts.push(t("missing_layer_connections") + ": " + t("opportunities"));
    }

    if (missingFields.length > 0) {
      parts.push(
        t("fields_not_in_input_layer") +
          ": " +
          missingFields.map((m) => `${m.field} (${m.paramLabel})`).join(", ")
      );
    }

    return parts.join(". ");
  }, [missingLayerInputs, missingConfig, missingOpportunities, missingFields, t]);

  const ToolIconComponent = toolIconMap[data.processId as TOOL_ICON_NAME];

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

      <NodeContainer selected={selected}>
        {/* Warning badge for missing inputs/config */}
        {hasWarning && !nodeStatus && (
          <Tooltip title={warningMessage} arrow>
            <WarningBadge>
              <WarningIcon sx={{ fontSize: 16 }} />
            </WarningBadge>
          </Tooltip>
        )}

        {/* Input handles - positioned vertically based on count */}
        {inputHandleCount === 1 ? (
          <Tooltip
            title={
              effectiveInputHandles[0]
                ? `${effectiveInputHandles[0].title}${effectiveInputHandles[0].dataTypeInfo ? ` (${formatDataType(effectiveInputHandles[0].dataTypeInfo)})` : ""}`
                : ""
            }
            placement="top"
            arrow>
            <StyledHandle
              type="target"
              position={Position.Left}
              id={effectiveInputHandles[0]?.name || "input"}
              selected={selected}
            />
          </Tooltip>
        ) : (
          effectiveInputHandles.map((input, index) => (
            <Tooltip
              key={input.name}
              title={`${input.title}${input.dataTypeInfo ? ` (${formatDataType(input.dataTypeInfo)})` : ""}`}
              placement="top"
              arrow>
              <StyledHandle
                type="target"
                position={Position.Left}
                id={input.name}
                selected={selected}
                style={{
                  top: `${((index + 1) / (inputHandleCount + 1)) * 100}%`,
                }}
              />
            </Tooltip>
          ))
        )}

        {/* Output handle - right */}
        <Tooltip
          title={`${t("output")} (${outputDataType ? formatDataType(outputDataType) : "any"})`}
          placement="top"
          arrow>
          <StyledHandle type="source" position={Position.Right} id="output" selected={selected} />
        </Tooltip>

        <NodeHeader>
          <AnimatedBorderWrapper isRunning={nodeStatus === "running"}>
            <NodeIconWrapper status={nodeStatus}>
              {ToolIconComponent ? (
                <ToolIconComponent sx={{ fontSize: 32 }} />
              ) : (
                <SettingsIcon
                  sx={{
                    fontSize: 32,
                    color:
                      nodeStatus === "completed"
                        ? "primary.main"
                        : nodeStatus === "failed"
                          ? "error.main"
                          : nodeStatus === "running"
                            ? "warning.main"
                            : "inherit",
                  }}
                />
              )}
              {/* Checkmark badge on icon */}
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
              {/* Block badge on icon */}
              {nodeStatus === "skipped" && (
                <IconStatusBadge status="skipped">
                  <BlockIcon sx={{ fontSize: 12 }} />
                </IconStatusBadge>
              )}
            </NodeIconWrapper>
          </AnimatedBorderWrapper>
          <Typography variant="caption" fontWeight={700} sx={{ flex: 1, wordBreak: "break-word" }}>
            {process?.title || t(data.processId, { defaultValue: data.label })}
          </Typography>
          {/* Duration chip - shown when completed */}
          {nodeStatus === "completed" && executionInfo?.durationMs && (
            <Chip
              label={formatDuration(executionInfo.durationMs)}
              size="small"
              color="primary"
              sx={{
                height: 20,
                fontSize: "0.7rem",
                fontWeight: "bold",
                ml: 1,
                "& .MuiChip-label": {
                  px: 1,
                },
              }}
            />
          )}
        </NodeHeader>

        {/* Show configured parameters */}
        {displayParams.length > 0 && (
          <NodeParamsSection>
            <Stack spacing={0.25}>
              {displayParams.map((param) => (
                <ParamRow key={param.name}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    fontWeight="bold"
                    sx={{
                      fontSize: 11,
                      flexShrink: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={param.label}>
                    {param.label}:
                  </Typography>
                  <Typography
                    variant="caption"
                    fontWeight="medium"
                    sx={{
                      fontSize: 11,
                      flexShrink: 0,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                    }}
                    title={param.value}>
                    {param.value}
                  </Typography>
                </ParamRow>
              ))}
            </Stack>
          </NodeParamsSection>
        )}

        {/* Show error message if failed */}
        {data.status === "error" && data.error && (
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

        {/* Show job ID when running or completed */}
        {data.jobId && (data.status === "running" || data.status === "completed") && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.5 }}>
            <Icon iconName={ICON_NAME.CIRCLEINFO} sx={{ fontSize: 10, opacity: 0.5 }} />
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 9, opacity: 0.7 }} noWrap>
              Job: {data.jobId.substring(0, 8)}...
            </Typography>
          </Box>
        )}
      </NodeContainer>
    </>
  );
};

export default memo(ToolNode);
