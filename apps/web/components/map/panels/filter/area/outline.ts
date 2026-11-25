// The area's outline on the map while the layer's Filter panel is open, or while the layer list's filter badge is
// hovered. The panel hands the area to a small store here and the map's FilterAreaLayer draws what the store holds:
// the two are far apart in the tree, and an area can be thousands of points, which is nothing to keep in the app's
// state.
import { useEffect, useRef, useSyncExternalStore } from "react";

import { type FilterArea, type PolygonCoords, areaGeometry, areaPolygons } from "@/lib/filter/area";
import { readFilter } from "@/lib/filter/read";
import type { JsonObject } from "@/lib/style/json";

export interface AreaOutline {
  /** Every piece's polygons as one Polygon or MultiPolygon. */
  geometry: JsonObject;
  enabled: boolean;
}

interface Shown {
  /** Who showed it: only they take it away again. */
  owner: object;
  polygons: PolygonCoords[];
  outline: AreaOutline;
}

// Each owner's outline, the latest on top: the map draws the top one. A layer list's hover shows a saved area over the
// open panel's, and the panel's comes back when the hover ends.
let stack: Shown[] = [];
const listeners = new Set<() => void>();

const top = (): Shown | null => stack[stack.length - 1] ?? null;

/** Sets the stack, telling the listeners when the outline on top is another one. */
const publish = (next: Shown[]) => {
  const before = top()?.outline;
  stack = next;
  if (top()?.outline !== before) listeners.forEach((listener) => listener());
};

const samePolygons = (a: PolygonCoords[], b: PolygonCoords[]) =>
  a.length === b.length && a.every((polygon, i) => polygon === b[i]);

export const areaOutlineStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): AreaOutline | null {
    return top()?.outline ?? null;
  },
  /** Shows `area` for `owner`, on top when the owner shows nothing yet, else where its outline is. The geometry is a
   * new one only when the polygons are other ones than before. */
  show(owner: object, area: FilterArea | undefined): void {
    const mine = stack.find((entry) => entry.owner === owner);
    const polygons = area ? areaPolygons(area) : [];
    const geometry =
      mine && samePolygons(mine.polygons, polygons) ? mine.outline.geometry : area && areaGeometry(area);
    if (!area || !geometry) return areaOutlineStore.clear(owner);
    const outline =
      mine?.outline.geometry === geometry && mine.outline.enabled === area.enabled
        ? mine.outline
        : { geometry, enabled: area.enabled };
    const entry = { owner, polygons, outline };
    publish(mine ? stack.map((other) => (other === mine ? entry : other)) : [...stack, entry]);
  },
  /** Takes `owner`'s outline away. */
  clear(owner: object): void {
    if (stack.some((entry) => entry.owner === owner)) publish(stack.filter((entry) => entry.owner !== owner));
  },
};

/** Shows the area of a saved filter (a project layer's `query`) for `owner`; nothing when it has none. */
export function showSavedArea(
  owner: object,
  query: { cql?: unknown; ui?: unknown } | null | undefined
): void {
  const area = query ? readFilter(query.cql, query.ui, {}).area : undefined;
  areaOutlineStore.show(owner, area);
}

/** What the map draws now: for the map's layer. */
export const useShownAreaOutline = (): AreaOutline | null =>
  useSyncExternalStore(areaOutlineStore.subscribe, areaOutlineStore.getSnapshot, () => null);

/** Shows `area` on the map as long as the calling component is mounted; nothing for no area. */
export function useAreaOutline(area: FilterArea | undefined): void {
  const owner = useRef({}).current;
  useEffect(() => areaOutlineStore.show(owner, area), [owner, area]);
  useEffect(() => () => areaOutlineStore.clear(owner), [owner]);
}
