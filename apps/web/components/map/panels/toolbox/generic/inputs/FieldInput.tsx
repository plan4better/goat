/**
 * Field Input Component
 *
 * Renders a field selector that shows fields from a related layer.
 * The related layer is determined by:
 * 1. Explicit widget_options.source_layer in the x-ui schema
 * 2. Explicit metadata (relatedLayer) in the input schema
 * 3. Naming convention: {prefix}_field -> {prefix}_layer_id
 *
 * Supports both single and multi-select modes via widget_options.multi.
 */
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { resolveValuePath } from "@/lib/utils/ogc-utils";
import type { LayerFieldType } from "@/lib/validations/layer";

import type { ProcessedInput } from "@/types/map/ogc-processes";

import useLayerFields from "@/hooks/map/CommonHooks";
import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";

import LayerFieldSelector from "@/components/map/common/LayerFieldSelector";

// Stable empty object references to avoid creating new references on each render
const EMPTY_LAYER_DATASET_IDS: Record<string, string> = {};
const EMPTY_PREDICTED_COLUMNS: Record<string, Record<string, string>> = {};
const EMPTY_FIELDS: LayerFieldType[] = [];

interface FieldInputProps {
  input: ProcessedInput;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  /** All current form values - needed to get the related layer's value */
  formValues: Record<string, unknown>;
  /** Map of layer input names to their dataset IDs (computed by parent) */
  layerDatasetIds?: Record<string, string>;
  /** Map of layer input names to their predicted columns (for connected tool outputs) */
  predictedColumns?: Record<string, Record<string, string>>;
}

/**
 * Infer the related layer input name from a field input name
 * E.g., "target_field" -> "target_layer_id"
 *       "join_field" -> "join_layer_id"
 *       "source_field" -> "source_layer_id"
 */
function inferRelatedLayerInput(fieldInputName: string): string | null {
  // Check for explicit patterns
  const patterns = [
    { match: /^(.+)_field$/, replacement: "$1_layer_id" },
    { match: /^(.+)Field$/, replacement: "$1LayerId" },
    { match: /^field_(.+)$/, replacement: "layer_id_$1" },
  ];

  for (const pattern of patterns) {
    if (pattern.match.test(fieldInputName)) {
      return fieldInputName.replace(pattern.match, pattern.replacement);
    }
  }

  return null;
}

/**
 * Map DuckDB column types to LayerFieldType types
 */
function mapDuckDBTypeToFieldType(duckdbType: string): string {
  const upperType = duckdbType.toUpperCase();

  if (upperType.includes("INT") || upperType.includes("BIGINT")) {
    return "number";
  }
  if (upperType.includes("FLOAT") || upperType.includes("DOUBLE") || upperType.includes("DECIMAL")) {
    return "number";
  }
  if (upperType.includes("VARCHAR") || upperType.includes("TEXT") || upperType.includes("STRING")) {
    return "string";
  }
  if (upperType.includes("BOOL")) {
    return "boolean";
  }
  if (upperType.includes("DATE") || upperType.includes("TIME") || upperType.includes("TIMESTAMP")) {
    return "string"; // Dates are typically shown as strings in selectors
  }
  if (upperType.includes("GEOMETRY")) {
    return "geometry";
  }

  return "string"; // Default fallback
}

