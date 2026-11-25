import type { DynamicToolUIPart } from "ai";
import { describe, expect, it } from "vitest";

import {
  type MapChange,
  mapChangeOfUndo,
  mapEdit,
  mapEdits,
  mergedMapChange,
} from "@/lib/assistant/mapEdits";
import type { AssistantMessage } from "@/lib/assistant/types";

const PROJECT = "p1";

const part = (output: unknown, extra: Partial<DynamicToolUIPart> = {}): DynamicToolUIPart =>
  ({
    type: "dynamic-tool",
    toolName: "map_update",
    toolCallId: "call-1",
    state: "output-available",
    input: {},
    output,
    ...extra,
  }) as DynamicToolUIPart;
const applied = (...ops: Array<Record<string, unknown>>) => ({
  project_id: PROJECT,
  applied: ops.map((op, index) => ({ index, summary: "", ...op })),
});
const none: Omit<MapChange, "projectId"> = {
  layers: false,
  state: false,
  groups: false,
  basemap: false,
  scene: false,
};
const change = (flags: Partial<MapChange>): MapChange => ({ projectId: PROJECT, ...none, ...flags });

describe("mapEdit", () => {
  it.each<[string, Record<string, unknown>, Partial<MapChange> | null]>([
    ["a renamed layer", { op: "set_layer", layer_project_id: 7, fields: ["name"] }, { layers: true }],
    [
      "a layer's visibility, position, active style and legend",
      { op: "set_layer", layer_project_id: 7, fields: ["visible", "position", "active_style_id"] },
      { state: true },
    ],
    [
      "a layer renamed and hidden at once",
      { op: "set_layer", layer_project_id: 7, fields: ["name", "visible"] },
      { layers: true, state: true },
    ],
    [
      "a set_layer that names no fields",
      { op: "set_layer", layer_project_id: 7 },
      { layers: true, state: true },
    ],
    ["a filter", { op: "filter", layer_project_id: 7, count_before: 9, count_after: 4 }, { layers: true }],
    ["a removed layer", { op: "remove_layer", layer_project_id: 7 }, { layers: true, state: true }],
    ["a move", { op: "move" }, { state: true, layers: true, groups: true }],
    ["a new group", { op: "add_group", group_id: 3 }, { groups: true, state: true }],
    ["a renamed group", { op: "rename_group", group_id: 3 }, { groups: true, state: true }],
    ["a group's state", { op: "set_group", group_id: 3, fields: ["visible"] }, { groups: true, state: true }],
    ["a removed group", { op: "remove_group", group_id: 3 }, { groups: true, state: true }],
    ["the basemap", { op: "set_basemap" }, { basemap: true }],
    ["the scene", { op: "set_scene" }, { scene: true }],
    ["the view", { op: "set_view" }, null],
  ])("maps each operation kind to the caches it touches: %s", (_, op, flags) => {
    const edit = mapEdit(part({ ...applied(op), view: { mode: "3d" } }));
    expect(edit?.change).toEqual(flags && change(flags));
    expect(edit?.projectId).toBe(PROJECT);
    expect(edit?.toolCallId).toBe("call-1");
  });

  it("adds up the operations of one call", () => {
    const edit = mapEdit(part(applied({ op: "filter", layer_project_id: 7 }, { op: "set_basemap" })));
    expect(edit).toEqual({
      projectId: PROJECT,
      toolCallId: "call-1",
      change: change({ layers: true, basemap: true }),
      view: null,
    });
  });

  it("reads the view of a finished map_update and none of a failed one", () => {
    const view = {
      camera: { center: [11.5, 48.1], zoom: 12, pitch: 40, bearing: -20 },
      mode: "3d",
      projection: "globe",
    };
    const output = { ...applied({ op: "set_view" }), view };
    expect(mapEdit(part(output))).toEqual({ projectId: PROJECT, toolCallId: "call-1", change: null, view });
    expect(
      mapEdit(part({ ...applied({ op: "set_view" }), view: { bbox: [11, 48, 12, 49], camera: null } }))?.view
    ).toEqual({ bbox: [11, 48, 12, 49] });
    // A step that failed, has not returned, or belongs to another tool moves nothing.
    expect(mapEdit(part(output, { state: "output-error", errorText: "refused" } as never))).toBeNull();
    expect(mapEdit(part(output, { state: "input-available" } as never))).toBeNull();
    expect(mapEdit(part(output, { toolName: "style_update" }))).toBeNull();
  });

  it("drops the parts of a view the map cannot use", () => {
    const view = (value: unknown) => mapEdit(part({ ...applied({ op: "set_view" }), view: value }))?.view;
    expect(view({ camera: { center: [11.5, "48"], zoom: 12 }, mode: "4d", projection: "flat" })).toEqual({
      camera: { zoom: 12 },
    });
    expect(view({ bbox: [11, 48, 12] })).toBeUndefined();
    expect(view({ camera: {} })).toBeUndefined();
    expect(view("3d")).toBeUndefined();
  });

  it("a result with a failed operation still yields the applied ones", () => {
    const edit = mapEdit(
      part({
        ...applied({ op: "set_layer", layer_project_id: 7, fields: ["visible"] }),
        failed: { index: 1, reason: "No such group." },
      })
    );
    expect(edit?.change).toEqual(change({ state: true }));
  });

  it("is nothing to follow when no operation was applied and no view came", () => {
    expect(
      mapEdit(part({ project_id: PROJECT, applied: [], failed: { index: 0, reason: "No." } }))
    ).toBeNull();
    expect(mapEdit(part({ project_id: PROJECT }))).toBeNull();
    // A removal that waits for the user's pick changed nothing.
    const confirm = [{ layer_project_id: 7, name: "Parks", value: "remove_layer:7", facts: {} }];
    expect(mapEdit(part({ project_id: PROJECT, applied: [], confirm }))).toBeNull();
    expect(mapEdit(part({ ...applied({ op: "filter" }), project_id: undefined }))).toBeNull();
    expect(mapEdit(part(null))).toBeNull();
  });
});

