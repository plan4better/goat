/**
 * Query answers kept per database: going back to the route list, or to a
 * route seen before, must not queue the same work again in the database's one
 * worker — the network's annual cost scans every trip, and a route opened
 * behind it waits for it.
 *
 * What the whole bundle shows (its lines, stations, agencies, cost) is kept
 * as long as the database. What one line, stop or trip shows is kept for the
 * last PER_ITEM of them only: browsing a hundred lines would otherwise keep
 * every one's trips and geometry, some 3 MB each on Barcelona (measured 23
 * Oct 2026), until the Explorer closes.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";

/** The answers about one line, stop or trip, by their keys' prefix. */
const PER_ITEM =
  /^(route|line|calendar|stop-timetable|directions|trip|trip-cost|pattern-sections|route-trips):/;
/** How many such answers are kept, the most recently asked for. */
export const PER_ITEM_KEPT = 40;

const answers = new WeakMap<SqlRunner, Map<string, Promise<unknown>>>();

export function remembered<T>(db: SqlRunner, key: string, query: (db: SqlRunner) => Promise<T>): Promise<T> {
  let byKey = answers.get(db);
  if (!byKey) answers.set(db, (byKey = new Map()));
  const kept = byKey;
  let answer = kept.get(key) as Promise<T> | undefined;
  if (answer) {
    // Asked for again: the most recent now, last to be let go.
    if (PER_ITEM.test(key)) {
      kept.delete(key);
      kept.set(key, answer);
    }
    return answer;
  }
  answer = query(db);
  // A failure is not kept: the next request tries again.
  answer.catch(() => kept.delete(key));
  kept.set(key, answer);
  if (PER_ITEM.test(key)) {
    // A Map iterates in the order keys went in: the oldest first.
    let items = 0;
    for (const k of kept.keys()) if (PER_ITEM.test(k)) items++;
    for (const k of kept.keys()) {
      if (items <= PER_ITEM_KEPT) break;
      if (PER_ITEM.test(k)) {
        kept.delete(k);
        items--;
      }
    }
  }
  return answer;
}
