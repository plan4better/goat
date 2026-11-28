/**
 * Saving an editing session to its bundle (`POST /bundles/{id}/changes`,
 * geoapi's `routers/pt_edits.py`): the changes as bundle rows, with the
 * revision the session started from. All of it is written or none.
 */
import { apiRequestAuth } from "@/lib/api/fetcher";
import { GEOAPI_BASE_URL } from "@/lib/constants";
import type { GtfsRowOp, GtfsValue } from "@/lib/explorer/edit/types";

/** A finding the server reports, as the MobilityData validator names it. */
export interface SaveNotice {
  code: string;
  severity: "ERROR" | "WARNING" | "INFO";
  role: string;
  key: Record<string, GtfsValue>;
  field: string | null;
}

export interface SaveResult {
  revision: number;
  rows: Record<string, { inserted: number; updated: number; deleted: number }>;
  warnings: SaveNotice[];
  rebuild_job_id: string | null;
}

/** Somebody saved the bundle while this session was open. */
export class SaveConflictError extends Error {
  constructor(
    message: string,
    readonly revision: number | null
  ) {
    super(message);
  }
}

/** The server found the changes would leave the bundle invalid: a bug in
 * an edit's cascade, since the session checks before Apply. */
export class SaveRefusedError extends Error {
  constructor(
    message: string,
    readonly notices: SaveNotice[]
  ) {
    super(message);
  }
}

/** The save ran out of time and was stopped and undone: nothing saved. */
export class SaveTimeoutError extends Error {}

export async function saveExplorerChanges(
  bundleId: string,
  baseRevision: number,
  ops: GtfsRowOp[]
): Promise<SaveResult> {
  const res = await apiRequestAuth(`${GEOAPI_BASE_URL}/bundles/${bundleId}/changes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_revision: baseRevision, changes: { ops } }),
  });
  if (res.ok) return (await res.json()) as SaveResult;
  const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
  const detail = body.detail as { message?: string; revision?: number; notices?: SaveNotice[] } | string;
  const message =
    typeof detail === "string" ? detail : (detail?.message ?? `${res.status} ${res.statusText}`);
  if (res.status === 409 && typeof detail === "object")
    throw new SaveConflictError(message, detail.revision ?? null);
  if (res.status === 422 && typeof detail === "object" && detail.notices)
    throw new SaveRefusedError(message, detail.notices);
  // geoapi's own: it stopped the save and undid it. A proxy's 504 (no
  // detail of geoapi's) says nothing of whether the save went through.
  if (res.status === 504 && typeof detail === "string") throw new SaveTimeoutError(message);
  throw new Error(message);
}
