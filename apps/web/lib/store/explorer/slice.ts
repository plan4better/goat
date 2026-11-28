/**
 * The PT network Explorer's view state: which bundle is open, which tab, which
 * route, what the right panel shows, which date, what the list is filtered by. The data itself is in DuckDB-WASM (useExplorerDb), not
 * here; the selected route's drawing — a handful of shape ids and stops — is,
 * because the map draws it from inside <Map>, away from the panels that hold
 * the database.
 */
import { type PayloadAction, createSlice } from "@reduxjs/toolkit";

import type { DirectionName, VariantKind } from "@/lib/explorer/derive/directions";
import { directionsOnShapes } from "@/lib/explorer/directionChoice";
import { type EditDraft, NO_LINE_VALUES, NO_STOP_VALUES } from "@/lib/explorer/edit/drafts";
import type { ChangeSummary } from "@/lib/explorer/edit/types";
import type { ModeKey } from "@/lib/explorer/modes";
import { setMapMode } from "@/lib/store/map/slice";

export type ExplorerLeftTab = "layers" | "explorer";

/** What the Explorer tab lists; an empty choice means everything. */
export interface ExplorerFilters {
  types: ("routes" | "stops")[];
  modes: ModeKey[];
  /** agency_idx values. */
  agencies: number[];
}

export type ExplorerRouteTab = "stops" | "service" | "calendar";
/** The trip panel's tabs: its stops, or the days it runs. */
export type ExplorerTripTab = "stops" | "calendar";
/** The stop panel's tabs: its schedule for the date, the next departures,
 * and its details (fields, lines, station). */
export type ExplorerStopTab = "schedule" | "departures" | "details";

/** The destination picker's choice: all directions, or a direction (by its
 * key, its main pattern's index) whole, or one of its patterns
 * (lib/explorer/directionChoice.ts). */
export interface ExplorerPatternChoice {
  direction: number;
  /** A variant; null for the whole direction. */
  pattern_idx: number | null;
}

/** A path: the stretch of a pattern between two of its stops in a row
 * (board 21), selected below a direction; its line is the selection
 * store's (lib/explorer/selectionStore.ts). */
export interface ExplorerPath {
  pattern_idx: number;
  /** The two stops, by their place in the pattern and name. */
  from_i: number;
  to_i: number;
  from_name: string;
  to_name: string;
  /** The two stops' stop_idx, and the pattern's line. */
  from_stop: number;
  to_stop: number;
  route_idx: number;
}

/** The trip strip, under a selected route (02-panel-behaviour-spec ›
 * Playback, Viewers): what the user set by hand, which no automatic change
 * undoes for the session. It shows the route's whole day; the chart zooms. */
export interface ExplorerStrip {
  /** Folded to the mini bar by hand. */
  collapsed: boolean;
  view: "chart" | "list";
  /** The whole bottom panel's height (px), as dragged by its top edge. */
  height: number;
}

/** The settings dialog's tabs (settings.ts). */
export type ExplorerSettingsTab = "data" | "rates" | "periods" | "vehicles";

/** The edit bar's tools (board 17): Select, and the two that create. */
export type ExplorerEditTool = "select" | "stop" | "route";

/** A line edited on the map until Done: its stops, or its path. */
export type ExplorerEditMode = "stops" | "path";

/** The dialog an edit is made in, from a selection's actions. */
export type ExplorerEditDialog =
  | { kind: "line"; route_idx: number }
  | { kind: "stop"; stop_idx: number }
  | { kind: "trip-times"; trip_idx: number }
  | { kind: "trip-shift"; trip_idx: number }
  | { kind: "trip-duplicate"; trip_idx: number; dep_s: number };

/** Editing, for a user who may write the bundle. The changes themselves are
 * the session's (lib/explorer/edit/session.ts); this mirrors their summaries
 * for the bar, the change list and the exit dialog. */
