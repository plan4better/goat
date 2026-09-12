import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import {
  datasetRows,
  fieldRefsOf,
  missingFieldRefs,
  replaceDatasetLayers,
  sameShapeLayers,
  sourceDatasetFor,
} from "@/lib/utils/workflowDatasets";
import type { ProjectLayer } from "@/lib/validations/project";

import type { OGCProcessDescription } from "@/types/map/ogc-processes";

const dataset = (id: string, layerId: string, projectLayerId: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type: "dataset",
    position: { x: 0, y: 0 },
    data: {
      type: "dataset",
      label: `Layer ${projectLayerId}`,
      layerId,
      projectLayerId,
      layerName: `Layer ${projectLayerId}`,
      geometryType: "point",
      layerType: "feature",
      ...extra,
    },
  }) as unknown as Node;

const tool = (id: string, processId: string, label: string, config: Record<string, unknown>) =>
  ({
    id,
    type: "tool",
    position: { x: 0, y: 0 },
    data: { type: "tool", processId, label, config, status: "idle" },
  }) as unknown as Node & {
    data: { type: "tool"; processId: string; label: string; config: Record<string, unknown> };
  };

const edge = (source: string, target: string, targetHandle?: string): Edge => ({
  id: `${source}-${target}-${targetHandle ?? ""}`,
  source,
  target,
  targetHandle,
});

const layer = (
  id: number,
  layerId: string,
  name: string,
  geometry = "point",
  extra: Partial<ProjectLayer> = {}
) =>
  ({
    id,
    layer_id: layerId,
    name,
    type: "feature",
    feature_layer_geometry_type: geometry,
    locked: false,
    ...extra,
  }) as unknown as ProjectLayer;

