/**
 * The roads Snap draws a moved stop's lines along: the Car measuring tool's
 * router (OSRM, `lib/api/osrm.ts`), rate-limited and cached there.
 */
import { fetchRoute } from "@/lib/api/osrm";
import type { Router } from "@/lib/explorer/edit/ops/moveStop";

export const carRoads: Router = async (waypoints) => {
  const route = await fetchRoute(waypoints, "CAR");
  return {
    line: route.geometry.coordinates as [number, number][],
    snapped: route.snappedWaypoints ?? waypoints,
  };
};
