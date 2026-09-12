/**
 * Utility functions for processing OGC API Processes schemas
 *
 * Transforms OGC input descriptions into UI-friendly structures
 * with support for sections, field ordering, and conditional visibility.
 */
import { OPPORTUNITY_LAYER_HANDLES } from "@/types/map/ogc-processes";
import type {
  InferredInputType,
  OGCInputDescription,
  OGCInputSchema,
  OGCOutputDescription,
  OGCProcessDescription,
  ProcessedInput,
  ProcessedSection,
  UIFieldMeta,
  UISection,
} from "@/types/map/ogc-processes";

// Inputs that are handled automatically (not shown in form)
const HIDDEN_INPUT_NAMES = ["user_id", "project_id", "save_results"];

// Default section for fields without explicit section assignment
const DEFAULT_SECTION_ID = "main";

// Default section definitions (used when no x-ui-sections provided)
const DEFAULT_SECTIONS: UISection[] = [
  { id: "main", order: 1, label: "Parameters", icon: "layers" },
  { id: "advanced", order: 10, label: "Advanced", icon: "settings", collapsible: true, collapsed: true },
];

/**
 * Infer the input type from OGC input schema
 */
export function inferInputType(
  input: OGCInputDescription,
  inputName: string,
  schemaDefs?: Record<string, OGCInputSchema>
): InferredInputType {
  const { schema, keywords } = input;

  // Check keywords first (more specific)
  if (keywords.includes("layer")) {
    return "layer";
  }

  if (keywords.includes("field")) {
    return "field";
  }

  // Infer field type from naming convention (e.g., "target_field", "join_field")
  if (inputName.endsWith("_field") || inputName.endsWith("Field")) {
    return "field";
  }

  // Check for explicit widget types in x-ui metadata BEFORE getting effective schema
  // This handles union types (anyOf) that have x-ui at the top level
  const topLevelUiMeta = schema["x-ui"];
  if (topLevelUiMeta?.widget === "layer-selector") {
    return "layer";
  }
  if (topLevelUiMeta?.widget === "bundle-selector") {
    return "bundle";
  }
  if (topLevelUiMeta?.widget === "time-picker") {
    return "time-picker";
  }
  if (topLevelUiMeta?.widget === "date-picker") {
    return "date-picker";
  }
  if (topLevelUiMeta?.widget === "starting-points") {
    return "starting-points";
  }
  if (topLevelUiMeta?.widget === "field-selector") {
    return "field";
  }
  if (topLevelUiMeta?.widget === "field-statistics-selector") {
    return "field-statistics";
  }
  if (topLevelUiMeta?.widget === "chips") {
    return "chips";
  }

  // Get the effective schema (handle anyOf/oneOf for nullable types)
  const effectiveSchema = getEffectiveSchema(schema);

  // Check for explicit widget types in x-ui metadata (for non-union schemas)
  const uiMeta = effectiveSchema["x-ui"];
  if (uiMeta?.widget === "layer-selector") {
    return "layer";
  }
  if (uiMeta?.widget === "bundle-selector") {
    return "bundle";
  }
  if (uiMeta?.widget === "time-picker") {
    return "time-picker";
  }
  if (uiMeta?.widget === "date-picker") {
    return "date-picker";
  }
  if (uiMeta?.widget === "starting-points") {
    return "starting-points";
  }
  if (uiMeta?.widget === "field-selector") {
    return "field";
  }
  if (uiMeta?.widget === "field-statistics-selector") {
    return "field-statistics";
  }

  // Check for repeatable array of objects (e.g., opportunities in heatmap, attribute relationships in join)
  if (effectiveSchema.type === "array") {
    const itemSchema = effectiveSchema.items;

    // Check if it's a repeatable array of objects
    // Note: for anyOf patterns (nullable arrays), x-ui metadata is at top level, not inside anyOf variants
    if (
      (uiMeta?.repeatable || topLevelUiMeta?.repeatable) &&
      itemSchema &&
      (itemSchema.type === "object" || itemSchema.$ref || itemSchema.properties)
    ) {
      return "repeatable-object";
    }

    // Check if it's an array of enums (multi-select)
    if (itemSchema && (itemSchema.enum || itemSchema.$ref)) {
      return "multi-enum";
    }

    return "array";
  }

  // Check schema type
  if (effectiveSchema.enum && effectiveSchema.enum.length > 0) {
    return "enum";
  }

  if (effectiveSchema.type === "boolean") {
    return "boolean";
  }

  if (effectiveSchema.type === "number" || effectiveSchema.type === "integer") {
    return "number";
  }

  if (effectiveSchema.type === "string") {
    return "string";
  }

  if (effectiveSchema.type === "object" || effectiveSchema.properties) {
    return "object";
  }

  // Check for $ref and resolve it to determine the actual type
  if (effectiveSchema.$ref) {
    if (schemaDefs) {
      const refName = effectiveSchema.$ref.replace("#/$defs/", "");
      const refSchema = schemaDefs[refName];
      if (refSchema) {
        // Check if the referenced schema is an object
        if (refSchema.type === "object" || refSchema.properties) {
          return "object";
        }
        // Check if it's an enum
        if (refSchema.enum) {
          return "enum";
        }
      }
    }
    // Default to enum for backwards compatibility if we can't resolve
    return "enum";
  }

  return "unknown";
}

