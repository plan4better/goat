import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  reloadWorkflow,
  selectWorkflow,
  setWorkflows,
  updateNode,
  updateNodePositions,
  workflowReducer,
} from "@/lib/store/workflow/slice";
import type { Workflow } from "@/lib/validations/workflow";

import { useWorkflowHistory } from "@/hooks/workflows/useWorkflowHistory";

const step = (id: string, x: number, label = id) => ({
  id,
  type: "tool",
  position: { x, y: 0 },
  data: { type: "tool", processId: "buffer", label, config: {} },
});

const stored = (revision: number, nodes: ReturnType<typeof step>[]): Workflow =>
  ({
    id: "wf-1",
    name: "Walk",
    project_id: "p-1",
    revision,
    config: { nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 }, variables: [] },
    created_at: "2026-10-25T00:00:00Z",
    updated_at: "2026-10-25T00:00:00Z",
  }) as unknown as Workflow;

/** Past the history's debounce, so the change before is one step of its own. */
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });

function setup() {
  const store = configureStore({ reducer: { workflow: workflowReducer } });
  store.dispatch(setWorkflows([stored(5, [step("a", 0), step("b", 300)])]));
  store.dispatch(selectWorkflow("wf-1"));
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  const hook = renderHook(() => useWorkflowHistory(), { wrapper });
  return { store, hook };
}

const positions = (store: ReturnType<typeof setup>["store"]) =>
  Object.fromEntries(store.getState().workflow.nodes.map((node) => [node.id, node.position.x]));
const labels = (store: ReturnType<typeof setup>["store"]) =>
  store.getState().workflow.nodes.map((node) => (node.data as { label: string }).label);

describe("useWorkflowHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes a move back with one undo, and saves that", async () => {
    const { store, hook } = setup();
    await settle();
    act(() => {
      store.dispatch(updateNodePositions([{ id: "a", position: { x: 5, y: 0 } }]));
    });
    await settle();
    act(() => hook.result.current.undo());
    expect(positions(store)).toEqual({ a: 0, b: 300 });
    expect(store.getState().workflow.isDirty).toBe(true);
    act(() => hook.result.current.redo());
    expect(positions(store)).toEqual({ a: 5, b: 300 });
  });

  it("takes back only an assistant edit loaded after moves, keeping the moves", async () => {
    const { store, hook } = setup();
    await settle();
    // A drag ends, then an arrow key moves a step: each reaches the store's steps.
    act(() => {
      store.dispatch(updateNodePositions([{ id: "b", position: { x: 320, y: 0 } }]));
    });
    await settle();
    act(() => {
      store.dispatch(updateNodePositions([{ id: "a", position: { x: 5, y: 0 } }]));
    });
    await settle();
    // The assistant's edit, as core stores it (the moves were saved before it).
    act(() => {
      store.dispatch(reloadWorkflow(stored(7, [step("a", 5, "Walk 10 min"), step("b", 320)])));
    });
    await settle();
    expect(labels(store)).toEqual(["Walk 10 min", "b"]);

    act(() => hook.result.current.undo());
    expect(labels(store)).toEqual(["a", "b"]);
    expect(positions(store)).toEqual({ a: 5, b: 320 });
    // Saved on top of the revision the reload adopted.
    expect(store.getState().workflow.isDirty).toBe(true);
    expect(store.getState().workflow.revisions["wf-1"]).toBe(7);

    act(() => hook.result.current.undo());
    expect(positions(store)).toEqual({ a: 0, b: 320 });
    act(() => hook.result.current.undo());
    expect(positions(store)).toEqual({ a: 0, b: 300 });

    act(() => hook.result.current.redo());
    act(() => hook.result.current.redo());
    act(() => hook.result.current.redo());
    expect(labels(store)).toEqual(["Walk 10 min", "b"]);
  });

  it("keeps a change made just before a reload as a step of its own", async () => {
    const { store, hook } = setup();
    await settle();
    act(() => {
      store.dispatch(updateNode({ id: "b", changes: { position: { x: 400, y: 0 } } }));
    });
    // The reload comes within the debounce of that change.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    act(() => {
      store.dispatch(reloadWorkflow(stored(6, [step("a", 0, "Walk 10 min"), step("b", 300)])));
    });
    await settle();

    act(() => hook.result.current.undo());
    expect(labels(store)).toEqual(["a", "b"]);
    expect(positions(store)).toEqual({ a: 0, b: 400 });
    act(() => hook.result.current.undo());
    expect(positions(store)).toEqual({ a: 0, b: 300 });
    expect(hook.result.current.canUndo).toBe(false);
  });

  it("takes back a change made just before, within the debounce, and nothing before it", async () => {
    const { store, hook } = setup();
    await settle();
    act(() => {
      store.dispatch(updateNodePositions([{ id: "a", position: { x: 5, y: 0 } }]));
    });
    await settle();
    act(() => {
      store.dispatch(updateNodePositions([{ id: "b", position: { x: 320, y: 0 } }]));
    });
    // Ctrl+Z at once: the move of b goes back, the move of a stays.
    act(() => hook.result.current.undo());
    expect(positions(store)).toEqual({ a: 5, b: 300 });
    await settle();
    act(() => hook.result.current.undo());
    expect(positions(store)).toEqual({ a: 0, b: 300 });
    act(() => hook.result.current.redo());
    act(() => hook.result.current.redo());
    expect(positions(store)).toEqual({ a: 5, b: 320 });
  });

  it("adds no step for a stored version that changes nothing", async () => {
    const { store, hook } = setup();
    await settle();
    act(() => {
      store.dispatch(reloadWorkflow(stored(6, [step("a", 0), step("b", 300)])));
    });
    await settle();
    expect(hook.result.current.historyLength).toBe(0);
  });

  it("does not start over when a stored version is loaded", async () => {
    const { store, hook } = setup();
    await settle();
    act(() => {
      store.dispatch(updateNodePositions([{ id: "a", position: { x: 50, y: 0 } }]));
    });
    await settle();
    expect(hook.result.current.historyLength).toBe(1);
    act(() => {
      store.dispatch(reloadWorkflow(stored(6, [step("a", 50, "Walk 10 min"), step("b", 300)])));
    });
    await settle();
    expect(hook.result.current.historyLength).toBe(2);
    expect(store.getState().workflow.selectedWorkflowId).toBe("wf-1");
  });
});
