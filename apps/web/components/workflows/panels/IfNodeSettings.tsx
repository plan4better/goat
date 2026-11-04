"use client";

import BlockIcon from "@mui/icons-material/Block";
import VariableIcon from "@mui/icons-material/DataObject";
import DeleteIcon from "@mui/icons-material/Delete";
import {
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  InputAdornment,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEdges } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { v4 as uuidv4 } from "uuid";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { apiRequestAuth } from "@/lib/api/fetcher";
import { predictNodeSchema, useWorkflowMetadata } from "@/lib/api/workflows";
import type { InputSchemaInfo } from "@/lib/api/workflows";
import { GEOAPI_BASE_URL } from "@/lib/constants";
import type { AppDispatch, RootState } from "@/lib/store";
import {
  selectNodes,
  selectSelectedWorkflowId,
  selectVariables,
} from "@/lib/store/workflow/selectors";
import { updateNode } from "@/lib/store/workflow/slice";
import {
  type Expression as ExpressionType,
  FilterType,
} from "@/lib/validations/filter";
import {
  type IfNodeData,
  type IfStatisticExpression,
  type WorkflowNode,
  type WorkflowVariable,
  getVariableDisplayName,
  hasVariableLabel,
} from "@/lib/validations/workflow";

import type { LayerFieldType } from "@/lib/validations/layer";
import type { ProjectLayer } from "@/lib/validations/project";

import type { SelectorItem } from "@/types/map/common";

import useLayerFields from "@/hooks/map/CommonHooks";
import useLogicalExpressionOperations from "@/hooks/map/FilteringHooks";

// Normalize a DuckDB column type to the filter UI's categories (as useLayerFields does).
const normalizeMetadataType = (raw: string): string => {
  const t = raw.toUpperCase();
  if (
    t.includes("INT") ||
    t === "DOUBLE" ||
    t === "FLOAT" ||
    t === "REAL" ||
    t.startsWith("DECIMAL") ||
    t.startsWith("NUMERIC")
  ) {
    return "number";
  }
  if (t === "BOOLEAN" || t === "BOOL") return "boolean";
  if (t.includes("DATE") || t.includes("TIME")) return "date";
  if (t === "GEOMETRY") return "object";
  return "string";
};

const HIDDEN_METADATA_FIELDS = new Set([
  "layer_id",
  "id",
  "h3_3",
  "h3_6",
  "geom",
  "geometry",
]);

const metadataColumnsToLayerFields = (
  columns: Record<string, string> | null | undefined
): LayerFieldType[] => {
  if (!columns) return [];
  return Object.entries(columns)
    .filter(([name]) => !HIDDEN_METADATA_FIELDS.has(name))
    .map(([name, type]) => ({ name, type: normalizeMetadataType(type) }));
};