/**
 * Get the effective schema, handling anyOf/oneOf patterns for nullable types
 */
export function getEffectiveSchema(schema: OGCInputSchema): OGCInputSchema {
  // Handle anyOf pattern (commonly used for nullable types)
  if (schema.anyOf && schema.anyOf.length > 0) {
    // Find the non-null schema
    const nonNullSchema = schema.anyOf.find((s) => s.type !== "null");
    if (nonNullSchema) {
      return { ...nonNullSchema, default: schema.default };
    }
  }

  // Handle oneOf pattern
  if (schema.oneOf && schema.oneOf.length > 0) {
    const nonNullSchema = schema.oneOf.find((s) => s.type !== "null");
    if (nonNullSchema) {
      return { ...nonNullSchema, default: schema.default };
    }
  }

  return schema;
}

/**
 * Data type information for workflow connections
 */
export interface DataTypeInfo {
  /** The data type: vector, table, or raster */
  dataType: "vector" | "table" | "raster" | undefined;
  /** Multiple allowed data types (e.g., ["vector", "table"] for Custom SQL inputs) */
  dataTypes?: ("vector" | "table" | "raster")[];
  /** For vector data, the allowed geometry types */
  geometryTypes?: string[];
}

/**
 * Extract data type info from input metadata
 */
export function extractInputDataType(input: OGCInputDescription): DataTypeInfo {
  const dataTypeMeta = input.metadata.find((m) => m.role === "constraint" && m.title === "data_type");
  const geometryTypesMeta = input.metadata.find(
    (m) => m.role === "constraint" && m.title === "geometry_types"
  );

  const geometryTypes = geometryTypesMeta?.value
    ? String(geometryTypesMeta.value)
        .split(",")
        .map((s) => s.trim())
    : undefined;

  // Parse data_type value — may be comma-separated for inputs accepting multiple types
  // e.g., "vector,table" for Custom SQL inputs
  if (dataTypeMeta?.value) {
    const rawValue = String(dataTypeMeta.value);
    const parts = rawValue.split(",").map((s) => s.trim()) as ("vector" | "table" | "raster")[];
    if (parts.length > 1) {
      return { dataType: parts[0], dataTypes: parts, geometryTypes };
    }
    return { dataType: parts[0], geometryTypes };
  }

  return { dataType: undefined, geometryTypes };
}

/**
 * Extract data type info from output metadata
 */
