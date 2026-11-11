// The map-level scene as MapLibre parts (3D spec 7.2 to 7.4): projection, terrain with its hillshade, 3D buildings,
// sky, the one light and the global state the light and every hillshade read. Pure; hooks/map/useScene.ts applies
// the result to a map.
//
// A set light's position and the hillshades' illumination read MapLibre global state (`lightPosition`, `sunAzimuth`,
// `sunAltitude`): MapLibre's validator accepts every shape used here (lib/scene/__tests__/maplibre-shapes.test.ts),
// so moving the light is a state change.
import type {
  LayerSpecification,
  LightSpecification,
  ProjectionSpecification,
  SkySpecification,
  SourceSpecification,
  TerrainSpecification,
} from "maplibre-gl";

import { type AtmosphereColors, lightened } from "@/lib/scene/atmosphere";
import {
  AUTO_LIGHT,
  type AutoLook,
  type EffectiveLight,
  type Tone,
  effectiveLight,
  isAuto,
  sceneForm,
} from "@/lib/scene/auto";
import {
  BUILDINGS_LAYER,
  BUILDINGS_SOURCE,
  type BuildingsPlan,
  buildingsLayer,
  buildingsSetting,
} from "@/lib/scene/buildings";
import type { ViewMode } from "@/lib/scene/view";
import { GLOBE_HANDOVER } from "@/lib/scene/visibility";
import { illumination } from "@/lib/style/compile/rasters";
import { type Expr, combine, fromForm, toProperty, valueAt } from "@/lib/style/compile/values";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { SCENE_DEFAULTS } from "@/lib/style/generated/scene";
import type { Scene } from "@/lib/style/generated/types";

export const TERRAIN_SOURCE = "goat-terrain";
/** The terrain hillshade's own DEM source (same tiles): MapLibre warns when terrain and a hillshade share one. */
export const TERRAIN_HILLSHADE_SOURCE = "goat-terrain-hillshade";
export const TERRAIN_HILLSHADE_LAYER = "goat-terrain-hillshade";
export const TERRAIN_ATTRIBUTION = '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>';
/**
 * The DEM's highest tile zoom; MapLibre overzooms past it. Mapterhorn serves zoom 12 worldwide and up to 16 to 18
 * where finer elevation data exists (zoom 16 across Germany), so tiles past 16 are missing in most places.
 */
export const TERRAIN_MAXZOOM = 16;

/** The colour of GOAT's building extrusion where the basemap gives none. */
const BUILDING_COLOR: Record<Tone, string> = { light: "#d6d6d6", dark: "#3a4250" };

/** How far GOAT's building extrusion on a dark basemap moves from the basemap's building colour towards white: dark
 * basemaps draw their flat buildings about as dark as their ground, which the extruded buildings would vanish into. */
const DARK_BUILDING_LIFT = 0.2;

/** The colour of GOAT's building extrusion: the basemap's building colour, lightened on a dark basemap. */
function buildingColor(basemap: string | undefined, tone: Tone): string {
  if (!basemap) return BUILDING_COLOR[tone];
  return tone === "dark" ? (lightened(basemap, DARK_BUILDING_LIFT) ?? BUILDING_COLOR.dark) : basemap;
}

/** MapLibre's `r` of the light position. */
const LIGHT_RADIUS = 1.15;

export interface SceneInputs {
  scene?: Scene;
  mode: ViewMode;
  projection: "mercator" | "globe";
  tone: Tone;
  /** The automatic horizon and fog colours the basemap's ground gives; none: the tone's. */
  atmosphere?: AtmosphereColors | null;
  terrainUrl?: string;
  buildings: BuildingsPlan;
  /** Whether a drawn project layer raises its features: the basemap's buildings are then off unless asked for. */
  projectExtrudes: boolean;
  /** The basemap is a picture of the ground (no automatic terrain hillshade over it). */
  imagery: boolean;
  /** The camera is zoomed out below `GLOBE_LIGHT_UNTIL_ZOOM`, where the globe's atmosphere shows. */
  zoomedOut?: boolean;
}

/** Below this zoom the globe's atmosphere can show (it fades out with the globe's handover to mercator and with the
 * camera's altitude, which grows with the canvas height: gone by about zoom 10.5 on any screen), and a custom light
 * stands with the camera there; from it on, volumes need the light on the map. */
export const GLOBE_LIGHT_UNTIL_ZOOM = Math.min(11, GLOBE_HANDOVER.until);

export interface SceneState {
  sunAzimuth: number | null;
  sunAltitude: number | null;
  lightPosition: [number, number, number];
}

/** The paint properties the scene sets on a basemap's own building layers: its 3D ones and its flat footprints. */
export type BuildingPaint = Partial<
  Record<"fill-extrusion-opacity" | "fill-extrusion-height" | "fill-extrusion-base", number>
