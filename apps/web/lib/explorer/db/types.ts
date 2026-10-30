/**
 * What the Explorer's derivations need of a database: run SQL, get rows.
 *
 * The browser runs DuckDB-WASM in a worker (`ExplorerDb`); tests run the
 * same engine's blocking Node build over the committed fixture snapshot. Both
 * are the DuckDB release the server builds snapshots with, so a query means
 * the same thing everywhere.
 */
export interface SqlRunner {
  /** Rows of a query, as plain objects. BIGINTs arrive as numbers. */
  all<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  /** A query's numeric columns as arrays, without an object per row: for
   * results too large to read row by row (playback's windows). A NULL reads
   * as 0, so the query states what stands in for one. */
  columns<K extends string>(sql: string): Promise<Record<K, ArrayLike<number>>>;
  /** A statement whose result is not needed. */
  exec(sql: string): Promise<void>;
}

/** One snapshot file, as the manifest lists it. */
export interface SnapshotFile {
  name: string;
  rows: number;
  bytes: number;
  url: string;
}

/** `GET /bundles/{id}/explorer` once the snapshot is ready. */
export interface SnapshotManifest {
  status: "ready";
  schema_version: number;
  layers_revision: number;
  files: SnapshotFile[];
  warnings: Record<string, number>;
  shape_dist_unit: string | null;
  /** The member whose features are the shapes as lines: `shape_lines`, an
   * older import's `shapes`, or none. */
  shape_lines_role?: string | null;
  service_window: [string | null, string | null];
}

/** The answer while the snapshot is being built, or after it failed. */
export interface SnapshotPending {
  status: "building" | "failed";
  layers_revision: number;
  detail?: string;
}
