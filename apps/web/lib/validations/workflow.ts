import * as z from "zod";

// ============================================================================
// Node Status
// ============================================================================

/**
 * Status of a workflow node during execution
 */
export const nodeStatusSchema = z.enum(["idle", "pending", "running", "completed", "error", "skipped"]);

export type NodeStatus = z.infer<typeof nodeStatusSchema>;

// ============================================================================
// Dataset Node
// ============================================================================

/**
 * Data schema for a dataset node - represents a layer input
 */
export const datasetNodeDataSchema = z.object({
  type: z.literal("dataset"),
  label: z.string(),
  // Project-scoped reference. When the node was created from a project layer, this is the
  // canonical lookup key used to render the current (live) name and survive renames.
  // Absent when the dataset was added directly from the Dataset Explorer.
  projectLayerId: z.number().int().optional(),
  // Layer reference - use layerId as the main identifier for API calls (tiles/features/fields)
  layerId: z.string().uuid().optional(), // Layer UUID - main identifier
  layerName: z.string().optional(),
  geometryType: z.string().optional(), // "point", "line", "polygon", etc.
  layerType: z.enum(["feature", "table", "raster"]).optional(), // Layer type (feature, table, raster)
  // Filter applied to the layer (workflow-specific, not persisted to layer)
  filter: z.record(z.unknown()).optional(), // CQL2-JSON filter
  filterInitialized: z.boolean().optional(), // True once filter has been initialized (prevents re-inheritance)
});

export type DatasetNodeData = z.infer<typeof datasetNodeDataSchema>;

// ============================================================================
// Tool Node
// ============================================================================

/**
 * Data schema for a tool node - represents a process/tool execution
 */
export const toolNodeDataSchema = z.object({
  type: z.literal("tool"),
  processId: z.string(), // e.g., "buffer", "catchment_area", "clip"
  label: z.string(),
  // Tool configuration (parameters excluding layer inputs)
  config: z.record(z.unknown()).default({}),
  // Execution state
  status: nodeStatusSchema.default("idle"),
  outputLayerId: z.string().uuid().optional(), // Result layer UUID after execution (temporary, not added to project)
  jobId: z.string().optional(), // Windmill job ID during execution
  error: z.string().optional(), // Error message if status is "error"
});

export type ToolNodeData = z.infer<typeof toolNodeDataSchema>;

// ============================================================================
// Text Annotation Node
// ============================================================================

/**
 * Data schema for a text annotation node - for notes and documentation on the canvas
 */
export const textAnnotationNodeDataSchema = z.object({
  type: z.literal("textAnnotation"),
  text: z.string().default("<p></p>"), // HTML content from TipTap
  backgroundColor: z.string().default("#F2CE58"), // Default warm golden/amber
  width: z.number().default(400),
  height: z.number().default(200),
});

export type TextAnnotationNodeData = z.infer<typeof textAnnotationNodeDataSchema>;

// ============================================================================
// Export Node
// ============================================================================

/**
 * Data schema for an export node - saves workflow results as permanent datasets
 */
export const exportNodeDataSchema = z.object({
  type: z.literal("export"),
  label: z.string(),
  datasetName: z.string().default(""), // Name for the exported dataset
  addToProject: z.boolean().default(true), // Whether to add the exported layer to the current project
  overwritePrevious: z.boolean().default(false), // Overwrite dataset from previous run
  // Execution state
  status: nodeStatusSchema.default("idle"),
  exportedLayerId: z.string().uuid().optional(), // Resulting permanent layer ID after export
  // The author's style for the result, from a workflow template: applied when
  // the export creates a new layer; an overwritten result keeps its own style
  outputStyle: z.record(z.unknown()).optional(),
  // "Add to existing" (goatlib's layer_append) instead of a new dataset:
  // the rows go into a dataset the user may edit. Absent means "new".
  destination: z.enum(["new", "existing"]).optional(),
  targetLayerId: z.string().uuid().optional(), // The dataset the rows are added to
  targetLayerName: z.string().optional(), // Display only
  jobId: z.string().optional(), // Windmill job ID during finalization
  error: z.string().optional(), // Error message if status is "error"
});

export type ExportNodeData = z.infer<typeof exportNodeDataSchema>;

// ============================================================================
// Conditional Node (binary if/else branching)
// ============================================================================

/**
 * Reserved source-handle ids for the Conditional node's two outputs.
 * Mirrored in [packages/python/goatlib/src/goatlib/tools/workflow_runner.py].
 */
export const IF_TRUE_HANDLE = "true";
export const IF_FALSE_HANDLE = "false";

/**
 * A statistic-style condition row inside the Simple-condition builder.
 * Evaluates an aggregate over the upstream layer (e.g. ``COUNT(*) > 100``,
 * ``AVG(population) >= 500``).
 */