> & { "fill-opacity"?: unknown };

export interface CompiledScene {
  projection: ProjectionSpecification;
  /** The terrain at full height; `terrainAt` gives what the map shows at a zoom. */
  terrain: TerrainSpecification | null;
  sources: Record<string, SourceSpecification>;
  /** GOAT's layers with where they go: before the basemap's roads, or above its ground layers (`Anchors.buildings`). */
  layers: Array<{ layer: LayerSpecification; before: "roads" | "buildings" }>;
  /** Hidden basemap layers to show (a basemap's own 3D buildings); the others keep their own visibility. */
  show: string[];
  /** Paint properties set on a basemap's own building layers, by layer id; the others keep their own. */
  paint: Record<string, BuildingPaint>;
  sky: SkySpecification | null;
  light: LightSpecification | null;
  /** The global state the light and the hillshades read. */
  state: SceneState;
}

/**
 * The lowest 3D building layer the scene shows (GOAT's, else the basemap's first own one), or undefined where it shows
 * none: the project layers drawn on the ground go below it, so they show through the buildings.
 */
export function buildingsAnchor(scene: CompiledScene | null): string | undefined {
  if (!scene) return undefined;
  if (scene.layers.some(({ layer }) => layer.id === BUILDINGS_LAYER)) return BUILDINGS_LAYER;
  return scene.show[0];
}

/** A scene value (fixed or by zoom) as a MapLibre property. */
function property(form: unknown, kind: "number" | "color"): Expr {
  return toProperty(combine([fromForm(form, kind, null)], ([v]) => v, { kind }));
}

/**
 * The global state for the light: MapLibre's light position is `[r, azimuth the light comes from, polar angle from
 * straight above]`, azimuth clockwise from north like GOAT's (pinned with buildings in MapLibre 6.16: azimuth 180 lights
 * the south walls), and the hillshades' illumination direction is the same compass direction. An automatic light
 * leaves the hillshades their own illumination.
 */
export function stateOf(light: EffectiveLight): SceneState {
  const { azimuth, altitude } = light;
  return {
    sunAzimuth: light.mode === "auto" ? null : azimuth,
    sunAltitude: light.mode === "auto" ? null : altitude,
    lightPosition: [LIGHT_RADIUS, azimuth, Number((90 - altitude).toFixed(6))],
  };
}

/** The zooms a set fog takes to come in once the globe has handed over to mercator (MapLibre draws no fog on the
 * globe, so without the fade the whole fog would appear at once). */
export const FOG_FADE_ZOOMS = 1.5;
/** The fade's zoom step for a fog that changes by zoom itself. */
const FOG_FADE_STEP = 0.25;

/**
 * A set fog's ground blend on the globe: none (1, fog only past the horizon) where the globe hands over, reaching the
 * fog's own value `FOG_FADE_ZOOMS` later, its own value from there on. A fixed value fades linearly; a value by
 * zoom is sampled through the fade and keeps its own stops after it.
 */
export function fogGroundOnGlobe(form: unknown): { zoom: Array<[number, number]> } {
  const start = GLOBE_HANDOVER.until;
  const end = start + FOG_FADE_ZOOMS;
  const value = fromForm(form, "number", 1);
  const at = (z: number) => Number(valueAt(value, z));
  const own = isZoomForm(form) ? (form.zoom as Array<[number, unknown]>).map(([z]) => Number(z)) : [];
  const zooms = own.length ? [] : [start, end];
  if (own.length) for (let z = start; z <= end + 1e-9; z += FOG_FADE_STEP) zooms.push(Number(z.toFixed(4)));
  zooms.push(...own.filter((z) => z > end));
  return {
    zoom: zooms.map((z) => {
      const t = Math.min(1, (z - start) / (end - start));
      return [z, Number((1 + (at(z) - 1) * t).toFixed(6))];
    }),
  };
}

const isZoomForm = (form: unknown): form is { zoom: unknown[] } =>
  !!form && typeof form === "object" && Array.isArray((form as { zoom?: unknown }).zoom);

/** No fog: the ground blend at the horizon leaves every pixel of the map as it is (MapLibre fogs only beyond it). */
const NO_FOG = { "horizon-fog-blend": 0, "fog-ground-blend": 1 };

