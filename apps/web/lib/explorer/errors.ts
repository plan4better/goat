/**
 * Why the Explorer could not open a network, sorted into the few cases a
 * planner can act on. The technical text is kept for the details.
 */

export type ExplorerErrorKind =
  /** Not a public transport bundle, or gone. */
  | "not_found"
  | "forbidden"
  /** The feed lacks a part the snapshot needs (stop times, a calendar, …). */
  | "incomplete"
  /** DuckDB-WASM ran out of memory loading the network. */
  | "memory_browser"
  /** The server ran out of memory preparing it. */
  | "memory_server"
  /** The server or the connection to it failed. */
  | "unreachable"
  | "other";

export interface ExplorerFailure {
  kind: ExplorerErrorKind;
  detail: string;
}

/** Whether trying again can help: not for what only a person can change. */
export function retryable(kind: ExplorerErrorKind): boolean {
  return kind !== "not_found" && kind !== "forbidden" && kind !== "incomplete";
}

export class ExplorerLoadError extends Error {
  constructor(
    readonly kind: ExplorerErrorKind,
    message: string
  ) {
    super(message);
    this.name = "ExplorerLoadError";
  }
}

const OUT_OF_MEMORY = /out of memory|failed to allocate|memory limit/i;
/** goatlib's snapshot refusals: "The bundle has no stop_times layer", … */
const INCOMPLETE = /has no \w+ layer|neither a calendar nor calendar_dates/i;

/** How an HTTP status the Explorer's requests get reads to a planner. */
export function kindOfStatus(status: number): ExplorerErrorKind {
  if (status === 404) return "not_found";
  if (status === 403) return "forbidden";
  if (status === 502 || status === 503 || status === 504) return "unreachable";
  return "other";
}

/** How the server's reason for a failed build reads to a planner. */
export function kindOfBuildFailure(detail: string): ExplorerErrorKind {
  if (OUT_OF_MEMORY.test(detail)) return "memory_server";
  if (INCOMPLETE.test(detail)) return "incomplete";
  return "other";
}

export function explain(error: unknown): ExplorerFailure {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof ExplorerLoadError) return { kind: error.kind, detail };
  // fetch's own failures: offline, refused, cut off.
  if (error instanceof TypeError && /fetch|network|load failed/i.test(detail)) {
    return { kind: "unreachable", detail };
  }
  // Anything else thrown while loading is the browser's database.
  if (OUT_OF_MEMORY.test(detail)) return { kind: "memory_browser", detail };
  return { kind: "other", detail };
}
