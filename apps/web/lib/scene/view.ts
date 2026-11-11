// The 2D and 3D camera modes (3D spec 5.1, 7.1).
import { GLOBE_HANDOVER } from "@/lib/scene/visibility";

export type ViewMode = "2d" | "3d";

/** GOAT's steepest tilt in 3D. */
export const MAX_PITCH_3D = 85;

/** Where switching to 3D tilts the map to; the bearing is kept. */
export const ENTER_3D = { pitch: 55 } as const;

/** A view's mode: its own, else 3D when it is tilted. */
export function viewModeOf(view: { mode?: ViewMode | null; pitch?: number | null }): ViewMode {
  if (view.mode === "2d" || view.mode === "3d") return view.mode;
  return (view.pitch ?? 0) > 0 ? "3d" : "2d";
}

/** The map's interaction options in a mode: 2D can neither tilt nor rotate. */
export function cameraFor(mode: ViewMode): {
  maxPitch: number;
  dragRotate: boolean;
  touchPitch: boolean;
  pitchWithRotate: boolean;
} {
  const three = mode === "3d";
  return { maxPitch: three ? MAX_PITCH_3D : 0, dragRotate: three, touchPitch: three, pitchWithRotate: true };
}

/** The mode a page opens a map in: a tilted view from the URL (which carries no mode) in 3D, else the saved mode. */
export function openingMode(
  saved: { mode?: ViewMode | null; pitch?: number | null } | null | undefined,
  urlPitch?: number
): ViewMode {
  if (urlPitch !== undefined && urlPitch > 0) return "3d";
  return viewModeOf({ mode: saved?.mode, pitch: urlPitch ?? saved?.pitch });
}

/**
 * The tilt a page opens a map at: the URL's (a link keeps its tilt), else the saved view's; a 3D view without a tilt
 * (a URL written flat, or a saved 3D view at 0) opens at the 3D entry tilt, so 3D never opens flat.
 */
export function openingPitch(
  saved: { mode?: ViewMode | null; pitch?: number | null } | null | undefined,
  urlPitch?: number
): number {
  if (urlPitch !== undefined && urlPitch > 0) return urlPitch;
  if (openingMode(saved, urlPitch) !== "3d") return 0;
  return saved?.pitch && saved.pitch > 0 ? saved.pitch : ENTER_3D.pitch;
}

/** Web Mercator's latitude limit. */
const MAX_LATITUDE = 85.051129;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * A camera as core stores it (`InitialViewState`): longitude wrapped into -180 (incl.) to 180 (excl.), latitude within
 * Web Mercator's, zoom 0 to 24 (Globe zooms out below 0), pitch 0 to 85, the zoom range whole numbers 0 to 20.
 */
export function storableView(view: {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
  min_zoom?: number | null;
  max_zoom?: number | null;
}): {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
  min_zoom: number;
  max_zoom: number;
} {
  const minZoom = Math.round(clamp(view.min_zoom ?? 0, 0, 20));
  return {
    // Wrapped only when outside, so a stored longitude keeps its digits.
    longitude:
      view.longitude >= -180 && view.longitude < 180
        ? view.longitude
        : ((((view.longitude + 180) % 360) + 360) % 360) - 180,
    latitude: clamp(view.latitude, -MAX_LATITUDE, MAX_LATITUDE),
    zoom: clamp(view.zoom, 0, 24),
    pitch: clamp(view.pitch, 0, MAX_PITCH_3D),
    bearing: view.bearing,
    min_zoom: minZoom,
    max_zoom: Math.max(minZoom, Math.round(clamp(view.max_zoom ?? 20, 0, 20))),
  };
}

/** Below this zoom a 3D globe lies flat; from `PITCH_FULL_AT` it may tilt to the 3D maximum, at the latest where
 * the globe starts handing over to mercator. */
const PITCH_FLAT_UNTIL = 3;
const PITCH_FULL_AT = Math.min(7, GLOBE_HANDOVER.from);

/**
 * The steepest tilt a 3D map on the globe allows at a zoom (as Google Earth tilts back while you zoom out): flat at
 * zoom 3 and below, rising evenly to the 3D maximum at zoom 7, so a zoomed-out globe stays in the middle of the view.
 */
export function maxPitchAtZoom(zoom: number): number {
  if (zoom <= PITCH_FLAT_UNTIL) return 0;
  if (zoom >= PITCH_FULL_AT) return MAX_PITCH_3D;
  return ((zoom - PITCH_FLAT_UNTIL) / (PITCH_FULL_AT - PITCH_FLAT_UNTIL)) * MAX_PITCH_3D;
}

/**
 * The tilt a page opens a map at (`openingPitch`), no steeper than a zoomed-out globe allows (`maxPitchAtZoom`), so
 * the first frame is already the camera the map settles on.
 */
export function openingTilt(
  saved: { mode?: ViewMode | null; pitch?: number | null } | null | undefined,
  urlPitch: number | undefined,
  zoom: number,
  projection: "mercator" | "globe"
): number {
  const pitch = openingPitch(saved, urlPitch);
  return projection === "globe" ? Math.min(pitch, maxPitchAtZoom(zoom)) : pitch;
}
