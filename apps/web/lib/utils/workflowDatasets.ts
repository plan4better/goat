import type { Edge, Node } from "@xyflow/react";

import { parseCQLQueryToObject } from "@/lib/transformers/filter";
import type { ProjectLayer } from "@/lib/validations/project";
import type { DatasetNodeData, ToolNodeData } from "@/lib/validations/workflow";

import { OPPORTUNITY_LAYER_HANDLES } from "@/types/map/ogc-processes";
import type { OGCInputSchema, OGCProcessDescription, UIFieldMeta } from "@/types/map/ogc-processes";

/** A node without named inputs takes its edge on this handle. */
const DEFAULT_INPUT_HANDLE = "input";

/** The canvas node shape the workflow store holds (xyflow's), narrowed by
 * the guards below to the data each node type carries. */
export type CanvasNode = Node;
export type CanvasEdge = Edge;

/** A dataset node as the Replace datasets dialog lists it. */
export interface DatasetRow {
  node: CanvasNode;
  data: DatasetNodeData;
  /** Labels of the tool nodes this dataset feeds, in edge order. */
  feeds: string[];
}

export const isDatasetNode = (node: CanvasNode): node is CanvasNode & { data: DatasetNodeData } =>
  node.type === "dataset" && (node.data as { type?: unknown }).type === "dataset";

export const isToolNode = (node: CanvasNode): node is CanvasNode & { data: ToolNodeData } =>
  node.type === "tool" && (node.data as { type?: unknown }).type === "tool";

/** Every dataset node of the workflow, with the tools it feeds. */
export const datasetRows = (nodes: CanvasNode[], edges: CanvasEdge[]): DatasetRow[] => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter(isDatasetNode).map((node) => {
    const feeds: string[] = [];
    for (const edge of edges) {
      if (edge.source !== node.id) continue;
      const target = byId.get(edge.target);
      if (!target || !isToolNode(target)) continue;
      const label = target.data.label || target.data.processId;
      if (!feeds.includes(label)) feeds.push(label);
    }
    return { node, data: node.data, feeds };
  });
};

const LAYER_TYPES = new Set(["feature", "table", "raster"]);

/** The project layers a dataset node can be pointed at: same geometry and
 * layer type as the node declares, not locked, one entry per dataset. A
 * node whose type is not one of the layer types (older configs carry
 * "layer") is matched on geometry alone. */
export const sameShapeLayers = (layers: ProjectLayer[], data: DatasetNodeData): ProjectLayer[] => {
  const seen = new Set<string>();
  const layerType = data.layerType && LAYER_TYPES.has(data.layerType) ? data.layerType : null;
  return layers.filter((layer) => {
    if (layer.locked) return false;
    if (layerType && layer.type !== layerType) return false;
    if (data.geometryType && layer.feature_layer_geometry_type !== data.geometryType) return false;
    if (seen.has(layer.layer_id)) return false;
    seen.add(layer.layer_id);
    return true;
  });
};

/** The layer's own CQL filter, copied onto the node the way the dataset
 * node settings do when a project layer is picked there. */
const inheritedFilter = (layer: ProjectLayer): Record<string, unknown> | undefined => {
  const cql = layer.query?.cql as { op?: string; args?: unknown[] } | undefined;
  if (!cql?.op || !cql.args) return undefined;
  const expressions = parseCQLQueryToObject(cql as { op: string; args: unknown[] });
  return expressions.length > 0 ? { op: cql.op, expressions } : undefined;
};

type ScalarMapping = Map<string, unknown>;

const scalarKey = (value: number | string) => `${typeof value}:${value}`;

/** `value` with every scalar named in `mapping` swapped, walking objects and
 * arrays in one pass so a rewritten value is never rewritten again. Only
 * values are matched, never keys; booleans never match a number. */
const replaceScalars = (value: unknown, mapping: ScalarMapping): unknown => {
  if (Array.isArray(value)) return value.map((item) => replaceScalars(item, mapping));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        replaceScalars(item, mapping),
      ])
    );
  }
  if (typeof value === "number" || typeof value === "string") {
    const key = scalarKey(value);
    return mapping.has(key) ? mapping.get(key) : value;
  }
  return value;
};

