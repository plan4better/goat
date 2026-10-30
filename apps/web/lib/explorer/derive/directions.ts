/**
 * A route's directions and their variants, named by destination
 * (docs/pt-network-editor/docs/04-direction-handling.md).
 *
 * 1. A pattern is the trips with one ordered list of stops (`patterns`).
 * 2. Patterns are grouped into directions: by `direction_id` when every trip
 *    of the route has one, otherwise by comparing stop orders — patterns that
 *    visit their shared stops in the same order go the same way.
 * 3. A direction's main pattern is the one with the most trips; the others
 *    are variants: a short turn runs a stretch of it, an express skips some of
 *    its stops, a branch leaves it.
 * 4. A direction is named by the headsign most of its trips share, else its
 *    last stop; a loop (ending where it starts) by its stop farthest from the
 *    start. A variant ending elsewhere than the main pattern is named by its
 *    own last stop, whatever its trips' headsign says. Never inbound/outbound or 0/1. The name is data — kind, place,
 *    and a stop to tell two same-named directions apart; the UI words it in
 *    the reader's language (`directionLabel`).
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import type { TripRange } from "@/lib/explorer/derive/runs";

export type VariantKind = "main" | "short_turn" | "express" | "branch";

export interface PatternInfo {
  pattern_idx: number;
  stops: number[];
  n_trips: number;
}

export interface DirectionPattern {
  pattern_idx: number;
  kind: VariantKind;
  /** Where its trips go: "Third" for "To Third". */
  destination: string;
  n_trips: number;
}

/** How a direction is named, for the UI to word: "to" a place, or a "loop"
 * via one; `via` tells apart two directions that would share a name. */
export interface DirectionName {
  kind: "to" | "loop";
  place: string;
  via: string | null;
}

export interface Direction {
  /** Stable within the route: the main pattern's index. */
  key: number;
  name: DirectionName;
  /** The feed's direction_id for these trips, when it gives one. */
  direction_id: number | null;
  patterns: DirectionPattern[];
  n_trips: number;
  /** The main pattern's first and last stop, as riders know them (the
   * station's name). */
  ends: [string, string];
}

export interface StopInfo {
  stop_idx: number;
  name: string | null;
  lat: number | null;
  lon: number | null;
  /** The parent station's name, which riders know the stop by. */
  station: string | null;
}

/** Trips of one pattern with one direction_id and headsign. */
export interface PatternTrips {
  pattern_idx: number;
  direction_id: number | null;
  headsign: string | null;
  n: number;
}

const SAME_WAY = 0.5;

function isContiguousSub(main: number[], part: number[]): boolean {
  if (part.length > main.length) return false;
  outer: for (let i = 0; i + part.length <= main.length; i++) {
    for (let j = 0; j < part.length; j++) if (main[i + j] !== part[j]) continue outer;
    return true;
  }
  return false;
}

function isSubsequence(main: number[], part: number[]): boolean {
  let i = 0;
  for (const s of main) if (i < part.length && s === part[i]) i++;
  return i === part.length;
}

/** +1 when `b` visits the stops it shares with `a` in a's order, -1 in
 * reverse, between when mixed; null when they share too few to tell. */
export function orderAgreement(a: number[], b: number[]): number | null {
  const posA = new Map<number, number>();
  a.forEach((s, i) => {
    if (!posA.has(s)) posA.set(s, i);
  });
  const shared = b.filter((s) => posA.has(s));
  const needed = Math.max(2, Math.ceil(0.3 * Math.min(a.length, b.length)));
  if (new Set(shared).size < needed) return null;
  let same = 0;
  let reverse = 0;
  for (let i = 1; i < shared.length; i++) {
    const d = (posA.get(shared[i]) as number) - (posA.get(shared[i - 1]) as number);
    if (d > 0) same++;
    else if (d < 0) reverse++;
  }
  return same + reverse === 0 ? null : (same - reverse) / (same + reverse);
}

function haversineM(a: StopInfo, b: StopInfo): number {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return 0;
  const r = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

function stopName(stops: Map<number, StopInfo>, idx: number): string {
  const s = stops.get(idx);
  return s?.station || s?.name || "?";
}

function isLoop(p: number[], stops: Map<number, StopInfo>): boolean {
  if (p.length < 3) return false;
  const first = p[0];
  const last = p[p.length - 1];
  return first === last || stopName(stops, first) === stopName(stops, last);
}

function loopVia(p: number[], stops: Map<number, StopInfo>): string {
  const start = stops.get(p[0]);
  let best = p[0];
  let bestD = -1;
  for (const s of p) {
    const info = stops.get(s);
    const d = start && info ? haversineM(start, info) : 0;
    if (d > bestD) {
      bestD = d;
      best = s;
    }
  }
  return stopName(stops, best);
}

/** The headsign shared by at least half of `trips`, if any. */
function sharedHeadsign(trips: PatternTrips[]): string | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const t of trips) {
    total += t.n;
    if (t.headsign) counts.set(t.headsign, (counts.get(t.headsign) ?? 0) + t.n);
  }
  let best: string | null = null;
  let bestN = 0;
  counts.forEach((n, h) => {
    if (n > bestN) {
      best = h;
      bestN = n;
    }
  });
  return best !== null && bestN * 2 >= total ? best : null;
}

