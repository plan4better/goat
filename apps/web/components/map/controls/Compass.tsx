"use client";

// The compass (3D spec 7.1, 8.1), with MapLibre's NavigationControl compass behaviour (`visualizePitch`) in GOAT's
// round map button: shown in 3D and on a rotated map. Its needle shows the heading and the tilt. A click turns the map
// to face north and lays it flat (`resetNorthPitch`), staying in 3D; dragging it turns the map (across) and tilts it
// (up and down), as MapLibre's control does. 2D is chosen in the View button.
import { Fab, Tooltip, useTheme } from "@mui/material";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";

import { shownMode } from "@/lib/scene/support";

import { useAppSelector } from "@/hooks/store/ContextHooks";

/** Below half a degree the map counts as facing north. */
const EPSILON = 0.5;
/** A press that moves less than this is a click (MapLibre's click tolerance). */
export const DRAG_THRESHOLD_PX = 3;
/** Degrees per pixel dragged, as MapLibre's mouse rotate and pitch handlers. */
export const TURN_PER_PX = 0.8;
export const TILT_PER_PX = 0.5;

/** The needle as MapLibre draws it with `visualizePitch`: tilted with the map, turned against the bearing. */
export const needleTransform = (pitch: number, bearing: number) =>
  `scale(${1 / Math.pow(Math.cos(pitch * (Math.PI / 180)), 0.5)}) rotateX(${pitch}deg) rotateZ(${-bearing}deg)`;

export function Compass() {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { map: mapRef } = useMap();
  const map = mapRef?.getMap();
  // The mode the map shows: a saved 3D view is flat where 3D would be drawn in software.
  const mode = shownMode(useAppSelector((state) => state.map.view?.mode ?? "2d"));
  const [camera, setCamera] = useState({ pitch: 0, bearing: 0 });
  // A press on the compass: where it started, and whether it moved far enough to be a drag.
  const press = useRef<{ x: number; y: number; bearing: number; pitch: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    if (!map) return;
    const read = () => {
      const pitch = map.getPitch();
      const bearing = map.getBearing();
      setCamera((prev) => (prev.pitch === pitch && prev.bearing === bearing ? prev : { pitch, bearing }));
    };
    read();
    map.on("move", read);
    return () => {
      map.off("move", read);
    };
  }, [map]);

  const rotated = Math.abs(camera.bearing) > EPSILON && Math.abs(camera.bearing) < 360 - EPSILON;
  if (!map || (mode !== "3d" && !rotated)) return null;
  const tilt = Math.round(camera.pitch);
  const heading = Math.round(((camera.bearing % 360) + 360) % 360) % 360;
  const points = (t("view3d.compass_points") as string).split(",");
  const action = t("view3d.compass_action");
  const label = rotated
    ? t("view3d.compass_rotated", { heading, point: points[Math.round(heading / 45) % 8], tilt, action })
    : t("view3d.compass_north", { tilt, action });

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer without capture (a synthetic event) still works.
    }
    dragged.current = false;
    press.current = {
      x: event.clientX,
      y: event.clientY,
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      moved: false,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p) return;
    const dx = event.clientX - p.x;
    const dy = event.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    p.moved = true;
    // MapLibre keeps the pitch within the map's limit (0 in 2D, 85 in 3D).
    map.jumpTo({ bearing: p.bearing + dx * TURN_PER_PX, pitch: Math.max(0, p.pitch - dy * TILT_PER_PX) });
  };
  const onPointerUp = () => {
    dragged.current = !!press.current?.moved;
    press.current = null;
  };
  const onClick = () => {
    // The click that ends a drag does nothing more.
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    map.resetNorthPitch();
  };

  return (
    <Tooltip title={action} arrow placement="left">
      <Fab
        size="small"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        sx={{
          pointerEvents: "all",
          touchAction: "none",
          backgroundColor: theme.palette.background.paper,
          color: theme.palette.action.active,
          "&:hover": { backgroundColor: theme.palette.background.default },
        }}>
        <svg
          viewBox="0 0 24 24"
          width={28}
          height={28}
          aria-hidden="true"
          data-testid="compass-needle"
          style={{ transform: needleTransform(camera.pitch, camera.bearing) }}>
          <path d="M12 2.5 15.2 12H8.8z" fill={theme.palette.error.main} />
          <path d="M12 21.5 8.8 12h6.4z" fill="currentColor" />
        </svg>
      </Fab>
    </Tooltip>
  );
}
