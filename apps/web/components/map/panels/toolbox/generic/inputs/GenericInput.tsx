/**
 * Generic Input Component
 *
 * Routes to the appropriate input component based on the inferred input type.
 */
import { Divider, Stack, Typography } from "@mui/material";

import type { OGCInputSchema, ProcessedInput } from "@/types/map/ogc-processes";

import ArrayInput from "@/components/map/panels/toolbox/generic/inputs/ArrayInput";
import BooleanInput from "@/components/map/panels/toolbox/generic/inputs/BooleanInput";
import BundleInput from "@/components/map/panels/toolbox/generic/inputs/BundleInput";
import ChipsInput from "@/components/map/panels/toolbox/generic/inputs/ChipsInput";
import DateInput from "@/components/map/panels/toolbox/generic/inputs/DateInput";
import EnumInput from "@/components/map/panels/toolbox/generic/inputs/EnumInput";
import FieldInput from "@/components/map/panels/toolbox/generic/inputs/FieldInput";
import FieldStatisticsInput from "@/components/map/panels/toolbox/generic/inputs/FieldStatisticsInput";
import LayerInput from "@/components/map/panels/toolbox/generic/inputs/LayerInput";
import MultiEnumInput from "@/components/map/panels/toolbox/generic/inputs/MultiEnumInput";
import NumberInput from "@/components/map/panels/toolbox/generic/inputs/NumberInput";
import ObjectInput from "@/components/map/panels/toolbox/generic/inputs/ObjectInput";
import OevStationConfigInput from "@/components/map/panels/toolbox/generic/inputs/OevStationConfigInput";
import RepeatableObjectInput from "@/components/map/panels/toolbox/generic/inputs/RepeatableObjectInput";
import StartingPointsInput from "@/components/map/panels/toolbox/generic/inputs/StartingPointsInput";
import StringInput from "@/components/map/panels/toolbox/generic/inputs/StringInput";
import TimePickerInput from "@/components/map/panels/toolbox/generic/inputs/TimePickerInput";

interface GenericInputProps {
  input: ProcessedInput;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Callback for layer inputs to report their associated CQL filter */
  onFilterChange?: (filter: Record<string, unknown> | undefined) => void;
  /** Callback for repeatable object inputs to report nested layer filters */
  onNestedFiltersChange?: (filters: Record<string, Record<string, unknown> | undefined>[]) => void;
  disabled?: boolean;
  /** All current form values - needed for field inputs to know the selected layer */
  formValues?: Record<string, unknown>;
  /** Schema definitions ($defs) for resolving $ref in nested objects */
  schemaDefs?: Record<string, OGCInputSchema>;
  /** Layer IDs to exclude from layer selectors (for repeatable objects) */
  excludedLayerIds?: string[];
  /** Map of layer input names to their dataset IDs (for connected layers in workflows) */
  layerDatasetIds?: Record<string, string>;
  /** Map of layer input names to their predicted columns (for connected tool outputs) */
  predictedColumns?: Record<string, Record<string, string>>;
  /** Process ID for tool-specific input overrides */
  processId?: string;
  /** Callback when field validation state changes */
  onValidationChange?: (hasError: boolean) => void;
}

// Stable empty object reference to avoid creating new references on each render
const EMPTY_FORM_VALUES: Record<string, unknown> = {};

