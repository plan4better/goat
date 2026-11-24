import { renderHook } from "@testing-library/react";
import type { DynamicToolUIPart } from "ai";
import { type ReactNode, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { missedEdits, resetFollowedCalls } from "@/lib/assistant/mapBridge";
import type { AssistantMessage } from "@/lib/assistant/types";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import { resetFollowedStyleEdits, useFollowStyleEdits } from "@/components/assistant/useFollowStyleEdits";
import { resetFollowedTypedUndos, useFollowTypedUndo } from "@/components/assistant/useFollowTypedUndo";

const actions = dockActions();
const wrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>
    <DockActionsContext.Provider value={actions}>{children}</DockActionsContext.Provider>
  </StrictMode>
);
const asked: AssistantMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Undo that" }] };
const base = { workflows: [], styles: [], not_restored: [], summary: "…" };
const undoneMap = {
  project_id: "p1",
  layers: [32],
  tree: false,
  groups: false,
  basemap: false,
  scene: false,
};
const undoneStyle = {
  project_id: "p1",
  layer_project_id: 12,
  style_id: "s1",
  revision: 6,
  removed: false,
  partial: false,
};
const undoneWorkflow = { workflow_id: "wf-2", project_id: "p1", revision: 8 };
const answered = (id: string, toolCallId: string, output: Record<string, unknown>): AssistantMessage => ({
  id,
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolName: "undo_changes",
      toolCallId,
      state: "output-available",
      input: {},
      output: { ...base, ...output },
    } as DynamicToolUIPart,
  ],
});
const undone = (id: string, toolCallId = "call-1") =>
  answered(id, toolCallId, {
    status: "undone",
    run_id: "r1",
    workflows: [undoneWorkflow],
    styles: [undoneStyle],
    map: undoneMap,
  });
/** The follows a chat view runs: the typed undo's own, and the style follow's catch-up of the newest answer. */
const mount = (messages: AssistantMessage[], initialMessages: AssistantMessage[]) =>
  renderHook(
    ({ list }: { list: AssistantMessage[] }) => {
      useFollowStyleEdits(list, initialMessages);
      useFollowTypedUndo(list, initialMessages);
    },
    { initialProps: { list: messages }, wrapper }
  );
const mapRead = { projectId: "p1", layers: true, state: true, groups: false, basemap: false, scene: false };
const styleRead = {
  projectId: "p1",
  layerProjectId: 12,
  styleId: "s1",
  revision: 6,
  listChanged: true,
  removed: false,
};
const workflowRead = { workflowId: "wf-2", projectId: "p1", revision: 8 };
const calls = () => ({
  map: vi.mocked(actions.followMapChange).mock.calls,
  styles: vi.mocked(actions.followStyleChanges).mock.calls,
  workflows: vi.mocked(actions.followWorkflowChanges).mock.calls,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetFollowedTypedUndos();
  resetFollowedStyleEdits();
  resetFollowedCalls();
});

describe("useFollowTypedUndo", () => {
  it("has the page follow the map, a style and a workflow a typed undo took back, once, also under StrictMode", () => {
    const view = mount([asked], [asked]);
    view.rerender({ list: [asked, undone("a1")] });
    view.rerender({ list: [asked, undone("a1")] });
    expect(calls()).toEqual({ map: [[mapRead]], styles: [[[styleRead]]], workflows: [[[workflowRead]]] });
    // Followed as it came in: the catch-up of a run that ended reads nothing of it again.
    expect(missedEdits([asked, undone("a1")])).toEqual([]);
  });

  it("follows a result seen live once more neither from history nor after a remount", () => {
    const view = mount([asked], [asked]);
    view.rerender({ list: [asked, undone("a1")] });
    view.unmount();
    // Stored under another message id than it streamed under.
    const stored = [asked, undone("a1-stored")];
    mount(stored, stored).rerender({ list: [...stored] });
    expect(calls()).toEqual({ map: [[mapRead]], styles: [[[styleRead]]], workflows: [[[workflowRead]]] });
  });

  it("follows what went back of a result that asks about the rest", () => {
    const view = mount([asked], [asked]);
    view.rerender({
      list: [
        asked,
        answered("a1", "call-1", { status: "changed", run_id: "r1", workflows: [undoneWorkflow] }),
      ],
    });
    expect(calls()).toEqual({ map: [], styles: [], workflows: [[[workflowRead]]] });
  });

  it("follows the undo anyway of a later answer for the same run, but not a repeated call's result", () => {
    const view = mount([asked], [asked]);
    const asking = answered("a1", "call-1", { status: "changed", run_id: "r1", workflows: [undoneWorkflow] });
    view.rerender({ list: [asked, asking] });
    // Were the repeated result followed, its map would be read.
    const repeated = answered("a1", "call-2", {
      status: "changed",
      run_id: "r1",
      map: { ...undoneMap, basemap: true },
      repeated_call: "…",
    });
    view.rerender({ list: [asked, { ...asking, parts: [...asking.parts, ...repeated.parts] }] });
    view.rerender({
      list: [
        asked,
        asking,
        asked,
        answered("a2", "call-3", { status: "undone", run_id: "r1", map: undoneMap }),
      ],
    });
    expect(calls()).toEqual({ map: [[mapRead]], styles: [], workflows: [[[workflowRead]]] });
  });

  it("catches up on a result that came in while the dock was closed, once", () => {
    const stored = [asked, undone("a1")];
    // The run ended with no chat view: the dock's watcher reads the stored conversation's missed changes.
    expect(missedEdits(stored)).toEqual([mapRead]);
    // The dock opens: the workflow follows, the map and the style are not read again.
    mount(stored, stored).unmount();
    mount(stored, stored).rerender({ list: [...stored] });
    expect(calls()).toEqual({ map: [], styles: [], workflows: [[[workflowRead]]] });
  });

  it("catches up on a conversation opened fresh as the other follows do, once per tab", () => {
    const older = answered("a0", "old", {
      status: "undone",
      run_id: "r0",
      workflows: [{ workflow_id: "wf-1", project_id: "p1", revision: 3 }],
      map: { ...undoneMap, basemap: true },
    });
    const stored = [asked, older, asked, undone("a1")];
    mount(stored, stored).unmount();
    mount(stored, stored).rerender({ list: [...stored] });
    // The newest answer's map is read once, with the styles its request carries (no style is read on its own);
    // the workflows of every answer are handed over once, and the editor ignores a revision it holds.
    expect(calls()).toEqual({
      map: [[mapRead]],
      styles: [],
      workflows: [[[{ workflowId: "wf-1", projectId: "p1", revision: 3 }, workflowRead]]],
    });
  });

  it("applies a result once when the running answer replays after a remount under another message id", () => {
    const view = mount([asked], [asked]);
    view.rerender({ list: [asked, undone("a1")] });
    view.unmount();
    const stored = [asked, undone("a1")];
    mount(stored, stored).rerender({ list: [asked, undone("a1-replay")] });
    expect(calls()).toEqual({ map: [[mapRead]], styles: [[[styleRead]]], workflows: [[[workflowRead]]] });
  });

  it("applies a result once when a running answer no chat followed replays after a remount", () => {
    // The dock was closed while the call returned; a resumed run replays under a message id of its own.
    const stored = [asked, undone("a1")];
    mount(stored, stored).rerender({ list: [asked, undone("a1-replay")] });
    expect(calls()).toEqual({ map: [[mapRead]], styles: [], workflows: [[[workflowRead]]] });
  });
});