export interface ExplorerEdit {
  tool: ExplorerEditTool;
  /** Route paths follow streets (stops are placed where clicked); kept for
   * the session. */
  snap: boolean;
  /** The applied changes, oldest first, and those undone that redo brings
   * back, the latest undone last. */
  changes: ChangeSummary[];
  redo: ChangeSummary[];
  /** The change list, under the bar's count. */
  listOpen: boolean;
  /** The "Save changes to …?" dialog: asking, or saving. */
  exit: "asking" | "saving" | null;
  /** Why the last save did not go through, shown in the dialog. */
  saveProblem: string | null;
  /** The edit being made, not yet applied (lib/explorer/edit/drafts.ts). */
  draft: EditDraft | null;
  /** The service dialog (4.1), open for a line and the direction it opened
   * on (Direction.key); it fills itself from a headway draft of that line. */
  service: { route_idx: number; direction: number | null } | null;
  /** The dialog an edit is made in, opened from a selection's actions (its
   * tab only shows what it edits): a line's properties, a stop's, a trip's
   * times or its shift. */
  dialog: ExplorerEditDialog | null;
  /** A line edited on the map until Done (the modes): its stops added,
   * removed and cut back ("stops"), or its path dragged ("path"). */
  mode: { route_idx: number; kind: ExplorerEditMode } | null;
  /** This user edits the open bundle (its session is ready): what the map,
   * outside the Explorer's data, needs to know to let a stop be dragged. */
  enabled: boolean;
}

/** Playback speeds: how many seconds of the day pass in one second. */
export const PLAYBACK_SPEEDS = [1, 10, 60] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export const NO_FILTERS: ExplorerFilters = { types: [], modes: [], agencies: [] };

export interface ExplorerRouteDrawing {
  routeId: string;
  /** `#RRGGBB`; the feed's colour, or none. */
  color: string | null;
  /** The bundle's shape_lines layer, and the route's shape ids in it. */
  shapeLinesLayerId: string | null;
  shapeIds: string[];
  /** Its stops, for the map and for fitting the view. */
  stops: { stop_idx: number; lon: number; lat: number; name: string }[];
  /** Each pattern's shapes — the feed's, or the line through its stops —:
   * what the map highlights when the Stops tab shows that pattern. */
  patternShapes: Record<number, string[]>;
  /** The route's directions, each with its patterns (its main one first)
   * and its name: which pattern the map highlights for the picker's choice,
   * and how the map offers a direction to pick. */
  directions: {
    key: number;
    patterns: number[];
    name: DirectionName;
    /** Its patterns other than the main one, as the direction picker names
     * them (a short turn, an express, a branch, to where). */
    variants: { pattern_idx: number; kind: VariantKind; destination: string }[];
  }[];
  /** Each pattern's extent from its stops, `[west, south, east, north]`: the
   * map fits it when the Stops tab switches to it. */
  patternBounds: Record<number, [number, number, number, number]>;
  /** Each pattern's first and last stop (stop_idx): the ends the map names. */
  patternEnds: Record<number, [number, number]>;
}

/** A stop the right panel shows, and where the map marks it (a station
 * may have no position of its own). */
export interface ExplorerPickedStop {
  stop_idx: number;
  name: string;
  lon: number | null;
  lat: number | null;
}

/** What the right panel shows (02-panel-behaviour-spec › Viewers): a stop's
 * timetable, or one run of a trip — a trip and when the run left its first
 * stop, as a frequency-based trip runs many times. */
export type ExplorerPanelItem =
  | { kind: "stop"; stop: ExplorerPickedStop }
  | { kind: "trip"; trip_idx: number; run_dep_s: number };

export interface ExplorerPanel {
  /** The item shown is the last; "‹" goes back to the one before (a trip
   * opened from a stop's timetable goes back to the stop). */
  stack: ExplorerPanelItem[];
  /** The route the item was opened from, if any: leaving that route lets
   * the item go. */
  fromRoute: string | null;
}

