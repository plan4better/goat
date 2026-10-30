/**
 * The network's places as a rider knows them: stations with their platforms
 * under them, and stops that belong to no station. Each lists the routes
 * that call there, from the routes' stop patterns — a station those calling
 * at any of its platforms.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";

export interface PlatformRow {
  stop_idx: number;
  stop_id: string;
  name: string | null;
  platform_code: string | null;
  lat: number | null;
  lon: number | null;
  route_idxs: number[];
}

export interface PlaceRow extends Omit<PlatformRow, "platform_code"> {
  is_station: boolean;
  /** A station's platforms; empty for a stop on its own. */
  platforms: PlatformRow[];
}

type Raw<T> = Omit<T, "route_idxs"> & { route_idxs: ArrayLike<number> | null };

const toList = (v: ArrayLike<number> | null) => (v ? Array.from(v) : []);

/** Stations and parentless stops, each with its platforms. Entrances, nodes
 * and boarding areas are parts of a station, not places of their own. */
export async function places(db: SqlRunner): Promise<PlaceRow[]> {
  const calls = `
    calls AS (SELECT route_idx, UNNEST(stops) AS stop_idx FROM patterns),
    direct AS (
      SELECT stop_idx, list_sort(list_distinct(list(route_idx))) AS route_idxs FROM calls GROUP BY 1
    )`;
  const [tops, platforms] = await Promise.all([
    db.all<Raw<Omit<PlaceRow, "platforms">>>(`
      WITH ${calls},
      served AS (
        SELECT COALESCE(s.parent_idx, s.stop_idx) AS place,
               list_sort(list_distinct(flatten(list(d.route_idxs)))) AS route_idxs
        FROM direct d JOIN stops s USING (stop_idx)
        GROUP BY 1
      )
      SELECT s.stop_idx, s.stop_id, s.name, s.lat, s.lon,
             COALESCE(s.location_type, 0) = 1 AS is_station, sv.route_idxs
      FROM stops s LEFT JOIN served sv ON sv.place = s.stop_idx
      WHERE s.parent_idx IS NULL AND COALESCE(s.location_type, 0) IN (0, 1)
      ORDER BY s.name, s.stop_idx`),
    db.all<Raw<PlatformRow> & { parent_idx: number }>(`
      WITH ${calls}
      SELECT s.stop_idx, s.stop_id, s.name, s.platform_code, s.lat, s.lon, s.parent_idx, d.route_idxs
      FROM stops s LEFT JOIN direct d USING (stop_idx)
      WHERE s.parent_idx IS NOT NULL AND COALESCE(s.location_type, 0) = 0
      ORDER BY s.parent_idx, s.platform_code NULLS LAST, s.name, s.stop_idx`),
  ]);

  const byParent = new Map<number, PlatformRow[]>();
  for (const { parent_idx, ...p } of platforms) {
    const list = byParent.get(parent_idx) ?? [];
    list.push({ ...p, route_idxs: toList(p.route_idxs) });
    byParent.set(parent_idx, list);
  }
  return tops.map((t) => ({
    ...t,
    route_idxs: toList(t.route_idxs),
    platforms: byParent.get(t.stop_idx) ?? [],
  }));
}
