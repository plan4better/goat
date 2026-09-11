import { describe, expect, it } from "vitest";

import type { Workflow } from "@/lib/validations/workflow";

import { selectWorkflow, setNodes, setWorkflows, workflowReducer as reducer } from "@/lib/store/workflow/slice";

const node = (id: string) => ({
  id,
  type: "textAnnotation",
  position: { x: 0, y: 0 },
  data: { text: id },
});

const workflow = (id: string, nodeIds: string[]): Workflow =>
  ({
    id,
    name: id,
    project_id: "p1",
    config: { nodes: nodeIds.map(node), edges: [], viewport: { x: 0, y: 0, zoom: 1 }, variables: [] },
    created_at: "2026-09-11T00:00:00Z",
    updated_at: "2026-09-11T00:00:00Z",
  }) as unknown as Workflow;

const initial = reducer(undefined, { type: "@@init" });

describe("workflow slice — a workflow selected before the list carried it", () => {
  it("loads its config once setWorkflows brings the workflow in", () => {
    // A workflow created from a template is selected by the panel the moment
    // its own list has it; the layout's copy of the list reaches the store a
    // render later. The canvas must not stay empty in between and, worse,
    // auto-save that emptiness back over the freshly created config.
    let state = reducer(initial, selectWorkflow("wf-new"));
    expect(state.selectedWorkflowId).toBe("wf-new");
    expect(state.nodes).toEqual([]);

    state = reducer(state, setWorkflows([workflow("wf-new", ["a", "b", "c"])]));
    expect(state.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(state.isDirty).toBe(false);
  });

  it("leaves a canvas the author already changed alone", () => {
    let state = reducer(initial, setWorkflows([workflow("wf-1", ["a"])]));
    state = reducer(state, selectWorkflow("wf-1"));
    state = reducer(state, setNodes([node("a"), node("typed")] as never));
    expect(state.isDirty).toBe(true);

    state = reducer(state, setWorkflows([workflow("wf-1", ["a"])]));
    expect(state.nodes.map((n) => n.id)).toEqual(["a", "typed"]);
  });

  it("keeps a selected workflow's loaded canvas when the list merely refreshes", () => {
    let state = reducer(initial, setWorkflows([workflow("wf-1", ["a", "b"])]));
    state = reducer(state, selectWorkflow("wf-1"));
    state = reducer(state, setWorkflows([workflow("wf-1", ["a", "b"]), workflow("wf-2", ["z"])]));
    expect(state.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });
});