export interface ExplorerState {
  active: boolean;
  bundleId: string | null;
  bundleName: string | null;
  /** The layer-tree group the Explorer hid on opening (its bundle's own
   * layers, drawn by the Explorer itself), and, once it closes, the one to
   * show again — the layer tree does both. */
  hiddenGroupId: number | null;
  restoreGroupId: number | null;
  leftTab: ExplorerLeftTab;
  selectedRouteId: string | null;
  /** The one date every view shows, `YYYY-MM-DD`; null until the feed's
   * window is known. */
  date: string | null;
  drawing: ExplorerRouteDrawing | null;
  filters: ExplorerFilters;
  panel: ExplorerPanel;
  routeTab: ExplorerRouteTab;
  /** Kept as trips are stepped through, each its own panel. */
  tripTab: ExplorerTripTab;
  stopTab: ExplorerStopTab;
  /** One picker for the trip strip, the Stops tab and the stop timetable
   * (02-panel-behaviour-spec › Direction); null is the first direction. */
  pattern: ExplorerPatternChoice | null;
  strip: ExplorerStrip;
  /** The settings dialog, open on a tab, or closed. */
  settingsTab: ExplorerSettingsTab | null;
  /** A right click on the selected line, while editing: where (on the
   * page, and on the map), and on which stop, if one. */
  lineMenu: {
    x: number;
    y: number;
    lon: number;
    lat: number;
    stop_idx: number | null;
    /** Out of a line mode: the selection's actions. */
    selection?: boolean;
  } | null;
  /** The network's extent, `[west, south, east, north]`: the map fits it
   * once on opening. */
  bounds: [number, number, number, number] | null;
  /** Playback: whether it runs, how fast, and the time of the day it shows,
   * in service-day seconds — null until the day's service is known. While it
   * runs the live time is the playback clock's (lib/explorer/playback.ts);
   * this is where it starts and stops. */
  playing: boolean;
  speed: PlaybackSpeed;
  time_s: number | null;
  /** The time the strip's now-line is dragged to: the line and the clock
   * follow it, and the map is drawn for it once let go. Let go, it holds
   * until the map has caught up; the bottom bar lets it go then, so it is
   * let go even when the chart is gone by then (the strip folded). */
  scrub: { t: number; let_go: boolean } | null;
  /** A run the map is asked to fly to, if its vehicle is out (a trip picked
   * in the trip strip); `n` counts the asks, so the same run can be asked
   * for again. */
  focus: { trip_idx: number; run_dep_s: number; n: number } | null;
  /** The shapes a click on the map found the selected route by: once its
   * drawing is in, the direction they are of is picked (setExplorerDrawing),
   * so the route opens the way it was clicked, not in its first direction. */
  clickedShapes: { routeId: string; shapeIds: string[] } | null;
  /** The path being rerouted, from "Edit path": named in the
   * reroute's panel. */
  path: ExplorerPath | null;
  edit: ExplorerEdit;
}

/** Select a route (or none): another route starts on its Service tab, in
 * its own first direction; what the right panel opened from the route it
 * leaves goes with it. */
function selectRoute(state: ExplorerState, routeId: string | null): void {
  if (routeId !== state.selectedRouteId) {
    state.routeTab = "service";
    state.pattern = null;
    state.path = null;
    // The mode is on the line left.
    state.edit.mode = null;
    if (state.panel.fromRoute !== null && state.panel.fromRoute === state.selectedRouteId)
      state.panel = { ...state.panel, stack: [], fromRoute: null };
  }
  state.selectedRouteId = routeId;
  if (routeId === null) state.drawing = null;
}

/** What the strip keeps for the session, the Explorer closed or not. */
const NO_EDITS: ExplorerEdit = {
  tool: "select",
  snap: true,
  changes: [],
  redo: [],
  listOpen: false,
  exit: null,
  saveProblem: null,
  draft: null,
  service: null,
  dialog: null,
  mode: null,
  enabled: false,
};

/** Editing as a new session starts: nothing changed, Select, the snap as
 * the user left it. */
function freshEdit(edit: ExplorerEdit): ExplorerEdit {
  return { ...NO_EDITS, snap: edit.snap, enabled: edit.enabled };
}