export function extractOutputDataType(output: OGCOutputDescription): DataTypeInfo {
  const dataTypeMeta = output.metadata?.find((m) => m.role === "constraint" && m.title === "data_type");
  const geometryTypeMeta = output.metadata?.find(
    (m) => m.role === "constraint" && m.title === "geometry_type"
  );

  const dataType = dataTypeMeta?.value as "vector" | "table" | "raster" | undefined;
  // Output has singular geometry_type, convert to array for consistency
  const geometryTypes = geometryTypeMeta?.value ? [String(geometryTypeMeta.value)] : undefined;

  return { dataType, geometryTypes };
}

/**
 * Check if an output type is compatible with an input type
 * @param outputType - The data type info of the source output
 * @param inputType - The data type info of the target input
 * @returns true if the connection is valid
 */
export function isConnectionValid(outputType: DataTypeInfo, inputType: DataTypeInfo): boolean {
  // If input has no data type constraint, accept anything
  if (!inputType.dataType) {
    return true;
  }

  // Check if the output data type matches any of the input's allowed types
  const allowedTypes = inputType.dataTypes ?? (inputType.dataType ? [inputType.dataType] : []);
  if (!outputType.dataType || !allowedTypes.includes(outputType.dataType)) {
    return false;
  }

  // For vector data, check geometry type compatibility
  if (inputType.dataType === "vector") {
    // If input has no geometry constraints, accept any vector
    if (!inputType.geometryTypes || inputType.geometryTypes.length === 0) {
      return true;
    }

    // If output has no geometry type specified, we allow it (flexible - dataset nodes)
    if (!outputType.geometryTypes || outputType.geometryTypes.length === 0) {
      return true;
    }

    // Check if output geometry type matches any of the allowed input types
    // Normalize geometry types (handle Point vs point, etc.)
    const normalizedInputTypes = inputType.geometryTypes.map((t) => t.toLowerCase());
    const normalizedOutputTypes = outputType.geometryTypes.map((t) => t.toLowerCase());

    // At least one output geometry type must be compatible
    return normalizedOutputTypes.some((outType) =>
      normalizedInputTypes.some((inType) => {
        // Exact match
        if (outType === inType) return true;
        // MultiX matches X
        if (outType === `multi${inType}`) return true;
        // X matches MultiX (less strict)
        if (`multi${outType}` === inType) return true;
        return false;
      })
    );
  }

  return true;
}

/**
 * Format data type info for display
 */
export function formatDataType(info: DataTypeInfo): string {
  if (!info.dataType) {
    return "any";
  }

  if (info.dataType === "vector" && info.geometryTypes && info.geometryTypes.length > 0) {
    return `vector (${info.geometryTypes.join(", ")})`;
  }

  return info.dataType;
}

/**
 * Extract geometry constraints from input metadata
 */
export function extractGeometryConstraints(input: OGCInputDescription): string[] | undefined {
  const constraintMeta = input.metadata.find((m) => m.role === "constraint" && m.title === "geometry_types");

  if (constraintMeta && typeof constraintMeta.value === "string") {
    return constraintMeta.value.split(",").map((s) => s.trim());
  }

  return undefined;
}

/**
 * Extract output geometry type from output metadata
 */
export function extractOutputGeometryType(output: OGCOutputDescription): string | undefined {
  const geometryMeta = output.metadata?.find((m) => m.role === "constraint" && m.title === "geometry_type");

  if (geometryMeta && typeof geometryMeta.value === "string") {
    return geometryMeta.value;
  }

  return undefined;
}

/**
 * Extract enum values from schema
 * @param schema - The input schema
 * @param schemaDefs - Schema $defs for resolving $ref
 */
export function extractEnumValues(
  schema: OGCInputSchema,
  schemaDefs?: Record<string, OGCInputSchema>
): (string | number | boolean)[] | undefined {
  const effectiveSchema = getEffectiveSchema(schema);

  if (effectiveSchema.enum) {
    return effectiveSchema.enum;
  }

  // Resolve $ref to $defs if available
  if (effectiveSchema.$ref && schemaDefs) {
    const refName = effectiveSchema.$ref.replace("#/$defs/", "");
    const refSchema = schemaDefs[refName];
    if (refSchema?.enum) {
      return refSchema.enum;
    }
  }

  return undefined;
}

