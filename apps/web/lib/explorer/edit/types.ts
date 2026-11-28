/**
 * The Explorer's edits: what a change is, in the browser and on the server.
 *
 * A change applies twice, in two forms. In the browser it changes the
 * snapshot's tables (indexed: `trip_idx`, `stop_idx`), so every panel shows
 * it at once. On save it is sent as rows of the bundle's GTFS tables, keyed by
 * GTFS ids — the snapshot's indexes mean nothing outside one build — and
 * geoapi writes those (`POST /bundles/{id}/changes`, goatlib's
 * `bundles/explorer/changeset.py`).
 */

/** The bundle tables a change may write (goatlib `ROLE_KEYS`). */
export type GtfsRole =
  | "agency"
  | "stops"
  | "routes"
  | "trips"
  | "stop_times"
  | "calendar"
  | "calendar_dates"
  | "frequencies"
  | "shapes";

/** A value as GTFS writes it: a time `25:10:00`, a date `20261012`. */
export type GtfsValue = string | number | null;

/** One row of a bundle table written: inserted whole, updated in the columns
 * given, or deleted; `key` is its GTFS primary key. */
export interface GtfsRowEdit {
  role: GtfsRole;
  op: "insert" | "update" | "delete";
  key: Record<string, GtfsValue>;
  values?: Record<string, GtfsValue>;
  /** An insert copying a row of the same table, by its key: the columns
   * `values` leaves out are the copied row's, as the bundle has them (a trip
   * copied keeps the fields the snapshot does not hold). */
  copy_of?: Record<string, GtfsValue>;
}

/** A stretch of a shape drawn anew: from and to as shares of its length
 * (null: its start or end), straight through `points`. */
export interface ShapeStretch {
  from: number | null;
  to: number | null;
  /** Where the stop it is drawn through was on it, as a share. */
  at: number | null;
  points: [number, number][];
  /** The point the stop lies at, where the stretch follows a road (Snap);
   * absent: the first. */
  stop_point?: number;
}

/** A shape redrawn through a moved stop (2.2): `source`'s points, at their
 * full resolution on the server, with each stretch replaced; written as
 * `key.shape_id` (the same shape, or a copy for some of its trips). The
 * feed's distances along it follow, `through` at its new place. */
export interface GtfsShapeReshape {
  role: "shapes";
  op: "reshape";
  key: { shape_id: string };
  source: string;
  /** The stop drawn through; none for a path rerouted between two (1.2). */
  through?: string;
  /** Metres per `shape_dist_traveled` unit, where the Explorer knows it. */
  metres_per_unit?: number;
  stretches: ShapeStretch[];
  /** The trips whose distances follow, as they were on it when redrawn: a
   * later edit may move some onto a copy before the save. */
  trips?: string[];
}

/** Room made in a trip for a stop added to it (3.1): its stop times past
 * `after` numbered one on. Rows named before it are named as they were then,
 * those after it as they are after it. */
export interface GtfsStopTimesShift {
  role: "stop_times";
  op: "shift";
  key: { trip_id: string };
  after: number;
}

export type GtfsRowOp = GtfsRowEdit | GtfsShapeReshape | GtfsStopTimesShift;

/** Rows of one snapshot table a change may alter, by a condition that
 * selects them before and after it: undo puts back exactly these rows. */
export interface Touch {
  table: string;
  where: string;
}

/** What the user reads of a change: in the change list, the exit dialog. */
export interface ChangeSummary {
  id: string;
  /** Which edit (`stop_rename`, `headway`, …): the list's icon. */
  kind: string;
  label: string;
  /** "+5 trips a weekday · +3 peak vehicles". */
  impact?: string;
  /** The change in annual operating cost, ≈, in the settings' currency. */
  cost?: number;
}

/** One change, ready to apply. */
export interface EditChange extends ChangeSummary {
  /** The snapshot rows it alters, and the statements that alter them. */
  touches: Touch[];
  sql: string[];
  /** The same change as bundle rows, for the save. */
  gtfs: GtfsRowOp[];
  /** Paths it redraws (shape_idx): the map draws them from the snapshot
   * until a save brings the bundle's lines in step. */
  shapes?: number[];
  /** Paths it takes out of the snapshot (shape_id), no trip running them
   * any more: the map leaves their tiles out until a save. */
  dropped?: string[];
}
