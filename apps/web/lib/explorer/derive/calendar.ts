/**
 * Which services run when: `calendar` (a weekday bitmask over a date range)
 * plus the dates `calendar_dates` adds, minus the dates it removes. Dates are
 * service days, as GTFS counts them: a trip at 25:10 on Monday's service runs
 * on Monday's service day.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";

/** A date as SQL, from `YYYY-MM-DD`. Validated, since it is spliced in. */
export function sqlDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Not a date: ${date}`);
  return `DATE '${date}'`;
}

/** SQL selecting the `service_idx` of every service running on `date`. */
export function activeServicesSql(date: string): string {
  const d = sqlDate(date);
  return `(
    (SELECT service_idx FROM services
     WHERE days IS NOT NULL AND ${d} BETWEEN start_date AND end_date
       AND (CAST(days AS INTEGER) >> (isodow(${d}) - 1)) & 1 = 1
     UNION
     SELECT service_idx FROM calendar_dates WHERE date = ${d} AND exception_type = 1)
    EXCEPT
    SELECT service_idx FROM calendar_dates WHERE date = ${d} AND exception_type = 2
  )`;
}

/** Counted once per database and window: every route's annual figures and
 * the network's need the same counts. */
const dayCounts = new WeakMap<SqlRunner, Map<string, Promise<Map<number, number>>>>();

/** How many days each service runs between `start` and `end`, inclusive. */
export function serviceDayCounts(db: SqlRunner, start: string, end: string): Promise<Map<number, number>> {
  let byWindow = dayCounts.get(db);
  if (!byWindow) dayCounts.set(db, (byWindow = new Map()));
  const key = `${start}/${end}`;
  let counts = byWindow.get(key);
  if (!counts) {
    counts = countServiceDays(db, start, end);
    // A failed count is not kept: the next caller tries again.
    counts.catch(() => byWindow?.delete(key));
    byWindow.set(key, counts);
  }
  return counts;
}

async function countServiceDays(db: SqlRunner, start: string, end: string): Promise<Map<number, number>> {
  const rows = await db.all<{ service_idx: number; days: number }>(`
    WITH dates AS (
      SELECT CAST(d AS DATE) AS date
      FROM range(${sqlDate(start)}, ${sqlDate(end)} + INTERVAL 1 DAY, INTERVAL 1 DAY) r(d)
    ),
    regular AS (
      SELECT s.service_idx, d.date FROM services s
      JOIN dates d ON d.date BETWEEN s.start_date AND s.end_date
      WHERE s.days IS NOT NULL AND (CAST(s.days AS INTEGER) >> (isodow(d.date) - 1)) & 1 = 1
    ),
    added AS (
      SELECT service_idx, date FROM calendar_dates
      WHERE exception_type = 1 AND date BETWEEN ${sqlDate(start)} AND ${sqlDate(end)}
    ),
    removed AS (SELECT service_idx, date FROM calendar_dates WHERE exception_type = 2)
    SELECT service_idx, CAST(count(*) AS INTEGER) AS days
    FROM ((SELECT * FROM regular UNION SELECT * FROM added) EXCEPT SELECT * FROM removed)
    GROUP BY service_idx
  `);
  return new Map(rows.map((r) => [r.service_idx, r.days]));
}

export interface ServiceDays {
  weekdays: number;
  saturdays: number;
  sundays: number;
  /** The days counted over. */
  window_days: number;
}

/** The days between `start` and `end` on which the network runs any service,
 * by kind of day: what a year's cost is counted from. */
export async function networkServiceDays(db: SqlRunner, start: string, end: string): Promise<ServiceDays> {
  const [row] = await db.all<{ weekdays: number; saturdays: number; sundays: number; window_days: number }>(`
    WITH dates AS (
      SELECT CAST(d AS DATE) AS date
      FROM range(${sqlDate(start)}, ${sqlDate(end)} + INTERVAL 1 DAY, INTERVAL 1 DAY) r(d)
    ),
    served AS (
      SELECT DISTINCT d.date FROM dates d
      WHERE EXISTS (SELECT 1 FROM services s WHERE s.days IS NOT NULL
                      AND d.date BETWEEN s.start_date AND s.end_date
                      AND (CAST(s.days AS INTEGER) >> (isodow(d.date) - 1)) & 1 = 1
                      AND NOT EXISTS (SELECT 1 FROM calendar_dates c WHERE c.service_idx = s.service_idx
                                        AND c.date = d.date AND c.exception_type = 2))
         OR EXISTS (SELECT 1 FROM calendar_dates c WHERE c.date = d.date AND c.exception_type = 1)
    )
    SELECT CAST(count(*) FILTER (WHERE isodow(date) <= 5) AS INTEGER) AS weekdays,
           CAST(count(*) FILTER (WHERE isodow(date) = 6) AS INTEGER) AS saturdays,
           CAST(count(*) FILTER (WHERE isodow(date) = 7) AS INTEGER) AS sundays,
           CAST((SELECT count(*) FROM dates) AS INTEGER) AS window_days
    FROM served`);
  return row;
}
