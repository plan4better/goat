import type { Map as MaplibreMap, StyleSpecification } from "maplibre-gl";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";
import { DEFAULT_BASEMAP, GLYPHS_URL } from "@/lib/constants/basemaps";
import { setActiveBasemap as setActiveBasemapAction } from "@/lib/store/map/slice";
import type { Basemap, BuiltInBasemap } from "@/types/map/common";
import { projectLayerOf } from "@/lib/style/render/mapLayers";
import type { CustomBasemap } from "@/lib/validations/project";

/** Adapts a custom basemap to the Basemap shape used by the selector. */
function customToBasemap(c: CustomBasemap): Basemap {
  return { ...c, source: "custom", value: c.id };
}

/**
 * Resolves the project's saved basemap value to a Basemap entry.
 * Order: built-in match → custom match → legacy URL fallback → DEFAULT_BASEMAP.
 */
export function resolveActiveBasemap(
  value: string | null | undefined,
  builtIns: BuiltInBasemap[],
  customs: CustomBasemap[]
): Basemap {
  if (!value) {
    return builtIns.find((b) => b.value === DEFAULT_BASEMAP) ?? builtIns[0];
  }

  const builtIn = builtIns.find((b) => b.value === value);
  if (builtIn) return builtIn;

  const custom = customs.find((c) => c.id === value);
  if (custom) return customToBasemap(custom);

  if (value.startsWith("http")) {
    return {
      source: "builtin",
      type: "vector",
      value: "custom",
      url: value,
      title: "Custom",
      subtitle: "User defined basemap",
      thumbnail: builtIns[0].thumbnail,
    };
  }

  return builtIns.find((b) => b.value === DEFAULT_BASEMAP) ?? builtIns[0];
}

/**
 * Builds the MapLibre style spec MapViewer feeds to react-map-gl.
 * - vector → URL string (existing path, unchanged)
 * - raster → synthesized raster source/layer style
 * - solid  → synthesized background-only style
 */
export function synthesizeMapStyle(
  basemap: Basemap
): string | StyleSpecification {
  if (basemap.type === "vector") {
    return basemap.url;
  }
  if (basemap.type === "raster") {
    return {
      version: 8,
      glyphs: GLYPHS_URL,
      sources: {
        "raster-source": {
          type: "raster",
          tiles: [basemap.url],
          tileSize: 256,
          attribution: basemap.attribution ?? undefined,
        },
      },
      layers: [
        { id: "raster-layer", type: "raster", source: "raster-source" },
      ],
    } as StyleSpecification;
  }
  // solid
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": basemap.color },
      },
    ],
  } as StyleSpecification;
}

/**
 * A text-field that varies the label BY ZOOM — either a legacy zoom/property
 * function (`{ stops: [...] }`) or a `step`/`interpolate` expression. Styles use
 * these to gate label *content* by zoom (e.g. mobidata-bw's `place_town` is `""`
 * below zoom 9, name at 9+). Overwriting them with a flat name expression makes
 * those labels appear at every zoom, so we leave them untouched.
 */
function isZoomDependentTextField(tf: unknown): boolean {
  if (tf && typeof tf === "object" && !Array.isArray(tf) && "stops" in (tf as object)) {
    return true;
  }
  if (Array.isArray(tf) && (tf[0] === "step" || tf[0] === "interpolate")) {
    return true;
  }
  return false;
}

/**
 * Apply label language to a MapLibre map instance by rewriting text-field
 * expressions on symbol layers to prefer the given locale.
 *
 * Fallback chain (first non-empty wins):
 *   1. name:{locale}  — preferred locale (e.g. name:de)
 *   2. name:en        — English fallback
 *   3. name:latin     — Latin-transliterated name (e.g. mobidata-bw's
 *                       OpenMapTiles only populate this — they leave
 *                       `name`/`name:en`/`name:de` empty, so without
 *                       this entry labels render blank on that basemap)
 *   4. name           — raw native name
 *
 * Zoom-dependent text-fields are preserved (see isZoomDependentTextField) so the
 * style's per-zoom label gating keeps working. Project layers are left alone: their
 * labels are the style's own templates, whatever field names they read.
 */
export function applyMapLanguage(map: MaplibreMap, locale: string) {
  if (!map.isStyleLoaded()) return;
  const style = map.getStyle();
  if (!style?.layers) return;

  for (const layer of style.layers) {
    if (layer.type !== "symbol" || projectLayerOf(map, layer.id) !== undefined) continue;
    const textField = map.getLayoutProperty(layer.id, "text-field");
    if (!textField) continue;

    // Don't clobber zoom-gated labels (would make them show at every zoom).
    if (isZoomDependentTextField(textField)) continue;

    const textStr = JSON.stringify(textField);
    if (!textStr.includes("name")) continue;

    map.setLayoutProperty(layer.id, "text-field", [
      "coalesce",
      ["get", `name:${locale}`],
      ["get", "name:en"],
      ["get", "name:latin"],
      ["get", "name"],
    ]);
  }
}

export const useBasemap = (
  project: { id?: string; custom_basemaps?: CustomBasemap[] | null; basemap?: string | null } | undefined
) => {
  const { t, i18n } = useTranslation("common");

  const builtIns = useAppSelector((state) => state.map.basemaps) as BuiltInBasemap[];
  const storedBasemap = useAppSelector((state) => state.map.activeBasemap);
  const storedBasemapProjectId = useAppSelector((state) => state.map.activeBasemapProjectId);
  // A basemap stored for another project is left over from the previously
  // opened one: ignoring it lets the map start on this project's own basemap.
  const localBasemap = storedBasemapProjectId === project?.id ? storedBasemap : undefined;
  const dispatch = useAppDispatch();

  const customs: CustomBasemap[] = useMemo(
    () => (project?.custom_basemaps as CustomBasemap[] | undefined) ?? [],
    [project]
  );

  /** Built-ins first, then customs adapted to the Basemap shape. */
  const basemaps: Basemap[] = useMemo(
    () => [...builtIns, ...customs.map(customToBasemap)],
    [builtIns, customs]
  );

  /** Translated copy used for selector display. */
  const translatedBaseMaps: Basemap[] = useMemo(() => {
    return basemaps.map((b) => {
      if (b.source !== "builtin") {
        // Customs use their own name/description; no i18n keys.
        return b;
      }
      return {
        ...b,
        title: i18n.exists(`common:basemap_types.${b.value}.title`)
          ? t(`basemap_types.${b.value}.title`)
          : t(b.title),
        subtitle: i18n.exists(`common:basemap_types.${b.value}.subtitle`)
          ? t(`basemap_types.${b.value}.subtitle`)
          : t(b.subtitle),
      };
    });
  }, [basemaps, i18n, t]);

  const activeBasemap: Basemap = useMemo(() => {
    if (!project) return builtIns[0];
    if (localBasemap) return localBasemap as Basemap;
    return resolveActiveBasemap(project.basemap, builtIns, customs);
  }, [builtIns, customs, localBasemap, project]);

  const mapStyle: string | StyleSpecification = useMemo(
    () => synthesizeMapStyle(activeBasemap),
    [activeBasemap]
  );

  const setActiveBasemap = useCallback(
    (value: string) => {
      const resolved = resolveActiveBasemap(value, builtIns, customs);
      dispatch(setActiveBasemapAction({ basemap: resolved, projectId: project?.id }));
    },
    [builtIns, customs, dispatch, project?.id]
  );

  return {
    basemaps,
    translatedBaseMaps,
    activeBasemap,
    mapStyle,
    setActiveBasemap,
  };
};
