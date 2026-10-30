/**
 * A bundle's Explorer database: built on the server if need be, downloaded,
 * and loaded into DuckDB-WASM. One per bundle while the Explorer is open,
 * released when it closes.
 */
import { useCallback, useEffect, useState } from "react";

import type { ExplorerDb } from "@/lib/explorer/db/ExplorerDb";
import type { SnapshotManifest } from "@/lib/explorer/db/types";
import { type ExplorerFailure, explain } from "@/lib/explorer/errors";
import { FIRST_TABLES, type LoadProgress, loadSnapshot, waitForManifest } from "@/lib/explorer/snapshot";

export type ExplorerDbState =
  /** Waiting for the snapshot; `building` once the server says it is making it. */
  | { status: "preparing"; building: boolean }
  | { status: "loading"; progress: LoadProgress; db: ExplorerDb; manifest: SnapshotManifest }
  | { status: "ready"; db: ExplorerDb; manifest: SnapshotManifest }
  | { status: "error"; error: ExplorerFailure };

/** Whether the tables a view needs are loaded. */
export function hasTables(state: ExplorerDbState, tables: string[]): boolean {
  if (state.status === "ready") return true;
  if (state.status !== "loading") return false;
  return tables.every((t) => state.progress.loaded.includes(t));
}

export function useExplorerDb(bundleId: string | undefined): { state: ExplorerDbState; retry: () => void } {
  const [state, setState] = useState<ExplorerDbState>({ status: "preparing", building: false });
  // Bumped by `retry`: a failed open starts over from the manifest.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!bundleId) return;
    const abort = new AbortController();
    let db: ExplorerDb | undefined;
    setState({ status: "preparing", building: false });

    (async () => {
      const manifest = await waitForManifest(
        bundleId,
        () => {
          if (!abort.signal.aborted) setState({ status: "preparing", building: true });
        },
        abort.signal,
        attempt > 0
      );
      const { ExplorerDb } = await import("@/lib/explorer/db/ExplorerDb");
      // A cancelled effect (an unmount, React's double mount in development)
      // must not start a worker, nor leave one running that it started.
      if (abort.signal.aborted) return;
      const opened = await ExplorerDb.open();
      if (abort.signal.aborted) {
        await opened.close();
        return;
      }
      db = opened;
      await loadSnapshot(
        opened,
        manifest,
        (progress) => {
          if (!abort.signal.aborted) setState({ status: "loading", progress, db: opened, manifest });
        },
        abort.signal
      );
      if (!abort.signal.aborted) setState({ status: "ready", db: opened, manifest });
    })().catch((error: unknown) => {
      if (abort.signal.aborted) return;
      setState({ status: "error", error: explain(error) });
    });

    return () => {
      abort.abort();
      void db?.close();
    };
  }, [bundleId, attempt]);

  return { state, retry };
}

export { FIRST_TABLES };
