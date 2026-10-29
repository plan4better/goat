/**
 * What a route runs on a day: headways per time period and direction, first
 * and last trip, vehicle-km, vehicle-hours, peak vehicles and the
 * vehicles-in-service curve (docs/pt-network-editor/docs/05-viewers-and-cost.md).
 *
 * Computed from a day's runs (`routeRuns`), so a frequency-based trip counts
 * every time it runs.
 */
import type { Run } from "@/lib/explorer/derive/runs";
import { DEFAULT_SETTINGS, type Period } from "@/lib/explorer/settings";

export interface Headway {
  /** Median minutes between departures; null with fewer than two. */
  minutes: number | null;
  departures: number;
}

export interface Operations {
  runs: number;
  first_dep_s: number | null;
  last_dep_s: number | null;
  vehicle_km: number;
  vehicle_hours: number;
  peak_vehicles: number;
  /** When the peak is first reached. */
  peak_at_s: number | null;
  /** Whether peak vehicles came from block_id (else trips plus layover). */
  peak_from_blocks: boolean;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Headway in each period, for the runs of one direction. */
export function headways(runs: Run[], periods: Period[] = DEFAULT_SETTINGS.periods): Map<string, Headway> {
  const out = new Map<string, Headway>();
  for (const p of periods) {
    const deps = runs
      .map((r) => r.dep_s)
      .filter((d) => d >= p.start_s && d < p.end_s)
      .sort((a, b) => a - b);
    const gaps = deps.slice(1).map((d, i) => d - deps[i]);
    out.set(p.key, {
      minutes: gaps.length ? Math.round(median(gaps) / 60) : null,
      departures: deps.length,
    });
  }
  return out;
}

/** End-to-end running time in each period: the median minutes of the runs
 * leaving in it on the pattern most of them use — a short turn or branch does
 * not shorten the main line's time, yet a period served only by a branch
 * still has one. Null where nothing leaves. */
export function runningTimes(
  runs: Run[],
  periods: Period[] = DEFAULT_SETTINGS.periods
): Map<string, number | null> {
  return new Map(
    periods.map((p) => {
      const inPeriod = runs.filter((r) => r.dep_s >= p.start_s && r.dep_s < p.end_s);
      const byPattern = new Map<number, number[]>();
      for (const r of inPeriod)
        byPattern.set(r.pattern_idx, [...(byPattern.get(r.pattern_idx) ?? []), r.arr_s - r.dep_s]);
      const busiest = [...byPattern.values()].sort((a, b) => b.length - a.length)[0];
      return [p.key, busiest ? Math.round(median(busiest) / 60) : null];
    })
  );
}

/** The intervals during which vehicles are tied up: one per block where every
 * run has a block, else one per run with its layover after it. */
function vehicleIntervals(
  runs: Run[],
  layover_s: number
): { intervals: [number, number][]; fromBlocks: boolean } {
  const fromBlocks = runs.length > 0 && runs.every((r) => r.block_idx !== null);
  if (!fromBlocks) return { intervals: runs.map((r) => [r.dep_s, r.arr_s + layover_s]), fromBlocks };
  const blocks = new Map<number, [number, number]>();
  for (const r of runs) {
    const b = blocks.get(r.block_idx as number);
    blocks.set(
      r.block_idx as number,
      b ? [Math.min(b[0], r.dep_s), Math.max(b[1], r.arr_s)] : [r.dep_s, r.arr_s]
    );
  }
  return { intervals: [...blocks.values()], fromBlocks };
}

/** Most intervals overlapping at once, and when that is first reached. */
function peak(intervals: [number, number][]): { n: number; at: number | null } {
  // Ends sort before starts at the same moment: a vehicle arriving at 08:10
  // can take the 08:10.
  const events = intervals
    .flatMap(([a, b]) => [
      [a, 1],
      [b, -1],
    ])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let n = 0;
  let best = 0;
  let at: number | null = null;
  for (const [t, d] of events) {
    n += d;
    if (n > best) {
      best = n;
      at = t;
    }
  }
  return { n: best, at };
}

/** `layover_s`: how long a run keeps its vehicle after arriving, where no
 * `block_id` says which trips one vehicle runs. */
export function operations(runs: Run[], layover_s = DEFAULT_SETTINGS.layover_s): Operations {
  const { intervals, fromBlocks } = vehicleIntervals(runs, layover_s);
  const p = peak(intervals);
  const deps = runs.map((r) => r.dep_s);
  return {
    runs: runs.length,
    first_dep_s: deps.length ? Math.min(...deps) : null,
    last_dep_s: deps.length ? Math.max(...deps) : null,
    vehicle_km: runs.reduce((s, r) => s + r.length_m, 0) / 1000,
    vehicle_hours: runs.reduce((s, r) => s + (r.arr_s - r.dep_s), 0) / 3600,
    peak_vehicles: p.n,
    peak_at_s: p.at,
    peak_from_blocks: fromBlocks,
  };
}

/** Vehicles in service (between departure and arrival) at each `step_s`
 * from 0 until the last arrival, so service past midnight is included. */
export function vehiclesInService(runs: Run[], step_s = 300): number[] {
  if (!runs.length) return [];
  const end = Math.max(...runs.map((r) => r.arr_s));
  const counts: number[] = [];
  for (let t = 0; t <= end; t += step_s) {
    counts.push(runs.filter((r) => r.dep_s <= t && t < r.arr_s).length);
  }
  return counts;
}
