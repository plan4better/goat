// The map's view for the area: read when a map view piece is taken, and watched while there is one to compare.
import { useCallback, useEffect, useState } from "react";
import { useMap } from "react-map-gl/maplibre";

import { MAIN_MAP } from "@/components/map/panels/filter/area/host";
import type { Bounds } from "@/components/map/panels/filter/area/pieces";

export interface MapView {
  /** The view after the map's last move, while it is watched. */
  bounds: Bounds | undefined;
  /** The view now; undefined without a map. */
  read: () => Bounds | undefined;
}

/** `watch`: follow the map's moves (once each has ended); without it nothing listens. `mapId`: the map's id in its
 * MapProvider, the project's map by default. */
export function useMapView(watch: boolean, mapId: string = MAIN_MAP.id): MapView {
  const map = useMap()[mapId];
  const read = useCallback(() => map?.getBounds().toArray().flat() as Bounds | undefined, [map]);
  const [bounds, setBounds] = useState<Bounds>();
  useEffect(() => {
    if (!map || !watch) return;
    // A move can end where it began (a click, a resize of another panel): the view then stays the one it was.
    const update = () => {
      const now = read();
      setBounds((was) => (was && now && was.every((edge, i) => edge === now[i]) ? was : now));
    };
    update();
    map.on("moveend", update);
    return () => void map.off("moveend", update);
  }, [map, watch, read]);
  return { bounds: watch ? bounds : undefined, read };
}