// Fetch a dataset layer's columns from the OGC queryables API.
async function fetchLayerColumns(
  layerUuid: string
): Promise<Record<string, string>> {
  try {
    const response = await apiRequestAuth(
      `${GEOAPI_BASE_URL}/collections/${layerUuid}/queryables`
    );
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

import FormLabelHelper from "@/components/common/FormLabelHelper";
import Container from "@/components/map/panels/Container";
import LayerFieldSelector from "@/components/map/common/LayerFieldSelector";
import Selector from "@/components/map/panels/common/Selector";
import ToolsHeader from "@/components/map/panels/common/ToolsHeader";
import StepIssuesSummary from "@/components/workflows/issues/StepIssuesSummary";
import { useStepIssues } from "@/components/workflows/issues/WorkflowIssuesContext";
import { useStepFieldFocus } from "@/hooks/workflows/useStepFieldFocus";
import { useNodeExecutionStatus } from "@/components/workflows/context/WorkflowExecutionContext";
import WorkflowVariableMenuItem from "@/components/workflows/inputs/WorkflowVariableMenuItem";

interface IfNodeSettingsProps {
  node: WorkflowNode;
  projectLayers?: ProjectLayer[];
  onBack: () => void;
}

// Resolve a dataset node's layerId (UUID or numeric project-layer id) to a layer UUID.
const resolveDatasetLayerUuid = (
  layerIdValue: string,
  projectLayers: ProjectLayer[]
): string | undefined => {
  const isUUID = layerIdValue.includes("-") && layerIdValue.length > 20;
  if (isUUID) return layerIdValue;
  const numericId = parseInt(layerIdValue, 10);
  if (Number.isNaN(numericId)) return undefined;
  const layer = projectLayers.find((l) => l.id === numericId);
  return layer?.layer_id;
};

interface ConditionState {
  op: "and" | "or";
  expressions: Array<ExpressionType | IfStatisticExpression>;
}

const isStatisticRow = (
  e: ExpressionType | IfStatisticExpression
): e is IfStatisticExpression => (e as IfStatisticExpression).kind === "statistic";

const VARIABLE_REF_REGEX = /^\{\{@([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/;

// Operators that produce a boolean from the field alone — no value input.
const VALUE_LESS_OPERATORS = new Set([
  "is_blank",
  "is_not_blank",
  "is_empty_string",
  "is_not_empty_string",
]);

// Operators that take a list of values; user enters them comma-separated.
const MULTI_VALUE_OPERATORS = new Set(["includes", "excludes"]);

// Operators hidden because they read misleadingly under "any feature matches".
const LOGICAL_OPERATORS_REMOVED = new Set([
  "is",
  "is_not",
  "is_empty_string",
  "is_not_empty_string",
  "does_not_contains_the_text",
]);

interface VariableTextFieldProps {
  value: string;
  onChange: (next: string) => void;
  variables: WorkflowVariable[];
  placeholder?: string;
  appendSeparator?: string;
}

export function VariableTextField({
  value,
  onChange,
  variables,
  placeholder,
  appendSeparator,
}: VariableTextFieldProps) {
  const { t } = useTranslation("common");
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const isVariableRef = VARIABLE_REF_REGEX.test(value);
  // A field holding exactly one labelled variable shows that label beneath it.
  const referencedVariable = useMemo(() => {
    const match = value.match(VARIABLE_REF_REGEX);
    return match ? variables.find((v) => v.name === match[1]) : undefined;
  }, [value, variables]);
  const referencedLabel =
    referencedVariable && hasVariableLabel(referencedVariable)
      ? getVariableDisplayName(referencedVariable)
      : undefined;

  const insertVariable = useCallback(
    (varName: string) => {
      const token = `{{@${varName}}}`;
      const next = value ? `${value}${appendSeparator ?? ""}${token}` : token;
      onChange(next);
      setMenuOpen(false);
    },
    [value, onChange, appendSeparator]
  );

  return (
    <>
      <TextField
        size="small"
        fullWidth
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        helperText={referencedLabel}
        sx={
          isVariableRef
            ? {
                "& input": {
                  color: "primary.main",
                  fontFamily: "monospace",
                  fontSize: "0.75rem",
                },
              }
            : undefined
        }
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip
                title={t("insert_variable", { defaultValue: "Insert workflow variable" })}
                arrow>
                <IconButton
                  size="small"
                  ref={buttonRef}
                  onClick={() => setMenuOpen((v) => !v)}
                  sx={{ color: "text.secondary", "&:hover": { color: "primary.main" } }}>
                  <VariableIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ),
        }}
      />
      <Menu
        anchorEl={buttonRef.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}>
        {variables.length === 0 ? (
          <MenuItem disabled>
            <Typography variant="caption" color="text.secondary">
              {t("no_workflow_variables_defined", {
                defaultValue: "No workflow variables defined yet",
              })}
            </Typography>
          </MenuItem>
        ) : (
          variables.map((v) => (
            <WorkflowVariableMenuItem key={v.id} variable={v} onSelect={(selected) => insertVariable(selected.name)} />
          ))
        )}
      </Menu>
    </>
  );
}

function ConditionRowHeader({
  iconName,
  title,
  onDelete,
}: {
  iconName: ICON_NAME;
  title: string;
  onDelete: () => void;
}) {
  const { t } = useTranslation("common");
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Stack direction="row" alignItems="center">
        <Icon
          iconName={iconName}
          style={{ fontSize: 17, color: "var(--mui-palette-text-secondary, #888)" }}
        />
        <Typography variant="body2" fontWeight="bold" sx={{ pl: 2 }}>
          {title}
        </Typography>
      </Stack>
      <Tooltip title={t("delete")} arrow placement="top">
        <IconButton size="small" onClick={onDelete}>
          <DeleteIcon fontSize="small" color="error" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

// Logical-filter editor with a free-form value input so conditionals can test
// arbitrary thresholds and {{@var}} references, not just existing layer values.
interface LogicalConditionRowProps {
  expression: ExpressionType;
  fields: LayerFieldType[];
  variables: WorkflowVariable[];
  onUpdate: (next: ExpressionType) => void;
  onDelete: (id: string) => void;
}

function LogicalConditionRow({
  expression,
  fields,
  variables,
  onUpdate,
  onDelete,
}: LogicalConditionRowProps) {
  const { t } = useTranslation("common");

  const selectedField = useMemo(
    () => fields.find((f) => f.name === expression.attribute),
    [fields, expression.attribute]
  );

  const { logicalExpressionTypes: rawOperators } = useLogicalExpressionOperations(
    selectedField?.type
  );

  // Hide operators whose semantic is misleading under "any feature matches".
  const logicalExpressionTypes = useMemo(
    () =>
      rawOperators.filter(
        (o) => !LOGICAL_OPERATORS_REMOVED.has(String(o.value))
      ),
    [rawOperators]
  );

  const selectedOperation = useMemo(
    () => logicalExpressionTypes.find((o) => o.value === expression.expression),
    [logicalExpressionTypes, expression.expression]
  );

  const showValue =
    !!selectedField &&
    !!expression.expression &&
    !VALUE_LESS_OPERATORS.has(expression.expression);

  return (
    <Stack direction="column">
      <ConditionRowHeader
        iconName={ICON_NAME.TABLE}
        title={t("logical_expression", { defaultValue: "Logical Expression" })}
        onDelete={() => onDelete(expression.id)}
      />

      <Stack direction="column" spacing={2}>
        <LayerFieldSelector
          fields={fields}
          selectedField={selectedField}
          setSelectedField={(field) =>
            onUpdate({
              ...expression,
              attribute: field?.name || "",
              expression: "",
              value: "",
            })
          }
          label={t("select_field")}
        />

        {selectedField && (
          <Selector
            selectedItems={selectedOperation}
            setSelectedItems={(item) => {
              const op = (item as SelectorItem | undefined)?.value as string | undefined;
              if (!op) return;
              onUpdate({ ...expression, expression: op, value: "" });
            }}
            items={logicalExpressionTypes}
            label={t("select_operator")}
          />
        )}

        {showValue && (
          <Box>
            <FormLabelHelper
              label={t("select_value")}
              color="inherit"
              tooltip={
                MULTI_VALUE_OPERATORS.has(expression.expression)
                  ? t("multi_value_hint", { defaultValue: "Enter multiple values separated by commas" })
                  : undefined
              }
            />
            <VariableTextField
              value={
                Array.isArray(expression.value)
                  ? expression.value.map(String).join(", ")
                  : String(expression.value ?? "")
              }
              onChange={(next) => {
                if (MULTI_VALUE_OPERATORS.has(expression.expression)) {
                  const parts = next
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                  onUpdate({ ...expression, value: parts });
                } else {
                  onUpdate({ ...expression, value: next });
                }
              }}
              variables={variables}
              appendSeparator={
                MULTI_VALUE_OPERATORS.has(expression.expression) ? ", " : undefined
              }
              placeholder={
                MULTI_VALUE_OPERATORS.has(expression.expression)
                  ? t("multi_value_placeholder", {
                      defaultValue: "value1, value2, value3",
                    })
                  : t("select_value")
              }
            />
          </Box>
        )}
      </Stack>
    </Stack>
  );
}

interface StatisticConditionRowProps {
  expression: IfStatisticExpression;
  fields: LayerFieldType[];
  variables: WorkflowVariable[];
  onUpdate: (next: IfStatisticExpression) => void;
  onDelete: (id: string) => void;
}

type StatisticMethod = NonNullable<IfStatisticExpression["method"]>;
type ComparisonOperator = NonNullable<IfStatisticExpression["operator"]>;

const STATISTIC_METHODS: { value: StatisticMethod; labelKey: string }[] = [
  { value: "count", labelKey: "count" },
  { value: "sum", labelKey: "sum" },
  { value: "mean", labelKey: "mean" },
  { value: "median", labelKey: "median" },
  { value: "min", labelKey: "min" },
  { value: "max", labelKey: "max" },
];

const COMPARISON_OPERATORS: { value: ComparisonOperator; labelKey: string }[] = [
  { value: "=", labelKey: "filter_expressions.is" },
  { value: "!=", labelKey: "filter_expressions.is_not" },
  { value: ">", labelKey: "filter_expressions.is_greater_than" },
  { value: ">=", labelKey: "filter_expressions.is_at_least" },
  { value: "<", labelKey: "filter_expressions.is_less_than" },
  { value: "<=", labelKey: "filter_expressions.is_at_most" },
];

function StatisticConditionRow({
  expression,
  fields,
  variables,
  onUpdate,
  onDelete,
}: StatisticConditionRowProps) {
  const { t } = useTranslation("common");

  const methodItems: SelectorItem[] = useMemo(
    () =>
      STATISTIC_METHODS.map((m) => ({
        value: m.value,
        label: t(m.labelKey, { defaultValue: m.value }),
      })),
    [t]
  );

  const operatorItems: SelectorItem[] = useMemo(
    () => COMPARISON_OPERATORS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
    [t]
  );

  // Numeric fields only for sum/mean/median/min/max; count(*) needs no field.
  const eligibleFields = useMemo<LayerFieldType[]>(() => {
    if (expression.method === "count" || !expression.method) return fields;
    return fields.filter((f) => f.type === "number");
  }, [fields, expression.method]);

  const selectedField = useMemo(
    () => eligibleFields.find((f) => f.name === expression.field),
    [eligibleFields, expression.field]
  );

  // Show the field selector once the user has chosen a method (other than count).
  const fieldVisible = !!expression.method && expression.method !== "count";

  return (
    <Stack direction="column">
      <ConditionRowHeader
        iconName={ICON_NAME.CHART}
        title={t("statistic_expression", { defaultValue: "Statistic Expression" })}
        onDelete={() => onDelete(expression.id)}
      />

      <Stack direction="column" spacing={2}>
        <Selector
          selectedItems={methodItems.find((i) => i.value === expression.method)}
          setSelectedItems={(item) => {
            const m = (item as SelectorItem | undefined)?.value as
              | IfStatisticExpression["method"]
              | undefined;
            if (!m) return;
            onUpdate({
              ...expression,
              method: m,
              // Reset field when switching to/from count
              field: m === "count" ? undefined : expression.field,
            });
          }}
          items={methodItems}
          label={t("select_operation")}
          placeholder={t("select_option")}
        />

        {fieldVisible && (
          <LayerFieldSelector
            fields={eligibleFields}
            selectedField={selectedField}
            setSelectedField={(field) =>
              onUpdate({ ...expression, field: field?.name })
            }
            label={t("select_field")}
            tooltip={t("select_numeric_field_for_statistics")}
          />
        )}

        {/* Comparison row only after the method is set. */}
        {expression.method && (
          <>
            <Selector
              selectedItems={operatorItems.find((i) => i.value === expression.operator)}
              setSelectedItems={(item) => {
                const op = (item as SelectorItem | undefined)?.value as
                  | IfStatisticExpression["operator"]
                  | undefined;
                if (!op) return;
                onUpdate({ ...expression, operator: op });
              }}
              items={operatorItems}
              label={t("select_operator")}
            />
            <Box>
              <FormLabelHelper label={t("select_value")} color="inherit" />
              <VariableTextField
                value={String(expression.value ?? "")}
                onChange={(next) => onUpdate({ ...expression, value: next })}
                variables={variables}
                placeholder={t("select_value")}
              />
            </Box>
          </>
        )}
      </Stack>
    </Stack>
  );
}

export default function IfNodeSettings({
  node,
  projectLayers = [],
  onBack,
}: IfNodeSettingsProps) {
  const { t } = useTranslation("common");
  const stepIssues = useStepIssues(node.id);
  const settingsRef = useStepFieldFocus(node.id);
  const dispatch = useDispatch<AppDispatch>();
  const edges = useEdges();
  const nodes = useSelector((state: RootState) => selectNodes(state));
  const workflowVariables = useSelector(selectVariables);
  const workflowId = useSelector(selectSelectedWorkflowId);
  const { metadata: workflowMetadata } = useWorkflowMetadata(workflowId ?? undefined);
  const { status: runtimeStatus } = useNodeExecutionStatus(node.id);

  const data = node.data as IfNodeData;

  // Resolve the upstream source so the field selectors know what to offer.
  const upstreamSource = useMemo<
    | { kind: "dataset"; layerId: string }
    | { kind: "tool"; nodeId: string }
    | undefined
  >(() => {
    let targetId = node.id;
    for (let i = 0; i < 50; i++) {
      const incoming = edges.find((e) => e.target === targetId);
      if (!incoming) return undefined;
      const sourceNode = nodes.find((n) => n.id === incoming.source);
      if (!sourceNode) return undefined;
      const d = sourceNode.data as Record<string, unknown> | undefined;
      if (d?.type === "dataset" && typeof d.layerId === "string") {
        const uuid = resolveDatasetLayerUuid(d.layerId, projectLayers);
        if (uuid) return { kind: "dataset", layerId: uuid };
        return undefined;
      }
      if (d?.type === "tool") {
        return { kind: "tool", nodeId: sourceNode.id };
      }
      if (d?.type === "if") {
        targetId = sourceNode.id;
        continue;
      }
      return undefined;
    }
    return undefined;
  }, [edges, node.id, nodes, projectLayers]);

  // Dataset source: fetch fields via the queryables API.
  const datasetLayerId =
    upstreamSource?.kind === "dataset" ? upstreamSource.layerId : "";
  const { layerFields: datasetFields } = useLayerFields(datasetLayerId);

  // Predicted columns for an upstream tool that hasn't executed yet, keyed by source node id.
  const [predictedColumns, setPredictedColumns] = useState<
    Record<string, Record<string, string>>
  >({});
  const predictionFetchedRef = useRef<string>("");

  useEffect(() => {
    if (!workflowId) return;
    if (upstreamSource?.kind !== "tool") return;
    const sourceNodeId = upstreamSource.nodeId;
    // Metadata already has it — no prediction needed.
    if (workflowMetadata?.nodes[sourceNodeId]?.columns) return;

    const fetchKey = `${workflowId}:${sourceNodeId}`;
    if (fetchKey === predictionFetchedRef.current) return;

    const resolveNodeColumns = async (
      nodeId: string,
      cache: Record<string, Record<string, string>>,
      visited: Set<string>
    ): Promise<Record<string, string>> => {
      if (visited.has(nodeId)) return {};
      visited.add(nodeId);
      if (cache[nodeId]) return cache[nodeId];

      if (workflowMetadata?.nodes[nodeId]?.columns) {
        const cols = workflowMetadata.nodes[nodeId].columns!;
        cache[nodeId] = cols;
        return cols;
      }

      const targetNode = nodes.find((n) => n.id === nodeId);
      if (!targetNode) return {};
      const targetData = targetNode.data as Record<string, unknown>;

      if (targetData?.type === "dataset" && targetData.layerId) {
        const layerIdValue = targetData.layerId as string;
        const layerUuid = resolveDatasetLayerUuid(layerIdValue, projectLayers);
        if (!layerUuid) return {};
        const cols = await fetchLayerColumns(layerUuid);
        cache[nodeId] = cols;
        return cols;
      }

      if (targetData?.type === "tool") {
        const processId = targetData.processId as string;
        const config = (targetData.config || {}) as Record<string, unknown>;
        const inputSchemas: Record<string, InputSchemaInfo> = {};
        const incomingEdges = edges.filter((e) => e.target === nodeId);

        for (const edge of incomingEdges) {
          const inputName = edge.targetHandle || "input_layer_id";
          const sourceColumns = await resolveNodeColumns(
            edge.source,
            cache,
            visited
          );
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

    (async () => {
      const cache: Record<string, Record<string, string>> = {};
      const cols = await resolveNodeColumns(sourceNodeId, cache, new Set());
      if (Object.keys(cols).length > 0) {
        setPredictedColumns((prev) => ({ ...prev, [sourceNodeId]: cols }));
      }
      predictionFetchedRef.current = fetchKey;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, upstreamSource, workflowMetadata]);

  // Field list priority: executed metadata > predicted > queryables (dataset).
  const upstreamFields = useMemo<LayerFieldType[]>(() => {
    if (!upstreamSource) return [];
    if (upstreamSource.kind === "dataset") return datasetFields || [];
    const metaCols = workflowMetadata?.nodes[upstreamSource.nodeId]?.columns;
    if (metaCols) return metadataColumnsToLayerFields(metaCols);
    return metadataColumnsToLayerFields(predictedColumns[upstreamSource.nodeId]);
  }, [upstreamSource, datasetFields, workflowMetadata, predictedColumns]);

  const hasUpstream = !!upstreamSource;

  const [condition, setCondition] = useState<ConditionState>(() => ({
    op: (data.condition?.op as "and" | "or") || "and",
    expressions: ((data.condition?.expressions as ConditionState["expressions"] | undefined) ?? []),
  }));

  // "Add expression" menu state
  const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(menuAnchorEl);

  // Reset local state when the active node changes
  useEffect(() => {
    setCondition({
      op: (data.condition?.op as "and" | "or") || "and",
      expressions: ((data.condition?.expressions as ConditionState["expressions"] | undefined) ?? []),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const logicalOperators: SelectorItem[] = useMemo(
    () => [
      { value: "and", label: t("match_all_filters") },
      { value: "or", label: t("match_at_least_one_filter") },
    ],
    [t]
  );

  const persist = useCallback(
    (next: Partial<IfNodeData>) => {
      dispatch(
        updateNode({
          id: node.id,
          changes: { data: { ...data, ...next } },
        })
      );
    },
    [dispatch, node.id, data]
  );

  const saveCondition = useCallback(
    (next: ConditionState) => {
      setCondition(next);
      persist({
        condition:
          next.expressions.length > 0
            ? { op: next.op, expressions: next.expressions as Record<string, unknown>[] }
            : undefined,
      });
    },
    [persist]
  );

  const handleAddExpression = useCallback(
    (kind: "logical" | "statistic") => {
      setMenuAnchorEl(null);
      // Empty row — the user fills in the row-specific fields.
      let newRow: ExpressionType | IfStatisticExpression;
      if (kind === "statistic") {
        newRow = { id: uuidv4(), kind: "statistic" } as IfStatisticExpression;
      } else {
        newRow = {
          id: uuidv4(),
          attribute: "",
          expression: "",
          value: "",
          type: FilterType.Logical,
        } as ExpressionType;
      }
      saveCondition({
        ...condition,
        expressions: [...condition.expressions, newRow],
      });
    },
    [condition, saveCondition]
  );

  const handleExpressionUpdate = useCallback(
    (updated: ExpressionType | IfStatisticExpression) => {
      saveCondition({
        ...condition,
        expressions: condition.expressions.map((e) => (e.id === updated.id ? updated : e)),
      });
    },
    [condition, saveCondition]
  );

  const handleExpressionDelete = useCallback(
    (id: string) => {
      saveCondition({
        ...condition,
        expressions: condition.expressions.filter((e) => e.id !== id),
      });
    },
    [condition, saveCondition]
  );

  const handleClearFilter = useCallback(() => {
    saveCondition({ op: condition.op, expressions: [] });
  }, [condition.op, saveCondition]);

  const handleOperatorChange = useCallback(
    (item: SelectorItem | SelectorItem[] | undefined) => {
      const op = (item as SelectorItem | undefined)?.value as "and" | "or" | undefined;
      if (!op) return;
      saveCondition({ ...condition, op });
    },
    [condition, saveCondition]
  );

  const areAllExpressionsValid = useMemo(
    () =>
      condition.expressions.every((e) => {
        if (isStatisticRow(e)) {
          const needsField = e.method !== "count";
          const v = String(e.value ?? "").trim();
          return !!e.method && !!e.operator && v !== "" && (!needsField || !!e.field);
        }
        const noValueOps = ["is_empty_string", "is_not_empty_string", "is_blank", "is_not_blank"];
        const hasValue = noValueOps.includes(e.expression || "") || !!e.value?.toString();
        return e.attribute && e.expression && hasValue;
      }),
    [condition.expressions]
  );

  const expressionTypeMenuItems = useMemo(
    () => [
      {
        kind: "logical" as const,
        icon: ICON_NAME.TABLE,
        label: t("logical_expression", { defaultValue: "Logical Expression" }),
      },
      {
        kind: "statistic" as const,
        icon: ICON_NAME.CHART,
        label: t("statistic_expression", { defaultValue: "Statistic Expression" }),
      },
    ],
    [t]
  );

  return (
    <Container
      header={
        <ToolsHeader
          onBack={onBack}
          title={data.label || t("if_node", { defaultValue: "Conditional" })}
        />
      }
      disablePadding={false}
      body={
        <Box ref={settingsRef}>
          <Typography variant="body2" sx={{ fontStyle: "italic", mb: 2 }}>
            {t("conditional_description", {
              defaultValue: "Evaluate a rule and decide how the workflow continues.",
            })}
          </Typography>

          {/* The step's issues */}
          <StepIssuesSummary issues={stepIssues} />

          {/* Execution Status Section */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="body2" fontWeight="bold" color="text.secondary" sx={{ mb: 1 }}>
              {t("execution_status")}
            </Typography>
            <Divider sx={{ mb: 1.5 }} />
            <Chip
              label={runtimeStatus ? t(runtimeStatus, { defaultValue: runtimeStatus }) : t("idle")}
              size="small"
              icon={runtimeStatus === "skipped" ? <BlockIcon sx={{ fontSize: 14 }} /> : undefined}
              color={
                runtimeStatus === "completed"
                  ? "primary"
                  : runtimeStatus === "failed"
                    ? "error"
                    : runtimeStatus === "running"
                      ? "warning"
                      : "default"
              }
              variant={runtimeStatus ? "filled" : "outlined"}
              sx={{ fontWeight: 600, textTransform: "uppercase" }}
            />
          </Box>

          <Box>
              {/* Logical operator (only when 2+ expressions) */}
              {condition.expressions.length > 1 && (
                <Box sx={{ mb: 2 }}>
                  <Divider sx={{ mb: 2 }} />
                  <Selector
                    selectedItems={logicalOperators.find((o) => o.value === condition.op)}
                    setSelectedItems={handleOperatorChange}
                    items={logicalOperators}
                    label={t("filter_results")}
                  />
                </Box>
              )}

              {/* Expression list */}
              {condition.expressions.length > 0 && (
                <Stack spacing={2} sx={{ pt: 1 }}>
                  <Divider />
                  {condition.expressions.map((expression) => {
                    if (isStatisticRow(expression)) {
                      return (
                        <StatisticConditionRow
                          key={expression.id}
                          expression={expression}
                          fields={upstreamFields}
                          variables={workflowVariables}
                          onUpdate={handleExpressionUpdate}
                          onDelete={handleExpressionDelete}
                        />
                      );
                    }
                    return (
                      <LogicalConditionRow
                        key={expression.id}
                        expression={expression}
                        fields={upstreamFields}
                        variables={workflowVariables}
                        onUpdate={handleExpressionUpdate}
                        onDelete={handleExpressionDelete}
                      />
                    );
                  })}
                </Stack>
              )}

              <Stack spacing={2} sx={{ pt: 3 }}>
                <Button
                  onClick={(e) => setMenuAnchorEl(e.currentTarget)}
                  fullWidth
                  size="small"
                  variant="outlined"
                  disabled={!hasUpstream || !areAllExpressionsValid}
                  startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 15 }} />}
                  sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold" }}>
                  {t("add_expression")}
                </Button>

                {/* Type-of-expression menu (Logical / Statistic) */}
                <Menu
                  anchorEl={menuAnchorEl}
                  open={menuOpen}
                  onClose={() => setMenuAnchorEl(null)}
                  anchorOrigin={{ vertical: "top", horizontal: "center" }}
                  transformOrigin={{ vertical: "bottom", horizontal: "center" }}>
                  {expressionTypeMenuItems.map((item) => (
                    <MenuItem
                      key={item.kind}
                      onClick={() => handleAddExpression(item.kind)}>
                      <ListItemIcon>
                        <Icon iconName={item.icon} style={{ fontSize: 15 }} />
                      </ListItemIcon>
                      <Typography variant="body2">{item.label}</Typography>
                    </MenuItem>
                  ))}
                </Menu>

                <Button
                  variant="outlined"
                  fullWidth
                  size="small"
                  color="error"
                  disabled={condition.expressions.length === 0}
                  onClick={handleClearFilter}
                  sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold" }}>
                  {t("clear_filter")}
                </Button>
              </Stack>

              {!hasUpstream && (
                <Typography variant="caption" color="warning.main" sx={{ display: "block", mt: 2 }}>
                  {t("connect_dataset_node")}
                </Typography>
              )}
          </Box>
        </Box>
      }
    />
  );
}