/**
 * Process a single OGC input description into UI-friendly format
 * @param name - Input field name
 * @param input - OGC input description
 * @param schemaDefs - Schema $defs for resolving $ref
 */
export function processInput(
  name: string,
  input: OGCInputDescription,
  schemaDefs?: Record<string, OGCInputSchema>
): ProcessedInput {
  const inputType = inferInputType(input, name, schemaDefs);
  const effectiveSchema = getEffectiveSchema(input.schema);
  const uiMeta = input.schema["x-ui"] as UIFieldMeta | undefined;

  return {
    name,
    title: input.title,
    description: input.description,
    inputType,
    required: input.minOccurs > 0,
    schema: input.schema,
    defaultValue: effectiveSchema.default,
    enumValues: extractEnumValues(input.schema, schemaDefs),
    isLayerInput: input.keywords.includes("layer"),
    geometryConstraints: extractGeometryConstraints(input),
    metadata: input.metadata,
    // UI metadata
    section: uiMeta?.section ?? DEFAULT_SECTION_ID,
    fieldOrder: uiMeta?.field_order ?? 100,
    advanced: uiMeta?.advanced ?? false,
    uiMeta,
  };
}

/**
 * Process all inputs from a process description (legacy format)
 * @deprecated Use processInputsWithSections instead
 */
export function processInputs(process: OGCProcessDescription): {
  mainInputs: ProcessedInput[];
  advancedInputs: ProcessedInput[];
  hiddenInputs: ProcessedInput[];
} {
  const sections = processInputsWithSections(process);

  // Flatten back to legacy format for backwards compatibility
  const mainInputs: ProcessedInput[] = [];
  const advancedInputs: ProcessedInput[] = [];
  const hiddenInputs: ProcessedInput[] = [];

  for (const section of sections) {
    if (section.id === "advanced" || section.id === "options") {
      advancedInputs.push(...section.inputs);
    } else {
      mainInputs.push(...section.inputs);
    }
  }

  // Hidden inputs from process
  for (const [name, input] of Object.entries(process.inputs)) {
    if (HIDDEN_INPUT_NAMES.includes(name)) {
      hiddenInputs.push(processInput(name, input));
    }
  }

  return { mainInputs, advancedInputs, hiddenInputs };
}

/**
 * Process inputs grouped by sections with proper ordering
 */
export function processInputsWithSections(process: OGCProcessDescription): ProcessedSection[] {
  // Get section definitions from process or use defaults
  const sectionDefs = process["x-ui-sections"] ?? DEFAULT_SECTIONS;

  // Get $defs for resolving $ref in schemas
  const schemaDefs = process.$defs;

  // Create section map
  const sectionMap = new Map<string, ProcessedSection>();

  for (const def of sectionDefs) {
    sectionMap.set(def.id, {
      id: def.id,
      label: def.label ?? def.label_key ?? def.id,
      icon: def.icon,
      order: def.order,
      collapsible: def.collapsible ?? false,
      collapsed: def.collapsed ?? false,
      inputs: [],
      dependsOn: def.depends_on,
    });
  }

  // Process and categorize inputs
  for (const [name, input] of Object.entries(process.inputs)) {
    // Skip hidden inputs
    if (HIDDEN_INPUT_NAMES.includes(name)) {
      continue;
    }

    const processed = processInput(name, input, schemaDefs);

    // Skip fields marked as hidden in UI metadata
    if (processed.uiMeta?.hidden) {
      continue;
    }

    const sectionId = processed.section ?? DEFAULT_SECTION_ID;

    // Get or create section
    let section = sectionMap.get(sectionId);
    if (!section) {
      // Create section dynamically if not defined
      section = {
        id: sectionId,
        label: formatSectionLabel(sectionId),
        order: 50, // Middle priority for unknown sections
        collapsible: false,
        collapsed: false,
        inputs: [],
      };
      sectionMap.set(sectionId, section);
    }

    section.inputs.push(processed);
  }

  // Sort inputs within each section by field_order
  for (const section of sectionMap.values()) {
    section.inputs.sort((a, b) => a.fieldOrder - b.fieldOrder);
  }

  // Convert to array, filter empty sections, and sort by section order
  const sections = Array.from(sectionMap.values())
    .filter((section) => section.inputs.length > 0)
    .sort((a, b) => a.order - b.order);

  return sections;
}

