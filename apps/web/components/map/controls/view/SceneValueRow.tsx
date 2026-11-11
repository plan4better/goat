"use client";

// A scene colour or number (3D spec 8.3) as the style editor shows a property: its control while fixed, a summary
// that opens the zoom editor while it changes by zoom, and the value mode button (Fixed, By zoom). A section that is
// still automatic shows the automatic values (the auto table with the basemap's atmosphere colours, the light with the
// camera); the first edit writes the whole section from the values shown.
import { useTheme } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { BASEMAPS, DEFAULT_BASEMAP } from "@/lib/constants/basemaps";
import { sceneAtmosphere } from "@/lib/scene/atmosphere";
import {
  type AutoLook,
  type AutoSource,
  type Tone,
  autoForm,
  autoLightAt,
  isImageryBasemap,
  toneOf,
} from "@/lib/scene/auto";
import { fromForm, valueAt } from "@/lib/style/compile/values";
import { SLIDERS } from "@/lib/style/editor/defaults";
import type { Mode } from "@/lib/style/editor/forms";
import { type EditorStore, type Path, setIn } from "@/lib/style/editor/store";
import { summarize, swatchOf } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";
import { isObject } from "@/lib/style/json";

import { useAppSelector } from "@/hooks/store/ContextHooks";

