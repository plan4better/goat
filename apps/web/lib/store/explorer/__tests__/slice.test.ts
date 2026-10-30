import { describe, expect, it } from "vitest";

import {
  clearRestoreGroup,
  closeExplorer,
  closeExplorerPanel,
  explorerPanelBack,
  explorerReducer,
  openExplorer,
  openExplorerPanel,
  panelItem,
  pickExplorerPattern,
  pickedStop,
  selectExplorerRoute,
  selectExplorerRouteAt,
  setExplorerDate,
  setExplorerDrawing,
  setExplorerFilters,
  setExplorerLeftTab,
  setExplorerRouteTab,
  setExplorerTripTab,
  setPlaybackTime,
  setPlaying,
  setStripCollapsed,
  setStripHeight,
  setStripView,
} from "@/lib/store/explorer/slice";
import { setMapMode } from "@/lib/store/map/slice";

const open = (state = explorerReducer(undefined, { type: "init" })) =>
  explorerReducer(state, openExplorer({ bundleId: "b1", bundleName: "Feed" }));

const FOURTH = { stop_idx: 4, name: "Fourth", lon: 13.43, lat: 52.5 };

describe("explorer slice", () => {
  it("opens on a bundle with nothing selected", () => {
    const state = open();
    expect(state).toMatchObject({ active: true, bundleId: "b1", bundleName: "Feed", selectedRouteId: null });
  });

  it("keeps the tab the user chose for the session", () => {
    let state = open();
    state = explorerReducer(state, setExplorerLeftTab("layers"));
    state = explorerReducer(state, closeExplorer());
    state = open(state);
    expect(state.leftTab).toBe("layers");
    // Another bundle opened from the Layers tab: its Explorer shows.
    state = explorerReducer(state, openExplorer({ bundleId: "b2", bundleName: "Other" }));
    expect(state.leftTab).toBe("explorer");
  });

  it("drops the drawing when the route is deselected", () => {
    let state = explorerReducer(open(), selectExplorerRoute("R1"));
    state = explorerReducer(
      state,
      setExplorerDrawing({
        routeId: "R1",
        color: "#123456",
        shapeLinesLayerId: null,
        shapeIds: [],
        stops: [],
        patternShapes: {},
        directions: [],
        patternBounds: {},
        patternEnds: {},
      })
    );
    state = explorerReducer(state, selectExplorerRoute(null));
    expect(state.drawing).toBeNull();
  });

  it("starts every bundle unfiltered with no stop picked", () => {
    let state = explorerReducer(
      open(),
      setExplorerFilters({ types: ["stops"], modes: ["bus"], agencies: [0] })
    );
    state = explorerReducer(state, openExplorerPanel({ item: { kind: "stop", stop: FOURTH } }));
    expect(state.filters.modes).toEqual(["bus"]);
    state = open(explorerReducer(state, closeExplorer()));
    expect(state.filters).toEqual({ types: [], modes: [], agencies: [] });
    expect(pickedStop(state)).toBeNull();
  });

  it("opens another route on its Overview, in its first direction", () => {
    let state = explorerReducer(open(), selectExplorerRoute("R1"));
    state = explorerReducer(state, setExplorerRouteTab("calendar"));
    state = explorerReducer(state, pickExplorerPattern({ direction: 3, pattern_idx: 4 }));
    // Back to the list and into the same route: where the user was.
    state = explorerReducer(state, selectExplorerRoute("R1"));
    expect(state.routeTab).toBe("calendar");
    state = explorerReducer(state, selectExplorerRoute("R2"));
    expect(state.routeTab).toBe("service");
    expect(state.pattern).toBeNull();
  });

  it("lets go of a stop picked along a route when the route is left", () => {
    let state = explorerReducer(open(), selectExplorerRoute("R1"));
    state = explorerReducer(
      state,
      openExplorerPanel({ item: { kind: "stop", stop: FOURTH }, fromRoute: "R1" })
    );
    state = explorerReducer(state, selectExplorerRoute(null));
    expect(pickedStop(state)).toBeNull();
    // A stop opened from the stops list stays as routes come and go.
    state = explorerReducer(state, openExplorerPanel({ item: { kind: "stop", stop: FOURTH } }));
    state = explorerReducer(state, selectExplorerRoute("R2"));
    expect(pickedStop(state)?.stop_idx).toBe(4);
  });

  it("goes back from a trip to the stop it was opened from, and closes", () => {
    let state = explorerReducer(open(), openExplorerPanel({ item: { kind: "stop", stop: FOURTH } }));
    state = explorerReducer(
      state,
      openExplorerPanel({ item: { kind: "trip", trip_idx: 2, run_dep_s: 29400 }, push: true })
    );
    expect(panelItem(state)?.kind).toBe("trip");
    expect(pickedStop(state)).toBeNull();
    state = explorerReducer(state, explorerPanelBack());
    expect(pickedStop(state)?.stop_idx).toBe(4);
    state = explorerReducer(state, closeExplorerPanel());
    expect(panelItem(state)).toBeNull();
  });

  it("pauses playback, at the same time of day, when the date changes", () => {
    let state = explorerReducer(open(), setExplorerDate("2026-10-14"));
    state = explorerReducer(state, setPlaybackTime(8 * 3600));
    state = explorerReducer(state, setPlaying(true));
    state = explorerReducer(state, setExplorerDate("2026-10-14"));
    expect(state).toMatchObject({ playing: true, time_s: 8 * 3600 });
    state = explorerReducer(state, setExplorerDate("2026-10-15"));
    expect(state).toMatchObject({ playing: false, time_s: 8 * 3600 });
  });

  it("hands back the group it hid when it closes", () => {
    let state = explorerReducer(
      undefined,
      openExplorer({ bundleId: "b1", bundleName: "Feed", hiddenGroupId: 7 })
    );
    expect(state.hiddenGroupId).toBe(7);
    state = explorerReducer(state, closeExplorer());
    expect(state).toMatchObject({ active: false, hiddenGroupId: null, restoreGroupId: 7 });
    state = explorerReducer(state, clearRestoreGroup());
    expect(state.restoreGroupId).toBeNull();
  });

  it("ends when the map leaves the data view", () => {
    expect(explorerReducer(open(), setMapMode("builder")).active).toBe(false);
    expect(explorerReducer(open(), setMapMode("data")).active).toBe(true);
  });

  it("keeps the strip as the user left it for the session", () => {
    let state = explorerReducer(open(), setStripCollapsed(true));
    state = explorerReducer(state, setStripView("list"));
    state = explorerReducer(state, setStripHeight(412.4));
    state = open(explorerReducer(state, closeExplorer()));
    expect(state.strip).toMatchObject({ collapsed: true, view: "list", height: 412 });
  });

  it("opens a trip on its stops, and keeps the tab while stepping", () => {
    const trip = (trip_idx: number) => ({ kind: "trip" as const, trip_idx, run_dep_s: 0 });
    let state = explorerReducer(open(), openExplorerPanel({ item: trip(1) }));
    state = explorerReducer(state, setExplorerTripTab("calendar"));
    state = explorerReducer(state, openExplorerPanel({ item: trip(2), step: true }));
    expect(state.tripTab).toBe("calendar");
    state = explorerReducer(state, openExplorerPanel({ item: trip(3) }));
    expect(state.tripTab).toBe("stops");
  });

  it("shows the last bundle's layers again when another bundle's Explorer opens over it", () => {
    let state = explorerReducer(
      undefined,
      openExplorer({ bundleId: "berlin", bundleName: "Berlin", hiddenGroupId: 7 })
    );
    state = explorerReducer(
      state,
      openExplorer({ bundleId: "munich", bundleName: "Munich", hiddenGroupId: 9 })
    );
    expect(state).toMatchObject({ bundleId: "munich", hiddenGroupId: 9, restoreGroupId: 7 });
    // The same bundle again: its group, hidden already, stays hidden.
    state = explorerReducer(state, clearRestoreGroup());
    state = explorerReducer(
      state,
      openExplorer({ bundleId: "munich", bundleName: "Munich", hiddenGroupId: null })
    );
    expect(state).toMatchObject({ hiddenGroupId: 9, restoreGroupId: null });
    // Closed: it is shown again.
    expect(explorerReducer(state, closeExplorer()).restoreGroupId).toBe(9);
  });

  it("opens a route clicked on the map in the direction of the line clicked", () => {
    const drawing = (routeId: string) => ({
      routeId,
      color: "#123456",
      shapeLinesLayerId: null,
      shapeIds: ["out", "back", "both"],
      stops: [],
      // Direction 10 runs "out", direction 20 "back"; both run "both".
      patternShapes: { 10: ["out", "both"], 20: ["back", "both"] },
      directions: [
        { key: 10, patterns: [10], name: { kind: "to" as const, place: "A", via: null } },
        { key: 20, patterns: [20], name: { kind: "to" as const, place: "B", via: null } },
      ],
      patternBounds: {},
      patternEnds: {},
    });
    let state = explorerReducer(open(), selectExplorerRouteAt({ routeId: "R1", shapeIds: ["back"] }));
    state = explorerReducer(state, setExplorerDrawing(drawing("R1")));
    expect(state.pattern).toEqual({ direction: 20, pattern_idx: null });
    expect(state.clickedShapes).toBeNull();
    // A shape both directions run on tells nothing: the first direction.
    state = explorerReducer(state, selectExplorerRouteAt({ routeId: "R2", shapeIds: ["both"] }));
    state = explorerReducer(state, setExplorerDrawing(drawing("R2")));
    expect(state.pattern).toBeNull();
  });
});