export interface NodeChange {
  id: string;
  changes: { data: Record<string, unknown> };
}

/**
 * The node updates that point the picked dataset nodes at other project
 * layers: each dataset node takes the layer's identity and filter (as the
 * node settings' "From project" pick does) and every tool node's config
 * has the old projectLayerId / layerId scalars rewritten to the new ones —
 * the same rewrite the backend applies when a template is bound.
 */
export const replaceDatasetLayers = (
  nodes: CanvasNode[],
  picks: Record<string, ProjectLayer>
): NodeChange[] => {
  const changes: NodeChange[] = [];
  const mapping: ScalarMapping = new Map();
  for (const node of nodes) {
    if (!isDatasetNode(node)) continue;
    const layer = picks[node.id];
    if (!layer || layer.layer_id === node.data.layerId) continue;
    const data = node.data as DatasetNodeData & { unresolved?: boolean };
    if (typeof data.projectLayerId === "number" && data.projectLayerId !== layer.id) {
      mapping.set(scalarKey(data.projectLayerId), layer.id);
    }
    if (data.layerId) mapping.set(scalarKey(data.layerId), layer.layer_id);
    const next: DatasetNodeData & { unresolved?: boolean } = {
      ...data,
      label: layer.name,
      projectLayerId: layer.id,
      layerId: layer.layer_id,
      layerName: layer.name,
      geometryType: layer.feature_layer_geometry_type || undefined,
      layerType: (layer.type as DatasetNodeData["layerType"]) || undefined,
      filter: inheritedFilter(layer),
      filterInitialized: true,
    };
    delete next.unresolved;
    changes.push({ id: node.id, changes: { data: next as Record<string, unknown> } });
  }
  if (mapping.size > 0) {
    for (const node of nodes) {
      if (!isToolNode(node)) continue;
      const config = node.data.config ?? {};
      const rewritten = replaceScalars(config, mapping) as Record<string, unknown>;
      if (JSON.stringify(rewritten) !== JSON.stringify(config)) {
        changes.push({
          id: node.id,
          changes: { data: { ...node.data, config: rewritten } as Record<string, unknown> },
        });
      }
    }
  }
  return changes;
};

/** One field name a tool's config points at, and which layer input it
 * belongs to. */
export interface FieldRef {
  /** Config path for wording: the input name, plus `[index].prop` inside a
   * repeatable array. */
  input: string;
  label: string;
  field: string;
  /** The layer input (edge handle) the field is read from; null when the
   * schema gives no hint and the tool has several layer inputs. */
  sourceInput: string | null;
}

const uiOf = (schema: OGCInputSchema | undefined): UIFieldMeta | undefined =>
  schema?.["x-ui"] ?? schema?.anyOf?.find((variant) => variant.type !== "null")?.["x-ui"];

const effective = (schema: OGCInputSchema): OGCInputSchema =>
  schema.anyOf?.find((variant) => variant.type !== "null") ?? schema;

const isFieldWidget = (name: string, ui: UIFieldMeta | undefined) =>
  ui?.widget === "field-selector" || (!ui?.widget && /_field$/.test(name));

/** "target_field" → "target_layer_id", the convention the field inputs use
 * when the schema names no source layer. */
const conventionalSource = (name: string): string | null => {
  const match = /^(.+)_field$/.exec(name);
  return match ? `${match[1]}_layer_id` : null;
};

const layerInputsOf = (process: OGCProcessDescription): string[] =>
  Object.entries(process.inputs ?? {})
    .filter(([, input]) => {
      const widget = uiOf(input.schema)?.widget;
      return widget === "layer-selector" || widget === "starting-points";
    })
    .map(([name]) => name);

/** Every field reference a tool node's config holds, read against the
 * process description: plain field inputs, field-statistics objects and
 * the `_field` props of repeatable arrays (opportunities, join attributes). */
