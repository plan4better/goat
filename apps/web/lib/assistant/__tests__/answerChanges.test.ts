import type { DynamicToolUIPart } from "ai";
import { describe, expect, it } from "vitest";

import { answerChanges, hasChanges, savesChange } from "@/lib/assistant/answerChanges";
import type { AssistantMessage } from "@/lib/assistant/types";

const step = (toolName: string, output: unknown, toolCallId = "call-1"): DynamicToolUIPart =>
  ({
    type: "dynamic-tool",
    toolName,
    toolCallId,
    state: "output-available",
    input: {},
    output,
  }) as DynamicToolUIPart;

const reply = (
  parts: AssistantMessage["parts"],
  role: AssistantMessage["role"] = "assistant"
): AssistantMessage => ({
  id: "a1",
  role,
  parts,
});

const styleSaved = {
  project_id: "p1",
  layer_project_id: 7,
  style_id: "s1",
  created: false,
  made_active: false,
  revision_before: 4,
  revision_after: 5,
};
const mapSaved = (applied: unknown[], more: Record<string, unknown> = {}) => ({
  project_id: "p1",
  applied,
  ...more,
});
const moved = { index: 0, op: "set_view", summary: "View" };
const hidden = { index: 1, op: "set_layer", layer_project_id: 12, fields: ["visible"], summary: "Hidden" };
const workflowSaved = { workflow_id: "wf-1", revision_before: 2, revision_after: 3 };

