"use client";

/**
 * Variable-Aware Input Wrapper
 *
 * Wraps GenericInput for workflow context. For string/number/array inputs:
 * - Replaces GenericInput with a custom TextField that supports {{@variable}} references
 * - Inline autocomplete triggered when user types {{@
 * - Variable icon as endAdornment inside the TextField (click to pick variable from dropdown)
 * - Variable references shown in primary color (error when undefined)
 * - Validation for undefined variables
 *
 * For all other input types (layer, field, enum, boolean, etc.):
 * - Transparent pass-through to GenericInput with zero visual change
 *
 * When `variables` is empty (e.g. map-view toolbox), this is a transparent
 * pass-through to GenericInput for ALL input types.
 */

import VariableIcon from "@mui/icons-material/DataObject";
import {
  Box,
  ClickAwayListener,
  IconButton,
  InputAdornment,
  Paper,
  Popper,
  Stack,
  TextField,
  Tooltip,
  useTheme,
} from "@mui/material";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { OGCInputSchema, ProcessedInput } from "@/types/map/ogc-processes";

import FormLabelHelper from "@/components/common/FormLabelHelper";
import { GenericInput } from "@/components/map/panels/toolbox/generic/inputs";
import WorkflowVariableMenuItem from "@/components/workflows/inputs/WorkflowVariableMenuItem";

import { getEffectiveSchema } from "@/lib/utils/ogc-utils";
import {
  type WorkflowVariable,
  getVariableDescription,
  getVariableDisplayName,
  hasVariableLabel,
} from "@/lib/validations/workflow";

