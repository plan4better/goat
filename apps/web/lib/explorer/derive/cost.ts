/**
 * Operating cost, an estimate for comparing scenarios
 * (docs/pt-network-editor/docs/05-viewers-and-cost.md):
 *
 *   annual cost = vehicle-km a year × € per km (+ vehicle-hours × € per hour)
 *
 * A year's vehicle-km come from the timetable and the calendar: each service's
 * daily km times the days it runs in the year counted (yearOf), scaled to 365
 * days when the feed's window is shorter. Rates are per operator and route type and set by
 * the user (settings.ts); a type without one is priced at its default.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { serviceDayCounts } from "@/lib/explorer/derive/calendar";
import type { TripRange } from "@/lib/explorer/derive/runs";
import { type Rate, defaultRate } from "@/lib/explorer/settings";

export type { Rate };
export { defaultRate };

export interface AnnualFigures {
  vehicle_km: number;
  vehicle_hours: number;
  cost: number;
  /** Days the year's figures were counted over, before scaling to 365. */
  window_days: number;
}

/** A year of the trips `where` selects (SQL over `trips`), priced at `rate`. */
async function annualFor(
  db: SqlRunner,
  where: string,
  window: [string, string],
  rate: Rate,
  days?: Map<number, number>
): Promise<AnnualFigures> {
  window = yearOf(window);
  days ??= await serviceDayCounts(db, window[0], window[1]);
  const perService = await db.all<{ service_idx: number; km: number; hours: number }>(`
    WITH t AS (
      -- Trips with a schedule: one without a first or last time never runs.
      SELECT * FROM trips
      WHERE (${where}) AND first_dep_s IS NOT NULL AND last_arr_s IS NOT NULL
    ),
    runs AS (
      SELECT service_idx, length_m, last_arr_s - first_dep_s AS secs, 1 AS n
      FROM t WHERE trip_idx NOT IN (SELECT trip_idx FROM frequencies)
      UNION ALL
      SELECT t.service_idx, t.length_m, t.last_arr_s - t.first_dep_s,
             len(range(f.start_s, f.end_s, f.headway_s))
      FROM t JOIN frequencies f USING (trip_idx)
    )
    SELECT service_idx, sum(length_m * n) / 1000 AS km, sum(secs * n) / 3600 AS hours
    FROM runs GROUP BY service_idx
  `);
  const windowDays =
    (Date.parse(`${window[1]}T00:00:00Z`) - Date.parse(`${window[0]}T00:00:00Z`)) / 86_400_000 + 1;
  const scale = windowDays < 365 ? 365 / windowDays : 1;
  let km = 0;
  let hours = 0;
  for (const s of perService) {
    const n = days.get(s.service_idx) ?? 0;
    km += s.km * n;
    hours += s.hours * n;
  }
  km *= scale;
  hours *= scale;
  return {
    vehicle_km: km,
    vehicle_hours: hours,
    cost: km * rate.per_km + (rate.per_hour ? hours * rate.per_hour : 0),
    window_days: windowDays,
  };
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The period a cost is counted over, and how it was chosen. */
export interface CostYear {
  from: string;
  to: string;
  /** "calendar": this calendar year, all of it in the feed; "year": 365
   * days of the feed, the calendar year not all in it; "scaled": all of a
   * feed shorter than a year, its figures scaled to 365 days. */
  kind: "calendar" | "year" | "scaled";
}

/** The period a cost is counted over: this calendar year, where the feed's
 * window covers all of it; else 365 days of the window, from today, or its
 * last 365 days once today is past them; and a window of a year or less,
 * all of it. Not from the window's first day, where a placeholder service
 * range (2018–2028) can put it years before the timetable runs. */
export function costYear(window: [string, string], today: Date = new Date()): CostYear {
  const start = Date.parse(`${window[0]}T00:00:00Z`);
  const end = Date.parse(`${window[1]}T00:00:00Z`);
  if (end - start <= 364 * DAY_MS) return { from: window[0], to: window[1], kind: "scaled" };
  const year = today.getUTCFullYear();
  const [jan1, dec31] = [`${year}-01-01`, `${year}-12-31`];
  if (window[0] <= jan1 && window[1] >= dec31) return { from: jan1, to: dec31, kind: "calendar" };
  const now = Date.UTC(year, today.getUTCMonth(), today.getUTCDate());
  const from = Math.min(Math.max(now, start), end - 364 * DAY_MS);
  return { from: isoDay(from), to: isoDay(from + 364 * DAY_MS), kind: "year" };
}

/** costYear as `[from, to]`. */
export function yearOf(window: [string, string], today: Date = new Date()): [string, string] {
  const { from, to } = costYear(window, today);
  return [from, to];
}

/** A route's figures for a year, from every service it runs on. */
export function annualFigures(
  db: SqlRunner,
  route: TripRange,
  window: [string, string],
  rate: Rate
): Promise<AnnualFigures> {
  return annualFor(db, `trip_idx BETWEEN ${route.trip_lo ?? -1} AND ${route.trip_hi ?? -2}`, window, rate);
}

/** The whole network's figures for a year, each operator's route types at
 * their rate. */
export async function networkAnnualFigures(
  db: SqlRunner,
  window: [string, string],
  rateFor: (agencyId: string | null, routeType: number | null) => Rate = (_a, type) => defaultRate(type)
): Promise<AnnualFigures> {
  const year = yearOf(window);
  const days = await serviceDayCounts(db, year[0], year[1]);
  const groups = await db.all<{
    agency_idx: number | null;
    agency_id: string | null;
    route_type: number | null;
  }>(`
    SELECT DISTINCT r.agency_idx, a.agency_id, r.route_type
    FROM routes r LEFT JOIN agencies a USING (agency_idx)`);
  const total: AnnualFigures = { vehicle_km: 0, vehicle_hours: 0, cost: 0, window_days: 0 };
  const is = (col: string, v: number | null) => (v === null ? `${col} IS NULL` : `${col} = ${v}`);
  for (const g of groups) {
    const where = `route_idx IN (SELECT route_idx FROM routes WHERE ${is("agency_idx", g.agency_idx)}
                   AND ${is("route_type", g.route_type)})`;
    const f = await annualFor(db, where, year, rateFor(g.agency_id, g.route_type), days);
    total.vehicle_km += f.vehicle_km;
    total.vehicle_hours += f.vehicle_hours;
    total.cost += f.cost;
    total.window_days = f.window_days;
  }
  return total;
}
