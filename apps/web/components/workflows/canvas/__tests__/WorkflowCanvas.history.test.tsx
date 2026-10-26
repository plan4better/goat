import { configureStore } from "@reduxjs/toolkit";
import { act, fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import React from "react";
import { Provider } from "react-redux";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  reloadWorkflow,
  selectNode,
  selectWorkflow,
  setWorkflows,
  workflowReducer,
} from "@/lib/store/workflow/slice";
import type { Workflow } from "@/lib/validations/workflow";

import WorkflowCanvas from "@/components/workflows/canvas/WorkflowCanvas";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/map/useConnectionValidation", () => ({
  useWorkflowProcessDescriptions: () => ({}),
  useConnectionValidator: () => () => true,
}));
vi.mock("@/hooks/workflows/useCurrentDatasetTypes", () => ({
  useCurrentDatasetTypes: <T,>(nodes: T[]) => nodes,
}));
const { Step } = vi.hoisted(() => ({
  Step: ({ id }: { id: string }) => id,
}));
vi.mock("@/components/workflows/nodes/ToolNode", () => ({ default: Step }));
vi.mock("@/components/workflows/nodes/DatasetNode", () => ({ default: Step }));
vi.mock("@/components/workflows/nodes/ExportNode", () => ({ default: Step }));
vi.mock("@/components/workflows/nodes/IfNode", () => ({ default: Step }));
vi.mock("@/components/workflows/nodes/TextAnnotationNode", () => ({ default: Step }));
vi.mock("@/components/workflows/dialogs/WorkflowVariablesDialog", () => ({ default: () => null }));
vi.mock("@/components/workflows/canvas/CanvasToolbar", () => ({
  default: ({ onUndo }: { onUndo: () => void }) => (
    <button type="button" onClick={onUndo}>
      undo
    </button>
  ),
}));

beforeAll(() => {
  class ResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  class DOMMatrixStub {
    m22 = 1;
  }
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixStub);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get: () => 40 },
    offsetWidth: { configurable: true, get: () => 120 },
  });
});

const WORKFLOW: Workflow = {
  id: "wf-1",
  project_id: "p-1",
  name: "Walk",
  description: null,
  is_default: false,
  revision: 5,
  thumbnail_url: null,
  config: {
    nodes: [
      {
        id: "tool-a",
        type: "tool",
        position: { x: 0, y: 0 },
        data: { type: "tool", processId: "buffer", label: "Buffer", config: {} },
      },
      {
        id: "tool-b",
        type: "tool",
        position: { x: 300, y: 0 },
        data: { type: "tool", processId: "clip", label: "Clip", config: {} },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    variables: [],
  },
  created_at: "2026-10-25T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
} as unknown as Workflow;

/** The canvas's React Flow store: a drag ends with a position change through it. */
let flow: ReturnType<typeof useStoreApi> | null = null;
function FlowStore() {
  flow = useStoreApi();
  return null;
}

function setup() {
  const store = configureStore({ reducer: { workflow: workflowReducer } });
  store.dispatch(setWorkflows([WORKFLOW]));
  store.dispatch(selectWorkflow("wf-1"));
  const view = render(
    <Provider store={store}>
      <ReactFlowProvider>
        <FlowStore />
        <WorkflowCanvas onDrop={vi.fn()} onDragOver={vi.fn()} />
      </ReactFlowProvider>
    </Provider>
  );
  return { store, view };
}

type Store = ReturnType<typeof setup>["store"];

const reduxPosition = (store: Store, id: string) =>
  store.getState().workflow.nodes.find((node) => node.id === id)?.position;
const drawnAt = (view: ReturnType<typeof setup>["view"], id: string) =>
  (view.container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement | null)?.style.transform;
const label = (store: Store, id: string) =>
  (store.getState().workflow.nodes.find((node) => node.id === id)?.data as { label?: string })?.label;

/** Past the history's debounce, so the change before is a step of its own. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

/** A drag that ends: React Flow reports the final position, not dragging any more. */
const dragEnd = (id: string, x: number, y: number) =>
  act(async () => {
    flow?.getState().triggerNodeChanges([{ id, type: "position", position: { x, y }, dragging: false }]);
  });

const arrowRight = (view: ReturnType<typeof setup>["view"], store: Store, id: string) =>
  act(async () => {
    store.dispatch(selectNode(id));
    await Promise.resolve();
    const node = view.container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
    fireEvent.keyDown(node, { key: "ArrowRight" });
  });

const ctrlZ = () =>
  act(async () => {
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
  });

describe("WorkflowCanvas undo", () => {
  it("draws a step back where an undo of its move puts it", async () => {
    const { store, view } = setup();
    await settle();
    await arrowRight(view, store, "tool-a");
    expect(reduxPosition(store, "tool-a")).toEqual({ x: 5, y: 0 });
    expect(drawnAt(view, "tool-a")).toContain("translate(5px");
    await settle();

    await ctrlZ();
    expect(reduxPosition(store, "tool-a")).toEqual({ x: 0, y: 0 });
    expect(drawnAt(view, "tool-a")).toContain("translate(0px");
  });

  it("draws a stored version loaded over the canvas, positions included", async () => {
    const { store, view } = setup();
    await settle();
    const moved = structuredClone(WORKFLOW);
    moved.revision = 6;
    moved.config.nodes[1].position = { x: 600, y: 40 };
    await act(async () => {
      store.dispatch(reloadWorkflow(moved));
    });
    expect(drawnAt(view, "tool-b")).toContain("translate(600px,40px)");
  });

  it("takes back only an assistant edit after a drag and an arrow-key move, keeping the moves", async () => {
    const { store, view } = setup();
    await settle();
    await dragEnd("tool-b", 320, 100);
    expect(reduxPosition(store, "tool-b")).toEqual({ x: 320, y: 100 });
    await settle();
    await arrowRight(view, store, "tool-a");
    await settle();

    // The assistant's edit as core stores it: the moves were saved before it.
    const edited = structuredClone(WORKFLOW);
    edited.revision = 7;
    edited.config.nodes[0].position = { x: 5, y: 0 };
    edited.config.nodes[0].data = { ...edited.config.nodes[0].data, label: "Buffer 500 m" } as never;
    edited.config.nodes[1].position = { x: 600, y: 0 };
    await act(async () => {
      store.dispatch(reloadWorkflow(edited));
    });
    expect(drawnAt(view, "tool-b")).toContain("translate(600px");
    await settle();

    await ctrlZ();
    expect(label(store, "tool-a")).toBe("Buffer");
    expect(reduxPosition(store, "tool-a")).toEqual({ x: 5, y: 0 });
    expect(reduxPosition(store, "tool-b")).toEqual({ x: 320, y: 100 });
    expect(drawnAt(view, "tool-a")).toContain("translate(5px");
    expect(drawnAt(view, "tool-b")).toContain("translate(320px,100px)");
    // The editor saves that on the revision the reload adopted.
    expect(store.getState().workflow.isDirty).toBe(true);
    expect(store.getState().workflow.revisions["wf-1"]).toBe(7);
  });
});