const aggregate: OGCProcessDescription = {
  id: "aggregate_point",
  version: "1",
  title: "Aggregate points",
  inputs: {
    source_layer_id: {
      title: "Source",
      schema: { "x-ui": { widget: "layer-selector" } },
      minOccurs: 1,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
    area_layer_id: {
      title: "Area",
      schema: { "x-ui": { widget: "layer-selector" } },
      minOccurs: 1,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
    group_by_field: {
      title: "Group by",
      schema: {
        type: "string",
        "x-ui": { widget: "field-selector", widget_options: { source_layer: "source_layer_id" } },
      },
      minOccurs: 0,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
    area_field: {
      title: "Area field",
      schema: { type: "string" },
      minOccurs: 0,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
    statistics: {
      title: "Statistics",
      schema: {
        type: "object",
        "x-ui": { widget: "field-statistics-selector", widget_options: { source_layer: "source_layer_id" } },
      },
      minOccurs: 0,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
  },
  outputs: {},
} as unknown as OGCProcessDescription;

const heatmap: OGCProcessDescription = {
  id: "heatmap",
  version: "1",
  title: "Heatmap",
  inputs: {
    opportunity_layer_1_id: {
      title: "Opp 1",
      schema: { "x-ui": { widget: "layer-selector" } },
      minOccurs: 0,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
    opportunity_layer_2_id: {
      title: "Opp 2",
      schema: { "x-ui": { widget: "layer-selector" } },
      minOccurs: 0,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
    opportunities: {
      title: "Opportunities",
      schema: { type: "array", items: { $ref: "#/$defs/Opportunity" }, "x-ui": { repeatable: true } },
      minOccurs: 1,
      maxOccurs: 3,
      keywords: [],
      metadata: [],
    },
  },
  outputs: {},
  $defs: {
    Opportunity: {
      type: "object",
      properties: {
        input_path: { type: "string" },
        potential_field: {
          type: "string",
          "x-ui": { widget: "field-selector", widget_options: { source_layer: "input_path" } },
        },
      },
    },
  },
} as unknown as OGCProcessDescription;

describe("datasetRows", () => {
  it("lists dataset nodes with the tools they feed", () => {
    const nodes = [
      dataset("d1", "L1", 1),
      dataset("d2", "L2", 2),
      tool("t1", "buffer", "Buffer", {}),
      tool("t2", "clip", "Clip", {}),
    ];
    const edges = [edge("d1", "t1"), edge("d1", "t2", "clip_layer_id"), edge("d2", "t2", "input_layer_id")];
    const rows = datasetRows(nodes, edges);
    expect(rows.map((row) => row.node.id)).toEqual(["d1", "d2"]);
    expect(rows[0].feeds).toEqual(["Buffer", "Clip"]);
    expect(rows[1].feeds).toEqual(["Clip"]);
  });
});

describe("sameShapeLayers", () => {
  it("keeps layers of the node's geometry and type, unlocked, one per dataset", () => {
    const layers = [
      layer(1, "L1", "Points A"),
      layer(2, "L1", "Points A (again)"),
      layer(3, "L3", "Polys", "polygon"),
      layer(4, "L4", "Locked", "point", { locked: true }),
      layer(5, "L5", "Table", "point", { type: "table" } as Partial<ProjectLayer>),
    ];
    const node = dataset("d1", "L9", 9);
    expect(sameShapeLayers(layers, node.data as never).map((l) => l.id)).toEqual([1]);
  });

  it("matches on geometry alone when the node carries a type that is not a layer type", () => {
    const layers = [layer(1, "L1", "Points A"), layer(3, "L3", "Polys", "polygon")];
    const node = dataset("d1", "L9", 9, { layerType: "layer" });
    expect(sameShapeLayers(layers, node.data as never).map((l) => l.id)).toEqual([1]);
  });
});

describe("replaceDatasetLayers", () => {
  it("re-points the dataset node and rewrites tool configs that named the old ids", () => {
    const nodes = [
      dataset("d1", "L1", 11, { unresolved: true }),
      tool("t1", "join", "Join", { target_layer_project_id: 11, other: 11, keep: 12, ref: "L1", flag: true }),
    ];
    const next = layer(21, "L21", "Stops", "point", {
      query: { cql: { op: "and", args: [] } },
    } as Partial<ProjectLayer>);
    const changes = replaceDatasetLayers(nodes, { d1: next });
    expect(changes).toHaveLength(2);
    const datasetChange = changes[0].changes.data as Record<string, unknown>;
    expect(datasetChange).toMatchObject({
      label: "Stops",
      layerName: "Stops",
      layerId: "L21",
      projectLayerId: 21,
      geometryType: "point",
      layerType: "feature",
      filterInitialized: true,
    });
    expect(datasetChange.unresolved).toBeUndefined();
    const toolChange = changes[1].changes.data as { config: Record<string, unknown> };
    expect(toolChange.config).toEqual({
      target_layer_project_id: 21,
      other: 21,
      keep: 12,
      ref: "L21",
      flag: true,
    });
  });

  it("changes nothing for a pick equal to the current layer", () => {
    const nodes = [dataset("d1", "L1", 11)];
    expect(replaceDatasetLayers(nodes, { d1: layer(11, "L1", "Same") })).toEqual([]);
  });
});

describe("fieldRefsOf", () => {
  it("reads plain field inputs, statistics objects and the convention for the source layer", () => {
    const refs = fieldRefsOf(aggregate, {
      group_by_field: "name",
      area_field: "district",
      statistics: { operation: "sum", field: "population" },
    });
    expect(refs).toEqual([
      { input: "group_by_field", label: "Group by", field: "name", sourceInput: "source_layer_id" },
      { input: "area_field", label: "Area field", field: "district", sourceInput: "area_layer_id" },
      { input: "statistics", label: "Statistics", field: "population", sourceInput: "source_layer_id" },
    ]);
  });

  it("maps repeatable opportunity items to their numbered handles", () => {
    const refs = fieldRefsOf(heatmap, {
      opportunities: [
        { input_path: "x", potential_field: "jobs" },
        { input_path: "y", potential_field: "seats" },
      ],
    });
    expect(refs.map((ref) => [ref.field, ref.sourceInput])).toEqual([
      ["jobs", "opportunity_layer_1_id"],
      ["seats", "opportunity_layer_2_id"],
    ]);
  });
});

describe("sourceDatasetFor", () => {
  it("follows the named handle, else the single unnamed edge", () => {
    const nodes = [dataset("d1", "L1", 1), dataset("d2", "L2", 2), tool("t1", "x", "X", {})];
    const t1 = nodes[2];
    expect(
      sourceDatasetFor(
        t1,
        "area_layer_id",
        [edge("d1", "t1", "source_layer_id"), edge("d2", "t1", "area_layer_id")],
        nodes
      )?.id
    ).toBe("d2");
    expect(sourceDatasetFor(t1, "source_layer_id", [edge("d1", "t1")], nodes)?.id).toBe("d1");
    expect(
      sourceDatasetFor(t1, "source_layer_id", [edge("d1", "t1", "a"), edge("d2", "t1", "b")], nodes)
    ).toBeNull();
  });
});

describe("missingFieldRefs", () => {
  const nodes = [
    dataset("d1", "L1", 1, { layerName: "Stops" }),
    dataset("d2", "L2", 2),
    tool("t1", "aggregate_point", "Aggregate points", { group_by_field: "name", area_field: "district" }),
  ];
  const edges = [edge("d1", "t1", "source_layer_id"), edge("d2", "t1", "area_layer_id")];

  it("names the fields the upstream layer lacks, per tool", () => {
    const missing = missingFieldRefs(nodes[2] as never, aggregate, edges, nodes, {
      L1: ["id", "stop_name"],
      L2: ["district"],
    });
    expect(missing).toEqual([
      { toolLabel: "Aggregate points", paramLabel: "Group by", field: "name", layerName: "Stops" },
    ]);
  });

  it("does not judge a layer whose fields are not loaded", () => {
    expect(missingFieldRefs(nodes[2] as never, aggregate, edges, nodes, { L2: ["district"] })).toEqual([]);
  });
});
