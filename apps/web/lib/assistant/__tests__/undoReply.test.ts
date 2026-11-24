import type { DynamicToolUIPart } from "ai";
import { describe, expect, it, vi } from "vitest";

import type { AssistantMessage } from "@/lib/assistant/types";
import { followUndone, runsUndoneByWords, typedUndoEdits } from "@/lib/assistant/undoReply";

const base = { workflows: [], styles: [], not_restored: [], summary: "…" };
const undoneMap = { project_id: "p1", layers: [32], tree: false, groups: true, basemap: false, scene: false };
const undoneStyle = {
  project_id: "p1",
  layer_project_id: 12,
  style_id: "s1",
  revision: 6,
  removed: false,
  partial: true,
};
const undoneWorkflow = { workflow_id: "wf-1", project_id: "p1", revision: 3 };

const undo = (
  toolCallId: string,
  output: Record<string, unknown>,
  state: DynamicToolUIPart["state"] = "output-available"
) =>
  ({
    type: "dynamic-tool",
    toolName: "undo_changes",
    toolCallId,
    state,
    input: {},
    ...(state === "output-available" ? { output: { ...base, ...output } } : {}),
  }) as DynamicToolUIPart;
const answer = (id: string, ...parts: DynamicToolUIPart[]): AssistantMessage => ({
  id,
  role: "assistant",
  parts,
});

describe("the result of a typed undo", () => {
  it("reads what went back with the shapes of the Undo button's reply, for undone and changed", () => {
    const messages = [
      answer(
        "a1",
        undo("u1", {
          status: "undone",
          run_id: "r1",
          workflows: [undoneWorkflow],
          styles: [undoneStyle],
          map: undoneMap,
          not_restored: ["layer_removed"],
        }),
        undo("u2", { status: "changed", run_id: "r2", workflows: [undoneWorkflow] })
      ),
    ];
    expect(typedUndoEdits(messages)).toEqual([
      {
        key: "a1:u1",
        toolCallId: "u1",
        restored: {
          workflows: [{ workflowId: "wf-1", projectId: "p1", revision: 3 }],
          styles: [
            {
              projectId: "p1",
              layerProjectId: 12,
              styleId: "s1",
              revision: 6,
              removed: false,
              partial: true,
            },
          ],
          map: { projectId: "p1", layers: [32], tree: false, groups: true, basemap: false, scene: false },
          notRestored: ["layer_removed"],
        },
      },
      {
        key: "a1:u2",
        toolCallId: "u2",
        restored: {
          workflows: [{ workflowId: "wf-1", projectId: "p1", revision: 3 }],
          styles: [],
          map: null,
          notRestored: [],
        },
      },
    ]);
  });

  it("leaves out a repeated call, a result that wrote nothing back, a running call and other tools", () => {
    const messages: AssistantMessage[] = [
      answer(
        "a1",
        undo("u1", { status: "undone", run_id: "r1", repeated_call: "…", map: undoneMap }),
        undo("u2", { status: "nothing" }),
        undo("u3", { status: "nothing", run_id: "r1" }),
        undo("u4", { status: "under_way", run_id: "r1" }),
        undo("u5", { status: "failed", run_id: "r1" }),
        undo("u6", {}, "input-available"),
        { ...undo("u7", { status: "undone", run_id: "r1" }), toolName: "map_update" } as DynamicToolUIPart
      ),
      { id: "q", role: "user", parts: [{ type: "text", text: "undo that" }] },
    ];
    expect(typedUndoEdits(messages)).toEqual([]);
  });

  it("names the runs whose answers now read Undone: undone, and nothing for a run taken back already", () => {
    const messages = [
      answer("a1", undo("u1", { status: "undone", run_id: "r1" })),
      answer("a2", undo("u2", { status: "nothing", run_id: "r2" })),
      answer(
        "a3",
        undo("u3", { status: "changed", run_id: "r3" }),
        undo("u4", { status: "nothing" }),
        undo("u5", { status: "under_way", run_id: "r5" }),
        undo("u6", { status: "failed", run_id: "r6" }),
        // Core stored nothing of a style's restore: the button stays Undo for it, and the history keeps it undoable.
        undo("u7", { status: "undone", run_id: "r7", not_restored: ["style"] })
      ),
    ];
    expect([...runsUndoneByWords(messages)]).toEqual(["r1", "r2"]);
  });

  it("is followed as the button's reply is: the workflows, the styles with their lists, and the map", () => {
    const actions = {
      followWorkflowChanges: vi.fn(),
      followStyleChanges: vi.fn(),
      followMapChange: vi.fn(),
    };
    const [edit] = typedUndoEdits([
      answer(
        "a1",
        undo("u1", {
          status: "undone",
          run_id: "r1",
          workflows: [undoneWorkflow],
          styles: [undoneStyle],
          map: undoneMap,
        })
      ),
    ]);
    followUndone(edit.restored, actions);
    expect(actions.followWorkflowChanges).toHaveBeenCalledWith([
      { workflowId: "wf-1", projectId: "p1", revision: 3 },
    ]);
    expect(actions.followStyleChanges).toHaveBeenCalledWith([
      { projectId: "p1", layerProjectId: 12, styleId: "s1", revision: 6, listChanged: true, removed: false },
    ]);
    expect(actions.followMapChange).toHaveBeenCalledWith({
      projectId: "p1",
      layers: true,
      state: true,
      groups: true,
      basemap: false,
      scene: false,
    });
    // Nothing of a kind went back: the page is not asked to follow it.
    vi.clearAllMocks();
    followUndone({ workflows: [], styles: [], map: null, notRestored: [] }, actions);
    expect(actions.followWorkflowChanges).not.toHaveBeenCalled();
    expect(actions.followStyleChanges).not.toHaveBeenCalled();
    expect(actions.followMapChange).not.toHaveBeenCalled();
  });
});
