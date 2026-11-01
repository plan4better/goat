import { describe, expect, it } from "vitest";

import {
  addWorkflow,
  markSaved,
  workflowReducer as reducer,
  reloadWorkflow,
  removeWorkflow,
  requestWorkflowReload,
  restoreCanvas,
  selectNode,
  selectWorkflow,
  setNodes,
  setVariables,
  setWorkflowRevision,
  setWorkflows,
  syncToWorkflowConfig,
  updateViewport,
} from "@/lib/store/workflow/slice";
import type { Workflow } from "@/lib/validations/workflow";

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

describe("workflow slice — variable labels and descriptions", () => {
  const labelled = {
    id: "var-1",
    name: "max_abstand_gruppierung",
    label: "Maximaler Abstand",
    description: "Größter Abstand zwischen zwei Punkten einer Gruppe, in Metern.",
    type: "number" as const,
    defaultValue: 250,
    order: 0,
  };
  const legacy = { id: "var-2", name: "radius", type: "number" as const, defaultValue: 100, order: 1 };

  const withVariables = (variables: unknown[]): Workflow =>
    ({
      ...workflow("wf-vars", ["a"]),
      config: { nodes: [node("a")], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, variables },
    }) as unknown as Workflow;

  it("loads label and description with the workflow, and a legacy variable as it was", () => {
    let state = reducer(initial, setWorkflows([withVariables([labelled, legacy])]));
    state = reducer(state, selectWorkflow("wf-vars"));

    expect(state.variables).toEqual([labelled, legacy]);
    expect(state.variables[1]).not.toHaveProperty("label");
    expect(state.variables[1]).not.toHaveProperty("description");
  });

  it("writes them back into the config it saves", () => {
    let state = reducer(initial, setWorkflows([withVariables([legacy])]));
    state = reducer(state, selectWorkflow("wf-vars"));
    state = reducer(state, setVariables([labelled, legacy]));
    state = reducer(state, syncToWorkflowConfig());

    const saved = state.workflows.find((w) => w.id === "wf-vars")?.config.variables;
    expect(saved).toEqual([labelled, legacy]);
  });
});


describe("workflow slice — a stored config the canvas cannot draw", () => {
  const damaged = (config: unknown): Workflow =>
    ({ ...workflow("wf-bad", []), config }) as unknown as Workflow;

  it("opens as an empty canvas instead of throwing", () => {
    let state = reducer(initial, setWorkflows([damaged({ nodes: "not a list", edges: [] })]));
    state = reducer(state, selectWorkflow("wf-bad"));
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.variables).toEqual([]);
  });

  it("also when the list brings it after it was selected", () => {
    let state = reducer(initial, selectWorkflow("wf-bad"));
    state = reducer(state, setWorkflows([damaged({ nodes: [{ id: "a", type: "tool", data: {} }], edges: [] })]));
    expect(state.nodes).toEqual([]);
  });

  it("keeps the stored config as it is, for the notice and the check", () => {
    const config = { nodes: [{ id: "a", type: "chart", position: { x: 0, y: 0 }, data: {} }], edges: [] };
    let state = reducer(initial, setWorkflows([damaged(config)]));
    state = reducer(state, selectWorkflow("wf-bad"));
    expect(state.workflows[0].config).toEqual(config);
  });
});