/**
 * Format section ID into display label
 */
function formatSectionLabel(sectionId: string): string {
  return sectionId
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * `default_from`: pick a default by matching conditions across several fields,
 * using the same entry shape as `max_value_from`. First entry whose `when`
 * matches wins; an entry without `when` is the fallback. Needed where a single
 * field's default depends on more than one other field (e.g. a travel budget
 * keyed on routing_mode AND cost_type), which `default_by_field` cannot express.
 */
export type DefaultFromEntry = { value: unknown; when?: Record<string, unknown> };
export type DefaultFrom = { fields: DefaultFromEntry[] };

/**
 * Read a conditional widget option — one shaped `{fields: [{value, when}]}`.
 * `default_from` and `unit_from` both use it, so they share one resolver.
 */
export function getConditionalOption(
  schema: OGCInputSchema | undefined,
  optionName: string
): DefaultFrom | undefined {
  const uiMeta = schema?.["x-ui"] as { widget_options?: Record<string, DefaultFrom | undefined> } | undefined;
  return uiMeta?.widget_options?.[optionName];
}

export function getDefaultFrom(schema: OGCInputSchema | undefined): DefaultFrom | undefined {
  return getConditionalOption(schema, "default_from");
}

/** i18n key for the unit suffix shown inside the input (e.g. min / m). */
export function getUnitFrom(schema: OGCInputSchema | undefined): DefaultFrom | undefined {
  return getConditionalOption(schema, "unit_from");
}

export function resolveDefaultFrom(
  defaultFrom: DefaultFrom | undefined,
  values: Record<string, unknown>
): unknown {
  if (!defaultFrom?.fields) return undefined;
  for (const entry of defaultFrom.fields) {
    if (entry.when && !Object.entries(entry.when).every(([k, v]) => values[k] === v)) continue;
    return entry.value;
  }
  return undefined;
}

/** Field names a `default_from` depends on, so callers know when to re-resolve. */
export function defaultFromDependencies(defaultFrom: DefaultFrom | undefined): string[] {
  if (!defaultFrom?.fields) return [];
  return [...new Set(defaultFrom.fields.flatMap((e) => Object.keys(e.when ?? {})))];
}

/** `default_by_field`: pick a default from a single other field's value. */
export function getDefaultByField(
  schema: OGCInputSchema | undefined
): { field: string; values: Record<string, unknown> } | undefined {
  const uiMeta = schema?.["x-ui"] as
    | { widget_options?: { default_by_field?: { field: string; values: Record<string, unknown> } } }
    | undefined;
  return uiMeta?.widget_options?.default_by_field;
}

/**
 * Get default values for all inputs.
 *
 * Three passes (the conditional passes resolve against the values built so far):
 *   1. Schema defaults (`default` from the JSON Schema).
 *   2. `default_by_field` resolution — fields keyed off another field's value
 *      (e.g. mode-specific speed defaults) need their initial value derived
 *      from the source field's *initial* default. The runtime handler in
 *      handleInputChange only fires on user-driven changes, not on first
 *      render, so we apply the same lookup here for the load case.
 *   3. `default_from` resolution — the multi-field variant of the same idea.
 *
 * `overrides` seed the conditional passes and are never overwritten by them.
 * Fields that restart the form rely on this: `routing_mode` has no schema
 * default, so without seeding it nothing keyed on the mode could resolve and
 * those fields would come back empty (a null speed) instead of the new mode's
 * default.
 */
