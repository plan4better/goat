import { describe, expect, it } from "vitest";

import {
  clearExplorerSelection,
  explorerReducer,
  openExplorer,
  openExplorerPanel,
  pickExplorerPattern,
  selectExplorerRoute,
  setEditDraft,
  setEditMode,
  setEditTool,
  setExplorerPath,
} from "@/lib/store/explorer/slice";

const open = () =>
  explorerReducer(
    explorerReducer(undefined, { type: "init" }),
    openExplorer({ bundleId: "b1", bundleName: "Feed" })
  );
const PATH = {
  pattern_idx: 4,
  from_i: 1,
  to_i: 2,
  from_name: "Second",
  to_name: "Third",
  from_stop: 1,
  to_stop: 2,
  route_idx: 0,
};
const STOP = { stop_idx: 4, name: "Fourth", lon: 13.43, lat: 52.5 };

describe("the selection", () => {
  it("holds one of a path, a trip and a stop", () => {
    let state = explorerReducer(open(), selectExplorerRoute("R1"));
    state = explorerReducer(state, openExplorerPanel({ item: { kind: "stop", stop: STOP } }));
    state = explorerReducer(state, setExplorerPath(PATH));
    expect(state.path).toEqual(PATH);
    expect(state.panel.stack).toEqual([]);
    state = explorerReducer(state, openExplorerPanel({ item: { kind: "trip", trip_idx: 2, run_dep_s: 0 } }));
    expect(state.path).toBeNull();
  });

  it("lets a path go with its direction or line", () => {
    let state = explorerReducer(open(), selectExplorerRoute("R1"));
    state = explorerReducer(state, setExplorerPath(PATH));
    expect(explorerReducer(state, pickExplorerPattern({ direction: 7, pattern_idx: null })).path).toBeNull();
    expect(explorerReducer(state, selectExplorerRoute("R2")).path).toBeNull();
  });

  it("is cleared whole by Esc", () => {
    let state = explorerReducer(open(), selectExplorerRoute("R1"));
    state = explorerReducer(state, setExplorerPath(PATH));
    state = explorerReducer(state, clearExplorerSelection());
    expect(state.path).toBeNull();
    expect(state.selectedRouteId).toBeNull();
  });
});

describe("the line modes", () => {
  it("starts with Select and no draft, and ends with its line or another tool", () => {
    let state = explorerReducer(open(), selectExplorerRoute("R1"));
    state = explorerReducer(state, setEditDraft({ kind: "stop-delete", stop_idx: 3 }));
    state = explorerReducer(state, setEditMode({ route_idx: 0, kind: "stops" }));
    expect(state.edit.mode).toEqual({ route_idx: 0, kind: "stops" });
    expect(state.edit.draft).toBeNull();
    expect(state.edit.tool).toBe("select");
    expect(explorerReducer(state, selectExplorerRoute("R2")).edit.mode).toBeNull();
    expect(explorerReducer(state, setEditTool("stop")).edit.mode).toBeNull();
    // Select again keeps it.
    expect(explorerReducer(state, setEditTool("select")).edit.mode).toEqual({ route_idx: 0, kind: "stops" });
  });
});
