/**
 * Whether this browser has memory to spare for playback: a nice-to-have that
 * must never starve what the Explorer needs — its database, which holds the
 * whole network, and the page. Playback starts only with room left on both,
 * and stops if either fills up while it runs.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";

/** Shares of each limit beyond which playback is not started or kept going:
 * the rest stays for queries (a route's figures, the calendar) and the map. */
export const DB_SHARE = 0.6;
export const HEAP_SHARE = 0.7;
/** Below this much device memory (GB, as the browser rounds it) playback is
 * not offered at all. */
export const MIN_DEVICE_GB = 4;

export type MemoryVerdict =
  | { ok: true }
  | { ok: false; reason: "device" | "database" | "page"; used: number; limit: number };

interface Measures {
  dbUsed: number | null;
  dbLimit: number | null;
  heapUsed: number | null;
  heapLimit: number | null;
  deviceGb: number | null;
}

/** The verdict on measures; pure, so it is tested directly. */
export function judge(m: Measures): MemoryVerdict {
  if (m.deviceGb !== null && m.deviceGb < MIN_DEVICE_GB)
    return { ok: false, reason: "device", used: m.deviceGb, limit: MIN_DEVICE_GB };
  if (m.dbUsed !== null && m.dbLimit && m.dbUsed > DB_SHARE * m.dbLimit)
    return { ok: false, reason: "database", used: m.dbUsed, limit: m.dbLimit };
  if (m.heapUsed !== null && m.heapLimit && m.heapUsed > HEAP_SHARE * m.heapLimit)
    return { ok: false, reason: "page", used: m.heapUsed, limit: m.heapLimit };
  return { ok: true };
}

/** `2560MB`, `2.5 GiB`, `1.0 GB` as bytes. */
export function parseBytes(text: string): number | null {
  const m = /^\s*([\d.]+)\s*([KMGT]?)(i?)B\s*$/i.exec(text);
  if (!m) return null;
  const base = m[3] ? 1024 : 1000;
  const power = { "": 0, K: 1, M: 2, G: 3, T: 4 }[m[2].toUpperCase() as "" | "K" | "M" | "G" | "T"];
  return Number(m[1]) * base ** power;
}

/** Measure what this browser and the database report, and judge it. Where a
 * browser reports nothing (the page heap outside Chromium), that measure is
 * left out rather than guessed. */
export async function checkMemory(db: SqlRunner): Promise<MemoryVerdict> {
  let dbUsed: number | null = null;
  let dbLimit: number | null = null;
  try {
    const [row] = await db.all<{ used: number | bigint | null; limit: string }>(`
      SELECT (SELECT sum(memory_usage_bytes) FROM duckdb_memory()) AS used,
             current_setting('memory_limit') AS limit`);
    dbUsed = row?.used === null || row?.used === undefined ? null : Number(row.used);
    dbLimit = row ? parseBytes(row.limit) : null;
  } catch {
    // An engine without duckdb_memory(): judged on the page alone.
  }
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  const deviceGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null;
  return judge({
    dbUsed,
    dbLimit,
    heapUsed: heap?.usedJSHeapSize ?? null,
    heapLimit: heap?.jsHeapSizeLimit ?? null,
    deviceGb,
  });
}
