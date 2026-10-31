import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerSurface, resetAssistantStore, setDockState } from "@/lib/assistant/store";
import type { AssistantMessage, AssistantSurfaceId } from "@/lib/assistant/types";

import { useFitRunResults } from "@/components/assistant/useFitRunResults";

const state = vi.hoisted(() => ({
  layers: [] as Array<{ id: number; type: string; extent: string }>,
  /** What the map shows now. */
  view: [0, 0, 0, 0] as [number, number, number, number],
}));
vi.mock("@/lib/api/projects", () => ({
  useProjectLayers: (projectId?: string) => ({ layers: projectId ? state.layers : undefined }),
}));

// Hamburg, the result; Munich, the view the map was left at.
const HAMBURG = "POLYGON((9.9 53.5, 10.1 53.5, 10.1 53.6, 9.9 53.6, 9.9 53.5))";
const MUNICH: [number, number, number, number] = [11.3, 47.9, 11.8, 48.3];
const NORTH_GERMANY: [number, number, number, number] = [8.5, 52.8, 11.5, 54.2];
const result = { id: 7, type: "feature", extent: HAMBURG };

const runPart = (status: string, { started = true, job = "j1" } = {}) => ({
  type: "data-workflow-run",
  id: `workflow-run:${job}`,
  data: {
    workflow_id: "w1",
    project_id: "p1",
    job_id: job,
    status,
    started,
    card_id: null,
    done: status === "running" ? 0 : 1,
    total: 1,
    step: null,
    started_at: null,
    saved: status === "running" ? 0 : 1,
  },
});
const runOutput = (status: string, saved: number[], { job = "j1", toolName = "workflow_run" } = {}) => ({
  type: "dynamic-tool",
  toolName,
  toolCallId: `call-${job}-${toolName}`,
  state: "output-available",
  input: { workflow_id: "w1" },
  output: {
    workflow_id: "w1",
    job_id: job,
    status,
    steps: [],
    saved: saved.map((id) => ({ name: "Result", layer_project_id: id, rows: 3 })),
    note: "",
  },
});
const answer = (id: string, ...parts: object[]): AssistantMessage =>
  ({ id, role: "assistant", parts }) as unknown as AssistantMessage;

const started = () => [answer("a1", runPart("running"))];
const finished = () => [answer("a1", runPart("succeeded"), runOutput("succeeded", [7]))];

/** The open project's page in `surface` mode, its map showing `view`. */
function openProject(view: [number, number, number, number], surface: AssistantSurfaceId = "project.map") {
  const zoomToLayer = vi.fn();
  state.view = view;
  act(() => {
    registerSurface({
      surface: surface as Exclude<AssistantSurfaceId, "none">,
      project: { id: "p1", name: "Hafen" },
      getContext: () =>
        surface === "project.map"
          ? {
              surface: "project.map",
              project_id: "p1",
              viewport: { center: [11.5, 48.1], zoom: 9, bearing: 0, pitch: 0, bbox: state.view },
            }
          : { surface: surface as "project.workflows", project_id: "p1" },
      zoomToLayer,
    });
  });
  return zoomToLayer;
}

const follow = (initial: AssistantMessage[] = [], projectId: string | null = "p1") =>
  renderHook(({ messages }) => useFitRunResults(messages, initial, projectId), {
    initialProps: { messages: initial.length ? initial : started() },
  });

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  state.layers = [];
});

describe("useFitRunResults", () => {
  it("fits the map to the result once its layer is in the project and the view shows none of it", () => {
    const zoomToLayer = openProject(MUNICH);
    const { rerender } = follow();
    // Rounding, a fraction of a pixel: the same view.
    state.view = [11.301, 47.9, 11.801, 48.3];
    rerender({ messages: finished() });
    // The layer list is read again after the run: nothing to fit to before.
    expect(zoomToLayer).not.toHaveBeenCalled();
    state.layers = [result];
    rerender({ messages: finished() });
    expect(zoomToLayer).toHaveBeenCalledTimes(1);
    // A fit nobody clicked for leaves the user's selection alone.
    expect(zoomToLayer).toHaveBeenCalledWith(7, { select: false });
    rerender({
      messages: [...finished(), answer("a2", runOutput("succeeded", [7], { toolName: "workflow_last_run" }))],
    });
    expect(zoomToLayer).toHaveBeenCalledTimes(1);
  });

  it("leaves the map when the view already shows part of a result", () => {
    const zoomToLayer = openProject(NORTH_GERMANY);
    state.layers = [result, { id: 8, type: "feature", extent: HAMBURG.replace(/53\./g, "48.") }];
    const { rerender } = follow();
    rerender({ messages: [answer("a1", runPart("succeeded"), runOutput("succeeded", [8, 7]))] });
    expect(zoomToLayer).not.toHaveBeenCalled();
  });

  it("leaves the map once it moved after the run started, also by a map control", () => {
    const zoomToLayer = openProject(MUNICH);
    state.layers = [result];
    const { rerender } = follow();
    // An address search flies the map elsewhere, still away from the result.
    state.view = [8.6, 49.3, 8.8, 49.5];
    rerender({ messages: finished() });
    expect(zoomToLayer).not.toHaveBeenCalled();
  });

  it("takes the view of a run started in another mode once the map shows", () => {
    state.layers = [result];
    openProject(MUNICH, "project.workflows");
    const { rerender } = follow();
    const zoomToLayer = openProject(MUNICH);
    rerender({ messages: started() });
    rerender({ messages: finished() });
    expect(zoomToLayer).toHaveBeenCalledWith(7, { select: false });
  });

  it("fits for a run an earlier answer started and a later one reported", () => {
    const zoomToLayer = openProject(MUNICH);
    state.layers = [result];
    const { rerender } = follow();
    rerender({
      messages: [
        ...started(),
        answer("a2", runPart("succeeded", { started: false }), runOutput("succeeded", [7])),
      ],
    });
    expect(zoomToLayer).toHaveBeenCalledWith(7, { select: false });
  });

  it("does nothing for a run it did not start or one of the conversation as it was opened", () => {
    const zoomToLayer = openProject(MUNICH);
    state.layers = [result];
    // A run the user started, which the answer waited for.
    const waited = (status: string) => answer("a1", runPart(status, { started: false }));
    const { rerender } = renderHook(({ messages }) => useFitRunResults(messages, [], "p1"), {
      initialProps: { messages: [waited("running")] },
    });
    rerender({ messages: [answer("a1", ...waited("succeeded").parts, runOutput("succeeded", [7]))] });
    const stored = finished();
    const { rerender: again } = follow(stored);
    again({ messages: [...stored] });
    expect(zoomToLayer).not.toHaveBeenCalled();
  });

  it("does nothing on another surface, another project, or while the dock covers the map", () => {
    state.layers = [result];
    const workflows = openProject(MUNICH, "project.workflows");
    const first = follow();
    first.rerender({ messages: finished() });
    expect(workflows).not.toHaveBeenCalled();

    const map = openProject(MUNICH);
    const other = follow([], "p2");
    other.rerender({ messages: finished() });
    act(() => setDockState({ expanded: true }));
    const covered = follow();
    covered.rerender({ messages: finished() });
    expect(map).not.toHaveBeenCalled();
  });
});
