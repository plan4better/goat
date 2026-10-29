/**
 * Which service a route runs on which day (board 11), in plain words.
 *
 * Feeds split service into service_ids freely — per weekday type, per week,
 * per operator — so the days are grouped instead by what runs on them: a day
 * type is the days on which the route runs the same timetable, the same trips
 * at the same times, whichever service_ids carry them. A day type is named by the weekdays it covers ("Mon–Fri"), with the
 * dates it skips on those weekdays ("except 25 Dec") and the dates it adds on
 * others ("adds 26 Dec").
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { sqlDate } from "@/lib/explorer/derive/calendar";
import type { TripRange } from "@/lib/explorer/derive/runs";

export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** The route's services running that day, by service_idx. */
  services: number[];
  /** The route's trips that day. */
  trips: number;
  /** The day's timetable, as a fingerprint of its trips' patterns and
   * departures; days with equal keys run the same timetable. Null without service. */
  key: string | null;
}

export interface DayType {
  /** The timetable's key (`CalendarDay.key`). */
  key: string;
  days: string[];
  /** Trips on a day of this type. */
  trips: number;
  /** ISO weekdays (1 = Monday) the type covers. */
  weekdays: number[];
  /** Dates on those weekdays, within the type's span, it does not run on. */
  except: string[];
  /** Dates on other weekdays it runs on. */
  adds: string[];
}

export interface RouteCalendar {
  days: CalendarDay[];
  /** By days covered, most first. */
  types: DayType[];
}

/** ISO weekday of a `YYYY-MM-DD` date, 1 = Monday. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The day after a `YYYY-MM-DD` date. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Sorted dates as spans `[first, last]`, so a list reads "26 Oct – 6 Nov"
 * rather than ten dates. Two dates join when every day between them falls on
 * none of `weekdays`: for a Mon–Fri pattern, a skipped fortnight is one span
 * across its weekend. Without weekdays, only consecutive days join.
 */
export function dateRuns(dates: string[], weekdays: number[] = []): [string, string][] {
  const on = new Set(weekdays);
  const runs: [string, string][] = [];
  for (const date of dates) {
    const last = runs[runs.length - 1];
    let joins = !!last;
    if (last) {
      let d = nextDay(last[1]);
      for (; d < date && joins; d = nextDay(d)) joins = on.size > 0 && !on.has(isoWeekday(d));
    }
    if (joins) last[1] = date;
    else runs.push([date, date]);
  }
  return runs;
}

/** The month grid's exception marks: "+" where a pattern runs off its
 * weekdays (service added; on a day another pattern skips, it runs in its
 * place), "-" where a pattern skips one of its weekdays and none runs instead
 * (service removed). Patterns without weekdays run on added days alone. */
export function exceptionMarks(types: DayType[]): Map<string, "+" | "-"> {
  const marks = new Map<string, "+" | "-">();
  for (const ty of types) {
    if (ty.weekdays.length) ty.adds.forEach((d) => marks.set(d, "+"));
    else ty.days.forEach((d) => marks.set(d, "+"));
  }
  for (const ty of types) for (const d of ty.except) if (!marks.has(d)) marks.set(d, "-");
  return marks;
}

/** Group days into day types. Pure, so it is tested directly. */
export function dayTypes(days: CalendarDay[]): DayType[] {
  const groups = new Map<string, CalendarDay[]>();
  for (const d of days) {
    if (!d.key) continue;
    groups.set(d.key, [...(groups.get(d.key) ?? []), d]);
  }
  const types: DayType[] = [];
  for (const [key, group] of groups) {
    const dates = group.map((d) => d.date);
    const first = dates[0];
    const last = dates[dates.length - 1];
    const span = days.filter((d) => d.date >= first && d.date <= last);
    const own = new Set(dates);
    // A weekday is the type's when it runs on most of that weekday's dates
    // within its span: a holiday it skips does not take the weekday away. One
    // date is no weekly rule: a type on a single Thursday is not "Thu".
    const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((w) => {
      const all = span.filter((d) => isoWeekday(d.date) === w);
      const on = all.filter((d) => own.has(d.date));
      return on.length >= 2 && on.length * 2 > all.length;
    });
    const mine = new Set(weekdays);
    types.push({
      key,
      days: dates,
      trips: Math.max(...group.map((d) => d.trips)),
      weekdays,
      except: span.filter((d) => mine.has(isoWeekday(d.date)) && !own.has(d.date)).map((d) => d.date),
      adds: dates.filter((d) => !mine.has(isoWeekday(d))),
    });
  }
  return types.sort((a, b) => b.days.length - a.days.length || a.key.localeCompare(b.key));
}