const VARIABLE_REF_REGEX = /^\{\{@([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/;

/** Detect partial variable pattern for autocomplete: {{@ or {{@partial_name */
const PARTIAL_VARIABLE_REGEX = /\{\{@([a-zA-Z_][a-zA-Z0-9_]*)?$/;

/** Input types that can accept a variable reference (text fields only, NOT dropdowns) */
const VARIABLE_CAPABLE_TYPES = new Set(["string", "number", "array"]);

interface VariableAwareInputProps {
  input: ProcessedInput;
  value: unknown;
  onChange: (value: unknown) => void;
  onFilterChange?: (filter: Record<string, unknown> | undefined) => void;
  onNestedFiltersChange?: (filters: Record<string, Record<string, unknown> | undefined>[]) => void;
  disabled?: boolean;
  formValues?: Record<string, unknown>;
  schemaDefs?: Record<string, OGCInputSchema>;
  excludedLayerIds?: string[];
  layerDatasetIds?: Record<string, string>;
  predictedColumns?: Record<string, Record<string, string>>;
  /** Workflow variables available for reference. Empty = no variable support. */
  variables: WorkflowVariable[];
}

/**
 * Check if a value is a complete variable reference like {{@variable_name}}
 */
function parseVariableRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(VARIABLE_REF_REGEX);
  return match ? match[1] : null;
}

/**
 * Filter variables by compatibility with input type
 */
function getCompatibleVariables(
  variables: WorkflowVariable[],
  inputType: string,
  schema?: OGCInputSchema
): WorkflowVariable[] {
  if (inputType === "number") {
    return variables.filter((v) => v.type === "number");
  }
  if (inputType === "array") {
    // For numeric arrays (e.g. buffer distances), only show number variables
    const effectiveSchema = schema ? getEffectiveSchema(schema) : undefined;
    const itemType = effectiveSchema?.items?.type;
    if (itemType === "number" || itemType === "integer") {
      return variables.filter((v) => v.type === "number");
    }
  }
  return variables;
}

/**
 * Variables matching what was typed after {{@: names starting with it, or
 * labels containing it (users may remember a variable by its label).
 */
export function filterVariables(variables: WorkflowVariable[], filter: string): WorkflowVariable[] {
  if (!filter) return variables;
  const lower = filter.toLowerCase();
  return variables.filter(
    (v) => v.name.toLowerCase().startsWith(lower) || (v.label ?? "").toLowerCase().includes(lower)
  );
}

/**
 * Variable autocomplete dropdown — appears below the input when typing {{@
 */
const VariableAutocomplete: React.FC<{
  anchorEl: HTMLElement | null;
  open: boolean;
  variables: WorkflowVariable[];
  filter: string;
  onSelect: (variable: WorkflowVariable) => void;
  onClose: () => void;
}> = ({ anchorEl, open, variables, filter, onSelect, onClose }) => {
  const filtered = useMemo(() => filterVariables(variables, filter), [variables, filter]);

  if (!open || !anchorEl || filtered.length === 0) return null;

  return (
    <Popper
      open={open}
      anchorEl={anchorEl?.parentElement}
      placement="bottom-start"
      style={{ zIndex: 1400, width: anchorEl?.parentElement?.offsetWidth }}>
      <ClickAwayListener onClickAway={onClose}>
        <Paper elevation={8} sx={{ maxHeight: 350, overflowY: "auto", mt: 0.5 }}>
          {filtered.map((v) => (
            <WorkflowVariableMenuItem
              key={v.id}
              variable={v}
              showIcon
              onSelect={(selected) => {
                onSelect(selected);
                onClose();
              }}
            />
          ))}
        </Paper>
      </ClickAwayListener>
    </Popper>
  );
};

/**
 * Custom TextField for string/number/array inputs with variable support.
 * Replicates the behavior of StringInput/NumberInput/ArrayInput from GenericInput,
 * plus adds: inline autocomplete, variable icon endAdornment, colored variable text,
 * and undefined-variable validation.
 *
 * Uses local text state for all input types to allow free editing.
 * Number and array values are parsed on blur (like native type="number" behavior).
 */
const VariableTextField: React.FC<{
  input: ProcessedInput;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  variables: WorkflowVariable[];
  compatibleVars: WorkflowVariable[];
}> = ({ input, value, onChange, disabled, variables, compatibleVars }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");

  const effectiveSchema = useMemo(() => getEffectiveSchema(input.schema), [input.schema]);
  const isNumber = input.inputType === "number";
  const isArray = input.inputType === "array";
  const isNumericArray = isArray && (effectiveSchema.items?.type === "number" || effectiveSchema.items?.type === "integer");

  // Check if the current value is a variable reference
  const variableRef = parseVariableRef(value);
  const isVariableRef = variableRef !== null;

  // Check if the referenced variable exists
  const referencedVariable = isVariableRef ? variables.find((v) => v.name === variableRef) : null;
  const isUndefinedVariable = isVariableRef && !referencedVariable;

  // Compute canonical text from the external value
  const externalText = useMemo(() => {
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }, [value]);

  // Local text state for free editing without immediate parse
  const [localText, setLocalText] = useState(externalText);

  // Sync local text when value changes externally (e.g. variable selection, undo)
  useEffect(() => {
    if (externalText !== localText) {
      setLocalText(externalText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalText]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.value;
      setLocalText(raw);

      // Check for partial variable pattern to trigger autocomplete
      const partialMatch = raw.match(PARTIAL_VARIABLE_REGEX);
      if (partialMatch) {
        setAutocompleteOpen(true);
        setAutocompleteFilter(partialMatch[1] || "");
      } else {
        setAutocompleteOpen(false);
        setAutocompleteFilter("");
      }

      // For complete variable references, apply immediately
      if (raw.match(VARIABLE_REF_REGEX)) {
        onChange(raw);
        return;
      }

      // For string fields, apply immediately (no conversion needed)
      if (!isNumber && !isArray) {
        onChange(raw === "" ? undefined : raw);
        return;
      }

      // For number/array fields: just update local text, parse on blur
    },
    [isArray, isNumber, onChange]
  );

  // Blur handler: parse number/array values from text
  const handleBlur = useCallback(() => {
    // Variable references are already applied in handleChange
    if (localText.match(VARIABLE_REF_REGEX)) return;
    // Partial variable pattern — store as string
    if (localText.includes("{{@")) {
      if (localText.trim()) onChange(localText);
      return;
    }

    if (isNumber) {
      if (localText.trim() === "") {
        onChange(undefined);
      } else {
        const num = Number(localText);
        onChange(isNaN(num) ? undefined : num);
      }
    } else if (isArray) {
      if (!localText.trim()) {
        onChange(undefined);
        return;
      }
      const parts = localText.split(",").map((p) => p.trim()).filter((p) => p);
      const parsed: unknown[] = [];
      for (const part of parts) {
        if (isNumericArray) {
          const num = Number(part);
          if (!isNaN(num)) parsed.push(num);
        } else {
          parsed.push(part);
        }
      }
      onChange(parsed.length > 0 ? parsed : undefined);
    }
  }, [isArray, isNumber, isNumericArray, localText, onChange]);

  const handleSelectVariable = useCallback(
    (variable: WorkflowVariable) => {
      const ref = `{{@${variable.name}}}`;
      onChange(ref);
      setLocalText(ref);
      setAutocompleteOpen(false);
      setPickerOpen(false);
    },
    [onChange]
  );

  // Build number-specific input props
  const numberProps = isNumber
    ? {
        min: effectiveSchema.minimum,
        max: effectiveSchema.maximum,
        step: effectiveSchema.type === "integer" ? 1 : "any",
      }
    : {};

  // Build string-specific input props
  const stringProps = !isNumber && !isArray
    ? {
        minLength: effectiveSchema.minLength,
        maxLength: effectiveSchema.maxLength,
        pattern: effectiveSchema.pattern,
      }
    : {};

  // Placeholder
  const placeholder = isArray
    ? (isNumericArray ? t("array_input_placeholder_numeric") : t("array_input_placeholder"))
    : (input.defaultValue !== undefined ? String(input.defaultValue) : undefined);

  // Helper text: undefined variables are an error; a labelled variable shows
  // its label under the technical reference, with its description on hover.
  const referencedDescription = referencedVariable ? getVariableDescription(referencedVariable) : undefined;
  const helperText = isUndefinedVariable ? (
    t("workflow_variable_undefined", { name: variableRef })
  ) : referencedVariable && (hasVariableLabel(referencedVariable) || referencedDescription) ? (
    <Tooltip title={referencedDescription ?? ""} placement="bottom-start" describeChild>
      <span data-testid="variable-reference-label">{getVariableDisplayName(referencedVariable)}</span>
    </Tooltip>
  ) : undefined;

  // Variable text color: primary for valid, error for undefined
  const varColor = isUndefinedVariable ? theme.palette.error.main : theme.palette.primary.main;

  return (
    <Stack>
      <FormLabelHelper
        label={input.title || input.name}
        tooltip={input.description}
        color="inherit"
        required={input.required}
      />
      <Box sx={{ position: "relative" }}>
        <TextField
          inputRef={inputRef}
          type="text"
          size="small"
          value={localText}
          onChange={handleChange}
          onBlur={handleBlur}
          disabled={disabled}
          inputProps={{
            ...numberProps,
            ...stringProps,
          }}
          placeholder={placeholder}
          fullWidth
          error={isUndefinedVariable}
          helperText={helperText}
          sx={{
            "& input": {
              ...(isVariableRef && {
                color: varColor,
                fontFamily: "monospace",
                fontSize: "0.75rem",
              }),
            },
          }}
          InputProps={{
            endAdornment: compatibleVars.length > 0 ? (
              <InputAdornment position="end" sx={{ mr: -0.5 }}>
                <Tooltip title={t("workflow_variable_insert")} placement="top">
                  <IconButton
                    size="small"
                    onClick={() => setPickerOpen((prev) => !prev)}
                    edge="end"
                    sx={{
                      p: 0.25,
                      color: pickerOpen ? "primary.main" : "text.secondary",
                      "&:hover": { color: "primary.main" },
                    }}>
                    <VariableIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              </InputAdornment>
            ) : undefined,
          }}
        />
        {/* Inline autocomplete — triggered by typing {{@ */}
        <VariableAutocomplete
          anchorEl={inputRef.current}
          open={autocompleteOpen}
          variables={compatibleVars}
          filter={autocompleteFilter}
          onSelect={handleSelectVariable}
          onClose={() => setAutocompleteOpen(false)}
        />
        {/* Variable picker dropdown — anchored to the TextField like a Select menu */}
        {pickerOpen && compatibleVars.length > 0 && (
          <Popper
            open={pickerOpen}
            anchorEl={inputRef.current?.parentElement}
            placement="bottom-start"
            style={{ zIndex: 1400, width: inputRef.current?.parentElement?.offsetWidth }}
          >
            <ClickAwayListener onClickAway={() => setPickerOpen(false)}>
              <Paper
                elevation={8}
                sx={{
                  maxHeight: 350,
                  overflowY: "auto",
                  mt: 0.5,
                }}
              >
                {compatibleVars.map((v) => (
                  <WorkflowVariableMenuItem
                    key={v.id}
                    variable={v}
                    showIcon
                    onSelect={handleSelectVariable}
                  />
                ))}
              </Paper>
            </ClickAwayListener>
          </Popper>
        )}
      </Box>
    </Stack>
  );
};

/**
 * Main VariableAwareInput component
 *
 * - When `variables` is empty: transparent pass-through to GenericInput
 * - When inputType is string/number/array: renders VariableTextField with variable features
 * - For all other types: transparent pass-through to GenericInput
 */
export default function VariableAwareInput({
  input,
  value,
  onChange,
  onFilterChange,
  onNestedFiltersChange,
  disabled,
  formValues,
  schemaDefs,
  excludedLayerIds,
  layerDatasetIds,
  predictedColumns,
  variables,
}: VariableAwareInputProps) {
  const isVariableCapable = VARIABLE_CAPABLE_TYPES.has(input.inputType);

  const compatibleVars = useMemo(
    () => (isVariableCapable ? getCompatibleVariables(variables, input.inputType, input.schema) : []),
    [variables, input.inputType, input.schema, isVariableCapable]
  );

  // Fast path: no variables at all (map-view toolbox) — pure GenericInput
  if (variables.length === 0) {
    return (
      <GenericInput
        input={input}
        value={value}
        onChange={onChange}
        onFilterChange={onFilterChange}
        onNestedFiltersChange={onNestedFiltersChange}
        disabled={disabled}
        formValues={formValues}
        schemaDefs={schemaDefs}
        excludedLayerIds={excludedLayerIds}
        layerDatasetIds={layerDatasetIds}
        predictedColumns={predictedColumns}
      />
    );
  }

  // Variable-capable (string/number/array) with available variables — use custom TextField
  if (isVariableCapable && compatibleVars.length > 0) {
    return (
      <VariableTextField
        input={input}
        value={value}
        onChange={onChange}
        disabled={disabled}
        variables={variables}
        compatibleVars={compatibleVars}
      />
    );
  }

  // All other types — plain GenericInput (layer, field, enum, boolean, etc.)
  return (
    <GenericInput
      input={input}
      value={value}
      onChange={onChange}
      onFilterChange={onFilterChange}
      onNestedFiltersChange={onNestedFiltersChange}
      disabled={disabled}
      formValues={formValues}
      schemaDefs={schemaDefs}
      excludedLayerIds={excludedLayerIds}
      layerDatasetIds={layerDatasetIds}
      predictedColumns={predictedColumns}
    />
  );
}