function stickyStrip(strip: ExplorerStrip): ExplorerStrip {
  return {
    ...initialState.strip,
    collapsed: strip.collapsed,
    view: strip.view,
    height: strip.height,
  };
}

const initialState: ExplorerState = {
  active: false,
  bundleId: null,
  bundleName: null,
  hiddenGroupId: null,
  restoreGroupId: null,
  leftTab: "explorer",
  selectedRouteId: null,
  date: null,
  drawing: null,
  filters: NO_FILTERS,
  panel: { stack: [], fromRoute: null },
  routeTab: "service",
  tripTab: "stops",
  stopTab: "schedule",
  pattern: null,
  lineMenu: null,
  strip: {
    collapsed: false,
    view: "chart",
    // The strip's opening height (STRIP_HEIGHT in the strip's layout).
    height: 272,
  },
  settingsTab: null,
  bounds: null,
  playing: false,
  speed: 10,
  time_s: null,
  scrub: null,
  focus: null,
  clickedShapes: null,
  path: null,
  edit: NO_EDITS,
};

const explorerSlice = createSlice({
  name: "explorer",
  initialState,
  reducers: {
    openExplorer: (
      state,
      action: PayloadAction<{ bundleId: string; bundleName: string; hiddenGroupId?: number | null }>
    ) => {
      // Opened over another bundle's Explorer, that bundle's layers, which
      // it hid, are shown again; opened again on the same bundle, the group
      // it hid stays hidden (its eye is off now, so the menu passes none).
      const hidden = state.active ? state.hiddenGroupId : null;
      const same = state.active && state.bundleId === action.payload.bundleId;
      // The tab the user chose stays for the session; switched to another
      // bundle (from the Layers tab, where its menu is), the new bundle's
      // Explorer shows, not the layer tree it was opened from.
      return {
        ...initialState,
        leftTab: state.active && !same ? "explorer" : state.leftTab,
        strip: stickyStrip(state.strip),
        edit: freshEdit(state.edit),
        active: true,
        bundleId: action.payload.bundleId,
        bundleName: action.payload.bundleName,
        hiddenGroupId: same
          ? (action.payload.hiddenGroupId ?? hidden)
          : (action.payload.hiddenGroupId ?? null),
        restoreGroupId: same ? null : hidden,
      };
    },
    closeExplorer: (state) => ({
      ...initialState,
      leftTab: state.leftTab,
      strip: stickyStrip(state.strip),
      edit: freshEdit(state.edit),
      restoreGroupId: state.hiddenGroupId,
    }),
    /** The layer tree has shown the group again. */
    clearRestoreGroup: (state) => {
      state.restoreGroupId = null;
    },
    setExplorerLeftTab: (state, action: PayloadAction<ExplorerLeftTab>) => {
      state.leftTab = action.payload;
    },
    selectExplorerRoute: (state, action: PayloadAction<string | null>) => {
      selectRoute(state, action.payload);
      state.clickedShapes = null;
    },
    /** A route selected by clicking its line on the map: it opens in the
     * direction of the shapes clicked, where they tell it. */
    selectExplorerRouteAt: (state, action: PayloadAction<{ routeId: string; shapeIds: string[] }>) => {
      selectRoute(state, action.payload.routeId);
      state.clickedShapes = action.payload;
    },
    setExplorerTripTab: (state, action: PayloadAction<ExplorerTripTab>) => {
      state.tripTab = action.payload;
    },
    setExplorerStopTab: (state, action: PayloadAction<ExplorerStopTab>) => {
      state.stopTab = action.payload;
    },
    setExplorerRouteTab: (state, action: PayloadAction<ExplorerRouteTab>) => {
      state.routeTab = action.payload;
    },
    pickExplorerPattern: (state, action: PayloadAction<ExplorerPatternChoice | null>) => {
      state.pattern = action.payload;
      state.path = null;
    },
    /** The path a reroute starts on (none: let go). A path, a trip and a
     * stop are one level, one at a time. */
    setExplorerPath: (state, action: PayloadAction<ExplorerPath | null>) => {
      state.path = action.payload;
      if (action.payload) {
        state.panel = { stack: [], fromRoute: null };
        state.edit.draft = null;
      }
    },
    /** Esc with Select (board 17): nothing selected. */
    clearExplorerSelection: (state) => {
      selectRoute(state, null);
      state.panel = { stack: [], fromRoute: null };
      state.path = null;
      state.edit.draft = null;
    },
    openExplorerSettings: (state, action: PayloadAction<ExplorerSettingsTab | null>) => {
      state.settingsTab = action.payload;
    },
    setExplorerBounds: (state, action: PayloadAction<[number, number, number, number] | null>) => {
      state.bounds = action.payload;
    },
    setPlaying: (state, action: PayloadAction<boolean>) => {
      state.playing = action.payload;
    },
    setPlaybackSpeed: (state, action: PayloadAction<PlaybackSpeed>) => {
      state.speed = action.payload;
    },
    /** Where playback stands: set by the scrubber, and by the clock when it stops. */
    setPlaybackTime: (state, action: PayloadAction<number | null>) => {
      state.time_s = action.payload;
    },
    focusExplorerRun: (state, action: PayloadAction<{ trip_idx: number; run_dep_s: number }>) => {
      state.focus = { ...action.payload, n: (state.focus?.n ?? 0) + 1 };
    },
    setScrub: (state, action: PayloadAction<{ t: number; let_go: boolean } | null>) => {
      state.scrub = action.payload;
    },
    setExplorerDate: (state, action: PayloadAction<string>) => {
      // Another day's service is read afresh: playback pauses, at the same
      // time of day, so days compare at one time (moved into the new day's
      // service if it is outside it: usePlayback).
      if (action.payload !== state.date) {
        state.playing = false;
        state.scrub = null;
      }
      state.date = action.payload;
    },
    setExplorerDrawing: (state, action: PayloadAction<ExplorerRouteDrawing | null>) => {
      state.drawing = action.payload;
      // Clicked on the map: the direction of the shapes clicked, set with the
      // drawing, so no view shows the first direction in between. Shapes both
      // directions run on tell nothing: the first stays.
      const clicked = state.clickedShapes;
      const drawing = action.payload;
      if (clicked && drawing && clicked.routeId === drawing.routeId) {
        const keys = directionsOnShapes(clicked.shapeIds, drawing.directions, drawing.patternShapes);
        if (keys.length === 1 && state.pattern === null)
          state.pattern = { direction: keys[0], pattern_idx: null };
        state.clickedShapes = null;
      }
    },
    setExplorerFilters: (state, action: PayloadAction<ExplorerFilters>) => {
      state.filters = action.payload;
    },
    /** Show an item in the right panel: in place of everything it shows;
     * with `push`, over it, to go back to; with `step`, in place of the item
     * shown only (the trip before or after it). */
    openExplorerPanel: (
      state,
      action: PayloadAction<{
        item: ExplorerPanelItem;
        push?: boolean;
        step?: boolean;
        fromRoute?: string | null;
      }>
    ) => {
      const { item, push, step, fromRoute } = action.payload;
      state.path = null;
      state.edit.draft = null;
      // A trip opened afresh starts on its stops; stepping to the trip before
      // or after keeps the tab.
      if (item.kind === "trip" && !step) state.tripTab = "stops";
      if (push) state.panel.stack = [...state.panel.stack, item];
      else if (step && state.panel.stack.length)
        state.panel.stack = [...state.panel.stack.slice(0, -1), item];
      else {
        state.panel.stack = [item];
        state.panel.fromRoute = fromRoute ?? null;
      }
    },
    explorerPanelBack: (state) => {
      state.panel.stack = state.panel.stack.slice(0, -1);
      state.edit.draft = null;
      if (!state.panel.stack.length) state.panel.fromRoute = null;
    },
    closeExplorerPanel: (state) => {
      state.panel.stack = [];
      state.edit.draft = null;
      state.panel.fromRoute = null;
    },
    setStripCollapsed: (state, action: PayloadAction<boolean>) => {
      state.strip.collapsed = action.payload;
    },
    setStripView: (state, action: PayloadAction<ExplorerStrip["view"]>) => {
      state.strip.view = action.payload;
    },
    /** The height the strip was dragged to; the caller clamps it to the
     * viewport. */
    setStripHeight: (state, action: PayloadAction<number>) => {
      state.strip.height = Math.round(action.payload);
    },
    setEditTool: (state, action: PayloadAction<ExplorerEditTool>) => {
      state.edit.tool = action.payload;
      state.edit.listOpen = false;
      // A tool that creates leaves the mode.
      if (action.payload !== "select") state.edit.mode = null;
      // The Route tool draws a new line (1.1): its panel open from the start.
      state.edit.draft =
        action.payload === "route" ? { kind: "line-new", stops: [], values: NO_LINE_VALUES } : null;
      if (action.payload === "route") {
        state.panel = { stack: [], fromRoute: null };
        state.path = null;
      }
    },
    setEditEnabled: (state, action: PayloadAction<boolean>) => {
      state.edit.enabled = action.payload;
    },
    /** The edit being made, or none: Cancel, or applied. */
    openExplorerLineMenu: (state, action: PayloadAction<NonNullable<ExplorerState["lineMenu"]>>) => {
      state.lineMenu = action.payload;
    },
    closeExplorerLineMenu: (state) => {
      state.lineMenu = null;
    },
    setEditDraft: (state, action: PayloadAction<EditDraft | null>) => {
      state.edit.draft = action.payload;
    },
    /** A click with the Stop tool (board 18): a new stop there, never
     * snapped, in the right panel to name; a second click moves it, keeping
     * what was typed. */
    placeStop: (state, action: PayloadAction<{ lon: number; lat: number }>) => {
      const draft = state.edit.draft;
      state.edit.draft = {
        kind: "stop-new",
        ...action.payload,
        // Its id is drawn by the panel, from the snapshot; kept on a move.
        stop_id: draft?.kind === "stop-new" ? draft.stop_id : null,
        values: draft?.kind === "stop-new" ? draft.values : NO_STOP_VALUES,
      };
      state.panel = { stack: [], fromRoute: null };
      state.path = null;
    },
    /** A new stop's id, drawn once it was placed; not over one typed. */
    presetNewStopId: (state, action: PayloadAction<string>) => {
      const draft = state.edit.draft;
      if (draft?.kind === "stop-new" && draft.stop_id === null) draft.stop_id = action.payload;
    },
    setEditSnap: (state, action: PayloadAction<boolean>) => {
      state.edit.snap = action.payload;
    },
    /** A change applied: it joins the list, and what was undone and its draft
     * are gone. */
    editApplied: (state, action: PayloadAction<ChangeSummary>) => {
      state.edit.changes.push(action.payload);
      state.edit.redo = [];
      state.edit.draft = null;
    },
    /** Saved into the bundle: the changes are its own now, with no undo. */
    editsSaved: (state) => {
      state.edit.changes = [];
      state.edit.redo = [];
    },
    /** Every change undone and forgotten, with the draft. */
    editsDiscarded: (state) => {
      state.edit.changes = [];
      state.edit.redo = [];
      state.edit.draft = null;
    },
    editUndone: (state) => {
      const last = state.edit.changes.pop();
      if (last) state.edit.redo.push(last);
    },
    editRedone: (state) => {
      const next = state.edit.redo.pop();
      if (next) state.edit.changes.push(next);
    },
    setChangeListOpen: (state, action: PayloadAction<boolean>) => {
      state.edit.listOpen = action.payload;
    },
    setServiceDialog: (state, action: PayloadAction<ExplorerEdit["service"]>) => {
      state.edit.service = action.payload;
    },
    setEditDialog: (state, action: PayloadAction<ExplorerEdit["dialog"]>) => {
      state.edit.dialog = action.payload;
    },
    /** Into "Edit stops" or "Edit path" on a line, or out of it: in it,
     * Select, and no draft but the mode's own. The map stays where it is. */
    setEditMode: (state, action: PayloadAction<ExplorerEdit["mode"]>) => {
      state.edit.mode = action.payload;
      state.edit.tool = "select";
      state.edit.draft = null;
      state.path = null;
      state.lineMenu = null;
    },
    /** Leaving with changes: the dialog asks what to do with them. */
    askToLeave: (state) => {
      state.edit.exit = "asking";
      state.edit.listOpen = false;
    },
    setExitState: (state, action: PayloadAction<ExplorerEdit["exit"]>) => {
      state.edit.exit = action.payload;
      if (action.payload === null) state.edit.saveProblem = null;
    },
    /** A save that did not go through: the dialog asks again, saying why. */
    saveFailed: (state, action: PayloadAction<string>) => {
      state.edit.exit = "asking";
      state.edit.saveProblem = action.payload;
    },
  },
  extraReducers: (builder) => {
    // The Explorer lives in the data view; leaving it ends the session.
    builder.addCase(setMapMode, (state, action) =>
      action.payload === "data"
        ? state
        : {
            ...initialState,
            leftTab: state.leftTab,
            edit: freshEdit(state.edit),
            restoreGroupId: state.hiddenGroupId,
          }
    );
  },
});

