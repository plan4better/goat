import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChangedElsewhereError } from "@/lib/api/changedElsewhere";
import { WorkflowIssuesError } from "@/lib/api/workflows";
import {
  requestWorkflowReload,
  selectWorkflow,
  setNodes,
  setWorkflows,
  updateViewport,
  workflowReducer,
} from "@/lib/store/workflow/slice";
import type { Workflow } from "@/lib/validations/workflow";

import { AUTOSAVE_DELAY_MS, useWorkflowAutosave } from "@/hooks/workflows/useWorkflowAutosave";

import { makeIssue } from "@/components/workflows/issues/__tests__/issueFixtures";

const { updateMock, getMock } = vi.hoisted(() => ({ updateMock: vi.fn(), getMock: vi.fn() }));

vi.mock("@/lib/api/workflows", () => {
  class WorkflowIssuesError extends Error {
    constructor(
      public readonly issues: unknown[],
      message = "The workflow has issues."
    ) {
      super(message);
    }
  }
  return { updateWorkflow: updateMock, getWorkflow: getMock, WorkflowIssuesError };
});

const workflow = {
  id: "wf-1",
  name: "Workflow 1",
  project_id: "p1",
  revision: 3,
  config: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, variables: [] },
} as unknown as Workflow;

const ada = { id: "user-2", firstname: "Ada", lastname: "Lovelace", avatar: null };
const changedElsewhere = (revision: number) =>
  new ChangedElsewhereError(revision, "2026-10-25T09:12:03+00:00", ada);

const note = (id: string) => ({
  id,
  type: "textAnnotation",
  position: { x: 0, y: 0 },
  data: { type: "textAnnotation", text: `<p>${id}</p>` },
});

const makeStore = () => configureStore({ reducer: { workflow: workflowReducer } });

const setup = (enabled = true, before?: (store: ReturnType<typeof makeStore>) => void) => {
  const store = makeStore();
  store.dispatch(setWorkflows([workflow]));
  store.dispatch(selectWorkflow("wf-1"));
  before?.(store);
  const onSaved = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  const hook = renderHook(() => useWorkflowAutosave({ projectId: "p1", enabled, onSaved }), { wrapper });
  return { store, onSaved, hook };
};

const edit = (store: ReturnType<typeof setup>["store"], id = "text-1") =>
  act(() => {
    store.dispatch(setNodes([note(id)] as never));
  });

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const savedIds = (call: number) =>
  (updateMock.mock.calls[call][2] as { config: { nodes: { id: string }[] } }).config.nodes.map(
    (node) => node.id
  );

const savedBase = (call: number) =>
  (updateMock.mock.calls[call][2] as { base_revision?: number }).base_revision;

