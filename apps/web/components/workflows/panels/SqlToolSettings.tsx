"use client";

/**
 * Custom SQL Tool Settings Panel
 *
 * Shown when a tool node has processId === "custom_sql".
 * Provides:
 * - Connected inputs display (auto-detected from edges)
 * - Additional layer selection (from project / my datasets / catalog)
 * - SQL editor via FormulaBuilder in SQL mode
 * - Output name
 */
import {
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { useEdges } from "@xyflow/react";
import { formatDistance } from "date-fns";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { apiRequestAuth } from "@/lib/api/fetcher";
import { useLayerQueryables } from "@/lib/api/layers";
import { predictNodeSchema, useTempLayerFeatures, useWorkflowMetadata } from "@/lib/api/workflows";
import type { InputSchemaInfo } from "@/lib/api/workflows";
import { GEOAPI_BASE_URL } from "@/lib/constants";
import type { AppDispatch, RootState } from "@/lib/store";
import {
  selectActiveDataPanelView,
  selectNodes,
  selectSelectedWorkflowId,
  selectVariables,
} from "@/lib/store/workflow/selectors";
import { requestMapView, requestTableView, updateNode } from "@/lib/store/workflow/slice";
import { sqlInputsByHandle } from "@/lib/utils/workflowHandles";
import type { ContentItem } from "@/lib/validations/content";
import type { WorkflowNode } from "@/lib/validations/workflow";

import type { SelectorItem } from "@/types/map/common";

import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";

import DatasetPickerDialog from "@/components/addLayer/DatasetPickerDialog";
import Container from "@/components/map/panels/Container";
import Selector from "@/components/map/panels/common/Selector";
import ToolsHeader from "@/components/map/panels/common/ToolsHeader";
import StepIssuesSummary from "@/components/workflows/issues/StepIssuesSummary";
import { useStepIssues } from "@/components/workflows/issues/WorkflowIssuesContext";
import { useStepFieldFocus } from "@/hooks/workflows/useStepFieldFocus";
import type { FormulaField, SqlTable } from "@/components/modals/FormulaBuilder";
import { useWorkflowExecutionContext } from "@/components/workflows/context/WorkflowExecutionContext";
import SaveDatasetDialog from "@/components/workflows/dialogs/SaveDatasetDialog";

const FormulaBuilder = dynamic(() => import("@/components/modals/FormulaBuilder"), { ssr: false });

const EMPTY_FIELDS: FormulaField[] = [];

interface AdditionalLayer {
  layerId: string; // layer UUID
  alias: string;
  layerName: string;
}

interface SqlToolConfig {
  sql_query?: string;
  additional_layers?: AdditionalLayer[];
  result_layer_name?: string;
}

interface SqlToolSettingsProps {
  node: WorkflowNode;
  onBack: () => void;
}

// Dataset source type enum (same as DatasetNodeSettings)
enum LayerSourceType {
  FromProject = "from_project",
  MyDatasets = "my_datasets",
}

/**
 * Hook to get queryable fields for a layer UUID.
 * Returns fields compatible with FormulaField interface.
 * Does NOT filter out id/layer_id — SQL queries need access to all columns.
 */
function useLayerFieldsForSql(layerUuid: string | undefined) {
  // Skip queryables fetch for temp layer references (they use predicted/metadata columns)
  const queryableUuid = layerUuid && !layerUuid.startsWith("temp:") ? layerUuid : "";
  const { queryables, isLoading } = useLayerQueryables(queryableUuid);

  const fields: FormulaField[] = useMemo(() => {
    if (!queryables || !layerUuid) return [];

    return Object.entries(queryables.properties).map(([key, value]) => ({
      name: key,
      type:
        value.type === "integer"
          ? "BIGINT"
          : value.type === "number"
            ? "DOUBLE"
            : value.type === "boolean"
              ? "BOOLEAN"
              : value.type === "geometry"
                ? "GEOMETRY"
                : "VARCHAR",
    }));
  }, [queryables, layerUuid]);

  return { fields, isLoading };
}

/**
 * Convert workflow metadata columns (Record<string, string>) to FormulaField[].
 */
function metadataColumnsToFields(columns: Record<string, string>): FormulaField[] {
  return Object.entries(columns).map(([name, type]) => ({ name, type }));
}

/**
 * Fetch a layer's columns directly from the OGC queryables API.
 * Returns DuckDB-compatible type names. Falls back to empty on error.
 */
async function fetchLayerColumns(layerUuid: string): Promise<Record<string, string>> {
  try {
    const response = await apiRequestAuth(`${GEOAPI_BASE_URL}/collections/${layerUuid}/queryables`);
    if (!response.ok) return {};
    const data = await response.json();
    const columns: Record<string, string> = {};
    for (const [key, value] of Object.entries(data.properties || {})) {
      const prop = value as { type?: string };
      columns[key] =
        prop.type === "integer"
          ? "BIGINT"
          : prop.type === "number"
            ? "DOUBLE"
            : prop.type === "boolean"
              ? "BOOLEAN"
              : prop.type === "geometry"
                ? "GEOMETRY"
                : "VARCHAR";
    }
    return columns;
  } catch {
    return {};
  }
}

export default function SqlToolSettings({ node, onBack }: SqlToolSettingsProps) {
  const { t } = useTranslation("common");
  const stepIssues = useStepIssues(node.id);
  const settingsRef = useStepFieldFocus(node.id);
  const theme = useTheme();
  const dispatch = useDispatch<AppDispatch>();
  const { projectId } = useParams();

  const edges = useEdges();
  const nodes = useSelector((state: RootState) => selectNodes(state));
  const workflowId = useSelector(selectSelectedWorkflowId);
  const workflowVariables = useSelector(selectVariables);
  const { metadata: workflowMetadata } = useWorkflowMetadata(workflowId ?? undefined);
  const { nodeStatuses, nodeExecutionInfo, tempLayerIds, onSaveNode } = useWorkflowExecutionContext();
  const nodeStatus = nodeStatuses[node.id];
  const executionInfo = nodeExecutionInfo[node.id];
  const tempLayerId = tempLayerIds[node.id];
  const hasTempResult = !!tempLayerId;
  const activeDataPanelView = useSelector(selectActiveDataPanelView);
  const dateLocale = useDateFnsLocale();

  // Parse temp layer ID to extract layer UUID
  const tempLayerUuid = useMemo(() => {
    if (!tempLayerId) return undefined;
    const parts = tempLayerId.split(":");
    return parts.length === 3 ? parts[2] : undefined;
  }, [tempLayerId]);

  // Fetch temp layer data for metadata
  const { data: tempLayerData } = useTempLayerFeatures(hasTempResult ? tempLayerUuid : undefined, {
    limit: 1,
  });

  // Derive metadata from temp layer response
  const tempLayerMetadata = useMemo(() => {
    if (!tempLayerData) return null;
    const featureCount = tempLayerData.numberMatched ?? tempLayerData.features?.length ?? 0;
    const geometryTypes = new Set<string>();
    if (tempLayerData.features?.length) {
      const feature = tempLayerData.features[0] as { geometry?: { type?: string } };
      if (feature?.geometry?.type) {
        geometryTypes.add(feature.geometry.type);
      }
    }
    return { featureCount, geometryTypes: Array.from(geometryTypes) };
  }, [tempLayerData]);

  const { layers: projectLayers } = useFilteredProjectLayers(projectId as string);

  // Get config from node data
  const config = (node.data.type === "tool" ? node.data.config : {}) as SqlToolConfig;
  const [sqlQuery, setSqlQuery] = useState(config.sql_query || "");
  const [additionalLayers, setAdditionalLayers] = useState<AdditionalLayer[]>(config.additional_layers || []);
  const [resultLayerName, setResultLayerName] = useState(config.result_layer_name || t("custom_sql"));

  // Formula builder dialog state
  const [formulaBuilderOpen, setFormulaBuilderOpen] = useState(false);

  // Save dataset dialog state
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Handle save dataset
  const handleSaveDataset = useCallback(
    async (name: string) => {
      if (!onSaveNode) {
        toast.error(t("save_failed"));
        return;
      }
      setIsSaving(true);
      try {
        await onSaveNode(node.id, name);
      } catch (error) {
        console.error("Failed to save layer:", error);
        toast.error(t("layer_save_failed"));
        throw error;
      } finally {
        setIsSaving(false);
      }
    },
    [onSaveNode, node.id, t]
  );

  // Layer source menu state (for adding additional layers)
  const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(menuAnchorEl);

  // Modal states
  const [myDatasetsOpen, setMyDatasetsOpen] = useState(false);

  // "From project" selector state
  const [showProjectSelector, setShowProjectSelector] = useState(false);

  // Reset when node changes
  useEffect(() => {
    const cfg = (node.data.type === "tool" ? node.data.config : {}) as SqlToolConfig;
    setSqlQuery(cfg.sql_query || "");
    setAdditionalLayers(cfg.additional_layers || []);
    setResultLayerName(cfg.result_layer_name || t("custom_sql"));
  }, [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect connected inputs
  const connectedInputs = useMemo(() => {
    const incomingEdges = edges.filter((e) => e.target === node.id);
    const inputs: Array<{
      handleName: string;
      alias: string;
      sourceNodeId: string | undefined;
      sourceNode: WorkflowNode | undefined;
      layerUuid: string | undefined;
      layerName: string;
    }> = [];

    // One entry per handle, under the aliases the runner registers (sqlInputsByHandle).
    for (const { handle: handleName, edge, alias } of sqlInputsByHandle(incomingEdges)) {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      const sourceData = sourceNode?.data as Record<string, unknown> | undefined;

      let layerUuid: string | undefined;
      // Use result_layer_name for tool nodes, fall back to translated processId or label
      let layerName = `Input ${alias.slice("input_".length)}`;
      if (sourceData?.type === "tool") {
        const toolConfig = sourceData.config as Record<string, unknown> | undefined;
        layerName =
          (toolConfig?.result_layer_name as string) ||
          t(sourceData.processId as string, { defaultValue: sourceData.label as string }) ||
          layerName;
      } else if (sourceData?.label) {
        layerName = sourceData.label as string;
      }

      if (sourceData?.type === "dataset" && sourceData.layerId) {
        const layerIdValue = sourceData.layerId as string;
        const isUUID = layerIdValue.includes("-") && layerIdValue.length > 20;
        if (isUUID) {
          layerUuid = layerIdValue;
        } else {
          const numId = parseInt(layerIdValue, 10);
          const pl = projectLayers?.find((l) => l.id === numId);
          layerUuid = pl?.layer_id;
          layerName = pl?.name || layerName;
        }
      }

      // For tool source nodes with temp results, use the temp file UUID for preview
      if (!layerUuid && sourceNode?.id && tempLayerIds[sourceNode.id]) {
        const tempId = tempLayerIds[sourceNode.id];
        const parts = tempId.split(":");
        // temp_layer_id format: "workflow_id:node_id:layer_uuid"
        if (parts.length >= 3) {
          layerUuid = `temp:${parts[2]}`;
        }
      }

      inputs.push({
        handleName,
        alias,
        sourceNodeId: sourceNode?.id,
        sourceNode: sourceNode as WorkflowNode | undefined,
        layerUuid,
        layerName,
      });
    }

    return inputs;
  }, [edges, node.id, nodes, projectLayers, tempLayerIds]);

  // Fetch fields for each connected input
  const input1Fields = useLayerFieldsForSql(connectedInputs[0]?.layerUuid);
  const input2Fields = useLayerFieldsForSql(connectedInputs[1]?.layerUuid);
  const input3Fields = useLayerFieldsForSql(connectedInputs[2]?.layerUuid);

  // Fetch fields for additional layers (up to 2)
  const addl0Uuid = additionalLayers[0]?.layerId;
  const addl1Uuid = additionalLayers[1]?.layerId;

  const addl0Fields = useLayerFieldsForSql(addl0Uuid);
  const addl1Fields = useLayerFieldsForSql(addl1Uuid);

  // Predicted columns for tool source nodes (keyed by source node ID)
  const [predictedColumns, setPredictedColumns] = useState<Record<string, Record<string, string>>>({});
  const predictionFetchedRef = useRef<string>("");

  // Stable key for connected inputs to avoid redundant fetches.
  // Includes source node config so predictions re-trigger when upstream SQL changes.
  const connectedInputsKey = useMemo(() => {
    return connectedInputs
      .map((ci) => {
        const base = `${ci.sourceNodeId || ""}:${ci.sourceNode?.data?.type || ""}`;
        // For tool source nodes, include config hash so we re-predict when upstream changes
        if (ci.sourceNode?.data?.type === "tool") {
          const config = (ci.sourceNode.data as Record<string, unknown>).config as
            | Record<string, unknown>
            | undefined;
          const sqlQuery = config?.sql_query as string | undefined;
          return `${base}:${sqlQuery || ""}`;
        }
        return base;
      })
      .join("|");
  }, [connectedInputs]);

  // Predict output schema for connected tool source nodes.
  // Uses recursive graph traversal: walks backward through edges until
  // reaching dataset nodes, predicting each tool's output along the way.
  useEffect(() => {
    if (!workflowId || connectedInputs.length === 0) return;

    const fetchKey = `${workflowId}:${connectedInputsKey}`;
    if (fetchKey === predictionFetchedRef.current) return;

    // Recursively resolve a node's output columns.
    // cache: avoids redundant API calls for the same node.
    // visited: prevents infinite loops in cyclic graphs.
    const resolveNodeColumns = async (
      nodeId: string,
      cache: Record<string, Record<string, string>>,
      visited: Set<string>
    ): Promise<Record<string, string>> => {
      if (visited.has(nodeId)) return {};
      visited.add(nodeId);
      if (cache[nodeId]) return cache[nodeId];

      // Check execution metadata first
      if (workflowMetadata?.nodes[nodeId]?.columns) {
        const cols = workflowMetadata.nodes[nodeId].columns!;
        cache[nodeId] = cols;
        return cols;
      }

      const targetNode = nodes.find((n) => n.id === nodeId);
      if (!targetNode) return {};
      const targetData = targetNode.data as Record<string, unknown>;

      // Dataset node: fetch columns from queryables API
      if (targetData?.type === "dataset" && targetData.layerId) {
        const layerIdValue = targetData.layerId as string;
        let layerUuid = layerIdValue;
        if (!layerIdValue.includes("-") || layerIdValue.length <= 20) {
          const numericId = parseInt(layerIdValue, 10);
          if (!isNaN(numericId)) {
            const pl = projectLayers?.find((l) => l.id === numericId);
            if (pl) layerUuid = pl.layer_id;
            else return {};
          }
        }
        const cols = await fetchLayerColumns(layerUuid);
        cache[nodeId] = cols;
        return cols;
      }

      // Tool node: recursively resolve input schemas, then predict output
      if (targetData?.type === "tool") {
        const processId = targetData.processId as string;
        const config = (targetData.config || {}) as Record<string, unknown>;
        const inputSchemas: Record<string, InputSchemaInfo> = {};
        const incomingEdges = edges.filter((e) => e.target === nodeId);

        for (const edge of incomingEdges) {
          const inputName = edge.targetHandle || "input_layer_id";
          const sourceColumns = await resolveNodeColumns(edge.source, cache, visited);
          if (Object.keys(sourceColumns).length > 0) {
            inputSchemas[inputName] = { columns: sourceColumns };
          }
        }

        try {
          const predicted = await predictNodeSchema(workflowId, {
            process_id: processId,
            input_schemas: inputSchemas,
            params: config,
          });
          if (predicted.columns && Object.keys(predicted.columns).length > 0) {
            cache[nodeId] = predicted.columns;
            return predicted.columns;
          }
        } catch (error) {
          console.warn(`Failed to predict schema for ${processId}:`, error);
        }
      }

      return {};
    };

    const fetchPredictions = async () => {
      const newPredicted: Record<string, Record<string, string>> = {};
      const cache: Record<string, Record<string, string>> = {};

      for (const input of connectedInputs) {
        if (!input.sourceNode || !input.sourceNodeId) continue;
        if (workflowMetadata?.nodes[input.sourceNodeId]?.columns) continue;
        if (input.sourceNode.data?.type !== "tool") continue;

        const cols = await resolveNodeColumns(input.sourceNodeId, cache, new Set());
        if (Object.keys(cols).length > 0) {
          newPredicted[input.sourceNodeId] = cols;
        }
      }

      if (Object.keys(newPredicted).length > 0) {
        setPredictedColumns((prev) => ({ ...prev, ...newPredicted }));
      }
      predictionFetchedRef.current = fetchKey;
    };

    fetchPredictions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, connectedInputsKey]);

  // Get fields for a connected input — prefer metadata, then predicted, then queryables
  const getInputFields = useCallback(
    (inputIdx: number, queryableFields: FormulaField[]): FormulaField[] => {
      const input = connectedInputs[inputIdx];
      if (!input) return [];

      // Priority 1: Workflow metadata (from already-executed source node)
      if (input.sourceNodeId && workflowMetadata?.nodes[input.sourceNodeId]?.columns) {
        return metadataColumnsToFields(workflowMetadata.nodes[input.sourceNodeId].columns!);
      }

      // Priority 2: Predicted columns (from predictNodeSchema for tool source nodes)
      if (input.sourceNodeId && predictedColumns[input.sourceNodeId]) {
        return metadataColumnsToFields(predictedColumns[input.sourceNodeId]);
      }

      // Priority 3: Queryables (from dataset layer UUID)
      if (queryableFields.length > 0) {
        return queryableFields;
      }

      return [];
    },
    [connectedInputs, workflowMetadata, predictedColumns]
  );

  // Build SqlTable[] for FormulaBuilder
  const sqlTables: SqlTable[] = useMemo(() => {
    const tables: SqlTable[] = [];
    const inputFieldSets = [input1Fields.fields, input2Fields.fields, input3Fields.fields];

    // Connected inputs
    for (let i = 0; i < connectedInputs.length && i < 3; i++) {
      tables.push({
        alias: `input_${i + 1}`,
        fields: getInputFields(i, inputFieldSets[i]),
        layerName: connectedInputs[i].layerName,
        layerId: connectedInputs[i].layerUuid,
      });
    }

    // Additional layers
    const addlFieldSets = [addl0Fields.fields, addl1Fields.fields];
    for (let i = 0; i < additionalLayers.length && i < 2; i++) {
      const uuid = i === 0 ? addl0Uuid : addl1Uuid;
      if (uuid) {
        tables.push({
          alias: additionalLayers[i].alias,
          fields: addlFieldSets[i],
          layerName: additionalLayers[i].layerName,
          layerId: uuid,
        });
      }
    }

    return tables;
  }, [
    connectedInputs,
    getInputFields,
    input1Fields.fields,
    input2Fields.fields,
    input3Fields.fields,
    additionalLayers,
    addl0Uuid,
    addl1Uuid,
    addl0Fields.fields,
    addl1Fields.fields,
  ]);

  // Save config to node data
  const saveConfig = useCallback(
    (updates: Partial<SqlToolConfig>) => {
      const newConfig = {
        ...config,
        ...updates,
      };

      // Auto-set connected input layer IDs
      if (connectedInputs[0]?.layerUuid) {
        (newConfig as Record<string, unknown>).input_layer_1_id = connectedInputs[0].layerUuid;
      }
      if (connectedInputs[1]?.layerUuid) {
        (newConfig as Record<string, unknown>).input_layer_2_id = connectedInputs[1].layerUuid;
      }
      if (connectedInputs[2]?.layerUuid) {
        (newConfig as Record<string, unknown>).input_layer_3_id = connectedInputs[2].layerUuid;
      }

      dispatch(
        updateNode({
          id: node.id,
          changes: {
            data: {
              ...node.data,
              config: newConfig,
            },
          },
        })
      );
    },
    [config, connectedInputs, dispatch, node]
  );

  // Handle SQL apply from FormulaBuilder
  const handleSqlApply = useCallback(
    (sql: string) => {
      setSqlQuery(sql);
      saveConfig({ sql_query: sql });
    },
    [saveConfig]
  );

  // Handle result layer name change
  const handleResultNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setResultLayerName(e.target.value);
      saveConfig({ result_layer_name: e.target.value });
    },
    [saveConfig]
  );

  // --- Additional Layer management ---

  const addAdditionalLayer = useCallback(
    (layerId: string, layerName: string) => {
      if (additionalLayers.length >= 2) return;
      const idx = additionalLayers.length + 1;
      const newLayer: AdditionalLayer = {
        layerId,
        alias: `extra_${idx}`,
        layerName,
      };
      const newLayers = [...additionalLayers, newLayer];
      setAdditionalLayers(newLayers);
      saveConfig({ additional_layers: newLayers });
    },
    [additionalLayers, saveConfig]
  );

  const handleRemoveLayer = useCallback(
    (index: number) => {
      const newLayers = additionalLayers.filter((_, i) => i !== index);
      setAdditionalLayers(newLayers);
      saveConfig({ additional_layers: newLayers });
    },
    [additionalLayers, saveConfig]
  );

  const handleUpdateAlias = useCallback(
    (index: number, alias: string) => {
      const newLayers = [...additionalLayers];
      newLayers[index] = { ...newLayers[index], alias };
      setAdditionalLayers(newLayers);
      saveConfig({ additional_layers: newLayers });
    },
    [additionalLayers, saveConfig]
  );

  // Menu items for "Add Layer" dropdown (same pattern as DatasetNodeSettings)
  const menuItems = [
    { type: LayerSourceType.FromProject, icon: ICON_NAME.LAYERS, label: t("from_project") },
    { type: LayerSourceType.MyDatasets, icon: ICON_NAME.DATABASE, label: t("my_datasets") },
  ];

  const handleMenuOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    setMenuAnchorEl(event.currentTarget);
  };

  const handleMenuClose = () => {
    setMenuAnchorEl(null);
  };

  const handleMenuItemClick = (type: LayerSourceType) => {
    handleMenuClose();
    switch (type) {
      case LayerSourceType.FromProject:
        setShowProjectSelector(true);
        break;
      case LayerSourceType.MyDatasets:
        setMyDatasetsOpen(true);
        break;
    }
  };

  // Handle layer selection from "From project" Selector
  const handleProjectLayerSelect = useCallback(
    (item: SelectorItem | SelectorItem[] | undefined) => {
      if (!item || Array.isArray(item)) return;

      const layer = projectLayers?.find((l) => String(l.id) === item.value);
      if (!layer) return;

      addAdditionalLayer(layer.layer_id, layer.name);
      setShowProjectSelector(false);
    },
    [projectLayers, addAdditionalLayer]
  );

  // Handle dataset selection from the dataset shelf
  const handleMyDatasetsPick = useCallback(
    (item: ContentItem) => {
      // A bundle is a set of layers, not a table the SQL tool can join.
      if (item.type !== "layer") return;
      addAdditionalLayer(item.id, item.name);
    },
    [addAdditionalLayer]
  );

  // Convert project layers to selector items
  const layerSelectorItems: SelectorItem[] = useMemo(() => {
    if (!projectLayers) return [];
    return projectLayers.map((layer) => ({
      value: String(layer.id),
      label: layer.name,
      icon:
        layer.feature_layer_geometry_type === "point"
          ? ICON_NAME.POINT_FEATURE
          : layer.feature_layer_geometry_type === "line"
            ? ICON_NAME.LINE_FEATURE
            : layer.feature_layer_geometry_type === "polygon"
              ? ICON_NAME.POLYGON_FEATURE
              : ICON_NAME.TABLE,
    }));
  }, [projectLayers]);

  return (
    <>
      <Container
        header={<ToolsHeader onBack={onBack} title={t("custom_sql")} />}
        disablePadding={false}
        body={
          <Box ref={settingsRef} sx={{ display: "flex", flexDirection: "column" }}>
            {/* Description */}
            <Typography variant="body2" sx={{ fontStyle: "italic", mb: theme.spacing(4) }}>
              {t("custom_sql_description")}
            </Typography>

            {/* The step's issues, a failed run's error among them */}
            <StepIssuesSummary issues={stepIssues} />

            {/* Execution Status Section */}
            <Box sx={{ mb: 2 }}>
              <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                {t("execution_status")}
              </Typography>
              <Divider sx={{ mb: 1.5 }} />
              <Chip
                label={nodeStatus ? t(nodeStatus) : t("idle")}
                size="small"
                color={
                  nodeStatus === "completed"
                    ? "primary"
                    : nodeStatus === "failed"
                      ? "error"
                      : nodeStatus === "running"
                        ? "warning"
                        : "default"
                }
                variant={nodeStatus ? "filled" : "outlined"}
                sx={{ fontWeight: 600, textTransform: "uppercase" }}
              />
            </Box>

            {/* Connected Inputs */}
            <Box sx={{ mt: 3, mb: 2 }}>
              <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                {t("connected_inputs")}
              </Typography>
              <Divider sx={{ mb: 1.5 }} />
            </Box>

            {connectedInputs.length === 0 ? (
              <Typography variant="body2" sx={{ fontStyle: "italic", mb: 2 }}>
                {t("connect_dataset_nodes")}
              </Typography>
            ) : (
              <Stack spacing={1.5} sx={{ mb: 2 }}>
                {connectedInputs.map((input, idx) => {
                  const fieldCount = sqlTables.find((t) => t.alias === input.alias)?.fields.length ?? 0;
                  return (
                    <Stack key={idx} direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="body2" color="text.secondary">
                        {input.alias}:
                      </Typography>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="body2" fontWeight="bold">
                          {input.layerName}
                        </Typography>
                        {fieldCount > 0 && (
                          <Typography variant="caption" color="text.disabled">
                            ({fieldCount})
                          </Typography>
                        )}
                      </Stack>
                    </Stack>
                  );
                })}
              </Stack>
            )}

            {/* Additional Layers */}
            <Box sx={{ mt: 3, mb: 2 }}>
              <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                {t("additional_layers")}
              </Typography>
              <Divider sx={{ mb: 1.5 }} />
            </Box>

            {additionalLayers.length > 0 && (
              <Stack spacing={2.5} sx={{ mb: 2 }}>
                {additionalLayers.map((al, idx) => (
                  <Box key={idx}>
                    {idx > 0 && <Divider sx={{ mb: 2.5 }} />}
                    <Stack spacing={1.5}>
                      {/* Layer name + remove */}
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                          <Icon iconName={ICON_NAME.LAYERS} style={{ fontSize: 16 }} />
                          <Typography variant="body2" fontWeight="bold" noWrap sx={{ minWidth: 0 }}>
                            {al.layerName}
                          </Typography>
                        </Stack>
                        <IconButton
                          size="small"
                          onClick={() => handleRemoveLayer(idx)}
                          sx={{ ml: 0.5, flexShrink: 0 }}>
                          <Icon iconName={ICON_NAME.TRASH} style={{ fontSize: 14 }} />
                        </IconButton>
                      </Stack>

                      {/* Alias */}
                      <Stack spacing={1}>
                        <Typography variant="body2" color="text.secondary">
                          {t("table_alias")}
                        </Typography>
                        <TextField
                          size="small"
                          fullWidth
                          placeholder={t("table_name_placeholder")}
                          value={al.alias}
                          onChange={(e) =>
                            handleUpdateAlias(idx, e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))
                          }
                          inputProps={{
                            style: { fontFamily: "monospace", fontSize: "0.875rem" },
                          }}
                        />
                      </Stack>
                    </Stack>
                  </Box>
                ))}
              </Stack>
            )}

            {/* "From project" inline selector (shown when that option is chosen) */}
            {showProjectSelector && (
              <Box sx={{ mb: 2 }}>
                <Selector
                  selectedItems={undefined}
                  setSelectedItems={handleProjectLayerSelect}
                  items={layerSelectorItems}
                  label={t("select_layer")}
                  placeholder={t("select_layer")}
                />
                <Button
                  variant="text"
                  size="small"
                  onClick={() => setShowProjectSelector(false)}
                  sx={{ mt: 1, textTransform: "none" }}>
                  {t("cancel")}
                </Button>
              </Box>
            )}

            {/* Add Layer button */}
            {additionalLayers.length < 2 && !showProjectSelector && (
              <Button
                variant="outlined"
                size="small"
                fullWidth
                startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 15 }} />}
                onClick={handleMenuOpen}
                sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold", mb: 2 }}>
                {t("add_layer")}
              </Button>
            )}

            {/* Layer source menu */}
            <Menu
              anchorEl={menuAnchorEl}
              open={menuOpen}
              onClose={handleMenuClose}
              anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
              transformOrigin={{ vertical: "top", horizontal: "left" }}
              slotProps={{
                paper: {
                  sx: {
                    width: menuAnchorEl?.offsetWidth,
                    minWidth: menuAnchorEl?.offsetWidth,
                  },
                },
              }}>
              {menuItems.map((item) => (
                <MenuItem key={item.type} onClick={() => handleMenuItemClick(item.type)}>
                  <ListItemIcon>
                    <Icon iconName={item.icon} style={{ fontSize: 15 }} />
                  </ListItemIcon>
                  <Typography variant="body2">{item.label}</Typography>
                </MenuItem>
              ))}
            </Menu>

            {/* SQL Query Section */}
            <Box sx={{ mt: 3, mb: 2 }}>
              <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                {t("sql_query")}
              </Typography>
              <Divider sx={{ mb: 1.5 }} />
            </Box>

            {/* SQL preview (clickable) */}
            {sqlQuery && (
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 1,
                  border: 1,
                  borderColor: "divider",
                  mb: 1.5,
                  cursor: "pointer",
                  "&:hover": { borderColor: "primary.main" },
                }}
                onClick={() => setFormulaBuilderOpen(true)}>
                <Typography
                  variant="body2"
                  fontFamily="monospace"
                  fontSize="0.8rem"
                  sx={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 120,
                    overflow: "auto",
                  }}>
                  {sqlQuery}
                </Typography>
              </Box>
            )}

            <Button
              variant="outlined"
              size="small"
              fullWidth
              startIcon={<Icon iconName={ICON_NAME.CODE} style={{ fontSize: 16 }} />}
              onClick={() => setFormulaBuilderOpen(true)}
              sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold" }}>
              {sqlQuery ? t("edit_sql_query") : t("write_sql_query")}
            </Button>

            {/* Output */}
            <Box sx={{ mt: 3, mb: 2 }}>
              <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                {t("output")}
              </Typography>
              <Divider sx={{ mb: 1.5 }} />
            </Box>

            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                {t("result_layer_name")}
              </Typography>
              <TextField
                size="small"
                fullWidth
                placeholder={t("enter_dataset_name")}
                value={resultLayerName}
                onChange={handleResultNameChange}
                inputProps={{
                  style: { fontSize: "0.875rem" },
                }}
              />
            </Stack>

            {/* Dataset Details Section - shown for completed runs with results */}
            {nodeStatus === "completed" && hasTempResult && tempLayerMetadata && (
              <>
                <Box sx={{ mt: 3, mb: 2 }}>
                  <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                    {t("dataset_details")}
                  </Typography>
                  <Divider sx={{ mb: 1.5 }} />
                </Box>

                <Stack spacing={1.5}>
                  {executionInfo?.startedAt && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="body2" color="text.secondary">
                        {t("created")}:
                      </Typography>
                      <Typography variant="body2">
                        {formatDistance(new Date(executionInfo.startedAt * 1000), new Date(), {
                          addSuffix: true,
                          locale: dateLocale,
                        })}
                      </Typography>
                    </Stack>
                  )}

                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography variant="body2" color="text.secondary">
                      {t("features")}:
                    </Typography>
                    <Typography variant="body2">{tempLayerMetadata.featureCount.toLocaleString()}</Typography>
                  </Stack>

                  {tempLayerMetadata.geometryTypes.length > 0 && (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="body2" color="text.secondary">
                        {t("geometry_types")}:
                      </Typography>
                      <Typography variant="body2">{tempLayerMetadata.geometryTypes.join(", ")}</Typography>
                    </Stack>
                  )}
                </Stack>
              </>
            )}

            {/* Actions Section - shown for completed runs with results */}
            {nodeStatus === "completed" && hasTempResult && (
              <>
                <Box sx={{ mt: 3, mb: 2 }}>
                  <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                    {t("actions")}
                  </Typography>
                  <Divider sx={{ mb: 1.5 }} />
                </Box>

                <Stack spacing={1.5}>
                  <Stack direction="row" spacing={1}>
                    <Button
                      variant={activeDataPanelView === "table" ? "contained" : "outlined"}
                      size="small"
                      startIcon={<Icon iconName={ICON_NAME.TABLE} style={{ fontSize: 16 }} />}
                      onClick={() => dispatch(requestTableView())}
                      sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold", flex: 1 }}>
                      {t("table")}
                    </Button>
                    {tempLayerMetadata && tempLayerMetadata.geometryTypes.length > 0 && (
                      <Button
                        variant={activeDataPanelView === "map" ? "contained" : "outlined"}
                        size="small"
                        startIcon={<Icon iconName={ICON_NAME.MAP} style={{ fontSize: 16 }} />}
                        onClick={() => dispatch(requestMapView())}
                        sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold", flex: 1 }}>
                        {t("map")}
                      </Button>
                    )}
                  </Stack>

                  <Button
                    variant="outlined"
                    size="small"
                    fullWidth
                    startIcon={<Icon iconName={ICON_NAME.LAYERS} style={{ fontSize: 16 }} />}
                    onClick={() => setSaveDialogOpen(true)}
                    sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold" }}>
                    {t("save_dataset")}
                  </Button>
                </Stack>
              </>
            )}
          </Box>
        }
      />

      {/* Formula Builder in SQL mode */}
      <FormulaBuilder
        open={formulaBuilderOpen}
        onClose={() => setFormulaBuilderOpen(false)}
        onApply={handleSqlApply}
        initialExpression={sqlQuery}
        fields={EMPTY_FIELDS}
        mode="sql"
        tables={sqlTables}
        title={t("custom_sql_editor")}
        showGroupBy={false}
        variables={workflowVariables}
      />

      {/* The dataset shelf */}
      <DatasetPickerDialog
        open={myDatasetsOpen}
        onClose={() => setMyDatasetsOpen(false)}
        onPick={handleMyDatasetsPick}
      />

      {/* Save Dataset Dialog */}
      <SaveDatasetDialog
        open={saveDialogOpen}
        onClose={() => setSaveDialogOpen(false)}
        onSave={handleSaveDataset}
        defaultName={resultLayerName || t("custom_sql")}
        isSaving={isSaving}
      />
    </>
  );
}
