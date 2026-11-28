/**
 * Edits being made: drafts, outside the snapshot until Apply (spec 01,
 * "Drafts sit outside the bundle"). One at a time, in Redux, so the panel
 * that fills it in and the Apply bar that applies it read the same thing;
 * Cancel, Esc or picking something else lets it go with no trace.
 */
import type { LineEnd } from "@/lib/explorer/edit/ops/extendLine";
import type { DayTypeGroup, HeadwayPeriod } from "@/lib/explorer/edit/ops/headway";
import type { CutEnd, LineScope } from "@/lib/explorer/edit/ops/lineStops";
import type { RouteValues } from "@/lib/explorer/edit/ops/routes";
import type { ServiceSpan } from "@/lib/explorer/edit/ops/span";
import type { StopTimeInput } from "@/lib/explorer/edit/ops/trips";

/** What a service edit (4.1, 4.2, 5.2) is made on, as the service dialog
 * picks it: one direction's patterns, on the service patterns picked
 * (`groups`, whole: patterns sharing a service go together), seen on
 * `date`. `direction` and `group_names` name them for the Apply bar. */
export interface ServiceTarget {
  route_idx: number;
  direction: { key: number; name: string };
  patterns: number[];
  groups: DayTypeGroup[];
  group_names: string[];
  date: string;
}

/** GTFS wheelchair_boarding: 0 unknown (or as its station), 1 accessible,
 * 2 not. */
export type Wheelchair = 0 | 1 | 2;

/** GTFS location_type: 0 stop or platform, 1 station, 2 entrance or exit,
 * 3 generic node, 4 boarding area. The Explorer makes the first three, each
 * keeping its type once made; a feed's nodes and boarding areas are shown,
 * not edited. */
export type LocationType = 0 | 1 | 2 | 3 | 4;
export const EDITABLE_LOCATION_TYPES = [0, 1, 2] as const;

/** A stop's own GTFS fields, as Properties edits them; text as typed, an
 * empty one none. */
export interface StopValues {
  name: string;
  wheelchair: Wheelchair;
  location_type: LocationType;
  /** The station (or, for a boarding area, platform) it belongs to. */
  parent_idx: number | null;
  platform_code: string;
}

export const NO_STOP_VALUES: StopValues = {
  name: "",
  wheelchair: 0,
  location_type: 0,
  parent_idx: null,
  platform_code: "",
};

/** A new line's fields, as its panel has them; text as typed. */
export interface NewLineValues {
  short_name: string;
  long_name: string;
  route_type: number;
  agency_idx: number;
  color: string;
  service_idx: number | null;
  /** First and last departure, "HH:MM" (past 24:00 for after midnight). */
  first: string;
  last: string;
  /** Minutes between departures, and from the first stop to the last. */
  headway: string;
  running: string;
}

export const NO_LINE_VALUES: NewLineValues = {
  short_name: "",
  long_name: "",
  route_type: 3,
  agency_idx: 0,
  color: "",
  service_idx: null,
  first: "",
  last: "",
  headway: "",
  running: "",
};

export type EditDraft =
  /** 2.4: a stop's details, as the Details tab has them. */
  | { kind: "stop-details"; stop_idx: number; values: StopValues }
  /** 2.1: a stop placed with the Stop tool, where it was clicked. */
  /** Its id null until one is drawn for it. */
  | {
      kind: "stop-new";
      lon: number;
      lat: number;
      stop_id: string | null;
      values: StopValues;
      /** Placed on a line in "Edit stops": once created, added to
       * it between `a` and `b` (the insert's own Apply next). */
      onLine?: { a: number; b: number; scope: LineScope };
    }
  /** 2.3: a stop deleted, with all that calls there. */
  | { kind: "stop-delete"; stop_idx: number }
  /** 2.2: a stop dragged to a new place, its paths with it. */
  | { kind: "stop-move"; stop_idx: number; lon: number; lat: number }
  /** 3.2: a stop taken off a line, for the trips its scope takes. */
  | { kind: "line-stop-remove"; stop_idx: number; scope: LineScope }
  /** 1.4: the line cut back at a stop, for the trips its scope takes:
   * ending there, or starting there. */
  | { kind: "line-cut"; stop_idx: number; end: CutEnd; scope: LineScope }
  /** 3.1: a stop added to a line between `a` and `b`, for the trips its
   * scope takes; picked on the map (null until then). */
  | { kind: "line-stop-add"; a: number; b: number; stop_idx: number | null; scope: LineScope }
  /** 1.2: the path from `a` to `b` (stops called back to back, drawn from
   * `ends`) dragged through `via`, for the trips its scope takes. */
  | {
      kind: "line-reroute";
      a: number;
      b: number;
      ends: [[number, number], [number, number]];
      via: [number, number][];
      scope: LineScope;
    }
  /** 1.5: a line deleted, with the stops no other line serves if `stops`. */
  | { kind: "line-delete"; route_idx: number; stops: boolean }
  /** 1.1: a line drawn through `stops`, picked on the map in order. */
  | { kind: "line-new"; stops: number[]; values: NewLineValues }
  /** A line's own fields, as its Properties tab has them. */
  | { kind: "route-details"; route_idx: number; values: RouteValues }
  /** 1.3: the line run on past its terminus `stop_idx` (at its `end`)
   * through `adds`, outward, for the trips its scope takes. */
  | { kind: "line-extend"; stop_idx: number; end: LineEnd; adds: number[]; scope: LineScope }
  /** 4.1: one direction's headways by time period. */
  | ({ kind: "line-headway"; periods: HeadwayPeriod[] } & ServiceTarget)
  /** 4.2: its first and last departure (null: as it is). */
  | ({ kind: "line-span"; span: ServiceSpan } & ServiceTarget)
  /** 5.2: its running times faster or slower by `percent`, all day or in
   * one period. */
  | ({
      kind: "line-speed";
      percent: number;
      period: { key: string; start_s: number; end_s: number } | null;
    } & ServiceTarget)
  /** 4.4: trips moved earlier or later by `by_s`. */
  | { kind: "trip-shift"; trip_idxs: number[]; by_s: number }
  /** 4.3: a copy of a trip leaving at `dep_s`. */
  | { kind: "trip-duplicate"; trip_idx: number; dep_s: number }
  /** 4.3: trips deleted. */
  | { kind: "trip-delete"; trip_idxs: number[] }
  /** 5.1: a trip's times as typed, the stops after the last typed one moved
   * with it if `follow`. */
  | { kind: "trip-times"; trip_idx: number; times: StopTimeInput[]; follow: boolean };

/** The service dialog's edits: on a direction, for groups of day types. */
export type ServiceDraft = Extract<EditDraft, { kind: "line-headway" | "line-span" | "line-speed" }>;
export function isServiceDraft(d: EditDraft | null | undefined): d is ServiceDraft {
  return d?.kind === "line-headway" || d?.kind === "line-span" || d?.kind === "line-speed";
}
