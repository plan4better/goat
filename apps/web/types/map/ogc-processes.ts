/**
 * OGC API Processes types for generic toolbox
 *
 * Based on OGC API - Processes - Part 1: Core (OGC 18-062r2)
 * Extended with UI hints for generic form rendering
 */

// ============================================================================
// OGC Process List Types
// ============================================================================

export interface OGCLink {
  href: string;
  rel: string;
  type?: string;
  title?: string;
  templated?: boolean;
}

export interface OGCProcessSummary {
  id: string;
  title: string;
  description?: string;
  version: string;
  jobControlOptions: string[];
  outputTransmission: string[];
  links: OGCLink[];
  "x-ui-toolbox-hidden"?: boolean;
  "x-ui-category"?: string;
  "x-ui-beta"?: boolean;
}

export interface OGCProcessList {
  processes: OGCProcessSummary[];
  links: OGCLink[];
}

// ============================================================================
// OGC Process Description Types
// ============================================================================

export interface OGCMetadata {
  title: string;
  role?: string;
  href?: string;
  value?: unknown;
}

export interface OGCInputDescription {
  title: string;
  description?: string;
  schema: OGCInputSchema;
  minOccurs: number;
  maxOccurs: number | string;
  keywords: string[];
  metadata: OGCMetadata[];
}

export interface OGCOutputDescription {
  title: string;
  description?: string;
  schema: OGCInputSchema;
  metadata?: OGCMetadata[];
}

export interface OGCProcessDescription extends OGCProcessSummary {
  inputs: Record<string, OGCInputDescription>;
  outputs: Record<string, OGCOutputDescription>;
  "x-ui-sections"?: UISection[];
  /** JSON Schema $defs for resolving $ref references in nested schemas */
  $defs?: Record<string, OGCInputSchema>;
}

// ============================================================================
// JSON Schema Types (subset used by OGC)
// ============================================================================

/**
 * UI metadata for a field (x-ui in schema)
 */
export interface UIFieldMeta {
  section?: string;
  field_order?: number;
  label?: string;
  description?: string;
  hidden?: boolean;
  advanced?: boolean;
  optional?: boolean;
  visible_when?: Record<string, unknown>;
  hidden_when?: Record<string, unknown>;
  mutually_exclusive_group?: string;
  priority?: number;
  repeatable?: boolean;
  min_items?: number;
  max_items?: number;
  widget?: string;
  widget_options?: Record<string, unknown>;
  enum_icons?: Record<string, string>;
  enum_labels?: Record<string, string>;
  inline_group?: string;
  inline_flex?: string;
  group_label?: string;
}

/**
 * UI section definition (from x-ui-sections)
 */
export interface UISection {
  id: string;
  order: number;
  icon?: string;
  label?: string;
  label_key?: string;
  collapsible?: boolean;
  collapsed?: boolean;
  /** Condition for section to be enabled (same syntax as visible_when) */
  depends_on?: Record<string, unknown>;
}

