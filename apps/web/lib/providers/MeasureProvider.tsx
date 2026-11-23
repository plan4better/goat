"use client";

import MapboxDraw from "@mapbox/mapbox-gl-draw";
import area from "@turf/area";
import bbox from "@turf/bbox";
import turfCircle from "@turf/circle";
import distance from "@turf/distance";
import { point } from "@turf/helpers";
import length from "@turf/length";
import type { MapMouseEvent } from "maplibre-gl";
import React, { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";
import { v4 as uuidv4 } from "uuid";

import { findSnapTarget, setSnapConfig } from "@p4b/draw";

import {
  type MeasureToolType,
  type Measurement,
  addMeasurement,
  clearMeasurements,
  removeMeasurement,
  setActiveMeasureTool,
  setIsMapGetInfoActive,
  setMapCursor,
  setSelectedMeasurementId,
  updateMeasurement,
} from "@/lib/store/map/slice";
import { projectGeometryLayerIds } from "@/lib/style/render/viewLayers";
import { drawEvents } from "@/lib/utils/map/drawEvents";
import {
  formatArea as formatAreaByUnit,
  formatDistance as formatDistanceByUnit,
  resolveUnitSystem,
} from "@/lib/utils/measurementUnits";
import type { UnitPreference } from "@/lib/utils/measurementUnits";

import { usePreferredUnitSystem } from "@/hooks/settings/usePreferredUnitSystem";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { DrawModes } from "@/components/map/controls/Draw";

import { useDraw } from "./DrawProvider";

// ============================================================================
// Measure Context - measurement-specific logic
// ============================================================================

interface MeasureContextType {
  startMeasuring: (tool: MeasureToolType) => void;
  stopMeasuring: () => void;
  deactivateTool: () => void;
  activeTool: MeasureToolType | undefined;
  selectMeasurement: (measurementId: string) => void;
  deleteMeasurement: (measurementId: string) => void;
  setMeasurementUnitSystem: (measurementId: string, unitSystem: UnitPreference) => void;
  zoomToMeasurement: (measurementId: string) => void;
}

const MeasureContext = createContext<MeasureContextType | undefined>(undefined);

const SNAP_INDICATOR_SOURCE_ID = "__measure-snap-indicator";
const SNAP_INDICATOR_LAYER_ID = "__measure-snap-indicator-layer";
const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export const MeasureProvider = ({ children }: { children: ReactNode }) => {
  const { map } = useMap();
  const { drawControl } = useDraw();
  const dispatch = useAppDispatch();
  const activeTool = useAppSelector((state) => state.map.activeMeasureTool);
  const measurements = useAppSelector((state) => state.map.measurements);
  const snapEnabled = useAppSelector((state) => state.map.measureSnapEnabled);
  const activeToolRef = useRef(activeTool);
  const measurementsRef = useRef(measurements);
  const { i18n } = useTranslation();
  const locale = i18n.language || "en-US";

  // Candidate map style layer ids: the project layers' geometry, from the
  // renderer's registry (basemap, labels and internal layers are left out).
  const [candidateSnapLayerIds, setCandidateSnapLayerIds] = useState<string[]>([]);

  useEffect(() => {
    if (!map) return;
    const m = map.getMap();

    const refresh = () => {
      const ids = projectGeometryLayerIds(m);
      setCandidateSnapLayerIds((prev) => {
        if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return prev;
        return ids;
      });
    };

    refresh();
    m.on("styledata", refresh);
    return () => {
      m.off("styledata", refresh);
    };
  }, [map]);

  // Push snap config into @p4b/draw.
  useEffect(() => {
    setSnapConfig({
      enabled: snapEnabled,
      layerIds: candidateSnapLayerIds,
      toleranceInPx: 12,
    });
  }, [candidateSnapLayerIds, snapEnabled]);

  // Reset snap config when the provider unmounts so other parts of the app
  // (or a different map instance) don't inherit stale state.
  useEffect(() => {
    return () => {
      setSnapConfig({ enabled: false, layerIds: [] });
    };
  }, []);

  // Snap indicator source/layer — a small ring at the snap target.
  useEffect(() => {
    if (!map) return;
    const m = map.getMap();

    const ensure = () => {
      try {
        if (!m.getSource(SNAP_INDICATOR_SOURCE_ID)) {
          m.addSource(SNAP_INDICATOR_SOURCE_ID, {
            type: "geojson",
            data: EMPTY_FC,
          });
        }
        if (!m.getLayer(SNAP_INDICATOR_LAYER_ID)) {
          m.addLayer({
            id: SNAP_INDICATOR_LAYER_ID,
            type: "circle",
            source: SNAP_INDICATOR_SOURCE_ID,
            paint: {
              "circle-radius": 8,
              "circle-color": "rgba(239, 68, 68, 0.25)",
              "circle-stroke-color": "#ef4444",
              "circle-stroke-width": 2,
            },
          });
        }
        // Keep the indicator on top — but only when it isn't already there.
        // moveLayer fires styledata synchronously, so calling it
        // unconditionally inside the styledata listener recurses forever.
        const styleLayers = m.getStyle()?.layers ?? [];
        const lastId = styleLayers[styleLayers.length - 1]?.id;
        if (lastId !== SNAP_INDICATOR_LAYER_ID) {
          m.moveLayer(SNAP_INDICATOR_LAYER_ID);
        }
      } catch {
        // styledata can fire mid-transition; ignore and rely on the next tick
      }
    };

    if (m.isStyleLoaded()) ensure();
    m.on("styledata", ensure);
    return () => {
      m.off("styledata", ensure);
      try {
        if (m.getLayer(SNAP_INDICATOR_LAYER_ID)) m.removeLayer(SNAP_INDICATOR_LAYER_ID);
        if (m.getSource(SNAP_INDICATOR_SOURCE_ID)) m.removeSource(SNAP_INDICATOR_SOURCE_ID);
      } catch {
        // best-effort cleanup
      }
    };
  }, [map]);

  // Live snap indicator: while a measurement tool is active and snap is
  // enabled, follow the cursor and show a marker at the candidate snap point.
  useEffect(() => {
    if (!map) return;
    const m = map.getMap();

    const clearIndicator = () => {
      const source = m.getSource(SNAP_INDICATOR_SOURCE_ID) as
        | { setData: (d: GeoJSON.FeatureCollection) => void }
        | undefined;
      source?.setData(EMPTY_FC);
    };

    if (!activeTool || !snapEnabled) {
      clearIndicator();
      return;
    }

    const onMove = (e: MapMouseEvent) => {
      const target = findSnapTarget(m, e.point);
      const source = m.getSource(SNAP_INDICATOR_SOURCE_ID) as
        | { setData: (d: GeoJSON.FeatureCollection) => void }
        | undefined;
      if (!source) return;
      if (target) {
        source.setData({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [target.lng, target.lat] },
              properties: {},
            },
          ],
        });
      } else {
        source.setData(EMPTY_FC);
      }
    };

    m.on("mousemove", onMove);
    return () => {
      m.off("mousemove", onMove);
      clearIndicator();
    };
  }, [map, activeTool, snapEnabled]);

  // Keep ref in sync with state
  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

  // Keep measurements ref in sync
  useEffect(() => {
    measurementsRef.current = measurements;
  }, [measurements]);

  const { unit: systemUnit } = usePreferredUnitSystem();

  const formatDistanceValue = useCallback(
    (meters: number, unitPreference?: UnitPreference): string => {
      const resolvedUnit = resolveUnitSystem(unitPreference, systemUnit);
      return formatDistanceByUnit(meters, resolvedUnit, locale);
    },
    [locale, systemUnit]
  );

  const formatAreaValue = useCallback(
    (squareMeters: number, unitPreference?: UnitPreference): string => {
      const resolvedUnit = resolveUnitSystem(unitPreference, systemUnit);
      return formatAreaByUnit(squareMeters, resolvedUnit, locale);
    },
    [locale, systemUnit]
  );

  const calculateMeasurement = useCallback(
    (
      feature: GeoJSON.Feature,
      toolType: MeasureToolType,
      drawFeatureId: string,
      options?: { unitSystem?: UnitPreference }
    ): Measurement | null => {
      const id = uuidv4();
      const geometry = feature.geometry;
      const unitSystem = options?.unitSystem ?? "default";

      switch (toolType) {
        case "line": {
          if (geometry.type !== "LineString") return null;
          const lineLength = length(feature as GeoJSON.Feature<GeoJSON.LineString>, { units: "meters" });
          return {
            id,
            drawFeatureId,
            type: "line",
            value: lineLength,
            formattedValue: formatDistanceValue(lineLength, unitSystem),
            geometry,
            unitSystem,
          };
        }
        case "distance": {
          // Flight distance - geodesic (great circle) distance along all waypoints
          if (geometry.type !== "LineString") return null;
          const coords = geometry.coordinates;
          if (coords.length < 2) return null;
          // Sum geodesic distances between consecutive waypoints
          let totalFlightDistance = 0;
          for (let i = 0; i < coords.length - 1; i++) {
            const p1 = point(coords[i] as [number, number]);
            const p2 = point(coords[i + 1] as [number, number]);
            totalFlightDistance += distance(p1, p2, { units: "meters" });
          }
          return {
            id,
            drawFeatureId,
            type: "distance",
            value: totalFlightDistance,
            formattedValue: formatDistanceValue(totalFlightDistance, unitSystem),
            geometry,
            unitSystem,
          };
        }
        case "area": {
          if (geometry.type !== "Polygon") return null;
          const polygonArea = area(feature as GeoJSON.Feature<GeoJSON.Polygon>);
          // Calculate perimeter by summing distances between consecutive points
          const polygonCoords = geometry.coordinates[0];
          let perimeter = 0;
          for (let i = 0; i < polygonCoords.length - 1; i++) {
            const p1 = point(polygonCoords[i] as [number, number]);
            const p2 = point(polygonCoords[i + 1] as [number, number]);
            perimeter += distance(p1, p2, { units: "meters" });
          }
          return {
            id,
            drawFeatureId,
            type: "area",
            value: polygonArea,
            formattedValue: formatAreaValue(polygonArea, unitSystem),
            geometry,
            unitSystem,
            properties: {
              perimeter,
              formattedPerimeter: formatDistanceValue(perimeter, unitSystem),
            },
          };
        }
        case "circle": {
          // Circle is stored as a LineString (radius line) with circle metadata
          // The geometry is: [center, edge] - two points defining center and radius
          if (geometry.type !== "LineString") return null;
          const coords = (geometry as GeoJSON.LineString).coordinates;
          if (coords.length < 2) return null;

          const center = coords[0] as [number, number];
          const edge = coords[1] as [number, number];

          // Get properties from the feature (set by measure-circle mode)
          const props = feature.properties || {};
          const radiusKm = props.radiusInKm ?? distance(point(center), point(edge), { units: "kilometers" });
          const radiusMeters = radiusKm * 1000;

          // Generate circle polygon for area calculation
          const circlePolygon = turfCircle(center, radiusKm, { units: "kilometers", steps: 64 });
          const circleArea = area(circlePolygon);
          const perimeter = 2 * Math.PI * radiusMeters;
          const azimuth = props.azimuthDegrees ?? 0;

          return {
            id,
            drawFeatureId,
            type: "circle",
            value: circleArea,
            formattedValue: formatAreaValue(circleArea, unitSystem),
            geometry: circlePolygon.geometry, // Store the calculated polygon geometry for display
            unitSystem,
            properties: {
              radius: radiusMeters,
              formattedRadius: formatDistanceValue(radiusMeters, unitSystem),
              perimeter,
              formattedPerimeter: formatDistanceValue(perimeter, unitSystem),
              azimuth,
              formattedAzimuth: `${azimuth.toFixed(1)}°`,
              center,
            },
          };
        }
        case "walking":
        case "car": {
          // Routing-based measurements - extract route data from feature properties
          if (geometry.type !== "LineString") return null;
          const props = feature.properties || {};

          // Route data is stored by the routing mode
          const routeDistance = props.routeDistance; // in meters
          const routeDuration = props.routeDuration; // in seconds
          const routeLegs = props.routeLegs; // array of leg details

          if (routeDistance === undefined || routeDuration === undefined) {
            // If route data is not available, return null
            return null;
          }

          // Format duration as days, hours and minutes
          const totalMinutes = Math.floor(routeDuration / 60);
          const totalHours = Math.floor(totalMinutes / 60);
          const days = Math.floor(totalHours / 24);
          const hours = totalHours % 24;
          const minutes = totalMinutes % 60;

          let formattedDuration = "";
          if (days > 0) {
            formattedDuration = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
          } else if (hours > 0) {
            formattedDuration = minutes > 0 ? `${hours}h ${minutes}min` : `${hours}h`;
          } else {
            formattedDuration = `${minutes}min`;
          }

          return {
            id,
            drawFeatureId,
            type: toolType,
            value: routeDistance,
            formattedValue: formatDistanceValue(routeDistance, unitSystem),
            geometry,
            unitSystem,
            properties: {
              routeDistance: routeDistance,
              duration: routeDuration,
              formattedDuration,
              legs: routeLegs,
            },
          };
        }
        default:
          return null;
      }
    },
    [formatDistanceValue, formatAreaValue]
  );

  // Handle draw.create event
  const handleFeatureCreate = useCallback(
    (e: { features: GeoJSON.Feature[] }) => {
      const feature = e.features[0] as GeoJSON.Feature & { id?: string };
      const currentTool = activeToolRef.current;

      if (!feature || !currentTool) return;

      // For routing features, skip creating measurement here
      // They will be created via UPDATE event when route data is ready
      const isRoutingTool = currentTool === "walking" || currentTool === "car";

      if (!isRoutingTool) {
        const drawFeatureId = feature.id || uuidv4();
        const measurement = calculateMeasurement(feature, currentTool, drawFeatureId);
        if (measurement) {
          dispatch(addMeasurement(measurement));
          // Select the newly created measurement
          dispatch(setSelectedMeasurementId(measurement.id));
        }
      }

      // After measurement complete: deactivate tool, select feature for editing
      setTimeout(() => {
        if (drawControl && feature.id) {
          // Check if the feature still exists in draw before switching modes
          const existingFeature = drawControl.get(feature.id as string);
          if (existingFeature) {
            // Switch to direct_select mode to enable editing the feature
            drawControl.changeMode(MapboxDraw.constants.modes.DIRECT_SELECT, {
              featureId: feature.id,
            });
          }
        }
        // Deactivate the measurement tool
        dispatch(setActiveMeasureTool(undefined));
        // Reset cursor since we're no longer in drawing mode
        dispatch(setMapCursor(undefined));
        // Re-enable map interactivity when not actively drawing
        dispatch(setIsMapGetInfoActive(true));
      }, 100);
    },
    [calculateMeasurement, dispatch, drawControl]
  );

  // Get the MapboxDraw mode for a measure tool type
  const getDrawMode = useCallback((tool: MeasureToolType): string => {
    switch (tool) {
      case "line":
        return DrawModes.LINE_STRING;
      case "distance":
        return DrawModes.GREAT_CIRCLE;
      case "area":
        return DrawModes.POLYGON;
      case "circle":
        return DrawModes.CIRCLE;
      case "walking":
        return DrawModes.ROUTE_WALKING;
      case "car":
        return DrawModes.ROUTE_CAR;
      default:
        return MapboxDraw.constants.modes.SIMPLE_SELECT;
    }
  }, []);

  // Start measuring with a specific tool
  const startMeasuring = useCallback(
    (tool: MeasureToolType) => {
      if (!drawControl || !map) return;

      // Set the draw mode (don't clear existing drawings)
      const mode = getDrawMode(tool);
      drawControl.changeMode(mode);

      // Set crosshair cursor
      dispatch(setMapCursor("crosshair"));

      // Disable map info popup
      dispatch(setIsMapGetInfoActive(false));

      // Set active tool in Redux
      dispatch(setActiveMeasureTool(tool));
    },
    [drawControl, map, dispatch, getDrawMode]
  );

  // Deactivate the current tool without clearing measurements
  const deactivateTool = useCallback(() => {
    if (drawControl) {
      drawControl.changeMode(MapboxDraw.constants.modes.SIMPLE_SELECT);
    }

    // Reset cursor
    dispatch(setMapCursor(undefined));

    // Re-enable map info interactions when tool is inactive
    dispatch(setIsMapGetInfoActive(true));

    // Clear active tool
    dispatch(setActiveMeasureTool(undefined));
  }, [drawControl, dispatch]);

  // Stop measuring and clean up all measurements
  const stopMeasuring = useCallback(() => {
    if (drawControl) {
      drawControl.deleteAll();
      drawControl.changeMode(MapboxDraw.constants.modes.SIMPLE_SELECT);
    }

    // Reset cursor
    dispatch(setMapCursor(undefined));

    // Re-enable map info popup
    dispatch(setIsMapGetInfoActive(true));

    // Clear active tool
    dispatch(setActiveMeasureTool(undefined));

    // Clear selection
    dispatch(setSelectedMeasurementId(undefined));

    // Clear all measurements from Redux
    dispatch(clearMeasurements());
  }, [drawControl, dispatch]);

  // Select a measurement and put its feature in edit mode
  const selectMeasurement = useCallback(
    (measurementId: string) => {
      const measurement = measurementsRef.current.find((m) => m.id === measurementId);
      if (!measurement || !drawControl) return;

      dispatch(setSelectedMeasurementId(measurementId));

      // Put the feature in direct_select mode for editing
      drawControl.changeMode(MapboxDraw.constants.modes.DIRECT_SELECT, {
        featureId: measurement.drawFeatureId,
      });
    },
    [drawControl, dispatch]
  );

  // Delete a measurement and its associated draw feature
  const deleteMeasurement = useCallback(
    (measurementId: string) => {
      const measurement = measurementsRef.current.find((m) => m.id === measurementId);
      if (!measurement) return;

      // Delete the draw feature
      if (drawControl) {
        drawControl.delete(measurement.drawFeatureId);
      }

      // Remove from Redux
      dispatch(removeMeasurement(measurementId));
    },
    [drawControl, dispatch]
  );

  const setMeasurementUnitSystem = useCallback(
    (measurementId: string, unitSystem: UnitPreference) => {
      const measurement = measurementsRef.current.find((m) => m.id === measurementId);
      if (!measurement) return;

      const formattedValue =
        measurement.type === "area" || measurement.type === "circle"
          ? formatAreaValue(measurement.value, unitSystem)
          : formatDistanceValue(measurement.value, unitSystem);

      const updatedProperties = measurement.properties
        ? {
            ...measurement.properties,
            formattedPerimeter:
              measurement.properties.perimeter !== undefined
                ? formatDistanceValue(measurement.properties.perimeter, unitSystem)
                : measurement.properties.formattedPerimeter,
            formattedRadius:
              measurement.properties.radius !== undefined
                ? formatDistanceValue(measurement.properties.radius, unitSystem)
                : measurement.properties.formattedRadius,
            // Azimuth doesn't change with unit system, but preserve it
            formattedAzimuth:
              measurement.properties.azimuth !== undefined
                ? `${measurement.properties.azimuth.toFixed(1)}°`
                : measurement.properties.formattedAzimuth,
          }
        : undefined;

      dispatch(
        updateMeasurement({
          ...measurement,
          unitSystem,
          formattedValue,
          properties: updatedProperties,
        })
      );
    },
    [dispatch, formatAreaValue, formatDistanceValue]
  );

  const zoomToMeasurement = useCallback(
    (measurementId: string) => {
      if (!map) return;

      const measurement = measurementsRef.current.find((m) => m.id === measurementId);
      if (!measurement) return;

      const feature: GeoJSON.Feature = {
        type: "Feature",
        geometry: measurement.geometry,
        properties: {},
      };

      try {
        const [minLng, minLat, maxLng, maxLat] = bbox(feature);
        const hasExtent = [minLng, minLat, maxLng, maxLat].every((value) => Number.isFinite(value));
        if (!hasExtent) {
          return;
        }

        const isPoint = minLng === maxLng && minLat === maxLat;
        if (isPoint) {
          map.easeTo({
            center: [minLng, minLat],
            zoom: Math.max(map.getZoom() ?? 0, 16),
            duration: 600,
          });
          return;
        }

        map.fitBounds(
          [
            [minLng, minLat],
            [maxLng, maxLat],
          ],
          {
            padding: 80,
            duration: 600,
            maxZoom: 18,
          }
        );
      } catch {
        // If bbox fails, fall back to easing to the first coordinate if available
        const center = (() => {
          const geometry = measurement.geometry;
          if (geometry.type === "LineString") {
            const coords = geometry.coordinates;
            return coords[Math.floor(coords.length / 2)] as [number, number];
          }
          if (geometry.type === "Polygon") {
            const coords = geometry.coordinates[0];
            return coords[0] as [number, number];
          }
          return null;
        })();

        if (center) {
          map.easeTo({ center, duration: 600 });
        }
      }
    },
    [map]
  );

  // Handle draw selection change to sync with Redux and enter edit mode
  const handleSelectionChange = useCallback(
    (e: { features: GeoJSON.Feature[] }) => {
      if (e.features.length === 0) {
        dispatch(setSelectedMeasurementId(undefined));
        return;
      }

      const selectedFeature = e.features[0] as GeoJSON.Feature & { id?: string };
      if (!selectedFeature.id) return;

      // Find the measurement that corresponds to this draw feature
      const measurement = measurementsRef.current.find((m) => m.drawFeatureId === selectedFeature.id);
      if (measurement) {
        dispatch(setSelectedMeasurementId(measurement.id));

        // Switch to direct_select mode to allow vertex editing
        // Use setTimeout to avoid interfering with the current selection event
        setTimeout(() => {
          if (drawControl && selectedFeature.id) {
            const currentMode = drawControl.getMode();
            // Only switch if we're in simple_select (not already in direct_select)
            if (currentMode === MapboxDraw.constants.modes.SIMPLE_SELECT) {
              drawControl.changeMode(MapboxDraw.constants.modes.DIRECT_SELECT, {
                featureId: selectedFeature.id,
              });
            }
          }
        }, 0);
      }
    },
    [dispatch, drawControl]
  );

  // Handle feature update (when user edits vertices)
  const handleFeatureUpdate = useCallback(
    (e: { features: GeoJSON.Feature[]; action: string }) => {
      if (e.action !== "change_coordinates") return;

      const updatedFeature = e.features[0] as GeoJSON.Feature & { id?: string };
      if (!updatedFeature.id) return;

      // Find the measurement that corresponds to this draw feature
      const measurement = measurementsRef.current.find((m) => m.drawFeatureId === updatedFeature.id);

      if (!measurement) {
        // Measurement doesn't exist yet - this happens for routing features
        // when drawing fast (CREATE fires before route calculation completes)
        const props = updatedFeature.properties || {};
        const isRoutingFeature = props.routingProfile || props.isRoutedFeature;

        if (isRoutingFeature && props.routeDistance !== undefined && props.routeDuration !== undefined) {
          // Now we have route data, create the measurement
          const profile = props.routingProfile;
          const toolType: MeasureToolType = profile === "car" || profile === "CAR" ? "car" : "walking";

          const newMeasurement = calculateMeasurement(updatedFeature, toolType, updatedFeature.id, {
            unitSystem: "default",
          });

          if (newMeasurement) {
            dispatch(addMeasurement(newMeasurement));
            // Don't auto-select since user might have moved on
          }
        }
        return;
      }

      // Recalculate the measurement with the new geometry
      const updatedMeasurement = calculateMeasurement(
        updatedFeature,
        measurement.type,
        measurement.drawFeatureId,
        {
          unitSystem: measurement.unitSystem,
        }
      );
      if (updatedMeasurement) {
        // Keep the same id but update everything else
        dispatch(
          updateMeasurement({
            ...updatedMeasurement,
            id: measurement.id,
          })
        );
      }
    },
    [calculateMeasurement, dispatch]
  );

  // Set up event listeners
  useEffect(() => {
    if (!map || !drawControl) return;

    // Always listen for selection and update events when there are measurements
    drawEvents(map).on(MapboxDraw.constants.events.SELECTION_CHANGE, handleSelectionChange);
    drawEvents(map).on(MapboxDraw.constants.events.UPDATE, handleFeatureUpdate);

    // Only listen for create when actively measuring
    if (activeTool) {
      drawEvents(map).on(MapboxDraw.constants.events.CREATE, handleFeatureCreate);
    }

    return () => {
      drawEvents(map).off(MapboxDraw.constants.events.SELECTION_CHANGE, handleSelectionChange);
      drawEvents(map).off(MapboxDraw.constants.events.UPDATE, handleFeatureUpdate);
      if (activeTool) {
        drawEvents(map).off(MapboxDraw.constants.events.CREATE, handleFeatureCreate);
      }
    };
  }, [map, drawControl, activeTool, handleFeatureCreate, handleSelectionChange, handleFeatureUpdate]);

  const hasMeasurements = measurements.length > 0;

  // Set up pointer cursor on hover over measurement features and handle click-to-select
  useEffect(() => {
    if (!map || !drawControl) return;

    // Don't show pointer cursor when actively drawing
    if (activeTool) return;

    // Only show pointer if there are measurements
    if (!hasMeasurements) {
      map.getCanvas().style.cursor = "";
      return;
    }

    const handleMouseMove = (e: MapMouseEvent) => {
      // Query draw features at the mouse position
      const features = drawControl.getFeatureIdsAt(e.point);

      if (features.length > 0) {
        map.getCanvas().style.cursor = "pointer";
      } else {
        map.getCanvas().style.cursor = "";
      }
    };

    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = "";
    };

    // Track which feature we want to select on mousedown (before MapboxDraw processes the click)
    let pendingFeatureId: string | null = null;

    const handleMouseDown = (e: MapMouseEvent) => {
      const featuresAtPoint = drawControl.getFeatureIdsAt(e.point);
      if (featuresAtPoint.length === 0) {
        pendingFeatureId = null;
        return;
      }

      const clickedFeatureId = featuresAtPoint[0];
      const currentMode = drawControl.getMode();

      // If we're in direct_select mode and clicking on a different feature,
      // remember which feature to select
      if (currentMode === MapboxDraw.constants.modes.DIRECT_SELECT) {
        const selected = drawControl.getSelected();
        const currentSelectedId = selected.features[0]?.id;

        if (currentSelectedId && currentSelectedId !== clickedFeatureId) {
          pendingFeatureId = clickedFeatureId;
        } else {
          pendingFeatureId = null;
        }
      } else {
        pendingFeatureId = null;
      }
    };

    // After MapboxDraw processes the click, switch to the pending feature if needed
    const handleClick = (e: MapMouseEvent) => {
      const featureIdsAtPoint = drawControl.getFeatureIdsAt(e.point);
      const clickedMeasurement = featureIdsAtPoint.length > 0;

      if (clickedMeasurement) {
        e.preventDefault();
        const originalEvent = e.originalEvent as MouseEvent | undefined;
        if (originalEvent) {
          originalEvent.stopPropagation();
          originalEvent.preventDefault();
          originalEvent.cancelBubble = true;
        }
      }

      if (pendingFeatureId) {
        const featureId = pendingFeatureId;
        pendingFeatureId = null;

        // Use setTimeout to let MapboxDraw finish its processing
        setTimeout(() => {
          drawControl.changeMode(MapboxDraw.constants.modes.DIRECT_SELECT, {
            featureId: featureId,
          });

          // Update Redux selection
          const measurement = measurementsRef.current.find((m) => m.drawFeatureId === featureId);
          if (measurement) {
            dispatch(setSelectedMeasurementId(measurement.id));
          }
        }, 0);
      }
    };

    map.on("mousemove", handleMouseMove);
    map.on("mouseout", handleMouseLeave);
    map.on("mousedown", handleMouseDown);
    map.on("click", handleClick);

    return () => {
      map.off("mousemove", handleMouseMove);
      map.off("mouseout", handleMouseLeave);
      map.off("mousedown", handleMouseDown);
      map.off("click", handleClick);
      map.getCanvas().style.cursor = "";
    };
  }, [map, drawControl, activeTool, dispatch, hasMeasurements]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (activeToolRef.current) {
        stopMeasuring();
      }
    };
  }, [stopMeasuring]);

  return (
    <MeasureContext.Provider
      value={{
        startMeasuring,
        stopMeasuring,
        deactivateTool,
        activeTool,
        selectMeasurement,
        deleteMeasurement,
        setMeasurementUnitSystem,
        zoomToMeasurement,
      }}>
      {children}
    </MeasureContext.Provider>
  );
};

export const useMeasure = () => {
  const context = useContext(MeasureContext);
  if (!context) {
    throw new Error("useMeasure must be used within a MeasureProvider");
  }
  return context;
};
