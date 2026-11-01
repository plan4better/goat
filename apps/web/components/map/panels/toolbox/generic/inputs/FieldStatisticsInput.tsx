/**
 * Field Statistics Input Component
 *
 * Renders a field statistics selector that combines:
 * 1. An operation dropdown (count, sum, min, max, mean, standard_deviation)
 * 2. A field selector (when operation is not 'count')
 * 3. An optional result column name input
 *
 * The related layer is determined by widget_options.source_layer.
 */
import { Box, Stack, TextField, Typography } from "@mui/material";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { LayerFieldType } from "@/lib/validations/layer";

import type { SelectorItem } from "@/types/map/common";
import type { ProcessedInput } from "@/types/map/ogc-processes";

import useLayerFields from "@/hooks/map/CommonHooks";
import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";

import FormLabelHelper from "@/components/common/FormLabelHelper";
import LayerFieldSelector from "@/components/map/common/LayerFieldSelector";
import Selector from "@/components/map/panels/common/Selector";

// Define the statistic operations supported by the backend
const STATISTIC_OPERATIONS = [
  { value: "count", labelKey: "count" },
  { value: "sum", labelKey: "sum" },
  { value: "min", labelKey: "min" },
  { value: "max", labelKey: "max" },
  { value: "mean", labelKey: "mean" },
  { value: "standard_deviation", labelKey: "standard_deviation" },
] as const;

interface FieldStatisticsValue {
  operation: string;
  field?: string | null;
  result_name?: string | null;
}

// Stable empty object references to avoid creating new references on each render
const EMPTY_LAYER_DATASET_IDS: Record<string, string> = {};
const EMPTY_PREDICTED_COLUMNS: Record<string, Record<string, string>> = {};

/**
 * The column a statistic gets when its result name is left empty: "count"
 * for a count, else the tool's `placeholder_template` with the field and the
 * operation filled in. A tool that names none writes `{field}_{operation}`.
 */
export const defaultResultName = (
  operation: string,
  field: string | null | undefined,
  template?: unknown
): string => {
  if (!operation) return "";
  if (operation === "count") return "count";
  if (!field) return "";
  const pattern = typeof template === "string" ? template : "{field}_{operation}";
  return pattern.replace(/\{(field|operation)\}/g, (_, key: string) => (key === "field" ? field : operation));
};

interface FieldStatisticsInputProps {
  input: ProcessedInput;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  /** All current form values - needed to get the related layer's value */
  formValues: Record<string, unknown>;
  /** Map of layer input names to their dataset IDs (for connected layers in workflows) */
  layerDatasetIds?: Record<string, string>;
  /** Map of layer input names to their predicted columns (for connected tool outputs) */
  predictedColumns?: Record<string, Record<string, string>>;
}

