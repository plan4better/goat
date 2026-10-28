import type { MapRef } from "react-map-gl/maplibre";
import { useCallback, useEffect, useRef } from "react";

import {
  type SnapTarget,
  clampToleranceToGround,
  findSnapTarget,
  snapLineEndpoints,
} from "@/lib/utils/snapping";

/** How close, in screen pixels, an endpoint has to be to snap. */
const SNAP_RADIUS_PX = 12;

/**
 * Below this zoom, snapping is switched off.
 *
 * The feature tile source is capped at zoom 14 and overzoomed above it, so this
 * is where the rendered geometry stops getting more accurate (~0.5 m of grid
 * quantisation, inside the server's 1 m tolerance — and the server moves the
 * endpoint onto the node exactly anyway). Below 14 the tiles themselves are
 * coarser, which no tolerance can compensate for.
 *
 * How far a snap may reach is handled separately, by MAX_SNAP_DISTANCE_M: the
 * pixel radius covers ~10 m of ground at z16 but ~38 m at z14, so the ground cap
 * is what stops a zoomed-out cursor grabbing across the street.
 */
const MIN_SNAP_ZOOM = 14;

const INDICATOR_SOURCE = "edge-snap-indicator";
const INDICATOR_LAYER = "edge-snap-indicator-circle";

type Position = [number, number];

/**
 * Snapping while drawing an edge.
 *
 * An aid, not the authority: the server re-derives the topology on save, snapping
 * an endpoint to a node within its own tolerance or splitting the edge it landed
 * on. This exists so the user can see and hit those targets instead of guessing
 * within a metre, and it mirrors the server's precedence — a vertex beats a line
 * interior — so the preview matches the outcome.
 *
 * Candidates come from what MapLibre has already rendered for the layer being
 * edited, so there is no extra request and no second copy of the network on the
 * client. That means it can only snap to what is currently on screen, which is
 * also the only thing the user can aim at.
 */