describe("mapEdits", () => {
  it("lists the answers' map changes, each keyed by its answer and step", () => {
    const answer = (id: string, ...parts: DynamicToolUIPart[]): AssistantMessage => ({
      id,
      role: "assistant",
      parts,
    });
    const messages: AssistantMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Hide the parks" }] },
      answer(
        "a1",
        part(applied({ op: "set_basemap" }), { toolCallId: "c1" }),
        part({ project_id: PROJECT, applied: [] }, { toolCallId: "c2" }),
        part({ ...applied({ op: "set_view" }), view: { mode: "2d" } }, { toolCallId: "c3" })
      ),
    ];
    expect(mapEdits(messages)).toEqual([
      { key: "a1:c1", projectId: PROJECT, toolCallId: "c1", change: change({ basemap: true }), view: null },
      { key: "a1:c3", projectId: PROJECT, toolCallId: "c3", change: null, view: { mode: "2d" } },
    ]);
  });
});

describe("mergedMapChange", () => {
  it("touches what either change touched", () => {
    expect(mergedMapChange(change({ layers: true }), change({ scene: true, layers: false }))).toEqual(
      change({ layers: true, scene: true })
    );
  });
});

describe("mapChangeOfUndo", () => {
  const undone = { projectId: PROJECT, layers: [], tree: false, groups: false, basemap: false, scene: false };

  it("re-reads what an undo wrote back", () => {
    expect(mapChangeOfUndo(undone)).toEqual(change({}));
    // A layer's entry does not say whether its name, its filter or its map state went back.
    expect(mapChangeOfUndo({ ...undone, layers: [7] })).toEqual(change({ layers: true, state: true }));
    expect(mapChangeOfUndo({ ...undone, tree: true })).toEqual(
      change({ state: true, layers: true, groups: true })
    );
    expect(mapChangeOfUndo({ ...undone, groups: true })).toEqual(change({ groups: true, state: true }));
    expect(mapChangeOfUndo({ ...undone, basemap: true, scene: true })).toEqual(
      change({ basemap: true, scene: true })
    );
  });
});