describe("useWorkflowAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateMock.mockReset();
    getMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("saves a moment after the last change, once", async () => {
    updateMock.mockResolvedValue({});
    const { store, onSaved } = setup();

    edit(store);
    await wait(AUTOSAVE_DELAY_MS - 1);
    expect(updateMock).not.toHaveBeenCalled();
    await wait(1);

    expect(updateMock).toHaveBeenCalledWith("p1", "wf-1", {
      config: expect.objectContaining({ edges: [] }),
      base_revision: 3,
    });
    expect(savedIds(0)).toEqual(["text-1"]);
    expect(store.getState().workflow.isDirty).toBe(false);
    expect(onSaved).toHaveBeenCalledTimes(1);

    await wait(5 * AUTOSAVE_DELAY_MS);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("never saves a workflow it must not write over", async () => {
    const { store } = setup(false);
    edit(store);
    await wait(5 * AUTOSAVE_DELAY_MS);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("reports a failed save until Retry saves it, without retrying on its own", async () => {
    updateMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
    const { store, hook } = setup();

    edit(store);
    await wait(AUTOSAVE_DELAY_MS);
    expect(hook.result.current.status).toBe("failed");
    expect(hook.result.current.issues).toEqual([]);

    await wait(5 * AUTOSAVE_DELAY_MS);
    expect(updateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      hook.result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(hook.result.current.status).toBe("idle");
    expect(store.getState().workflow.isDirty).toBe(false);
  });

  it("carries the issues core lists when it refuses the config as damaged", async () => {
    const damaged = makeIssue({ code: "node_duplicate_id", level: "damaged", params: { id: "a" } });
    updateMock.mockRejectedValueOnce(new WorkflowIssuesError([damaged], "The workflow is damaged."));
    const { store, hook } = setup();

    edit(store);
    await wait(AUTOSAVE_DELAY_MS);

    expect(hook.result.current.status).toBe("failed");
    expect(hook.result.current.issues).toEqual([damaged]);
  });

  it("saves an edit made while the previous save was still under way", async () => {
    let finish: (value: unknown) => void = () => undefined;
    updateMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValue({});
    const { store } = setup();

    edit(store, "text-1");
    await wait(AUTOSAVE_DELAY_MS);
    expect(updateMock).toHaveBeenCalledTimes(1);

    edit(store, "text-2");
    await act(async () => {
      finish({});
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(store.getState().workflow.isDirty).toBe(true);

    await wait(AUTOSAVE_DELAY_MS);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(savedIds(1)).toEqual(["text-2"]);
    expect(store.getState().workflow.isDirty).toBe(false);
  });

  it("saves on the revision core returned for the last save", async () => {
    updateMock.mockResolvedValueOnce({ revision: 4 }).mockResolvedValue({ revision: 5 });
    const { store } = setup();

    edit(store, "text-1");
    await wait(AUTOSAVE_DELAY_MS);
    edit(store, "text-2");
    await wait(AUTOSAVE_DELAY_MS);

    expect(savedBase(0)).toBe(3);
    expect(savedBase(1)).toBe(4);
    expect(store.getState().workflow.revisions["wf-1"]).toBe(5);
  });

  it("waits for a save under way before the next one, so it never conflicts with itself", async () => {
    let finish: (value: unknown) => void = () => undefined;
    updateMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValue({ revision: 5 });
    const { store } = setup();

    edit(store, "text-1");
    await wait(AUTOSAVE_DELAY_MS);
    edit(store, "text-2");
    await wait(AUTOSAVE_DELAY_MS);
    expect(updateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ revision: 4 });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(savedIds(1)).toEqual(["text-2"]);
    expect(savedBase(1)).toBe(4);
  });

  it("stops autosaving on a conflict and shows it instead of Not saved", async () => {
    updateMock.mockRejectedValueOnce(changedElsewhere(5));
    const { store, hook } = setup();

    edit(store, "text-1");
    await wait(AUTOSAVE_DELAY_MS);

    expect(hook.result.current.conflict).toEqual({
      id: "wf-1",
      revision: 5,
      updatedAt: "2026-10-25T09:12:03+00:00",
      updatedBy: ada,
    });
    expect(hook.result.current.status).toBe("idle");

    edit(store, "text-2");
    await wait(5 * AUTOSAVE_DELAY_MS);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(store.getState().workflow.isDirty).toBe(true);
  });

  it("Keep mine saves the canvas as it is now on the revision core holds, and autosave resumes", async () => {
    updateMock
      .mockRejectedValueOnce(changedElsewhere(5))
      .mockResolvedValueOnce({ revision: 6 })
      .mockResolvedValue({ revision: 7 });
    const { store, hook, onSaved } = setup();

    edit(store, "text-1");
    await wait(AUTOSAVE_DELAY_MS);
    edit(store, "text-2");

    await act(async () => {
      hook.result.current.keepMine();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(savedIds(1)).toEqual(["text-2"]);
    expect(savedBase(1)).toBe(5);
    expect(hook.result.current.conflict).toBeNull();
    expect(store.getState().workflow.isDirty).toBe(false);
    expect(onSaved).toHaveBeenCalledTimes(1);

    edit(store, "text-3");
    await wait(AUTOSAVE_DELAY_MS);
    expect(updateMock).toHaveBeenCalledTimes(3);
    expect(savedBase(2)).toBe(6);
  });

  it("Keep mine resolves once its save is in, so the banner stays busy until then", async () => {
    let finish: (value: unknown) => void = () => undefined;
    updateMock.mockRejectedValueOnce(changedElsewhere(5)).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { store, hook } = setup();
    edit(store, "text-1");
    await wait(AUTOSAVE_DELAY_MS);

    let settled = false;
    let kept: Promise<void> = Promise.resolve();
    act(() => {
      kept = hook.result.current.keepMine().then(() => {
        settled = true;
      });
    });
    await wait(0);
    expect(settled).toBe(false);

    await act(async () => {
      finish({ revision: 6 });
      await kept;
    });
    expect(settled).toBe(true);
  });

  it("Reload loads the stored workflow and its revision over the canvas, and autosave resumes", async () => {
    updateMock.mockRejectedValueOnce(changedElsewhere(5)).mockResolvedValue({ revision: 6 });
    getMock.mockResolvedValue({
      ...workflow,
      revision: 5,
      config: { ...workflow.config, nodes: [note("theirs")] },
    });
    const { store, hook, onSaved } = setup();

    edit(store, "mine");
    await wait(AUTOSAVE_DELAY_MS);

    await act(async () => {
      await hook.result.current.reload();
    });
    expect(getMock).toHaveBeenCalledWith("p1", "wf-1");
    const state = store.getState().workflow;
    expect(state.nodes.map((n) => n.id)).toEqual(["theirs"]);
    expect(state.revisions["wf-1"]).toBe(5);
    expect(state.isDirty).toBe(false);
    expect(hook.result.current.conflict).toBeNull();
    expect(onSaved).toHaveBeenCalledTimes(1);

    edit(store, "after");
    await wait(AUTOSAVE_DELAY_MS);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(savedBase(1)).toBe(5);
  });

  it("keeps the conflict when the stored workflow cannot be read", async () => {
    updateMock.mockRejectedValueOnce(changedElsewhere(5));
    getMock.mockRejectedValue(new Error("offline"));
    const { store, hook } = setup();

    edit(store);
    await wait(AUTOSAVE_DELAY_MS);
    await act(async () => {
      await hook.result.current.reload();
    });

    expect(hook.result.current.conflict?.revision).toBe(5);
    expect(store.getState().workflow.nodes.map((n) => n.id)).toEqual(["text-1"]);
  });

  it("drops the conflict when another workflow is opened", async () => {
    updateMock.mockRejectedValueOnce(changedElsewhere(5));
    const { store, hook } = setup();
    act(() => {
      store.dispatch(setWorkflows([workflow, { ...workflow, id: "wf-2", revision: 1 }]));
    });

    edit(store);
    await wait(AUTOSAVE_DELAY_MS);
    expect(hook.result.current.conflict).not.toBeNull();

    act(() => {
      store.dispatch(selectWorkflow("wf-2"));
    });
    expect(hook.result.current.conflict).toBeNull();
  });

  it("renames on the workflow's revision, in turn with the saves, and keeps the new revision", async () => {
    let finish: (value: unknown) => void = () => undefined;
    updateMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValue({ revision: 5 });
    const { store, hook } = setup();

    edit(store);
    await wait(AUTOSAVE_DELAY_MS);
    let renamed: Promise<void> = Promise.resolve();
    act(() => {
      renamed = hook.result.current.rename("wf-1", "Renamed");
    });
    await wait(0);
    expect(updateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ revision: 4 });
      await renamed;
    });
    expect(updateMock).toHaveBeenLastCalledWith("p1", "wf-1", { name: "Renamed", base_revision: 4 });
    expect(store.getState().workflow.revisions["wf-1"]).toBe(5);
  });

  describe("an assistant edit of the open workflow", () => {
    const edited = (revision: number, id = "assistant") => ({
      ...workflow,
      revision,
      config: { ...workflow.config, nodes: [note(id)] },
    });
    const request = (store: ReturnType<typeof setup>["store"], revision: number) =>
      act(async () => {
        store.dispatch(requestWorkflowReload({ id: "wf-1", revision }));
        await vi.advanceTimersByTimeAsync(0);
      });

    it("is loaded with its revision, and the next save is made on it", async () => {
      getMock.mockResolvedValue(edited(4));
      updateMock.mockResolvedValue({ revision: 5 });
      const { store, hook, onSaved } = setup();

      await request(store, 4);
      expect(getMock).toHaveBeenCalledWith("p1", "wf-1");
      const state = store.getState().workflow;
      expect(state.nodes.map((n) => n.id)).toEqual(["assistant"]);
      expect(state.revisions["wf-1"]).toBe(4);
      expect(state.isDirty).toBe(false);
      expect(state.reloadRequests).toEqual({});
      expect(onSaved).toHaveBeenCalledTimes(1);

      edit(store, "after");
      await wait(AUTOSAVE_DELAY_MS);
      expect(savedBase(0)).toBe(4);
      expect(hook.result.current.conflict).toBeNull();
    });

    it("waits for a save under way, and loads the edit over it", async () => {
      let finish: (value: unknown) => void = () => undefined;
      updateMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      getMock.mockResolvedValue(edited(5));
      const { store } = setup();
      edit(store, "mine");
      await wait(AUTOSAVE_DELAY_MS);
      expect(updateMock).toHaveBeenCalledTimes(1);

      await request(store, 5);
      expect(getMock).not.toHaveBeenCalled();
      await act(async () => {
        finish({ revision: 4 });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(store.getState().workflow.nodes.map((n) => n.id)).toEqual(["assistant"]);
      expect(store.getState().workflow.revisions["wf-1"]).toBe(5);
    });

    it("keeps the banner its own save ran into, with what it holds, until the person chooses", async () => {
      updateMock.mockRejectedValueOnce(changedElsewhere(4)).mockResolvedValue({ revision: 5 });
      getMock.mockResolvedValue(edited(4));
      const { store, hook } = setup();
      edit(store, "mine");
      await wait(AUTOSAVE_DELAY_MS);
      expect(hook.result.current.conflict).not.toBeNull();

      await request(store, 4);
      expect(getMock).not.toHaveBeenCalled();
      expect(hook.result.current.conflict).not.toBeNull();
      expect(store.getState().workflow.nodes.map((n) => n.id)).toEqual(["mine"]);

      // Reload takes the edit over, and serves the request.
      await act(async () => {
        await hook.result.current.reload();
      });
      expect(store.getState().workflow.nodes.map((n) => n.id)).toEqual(["assistant"]);
      expect(store.getState().workflow.reloadRequests).toEqual({});
      await wait(AUTOSAVE_DELAY_MS);
      // Reload's own read served it: no second read.
      expect(getMock).toHaveBeenCalledTimes(1);
      edit(store, "after");
      await wait(AUTOSAVE_DELAY_MS);
      expect(savedBase(1)).toBe(4);
    });

    it("saves a change not saved yet first; one that runs into the edit gets the banner", async () => {
      updateMock.mockRejectedValueOnce(changedElsewhere(4));
      getMock.mockResolvedValue(edited(4));
      const { store, hook } = setup();
      edit(store, "mine");
      // Within the autosave's delay: the follow saves it at once.
      await request(store, 4);
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(savedIds(0)).toEqual(["mine"]);
      expect(savedBase(0)).toBe(3);
      expect(hook.result.current.conflict).toMatchObject({ revision: 4 });
      expect(getMock).not.toHaveBeenCalled();
      expect(store.getState().workflow.nodes.map((n) => n.id)).toEqual(["mine"]);
    });

    it("says when the conflict is with the assistant's edit it waits to load", async () => {
      updateMock.mockRejectedValueOnce(changedElsewhere(4));
      const { store, hook } = setup();
      edit(store, "mine");
      await request(store, 4);
      expect(hook.result.current.conflict).toMatchObject({ revision: 4 });
      expect(hook.result.current.conflictByAssistant).toBe(true);
    });

    it("tells every other conflict as before: a colleague's, or one with no edit waiting", async () => {
      updateMock.mockRejectedValueOnce(changedElsewhere(5));
      const { store, hook } = setup();
      edit(store, "mine");
      await wait(AUTOSAVE_DELAY_MS);
      expect(hook.result.current.conflict).not.toBeNull();
      expect(hook.result.current.conflictByAssistant).toBe(false);
      // The assistant edits the colleague's version while that banner is open.
      await request(store, 6);
      expect(hook.result.current.conflictByAssistant).toBe(false);
    });

    it("lets a pan alone follow, and saves the pan on the new revision", async () => {
      getMock.mockResolvedValue(edited(4));
      updateMock.mockResolvedValue({ revision: 4 });
      const { store } = setup();
      act(() => {
        store.dispatch(updateViewport({ x: 40, y: 20, zoom: 2 }));
      });
      await request(store, 4);
      expect(getMock).toHaveBeenCalledTimes(1);
      const state = store.getState().workflow;
      expect(state.nodes.map((n) => n.id)).toEqual(["assistant"]);
      expect(state.viewport).toEqual({ x: 40, y: 20, zoom: 2 });
      await wait(AUTOSAVE_DELAY_MS);
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(savedBase(0)).toBe(4);
      expect((updateMock.mock.calls[0][2] as { config: { viewport: unknown } }).config.viewport).toEqual({
        x: 40,
        y: 20,
        zoom: 2,
      });
    });

    it("never closes a colleague's banner, and keeps what it holds for Keep mine", async () => {
      updateMock.mockRejectedValueOnce(changedElsewhere(5)).mockResolvedValue({ revision: 7 });
      getMock.mockResolvedValue(edited(6));
      const { store, hook } = setup();
      edit(store, "mine");
      await wait(AUTOSAVE_DELAY_MS);
      // The assistant edits the colleague's version (6) while the banner is open.
      await request(store, 6);
      expect(getMock).not.toHaveBeenCalled();
      expect(hook.result.current.conflict).toMatchObject({ revision: 5, updatedBy: ada });

      await act(async () => {
        await hook.result.current.keepMine();
      });
      expect(savedIds(1)).toEqual(["mine"]);
      // Keep mine saved over the assistant's change: nothing is left to load.
      expect(store.getState().workflow.reloadRequests).toEqual({});
      await wait(AUTOSAVE_DELAY_MS);
      expect(getMock).not.toHaveBeenCalled();
    });

    it("keeps the work a failed save holds until it is saved", async () => {
      updateMock.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(changedElsewhere(4));
      getMock.mockResolvedValue(edited(4));
      const { store, hook } = setup();
      edit(store, "mine");
      await wait(AUTOSAVE_DELAY_MS);
      expect(hook.result.current.status).toBe("failed");

      await request(store, 4);
      expect(getMock).not.toHaveBeenCalled();
      expect(store.getState().workflow.nodes.map((n) => n.id)).toEqual(["mine"]);

      // Retry runs into the edit: the banner asks.
      await act(async () => {
        hook.result.current.retry();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(hook.result.current.conflict).toMatchObject({ revision: 4 });
      expect(getMock).not.toHaveBeenCalled();
    });

    it("is loaded once the editor opens, when it came while the editor was closed", async () => {
      getMock.mockResolvedValue(edited(4));
      const { store } = setup(true, (early) => {
        early.dispatch(requestWorkflowReload({ id: "wf-1", revision: 4 }));
      });
      await wait(0);
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(store.getState().workflow.revisions["wf-1"]).toBe(4);
    });

    it("loads a newer edit that came while an older one was read", async () => {
      let read: (value: unknown) => void = () => undefined;
      getMock
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              read = resolve;
            })
        )
        .mockResolvedValue(edited(5, "second"));
      const { store } = setup();
      await request(store, 4);
      await request(store, 5);
      await act(async () => {
        read(edited(4, "first"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getMock).toHaveBeenCalledTimes(2);
      expect(store.getState().workflow.nodes.map((n) => n.id)).toEqual(["second"]);
      expect(store.getState().workflow.reloadRequests).toEqual({});
    });

    it("does not read again on its own when the stored workflow cannot be read", async () => {
      getMock.mockRejectedValue(new Error("offline"));
      const { store } = setup();
      await request(store, 4);
      await wait(5000);
      expect(getMock).toHaveBeenCalledTimes(1);
      // A later edit is read again.
      getMock.mockResolvedValue(edited(5));
      await request(store, 5);
      expect(getMock).toHaveBeenCalledTimes(2);
      expect(store.getState().workflow.revisions["wf-1"]).toBe(5);
    });

    it("leaves an edit of another workflow to the list", async () => {
      const { store } = setup();
      await act(async () => {
        store.dispatch(requestWorkflowReload({ id: "wf-2", revision: 2 }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getMock).not.toHaveBeenCalled();
    });
  });
});
