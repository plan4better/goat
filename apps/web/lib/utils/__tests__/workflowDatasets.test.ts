import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import {
  datasetRows,
  fieldRefsOf,
  missingFieldRefs,
  replaceDatasetLayers,
  sameShapeLayers,
  sourceDatasetFor,
  withCurrentDatasetTypes,
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

const layerInput = (title: string) => ({
  title,
  schema: { "x-ui": { widget: "layer-selector" } },
  minOccurs: 0,
  maxOccurs: 1,
  keywords: [],
  metadata: [],
});

// Two layer inputs, and a list setting whose items name their own layer input
// (aggregate_polygon's `column_statistics`).
const aggregatePolygon: OGCProcessDescription = {
  id: "aggregate_polygon",
  version: "1",
  title: "Aggregate polygons",
  inputs: {
    source_layer_id: layerInput("Source"),
    area_layer_id: layerInput("Area"),
    column_statistics: {
      title: "Statistics",
      schema: {
        type: "array",
        items: { $ref: "#/$defs/AggregateFieldStatistic" },
        "x-ui": { repeatable: true, label: "Statistics" },
      },
      minOccurs: 1,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
  },
  outputs: {},
  $defs: {
    AggregateFieldStatistic: {
      type: "object",
      properties: {
        operation: { type: "string" },
        field: {
          anyOf: [{ type: "string" }, { type: "null" }],
          "x-ui": {
            widget: "field-selector",
            widget_options: { source_layer: "source_layer_id" },
            label: "Field",
          },
        },
      },
    },
  },
} as unknown as OGCProcessDescription;

// Each field of a match row reads its own layer (join's `attribute_relationships`).
const join: OGCProcessDescription = {
  id: "join",
  version: "1",
  title: "Join",
  inputs: {
    target_layer_id: layerInput("Target"),
    join_layer_id: layerInput("Join"),
    attribute_relationships: {
      title: "Match Fields",
      schema: {
        anyOf: [{ type: "array", items: { $ref: "#/$defs/AttributeRelationship" } }, { type: "null" }],
        "x-ui": { repeatable: true, label: "Match Fields" },
      },
      minOccurs: 0,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
  },
  outputs: {},
  $defs: {
    AttributeRelationship: {
      type: "object",
      properties: {
        target_field: {
          type: "string",
          "x-ui": {
            widget: "field-selector",
            widget_options: { source_layer: "target_layer_id" },
            label: "Target Field",
          },
        },
        join_field: {
          type: "string",
          "x-ui": {
            widget: "field-selector",
            widget_options: { source_layer: "join_layer_id" },
            label: "Join Field",
          },
        },
      },
    },
  },
} as unknown as OGCProcessDescription;

// A list setting that names the layer input itself; its items name none.
const grouped: OGCProcessDescription = {
  id: "grouped",
  version: "1",
  title: "Grouped",
  inputs: {
    source_layer_id: layerInput("Source"),
    area_layer_id: layerInput("Area"),
    groups: {
      title: "Groups",
      schema: {
        type: "array",
        items: { $ref: "#/$defs/Group" },
        "x-ui": { repeatable: true, widget_options: { source_layer: "area_layer_id" } },
      },
      minOccurs: 0,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
  },
  outputs: {},
  $defs: {
    Group: {
      type: "object",
      properties: { name_field: { type: "string", "x-ui": { widget: "field-selector" } } },
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

describe("withCurrentDatasetTypes", () => {
  const table = (id: number, layerId: string, name: string) =>
    layer(id, layerId, name, "point", { type: "table", feature_layer_geometry_type: null } as never);

  it("gives a node stored as a table the type of its layer, now a point layer", () => {
    const nodes = [dataset("d1", "L1", 1, { layerType: "table", geometryType: undefined })];
    const [node] = withCurrentDatasetTypes(nodes, [layer(1, "L1", "Stops")]);
    expect(node.data).toMatchObject({ layerType: "feature", geometryType: "point" });
  });

  it("gives a node stored as a point layer the type of its layer, now a table", () => {
    const nodes = [dataset("d1", "L1", 1)];
    const [node] = withCurrentDatasetTypes(nodes, [table(1, "L1", "Stops")]);
    expect(node.data).toMatchObject({ layerType: "table" });
    expect((node.data as { geometryType?: string }).geometryType).toBeUndefined();
  });

  it("reads the layer by its dataset id, as the run does, also for a node without a project layer", () => {
    const nodes = [
      dataset("d1", "L1", 1, { projectLayerId: undefined, layerType: "table", geometryType: undefined }),
    ];
    const [node] = withCurrentDatasetTypes(nodes, [layer(7, "L1", "Stops", "polygon")]);
    expect(node.data).toMatchObject({ layerType: "feature", geometryType: "polygon" });
  });

  it("keeps the stored types of a layer that is not in the list, and while the list loads", () => {
    const nodes = [dataset("d1", "L1", 1, { layerType: "table", geometryType: undefined })];
    expect(withCurrentDatasetTypes(nodes, [layer(2, "L2", "Other")])).toBe(nodes);
    expect(withCurrentDatasetTypes(nodes, undefined)).toBe(nodes);
  });

  it("keeps every node object whose types are already current, and the other steps", () => {
    const nodes = [dataset("d1", "L1", 1), tool("t1", "buffer", "Buffer", {})];
    expect(withCurrentDatasetTypes(nodes, [layer(1, "L1", "Stops")])).toBe(nodes);
    const next = withCurrentDatasetTypes(nodes, [table(1, "L1", "Stops")]);
    expect(next).not.toBe(nodes);
    expect(next[1]).toBe(nodes[1]);
    expect(nodes[0].data).toMatchObject({ layerType: "feature", geometryType: "point" });
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

  it("reads a statistic's field from the layer input its own selector names", () => {
    const refs = fieldRefsOf(aggregatePolygon, {
      column_statistics: [
        { operation: "sum", field: "population" },
        { operation: "count" },
      ],
    });
    expect(refs).toEqual([
      {
        input: "column_statistics[0].field",
        label: "Statistics · Field",
        field: "population",
        sourceInput: "source_layer_id",
      },
    ]);
  });

  it("reads each field of a join's match row from its own layer input", () => {
    const refs = fieldRefsOf(join, {
      attribute_relationships: [{ target_field: "district_id", join_field: "id" }],
    });
    expect(refs.map((ref) => [ref.input, ref.field, ref.sourceInput])).toEqual([
      ["attribute_relationships[0].target_field", "district_id", "target_layer_id"],
      ["attribute_relationships[0].join_field", "id", "join_layer_id"],
    ]);
  });

  it("falls back to the list setting's layer input when an item's selector names none", () => {
    const refs = fieldRefsOf(grouped, { groups: [{ name_field: "district" }] });
    expect(refs.map((ref) => [ref.field, ref.sourceInput])).toEqual([["district", "area_layer_id"]]);
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

  it("judges a join's match fields against the layer each one reads", () => {
    const joinNodes = [
      dataset("d1", "L1", 1, { layerName: "Districts" }),
      dataset("d2", "L2", 2, { layerName: "Schools" }),
      tool("t1", "join", "Join", {
        attribute_relationships: [{ target_field: "district_id", join_field: "district_id" }],
      }),
    ];
    const joinEdges = [edge("d1", "t1", "target_layer_id"), edge("d2", "t1", "join_layer_id")];
    const missing = missingFieldRefs(joinNodes[2] as never, join, joinEdges, joinNodes, {
      L1: ["district_id"],
      L2: ["id", "name"],
    });
    expect(missing).toEqual([
      { toolLabel: "Join", paramLabel: "Match Fields · Join Field", field: "district_id", layerName: "Schools" },
    ]);
  });
});
