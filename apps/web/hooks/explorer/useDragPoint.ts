/**
 * A point on the map dragged by the pointer: pressed on one of `layers`,
 * the map stops panning, the point follows the pointer (`onDrag`, each move,
 * for drawing only), and where it is let go is reported once (`onDrop`),
 * let go on the map or off it. Turned off mid-press, the drag ends with
 * `onDrag(null)` and no drop. A press that does not move is a click, left to
 * the map's click handlers.
 * Both are told the feature pressed on, where one layer holds several points.
 */
import type { MapGeoJSONFeature, MapLayerMouseEvent, Map as MapLibre } from "maplibre-gl";
import { useEffect, useRef } from "react";

/** Pixels the pointer moves before a press is a drag, not a click. */
const DRAG_START_PX = 3;

export function useDragPoint(
  map: MapLibre | undefined,
  layers: string[],
  enabled: boolean,
  onDrag: (lonLat: [number, number] | null, grabbed?: MapGeoJSONFeature) => void,
  onDrop: (lonLat: [number, number], grabbed?: MapGeoJSONFeature) => void
): void {
  // The latest handlers, without re-registering on every render.
  const handlers = useRef({ onDrag, onDrop });
  handlers.current = { onDrag, onDrop };
  const key = layers.join(",");

  useEffect(() => {
    if (!map || !enabled) return;
    const ids = key.split(",");
    let start: { x: number; y: number } | null = null;
    let grabbed: MapGeoJSONFeature | undefined;
    let dragging = false;
    // Where the pointer last was on the map: a press let go off it (over a
    // panel, outside the window) is dropped there.
    let last: [number, number] | null = null;
    const canvas = map.getCanvas();

    const onMove = (e: MapLayerMouseEvent) => {
      if (!start) return;
      last = [e.lngLat.lng, e.lngLat.lat];
      if (!dragging && Math.hypot(e.point.x - start.x, e.point.y - start.y) < DRAG_START_PX) return;
      dragging = true;
      canvas.style.cursor = "grabbing";
      handlers.current.onDrag(last, grabbed);
    };
    /** The press over, wherever it was let go: the map pans again, and a
     * drag is dropped where the pointer last was on the map. */
    const end = (drop: boolean) => {
      map.off("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      map.dragPan.enable();
      canvas.style.cursor = "";
      const was = dragging;
      start = null;
      dragging = false;
      if (was) {
        handlers.current.onDrag(null, grabbed);
        if (drop && last) handlers.current.onDrop(last, grabbed);
      }
    };
    const onUp = () => end(true);
    const onDown = (e: MapLayerMouseEvent) => {
      if (e.originalEvent.button !== 0) return;
      const present = ids.filter((id) => map.getLayer(id));
      if (!present.length) return;
      [grabbed] = map.queryRenderedFeatures(e.point, { layers: present });
      if (!grabbed) return;
      // Ours: the map does not pan while the point is held.
      e.preventDefault();
      map.dragPan.disable();
      start = e.point;
      last = [e.lngLat.lng, e.lngLat.lat];
      map.on("mousemove", onMove);
      // On the window: a press let go off the map ends too.
      window.addEventListener("mouseup", onUp);
    };
    map.on("mousedown", onDown);
    return () => {
      map.off("mousedown", onDown);
      // Turned off mid-press: the press ends, nothing dropped, so no one
      // is left waiting on a drag that never lands.
      if (start) end(false);
    };
  }, [map, key, enabled]);
}