/** Group a route's patterns into directions. Pure, so it is tested directly. */
export function deriveDirections(
  patterns: PatternInfo[],
  trips: PatternTrips[],
  stops: Map<number, StopInfo>
): Direction[] {
  const byPattern = new Map<number, PatternTrips[]>();
  for (const t of trips) {
    const list = byPattern.get(t.pattern_idx) ?? [];
    list.push(t);
    byPattern.set(t.pattern_idx, list);
  }
  const ordered = [...patterns].sort(
    (a, b) => b.n_trips - a.n_trips || b.stops.length - a.stops.length || a.pattern_idx - b.pattern_idx
  );

  // Group: by the feed's direction_id when every trip has one.
  const allHaveId = trips.length > 0 && trips.every((t) => t.direction_id !== null);
  const groups: PatternInfo[][] = [];
  if (allHaveId) {
    const byId = new Map<number, PatternInfo[]>();
    for (const p of ordered) {
      // A pattern's direction is its trips' majority direction_id.
      const ids = new Map<number, number>();
      for (const t of byPattern.get(p.pattern_idx) ?? [])
        ids.set(t.direction_id as number, (ids.get(t.direction_id as number) ?? 0) + t.n);
      const id = [...ids.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
      byId.set(id, [...(byId.get(id) ?? []), p]);
    }
    [...byId.keys()].sort((a, b) => a - b).forEach((id) => groups.push(byId.get(id) as PatternInfo[]));
  } else {
    for (const p of ordered) {
      const home = groups.find((g) => {
        const agree = orderAgreement(g[0].stops, p.stops);
        return agree !== null && agree >= SAME_WAY;
      });
      if (home) home.push(p);
      else groups.push([p]);
    }
  }

  const directions = groups.map((group): Direction => {
    const main = group[0];
    const groupTrips = group.flatMap((p) => byPattern.get(p.pattern_idx) ?? []);
    const ids = new Set(groupTrips.map((t) => t.direction_id));
    const name: DirectionName = isLoop(main.stops, stops)
      ? { kind: "loop", place: loopVia(main.stops, stops), via: null }
      : {
          kind: "to",
          place: sharedHeadsign(groupTrips) ?? stopName(stops, main.stops[main.stops.length - 1]),
          via: null,
        };
    const patternsOut = group.map((p): DirectionPattern => {
      let kind: VariantKind = "main";
      if (p !== main) {
        if (isContiguousSub(main.stops, p.stops)) kind = "short_turn";
        else if (isSubsequence(main.stops, p.stops)) kind = "express";
        else kind = "branch";
      }
      // Where it goes: its last stop where that is not the main pattern's.
      // Feeds often keep the line's headsign on a short working (TMB's 113
      // ends at González Tablas yet signs Pl. Pius XII); the headsign names
      // only a pattern ending where the main one does.
      const end = p.stops[p.stops.length - 1];
      const destination =
        end === main.stops[main.stops.length - 1]
          ? (sharedHeadsign(byPattern.get(p.pattern_idx) ?? []) ?? stopName(stops, end))
          : stopName(stops, end);
      return { pattern_idx: p.pattern_idx, kind, destination, n_trips: p.n_trips };
    });
    return {
      key: main.pattern_idx,
      name,
      direction_id: ids.size === 1 ? ([...ids][0] as number | null) : null,
      patterns: patternsOut,
      n_trips: group.reduce((n, p) => n + p.n_trips, 0),
      ends: [stopName(stops, main.stops[0]), stopName(stops, main.stops[main.stops.length - 1])],
    };
  });

  // Two directions with one name are told apart by where they first differ.
  const same = (d: Direction) => `${d.name.kind}|${d.name.place}`;
  const seen = new Map<string, number>();
  directions.forEach((d) => seen.set(same(d), (seen.get(same(d)) ?? 0) + 1));
  for (const d of directions) {
    if ((seen.get(same(d)) ?? 0) < 2) continue;
    const main = patterns.find((p) => p.pattern_idx === d.key);
    if (main && main.stops.length > 1) d.name.via = stopName(stops, main.stops[1]);
  }
  return directions;
}

/** A route's directions, read from the snapshot. */
export async function routeDirections(db: SqlRunner, route: TripRange & { route_idx: number }) {
  const [patterns, trips] = await Promise.all([
    db.all<PatternInfo>(
      `SELECT pattern_idx, stops, n_trips FROM patterns WHERE route_idx = ${route.route_idx}`
    ),
    db.all<PatternTrips>(`
      SELECT pattern_idx, direction_id, headsign, CAST(count(*) AS INTEGER) AS n
      FROM trips WHERE trip_idx BETWEEN ${route.trip_lo ?? -1} AND ${route.trip_hi ?? -2}
      GROUP BY ALL`),
  ]);
  // Lists arrive as Arrow vectors; make them plain arrays.
  const plain = patterns.map((p) => ({ ...p, stops: Array.from(p.stops as ArrayLike<number>) }));
  const ids = [...new Set(plain.flatMap((p) => p.stops))];
  const stopRows = ids.length
    ? await db.all<StopInfo>(`
        SELECT s.stop_idx, s.name, s.lat, s.lon, p.name AS station
        FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx
        WHERE s.stop_idx IN (${ids.join(",")})`)
    : [];
  const stops = new Map(stopRows.map((s) => [s.stop_idx, s]));
  return { directions: deriveDirections(plain, trips, stops), stops, patterns: plain };
}
