"use client";

/**
 * Workflow Node Settings Panel
 *
 * Shows configuration for a selected workflow node.
 * For tool nodes, displays the same inputs as GenericTool.
 * For dataset nodes, delegates to DatasetNodeSettings.
 */
import BlockIcon from "@mui/icons-material/Block";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { useEdges } from "@xyflow/react";
import { formatDistance } from "date-fns";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { useLayerWriteAccess } from "@/lib/api/layers";
import { predictNodeSchema, useTempLayerFeatures, useWorkflowMetadata } from "@/lib/api/workflows";
import type { InputSchemaInfo } from "@/lib/api/workflows";
import { OEV_STATION_CONFIG_DEFAULT } from "@/lib/constants/oev-gueteklassen";
import type { AppDispatch, RootState } from "@/lib/store";
import {
  selectActiveDataPanelView,
  selectNodes,
  selectSelectedWorkflowId,
  selectVariables,
} from "@/lib/store/workflow/selectors";
import { requestMapView, requestTableView, updateNode } from "@/lib/store/workflow/slice";
import {
  applyDynamicDefaults,
  getDefaultValues,
  getVisibleInputs,
  hasOpportunityHandles,
  isFormResetField,
  isSectionEnabled,
  processInputsWithSections,
} from "@/lib/utils/ogc-utils";
import type { ContentItem } from "@/lib/validations/content";
import type { ProjectLayer } from "@/lib/validations/project";
import type { ExportNodeData, WorkflowNode } from "@/lib/validations/workflow";

import type { SelectorItem } from "@/types/map/common";
import { OPPORTUNITY_LAYER_HANDLES } from "@/types/map/ogc-processes";
import type { ProcessedSection } from "@/types/map/ogc-processes";

import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";
import { useProcessDescription } from "@/hooks/map/useOgcProcesses";
import { useProjectBundleKinds } from "@/hooks/map/useProjectBundleKinds";

import DatasetPickerDialog from "@/components/addLayer/DatasetPickerDialog";
import Container from "@/components/map/panels/Container";
import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";
import Selector from "@/components/map/panels/common/Selector";
import ToolsHeader from "@/components/map/panels/common/ToolsHeader";
import { DEFAULT_NETWORK_BUNDLE } from "@/components/map/panels/toolbox/generic/inputs/BundleInput";
import OevStationConfigInput from "@/components/map/panels/toolbox/generic/inputs/OevStationConfigInput";
import {
  getObjectDefaults,
  processObjectProperties,
} from "@/components/map/panels/toolbox/generic/inputs/RepeatableObjectInput";
import { useWorkflowExecutionContext } from "@/components/workflows/context/WorkflowExecutionContext";
import SaveDatasetDialog from "@/components/workflows/dialogs/SaveDatasetDialog";
import VariableAwareInput from "@/components/workflows/inputs/VariableAwareInput";
import DatasetNodeSettings from "@/components/workflows/panels/DatasetNodeSettings";
import IfNodeSettings from "@/components/workflows/panels/IfNodeSettings";
import SqlToolSettings from "@/components/workflows/panels/SqlToolSettings";

// Map section icons from backend to ICON_NAME
const SECTION_ICON_MAP: Record<string, ICON_NAME> = {
  layers: ICON_NAME.LAYERS,
  route: ICON_NAME.ROUTE,
  settings: ICON_NAME.SETTINGS,
  hexagon: ICON_NAME.HEXAGON,
  table: ICON_NAME.TABLE,
  tag: ICON_NAME.BOOKMARK,
  grid: ICON_NAME.TABLE,
  list: ICON_NAME.LIST,
  globe: ICON_NAME.GLOBE,
  upload: ICON_NAME.UPLOAD,
  download: ICON_NAME.DOWNLOAD,
  location: ICON_NAME.LOCATION,
  "location-marker": ICON_NAME.LOCATION_MARKER,
  aggregate: ICON_NAME.AGGREGATE,
  chart: ICON_NAME.CHART,
  clock: ICON_NAME.CLOCK,
  save: ICON_NAME.SAVE,
};

const getSectionIcon = (section: ProcessedSection): ICON_NAME => {
  if (section.icon && SECTION_ICON_MAP[section.icon]) {
    return SECTION_ICON_MAP[section.icon];
  }
  return ICON_NAME.CIRCLEINFO;
};

interface WorkflowNodeSettingsProps {
  node: WorkflowNode;
  projectLayers?: ProjectLayer[];
  onBack: () => void;
}