export function useEdgeSnapping(
  mapRef: React.RefObject<MapRef | null> | null,
  enabled: boolean,
  /** The MapLibre layers drawing the edited layer's geometry, read when candidates are needed. */
  targetMapLayerIds: () => string[],
  // Separate from `enabled` on purpose: the marker answers "where will this
  // endpoint land", which is only a question mid-gesture. Consulted per mouse
  // move rather than passed as a flag, because MapboxDraw's mode changes without
  // any React state changing.
  isEditingGesture: () => boolean
) {
  const layerIdsRef = useRef(targetMapLayerIds);
  layerIdsRef.current = targetMapLayerIds;

  /** Tolerance in degrees for the current zoom, from a pixel radius. */
  const toleranceAt = useCallback(
    (position: Position): number | null => {
      const map = mapRef?.current?.getMap();
      if (!map) return null;
      if (map.getZoom() < MIN_SNAP_ZOOM) return null;
      const screen = map.project(position);
      const offset = map.unproject([screen.x + SNAP_RADIUS_PX, screen.y]);
      return clampToleranceToGround(
        Math.abs(offset.lng - position[0]),
        position[1]
      );
    },
    [mapRef]
  );

  const candidatesNear = useCallback(
    (position: Position): GeoJSON.Feature[] => {
      const map = mapRef?.current?.getMap();
      if (!map) return [];
      const layers = layerIdsRef.current().filter((id) => map.getLayer(id));
      if (!layers.length) return [];
      const screen = map.project(position);
      const box: [[number, number], [number, number]] = [
        [screen.x - SNAP_RADIUS_PX, screen.y - SNAP_RADIUS_PX],
        [screen.x + SNAP_RADIUS_PX, screen.y + SNAP_RADIUS_PX],
      ];
      // Rendered features are clipped to tile boundaries, so a line crossing one
      // arrives in pieces. That is harmless here: a piece still carries the
      // geometry under the cursor, which is all the projection needs.
      return map.queryRenderedFeatures(box, { layers }) as unknown as GeoJSON.Feature[];
    },
    [mapRef]
  );

  /** The snap target for a position, or null when nothing is close enough. */
  const targetFor = useCallback(
    (position: Position): SnapTarget | null => {
      if (!enabled) return null;
      const tolerance = toleranceAt(position);
      if (tolerance === null) return null;
      return findSnapTarget(position, candidatesNear(position), tolerance);
    },
    [enabled, toleranceAt, candidatesNear]
  );

  /** Snap a drawn line's endpoints, returning null when nothing moved. */
  const snapDrawnLine = useCallback(
    (coordinates: Position[]): Position[] | null => {
      if (!enabled || coordinates.length < 2) return null;
      const tolerance = toleranceAt(coordinates[0]);
      if (tolerance === null) return null;
      // One candidate set around each end, rather than one around the whole
      // line: a long edge would otherwise pull in everything in its bbox.
      const candidates = [
        ...candidatesNear(coordinates[0]),
        ...candidatesNear(coordinates[coordinates.length - 1]),
      ];
      const result = snapLineEndpoints(coordinates, candidates, tolerance);
      return result.snapped ? result.coordinates : null;
    },
    [enabled, toleranceAt, candidatesNear]
  );

  // --- the on-map indicator ---

  /**
   * Add the indicator source and layer if they are not there.
   *
   * Idempotent and called on every update, because the project layers are
   * declarative: their React key carries `updated_at`, so a save remounts them,
   * and a basemap change rebuilds the style. Either drops or re-orders anything
   * added imperatively, so this cannot be a one-off at session start.
   */
  const ensureIndicator = useCallback(() => {
    const map = mapRef?.current?.getMap();
    if (!map || !map.getStyle()) return;
    if (!map.getSource(INDICATOR_SOURCE)) {
      map.addSource(INDICATOR_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getLayer(INDICATOR_LAYER)) {
      map.addLayer({
        id: INDICATOR_LAYER,
        type: "circle",
        source: INDICATOR_SOURCE,
        paint: {
          // A vertex is an existing node the edge will connect to; an edge hit
          // means the server will split it. Different consequences, so they
          // read differently.
          "circle-radius": 7,
          "circle-color": ["case", ["==", ["get", "kind"], "vertex"], "#2196f3", "#ff9800"],
          "circle-opacity": 0.9,
          // A halo, so the marker stays legible on top of the line it sits on.
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#ffffff",
        },
      });
    }
  }, [mapRef]);

  const showIndicator = useCallback(
    (target: SnapTarget | null) => {
      const map = mapRef?.current?.getMap();
      if (!map) return;
      // Nothing to show and nothing showing: do not re-create a layer that the
      // session has already torn down.
      if (!target && !map.getSource(INDICATOR_SOURCE)) return;
      ensureIndicator();
      const source = map.getSource(INDICATOR_SOURCE);
      if (!source) return;
      const data: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: target
          ? [
              {
                type: "Feature",
                properties: { kind: target.kind },
                geometry: { type: "Point", coordinates: target.position },
              },
            ]
          : [],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (source as any).setData(data);
      // Re-assert the top of the stack on every update rather than trusting the
      // insertion order: a remounted project layer is appended above whatever
      // was added before it, which buries the marker under the very edge it is
      // pointing at.
      try {
        map.moveLayer(INDICATOR_LAYER);
      } catch {
        /* the layer went away with a style change; the next call re-adds it */
      }
    },
    [mapRef, ensureIndicator]
  );

  useEffect(() => {
    const map = mapRef?.current?.getMap();
    if (!map || !enabled) return;

    ensureIndicator();
    // Not `once`: a basemap switch rebuilds the style and takes the layer with
    // it, and the session is still running.
    map.on("styledata", ensureIndicator);

    const onMouseMove = (event: { lngLat: { lng: number; lat: number } }) => {
      // Idle hovering is not a question about where an endpoint will land, so
      // the marker only appears once a gesture is under way.
      if (!isEditingGesture()) {
        showIndicator(null);
        return;
      }
      showIndicator(targetFor([event.lngLat.lng, event.lngLat.lat]));
    };
    map.on("mousemove", onMouseMove);

    return () => {
      map.off("mousemove", onMouseMove);
      map.off("styledata", ensureIndicator);
      if (map.getLayer(INDICATOR_LAYER)) map.removeLayer(INDICATOR_LAYER);
      if (map.getSource(INDICATOR_SOURCE)) map.removeSource(INDICATOR_SOURCE);
    };
  }, [mapRef, enabled, targetFor, showIndicator, ensureIndicator, isEditingGesture]);

  return { snapDrawnLine, showIndicator };
}

export default useEdgeSnapping;
