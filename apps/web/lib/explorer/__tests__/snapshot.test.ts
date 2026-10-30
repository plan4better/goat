import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExplorerDb } from "@/lib/explorer/db/ExplorerDb";
import type { SnapshotManifest } from "@/lib/explorer/db/types";
import { loadSnapshot } from "@/lib/explorer/snapshot";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: request }));

const manifest = (bytes: number): SnapshotManifest => ({
  status: "ready",
  schema_version: 1,
  layers_revision: 1,
  files: [{ name: "stops", rows: 1, bytes, url: "/stops.parquet" }],
  warnings: {},
  shape_dist_unit: null,
  service_window: [null, null],
});
const db = { loadParquet: vi.fn(async () => undefined) } as unknown as ExplorerDb;

/** A response that sends `chunks`, then, unless `end`, nothing more until
 * aborted. Only what `loadSnapshot` reads of a response, not a real stream:
 * vitest's vmForks pool (CI) gives the jsdom environment no ReadableStream. */
function respond(chunks: Uint8Array[], end: boolean) {
  request.mockImplementation(async (_url: string, { signal }: { signal: AbortSignal }) => {
    let i = 0;
    const read = (): Promise<{ done: boolean; value?: Uint8Array }> => {
      if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] });
      if (end) return Promise.resolve({ done: true });
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      );
    };
    return { ok: true, status: 200, statusText: "OK", body: { getReader: () => ({ read }) } };
  });
}

afterEach(() => {
  vi.useRealTimers();
  request.mockReset();
});

describe("loading a snapshot", () => {
  it("gives up a download that stops sending, as unreachable", async () => {
    vi.useFakeTimers();
    respond([new Uint8Array(10)], false);
    const load = loadSnapshot(db, manifest(20), () => undefined);
    const failed = expect(load).rejects.toMatchObject({ kind: "unreachable" });
    await vi.advanceTimersByTimeAsync(31_000);
    await failed;
  });

  it("reports progress a few times a second, and every table as it loads", async () => {
    respond(
      Array.from({ length: 50 }, () => new Uint8Array(10)),
      true
    );
    const reports: number[] = [];
    await loadSnapshot(db, manifest(500), (p) => reports.push(p.loaded.length));
    // Fifty chunks arrive at once: far fewer reports than chunks, the last
    // one with the table loaded.
    expect(reports.length).toBeLessThan(5);
    expect(reports[reports.length - 1]).toBe(1);
  });
});
