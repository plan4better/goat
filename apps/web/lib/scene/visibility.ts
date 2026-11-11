// Whether a scene section shows at the current camera (MapLibre 6.16): the globe renders below the end of its handover
// to mercator (`GLOBE_HANDOVER`), and while it renders MapLibre draws no fog and the sky is seen from space; a set fog
// shows on terrain from a tilt of 60 (full at 70; the automatic fog is none); the sky band shows above the horizon
// from a tilt of about 69; the globe glow only around the globe. The light always shows (buildings, hillshades).

/**
 * The zooms over which a map with Globe on hands the globe over to mercator: the globe in full below `from`, flattening
 * on the way to `until`, mercator from `until` on. The compiled projection, the terrain's rise, the globe's depth range
 * and every "while the globe draws" decision follow it.
 */
export const GLOBE_HANDOVER = { from: 8, until: 9 } as const;
/** From this zoom a map with Globe on draws in mercator. */
export const GLOBE_UNTIL_ZOOM = GLOBE_HANDOVER.until;
/** Fog shows on terrain from this tilt. */
export const FOG_FROM_PITCH = 60;
/** The horizon, and the sky band above it, comes into view from this tilt. */
export const SKY_FROM_PITCH = 69;

export interface CameraLook {
  mode: "2d" | "3d";
  projection: "mercator" | "globe";
  zoom: number;
  pitch: number;
  /** Terrain is on (3D with a terrain source and not switched off), wherever it can be shown. */
  terrain: boolean;
  /** A fog is set (the automatic fog is none). */
  fog?: boolean;
}

/** Whether a projection on a map is GOAT's globe (a zoom expression, see `GLOBE_PROJECTION`) or MapLibre's own. */
export const projectionKind = (projection: { type?: unknown } | null | undefined): "mercator" | "globe" =>
  projection?.type === "globe" || Array.isArray(projection?.type) ? "globe" : "mercator";

export type SectionVisibility = Record<"sky" | "fog" | "glow" | "light", boolean>;

/** Whether the globe is drawn at this camera. */
export const rendersGlobe = (look: Pick<CameraLook, "projection" | "zoom">): boolean =>
  look.projection === "globe" && look.zoom < GLOBE_UNTIL_ZOOM;

export function sectionVisibility(look: CameraLook): SectionVisibility {
  const globe = rendersGlobe(look);
  const three = look.mode === "3d";
  return {
    sky: three && !globe && look.pitch >= SKY_FROM_PITCH,
    fog: three && look.terrain && look.fog !== false && !globe && look.pitch >= FOG_FROM_PITCH,
    glow: globe,
    light: true,
  };
}