function skyOf(scene: Scene | undefined, look: AutoLook, globe: boolean): SkySpecification {
  const color = (key: string) => property(sceneForm(scene, look, key), "color");
  const number = (key: string) => property(sceneForm(scene, look, key), "number");
  // The automatic fog is none; a set fog comes in after the globe's handover.
  const fog = isAuto(scene, "fog")
    ? NO_FOG
    : {
        "horizon-fog-blend": number("fog.horizon_blend"),
        "fog-ground-blend": globe
          ? property(fogGroundOnGlobe(sceneForm(scene, look, "fog.ground_blend")), "number")
          : number("fog.ground_blend"),
      };
  return {
    "sky-color": color("sky.color"),
    "horizon-color": color("sky.horizon_color"),
    "sky-horizon-blend": number("sky.horizon_blend"),
    "fog-color": color("fog.color"),
    ...fog,
    // MapLibre's own atmosphere: a hairline rim under the automatic light, a crescent on the sun's side under a set
    // light. The halo around the globe (lib/scene/space.ts) follows the same strength.
    "atmosphere-blend": number("glow.strength"),
  } as SkySpecification;
}

/**
 * The automatic light's place: with the camera (anchor viewport). MapLibre's globe atmosphere reads the light position
 * negated as its sun, so a light with the camera puts the sun behind the planet: the globe's face stays evenly lit
 * with a soft rim, where a light standing on the map puts the sun in front of the face for most centres and washes it
 * white. Zoomed out the sun stands straight behind the planet (polar 0, an even rim); from the city zooms on, volumes
 * get MapLibre's default angle, lit from the viewer's side, which suits a light nobody chose.
 */
export const AUTO_LIGHT_POSITION: Expr = [
  "interpolate",
  ["linear"],
  ["zoom"],
  ...AUTO_LIGHT.polar.flatMap(([zoom, polar]) => [
    zoom,
    ["literal", [LIGHT_RADIUS, AUTO_LIGHT.azimuth, polar]],
  ]),
];

/**
 * A custom light on the zoomed-out globe: with the camera too, else its sun stands at a fixed place on Earth (MapLibre
 * reads a map light's position as seen from latitude and longitude 0) and washes the face white wherever that place
 * faces the camera. The sun stands behind the planet, a third of the light's angle from straight behind, toward the
 * side the light comes from (MapLibre's viewport azimuth 0 is the bottom of the screen, 90 the right): the rim is
 * brighter there, more so for a low light, and the face stays clear.
 */
function globeLightPosition(light: EffectiveLight): [number, number, number] {
  const azimuth = (((180 - light.azimuth) % 360) + 360) % 360;
  return [LIGHT_RADIUS, azimuth, Number(((90 - light.altitude) / 3).toFixed(6))];
}

function lightOf(scene: Scene | undefined, look: AutoLook, onGlobe: boolean): LightSpecification {
  const place = isAuto(scene, "light")
    ? { anchor: "viewport", position: AUTO_LIGHT_POSITION }
    : onGlobe
      ? { anchor: "viewport", position: globeLightPosition(effectiveLight(scene, look)) }
      : { anchor: "map", position: ["global-state", "lightPosition"] };
  return {
    ...place,
    intensity: property(sceneForm(scene, look, "light.intensity"), "number"),
    color: property(sceneForm(scene, look, "light.color"), "color"),
  } as LightSpecification;
}

/** The terrain hillshade's shadow and highlight by tone: over a dark basemap pure white highlights turn the
 * mountains silver and hide the basemap, so both are softened there. */
const TERRAIN_SHADING: Record<Tone, { shadow: string; highlight: string }> = {
  light: { shadow: "#000000", highlight: "#ffffff" },
  dark: { shadow: "rgba(0, 0, 0, 0.7)", highlight: "rgba(255, 255, 255, 0.25)" },
};

/** The terrain's shading: MapLibre's igor hillshade, lit by the scene's light like every hillshade. */
function terrainHillshade(tone: Tone): LayerSpecification {
  return {
    id: TERRAIN_HILLSHADE_LAYER,
    type: "hillshade",
    source: TERRAIN_HILLSHADE_SOURCE,
    paint: {
      "hillshade-method": "igor",
      "hillshade-exaggeration": 0.5,
      "hillshade-shadow-color": TERRAIN_SHADING[tone].shadow,
      "hillshade-highlight-color": TERRAIN_SHADING[tone].highlight,
      "hillshade-accent-color": "#000000",
      ...illumination(DEFAULTS["hillshade.direction"] as number, DEFAULTS["hillshade.altitude"] as number),
    },
  } as LayerSpecification;
}

/**
 * GOAT's globe: MapLibre's vertical perspective handed over to mercator over `GLOBE_HANDOVER`, as MapLibre's own
 * `globe` does over its fixed zooms, so the handover is set in one place.
 */
export const GLOBE_PROJECTION: ProjectionSpecification = {
  type: [
    "interpolate",
    ["linear"],
    ["zoom"],
    GLOBE_HANDOVER.from,
    "vertical-perspective",
    GLOBE_HANDOVER.until,
    "mercator",
  ],
};

/** The zooms the terrain takes to rise once the globe has handed over to mercator. */
export const GLOBE_TERRAIN_RISE = 1;
/** The steps it rises in: MapLibre builds the terrain anew for each exaggeration it is given, so the height changes
 * only a few times on the way. */
