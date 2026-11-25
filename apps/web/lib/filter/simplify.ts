// An outline made to fit the filter: positions are dropped in the order Douglas-Peucker drops them, as few as it takes
// for the caller's check to pass. Every ring stays, with at least four positions, and only positions of the outline
// are kept. Distances are measured in meters on a local projection, so a spike in the north counts as one in the south.
import type { PolygonCoords, Position } from "@/lib/filter/area";

export interface Simplified {
  polygons: PolygonCoords[];
  /** How far the outline moved at most, in meters: the farthest dropped position from the edge that replaced it. */
  shift: number;
}

const METERS_PER_DEGREE_LAT = 110_574;
const METERS_PER_DEGREE_LON = 111_320;

type Point = [number, number];

const project = ([lon, lat]: Position): Point => [
  lon * Math.cos((lat * Math.PI) / 180) * METERS_PER_DEGREE_LON,
  lat * METERS_PER_DEGREE_LAT,
];

/** The distance from p to the segment a-b. */
function distance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Each vertex's rank in the order Douglas-Peucker keeps them: the distance at which it is kept, never more than that of
 * the vertex that split its segment. Three vertices of the ring always stay. `points` holds the ring without its
 * closing position. */
function importance(points: Point[]): Float64Array {
  const n = points.length;
  const rank = new Float64Array(n);
  if (n <= 3) return rank.fill(Infinity);
  let far = 1;
  for (let i = 2; i < n; i++) {
    if (
      Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]) >
      Math.hypot(points[far][0] - points[0][0], points[far][1] - points[0][1])
    )
      far = i;
  }
  rank[0] = Infinity;
  rank[far] = Infinity;
  // Segments as [from, to, rank of the vertex that split them]; `to` may be n, the ring's first vertex again.
  const stack: Array<[number, number, number]> = [
    [0, far, Infinity],
    [far, n, Infinity],
  ];
  const at = (i: number) => points[i % n];
  while (stack.length) {
    const [from, to, parent] = stack.pop()!;
    let best = -1;
    let bestDistance = -1;
    for (let i = from + 1; i < to; i++) {
      const d = distance(points[i], at(from), at(to));
      if (d > bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    if (best < 0) continue;
    rank[best] = Math.min(bestDistance, parent);
    stack.push([from, best, rank[best]], [best, to, rank[best]]);
  }
  // The third vertex: the one that would be kept first after the two ends.
  let third = -1;
  for (let i = 1; i < n; i++) if (rank[i] !== Infinity && (third < 0 || rank[i] > rank[third])) third = i;
  if (third >= 0) rank[third] = Infinity;
  return rank;
}

/** The outline with as few positions dropped as `fits` allows, and how far it moved; null when even every ring at four
 * positions does not fit. */
export function simplifyToFit(
  polygons: PolygonCoords[],
  fits: (candidate: PolygonCoords[]) => boolean
): Simplified | null {
  // Every ring without its closing position, projected, with its vertices' ranks.
  const rings = polygons.flatMap((polygon) =>
    polygon.map((ring) => {
      const open = ring.slice(0, -1);
      const projected = open.map(project);
      return { open, projected, rank: importance(projected) };
    })
  );
  // The vertices that may go, the most important first.
  const optional: Array<[number, number, number]> = [];
  rings.forEach((ring, k) =>
    ring.rank.forEach((rank, i) => {
      if (rank !== Infinity) optional.push([rank, k, i]);
    })
  );
  optional.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);

  const keptWith = (count: number): Uint8Array[] => {
    const kept = rings.map((ring) => Uint8Array.from(ring.rank, (rank) => (rank === Infinity ? 1 : 0)));
    for (let j = 0; j < count; j++) kept[optional[j][1]][optional[j][2]] = 1;
    return kept;
  };
  // The rings are listed polygon by polygon, so the k-th ring of the list is the next one of the outline.
  const candidate = (kept: Uint8Array[]): PolygonCoords[] => {
    let k = 0;
    return polygons.map((polygon) =>
      polygon.map(() => {
        const keep = kept[k];
        const ring = rings[k++].open.filter((_, i) => keep[i]);
        return [...ring, ring[0]];
      })
    );
  };

  if (!fits(candidate(keptWith(0)))) return null;
  // The most vertices that fit.
  let low = 0;
  let high = optional.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(candidate(keptWith(mid)))) low = mid;
    else high = mid - 1;
  }
  const kept = keptWith(low);

  // How far the outline moved: each dropped vertex from the edge between the kept ones around it.
  let shift = 0;
  rings.forEach(({ projected }, k) => {
    const n = projected.length;
    const keep = kept[k];
    const first = keep.indexOf(1);
    let from = first;
    for (let step = 1; step <= n; step++) {
      const i = (first + step) % n;
      if (!keep[i]) continue;
      for (let j = (from + 1) % n; j !== i; j = (j + 1) % n)
        shift = Math.max(shift, distance(projected[j], projected[from], projected[i]));
      from = i;
    }
  });
  return { polygons: candidate(kept), shift };
}