describe("what an answer changed", () => {
  it("an answer that only changed a style shows Undo", () => {
    const changes = answerChanges(reply([step("style_update", styleSaved)]));
    expect(changes).toEqual({
      workflows: [],
      styles: [{ projectId: "p1", layerProjectId: 7, styleId: "s1", revision: 5, listChanged: false }],
      map: [],
      layersRemoved: false,
    });
    expect(hasChanges(changes)).toBe(true);
  });

  it("lists workflow and style changes in order, each of its kind", () => {
    const changes = answerChanges(
      reply([
        step("workflow_update", workflowSaved, "w1"),
        step("style_update", styleSaved, "s1"),
        step("style_update", { ...styleSaved, revision_before: 5, revision_after: 6 }, "s2"),
      ])
    );
    expect(changes.workflows).toEqual([{ workflowId: "wf-1", revision: 3 }]);
    expect(changes.styles.map((change) => change.revision)).toEqual([5, 6]);
    expect(hasChanges(changes)).toBe(true);
  });

  it("has no changes for an answer that saved nothing, nor for a user message", () => {
    expect(hasChanges(answerChanges(reply([{ type: "text", text: "ok" }])))).toBe(false);
    expect(
      hasChanges(answerChanges(reply([step("style_update", { ...styleSaved, revision_after: 4 })])))
    ).toBe(false);
    expect(hasChanges(answerChanges(reply([step("style_update", styleSaved)], "user")))).toBe(false);
  });

  it("an answer that only moved the view shows no Undo", () => {
    const changes = answerChanges(
      reply([step("map_update", mapSaved([moved], { view: { camera: { center: [11.5, 48.1], zoom: 12 } } }))])
    );
    expect(changes.map).toEqual([]);
    expect(hasChanges(changes)).toBe(false);
  });

  it("an answer that only asked before removing a layer shows no Undo", () => {
    const confirm = [{ layer_project_id: 12, name: "Parks", value: "remove_layer:12", facts: {} }];
    const changes = answerChanges(reply([step("map_update", mapSaved([], { confirm }))]));
    expect(changes.map).toEqual([]);
    expect(hasChanges(changes)).toBe(false);
  });

  it("an answer that hid a layer shows Undo", () => {
    const changes = answerChanges(reply([step("map_update", mapSaved([moved, hidden]))]));
    expect(changes).toEqual({
      workflows: [],
      styles: [],
      map: [{ projectId: "p1", layers: false, state: true, groups: false, basemap: false, scene: false }],
      layersRemoved: false,
    });
    expect(hasChanges(changes)).toBe(true);
  });

  it("an answer that only removed a layer shows no Undo: the layer does not come back", () => {
    const removed = { index: 0, op: "remove_layer", layer_project_id: 12, summary: "Removed Parks" };
    const changes = answerChanges(reply([step("map_update", mapSaved([removed, moved]))]));
    expect(changes.map).toEqual([]);
    expect(changes.layersRemoved).toBe(true);
    expect(hasChanges(changes)).toBe(false);
    // A removal beside a change Undo puts back keeps the Undo.
    const both = answerChanges(reply([step("map_update", mapSaved([removed, hidden]))]));
    expect(both.map).toHaveLength(1);
    expect(both.layersRemoved).toBe(true);
    expect(hasChanges(both)).toBe(true);
    const besideStyle = answerChanges(
      reply([step("map_update", mapSaved([removed]), "m1"), step("style_update", styleSaved, "s1")])
    );
    expect(besideStyle.map).toEqual([]);
    expect(hasChanges(besideStyle)).toBe(true);
  });

  it("an answer whose map step failed after applying an operation still shows Undo", () => {
    const failed = { index: 2, reason: "No group 3 in this project." };
    const changes = answerChanges(reply([step("map_update", mapSaved([hidden], { failed }))]));
    expect(changes.map).toHaveLength(1);
    expect(hasChanges(changes)).toBe(true);
    // A step that applied nothing before its failure changed nothing.
    expect(hasChanges(answerChanges(reply([step("map_update", mapSaved([], { failed }))])))).toBe(false);
  });

  it("lists one map change per map step, beside the other kinds", () => {
    const changes = answerChanges(
      reply([
        step("map_update", mapSaved([hidden]), "m1"),
        step("style_update", styleSaved, "s1"),
        step("map_update", mapSaved([{ index: 0, op: "set_basemap", summary: "Basemap: Dark" }]), "m2"),
        step("map_update", mapSaved([moved], { view: { mode: "3d" } }), "m3"),
      ])
    );
    expect(changes.styles).toHaveLength(1);
    expect(changes.map.map(({ state, basemap }) => ({ state, basemap }))).toEqual([
      { state: true, basemap: false },
      { state: false, basemap: true },
    ]);
  });

  it("has no map changes for a map step of a user message or one still running", () => {
    expect(answerChanges(reply([step("map_update", mapSaved([hidden]))], "user")).map).toEqual([]);
    const running = { ...step("map_update", undefined), state: "input-available" } as DynamicToolUIPart;
    expect(answerChanges(reply([running])).map).toEqual([]);
  });

  it("names as change lines exactly the steps whose changes it lists", () => {
    const removed = { index: 0, op: "remove_layer", layer_project_id: 12, summary: "Removed" };
    const cases: Array<[DynamicToolUIPart, boolean]> = [
      [step("workflow_update", workflowSaved, "w1"), true],
      [step("workflow_update", { ...workflowSaved, revision_after: 2 }, "w0"), false],
      [step("style_update", styleSaved, "s1"), true],
      [step("style_update", { ...styleSaved, revision_after: 4 }, "s0"), false],
      [step("map_update", mapSaved([hidden]), "m1"), true],
      [step("map_update", mapSaved([removed, hidden]), "m2"), true],
      [step("map_update", mapSaved([removed]), "m3"), false],
      [step("map_update", mapSaved([moved], { view: { zoom: 12 } }), "m4"), false],
      [step("undo_changes", { status: "undone", run_id: "r1", workflows: [], styles: [] }, "u1"), false],
      [{ ...step("style_update", styleSaved, "s9"), state: "input-available" } as DynamicToolUIPart, false],
    ];
    for (const [part, saves] of cases) {
      expect(savesChange(part), part.toolCallId).toBe(saves);
      const changes = answerChanges(reply([part]));
      expect(hasChanges(changes), part.toolCallId).toBe(saves);
    }
  });
});
