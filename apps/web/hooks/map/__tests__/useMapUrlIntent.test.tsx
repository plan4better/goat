/**
 * `useMapUrlIntent` is how a template result (`templateResultHref` in
 * hooks/templates/useUseTemplate.ts, e.g. `/map/<project>?mode=workflows&workflow=<id>`)
 * lands the map page on the right panel and selection. `useSearchParams` is
 * mocked as URL state (same approach as useContentPageState's tests); the
 * Redux store is real so dispatched actions can be asserted on its state.
 */
import { configureStore } from "@reduxjs/toolkit";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mapReducer } from "@/lib/store/map/slice";
import { workflowReducer } from "@/lib/store/workflow/slice";
import type { Workflow } from "@/lib/validations/workflow";

import { useMapUrlIntent } from "@/hooks/map/useMapUrlIntent";

let currentParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => currentParams,
}));

let mockWorkflows: Workflow[] | undefined;
vi.mock("@/lib/api/workflows", () => ({
  useWorkflows: (projectId?: string) => ({ workflows: projectId ? mockWorkflows : undefined }),
}));

const setParams = (params: Record<string, string>) => {
  currentParams = new URLSearchParams(params);
};

const makeStore = () =>
  configureStore({
    reducer: { map: mapReducer, workflow: workflowReducer },
  });

const renderIntent = (projectId: string | undefined, store: ReturnType<typeof makeStore>) =>
  renderHook(() => useMapUrlIntent(projectId), {
    wrapper: ({ children }: { children: React.ReactNode }) => <Provider store={store}>{children}</Provider>,
  });

const asWorkflow = (id: string, config: { nodes?: unknown[]; edges?: unknown[] } = {}): Workflow =>
  ({
    id,
    name: id,
    project_id: "p1",
    is_default: false,
    config: { nodes: config.nodes ?? [], edges: config.edges ?? [] },
  }) as unknown as Workflow;

describe("useMapUrlIntent", () => {
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setParams({});
    mockWorkflows = undefined;
    window.history.replaceState(null, "", "/map/p1");
    replaceStateSpy = vi.spyOn(window.history, "replaceState");
  });

  // Restored after each test so the next one's setup call above reaches the
  // real method: since Vitest 4, spying on a method that is already a spy
  // returns that same spy, so its calls would carry over between tests.
  afterEach(() => {
    replaceStateSpy.mockRestore();
  });

  it("does nothing when the URL carries none of mode/workflow/layout", () => {
    const store = makeStore();
    renderIntent("p1", store);
    expect(store.getState().map.mapMode).toBe("data");
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("sets the map mode and strips only the handled params, keeping the rest", () => {
    setParams({ mode: "workflows", loc: "10,20,5" });
    const store = makeStore();
    renderIntent("p1", store);

    expect(store.getState().map.mapMode).toBe("workflows");
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    const [, , url] = replaceStateSpy.mock.calls[0];
    expect(url).toBe("/map/p1?loc=10%2C20%2C5");
  });

  it("waits for the workflow list before selecting or stripping params", () => {
    setParams({ mode: "workflows", workflow: "w2" });
    mockWorkflows = undefined; // still loading
    const store = makeStore();
    renderIntent("p1", store);

    expect(store.getState().map.mapMode).toBe("workflows");
    expect(store.getState().workflow.selectedWorkflowId).toBeNull();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("selects the workflow via the same Redux action the panel uses, once the list contains it", async () => {
    setParams({ mode: "workflows", workflow: "w2" });
    mockWorkflows = [asWorkflow("w1"), asWorkflow("w2")];
    const store = makeStore();
    renderIntent("p1", store);

    await waitFor(() => expect(store.getState().workflow.selectedWorkflowId).toBe("w2"));
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(replaceStateSpy.mock.calls[0][2]).toBe("/map/p1");
  });

  it("dispatches setWorkflows with its own fresh list before selectWorkflow, so the canvas isn't left empty", async () => {
    // Nothing else in this test populates state.workflow.workflows — if selectWorkflow ran
    // before setWorkflows (the race this fixes), configToReactFlow would resolve against an
    // empty array and nodes/edges would stay [] permanently.
    setParams({ mode: "workflows", workflow: "w2" });
    mockWorkflows = [
      asWorkflow("w1"),
      asWorkflow("w2", { nodes: [{ id: "n1", type: "dataset", position: { x: 0, y: 0 }, data: {} }] }),
    ];
    const store = makeStore();
    renderIntent("p1", store);

    await waitFor(() => expect(store.getState().workflow.selectedWorkflowId).toBe("w2"));
    expect(store.getState().workflow.workflows).toEqual(mockWorkflows);
    expect(store.getState().workflow.nodes).toHaveLength(1);
    expect(store.getState().workflow.nodes[0].id).toBe("n1");
  });

  it("still strips the params when the loaded list doesn't contain the id", () => {
    setParams({ mode: "workflows", workflow: "missing" });
    mockWorkflows = [asWorkflow("w1")];
    const store = makeStore();
    renderIntent("p1", store);

    expect(store.getState().workflow.selectedWorkflowId).toBeNull();
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the requested layout for the caller to thread down (e.g. to ReportsLayout) after stripping the param", () => {
    setParams({ mode: "reports", layout: "l1" });
    const store = makeStore();

    const { result, rerender } = renderIntent("p1", store);
    expect(result.current.layoutRequest).toEqual({ id: "l1" });
    expect(store.getState().map.mapMode).toBe("reports");
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);

    // The stripped param reaches useSearchParams; the request stays for the panel that mounts now.
    setParams({});
    rerender();
    expect(result.current.layoutRequest).toEqual({ id: "l1" });
  });

  it("makes a new request each time the param shows up again, also for the same layout", () => {
    setParams({ mode: "reports", layout: "l1" });
    const store = makeStore();
    const { result, rerender } = renderIntent("p1", store);
    const first = result.current.layoutRequest;

    setParams({});
    rerender();
    setParams({ mode: "reports", layout: "l1" });
    rerender();

    expect(result.current.layoutRequest).toEqual({ id: "l1" });
    expect(result.current.layoutRequest).not.toBe(first);
  });

  it("returns no layout request when the URL carries none", () => {
    const store = makeStore();
    const { result } = renderIntent("p1", store);
    expect(result.current.layoutRequest).toBeNull();
  });

  it("does nothing without a projectId even if the URL carries params", () => {
    setParams({ mode: "workflows" });
    const store = makeStore();
    renderIntent(undefined, store);

    expect(store.getState().map.mapMode).toBe("data");
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });
});