export default function FieldInput({
  input,
  value,
  onChange,
  disabled,
  formValues,
  layerDatasetIds,
  predictedColumns,
}: FieldInputProps) {
  const { t } = useTranslation("common");
  const { projectId } = useParams();

  // Ensure we have safe objects to access (handles explicit undefined) - use stable references
  const safeLayerDatasetIds =
    layerDatasetIds && Object.keys(layerDatasetIds).length > 0 ? layerDatasetIds : EMPTY_LAYER_DATASET_IDS;
  const safePredictedColumns =
    predictedColumns && Object.keys(predictedColumns).length > 0 ? predictedColumns : EMPTY_PREDICTED_COLUMNS;

  // Determine which layer this field relates to
  const relatedLayerInputName = useMemo(() => {
    // 1. Check widget_options.source_layer (preferred method from schema)
    const sourceLayer = input.uiMeta?.widget_options?.source_layer;
    if (typeof sourceLayer === "string") {
      return sourceLayer;
    }

    // 2. Check metadata for explicit relationship
    const relatedLayerMeta = input.metadata?.find(
      (m) => m.role === "relatedLayer" || m.title === "relatedLayer"
    );
    if (relatedLayerMeta?.value) {
      return relatedLayerMeta.value as string;
    }

    // 3. Fall back to naming convention
    return inferRelatedLayerInput(input.name);
  }, [input.name, input.metadata, input.uiMeta]);

  // Get the selected layer ID from form values. `source_layer` may name a
  // plain input or reach into an object-valued one (`starting_points.layer_id`),
  // which is how an input that is *either* coordinates or a layer still points
  // this at a layer when it holds one.
  const selectedLayerId = useMemo(() => {
    if (!relatedLayerInputName) return null;
    const layerId = resolveValuePath(formValues, relatedLayerInputName);
    return typeof layerId === "string" ? layerId : null;
  }, [relatedLayerInputName, formValues]);

  // Get project layers to find the dataset ID
  const { layers: projectLayers } = useFilteredProjectLayers(projectId as string);

  // Find the dataset ID for the selected layer
  const datasetId = useMemo(() => {
    // First check if parent provided it
    if (relatedLayerInputName && safeLayerDatasetIds[relatedLayerInputName]) {
      return safeLayerDatasetIds[relatedLayerInputName];
    }

    // Otherwise try to find it from project layers
    if (!selectedLayerId || !projectLayers) return "";

    // The selectedLayerId from OGC/form could be:
    // - A project layer id (number as string)
    // - A layer_id (string UUID which is the dataset_id)
    const layer = projectLayers.find(
      (l) => l.id === Number(selectedLayerId) || l.layer_id === selectedLayerId
    );
    // layer_id IS the dataset_id in the project layer schema
    return layer?.layer_id || "";
  }, [selectedLayerId, projectLayers, relatedLayerInputName, safeLayerDatasetIds]);

  // Check if we have predicted columns for this layer input (for connected tool outputs)
  const hasPredictedColumns = useMemo(() => {
    return relatedLayerInputName && safePredictedColumns[relatedLayerInputName] != null;
  }, [relatedLayerInputName, safePredictedColumns]);

  // Fetch fields for the layer (skip when predicted columns are available)
  const { layerFields, isLoading } = useLayerFields(hasPredictedColumns ? "" : datasetId);

  // Convert predicted columns to LayerFieldType format
  const predictedFields = useMemo((): LayerFieldType[] => {
    if (!relatedLayerInputName || !safePredictedColumns[relatedLayerInputName]) {
      return EMPTY_FIELDS;
    }
    const columns = safePredictedColumns[relatedLayerInputName];
    return Object.entries(columns).map(([name, type]) => ({
      name,
      type: mapDuckDBTypeToFieldType(type),
    }));
  }, [relatedLayerInputName, safePredictedColumns]);

  // Use predicted fields if available, otherwise use layer fields
  const availableFields = useMemo(() => {
    if (hasPredictedColumns && predictedFields.length > 0) {
      return predictedFields;
    }
    return layerFields.length > 0 ? layerFields : EMPTY_FIELDS;
  }, [hasPredictedColumns, predictedFields, layerFields]);

  // Get field type filter from widget_options (supports both 'field_types' and 'types')
  const fieldTypeFilter = useMemo(() => {
    const fieldTypes = input.uiMeta?.widget_options?.field_types || input.uiMeta?.widget_options?.types;
    if (Array.isArray(fieldTypes)) {
      return fieldTypes as string[];
    }
    return null;
  }, [input.uiMeta]);

  // Check if multi-select mode is enabled
  const isMultiSelect = useMemo(() => {
    return input.uiMeta?.widget_options?.multi === true || input.uiMeta?.widget_options?.multiple === true;
  }, [input.uiMeta]);

  // Filter fields by type if specified
  const filteredFields = useMemo(() => {
    if (!fieldTypeFilter || fieldTypeFilter.length === 0) {
      return availableFields;
    }
    return availableFields.filter((field) => fieldTypeFilter.includes(field.type));
  }, [availableFields, fieldTypeFilter]);

  // Opt-in: when widget_options.default_all is set, multi-select mode is active,
  // and the value is empty/unset, seed it with every available field name on
  // first render so the user sees all checkboxes ticked by default. Other
  // tools without the flag are unaffected.
  const defaultAll = input.uiMeta?.widget_options?.default_all === true;
  // Track which field set (by name content, not reference) we've already seeded.
  // Using a string key is immune to SWR returning new array references for the
  // same data, which would otherwise reset a reference-based guard and re-seed
  // after the user explicitly deselects all fields.
  const seededFieldKey = useRef("");
  useEffect(() => {
    if (!defaultAll || !isMultiSelect || filteredFields.length === 0) return;
    const fieldKey = filteredFields.map((f) => f.name).join("\0");
    if (seededFieldKey.current === fieldKey) return; // already seeded for this exact field set
    const isEmpty = value === undefined || value === null || (Array.isArray(value) && value.length === 0);
    seededFieldKey.current = fieldKey;
    if (!isEmpty) return;
    onChange(filteredFields.map((f) => f.name));
  }, [defaultAll, isMultiSelect, filteredFields, value, onChange]);

  // Convert value to LayerFieldType format (single select)
  const selectedField = useMemo((): LayerFieldType | undefined => {
    if (!value || isMultiSelect) return undefined;

    // Value might be just the field name (string) or a full object
    if (typeof value === "string") {
      return filteredFields.find((f) => f.name === value);
    }

    // If it's already an object with name/type
    if (typeof value === "object" && value !== null && "name" in value) {
      return value as LayerFieldType;
    }

    return undefined;
  }, [value, filteredFields, isMultiSelect]);

  // Convert value to LayerFieldType[] format (multi select)
  const selectedFields = useMemo((): LayerFieldType[] | undefined => {
    if (!value || !isMultiSelect) return undefined;

    // Value should be an array of field names
    if (Array.isArray(value)) {
      return value
        .map((v) => {
          if (typeof v === "string") {
            return filteredFields.find((f) => f.name === v);
          }
          if (typeof v === "object" && v !== null && "name" in v) {
            return v as LayerFieldType;
          }
          return undefined;
        })
        .filter((f): f is LayerFieldType => f !== undefined);
    }

    return undefined;
  }, [value, filteredFields, isMultiSelect]);

  const handleChange = (field: LayerFieldType | undefined) => {
    // Store just the field name for the API
    onChange(field?.name ?? null);
  };

  const handleMultiChange = (fields: LayerFieldType[] | undefined) => {
    // Store array of field names for the API
    onChange(fields?.map((f) => f.name) ?? []);
  };

  // Get label from uiMeta (already translated) or fallback to title
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

  // Show loading state while fields are being fetched
  if (isLoading) {
    return (
      <Box>
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
          {label}: {t("loading")}...
        </Typography>
      </Box>
    );
  }

  const noFields = filteredFields.length === 0;

  const errorIcon = noFields ? (
    <Tooltip title={t("no_fields_found")} arrow>
      <ErrorOutlineIcon color="error" fontSize="small" sx={{ ml: 1, mb: "8px" }} />
    </Tooltip>
  ) : null;

  // Render multi-select or single-select based on config
  if (isMultiSelect) {
    return (
      <Stack direction="row" alignItems="flex-end">
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <LayerFieldSelector
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            selectedField={selectedFields as any}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            setSelectedField={handleMultiChange as any}
            fields={filteredFields}
            label={input.title || input.name}
            tooltip={input.description}
            disabled={disabled || noFields}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            multiple={true as any}
          />
        </Box>
        {errorIcon}
      </Stack>
    );
  }

  return (
    <Stack direction="row" alignItems="flex-end">
      <Box sx={{ flex: 1 }}>
        <LayerFieldSelector
          selectedField={selectedField}
          setSelectedField={handleChange}
          fields={filteredFields}
          label={input.title || input.name}
          tooltip={input.description}
          disabled={disabled || noFields}
        />
      </Box>
      {errorIcon}
    </Stack>
  );
}