export const GLOBE_TERRAIN_STEPS = 10;

/**
 * The terrain's exaggeration at a zoom, or null where the map shows no raised terrain. While the globe draws (below
 * `GLOBE_HANDOVER.until`) the terrain stays flat and only its hillshade shows the relief: MapLibre hides points and
 * labels behind the terrain with a depth test that only works with the globe's own depth range, and fill extrusions
 * need a finer one there (lib/scene/depth.ts). Once the map is mercator the terrain rises over `GLOBE_TERRAIN_RISE`
 * zooms in `GLOBE_TERRAIN_STEPS` steps to the scene's exaggeration; with Globe off it is always full.
 */
export function terrainExaggerationAt(
  zoom: number,
  projection: "mercator" | "globe",
  exaggeration: number
): number | null {
  const from = GLOBE_HANDOVER.until;
  if (projection !== "globe" || zoom >= from + GLOBE_TERRAIN_RISE) return exaggeration;
  if (zoom < from) return null;
  const share = Math.round(((zoom - from) / GLOBE_TERRAIN_RISE) * GLOBE_TERRAIN_STEPS) / GLOBE_TERRAIN_STEPS;
  return Number((exaggeration * share).toFixed(6));
}

/** The compiled terrain as the map shows it at a zoom (see `terrainExaggerationAt`). */
export function terrainAt(
  terrain: TerrainSpecification | null,
  zoom: number,
  projection: "mercator" | "globe"
): TerrainSpecification | null {
  if (!terrain) return null;
  const exaggeration = terrainExaggerationAt(zoom, projection, terrain.exaggeration ?? 1);
  return exaggeration === null ? null : { ...terrain, exaggeration };
}

export function compileScene(i: SceneInputs): CompiledScene {
  const { scene, tone } = i;
  const look: AutoLook = { tone, atmosphere: i.atmosphere };
  const three = i.mode === "3d";
  const globe = i.projection === "globe";
  const out: CompiledScene = {
    projection: globe ? GLOBE_PROJECTION : { type: "mercator" },
    terrain: null,
    sources: {},
    layers: [],
    show: [],
    paint: {},
    sky: null,
    light: null,
    state: stateOf(effectiveLight(scene, look)),
  };

  if (three && scene?.terrain !== false && i.terrainUrl) {
    const dem = (): SourceSpecification => ({
      type: "raster-dem",
      tiles: [i.terrainUrl!],
      encoding: "terrarium",
      tileSize: 512,
      maxzoom: TERRAIN_MAXZOOM,
      attribution: TERRAIN_ATTRIBUTION,
    });
    const exaggeration =
      (scene?.terrain && scene.terrain.exaggeration) ?? (SCENE_DEFAULTS["terrain.exaggeration"] as number);
    out.terrain = { source: TERRAIN_SOURCE, exaggeration };
    out.sources[TERRAIN_SOURCE] = dem();
    // Imagery carries its own shading.
    if (!i.imagery) {
      out.sources[TERRAIN_HILLSHADE_SOURCE] = dem();
      out.layers.push({ layer: terrainHillshade(tone), before: "roads" });
    }
  }

  const setting = buildingsSetting(scene);
  const buildings = three && (setting.on ?? !i.projectExtrudes);
  const plan = i.buildings;
  // A basemap's own buildings switched off are flat, as 2D draws them: their own visibility and opacity, height 0.
  if (plan.kind === "own" && three) {
    if (buildings) out.show.push(...plan.layers);
    const paint: BuildingPaint = buildings
      ? { "fill-extrusion-opacity": setting.opacity }
      : { "fill-extrusion-height": 0, "fill-extrusion-base": 0 };
    out.paint = Object.fromEntries(plan.layers.map((id) => [id, paint]));
  }
  // The basemap's flat footprints of the shown buildings fade where those show (`Footprint`).
  if (buildings && (plan.kind === "own" || plan.kind === "source"))
    for (const { id, opacity } of plan.footprints ?? []) out.paint[id] = { "fill-opacity": opacity };
  if (buildings && plan.kind === "source")
    out.layers.push({
      layer: buildingsLayer(plan.source, buildingColor(plan.color, tone), setting.opacity),
      before: "buildings",
    });
  if (buildings && plan.kind === "overlay") {
    out.sources[BUILDINGS_SOURCE] = { type: "vector", url: plan.url };
    out.layers.push({
      layer: buildingsLayer(BUILDINGS_SOURCE, BUILDING_COLOR[tone], setting.opacity),
      before: "buildings",
    });
  }

  if (three || globe) {
    out.sky = skyOf(scene, look, globe);
    out.light = lightOf(scene, look, globe && !!i.zoomedOut);
  }

  return out;
}
