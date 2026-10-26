/**
 * A workflow save whose request never answers: the request gives up after
 * SAVE_TIMEOUT_MS, the editor shows "Not saved" with Retry, and the saves
 * queued behind it go out. Runs the real `updateWorkflow` over a request that,
 * like fetch, answers only when its signal aborts.
 */
import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAVE_TIMEOUT_MS } from "@/lib/api/changedElsewhere";
import { selectWorkflow, setNodes, setWorkflows, workflowReducer } from "@/lib/store/workflow/slice";
import type { Workflow } from "@/lib/validations/workflow";

import { AUTOSAVE_DELAY_MS, useWorkflowAutosave } from "@/hooks/workflows/useWorkflowAutosave";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: requestMock, fetcher: vi.fn() }));
vi.mock("swr", () => ({ default: vi.fn(() => ({})), mutate: vi.fn() }));

const workflow = {
  id: "wf-1",
  name: "Workflow 1",
  project_id: "p1",
  revision: 3,
  config: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, variables: [] },
} as unknown as Workflow;

const note = (id: string) => ({
  id,
  type: "textAnnotation",
  position: { x: 0, y: 0 },
  data: { type: "textAnnotation", text: `<p>${id}</p>` },
});

/** The timers of the requests sent, in order: fake timers do not drive
 * AbortSignal.timeout, so the test fires them. */
let timers: AbortController[] = [];

const stalled = (_url: string, options: RequestInit) =>
  new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
  });
const answered = (revision: number) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...workflow, revision }) });

const setup = () => {
  const store = configureStore({ reducer: { workflow: workflowReducer } });
  store.dispatch(setWorkflows([workflow]));
  store.dispatch(selectWorkflow("wf-1"));
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  const hook = renderHook(() => useWorkflowAutosave({ projectId: "p1", enabled: true, onSaved: vi.fn() }), {
    wrapper,
  });
  return { store, hook };
};

const edit = (store: ReturnType<typeof setup>["store"], id: string) =>
  act(() => {
    store.dispatch(setNodes([note(id)] as never));
  });

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const timeOut = (index: number) =>
  act(async () => {
    timers[index].abort(new DOMException("The save timed out.", "TimeoutError"));
    await vi.advanceTimersByTimeAsync(0);
  });

const sentBody = (call: number) => JSON.parse(requestMock.mock.calls[call][1].body);

describe("useWorkflowAutosave with a request that does not answer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    timers = [];
    requestMock.mockReset();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      expect(ms).toBe(SAVE_TIMEOUT_MS);
      const timer = new AbortController();
      timers.push(timer);
      return timer.signal;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ends as Not saved when the request gives up, and Retry saves", async () => {
    requestMock.mockImplementationOnce(stalled).mockImplementation(() => answered(4));
    const { store, hook } = setup();

    edit(store, "text-1");
    await wait(AUTOSAVE_DELAY_MS);
    expect(hook.result.current.status).toBe("saving");

    await timeOut(0);
    expect(hook.result.current.status).toBe("failed");
    expect(store.getState().workflow.isDirty).toBe(true);

    await act(async () => {
      hook.result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(sentBody(1)).toMatchObject({ base_revision: 3 });
    expect(hook.result.current.status).toBe("idle");
    expect(store.getState().workflow.isDirty).toBe(false);
  });

  it("sends the save queued behind it once it gives up", async () => {
    requestMock.mockImplementationOnce(stalled).mockImplementation(() => answered(4));
    const { store } = setup();

    edit(store, "text-1");
    await wait(AUTOSAVE_DELAY_MS);
    edit(store, "text-2");
    await wait(AUTOSAVE_DELAY_MS);
    expect(requestMock).toHaveBeenCalledTimes(1);

    await timeOut(0);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(sentBody(1).config.nodes.map((n: { id: string }) => n.id)).toEqual(["text-2"]);
    expect(store.getState().workflow.isDirty).toBe(false);
  });
});