export default function GenericInput({
  input,
  value,
  onChange,
  onFilterChange,
  onNestedFiltersChange,
  disabled,
  formValues = EMPTY_FORM_VALUES,
  schemaDefs,
  excludedLayerIds,
  layerDatasetIds,
  predictedColumns,
  processId,
  onValidationChange,
}: GenericInputProps) {
  // Ensure formValues is always an object (handles explicit undefined) - use stable reference
  const safeFormValues = formValues && Object.keys(formValues).length > 0 ? formValues : EMPTY_FORM_VALUES;

  if (processId === "oev_gueteklassen" && input.name === "station_config") {
    return <OevStationConfigInput input={input} value={value} onChange={onChange} disabled={disabled} />;
  }

  const groupLabel = input.uiMeta?.group_label;

  const renderInput = () => { switch (input.inputType) {
    case "layer":
      return (
        <LayerInput
          input={input}
          value={value as string | undefined}
          onChange={onChange}
          onFilterChange={onFilterChange}
          disabled={disabled}
          excludedLayerIds={excludedLayerIds}
        />
      );

    case "bundle":
      return (
        <BundleInput
          input={input}
          value={value as string | undefined}
          onChange={onChange}
          disabled={disabled}
        />
      );

    case "field":
      return (
        <FieldInput
          input={input}
          value={value}
          onChange={onChange}
          disabled={disabled}
          formValues={safeFormValues}
          layerDatasetIds={layerDatasetIds}
          predictedColumns={predictedColumns}
        />
      );

    case "field-statistics":
      return (
        <FieldStatisticsInput
          input={input}
          value={value}
          onChange={onChange}
          disabled={disabled}
          formValues={safeFormValues}
          layerDatasetIds={layerDatasetIds}
          predictedColumns={predictedColumns}
        />
      );

    case "enum":
      return (
        <EnumInput
          input={input}
          value={value as string | number | boolean | undefined}
          onChange={onChange}
          disabled={disabled}
          formValues={safeFormValues}
        />
      );

    case "multi-enum":
      return (
        <MultiEnumInput
          input={input}
          value={value as (string | number)[] | undefined}
          onChange={onChange}
          disabled={disabled}
          schemaDefs={schemaDefs}
        />
      );

    case "boolean":
      return (
        <BooleanInput
          input={input}
          value={value as boolean | undefined}
          onChange={(v) => onChange(v)}
          disabled={disabled}
        />
      );

    case "number":
      return (
        <NumberInput
          input={input}
          value={value as number | undefined}
          onChange={onChange}
          disabled={disabled}
          formValues={safeFormValues}
          onValidationChange={onValidationChange}
        />
      );

    case "time-picker":
      return (
        <TimePickerInput
          input={input}
          value={value as number | undefined}
          onChange={onChange}
          disabled={disabled}
        />
      );

    case "date-picker":
      return (
        <DateInput
          input={input}
          value={value as string | undefined}
          onChange={onChange}
          disabled={disabled}
          formValues={safeFormValues}
        />
      );

    case "starting-points":
      return (
        <StartingPointsInput
          input={input}
          value={value as { latitude: number[]; longitude: number[] } | { layer_id: string } | undefined}
          onChange={onChange}
          disabled={disabled}
        />
      );

    case "string":
      return (
        <StringInput
          input={input}
          value={value as string | undefined}
          onChange={onChange}
          disabled={disabled}
          formValues={safeFormValues}
        />
      );

    case "chips":
      return (
        <ChipsInput
          input={input}
          value={value as number[] | undefined}
          onChange={onChange}
          disabled={disabled}
          formValues={safeFormValues}
          onValidationChange={onValidationChange}
        />
      );

    case "array":
      return (
        <ArrayInput
          input={input}
          value={value as unknown[] | undefined}
          onChange={onChange}
          disabled={disabled}
        />
      );

    case "repeatable-object":
      return (
        <RepeatableObjectInput
          input={input}
          value={value as Record<string, unknown>[] | undefined}
          onChange={onChange}
          onNestedFiltersChange={onNestedFiltersChange}
          disabled={disabled}
          schemaDefs={schemaDefs}
          formValues={safeFormValues}
          layerDatasetIds={layerDatasetIds}
          predictedColumns={predictedColumns}
        />
      );

    case "object":
      return (
        <ObjectInput
          input={input}
          value={value as Record<string, unknown> | undefined}
          onChange={onChange}
          disabled={disabled}
          schemaDefs={schemaDefs}
          formValues={safeFormValues}
        />
      );

    case "unknown":
    default:
      return (
        <Typography variant="body2" color="text.secondary">
          Unknown input type: {input.title}
        </Typography>
      );
  }};

  if (groupLabel) {
    return (
      <Stack spacing={1}>
        <Divider>
          <Typography variant="caption" fontWeight={600} color="text.secondary">
            {groupLabel}
          </Typography>
        </Divider>
        {renderInput()}
      </Stack>
    );
  }

  return renderInput();
}