export const fieldRefsOf = (process: OGCProcessDescription, config: Record<string, unknown>): FieldRef[] => {
  const refs: FieldRef[] = [];
  const layerInputs = layerInputsOf(process);
  const soleLayerInput = layerInputs.length === 1 ? layerInputs[0] : null;
  const sourceFor = (name: string, ui: UIFieldMeta | undefined): string | null => {
    const declared = ui?.widget_options?.source_layer;
    if (typeof declared === "string") return declared;
    return conventionalSource(name) ?? soleLayerInput;
  };
  for (const [name, input] of Object.entries(process.inputs ?? {})) {
    const ui = uiOf(input.schema);
    const label = ui?.label ?? input.title ?? name;
    const value = config[name];
    if (ui?.widget === "field-statistics-selector") {
      const field = (value as { field?: unknown } | undefined)?.field;
      if (typeof field === "string" && field)
        refs.push({ input: name, label, field, sourceInput: sourceFor(name, ui) });
      continue;
    }
    if (isFieldWidget(name, ui)) {
      if (typeof value === "string" && value)
        refs.push({ input: name, label, field: value, sourceInput: sourceFor(name, ui) });
      continue;
    }
    const schema = effective(input.schema);
    if (schema.type === "array" && Array.isArray(value)) {
      const itemRef = schema.items?.$ref?.replace("#/$defs/", "");
      const itemSchema = itemRef ? process.$defs?.[itemRef] : schema.items;
      const props = itemSchema?.properties;
      if (!props) continue;
      const isOpportunities = name === "opportunities";
      value.forEach((item, index) => {
        if (!item || typeof item !== "object") return;
        for (const [prop, propSchema] of Object.entries(props)) {
          const propUi = uiOf(propSchema);
          if (!isFieldWidget(prop, propUi)) continue;
          const field = (item as Record<string, unknown>)[prop];
          if (typeof field !== "string" || !field) continue;
          const sourceInput = isOpportunities
            ? (OPPORTUNITY_LAYER_HANDLES[index] ?? null)
            : sourceFor(name, ui);
          refs.push({
            input: `${name}[${index}].${prop}`,
            label: `${label} · ${propUi?.label ?? prop}`,
            field,
            sourceInput,
          });
        }
      });
    }
  }
  return refs;
};

/** The dataset node wired into `toolNode`'s `sourceInput` handle; with no
 * handle named, the single incoming dataset edge. */
export const sourceDatasetFor = (
  toolNode: CanvasNode,
  sourceInput: string | null,
  edges: CanvasEdge[],
  nodes: CanvasNode[]
): (CanvasNode & { data: DatasetNodeData }) | null => {
  const incoming = edges.filter((edge) => edge.target === toolNode.id);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const datasetOf = (edge: CanvasEdge | undefined) => {
    const node = edge ? byId.get(edge.source) : undefined;
    return node && isDatasetNode(node) ? node : null;
  };
  if (sourceInput) {
    const exact = incoming.find((edge) => edge.targetHandle === sourceInput);
    if (exact) return datasetOf(exact);
  }
  const unnamed = incoming.filter((edge) => !edge.targetHandle || edge.targetHandle === DEFAULT_INPUT_HANDLE);
  if (unnamed.length === 1) return datasetOf(unnamed[0]);
  if (!sourceInput && incoming.length === 1) return datasetOf(incoming[0]);
  return null;
};

export interface MissingField {
  toolLabel: string;
  paramLabel: string;
  field: string;
  layerName: string;
}

/**
 * The field references of one tool node that its upstream dataset layers do
 * not carry. A layer whose fields are not in `fieldsByLayerId` (still
 * loading, or not a project layer) is not judged.
 */
export const missingFieldRefs = (
  toolNode: CanvasNode & { data: ToolNodeData },
  process: OGCProcessDescription | undefined,
  edges: CanvasEdge[],
  nodes: CanvasNode[],
  fieldsByLayerId: Record<string, string[] | undefined>
): MissingField[] => {
  if (!process) return [];
  const missing: MissingField[] = [];
  for (const ref of fieldRefsOf(process, toolNode.data.config ?? {})) {
    const dataset = sourceDatasetFor(toolNode, ref.sourceInput, edges, nodes);
    const layerId = dataset?.data.layerId;
    const fields = layerId ? fieldsByLayerId[layerId] : undefined;
    if (!fields || fields.includes(ref.field)) continue;
    missing.push({
      toolLabel: toolNode.data.label || toolNode.data.processId,
      paramLabel: ref.label,
      field: ref.field,
      layerName: dataset?.data.layerName || dataset?.data.label || "",
    });
  }
  return missing;
};
