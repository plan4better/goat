import type { DynamicToolUIPart } from "ai";
import { describe, expect, it, vi } from "vitest";

import type { AssistantMessage } from "@/lib/assistant/types";
import { answerEdits, followWorkflowChanges, workflowEdits } from "@/lib/assistant/workflowEdits";

const step = (
  toolName: string,
  output: unknown,
  state: DynamicToolUIPart["state"] = "output-available",
  toolCallId = "call-1"
): DynamicToolUIPart =>
  ({ type: "dynamic-tool", toolName, toolCallId, state, input: {}, output }) as DynamicToolUIPart;

const reply = (id: string, parts: DynamicToolUIPart[]): AssistantMessage => ({
  id,
  role: "assistant",
  parts,
});

const saved = { workflow_id: "wf-1", revision_before: 4, revision_after: 5, changed_steps: [] };

describe("workflow edits of an answer", () => {
  it("are the workflow_update steps that saved a change, with the revision they left", () => {
    const message = reply("a1", [
      step("workflow_get", { workflow_id: "wf-1", revision: 4 }),
      step("workflow_update", saved),
      step("workflow_update", { ...saved, workflow_id: "wf-2", revision_before: 2, revision_after: 3 }),
    ]);
    expect(answerEdits(message)).toEqual([
      { workflowId: "wf-1", revision: 5 },
      { workflowId: "wf-2", revision: 3 },
    ]);
  });

  it("leave out an edit that changed nothing, a failed one, and other answers' kinds of steps", () => {
    const message = reply("a1", [
      step("workflow_update", { ...saved, revision_after: 4 }),
      step("workflow_update", undefined, "output-error"),
      step("workflow_create", { workflow: { id: "wf-9" } }),
    ]);
    expect(answerEdits(message)).toEqual([]);
    expect(answerEdits({ id: "u1", role: "user", parts: [{ type: "text", text: "x" }] })).toEqual([]);
  });

  it("are keyed by answer and step across a conversation", () => {
    const messages = [
      reply("a1", [step("workflow_update", saved, "output-available", "c1")]),
      reply("a2", [
        step(
          "workflow_update",
          { ...saved, revision_before: 5, revision_after: 6 },
          "output-available",
          "c2"
        ),
      ]),
    ];
    expect(workflowEdits(messages)).toEqual([
      { workflowId: "wf-1", revision: 5, key: "a1:c1" },
      { workflowId: "wf-1", revision: 6, key: "a2:c2" },
    ]);
  });
});

describe("following workflow changes made elsewhere", () => {
  const deps = (open: string | null, project: string | null = "p1") => ({
    openWorkflowId: () => open,
    openProjectId: () => project,
    requestReload: vi.fn(),
    refreshList: vi.fn(async () => undefined),
  });

  it("has the open workflow load its change, and reads the project's workflow list again", () => {
    const follow = deps("wf-1");
    followWorkflowChanges(
      [
        { workflowId: "wf-1", revision: 5 },
        { workflowId: "wf-2", revision: 3 },
      ],
      follow
    );
    expect(follow.requestReload).toHaveBeenCalledTimes(1);
    expect(follow.requestReload).toHaveBeenCalledWith("wf-1", 5);
    expect(follow.refreshList).toHaveBeenCalledTimes(1);
    expect(follow.refreshList).toHaveBeenCalledWith("p1");
  });

  it("reads the list of the project a change names", () => {
    const follow = deps(null, null);
    followWorkflowChanges([{ workflowId: "wf-1", revision: 5, projectId: "p2" }], follow);
    expect(follow.requestReload).not.toHaveBeenCalled();
    expect(follow.refreshList).toHaveBeenCalledWith("p2");
  });

  it("reads the list only for a change whose revision is not known", () => {
    const follow = deps("wf-1");
    followWorkflowChanges([{ workflowId: "wf-1", revision: null, projectId: "p1" }], follow);
    expect(follow.requestReload).not.toHaveBeenCalled();
    expect(follow.refreshList).toHaveBeenCalledWith("p1");
  });

  it("does nothing without changes", () => {
    const follow = deps("wf-1");
    followWorkflowChanges([], follow);
    expect(follow.refreshList).not.toHaveBeenCalled();
  });
});