import {
  useEditor,
  useEditorMap,
  useMapZoom,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { ColorRow } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { ZoomEditor } from "@/components/map/panels/styleEditor/editors/ZoomEditor";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { GroupRow, SliderRow } from "@/components/map/panels/styleEditor/rows";
import { ValueModeButton } from "@/components/map/panels/styleEditor/rows/ValueModeButton";

export type SceneSection = "sky" | "fog" | "glow" | "light";

/** The keys of each section a first edit writes. */
export const SECTION_KEYS: Record<SceneSection, string[]> = {
  sky: ["color", "horizon_color", "horizon_blend"],
  fog: ["color", "horizon_blend", "ground_blend"],
  glow: ["strength", "color"],
  light: ["direction", "altitude", "intensity", "color"],
};

function useSceneBasemap() {
  const activeBasemap = useAppSelector((state) => state.map.activeBasemap);
  return activeBasemap ?? BASEMAPS.find((b) => b.value === DEFAULT_BASEMAP) ?? BASEMAPS[0];
}

/** The basemap's tone for the automatic scene, as the map computes it. */
export function useSceneTone(): Tone {
  const theme = useTheme();
  return toneOf(useSceneBasemap(), theme.palette.mode);
}

/** The automatic scene as the map draws it: the basemap's tone and the atmosphere colours of its ground, read from
 * the loaded style again on each new style (lib/scene/atmosphere.ts). */
export function useSceneLook(): AutoLook {
  const tone = useSceneTone();
  const basemap = useSceneBasemap();
  const map = useEditorMap();
  const zoom = useMapZoom();
  const [styles, setStyles] = useState(0);
  useEffect(() => {
    if (!map) return;
    const onStyle = () => setStyles((n) => n + 1);
    map.on("style.load", onStyle);
    return () => {
      map.off("style.load", onStyle);
    };
  }, [map]);
  const level = Math.round(zoom);
  return useMemo(() => {
    let style;
    try {
      style = map?.getStyle();
    } catch {
      style = undefined;
    }
    return { tone, atmosphere: sceneAtmosphere(basemap, isImageryBasemap(basemap), style, level, tone) };
    // `styles` counts the styles loaded: a new one is read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, basemap, tone, level, styles]);
}

/** Where the camera is, for the automatic light a first edit of the light writes (it stands with the camera). */
export interface SceneCamera {
  zoom: number;
  bearing: number;
}

/** A scene key's form as shown: the stored one, else the automatic one. */
export function shownForm(store: EditorStore, look: AutoSource, path: Path): unknown {
  return store.get(path) ?? autoForm(look, path.slice("scene.".length));
}

/** A section as its first edit writes it: every automatic value shown, then the stored keys. The automatic light
 * is written as a light on the map where it stands for `camera`. */
export function sectionShown(
  store: EditorStore,
  look: AutoSource,
  section: SceneSection,
  camera: SceneCamera = { zoom: 14, bearing: 0 }
): Record<string, unknown> {
  const own = store.get(`scene.${section}`);
  const auto: Record<string, unknown> =
    section === "light"
      ? {
          ...autoLightAt(camera.zoom, camera.bearing),
          intensity: autoForm(look, "light.intensity"),
          color: autoForm(look, "light.color"),
        }
      : Object.fromEntries(SECTION_KEYS[section].map((key) => [key, autoForm(look, `${section}.${key}`)]));
  return { ...auto, ...(isObject(own) ? own : {}) };
}

/** Writes a scene value; an automatic section is written whole, with the values it showed. */
export function writeSceneValue(
  store: EditorStore,
  look: AutoSource,
  path: Path,
  value: unknown,
  camera?: SceneCamera
): void {
  const section = path.split(".")[1] as SceneSection;
  const key = path.split(".").slice(2).join(".");
  if (store.get(`scene.${section}`) !== undefined) return store.set(path, value);
  store.set(`scene.${section}`, setIn(sectionShown(store, look, section, camera), key, value));
}

/** The editor map's camera now (a first light edit reads it). */
export function useSceneCamera(): () => SceneCamera {
  const map = useEditorMap();
  return () => ({ zoom: map?.getZoom() ?? 14, bearing: map?.getBearing() ?? 0 });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clampZoom = (z: number) => Math.min(24, Math.max(0, z));

/** A form's one value at a zoom. */
export function valueOfForm(form: unknown, kind: "color" | "number", zoom: number): unknown {
  const value = valueAt(fromForm(form, kind, null), zoom);
  return typeof value === "number" ? round2(value) : value;
}

const isZoomForm = (form: unknown) => isObject(form) && Array.isArray(form.zoom);

export function SceneValueRow({
  path,
  label,
  kind,
  look,
}: {
  path: Path;
  label: string;
  kind: "color" | "number";
  look: AutoLook;
}) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const mapZoom = useMapZoom();
  const popover = usePopover();
  const next = useNextLevel();
  // Renders again when the value changes.
  useStyleValue(path);
  const camera = useSceneCamera();
  const form = shownForm(store, look, path);
  const mode: Mode = isZoomForm(form) ? "zoom" : "fixed";
  const write = (value: unknown) => writeSceneValue(store, look, path, value, camera());

  const openZoom = (anchorTop: number) => {
    // The zoom editor edits the stored value: an automatic section is written first.
    if (store.get(path) === undefined) write(form);
    popover.open(next, {
      key: `zoom:${path}`,
      title: t("style_editor.by_zoom_title", { label }),
      anchorTop,
      render: () => <ZoomEditor path={path} />,
    });
  };
  const select = (to: Mode, anchor: HTMLElement) => {
    if (to === mode) {
      if (to === "zoom") openZoom(anchorTopOf(anchor));
      return;
    }
    const value = valueOfForm(form, kind, mapZoom);
    if (to === "fixed") return write(value);
    const at = Math.round(mapZoom * 2) / 2;
    write({
      zoom: [
        [clampZoom(at - 2), value],
        [clampZoom(at + 2), value],
      ],
    });
    openZoom(anchorTopOf(anchor));
  };
  const modeButton = (
    <ValueModeButton
      label={label}
      propertyKey={path}
      mode={mode}
      modes={["fixed", "zoom"]}
      onSelect={(to, anchor) => select(to as Mode, anchor)}
    />
  );

  if (mode === "zoom") {
    // The summary as the style editor writes it, of the value shown.
    const shown = setIn(store.document, path, form) as LayerStyle;
    const summary = summarize(shown, path, t, { fields: [], mapZoom });
    const swatch = kind === "color" ? { background: swatchOf(shown, path), wide: true } : undefined;
    return (
      <GroupRow
        label={label}
        value={summary}
        swatch={swatch}
        curve={!swatch}
        mode={modeButton}
        onOpen={(anchor) => openZoom(anchorTopOf(anchor))}
      />
    );
  }
  if (kind === "color")
    return (
      <ColorRow
        label={label}
        path={path}
        fallback={typeof form === "string" ? form : undefined}
        write={(value) => write(value)}
        mode={modeButton}
      />
    );
  const range = SLIDERS[path] ?? { min: 0, max: 1, step: 0.05, pct: true };
  return (
    <SliderRow
      label={label}
      min={range.min}
      max={range.max}
      step={range.step}
      unit={range.unit}
      pct={range.pct}
      value={typeof form === "number" ? form : Number(valueOfForm(form, "number", mapZoom))}
      onChange={write}
      mode={modeButton}
    />
  );
}

/** The value a section's key shows at the map zoom (for summaries and swatches). */
export function shownValue(
  store: EditorStore,
  look: AutoSource,
  path: Path,
  kind: "color" | "number",
  zoom: number
): unknown {
  return valueOfForm(shownForm(store, look, path), kind, zoom);
}