export function getDefaultValues(
  process: OGCProcessDescription,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  for (const [name, input] of Object.entries(process.inputs)) {
    const effectiveSchema = getEffectiveSchema(input.schema);
    if (effectiveSchema.default !== undefined) {
      defaults[name] = effectiveSchema.default;
    }
  }

  Object.assign(defaults, overrides);

  for (const [name, input] of Object.entries(process.inputs)) {
    if (name in overrides) continue;
    const defaultByField = getDefaultByField(input.schema);
    if (!defaultByField) continue;
    const sourceVal = defaults[defaultByField.field];
    if (sourceVal === undefined || sourceVal === null) continue;
    const dynamicDefault = defaultByField.values[String(sourceVal)];
    if (dynamicDefault !== undefined) {
      defaults[name] = dynamicDefault;
    }
  }

  for (const [name, input] of Object.entries(process.inputs)) {
    if (name in overrides) continue;
    const resolved = resolveDefaultFrom(getDefaultFrom(input.schema), defaults);
    if (resolved !== undefined) {
      defaults[name] = resolved;
    }
  }

  return defaults;
}

/**
 * Does changing this field restart the whole form? The transport mode decides
 * which measures, budgets and legs are meaningful, so nothing may carry over.
 */
export function isFormResetField(inputs: ProcessedInput[], name: string): boolean {
  return inputs.some((i) => i.name === name && i.uiMeta?.widget_options?.resets_form === true);
}

/**
 * Apply a field change, re-resolving every value that depends on it: dynamic
 * defaults (`default_by_field`, `default_from`) and fields whose `max_value_from`
 * cap references the changed field.
 */
export function applyDynamicDefaults(
  inputs: ProcessedInput[],
  prev: Record<string, unknown>,
  name: string,
  value: unknown
): Record<string, unknown> {
  const newValues = { ...prev, [name]: value };

  for (const input of inputs) {
    const defaultByField = getDefaultByField(input.schema);
    if (defaultByField?.field === name) {
      const dynamicDefault = defaultByField.values[String(value)];
      if (dynamicDefault !== undefined) {
        newValues[input.name] = dynamicDefault;
      }
    }

    // Re-resolve default_from when one of its condition fields changes.
    // Reset (rather than clamp) is deliberate: switching cost_type moves
    // between units, so the previous number is meaningless.
    const defaultFrom = getDefaultFrom(input.schema);
    if (defaultFromDependencies(defaultFrom).includes(name)) {
      const resolved = resolveDefaultFrom(defaultFrom, newValues);
      if (resolved !== undefined) {
        newValues[input.name] = resolved;
      }
    }

    // Auto-clamp fields whose max_value_from references the changed field
    const maxValueFrom = input.uiMeta?.widget_options?.max_value_from as
      | { fields: (string | { field?: string })[]; max?: number }
      | undefined;

    if (maxValueFrom) {
      const fieldNames = maxValueFrom.fields.map((f) => (typeof f === "string" ? f : f.field));
      if (fieldNames.includes(name)) {
        const currentVal = newValues[input.name] as number | undefined;
        const newLimit = Math.min(Number(value) || Infinity, maxValueFrom.max ?? Infinity);
        if (currentVal !== undefined && currentVal > newLimit) {
          newValues[input.name] = newLimit;
        }
      }
    }
  }

  return newValues;
}

/**
 * Validate inputs against process schema
 * Returns array of error messages, empty if valid
 */
export function validateInputs(process: OGCProcessDescription, values: Record<string, unknown>): string[] {
  const errors: string[] = [];

  for (const [name, input] of Object.entries(process.inputs)) {
    const value = values[name];
    const isRequired = input.minOccurs > 0;

    // Check required fields
    if (isRequired && (value === undefined || value === null || value === "")) {
      // Skip hidden inputs that will be added automatically
      if (!HIDDEN_INPUT_NAMES.includes(name)) {
        errors.push(`${input.title} is required`);
      }
    }
  }

  return errors;
}