export interface OGCInputSchema {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: (string | number | boolean)[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: OGCInputSchema;
  properties?: Record<string, OGCInputSchema>;
  required?: string[];
  anyOf?: OGCInputSchema[];
  oneOf?: OGCInputSchema[];
  allOf?: OGCInputSchema[];
  $ref?: string;
  $defs?: Record<string, OGCInputSchema>;
  "x-ui"?: UIFieldMeta;
}

// ============================================================================
// Execution Types
// ============================================================================

export interface OGCExecuteRequest {
  inputs: Record<string, unknown>;
  outputs?: Record<string, OGCOutputDefinition>;
  response?: "raw" | "document";
}

export interface OGCOutputDefinition {
  transmissionMode?: "value" | "reference";
  format?: Record<string, string>;
}

export interface OGCJobStatus {
  processID?: string;
  type: string;
  jobID: string;
  status: "accepted" | "running" | "successful" | "failed" | "dismissed";
  message?: string;
  created?: string;
  started?: string;
  finished?: string;
  updated?: string;
  progress?: number;
  links: OGCLink[];
}

// ============================================================================
// UI Helper Types
// ============================================================================

/**
 * Inferred input type based on schema analysis
 */
export type InferredInputType =
  | "layer" // Layer selector (keywords includes "layer")
  | "bundle" // Bundle selector (x-ui.widget is bundle-selector)
  | "field" // Field selector (keywords includes "field")
  | "enum" // Dropdown (schema has enum)
  | "multi-enum" // Multi-select dropdown (array of enums)
  | "boolean" // Switch (type is boolean)
  | "number" // Number input (type is number/integer)
  | "string" // Text input (type is string)
  | "array" // Array input (type is array of primitives)
  | "repeatable-object" // Repeatable array of objects (x-ui.repeatable)
  | "object" // Nested object (type is object)
  | "time-picker" // Time picker (x-ui.widget is time-picker)
  | "date-picker" // Date field, bounded by a bundle's service window (x-ui.widget is date-picker)
  | "starting-points" // Starting points selector (map clicks or layer)
  | "field-statistics" // Field statistics selector (operation + field)
  | "chips" // Editable chips (x-ui.widget is chips)
  | "unknown"; // Fallback

/**
 * Processed input for UI rendering
 */
export interface ProcessedInput {
  name: string;
  title: string;
  description?: string;
  inputType: InferredInputType;
  required: boolean;
  schema: OGCInputSchema;
  defaultValue?: unknown;
  enumValues?: (string | number | boolean)[];
  isLayerInput: boolean;
  geometryConstraints?: string[];
  metadata: OGCMetadata[];
  // UI metadata from x-ui
  section?: string;
  fieldOrder: number;
  advanced?: boolean;
  uiMeta?: UIFieldMeta;
}

/**
 * Processed section with its inputs
 */
export interface ProcessedSection {
  id: string;
  label: string;
  icon?: string;
  order: number;
  collapsible: boolean;
  collapsed: boolean;
  inputs: ProcessedInput[];
  /** Condition for section to be enabled */
  dependsOn?: Record<string, unknown>;
}

/**
 * Tool category for grouping in toolbox
 */
export type ToolCategory =
  | "geoprocessing"
  | "geoanalysis"
  | "data_management"
  | "accessibility_indicators"
  | "other";

/**
 * Tool with category assignment
 */
export interface CategorizedTool extends OGCProcessSummary {
  category: ToolCategory;
  icon?: string;
}

// ============================================================================
// Utility Functions Types
// ============================================================================

/**
 * Map tool IDs to icons (client-side mapping)
 * TODO: Move to backend x-ui-icon when available
 */
export const TOOL_ICON_MAP: Record<string, string> = {
  buffer: "BUFFER",
  clip: "CLIP",
  difference: "DIFFERENCE",
  intersection: "INTERSECTION",
  union: "UNION",
  merge: "MERGE",
  centroid: "CENTROID",
  join: "JOIN",
  origin_destination: "ROUTE",
  heatmap_gravity: "HEATMAP",
  heatmap_closest_average: "HEATMAP",
  heatmap_connectivity: "HEATMAP",
  oev_gueteklassen: "BUS",
};

/**
 * Numbered canvas handles some tools expose instead of a repeatable list — a
 * workflow edge can only target a named input, never a list element. In order;
 * mirrors MAX_OPPORTUNITY_LAYERS in goatlib's `_opportunity_handles`, which
 * declares the matching fields.
 */
export const OPPORTUNITY_LAYER_HANDLES = [
  "opportunity_layer_1_id",
  "opportunity_layer_2_id",
  "opportunity_layer_3_id",
];

/**
 * Inputs that should be hidden from the generic form (handled automatically)
 */
export const HIDDEN_INPUTS = ["user_id", "project_id", "save_results"];

/**
 * Inputs that should be shown in advanced settings
 */
export const ADVANCED_INPUTS = ["output_crs", "output_name"];