export async function routeCalendar(
  db: SqlRunner,
  route: TripRange,
  window: [string, string]
): Promise<RouteCalendar> {
  const range = `trip_idx BETWEEN ${route.trip_lo ?? -1} AND ${route.trip_hi ?? -2}`;
  const [start, end] = [sqlDate(window[0]), sqlDate(window[1])];
  const mine = `(SELECT service_idx, CAST(count(*) AS INTEGER) AS trips FROM trips WHERE ${range} GROUP BY 1)`;
  const rows = await db.all<{
    date: string;
    services: ArrayLike<number> | null;
    trips: number;
    key: string | null;
  }>(`
      WITH rs AS ${mine},
      dates AS (SELECT CAST(d AS DATE) AS date FROM range(${start}, ${end} + INTERVAL 1 DAY, INTERVAL 1 DAY) r(d)),
      regular AS (
        SELECT s.service_idx, d.date FROM services s JOIN rs USING (service_idx)
        JOIN dates d ON d.date BETWEEN s.start_date AND s.end_date
        WHERE s.days IS NOT NULL AND (CAST(s.days AS INTEGER) >> (isodow(d.date) - 1)) & 1 = 1
      ),
      added AS (
        SELECT cd.service_idx, cd.date FROM calendar_dates cd JOIN rs USING (service_idx)
        WHERE cd.exception_type = 1 AND cd.date BETWEEN ${start} AND ${end}
      ),
      removed AS (
        SELECT cd.service_idx, cd.date FROM calendar_dates cd JOIN rs USING (service_idx)
        WHERE cd.exception_type = 2
      ),
      active AS ((SELECT * FROM regular UNION SELECT * FROM added) EXCEPT SELECT * FROM removed),
      -- A frequency-based trip runs every headway_s from start_s up to end_s,
      -- as derive/runs expands it: that many trips, not one.
      freq AS (
        SELECT trip_idx, CAST(sum(ceil((end_s - start_s) / headway_s)) AS INTEGER) AS runs,
               sum(hash(start_s, end_s, headway_s) % 1000000007) AS h
        FROM frequencies GROUP BY trip_idx
      ),
      -- A day's timetable: its trips' patterns and first departures (and
      -- frequencies), summed as hashes so the order they come in does not matter.
      timetable AS (
        SELECT a.date, CAST(sum(COALESCE(f.runs, 1)) AS INTEGER) AS trips,
               sum(hash(t.pattern_idx, t.first_dep_s, f.h) % 1000000007) AS sig
        FROM active a JOIN trips t ON t.service_idx = a.service_idx AND t.${range}
        LEFT JOIN freq f ON f.trip_idx = t.trip_idx
        GROUP BY a.date
      ),
      per_day AS (
        SELECT d.date, list_sort(list(a.service_idx) FILTER (WHERE a.service_idx IS NOT NULL)) AS services
        FROM dates d LEFT JOIN active a USING (date) GROUP BY d.date
      )
      SELECT strftime(p.date, '%Y-%m-%d') AS date, p.services,
             COALESCE(tt.trips, 0) AS trips,
             CASE WHEN tt.trips > 0 THEN tt.trips || ':' || tt.sig END AS key
      FROM per_day p LEFT JOIN timetable tt USING (date)
      ORDER BY p.date`);
  const days = rows.map((r) => ({
    date: r.date,
    services: r.services ? Array.from(r.services) : [],
    trips: r.trips,
    key: r.key,
  }));
  return { days, types: dayTypes(days) };
}