export default function WorkflowNodeSettings({
  node,
  projectLayers = [],
  onBack,
}: WorkflowNodeSettingsProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useDispatch<AppDispatch>();
  const { projectId } = useParams();
  const dateLocale = useDateFnsLocale();

  // Get edges to detect connected inputs
  const edges = useEdges();

  // Get all nodes from redux store for tracing connections
  const nodes = useSelector((state: RootState) => selectNodes(state));

  // Get current workflow ID for metadata API
  const workflowId = useSelector(selectSelectedWorkflowId);

  // Get workflow variables for variable-aware inputs
  const variables = useSelector(selectVariables);

  // Fetch workflow metadata (columns from executed nodes)
  const { metadata: workflowMetadata } = useWorkflowMetadata(workflowId ?? undefined);

  // Get execution context for status and temp layer info
  const { nodeStatuses, nodeExecutionInfo, tempLayerIds, onSaveNode } = useWorkflowExecutionContext();

  // Track active data panel view for button selected state
  const activeDataPanelView = useSelector(selectActiveDataPanelView);

  // Get execution status for this node
  const nodeStatus = nodeStatuses[node.id];
  const executionInfo = nodeExecutionInfo[node.id];
  const tempLayerId = tempLayerIds[node.id];
  const hasTempResult = !!tempLayerId;

  // Parse temp layer ID to extract layer UUID
  const tempLayerUuid = useMemo(() => {
    if (!tempLayerId) return undefined;
    const parts = tempLayerId.split(":");
    return parts.length === 3 ? parts[2] : undefined;
  }, [tempLayerId]);

  // Fetch temp layer data for metadata (features count, geometry types)
  const { data: tempLayerData } = useTempLayerFeatures(hasTempResult ? tempLayerUuid : undefined, {
    limit: 1, // Just need metadata, not all features
  });

  // Derive metadata from temp layer response
  const tempLayerMetadata = useMemo(() => {
    if (!tempLayerData) return null;

    const featureCount = tempLayerData.numberMatched ?? tempLayerData.features?.length ?? 0;

    // Derive geometry types from first feature
    const geometryTypes = new Set<string>();
    if (tempLayerData.features?.length) {
      const feature = tempLayerData.features[0] as { geometry?: { type?: string } };
      if (feature?.geometry?.type) {
        geometryTypes.add(feature.geometry.type);
      }
    }

    return {
      featureCount,
      geometryTypes: Array.from(geometryTypes),
    };
  }, [tempLayerData]);

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
        // Note: success toast is shown when the finalize job completes (handled by useJobStatus)
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

  // For tool nodes, fetch process description
  const processId = node.type === "tool" && node.data.type === "tool" ? node.data.processId : undefined;
  const { process, isLoading: isLoadingProcess } = useProcessDescription(processId);

  // Project layers for geometry type detection
  const { layers: fetchedLayers } = useFilteredProjectLayers(projectId as string);
  const layers = fetchedLayers || projectLayers;

  // Initialize values from node data or defaults.
  //
  // The saved config is seeded into the resolution so fields keyed on another
  // field settle on load: `speed` derives from `routing_mode`, which has no
  // schema default, so without the seed it can only resolve at the moment the
  // user changes the mode. A node saved with a mode already set never fires
  // that change and would show an empty speed.
  const savedConfig = node.data.type === "tool" ? node.data.config : undefined;
  const defaultValues = useMemo(() => {
    if (!process) return {};
    return getDefaultValues(process, savedConfig ?? {});
  }, [process, savedConfig]);

  // Detect connected layer inputs and create virtual values for them
  // This ensures depends_on conditions like {input_layer_id: {$ne: None}} are satisfied
  const connectedLayerValues = useMemo(() => {
    if (!process?.inputs) return {};

    const virtualValues: Record<string, string> = {};

    // Get incoming edges to this node
    const incomingEdges = edges.filter((e) => e.target === node.id);

    // Find layer inputs (widgets: layer-selector, starting-points)
    for (const [name, input] of Object.entries(process.inputs)) {
      const widget = input.schema?.["x-ui"]?.widget;
      if (widget === "layer-selector" || widget === "starting-points") {
        // Check if this input has a connection
        const isConnected = incomingEdges.some(
          (e) => e.targetHandle === name || (!e.targetHandle && Object.keys(process.inputs).length === 1)
        );
        if (isConnected) {
          // Set a placeholder value to satisfy depends_on conditions
          virtualValues[name] = "__connected__";
        }
      }
    }

    return virtualValues;
  }, [process, edges, node.id]);

  const connectedStartingPointValues = useMemo(() => {
    if (!process?.inputs) return {};

    const nested: Record<string, { layer_id: string }> = {};
    for (const name of Object.keys(connectedLayerValues)) {
      if (process.inputs[name]?.schema?.["x-ui"]?.widget === "starting-points") {
        nested[name] = { layer_id: "__connected__" };
      }
    }
    return nested;
  }, [process, connectedLayerValues]);

  // Form state - initialize with node's saved config or defaults
  // Use node.id as key to ensure state resets when switching nodes
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (node.type === "tool" && node.data.type === "tool" && node.data.config) {
      return node.data.config;
    }
    return {};
  });

  // Layer filters state (for future use when executing tools)
  const [_layerFilters, setLayerFilters] = useState<Record<string, Record<string, unknown> | undefined>>({});

  // Nested layer filters for repeatable objects (for future use)
  const [_nestedLayerFilters, setNestedLayerFilters] = useState<
    Record<string, Record<string, Record<string, unknown> | undefined>[]>
  >({});

  // Section collapse state
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  // Advanced options collapse state
  const [advancedCollapsed, setAdvancedCollapsed] = useState<Record<string, boolean>>({});

  // Process inputs into sections
  const sections = useMemo(() => {
    if (!process) return [];
    return processInputsWithSections(process);
  }, [process]);

  // Initialize values when process loads (but preserve node's saved values)
  useEffect(() => {
    if (process) {
      const defaults = getDefaultValues(process);
      setValues((prev) => {
        // Merge defaults with existing values (node config takes precedence)
        return { ...defaults, ...prev };
      });

      // Initialize collapsed states
      const collapsed: Record<string, boolean> = {};
      const advCollapsed: Record<string, boolean> = {};
      for (const section of sections) {
        collapsed[section.id] = section.collapsed;
        advCollapsed[section.id] = true;
      }
      setCollapsedSections(collapsed);
      setAdvancedCollapsed(advCollapsed);
    }
  }, [process, sections]);

  // The oev_gueteklassen schema doesn't expose station_config as an input, so seed
  // the default here and render a fallback control (same special-casing as GenericTool).
  useEffect(() => {
    if (processId !== "oev_gueteklassen") {
      return;
    }
    setValues((prev) => {
      if (prev.station_config) {
        return prev;
      }
      return {
        ...prev,
        station_config: OEV_STATION_CONFIG_DEFAULT,
      };
    });
  }, [processId]);

  // Get all inputs from all sections
  const allInputs = useMemo(() => {
    return sections.flatMap((section) => section.inputs);
  }, [sections]);

  const bundleSelectors = useMemo(
    () =>
      allInputs
        .filter((input) => input.uiMeta?.widget === "bundle-selector")
        .map((input) => ({
          name: input.name,
          bundleType: input.uiMeta?.widget_options?.bundle_type as string | undefined,
          artifactKind: input.uiMeta?.widget_options?.artifact_kind as string | undefined,
        })),
    [allInputs]
  );
  const projectBundleValues = useProjectBundleKinds(projectId as string, bundleSelectors);

  const bundleChoiceValues = useMemo((): Record<string, unknown> => {
    const merged = { ...defaultValues, ...values };
    const flags: Record<string, unknown> = {};
    for (const selector of bundleSelectors) {
      const chosen = merged[selector.name];
      flags[`_${selector.name}_is_custom`] =
        typeof chosen === "string" && chosen !== "" && chosen !== DEFAULT_NETWORK_BUNDLE;
    }
    return flags;
  }, [bundleSelectors, values, defaultValues]);

  // Repeatable inputs whose items are layers (e.g. merge) — these are filled by
  // canvas connections, so we don't pad them to min_items in the workflow panel.
  const layerRepeatableInputNames = useMemo(() => {
    const names = new Set<string>();
    if (!process) return names;
    for (const input of allInputs) {
      if (input.inputType !== "repeatable-object") continue;
      const itemsRef = input.schema?.items?.$ref;
      if (!itemsRef || !process.$defs) continue;
      const itemSchema = process.$defs[itemsRef.replace("#/$defs/", "")];
      if (!itemSchema) continue;
      const fields = processObjectProperties(itemSchema, process.$defs);
      if (fields.some((f) => f.inputType === "layer")) names.add(input.name);
    }
    return names;
  }, [process, allInputs]);

  // Helper to get layer ID from a connected source node
  const getLayerIdFromSourceNode = useCallback(
    (inputName: string): string | undefined => {
      // Find the edge that connects to this input
      const edge = edges.find(
        (e) =>
          e.target === node.id &&
          (e.targetHandle === inputName || (!e.targetHandle && allInputs.length === 1))
      );
      if (!edge) return undefined;

      // Find the source node
      const sourceNode = nodes.find((n) => n.id === edge.source);
      if (!sourceNode) return undefined;

      // If source is a dataset node, get its configured layerId
      if (sourceNode.data?.type === "dataset" && sourceNode.data?.layerId) {
        return sourceNode.data.layerId as string;
      }

      // If source is a tool node with temp result, assume it has geometry
      // (tool outputs generally preserve geometry type)
      if (sourceNode.data?.type === "tool") {
        return "__tool_output__"; // Special marker to indicate tool output (has geometry)
      }

      return undefined;
    },
    [edges, node.id, nodes, allInputs.length]
  );

  // Compute layer geometry types for visibility conditions
  const layerGeometryValues = useMemo(() => {
    if (!layers) return {};

    const computed: Record<string, boolean> = {};
    const effectiveValues = { ...defaultValues, ...connectedLayerValues, ...values };

    for (const input of allInputs) {
      if (input.inputType === "layer") {
        const projectLayerId = effectiveValues[input.name] as string | undefined;

        // Check if this is a connected input
        if (projectLayerId === "__connected__") {
          // Trace to source node to get actual layer ID
          const sourceLayerId = getLayerIdFromSourceNode(input.name);

          if (sourceLayerId === "__tool_output__") {
            // Tool outputs generally have geometry
            computed[`_${input.name}_has_geometry`] = true;
          } else if (sourceLayerId) {
            // sourceLayerId could be a UUID (layer_id) or numeric project layer ID
            const isUUID = sourceLayerId.includes("-") && sourceLayerId.length > 20;

            if (isUUID) {
              // Find layer by layer_id (UUID)
              const layer = layers.find((l) => l.layer_id === sourceLayerId);
              computed[`_${input.name}_has_geometry`] = !!layer?.feature_layer_geometry_type;
            } else {
              // Find layer by numeric ID
              const numericId = parseInt(sourceLayerId, 10);
              const layer = layers.find((l) => l.id === numericId);
              computed[`_${input.name}_has_geometry`] = !!layer?.feature_layer_geometry_type;
            }
          } else {
            // Connected but can't determine - assume has geometry for better UX
            computed[`_${input.name}_has_geometry`] = true;
          }
        } else if (projectLayerId) {
          // Direct layer selection
          const numericId = parseInt(projectLayerId, 10);
          const layer = layers.find((l) => l.id === numericId);
          computed[`_${input.name}_has_geometry`] = !!layer?.feature_layer_geometry_type;
        } else {
          computed[`_${input.name}_has_geometry`] = false;
        }
      }
    }

    const geometryFlags = Object.values(computed);
    computed["_any_layer_has_geometry"] = geometryFlags.some((v) => v === true);
    computed["_all_layers_have_geometry"] =
      geometryFlags.length > 0 && geometryFlags.every((v) => v === true);

    return computed;
  }, [layers, allInputs, values, defaultValues, connectedLayerValues, getLayerIdFromSourceNode]);

  // Compute dataset IDs for layer inputs (needed for field selectors)
  // This maps layer input names to their dataset IDs, handling connected inputs
  const layerDatasetIds = useMemo(() => {
    if (!layers) return {};

    const mapping: Record<string, string> = {};
    const effectiveValues = { ...defaultValues, ...connectedLayerValues, ...values };

    for (const input of allInputs) {
      if (input.inputType === "layer" || input.inputType === "starting-points") {
        const projectLayerId = effectiveValues[input.name] as string | undefined;

        if (projectLayerId === "__connected__") {
          // Trace to source node to get actual layer ID
          const sourceLayerId = getLayerIdFromSourceNode(input.name);

          if (sourceLayerId && sourceLayerId !== "__tool_output__") {
            // sourceLayerId could be:
            // 1. A numeric project layer ID (e.g., "123")
            // 2. A UUID layer_id/dataset_id (e.g., "16235883-3477-49fc-a7a5-796d7048f0c1")

            // Check if it's a UUID (contains dashes and is longer than typical numeric IDs)
            const isUUID = sourceLayerId.includes("-") && sourceLayerId.length > 20;

            if (isUUID) {
              // It's already a layer_id (dataset_id), use it directly
              mapping[input.name] = sourceLayerId;
            } else {
              // Find layer by numeric ID and get its dataset ID (layer_id)
              const numericId = parseInt(sourceLayerId, 10);
              const layer = layers.find((l) => l.id === numericId);
              if (layer?.layer_id) {
                mapping[input.name] = layer.layer_id;
              }
            }
          }
          // For tool outputs, we can't determine fields until execution
        } else if (projectLayerId) {
          // Direct layer selection
          const numericId = parseInt(projectLayerId, 10);
          const layer = layers.find((l) => l.id === numericId);
          if (layer?.layer_id) {
            mapping[input.name] = layer.layer_id;
          }
        }
      }
    }

    for (const [name, datasetId] of Object.entries({ ...mapping })) {
      mapping[`${name}.layer_id`] = datasetId;
    }

    return mapping;
  }, [layers, allInputs, values, defaultValues, connectedLayerValues, getLayerIdFromSourceNode]);

  // Tools taking opportunity layers from numbered canvas handles
  const takesOpportunityHandles = hasOpportunityHandles(process);

  // Compute predicted columns for connected tool outputs
  // This enables field selectors to show fields from upstream tool nodes
  // Declared here (before connectedOpportunities) because that useMemo references it
  const [predictedColumns, setPredictedColumns] = useState<Record<string, Record<string, string>>>({});

  // Compute connected opportunity handles and per-opportunity field definitions
  const connectedOpportunities = useMemo(() => {
    if (!takesOpportunityHandles || !process) return [];

    // Find which opportunity_layer_N_id handles have incoming edges
    const incomingEdges = edges.filter((e) => e.target === node.id);
    return OPPORTUNITY_LAYER_HANDLES.map((handle) => {
      const edge = incomingEdges.find((e) => e.targetHandle === handle);
      if (!edge) return null;

      const sourceNode = nodes.find((n) => n.id === edge.source);
      const sourceLabel = sourceNode
        ? (sourceNode.data as { label?: string }).label || sourceNode.id
        : edge.source;
      const oppNum = handle.split("_")[2]; // "1", "2", or "3"

      // Resolve source dataset ID for field selectors (e.g. potential_field)
      // The opportunity schema uses source_layer="input_path", so we map input_path
      // to the connected layer's dataset ID
      let sourceDatasetId: string | undefined;
      let sourcePredictedCols: Record<string, string> | undefined;
      if (sourceNode?.data?.type === "dataset" && sourceNode.data.layerId) {
        const layerIdValue = sourceNode.data.layerId as string;
        const isUUID = layerIdValue.includes("-") && layerIdValue.length > 20;
        if (isUUID) {
          sourceDatasetId = layerIdValue;
        } else {
          const numericId = parseInt(layerIdValue, 10);
          const layer = layers?.find((l) => l.id === numericId);
          sourceDatasetId = layer?.layer_id;
        }
      } else if (sourceNode?.data?.type === "tool") {
        // For tool source nodes, check for predicted/executed columns
        if (workflowMetadata?.nodes[sourceNode.id]?.columns) {
          sourcePredictedCols = workflowMetadata.nodes[sourceNode.id].columns!;
        } else if (predictedColumns[handle]) {
          // Fallback to predicted columns from the main prediction effect
          // This handles un-executed tool sources (e.g. custom_sql → heatmap)
          sourcePredictedCols = predictedColumns[handle];
        }
      }

      return { handle, oppNum, sourceLabel, sourceDatasetId, sourcePredictedCols };
    }).filter((item): item is NonNullable<typeof item> => item !== null);
  }, [takesOpportunityHandles, process, edges, node.id, nodes, layers, workflowMetadata, predictedColumns]);

  // Get per-opportunity field definitions from the opportunities schema
  const opportunityFields = useMemo(() => {
    if (!takesOpportunityHandles || !process) return [];

    // Find the 'opportunities' input and resolve its item schema
    const oppInput = process.inputs?.opportunities;
    if (!oppInput) return [];

    const itemsRef = oppInput.schema?.items?.$ref;
    if (!itemsRef || !process.$defs) return [];

    const refName = itemsRef.replace("#/$defs/", "");
    const itemSchema = process.$defs[refName];
    if (!itemSchema) return [];

    // Process properties into field definitions
    const fields = processObjectProperties(itemSchema, process.$defs);

    // Filter out input_path and input_layer_filter (these come from connections)
    return fields.filter(
      (f) => f.name !== "input_path" && f.name !== "input_layer_filter" && f.name !== "name"
    );
  }, [takesOpportunityHandles, process]);

  // Get default values for opportunity fields
  const opportunityDefaults = useMemo(() => {
    if (!takesOpportunityHandles || !process) return {};

    const oppInput = process.inputs?.opportunities;
    if (!oppInput) return {};

    const itemsRef = oppInput.schema?.items?.$ref;
    if (!itemsRef || !process.$defs) return {};

    const refName = itemsRef.replace("#/$defs/", "");
    const itemSchema = process.$defs[refName];
    if (!itemSchema) return {};

    // Pass the node's own values so nested default_by_field / default_from
    // resolve against routing_mode and cost_type — otherwise a distance-based
    // heatmap would persist the time-based schema default as its budget.
    return getObjectDefaults(itemSchema, process.$defs, { ...defaultValues, ...values });
  }, [takesOpportunityHandles, process, defaultValues, values]);

  // Auto-persist opportunity defaults to node config when connections are made.
  // Without this, default values are only used for display but never written to
  // the config, so the workflow runner receives incomplete opportunity configs.
  useEffect(() => {
    if (connectedOpportunities.length === 0 || Object.keys(opportunityDefaults).length === 0) return;

    let needsUpdate = false;
    const newValues = { ...values };

    for (const opp of connectedOpportunities) {
      const prefix = `opportunity_${opp.oppNum}_`;
      for (const [key, val] of Object.entries(opportunityDefaults)) {
        if (key === "input_path" || key === "input_layer_filter" || key === "name") continue;
        const configKey = `${prefix}${key}`;
        if (newValues[configKey] === undefined) {
          newValues[configKey] = val;
          needsUpdate = true;
        }
      }
    }

    if (needsUpdate) {
      setValues(newValues);
      if (node.type === "tool") {
        dispatch(
          updateNode({
            id: node.id,
            changes: {
              data: {
                ...node.data,
                config: newValues,
              },
            },
          })
        );
      }
    }
  }, [connectedOpportunities, opportunityDefaults]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset all state when node changes to ensure nodes are independent
  useEffect(() => {
    if (node.type === "tool" && node.data.type === "tool") {
      setValues(node.data.config || {});
    } else {
      setValues({});
    }
    // Reset predicted columns when node changes
    setPredictedColumns({});
  }, [node.id]); // Only reset when node ID changes

  // Use ref to track latest values without triggering effect re-runs
  const valuesRef = useRef<Record<string, unknown>>({});
  const defaultValuesRef = useRef<Record<string, unknown>>({});
  const connectedLayerValuesRef = useRef<Record<string, string>>({});
  const layersRef = useRef<ProjectLayer[] | undefined>(undefined);

  // Update refs when values change (doesn't trigger re-render)
  useEffect(() => {
    valuesRef.current = values;
    defaultValuesRef.current = defaultValues;
    connectedLayerValuesRef.current = connectedLayerValues;
    layersRef.current = layers;
  }, [values, defaultValues, connectedLayerValues, layers]);

  // Compute a stable key for when we need to re-fetch predictions
  // Only changes when graph structure changes (edges, nodes) or workflow metadata updates
  const connectedToolInputsKey = useMemo(() => {
    const connectedInputs: string[] = [];

    for (const input of allInputs) {
      if (input.inputType !== "layer" && input.inputType !== "starting-points") continue;

      // Check if this input has a connection
      const edge = edges.find(
        (e) =>
          e.target === node.id &&
          (e.targetHandle === input.name || (!e.targetHandle && allInputs.length === 1))
      );

      if (!edge) continue;

      const sourceNode = nodes.find((n) => n.id === edge.source);

      if (!sourceNode || sourceNode.data?.type !== "tool") continue;

      // Include source node info and its config hash in the key
      const sourceConfig = JSON.stringify(sourceNode.data.config || {});
      connectedInputs.push(`${input.name}:${sourceNode.id}:${sourceNode.data.processId}:${sourceConfig}`);
    }

    return connectedInputs.sort().join("|");
  }, [allInputs, edges, nodes, node.id]);

  // Track if fetch is in progress and the last key we fetched for
  const fetchInProgressRef = useRef(false);
  const lastFetchedKeyRef = useRef<string>("");

  // Effect to fetch predicted columns for connected tool outputs
  // Only runs when the stable key changes, not on every render
  useEffect(() => {
    if (!process || !workflowId || !connectedToolInputsKey) {
      return;
    }

    // Wait for layers to be available before fetching predictions
    // This ensures we can resolve layer_ids from dataset nodes
    if (!layers || layers.length === 0) {
      return;
    }

    // Create a complete fetch key including layers availability and node.id
    const fetchKey = `${node.id}:${connectedToolInputsKey}:${layers.length}`;

    // Skip if we already fetched for this exact key
    if (lastFetchedKeyRef.current === fetchKey) {
      return;
    }

    // Prevent duplicate fetches
    if (fetchInProgressRef.current) {
      return;
    }

    const fetchPredictedColumns = async () => {
      fetchInProgressRef.current = true;

      try {
        const newPredicted: Record<string, Record<string, string>> = {};
        // Use refs to get current values without them being dependencies
        const effectiveValues = {
          ...defaultValuesRef.current,
          ...connectedLayerValuesRef.current,
          ...valuesRef.current,
        };
        // Use layers directly since it's now a dependency
        const currentLayers = layers;

        // Cache for resolved columns to avoid redundant API calls
        const cache: Record<string, Record<string, string>> = {};

        // Recursively resolve a node's output columns (same pattern as SqlToolSettings)
        const resolveNodeColumns = async (
          nodeId: string,
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

          // Dataset node: use layer_id for prediction
          if (targetNode.data?.type === "dataset" && targetNode.data.layerId) {
            const layerIdValue = targetNode.data.layerId as string;
            let layerForId = currentLayers?.find((l) => l.layer_id === layerIdValue);
            if (!layerForId) {
              const numericId = parseInt(layerIdValue, 10);
              if (!isNaN(numericId)) {
                layerForId = currentLayers?.find((l) => l.id === numericId);
              }
            }
            // Return empty — dataset columns are resolved via layer_id in inputSchemas
            // We store a marker so the caller knows to use layer_id instead
            return {};
          }

          // Tool node: recursively resolve input schemas, then predict output
          if (targetNode.data?.type === "tool") {
            const targetProcessId = targetNode.data.processId as string;
            const config = (targetNode.data.config || {}) as Record<string, unknown>;
            const inputSchemas: Record<string, InputSchemaInfo> = {};
            const incomingEdges = edges.filter((e) => e.target === nodeId);

            for (const srcEdge of incomingEdges) {
              const inputName = srcEdge.targetHandle || "input_layer_id";
              const srcNode = nodes.find((n) => n.id === srcEdge.source);

              if (srcNode?.data?.type === "dataset" && srcNode.data.layerId) {
                // Dataset: resolve layer UUID for layer_id-based prediction
                const layerIdValue = srcNode.data.layerId as string;
                let layer = currentLayers?.find((l) => l.layer_id === layerIdValue);
                if (!layer) {
                  const numericId = parseInt(layerIdValue, 10);
                  if (!isNaN(numericId)) {
                    layer = currentLayers?.find((l) => l.id === numericId);
                  }
                }
                const layerUuid = layer?.layer_id || layerIdValue;
                if (layerUuid) {
                  inputSchemas[inputName] = { layer_id: layerUuid };
                }
              } else if (srcNode?.data?.type === "tool") {
                // Tool: recursively resolve its output columns
                const sourceColumns = await resolveNodeColumns(srcEdge.source, visited);
                if (Object.keys(sourceColumns).length > 0) {
                  inputSchemas[inputName] = { columns: sourceColumns };
                }
              }
            }

            try {
              const predicted = await predictNodeSchema(workflowId, {
                process_id: targetProcessId,
                input_schemas: inputSchemas,
                params: config,
              });
              if (predicted.columns && Object.keys(predicted.columns).length > 0) {
                cache[nodeId] = predicted.columns;
                return predicted.columns;
              }
            } catch (error) {
              console.warn(`Failed to predict schema for ${targetProcessId}:`, error);
            }
          }

          return {};
        };

        for (const input of allInputs) {
          if (input.inputType !== "layer" && input.inputType !== "starting-points") continue;

          const projectLayerId = effectiveValues[input.name] as string | undefined;

          if (projectLayerId !== "__connected__") continue;

          // Find the edge to get source node
          const edge = edges.find(
            (e) =>
              e.target === node.id &&
              (e.targetHandle === input.name || (!e.targetHandle && allInputs.length === 1))
          );
          if (!edge) continue;

          const sourceNode = nodes.find((n) => n.id === edge.source);
          if (!sourceNode) continue;

          // Check if we have metadata from executed node
          if (workflowMetadata?.nodes[sourceNode.id]?.columns) {
            newPredicted[input.name] = workflowMetadata.nodes[sourceNode.id].columns!;
            continue;
          }

          // Recursively resolve source node's output columns
          if (sourceNode.data?.type === "tool") {
            const cols = await resolveNodeColumns(sourceNode.id, new Set());
            if (Object.keys(cols).length > 0) {
              newPredicted[input.name] = cols;
            }
          }
        }

        for (const [name, cols] of Object.entries({ ...newPredicted })) {
          newPredicted[`${name}.layer_id`] = cols;
        }

        setPredictedColumns(newPredicted);
        // Mark this key as fetched
        lastFetchedKeyRef.current = fetchKey;
      } finally {
        fetchInProgressRef.current = false;
      }
    };

    fetchPredictedColumns();
    // Note: We intentionally exclude allInputs, edges, nodes, workflowMetadata from deps
    // because connectedToolInputsKey captures the relevant changes, and lastFetchedKeyRef
    // prevents duplicate fetches for the same configuration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    process,
    workflowId,
    connectedToolInputsKey, // Stable key that only changes when graph structure changes
    node.id,
    layers, // Re-fetch when layers become available
  ]);

  // Update a single input value
  const handleInputChange = useCallback(
    (name: string, value: unknown) => {
      // A field marked `resets_form` starts the node's form over when it
      // changes — same rule as the toolbox form. Seeding the new value rebuilds
      // the defaults that are keyed on it.
      const resets =
        !!process &&
        isFormResetField(allInputs, name) &&
        values[name] !== undefined &&
        values[name] !== value;
      const newValues = resets
        ? getDefaultValues(process, { [name]: value })
        : applyDynamicDefaults(allInputs, values, name, value);

      // Update local state
      setValues(newValues);

      // Save to Redux (outside setValues updater to avoid updating
      // other components during this component's render)
      if (node.type === "tool") {
        dispatch(
          updateNode({
            id: node.id,
            changes: {
              data: {
                ...node.data,
                config: newValues,
              },
            },
          })
        );
      }
    },
    [allInputs, process, values, dispatch, node]
  );

  // Update filter for a layer input
  const handleFilterChange = useCallback((inputName: string, filter: Record<string, unknown> | undefined) => {
    setLayerFilters((prev) => ({
      ...prev,
      [inputName]: filter,
    }));
  }, []);

  // Update nested filters
  const handleNestedFiltersChange = useCallback(
    (inputName: string, filters: Record<string, Record<string, unknown> | undefined>[]) => {
      setNestedLayerFilters((prev) => ({
        ...prev,
        [inputName]: filters,
      }));
    },
    []
  );

  // Toggle section collapse
  const toggleSection = useCallback((sectionId: string) => {
    setCollapsedSections((prev) => ({
      ...prev,
      [sectionId]: !prev[sectionId],
    }));
  }, []);

  // Toggle advanced options collapse
  const toggleAdvanced = useCallback((sectionId: string) => {
    setAdvancedCollapsed((prev) => ({
      ...prev,
      [sectionId]: !prev[sectionId],
    }));
  }, []);

  // Render dataset node settings
  if (node.type === "dataset" && node.data.type === "dataset") {
    return <DatasetNodeSettings node={node} projectLayers={layers} onBack={onBack} />;
  }

  // Render export node settings (inline, same structure as tool nodes)
  if (node.type === "export" && node.data.type === "export") {
    const exportData = node.data as ExportNodeData;

    // Find upstream tool node
    const upstreamInfo = (() => {
      const incomingEdge = edges.find((e) => e.target === node.id);
      if (!incomingEdge) return null;
      const sourceNode = nodes.find((n) => n.id === incomingEdge.source);
      if (!sourceNode) return null;
      return {
        label: (sourceNode.data as { label?: string }).label || sourceNode.id,
      };
    })();

    return (
      <ExportNodeSettingsInline
        node={node}
        exportData={exportData}
        nodeStatus={nodeStatus}
        upstreamInfo={upstreamInfo}
        onBack={onBack}
      />
    );
  }

  // Render Custom SQL tool settings (special case)
  if (node.type === "tool" && node.data.type === "tool" && node.data.processId === "custom_sql") {
    return <SqlToolSettings node={node} onBack={onBack} />;
  }

  // Render If/Switch branching node settings
  if (node.type === "if" && node.data.type === "if") {
    return <IfNodeSettings node={node} projectLayers={layers} onBack={onBack} />;
  }

  // Render tool node settings
  if (node.type === "tool" && node.data.type === "tool") {
    // Loading state
    if (isLoadingProcess) {
      return (
        <Container
          header={<ToolsHeader onBack={onBack} title={t("loading")} />}
          disablePadding={true}
          body={
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress />
            </Box>
          }
        />
      );
    }

    // No process found
    if (!process) {
      return (
        <Container
          header={<ToolsHeader onBack={onBack} title={node.data.label} />}
          disablePadding={false}
          body={
            <Typography variant="body2" color="text.secondary">
              {t("process_not_found")}
            </Typography>
          }
        />
      );
    }

    // Effective values for visibility
    // Include connectedLayerValues so depends_on conditions for connected inputs are satisfied
    const effectiveValues = {
      ...defaultValues,
      ...connectedLayerValues,
      ...values,
      ...layerGeometryValues,
      ...connectedStartingPointValues,
      ...projectBundleValues,
      ...bundleChoiceValues,
    };

    // Render sections with inputs (matching GenericTool pattern)
    return (
      <>
        <Container
          header={<ToolsHeader onBack={onBack} title={process.title} />}
          disablePadding={false}
          body={
            <Box sx={{ display: "flex", flexDirection: "column" }}>
              {/* Description */}
              <Typography variant="body2" sx={{ fontStyle: "italic", mb: theme.spacing(4) }}>
                {process.description}
              </Typography>

              {/* Execution Status Section */}
              <Box sx={{ mb: 2 }}>
                <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                  {t("execution_status")}
                </Typography>
                <Divider sx={{ mb: 1.5 }} />
                <Chip
                  label={nodeStatus ? t(nodeStatus, { defaultValue: nodeStatus }) : t("idle")}
                  size="small"
                  icon={nodeStatus === "skipped" ? <BlockIcon sx={{ fontSize: 14 }} /> : undefined}
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

              {/* Parameters Section */}
              <Box sx={{ mt: 3, mb: 2 }}>
                <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                  {t("parameters")}
                </Typography>
                <Divider sx={{ mb: 1.5 }} />
              </Box>

              {/* Render sections dynamically */}
              {sections.map((section) => {
                // In workflows, skip sections that are handled by node connections or not applicable
                // Result sections are not supported in workflows
                const workflowHiddenSections = ["result"];
                // Tools whose opportunity layers arrive on numbered canvas handles
                // get the section hidden; ones with non-repeatable opportunity
                // fields (huff_model) must keep it visible.
                if (takesOpportunityHandles) {
                  workflowHiddenSections.push("opportunities");
                }
                if (workflowHiddenSections.includes(section.id)) {
                  return null;
                }

                // Filter out layer inputs that should come from node connections
                const workflowHiddenWidgets = ["layer-selector", "starting-points"];
                const visibleInputs = getVisibleInputs(section.inputs, effectiveValues)
                  .filter((input) => !workflowHiddenWidgets.includes(input.uiMeta?.widget || ""))
                  // Repeatable layer inputs come from connections; don't pad to min_items.
                  .map((input) =>
                    layerRepeatableInputNames.has(input.name)
                      ? { ...input, uiMeta: { ...input.uiMeta, min_items: 0 } }
                      : input
                  );
                const sectionEnabled = isSectionEnabled(section, effectiveValues);

                // Skip empty sections
                if (visibleInputs.length === 0) {
                  return null;
                }

                // Split into base and advanced inputs
                const baseInputs = visibleInputs.filter((input) => !input.advanced);
                const advancedInputs = visibleInputs.filter((input) => input.advanced);
                const hasAdvancedOptions = advancedInputs.length > 0;
                const shouldRenderOevStationConfigFallback =
                  processId === "oev_gueteklassen" &&
                  section.id === "configuration" &&
                  !visibleInputs.some((input) => input.name === "station_config");

                const isCollapsed = collapsedSections[section.id] ?? section.collapsed;
                const isAdvancedCollapsed = advancedCollapsed[section.id] ?? true;
                const isFirstSection = sections.indexOf(section) === 0;
                const isDisabled = !sectionEnabled;

                return (
                  <Box
                    key={section.id}
                    sx={{
                      opacity: isDisabled ? 0.5 : 1,
                      pointerEvents: isDisabled ? "none" : "auto",
                      transition: "opacity 0.2s ease",
                    }}>
                    <SectionHeader
                      active={!isCollapsed && !isDisabled}
                      alwaysActive={!section.collapsible || isFirstSection}
                      label={section.label}
                      icon={getSectionIcon(section)}
                      disableAdvanceOptions={!hasAdvancedOptions}
                      collapsed={hasAdvancedOptions ? isAdvancedCollapsed : isCollapsed || isDisabled}
                      setCollapsed={
                        hasAdvancedOptions
                          ? () => toggleAdvanced(section.id)
                          : section.collapsible
                            ? () => toggleSection(section.id)
                            : undefined
                      }
                      onToggleChange={
                        section.collapsible && !isFirstSection ? () => toggleSection(section.id) : undefined
                      }
                    />
                    {!isCollapsed && !isDisabled && (
                      <SectionOptions
                        active={true}
                        collapsed={isAdvancedCollapsed}
                        baseOptions={
                          <Stack spacing={2}>
                            {baseInputs.map((input) => (
                              <VariableAwareInput
                                key={input.name}
                                input={input}
                                value={effectiveValues[input.name]}
                                onChange={(value) => handleInputChange(input.name, value)}
                                onFilterChange={
                                  input.inputType === "layer"
                                    ? (filter) => handleFilterChange(input.name, filter)
                                    : undefined
                                }
                                onNestedFiltersChange={
                                  input.inputType === "repeatable-object"
                                    ? (filters) => handleNestedFiltersChange(input.name, filters)
                                    : undefined
                                }
                                formValues={effectiveValues}
                                schemaDefs={process.$defs}
                                layerDatasetIds={layerDatasetIds}
                                predictedColumns={predictedColumns}
                                variables={variables}
                              />
                            ))}
                            {shouldRenderOevStationConfigFallback && (
                              <OevStationConfigInput
                                input={{ name: "station_config", title: "Station configuration" }}
                                value={effectiveValues.station_config}
                                onChange={(value) => handleInputChange("station_config", value)}
                              />
                            )}
                          </Stack>
                        }
                        advancedOptions={
                          hasAdvancedOptions ? (
                            <Stack spacing={2}>
                              {advancedInputs.map((input) => (
                                <VariableAwareInput
                                  key={input.name}
                                  input={input}
                                  value={effectiveValues[input.name]}
                                  onChange={(value) => handleInputChange(input.name, value)}
                                  onFilterChange={
                                    input.inputType === "layer"
                                      ? (filter) => handleFilterChange(input.name, filter)
                                      : undefined
                                  }
                                  onNestedFiltersChange={
                                    input.inputType === "repeatable-object"
                                      ? (filters) => handleNestedFiltersChange(input.name, filters)
                                      : undefined
                                  }
                                  formValues={effectiveValues}
                                  schemaDefs={process.$defs}
                                  layerDatasetIds={layerDatasetIds}
                                  predictedColumns={predictedColumns}
                                  variables={variables}
                                />
                              ))}
                            </Stack>
                          ) : undefined
                        }
                      />
                    )}
                  </Box>
                );
              })}

              {/* Per-opportunity config for heatmap tools */}
              {takesOpportunityHandles && connectedOpportunities.length > 0 && (
                <Box>
                  <SectionHeader
                    active={true}
                    alwaysActive={true}
                    label={t("opportunities")}
                    icon={ICON_NAME.LOCATION_MARKER}
                    disableAdvanceOptions={true}
                    collapsed={false}
                  />
                  <SectionOptions
                    active={true}
                    collapsed={false}
                    baseOptions={
                      <Stack spacing={2}>
                        {connectedOpportunities.map((opp, index) => {
                          const prefix = `opportunity_${opp.oppNum}_`;

                          // Build per-opportunity values from flat config
                          const oppValues: Record<string, unknown> = { input_path: "__connected__" };
                          for (const [key, val] of Object.entries(values)) {
                            if (key.startsWith(prefix)) {
                              oppValues[key.slice(prefix.length)] = val;
                            }
                          }
                          // Apply defaults for missing values
                          for (const [key, val] of Object.entries(opportunityDefaults)) {
                            if (
                              key !== "input_path" &&
                              key !== "input_layer_filter" &&
                              key !== "name" &&
                              oppValues[key] === undefined
                            ) {
                              oppValues[key] = val;
                            }
                          }

                          // Card fields resolve their conditions (visibility, per-mode
                          // limits) against the node's own fields too, as in the toolbox.
                          const oppFormValues = { ...defaultValues, ...values, ...oppValues };
                          const visibleFields = getVisibleInputs(opportunityFields, oppFormValues);

                          return (
                            <Box key={opp.handle}>
                              {/* Opportunity header with source node label */}
                              <Typography
                                variant="body2"
                                fontWeight="bold"
                                color="text.secondary"
                                sx={{ mb: 1 }}>
                                {t("opportunity")} {index + 1}:{" "}
                                <Typography component="span" variant="body2" fontWeight="normal">
                                  {t(opp.sourceLabel, { defaultValue: opp.sourceLabel })}
                                </Typography>
                              </Typography>

                              <Stack spacing={2}>
                                {visibleFields.map((field) => (
                                  <VariableAwareInput
                                    key={`${prefix}${field.name}`}
                                    input={field}
                                    value={oppValues[field.name] ?? field.defaultValue}
                                    onChange={(value) => handleInputChange(`${prefix}${field.name}`, value)}
                                    formValues={oppFormValues}
                                    schemaDefs={process.$defs}
                                    layerDatasetIds={{
                                      ...layerDatasetIds,
                                      ...(opp.sourceDatasetId ? { input_path: opp.sourceDatasetId } : {}),
                                    }}
                                    predictedColumns={{
                                      ...predictedColumns,
                                      ...(opp.sourcePredictedCols
                                        ? { input_path: opp.sourcePredictedCols }
                                        : {}),
                                    }}
                                    variables={variables}
                                  />
                                ))}
                              </Stack>

                              {/* Divider between opportunities */}
                              {index < connectedOpportunities.length - 1 && <Divider sx={{ mt: 2 }} />}
                            </Box>
                          );
                        })}
                      </Stack>
                    }
                  />
                </Box>
              )}

              {/* Dataset Details Section - shown for completed tools with results */}
              {nodeStatus === "completed" && hasTempResult && tempLayerMetadata && (
                <>
                  <Box sx={{ mt: 3, mb: 2 }}>
                    <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                      {t("dataset_details")}
                    </Typography>
                    <Divider sx={{ mb: 1.5 }} />
                  </Box>

                  <Stack spacing={1.5}>
                    {/* Created at */}
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

                    {/* Features count */}
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="body2" color="text.secondary">
                        {t("features")}:
                      </Typography>
                      <Typography variant="body2">
                        {tempLayerMetadata.featureCount.toLocaleString()}
                      </Typography>
                    </Stack>

                    {/* Geometry types */}
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

              {/* Actions Section - shown for completed tools with results */}
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
                      <Button
                        variant={activeDataPanelView === "map" ? "contained" : "outlined"}
                        size="small"
                        startIcon={<Icon iconName={ICON_NAME.MAP} style={{ fontSize: 16 }} />}
                        onClick={() => dispatch(requestMapView())}
                        sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold", flex: 1 }}>
                        {t("map")}
                      </Button>
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

        {/* Save Dataset Dialog */}
        <SaveDatasetDialog
          open={saveDialogOpen}
          onClose={() => setSaveDialogOpen(false)}
          onSave={handleSaveDataset}
          defaultName={process.title || node.data.label || ""}
          isSaving={isSaving}
        />
      </>
    );
  }

  // Fallback
  return (
    <Container
      header={<ToolsHeader onBack={onBack} title={t("node_settings")} />}
      disablePadding={false}
      body={
        <Typography variant="body2" color="text.secondary">
          {t("unknown_node_type")}
        </Typography>
      }
    />
  );
}

// ----- Export Node Settings (inline sub-component) -----

/** A dataset rows can go into: a feature layer or a table. Whether the user
 * may edit it is not judged from the list's role but by the write-access
 * check (the rule the run uses), which warns right after the pick. */
export const canAppendTo = (item: ContentItem): boolean =>
  item.type === "layer" && ((item as { layer_type?: string }).layer_type ?? "feature") !== "raster";

interface ExportExistingTargetProps {
  data: ExportNodeData;
  onChange: (changes: Partial<ExportNodeData>) => void;
}

/**
 * "Existing dataset" in the "Save as dataset" panel, laid out like the
 * "Dataset name *" field it replaces: which dataset the rows are added to.
 * The columns must match the dataset's; "Add to project" is the panel's own.
 */
function ExportExistingTarget({ data, onChange }: ExportExistingTargetProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [pickerOpen, setPickerOpen] = useState(false);
  const { canWrite } = useLayerWriteAccess(data.targetLayerId);

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      <Typography variant="body2" color="text.secondary">
        {t("append_target_layer")} *
      </Typography>
      {data.targetLayerId && (
        <Stack direction="row" alignItems="center" spacing={1}>
          <Icon
            iconName={ICON_NAME.LAYERS}
            style={{ fontSize: 14 }}
            htmlColor={theme.palette.text.secondary}
          />
          <Typography
            variant="body2"
            fontWeight="bold"
            sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            {data.targetLayerName}
          </Typography>
        </Stack>
      )}
      <Button
        variant="outlined"
        size="small"
        fullWidth
        startIcon={
          <Icon
            iconName={data.targetLayerId ? ICON_NAME.LAYERS : ICON_NAME.PLUS}
            style={{ fontSize: data.targetLayerId ? 16 : 15 }}
          />
        }
        onClick={() => setPickerOpen(true)}
        sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold" }}>
        {data.targetLayerId ? t("change_dataset") : t("append_choose_target")}
      </Button>

      {data.targetLayerId && canWrite === false && (
        <Alert severity="warning" sx={{ py: 0 }}>
          {t("append_no_edit_rights_detail")}
        </Alert>
      )}

      <DatasetPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(item) => onChange({ targetLayerId: item.id, targetLayerName: item.name })}
        canPick={canAppendTo}
        cannotPickLabel={t("append_target_wrong_type")}
      />
    </Stack>
  );
}

interface ExportNodeSettingsInlineProps {
  node: WorkflowNode;
  exportData: ExportNodeData;
  nodeStatus: string | undefined;
  upstreamInfo: { label: string } | null;
  onBack: () => void;
}

function ExportNodeSettingsInline({
  node,
  exportData,
  nodeStatus,
  upstreamInfo,
  onBack,
}: ExportNodeSettingsInlineProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useDispatch<AppDispatch>();

  // Local state for form values — provides instant UI updates.
  // Redux is updated as a side effect (same pattern as tool nodes).
  const [datasetName, setDatasetName] = useState(exportData.datasetName || "");
  const [addToProject, setAddToProject] = useState(exportData.addToProject);
  const [overwritePrevious, setOverwritePrevious] = useState(exportData.overwritePrevious);
  const isExisting = exportData.destination === "existing";

  const saveToItems: SelectorItem[] = useMemo(
    () => [
      { value: "new", label: t("export_mode_new"), icon: ICON_NAME.PLUS },
      { value: "existing", label: t("export_mode_existing"), icon: ICON_NAME.LAYERS },
    ],
    [t]
  );

  // Several fields at once (the "Add to existing" settings)
  const saveChanges = useCallback(
    (changes: Partial<ExportNodeData>) => {
      dispatch(updateNode({ id: node.id, changes: { data: { ...node.data, ...changes } } }));
    },
    [dispatch, node.id, node.data]
  );

  // Persist a field change to Redux (side effect, not driving UI)
  const syncToRedux = useCallback(
    (field: keyof ExportNodeData, value: unknown) => saveChanges({ [field]: value }),
    [saveChanges]
  );

  const handleDatasetNameChange = useCallback(
    (e: { target: { value: string } }) => {
      const val = e.target.value;
      setDatasetName(val);
      syncToRedux("datasetName", val);
    },
    [syncToRedux]
  );

  const handleAddToProjectChange = useCallback(
    (_: React.SyntheticEvent, checked: boolean) => {
      setAddToProject(checked);
      syncToRedux("addToProject", checked);
    },
    [syncToRedux]
  );

  const handleOverwriteChange = useCallback(
    (_: React.SyntheticEvent, checked: boolean) => {
      setOverwritePrevious(checked);
      syncToRedux("overwritePrevious", checked);
    },
    [syncToRedux]
  );

  return (
    <Container
      header={<ToolsHeader onBack={onBack} title={t("export_dataset")} />}
      disablePadding={false}
      body={
        <Box sx={{ display: "flex", flexDirection: "column" }}>
          {/* Description */}
          <Typography variant="body2" sx={{ fontStyle: "italic", mb: theme.spacing(4) }}>
            {t("export_dataset_description")}
          </Typography>

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

          {/* Parameters Section */}
          <Box sx={{ mt: 3, mb: 2 }}>
            <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
              {t("parameters")}
            </Typography>
            <Divider sx={{ mb: 1.5 }} />
          </Box>

          {/* Source connection info */}
          {upstreamInfo && (
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="body2" color="text.secondary">
                {t("receives_output_from")}:
              </Typography>
              <Typography variant="body2" fontWeight="bold">
                {t(upstreamInfo.label, { defaultValue: upstreamInfo.label })}
              </Typography>
            </Stack>
          )}

          {/* New dataset, or add the rows to an existing one */}
          <Box sx={{ mb: 2 }}>
            <Selector
              selectedItems={saveToItems.find((item) => item.value === (isExisting ? "existing" : "new"))}
              setSelectedItems={(item) => {
                const picked = Array.isArray(item) ? item[0] : item;
                if (picked) saveChanges({ destination: picked.value as "new" | "existing" });
              }}
              items={saveToItems}
              label={t("export_save_to")}
              tooltip={t("export_save_to_help")}
            />
          </Box>

          {isExisting && <ExportExistingTarget data={exportData} onChange={saveChanges} />}

          {/* Dataset name */}
          {!isExisting && (
            <Stack spacing={1} sx={{ mb: 2 }}>
              <Typography variant="body2" color="text.secondary">
                {t("dataset_name")} *
              </Typography>
              <TextField
                fullWidth
                size="small"
                required
                placeholder={t("enter_dataset_name")}
                value={datasetName}
                onChange={handleDatasetNameChange}
                error={!datasetName.trim()}
                helperText={!datasetName.trim() ? t("dataset_name_required") : undefined}
                inputProps={{
                  style: { fontSize: "0.875rem" },
                }}
              />
            </Stack>
          )}

          {/* Options */}
          <FormControlLabel
            control={<Checkbox checked={addToProject} onChange={handleAddToProjectChange} size="small" />}
            label={<Typography variant="body2">{t("add_to_project")}</Typography>}
            sx={{ ml: 0, mb: 0.5 }}
          />

          {!isExisting && (
            <FormControlLabel
              control={<Checkbox checked={overwritePrevious} onChange={handleOverwriteChange} size="small" />}
              label={<Typography variant="body2">{t("overwrite_on_rerun")}</Typography>}
              sx={{ ml: 0 }}
            />
          )}

          {/* Completed state info */}
          {!isExisting && nodeStatus === "completed" && exportData.exportedLayerId && (
            <Box sx={{ mt: 3, mb: 2 }}>
              <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                {t("result")}
              </Typography>
              <Divider sx={{ mb: 1.5 }} />
              <Stack direction="row" alignItems="center" spacing={1}>
                <CheckCircleIcon sx={{ fontSize: 16, color: "success.main" }} />
                <Typography variant="body2" color="success.main" fontWeight="bold">
                  {t("dataset_exported_successfully")}
                </Typography>
              </Stack>
            </Box>
          )}

          {/* Error state */}
          {nodeStatus === "failed" && exportData.error && (
            <Box sx={{ mt: 3, mb: 2 }}>
              <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
                {t("result")}
              </Typography>
              <Divider sx={{ mb: 1.5 }} />
              <Typography variant="body2" color="error.main">
                {exportData.error}
              </Typography>
            </Box>
          )}
        </Box>
      }
    />
  );
}