describe("workflow slice — the revision each workflow's copy is based on", () => {
  const at = (id: string, nodeIds: string[], revision: number): Workflow => ({
    ...workflow(id, nodeIds),
    revision,
  });

  it("records the revision of the workflow it opens", () => {
    let state = reducer(initial, setWorkflows([at("wf-1", ["a"], 3)]));
    state = reducer(state, selectWorkflow("wf-1"));
    expect(state.revisions["wf-1"]).toBe(3);
  });

  it("records the revision of a workflow selected before the list carried it, when it loads", () => {
    let state = reducer(initial, selectWorkflow("wf-new"));
    state = reducer(state, setWorkflows([at("wf-new", ["a"], 1)]));
    expect(state.revisions["wf-new"]).toBe(1);
  });

  it("keeps the open workflow's revision while a refreshed list carries a newer one", () => {
    // The canvas stays as it is, so its next save must still name the
    // revision it was made on: core then refuses it instead of overwriting
    // the change made elsewhere.
    let state = reducer(initial, setWorkflows([at("wf-1", ["a"], 3), at("wf-2", ["z"], 1)]));
    state = reducer(state, selectWorkflow("wf-1"));
    state = reducer(state, setWorkflows([at("wf-1", ["a", "theirs"], 4), at("wf-2", ["z"], 2)]));

    expect(state.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(state.revisions["wf-1"]).toBe(3);
    expect(state.revisions["wf-2"]).toBe(2);
  });

  it("moves a workflow to the revision a save returned", () => {
    let state = reducer(initial, setWorkflows([at("wf-1", ["a"], 3)]));
    state = reducer(state, selectWorkflow("wf-1"));
    state = reducer(state, setWorkflowRevision({ id: "wf-1", revision: 4 }));

    expect(state.revisions["wf-1"]).toBe(4);
    expect(state.workflows[0].revision).toBe(4);
  });

  it("loads the stored workflow over the open canvas, with its revision, keeping the view", () => {
    let state = reducer(initial, setWorkflows([at("wf-1", ["a"], 3)]));
    state = reducer(state, selectWorkflow("wf-1"));
    state = reducer(state, setNodes([node("a"), node("mine")] as never));
    state = reducer(state, updateViewport({ x: 40, y: 20, zoom: 2 }));

    state = reducer(state, reloadWorkflow(at("wf-1", ["a", "theirs"], 5)));

    expect(state.nodes.map((n) => n.id)).toEqual(["a", "theirs"]);
    expect(state.workflows[0].config.nodes.map((n) => n.id)).toEqual(["a", "theirs"]);
    expect(state.revisions["wf-1"]).toBe(5);
    expect(state.isDirty).toBe(false);
    expect(state.viewport).toEqual({ x: 40, y: 20, zoom: 2 });
  });

  it("loads a workflow that is not open into the list only", () => {
    let state = reducer(initial, setWorkflows([at("wf-1", ["a"], 3), at("wf-2", ["z"], 1)]));
    state = reducer(state, selectWorkflow("wf-1"));

    state = reducer(state, reloadWorkflow(at("wf-2", ["z", "y"], 2)));

    expect(state.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(state.workflows[1].config.nodes.map((n) => n.id)).toEqual(["z", "y"]);
    expect(state.revisions["wf-2"]).toBe(2);
  });

  it("forgets the revisions of workflows a refreshed list no longer has, keeping the open one's", () => {
    let state = reducer(
      initial,
      setWorkflows([at("wf-1", ["a"], 3), at("wf-2", ["z"], 1), at("wf-3", [], 2)])
    );
    state = reducer(state, selectWorkflow("wf-1"));
    state = reducer(state, setWorkflows([at("wf-2", ["z"], 1)]));

    expect(state.revisions).toEqual({ "wf-1": 3, "wf-2": 1 });
  });

  it("records the revision of a workflow added to the list", () => {
    const state = reducer(initial, addWorkflow(at("wf-new", [], 1)));
    expect(state.revisions["wf-new"]).toBe(1);
  });

  it("forgets the revision of a removed workflow", () => {
    let state = reducer(initial, setWorkflows([at("wf-1", ["a"], 3)]));
    state = reducer(state, removeWorkflow("wf-1"));
    expect(state.revisions).not.toHaveProperty("wf-1");
  });
});

describe("workflow slice — the canvas loads the store's steps anew", () => {
  const at = (id: string, nodeIds: string[], revision: number): Workflow => ({
    ...workflow(id, nodeIds),
    revision,
  });
  const open = () => {
    const state = reducer(initial, setWorkflows([at("wf-1", ["a", "b"], 3), at("wf-2", ["z"], 1)]));
    return reducer(state, selectWorkflow("wf-1"));
  };

  it("on an undo or redo: the steps and connections it restores, to be saved", () => {
    let state = open();
    const before = state.canvasVersion;
    const moved = [{ ...node("a"), position: { x: 5, y: 0 } }, node("b")];
    state = reducer(state, restoreCanvas({ nodes: moved as never, edges: [] }));

    expect(state.nodes).toEqual(moved);
    expect(state.isDirty).toBe(true);
    expect(state.canvasVersion).toBe(before + 1);
  });

  it("drops a selected step an undo takes away", () => {
    let state = reducer(open(), selectNode("b"));
    state = reducer(state, restoreCanvas({ nodes: [node("a")] as never, edges: [] }));
    expect(state.selectedNodeId).toBeNull();
  });

  it("on a stored version loaded over the open workflow, and not for another one", () => {
    let state = open();
    const before = state.canvasVersion;
    state = reducer(state, reloadWorkflow(at("wf-2", ["z", "y"], 2)));
    expect(state.canvasVersion).toBe(before);
    state = reducer(state, reloadWorkflow(at("wf-1", ["a", "b"], 4)));
    expect(state.canvasVersion).toBe(before + 1);
  });
});

describe("workflow slice — a change made elsewhere that the editor takes over", () => {
  const at = (id: string, nodeIds: string[], revision: number): Workflow => ({
    ...workflow(id, nodeIds),
    revision,
  });

  it("is asked for with the revision it made, the newest one kept", () => {
    let state = reducer(initial, requestWorkflowReload({ id: "wf-1", revision: 5 }));
    state = reducer(state, requestWorkflowReload({ id: "wf-1", revision: 4 }));
    expect(state.reloadRequests).toEqual({ "wf-1": 5 });
    state = reducer(state, requestWorkflowReload({ id: "wf-1", revision: 6 }));
    expect(state.reloadRequests).toEqual({ "wf-1": 6 });
  });

  it("is not asked for when the copy here is based on that revision or a newer one already", () => {
    // A replayed answer names an edit the editor took over before.
    let state = reducer(initial, setWorkflows([at("wf-1", ["a"], 5)]));
    state = reducer(state, selectWorkflow("wf-1"));
    state = reducer(state, requestWorkflowReload({ id: "wf-1", revision: 5 }));
    expect(state.reloadRequests).toEqual({});
  });

  it("is served by loading that revision or a newer one, not an older one", () => {
    let state = reducer(initial, setWorkflows([at("wf-1", ["a"], 3)]));
    state = reducer(state, selectWorkflow("wf-1"));
    state = reducer(state, requestWorkflowReload({ id: "wf-1", revision: 5 }));
    state = reducer(state, reloadWorkflow(at("wf-1", ["a"], 4)));
    expect(state.reloadRequests).toEqual({ "wf-1": 5 });
    state = reducer(state, reloadWorkflow(at("wf-1", ["a", "b"], 6)));
    expect(state.reloadRequests).toEqual({});
  });
});

describe("workflow slice — changes beyond the view", () => {
  const at = (id: string, nodeIds: string[], revision: number): Workflow => ({
    ...workflow(id, nodeIds),
    revision,
  });
  const open = () => reducer(reducer(initial, setWorkflows([at("wf-1", ["a"], 3)])), selectWorkflow("wf-1"));

  it("are told apart from a pan or zoom, which only make the canvas dirty", () => {
    let state = reducer(open(), updateViewport({ x: 4, y: 0, zoom: 1 }));
    expect(state.isDirty).toBe(true);
    expect(state.contentDirty).toBe(false);
    state = reducer(state, setNodes([node("a"), node("b")] as never));
    expect(state.contentDirty).toBe(true);
    state = reducer(state, markSaved());
    expect([state.isDirty, state.contentDirty]).toEqual([false, false]);
    state = reducer(state, restoreCanvas({ nodes: [node("a")] as never, edges: [] }));
    expect(state.contentDirty).toBe(true);
    state = reducer(state, reloadWorkflow(at("wf-1", ["a"], 4)));
    expect(state.contentDirty).toBe(false);
  });

  it("a read of the workflow on or past a requested change makes the request moot", () => {
    // A stored answer's edit asked for before the editor read the workflow.
    let state = reducer(initial, requestWorkflowReload({ id: "wf-1", revision: 5 }));
    state = reducer(state, setWorkflows([at("wf-1", ["a"], 9)]));
    expect(state.reloadRequests).toEqual({});
    state = reducer(state, requestWorkflowReload({ id: "wf-2", revision: 2 }));
    state = reducer(state, setWorkflows([at("wf-1", ["a"], 9), at("wf-2", ["z"], 1)]));
    expect(state.reloadRequests).toEqual({ "wf-2": 2 });
  });

  it("a save of the copy on or past a requested change makes the request moot", () => {
    // Keep mine saved over the assistant's change: nothing is left to load.
    let state = reducer(open(), requestWorkflowReload({ id: "wf-1", revision: 4 }));
    state = reducer(state, setWorkflowRevision({ id: "wf-1", revision: 3 }));
    expect(state.reloadRequests).toEqual({ "wf-1": 4 });
    state = reducer(state, setWorkflowRevision({ id: "wf-1", revision: 5 }));
    expect(state.reloadRequests).toEqual({});
  });
});