export default function FieldStatisticsInput({
  input,
  value,
  onChange,
  disabled,
  formValues,
  layerDatasetIds,
  predictedColumns,
}: FieldStatisticsInputProps) {
  const { t } = useTranslation("common");
  const { projectId } = useParams();

  // Ensure we have safe objects to access (handles explicit undefined) - use stable references
  const safeLayerDatasetIds =
    layerDatasetIds && Object.keys(layerDatasetIds).length > 0 ? layerDatasetIds : EMPTY_LAYER_DATASET_IDS;
  const safePredictedColumns =
    predictedColumns && Object.keys(predictedColumns).length > 0 ? predictedColumns : EMPTY_PREDICTED_COLUMNS;

  // Parse the current value - backend expects array but we show single selector
  const currentValue = useMemo((): FieldStatisticsValue => {
    // Handle array format from backend
    if (Array.isArray(value) && value.length > 0) {
      const v = value[0] as FieldStatisticsValue;
      return {
        operation: v.operation || "",
        field: v.field ?? null,
        result_name: v.result_name ?? null,
      };
    }
    // Handle single object format (legacy)
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const v = value as FieldStatisticsValue;
      return {
        operation: v.operation || "",
        field: v.field ?? null,
        result_name: v.result_name ?? null,
      };
    }
    return { operation: "", field: null, result_name: null };
  }, [value]);

  // Helper to emit value in array format (backend expects List[FieldStatistic])
  const emitChange = (newValue: FieldStatisticsValue) => {
    // Only emit if there's a valid operation
    if (newValue.operation) {
      // Clean up result_name if empty string
      const cleanedValue = {
        ...newValue,
        result_name: newValue.result_name?.trim() || null,
      };
      onChange([cleanedValue]);
    } else {
      onChange(null);
    }
  };

  // Determine which layer this field relates to from widget_options.source_layer
  const relatedLayerInputName = useMemo(() => {
    const sourceLayer = input.uiMeta?.widget_options?.source_layer;
    return typeof sourceLayer === "string" ? sourceLayer : null;
  }, [input.uiMeta]);

  // Get the selected layer ID from form values
  const selectedLayerId = useMemo(() => {
    if (!relatedLayerInputName) return null;
    const layerId = formValues[relatedLayerInputName];
    return typeof layerId === "string" ? layerId : null;
  }, [relatedLayerInputName, formValues]);

  // Get project layers to find the dataset ID
  const { layers: projectLayers } = useFilteredProjectLayers(projectId as string);

  // Find the dataset ID for the selected layer
  const datasetId = useMemo(() => {
    // First check if parent provided it (for connected layers in workflows)
    if (relatedLayerInputName && safeLayerDatasetIds[relatedLayerInputName]) {
      return safeLayerDatasetIds[relatedLayerInputName];
    }

    // Otherwise try to find it from project layers
    if (!selectedLayerId || !projectLayers) return "";

    const layer = projectLayers.find(
      (l) => l.id === Number(selectedLayerId) || l.layer_id === selectedLayerId
    );
    return layer?.layer_id || "";
  }, [selectedLayerId, projectLayers, relatedLayerInputName, safeLayerDatasetIds]);

  // Check if we have predicted columns for this layer input (for connected tool outputs)
  const hasPredictedColumns = useMemo(() => {
    return relatedLayerInputName && safePredictedColumns[relatedLayerInputName] != null;
  }, [relatedLayerInputName, safePredictedColumns]);

  // Convert predicted columns to LayerFieldType format (numeric only for statistics)
  const predictedNumericFields = useMemo((): LayerFieldType[] => {
    if (!relatedLayerInputName || !safePredictedColumns[relatedLayerInputName]) {
      return [];
    }
    const columns = safePredictedColumns[relatedLayerInputName];
    return Object.entries(columns)
      .filter(([name, type]) => {
        if (["geometry", "geom", "id", "layer_id"].includes(name.toLowerCase())) return false;
        const upperType = type.toUpperCase();
        return (
          upperType.includes("INT") ||
          upperType.includes("FLOAT") ||
          upperType.includes("DOUBLE") ||
          upperType.includes("DECIMAL") ||
          upperType.includes("NUMERIC")
        );
      })
      .map(([name]) => ({
        name,
        type: "number" as const,
      }));
  }, [relatedLayerInputName, safePredictedColumns]);

  // Fetch numeric fields for the layer (skip when predicted columns are available)
  const { layerFields, isLoading } = useLayerFields(hasPredictedColumns ? "" : datasetId, "number");

  // Use predicted numeric fields if available, otherwise use layer fields
  const numericFields = useMemo((): LayerFieldType[] => {
    if (hasPredictedColumns && predictedNumericFields.length > 0) {
      return predictedNumericFields;
    }
    return layerFields as LayerFieldType[];
  }, [hasPredictedColumns, predictedNumericFields, layerFields]);

  // Check if the current operation requires a field
  const requiresField = currentValue.operation && currentValue.operation !== "count";

  // Convert the selected field name to LayerFieldType format
  const selectedField = useMemo((): LayerFieldType | undefined => {
    if (!currentValue.field || !requiresField) return undefined;
    return numericFields.find((f) => f.name === currentValue.field);
  }, [currentValue.field, numericFields, requiresField]);

  // Convert operations to SelectorItems for the Selector component
  const operationItems: SelectorItem[] = useMemo(() => {
    return STATISTIC_OPERATIONS.map((op) => ({
      value: op.value,
      label: t(op.labelKey),
    }));
  }, [t]);

  // Find selected operation item
  const selectedOperationItem = useMemo(() => {
    if (!currentValue.operation) return undefined;
    return operationItems.find((item) => item.value === currentValue.operation);
  }, [currentValue.operation, operationItems]);

  const handleOperationChange = (item: SelectorItem | SelectorItem[] | undefined) => {
    if (Array.isArray(item)) return;
    const operation = (item?.value as string) || "";
    if (operation === "count") {
      emitChange({ operation, field: null, result_name: currentValue.result_name });
    } else {
      emitChange({ operation, field: currentValue.field || null, result_name: currentValue.result_name });
    }
  };

  const handleFieldChange = (field: LayerFieldType | undefined) => {
    emitChange({
      operation: currentValue.operation,
      field: field?.name ?? null,
      result_name: currentValue.result_name,
    });
  };

  const handleResultNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    emitChange({
      operation: currentValue.operation,
      field: currentValue.field,
      result_name: event.target.value || null,
    });
  };

  // Placeholder for the result name: the name the run writes when it is empty
  const placeholderTemplate = input.uiMeta?.widget_options?.placeholder_template;
  const resultNamePlaceholder = useMemo(
    () => defaultResultName(currentValue.operation, currentValue.field, placeholderTemplate),
    [currentValue.operation, currentValue.field, placeholderTemplate]
  );

  // Get label from uiMeta or fallback to title
  const label = input.uiMeta?.label || input.title || input.name;

  // Show message if no layer is selected
  if (!selectedLayerId) {
    return (
      <Box>
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
          {label}: {t("select_layer_first")}
        </Typography>
      </Box>
    );
  }

  return (
    <Stack spacing={2}>
      {/* Operation Selector - uses Selector component like EnumInput */}
      <Selector
        selectedItems={selectedOperationItem}
        setSelectedItems={handleOperationChange}
        items={operationItems}
        label={t("select_operation")}
        placeholder={t("select_option")}
        disabled={disabled}
      />

      {/* Field Selector (hidden for count operation) */}
      {requiresField && (
        <LayerFieldSelector
          selectedField={selectedField}
          setSelectedField={handleFieldChange}
          fields={numericFields}
          label={t("select_field")}
          tooltip={t("select_numeric_field_for_statistics")}
          disabled={disabled || isLoading}
        />
      )}

      {/* Result Column Name (optional) - uses FormLabelHelper like StringInput */}
      {currentValue.operation && (
        <Stack>
          <FormLabelHelper label={t("result_column_name")} color="inherit" tooltip={t("result_column_name_helper")} />
          <TextField
            size="small"
            fullWidth
            placeholder={resultNamePlaceholder}
            value={currentValue.result_name || ""}
            onChange={handleResultNameChange}
            disabled={disabled}
          />
        </Stack>
      )}
    </Stack>
  );
}
