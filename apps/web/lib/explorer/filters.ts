/**
 * The Explorer tab's filter (board 4): which lists show, and which routes —
 * by route type and agency — they hold. Stops follow the routes: with a route
 * filter on, a stop is listed when a matching route calls there.
 */
import type { PlaceRow, PlatformRow } from "@/lib/explorer/derive/stops";
import { type ModeKey, modeOf } from "@/lib/explorer/modes";
import type { ExplorerFilters } from "@/lib/store/explorer/slice";

export interface FilterableRoute {
  route_idx: number;
  route_type: number | null;
  agency_idx: number | null;
}

export function filterCount(filters: ExplorerFilters): number {
  return filters.types.length + filters.modes.length + filters.agencies.length;
}

/** Whether a list shows: both do until one is picked. */
export function shows(filters: ExplorerFilters, type: "routes" | "stops"): boolean {
  return filters.types.length === 0 || filters.types.includes(type);
}

export function routeMatches(route: FilterableRoute, filters: ExplorerFilters): boolean {
  if (filters.modes.length && !filters.modes.includes(modeOf(route.route_type))) return false;
  if (filters.agencies.length && (route.agency_idx === null || !filters.agencies.includes(route.agency_idx)))
    return false;
  return true;
}

/** The routes a stop list is narrowed to, or null when no route filter is on. */
export function matchingRouteIdxs(routes: FilterableRoute[], filters: ExplorerFilters): Set<number> | null {
  if (!filters.modes.length && !filters.agencies.length) return null;
  return new Set(routes.filter((r) => routeMatches(r, filters)).map((r) => r.route_idx));
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Route counts per mode, in a stable order, for the modes the feed has. */
export function modeCounts(routes: FilterableRoute[]): [ModeKey, number][] {
  const counts = new Map<ModeKey, number>();
  for (const r of routes) counts.set(modeOf(r.route_type), (counts.get(modeOf(r.route_type)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function agencyCounts(routes: FilterableRoute[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const r of routes)
    if (r.agency_idx !== null) counts.set(r.agency_idx, (counts.get(r.agency_idx) ?? 0) + 1);
  return counts;
}

export interface ListedPlace {
  place: PlaceRow;
  /** The platforms to show: all, or those the search or filter kept. */
  platforms: PlatformRow[];
  /** Opened by a search that matched one of its platforms. */
  opened: boolean;
}

/** Whether `text` has a word starting with `q`: at its start, or after a
 * space or other separator ("Hbf (Berlin)", "Alt-Moabit"). */
function wordStarts(text: string, q: string): boolean {
  return text.startsWith(q) || [" ", "-", "/", "(", "."].some((sep) => text.includes(sep + q));
}

/** Route numbers as people read them: 2, 4, 10, 52, 100 — not as text. */
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface SearchableRoute {
  route_idx: number;
  short_name: string | null;
  long_name: string | null;
  agency: string | null;
  route_id: string;
}

/** How well a route matches a search, best first, or null where it does
 * not: its number exactly, starting with the search, holding it; then its
 * name, a word of it starting with the search, holding it; last, only its
 * operator or id (route 25 whose id holds "52" comes after 52 and 520). */
export function routeRank(route: SearchableRoute, q: string): number | null {
  const short = (route.short_name ?? "").toLowerCase();
  const long = (route.long_name ?? "").toLowerCase();
  if (short === q) return 0;
  if (short.startsWith(q)) return 1;
  if (short.includes(q)) return 2;
  if (wordStarts(long, q)) return 3;
  if (long.includes(q)) return 4;
  if ((route.agency ?? "").toLowerCase().includes(q) || route.route_id.toLowerCase().includes(q)) return 5;
  return null;
}

/** The routes a search finds, best match first. Among equals, with each
 * route's runs on the date known (`runs`, by route_idx): those running that
 * day first, the busiest first; then by number in natural order (52 before
 * 520), else as listed. No search: all, as listed. */
export function searchRoutes<R extends SearchableRoute>(
  routes: R[],
  query: string,
  runs?: Map<number, number> | null
): R[] {
  const q = query.toLowerCase();
  if (!q) return routes;
  const found: [number, number, number, R][] = [];
  routes.forEach((r, i) => {
    const rank = routeRank(r, q);
    if (rank !== null) found.push([rank, runs?.get(r.route_idx) ?? 0, i, r]);
  });
  found.sort(
    (a, b) =>
      a[0] - b[0] ||
      (runs ? b[1] - a[1] : 0) ||
      natural.compare(a[3].short_name ?? "", b[3].short_name ?? "") ||
      a[2] - b[2]
  );
  return found.map(([, , , r]) => r);
}

/** The text a search looks in, lowercased once per list of places rather
 * than on every keystroke: a place's name and id, and each platform's name,
 * code and id. A platform's fields are joined by a character no search
 * holds, so a search never matches across two of them. */
const placeKeys = new WeakMap<
  PlaceRow[],
  { name: string; id: string; platforms: Map<PlatformRow, string> }[]
>();
const key = (...vs: (string | null)[]) =>
  vs
    .map((v) => v ?? "")
    .join("\u0000")
    .toLowerCase();
function keysOf(places: PlaceRow[]) {
  let keys = placeKeys.get(places);
  if (!keys) {
    keys = places.map((p) => ({
      name: (p.name ?? "").toLowerCase(),
      id: (p.stop_id ?? "").toLowerCase(),
      platforms: new Map(p.platforms.map((x) => [x, key(x.name, x.platform_code, x.stop_id)])),
    }));
    placeKeys.set(places, keys);
  }
  return keys;
}

/** How well a place's own name or id matches, best first: the name exactly,
 * starting with the search, a word of it starting with it, holding it; then
 * the id. Null where only a platform, or nothing, matches. */
function placeRank(k: { name: string; id: string }, q: string): number | null {
  if (k.name === q) return 0;
  if (k.name.startsWith(q)) return 1;
  if (wordStarts(k.name, q)) return 2;
  if (k.name.includes(q)) return 3;
  if (k.id.includes(q)) return 4;
  return null;
}

/** The places a search and a route filter keep, with the platforms they
 * keep: best match first, a place found by one of its platforms last, and
 * equals in name order. */
export function listPlaces(places: PlaceRow[], query: string, via: Set<number> | null): ListedPlace[] {
  const q = query.toLowerCase();
  const keys = q ? keysOf(places) : null;
  const calledAt = (routes: number[]) => !via || routes.some((i) => via.has(i));
  const out: [number, ListedPlace][] = [];
  places.forEach((place, i) => {
    if (!calledAt(place.route_idxs)) return;
    const platforms = via ? place.platforms.filter((p) => calledAt(p.route_idxs)) : place.platforms;
    const rank = keys ? placeRank(keys[i], q) : 0;
    if (rank !== null) {
      out.push([rank, { place, platforms, opened: false }]);
      return;
    }
    const found = platforms.filter((p) => keys?.[i].platforms.get(p)?.includes(q));
    if (found.length) out.push([5, { place, platforms: found, opened: true }]);
  });
  // A stable sort: equals keep the name order they came in.
  if (q) out.sort((a, b) => a[0] - b[0]);
  return out.map(([, listed]) => listed);
}
