import * as z from "zod";

import type { ToolNodeData } from "@/lib/validations/workflow";

// Keys match what the workflow runner reads; params never carry user_id, project_id or folder_id.
export const datasetConnectionSchema = z.object({
  processId: z.literal("fetch_data"),
  params: z.record(z.unknown()),
  summary: z.string(),
  geometryType: z.string(),
  fields: z.array(z.object({ name: z.string(), type: z.string() })),
  // How the area was chosen, so the dialog reopens on it; the runner reads only params.
  areaChoice: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("region"),
        nutsIds: z.array(z.string()),
        names: z.record(z.string()).optional(),
      }),
      z.object({
        kind: z.literal("point"),
        lng: z.number(),
        lat: z.number(),
        km: z.number(),
        label: z.string().optional(),
      }),
      z.object({ kind: z.literal("polygon"), ring: z.array(z.tuple([z.number(), z.number()])) }),
      z.object({ kind: z.literal("view"), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]) }),
    ])
    .optional(),
});

export type DatasetConnection = z.infer<typeof datasetConnectionSchema>;

export const INTEGRATE_PROCESS_ID = "fetch_data";

/** The node's saved choice in the shape the dialog reopens on; none before a first choice. */
export const connectionFromNode = (data: ToolNodeData): DatasetConnection | undefined =>
  data.config?.area
    ? {
        processId: INTEGRATE_PROCESS_ID,
        params: data.config,
        summary: data.label,
        geometryType: data.outputGeometryType ?? "",
        fields: data.outputFields ?? [],
        ...(data.areaChoice ? { areaChoice: data.areaChoice } : {}),
      }
    : undefined;

/** What a choice writes on the node. */
export const nodeDataFromConnection = (connection: DatasetConnection): Partial<ToolNodeData> => ({
  config: connection.params,
  label: connection.summary,
  outputGeometryType: connection.geometryType,
  outputFields: connection.fields,
  areaChoice: connection.areaChoice,
});

/** A fetch without an area cannot run. */
export const integrationNeedsArea = (data: ToolNodeData): boolean =>
  data.processId === INTEGRATE_PROCESS_ID && !data.config?.area;

// The mirror's geometry kinds as the DuckDB type schema prediction reads.
const GEOMETRY_COLUMN: Record<string, string> = {
  point: "GEOMETRY(POINT)",
  line: "GEOMETRY(LINESTRING)",
  polygon: "GEOMETRY(POLYGON)",
};

/** The columns a fetch will write, as predicted columns; undefined for any other node or before a choice. */
export const integrationColumns = (data: ToolNodeData): Record<string, string> | undefined => {
  if (data.processId !== INTEGRATE_PROCESS_ID || !data.outputFields?.length) return undefined;
  const columns = Object.fromEntries(data.outputFields.map((f) => [f.name, f.type]));
  if (data.outputGeometryType) columns.geometry = GEOMETRY_COLUMN[data.outputGeometryType] ?? "GEOMETRY";
  return columns;
};