export const ifStatisticExpressionSchema = z.object({
  id: z.string(),
  /** Marker so the evaluator can distinguish from logical filter rows. */
  kind: z.literal("statistic"),
  /** Aggregate method — `count` requires no field; the others need one. */
  method: z.enum(["count", "sum", "mean", "median", "min", "max"]).optional(),
  /** Field/column to aggregate. Empty for `count(*)`. */
  field: z.string().optional(),
  /** Comparison operator against the threshold value. */
  operator: z.enum(["=", "!=", ">", ">=", "<", "<="]).optional(),
  /** Threshold. Accepts a number, a literal string, or a {{@variable}} reference. */
  value: z.union([z.string(), z.number()]).optional(),
});

export type IfStatisticExpression = z.infer<typeof ifStatisticExpressionSchema>;

/**
 * Data schema for the Conditional (if/else) node. Evaluates a single rule
 * against the connected upstream layer; rows matching the condition flow
 * through the TRUE handle, the rest through FALSE.
 */
export const ifNodeDataSchema = z.object({
  type: z.literal("if"),
  label: z.string(),
  mode: z.enum(["simple", "custom"]).default("simple"),
  // Simple-mode condition: mix of logical filter rows and statistic rows
  condition: z
    .object({
      op: z.string(),
      expressions: z.array(z.record(z.unknown())),
    })
    .optional(),
  // Custom-mode free-text SQL expression
  customExpression: z.string().default(""),
  // Populated by the executor; identifies which output handle was taken
  activeHandle: z.enum(["true", "false"]).optional(),
  status: nodeStatusSchema.default("idle"),
  error: z.string().optional(),
});

export type IfNodeData = z.infer<typeof ifNodeDataSchema>;

// ============================================================================
// Workflow Node (ReactFlow compatible)
// ============================================================================

/**
 * Workflow node schema - compatible with ReactFlow's Node type
 */
export const workflowNodeSchema = z.object({
  id: z.string(),
  type: z.enum(["dataset", "tool", "textAnnotation", "export", "if"]),
  position: z.object({
    x: z.number(),
    y: z.number(),
  }),
  data: z.discriminatedUnion("type", [
    datasetNodeDataSchema,
    toolNodeDataSchema,
    textAnnotationNodeDataSchema,
    exportNodeDataSchema,
    ifNodeDataSchema,
  ]),
  // Optional ReactFlow properties
  width: z.number().optional(),
  height: z.number().optional(),
  selected: z.boolean().optional(),
  dragging: z.boolean().optional(),
  zIndex: z.number().optional(),
  style: z.record(z.unknown()).optional(),
});

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

// ============================================================================
// Workflow Edge (ReactFlow compatible)
// ============================================================================

/**
 * Workflow edge schema - compatible with ReactFlow's Edge type
 */
export const workflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(), // Source node ID
  target: z.string(), // Target node ID
  sourceHandle: z.string().optional(), // Output handle ID (usually just one per node)
  targetHandle: z.string().optional(), // Input handle ID (e.g., "input_layer_id", "clip_layer_id")
  // Optional styling
  animated: z.boolean().optional(),
  style: z.record(z.unknown()).optional(),
});

export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

// ============================================================================
// Workflow Variable
// ============================================================================

/** Longest display label a workflow variable may carry. */
export const WORKFLOW_VARIABLE_LABEL_MAX = 120;
/** Longest help text a workflow variable may carry. */
export const WORKFLOW_VARIABLE_DESCRIPTION_MAX = 500;

/**
 * A workflow-level variable that can be referenced in tool parameters
 * using {{@variable_name}} syntax.
 *
 * `name` is the identifier expressions and SQL use. `label` and `description`
 * are optional and display-only: users see the label (falling back to the
 * name) wherever they pick or fill in a variable, and the description as help
 * text. The runner resolves variables by `name` alone, so neither affects a
 * run. Workflows saved before they existed simply lack both keys.
 */
