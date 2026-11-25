import MapboxDraw from "@mapbox/mapbox-gl-draw";
import { useEffect, useMemo } from "react";
import type { ControlPosition } from "react-map-gl/maplibre";
import { useControl } from "react-map-gl/maplibre";

import {
  CircleMode,
  GreatCircleMode,
  LineStringMode,
  PatchedSimpleSelect,
  PolygonMode,
  type RouteFetcher,
  type RoutingProfile,
  createPatchedDirectSelect,
  createRoutingMode,
  defaultDrawStyles,
} from "@p4b/draw";

import { fetchRoute as osrmFetchRoute } from "@/lib/api/osrm";
import { useDraw } from "@/lib/providers/DrawProvider";
import { drawEvents } from "@/lib/utils/map/drawEvents";

// Adapter to match the RouteFetcher signature from @p4b/draw
const fetchRoute: RouteFetcher = async (waypoints: [number, number][], profile: RoutingProfile) => {
  // Map routing profiles to OSRM API format
  const mode = profile === "foot" || profile === "walk" || profile === "WALK" ? "WALK" : "CAR";
  const result = await osrmFetchRoute(waypoints, mode);
  return {
    geometry: {
      type: "LineString" as const,
      coordinates: result.geometry.coordinates as [number, number][],
    },
    distance: result.distance,
    duration: result.duration,
    snappedWaypoints: result.snappedWaypoints,
  };
};

const constants = MapboxDraw.constants;

export enum DrawModes {
  CIRCLE = "draw_circle",
  LINE_STRING = "draw_line_string",
  POLYGON = "draw_polygon",
  GREAT_CIRCLE = "draw_great_circle",
  ROUTE_WALKING = "draw_route_walking",
  ROUTE_CAR = "draw_route_car",
}

type DrawControlProps = ConstructorParameters<typeof MapboxDraw>[0] & {
  position?: ControlPosition;

  onCreate?: (evt: { features: object[] }) => void;
  onUpdate?: (evt: { features: object[]; action: string }) => void;
  onDelete?: (evt: { features: object[] }) => void;
};

// eslint-disable-next-line react/display-name
export const DrawControl = (props: DrawControlProps) => {
  const { setDrawControl } = useDraw();

  // Create modes with dependencies - memoized to avoid recreation on every render
  const modes = useMemo(() => {
    // Create routing modes with the OSRM fetch function
    const WalkingMode = createRoutingMode("foot", fetchRoute);
    const CarMode = createRoutingMode("car", fetchRoute);

    // Create patched direct select with routing support
    const PatchedDirectSelectMode = createPatchedDirectSelect(fetchRoute);

    return {
      ...MapboxDraw.modes,
      [MapboxDraw.constants.modes.SIMPLE_SELECT]: PatchedSimpleSelect,
      [MapboxDraw.constants.modes.DIRECT_SELECT]: PatchedDirectSelectMode,
      [DrawModes.LINE_STRING]: LineStringMode,
      [DrawModes.POLYGON]: PolygonMode,
      [DrawModes.GREAT_CIRCLE]: GreatCircleMode,
      [DrawModes.CIRCLE]: CircleMode,
      [DrawModes.ROUTE_WALKING]: WalkingMode,
      [DrawModes.ROUTE_CAR]: CarMode,
    };
  }, []);

  // Merge custom styles with any passed styles
  const mergedProps = {
    ...props,
    modes, // Pass the custom modes to MapboxDraw
    styles: props.styles || defaultDrawStyles,
    userProperties: true, // Enable user properties to be passed through to display
  };

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const drawControl = useControl<MapboxDraw>(
    () => new MapboxDraw(mergedProps),
    ({ map }) => {
      props.onCreate && drawEvents(map).on(constants.events.CREATE, props.onCreate);
      props.onUpdate && drawEvents(map).on(constants.events.UPDATE, props.onUpdate);
      props.onDelete && drawEvents(map).on(constants.events.DELETE, props.onDelete);
    },
    ({ map }) => {
      props.onCreate && drawEvents(map).off(constants.events.CREATE, props.onCreate);
      props.onUpdate && drawEvents(map).off(constants.events.UPDATE, props.onUpdate);
      props.onDelete && drawEvents(map).off(constants.events.DELETE, props.onDelete);
    },
    {
      position: props.position,
    }
  );

  useEffect(() => {
    if (drawControl) {
      setDrawControl(drawControl);
    }
    // Clear on unmount — a MapboxDraw instance detached from the map throws
    // on every API call, so consumers must not see it via the context.
    return () => setDrawControl(null);
  }, [drawControl, setDrawControl]);

  return null;
};

export default DrawControl;