export const {
  openExplorer,
  closeExplorer,
  clearRestoreGroup,
  setExplorerLeftTab,
  selectExplorerRoute,
  setExplorerDate,
  setExplorerDrawing,
  setExplorerFilters,
  openExplorerPanel,
  explorerPanelBack,
  closeExplorerPanel,
  setStripCollapsed,
  setStripView,
  setStripHeight,
  setExplorerRouteTab,
  setExplorerTripTab,
  setExplorerStopTab,
  pickExplorerPattern,
  openExplorerSettings,
  setExplorerBounds,
  setPlaying,
  setPlaybackSpeed,
  setPlaybackTime,
  setScrub,
  focusExplorerRun,
  selectExplorerRouteAt,
  setEditTool,
  setEditSnap,
  setEditDraft,
  openExplorerLineMenu,
  closeExplorerLineMenu,
  setEditEnabled,
  placeStop,
  presetNewStopId,
  editApplied,
  editsSaved,
  editsDiscarded,
  editUndone,
  editRedone,
  setChangeListOpen,
  setServiceDialog,
  setEditDialog,
  setEditMode,
  askToLeave,
  setExitState,
  saveFailed,
  setExplorerPath,
  clearExplorerSelection,
} = explorerSlice.actions;

export const explorerReducer = explorerSlice.reducer;

/** The item the right panel shows, if any. */
export function panelItem(state: ExplorerState): ExplorerPanelItem | null {
  return state.panel.stack[state.panel.stack.length - 1] ?? null;
}

/** Whether the right panel is open: an item in it, or a stop being placed
 * or added to a line (its draft fills the panel, board 18). */
export function rightPanelOpen(state: ExplorerState): boolean {
  const kind = state.edit.draft?.kind;
  return (
    state.active &&
    (state.panel.stack.length > 0 ||
      kind === "stop-new" ||
      kind === "line-stop-add" ||
      kind === "line-reroute" ||
      kind === "line-delete" ||
      kind === "line-extend" ||
      kind === "route-details" ||
      kind === "line-new" ||
      kind === "line-headway" ||
      kind === "line-span" ||
      kind === "line-speed")
  );
}

/** The stop the right panel shows, highlighted on the map. */
export function pickedStop(state: ExplorerState): ExplorerPickedStop | null {
  const item = panelItem(state);
  return item?.kind === "stop" ? item.stop : null;
}

/** Changes made and not saved: leaving asks first. */
export function hasUnsavedEdits(state: ExplorerState): boolean {
  return state.active && state.edit.changes.length > 0;
}