/**
 * Check if a layer type matches the geometry constraints
 */
export function matchesGeometryConstraint(
  layerGeometryType: string | undefined,
  constraints: string[] | undefined
): boolean {
  if (!constraints || constraints.length === 0) {
    return true; // No constraints means any geometry is accepted
  }

  if (!layerGeometryType) {
    return false;
  }

  // Normalize geometry type names for comparison
  const normalizedLayerType = layerGeometryType.toLowerCase();
  const normalizedConstraints = constraints.map((c) => c.toLowerCase());

  return normalizedConstraints.some((constraint) => {
    // Handle variations like "polygon" matching "Polygon" or "MultiPolygon"
    if (normalizedLayerType.includes(constraint)) {
      return true;
    }
    // Handle "multi" prefix
    if (constraint.startsWith("multi") && normalizedLayerType === constraint.substring(5)) {
      return true;
    }
    if (normalizedLayerType.startsWith("multi") && normalizedLayerType.substring(5) === constraint) {
      return true;
    }
    return normalizedLayerType === constraint;
  });
}

/**
 * Format input name for display (snake_case to Title Case)
 */
export function formatInputName(name: string): string {
  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ============================================================================
// Visibility Evaluation Functions
// ============================================================================

/**
 * Evaluate a MongoDB-like condition against form values
 *
 * Supports operators:
 * - $eq: equals
 * - $ne: not equals
 * - $gt, $gte, $lt, $lte: comparisons
 * - $in: value in array
 * - $nin: value not in array
 * - $exists: field exists (is not undefined/null)
 * - $and: all conditions must be true
 * - $or: at least one condition must be true
 */
export function evaluateCondition(
  condition: Record<string, unknown>,
  values: Record<string, unknown>
): boolean {
  for (const [field, check] of Object.entries(condition)) {
    // Handle $and operator - all conditions must be true
    if (field === "$and" && Array.isArray(check)) {
      for (const subCondition of check) {
        if (!evaluateCondition(subCondition as Record<string, unknown>, values)) {
          return false;
        }
      }
      continue;
    }

    // Handle $or operator - at least one condition must be true
    if (field === "$or" && Array.isArray(check)) {
      let anyTrue = false;
      for (const subCondition of check) {
        if (evaluateCondition(subCondition as Record<string, unknown>, values)) {
          anyTrue = true;
          break;
        }
      }
      if (!anyTrue) return false;
      continue;
    }

    const value = values[field];

    // Handle operator objects
    if (check !== null && typeof check === "object" && !Array.isArray(check)) {
      const operators = check as Record<string, unknown>;

      for (const [op, expected] of Object.entries(operators)) {
        switch (op) {
          case "$eq":
            if (value !== expected) return false;
            break;
          case "$ne":
            // Treat undefined, null, and empty string as equivalent for $ne null checks
            const isNullish = value === null || value === undefined || value === "";
            const expectedNullish = expected === null || expected === undefined || expected === "";
            if (expectedNullish) {
              // $ne: null means "has a value"
              if (isNullish) return false;
            } else {
              if (value === expected) return false;
            }
            break;
          case "$gt":
            if (typeof value !== "number" || typeof expected !== "number" || value <= expected) return false;
            break;
          case "$gte":
            if (typeof value !== "number" || typeof expected !== "number" || value < expected) return false;
            break;
          case "$lt":
            if (typeof value !== "number" || typeof expected !== "number" || value >= expected) return false;
            break;
          case "$lte":
            if (typeof value !== "number" || typeof expected !== "number" || value > expected) return false;
            break;
          case "$in":
            if (!Array.isArray(expected) || !expected.includes(value)) return false;
            break;
          case "$nin":
            if (!Array.isArray(expected) || expected.includes(value)) return false;
            break;
          case "$exists":
            const exists = value !== undefined && value !== null && value !== "";
            if (expected && !exists) return false;
            if (!expected && exists) return false;
            break;
          default:
            // Unknown operator, skip
            break;
        }
      }
    } else {
      // Direct equality check
      if (value !== check) return false;
    }
  }

  return true;
}

/**
 * Check if an input should be visible based on its UI metadata and form values
 */
export function isInputVisible(input: ProcessedInput, values: Record<string, unknown>): boolean {
  const { uiMeta } = input;

  if (!uiMeta) return true;

  // Check hidden flag (always hidden)
  if (uiMeta.hidden) return false;

  // Check visible_when condition
  if (uiMeta.visible_when) {
    if (!evaluateCondition(uiMeta.visible_when, values)) {
      return false;
    }
  }

  // Check hidden_when condition
  if (uiMeta.hidden_when) {
    if (evaluateCondition(uiMeta.hidden_when, values)) {
      return false;
    }
  }

  return true;
}

/**
 * Does this tool take its opportunity layers from the numbered canvas handles
 * rather than the repeatable `opportunities` list?
 *
 * Read off the schema rather than a list of tool names: the backend declares the
 * handles, so a renamed or newly added tool is picked up without a second place
 * to update.
 */
export function hasOpportunityHandles(process: OGCProcessDescription | undefined): boolean {
  // `some`, not `every`: declaring any numbered handle is what marks the tool.
  // Requiring all of them would silently switch the feature off for every tool
  // if the backend's MAX_OPPORTUNITY_LAYERS ever outgrew the list below.
  return !!process?.inputs && OPPORTUNITY_LAYER_HANDLES.some((name) => name in process.inputs);
}

/**
 * Get visible inputs for a section based on current form values
 */
export function getVisibleInputs(
  inputs: ProcessedInput[],
  values: Record<string, unknown>
): ProcessedInput[] {
  return inputs.filter((input) => isInputVisible(input, values));
}

/**
 * Check if a section is enabled based on its depends_on condition
 */
export function isSectionEnabled(section: ProcessedSection, values: Record<string, unknown>): boolean {
  if (!section.dependsOn) return true;
  return evaluateCondition(section.dependsOn, values);
}

/**
 * Filter inputs by mutually exclusive group
 * Returns only the highest priority input that has a value, or the first one if none have values
 */
export function filterMutuallyExclusiveInputs(
  inputs: ProcessedInput[],
  values: Record<string, unknown>
): ProcessedInput[] {
  // Group inputs by mutually_exclusive_group
  const groups = new Map<string, ProcessedInput[]>();
  const nonGrouped: ProcessedInput[] = [];

  for (const input of inputs) {
    const groupId = input.uiMeta?.mutually_exclusive_group;
    if (groupId) {
      const group = groups.get(groupId) ?? [];
      group.push(input);
      groups.set(groupId, group);
    } else {
      nonGrouped.push(input);
    }
  }

  // For each group, determine which input to show
  const result = [...nonGrouped];

  for (const [, groupInputs] of groups) {
    // Sort by priority (lower is higher priority)
    groupInputs.sort((a, b) => (a.uiMeta?.priority ?? 99) - (b.uiMeta?.priority ?? 99));

    // Find the first input that has a value
    const inputWithValue = groupInputs.find((input) => {
      const value = values[input.name];
      return value !== undefined && value !== null && value !== "";
    });

    if (inputWithValue) {
      result.push(inputWithValue);
    } else {
      // No input has value, show the highest priority one
      result.push(groupInputs[0]);
    }
  }

  return result;
}

/**
 * Get all inputs from a group for toggling
 */
export function getMutuallyExclusiveGroup(inputs: ProcessedInput[], groupId: string): ProcessedInput[] {
  return inputs
    .filter((input) => input.uiMeta?.mutually_exclusive_group === groupId)
    .sort((a, b) => (a.uiMeta?.priority ?? 99) - (b.uiMeta?.priority ?? 99));
}