export const workflowVariableSchema = z.object({
  id: z.string(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  label: z.string().max(WORKFLOW_VARIABLE_LABEL_MAX).optional(),
  description: z.string().max(WORKFLOW_VARIABLE_DESCRIPTION_MAX).optional(),
  type: z.enum(["string", "number"]),
  defaultValue: z.union([z.string(), z.number()]).optional(),
  order: z.number().int().default(0),
});

export type WorkflowVariable = z.infer<typeof workflowVariableSchema>;

/** What users see for a variable: its label, or its name when it has none. */
export function getVariableDisplayName(variable: Pick<WorkflowVariable, "name" | "label">): string {
  const label = variable.label?.trim();
  return label ? label : variable.name;
}

/** Whether the variable's display name differs from its technical name. */
export function hasVariableLabel(variable: Pick<WorkflowVariable, "name" | "label">): boolean {
  return getVariableDisplayName(variable) !== variable.name;
}

/** The variable's help text, or undefined when it has none worth showing. */
export function getVariableDescription(variable: Pick<WorkflowVariable, "description">): string | undefined {
  const description = variable.description?.trim();
  return description ? description : undefined;
}

// ============================================================================
// Workflow Config
// ============================================================================

/**
 * Full workflow configuration stored in the database
 */
export const workflowConfigSchema = z.object({
  nodes: z.array(workflowNodeSchema).default([]),
  edges: z.array(workflowEdgeSchema).default([]),
  viewport: z
    .object({
      x: z.number(),
      y: z.number(),
      zoom: z.number(),
    })
    .default({ x: 0, y: 0, zoom: 1 }),
  variables: z.array(workflowVariableSchema).default([]),
});

export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;

// ============================================================================
// Workflow Entity
// ============================================================================

/**
 * Workflow entity as returned from the API
 */
export const workflowSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  is_default: z.boolean(),
  config: workflowConfigSchema,
  thumbnail_url: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Workflow = z.infer<typeof workflowSchema>;

// ============================================================================
// Create/Update Schemas
// ============================================================================

/**
 * Schema for creating a new workflow
 */
export const workflowCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  is_default: z.boolean().default(false),
  config: workflowConfigSchema,
});

export type WorkflowCreate = z.infer<typeof workflowCreateSchema>;

/**
 * Schema for updating an existing workflow
 */
export const workflowUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  is_default: z.boolean().optional(),
  config: workflowConfigSchema.optional(),
});

export type WorkflowUpdate = z.infer<typeof workflowUpdateSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create an empty workflow config
 */
export const createEmptyWorkflowConfig = (): WorkflowConfig => ({
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  variables: [],
});

/**
 * Create a new dataset node
 */
export const createDatasetNode = (
  id: string,
  position: { x: number; y: number },
  label: string = "Dataset"
): WorkflowNode => ({
  id,
  type: "dataset",
  position,
  zIndex: 1000, // Dataset nodes appear above text annotations
  data: {
    type: "dataset",
    label,
  },
});

/**
 * Create a new tool node
 */
export const createToolNode = (
  id: string,
  position: { x: number; y: number },
  processId: string,
  label: string
): WorkflowNode => ({
  id,
  type: "tool",
  position,
  zIndex: 1000, // Tool nodes appear above text annotations
  data: {
    type: "tool",
    processId,
    label,
    config: {},
    status: "idle",
  },
});

/**
 * Create a new text annotation node
 */
export const createTextAnnotationNode = (
  id: string,
  position: { x: number; y: number },
  width: number = 400,
  height: number = 200,
  text: string = "<h2>Header</h2><p>This is an example paragraph. You can write your text here. You can use <em>italic</em> or <strong>bold</strong> to highlight words.</p>",
  backgroundColor: string = "#F2CE58"
): WorkflowNode => ({
  id,
  type: "textAnnotation",
  position,
  zIndex: -1000, // Text annotations always appear below other nodes, even when selected
  data: {
    type: "textAnnotation",
    text,
    backgroundColor,
    width,
    height,
  },
});

/**
 * Check if a node is a dataset node
 */
export const isDatasetNode = (node: WorkflowNode): node is WorkflowNode & { data: DatasetNodeData } =>
  node.data.type === "dataset";

/**
 * Check if a node is a tool node
 */
export const isToolNode = (node: WorkflowNode): node is WorkflowNode & { data: ToolNodeData } =>
  node.data.type === "tool";

/**
 * Check if a node is a text annotation node
 */
export const isTextAnnotationNode = (
  node: WorkflowNode
): node is WorkflowNode & { data: TextAnnotationNodeData } => node.data.type === "textAnnotation";

/**
 * Check if a node is an export node
 */
export const isExportNode = (node: WorkflowNode): node is WorkflowNode & { data: ExportNodeData } =>
  node.data.type === "export";

/**
 * Check if a node is an If/Switch node
 */
export const isIfNode = (node: WorkflowNode): node is WorkflowNode & { data: IfNodeData } =>
  node.data.type === "if";

/**
 * Create a new export node
 */
export const createExportNode = (
  id: string,
  position: { x: number; y: number },
  label: string = "Export Dataset"
): WorkflowNode => ({
  id,
  type: "export",
  position,
  zIndex: 1000,
  data: {
    type: "export",
    label,
    datasetName: "",
    addToProject: true,
    overwritePrevious: false,
    status: "idle",
  },
});

/**
 * Create a new Conditional (binary if/else) node.
 */
export const createIfNode = (
  id: string,
  position: { x: number; y: number },
  label: string = "Conditional"
): WorkflowNode => ({
  id,
  type: "if",
  position,
  zIndex: 1000,
  data: {
    type: "if",
    label,
    mode: "simple",
    customExpression: "",
    status: "idle",
  },
});
