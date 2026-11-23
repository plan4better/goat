"use client";

// The Sky and atmosphere panel (3D spec 8.3): it replaces the View popover's content. Auto (the default) shows the
// values the basemap and the theme give, read only; with Auto off, Sky, Fog (only with terrain), Globe glow and
// Light open the style editor's popovers left of the panel. Turning Auto off changes nothing on the map: every
// section stays automatic until its first edit, which writes it whole from the values shown (the automatic fog is
// none; its popover turns a fog on). A section the camera does not show right now (fog and sky need a steep tilt, the
// glow the globe zoomed out) stays editable; its row is muted and its popover says when it shows.
import { Box, Button, Switch, Tooltip, Typography } from "@mui/material";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { TERRAIN_TILES_URL } from "@/lib/constants";
import type { AutoLook } from "@/lib/scene/auto";
import { type CameraLook, type SectionVisibility, sectionVisibility } from "@/lib/scene/visibility";
import { setIn } from "@/lib/style/editor/store";
import type { LayerStyle, Scene } from "@/lib/style/generated/types";
import { isObject } from "@/lib/style/json";

import { LightEditor, lightSummary } from "@/components/map/controls/view/LightEditor";
import {
  type SceneSection,
  SceneValueRow,
  sectionShown,
  shownForm,
  shownValue,
  useSceneLook,
} from "@/components/map/controls/view/SceneValueRow";
import { VIEW_WIDTH, isCustomScene, useProjectView } from "@/components/map/controls/view/ViewPanel";
import {
  useEditor,
  useEditorMap,
  useMapZoom,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { HeaderSwitch } from "@/components/map/panels/styleEditor/editors/PartEditor";
import { PopoverFrame } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import {
  type PopoverEntry,
  anchorTopOf,
  useCloseWhenGone,
  useIsOpen,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { GroupRow, Row, SwatchBox } from "@/components/map/panels/styleEditor/rows";

const SECTIONS: SceneSection[] = ["sky", "fog", "glow", "light"];

/** The rows of the Sky, Fog and Globe glow popovers. */
const SECTION_ROWS: Record<
  Exclude<SceneSection, "light">,
  Array<{ key: string; label: string; kind: "color" | "number" }>
> = {
  sky: [
    { key: "color", label: "view3d.sky_color", kind: "color" },
    { key: "horizon_color", label: "view3d.horizon_color", kind: "color" },
    { key: "horizon_blend", label: "view3d.sky_to_horizon", kind: "number" },
  ],
  fog: [
    { key: "color", label: "view3d.fog_color", kind: "color" },
    { key: "horizon_blend", label: "view3d.horizon_to_fog", kind: "number" },
    { key: "ground_blend", label: "view3d.fog_to_ground", kind: "number" },
  ],
  glow: [
    { key: "strength", label: "view3d.strength", kind: "number" },
    { key: "color", label: "view3d.glow_color", kind: "color" },
  ],
};

const isZoomForm = (form: unknown) => isObject(form) && Array.isArray(form.zoom);
const pct = (n: unknown) => `${Math.round(Number(n) * 100)}%`;

/** Auto switched off before any section was edited: nothing is written for it, so it lives here until the first
 * edit (shared by the panel and its popovers) or until Auto is switched on again. */
let autoOff = false;
const autoOffListeners = new Set<() => void>();
function setAutoOff(value: boolean) {
  if (autoOff === value) return;
  autoOff = value;
  autoOffListeners.forEach((fn) => fn());
}
function useAutoOff(): boolean {
  return useSyncExternalStore(
    (fn) => {
      autoOffListeners.add(fn);
      return () => {
        autoOffListeners.delete(fn);
      };
    },
    () => autoOff,
    () => false
  );
}

/** Whether the panel shows its sections editable: a section is set, or Auto was switched off. */
function useCustom(scene: Scene): boolean {
  const off = useAutoOff();
  return isCustomScene(scene) || off;
}

/** The scene as the panel's store holds it. */
function useScene(): Scene {
  return (useStyleValue<Scene | undefined>("scene") ?? {}) as Scene;
}

/** The map's tilt and zoom, read when the map stops (not on every frame). */
function useCamera(): { pitch: number; zoom: number } {
  const map = useEditorMap();
  const read = () => ({ pitch: map?.getPitch() ?? 0, zoom: map?.getZoom() ?? 0 });
  const [camera, setCamera] = useState(read);
  useEffect(() => {
    if (!map) return;
    const onEnd = () =>
      setCamera((prev) => {
        const next = { pitch: map.getPitch(), zoom: map.getZoom() };
        return prev.pitch === next.pitch && prev.zoom === next.zoom ? prev : next;
      });
    onEnd();
    for (const type of ["moveend", "pitchend", "zoomend"] as const) map.on(type, onEnd);
    return () => {
      for (const type of ["moveend", "pitchend", "zoomend"] as const) map.off(type, onEnd);
    };
  }, [map]);
  return camera;
}

/** What the camera shows of each section now. */
function useVisibility(): { visible: SectionVisibility; look: CameraLook } {
  const scene = useScene();
  const { mode, projection } = useProjectView();
  const { pitch, zoom } = useCamera();
  const look: CameraLook = {
    mode,
    projection,
    pitch,
    zoom,
    terrain: mode === "3d" && scene.terrain !== false && !!TERRAIN_TILES_URL,
    fog: !!scene.fog,
  };
  return { visible: sectionVisibility(look), look };
}

/** When a hidden section shows (sky, fog, glow). */
const HIDDEN_NOTES: Partial<Record<SceneSection, string>> = {
  sky: "view3d.hidden_sky",
  fog: "view3d.hidden_fog",
  glow: "view3d.hidden_glow",
};

/** A hidden section's note: when the camera shows it. */
function HiddenNote({ section }: { section: "sky" | "fog" | "glow" }) {
  const { t } = useTranslation("common");
  const { visible, look } = useVisibility();
  // No fog is set: there is nothing to show.
  if (visible[section] || (section === "fog" && !look.fog)) return null;
  return (
    <Typography variant="caption" color="text.secondary" sx={{ px: 3, pb: 1 }}>
      {t(HIDDEN_NOTES[section]!)}
    </Typography>
  );
}

/** "Reset to auto": removes the section (or, in the panel, every section). */
function ResetLink({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation("common");
  return (
    <Button
      variant="text"
      size="small"
      onClick={onClick}
      sx={{ mx: 1.5, mt: 1, textTransform: "none", fontWeight: 700, alignSelf: "flex-start" }}>
      {t("view3d.reset")}
    </Button>
  );
}

/** The Fog popover's header switch: the automatic fog is none, so on writes a fog from the values shown and off
 * removes it. */
function FogSwitch({ look }: { look: AutoLook }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const on = useStyleValue("scene.fog") !== undefined;
  return (
    <HeaderSwitch
      name={t("view3d.section_fog")}
      on={on}
      onToggle={() => store.set("scene.fog", on ? undefined : sectionShown(store, look, "fog"))}
    />
  );
}

/** A section's popover content: its rows and its own "Reset to auto". The Fog popover has no rows while no fog is
 * set; its header switch turns one on. */
function SectionEditor({ section, look }: { section: Exclude<SceneSection, "light">; look: AutoLook }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const own = useStyleValue(`scene.${section}`);
  const custom = useCustom(useScene());
  // Back to Auto (the panel's switch or an undo): the section's popover has nothing left to edit.
  useCloseWhenGone(!custom);
  const fogOff = section === "fog" && own === undefined;
  return (
    <Box sx={{ display: "flex", flexDirection: "column" }}>
      {!fogOff && <HiddenNote section={section} />}
      {!fogOff &&
        SECTION_ROWS[section].map((row) => (
          <SceneValueRow
            key={row.key}
            path={`scene.${section}.${row.key}`}
            label={t(row.label)}
            kind={row.kind}
            look={look}
          />
        ))}
      {own !== undefined && section !== "fog" && (
        <ResetLink onClick={() => store.set(`scene.${section}`, undefined)} />
      )}
    </Box>
  );
}

export function SkyPanel({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const scene = useScene();
  const look = useSceneLook();
  const mapZoom = useMapZoom();
  const { visible } = useVisibility();
  const { mode } = useProjectView();
  const terrainOn = mode === "3d" && scene.terrain !== false && !!TERRAIN_TILES_URL;
  const custom = useCustom(scene);
  // A section the camera does not show now: its row is muted, with a note on when it shows.
  const notes: Record<SceneSection, string | undefined> = {
    sky: visible.sky ? undefined : t("view3d.hidden_sky"),
    // The automatic fog is none: nothing to show, nothing hidden.
    fog: visible.fog || !scene.fog ? undefined : t("view3d.hidden_fog"),
    glow: visible.glow ? undefined : t("view3d.hidden_glow"),
    light: undefined,
  };
  const titles: Record<SceneSection, string> = {
    sky: t("view3d.section_sky"),
    fog: t("view3d.section_fog"),
    glow: t("view3d.section_glow"),
    light: t("view3d.section_light"),
  };
  const shown = (path: string, kind: "color" | "number") => shownValue(store, look, path, kind, mapZoom);

  const summaryOf = (section: SceneSection): { swatches: string[]; zoom?: boolean; text: string } => {
    const form = (path: string) => shownForm(store, look, path);
    switch (section) {
      case "sky":
        return {
          swatches: [
            String(shown("scene.sky.color", "color")),
            String(shown("scene.sky.horizon_color", "color")),
          ],
          text: isZoomForm(form("scene.sky.horizon_blend"))
            ? t("view3d.summary_blend_zoom")
            : t("view3d.summary_blend", { value: pct(form("scene.sky.horizon_blend")) }),
        };
      case "fog":
        if (!scene.fog) return { swatches: [], text: t("view3d.summary_off") };
        return {
          swatches: [String(shown("scene.fog.color", "color"))],
          text: isZoomForm(form("scene.fog.ground_blend"))
            ? t("view3d.summary_ground_zoom")
            : t("view3d.summary_ground", { value: pct(form("scene.fog.ground_blend")) }),
        };
      case "glow": {
        const swatches = [String(shown("scene.glow.color", "color"))];
        return isZoomForm(form("scene.glow.strength"))
          ? { swatches, zoom: true, text: t("view3d.summary_by_zoom") }
          : { swatches, text: pct(form("scene.glow.strength")) };
      }
      case "light":
        return {
          swatches: [String(shown("scene.light.color", "color"))],
          text: lightSummary(scene.light ?? null, t),
        };
    }
  };

  // The open section's row is not dimmed while its popover shows.
  const open: Record<SceneSection, boolean> = {
    sky: useIsOpen("scene:sky"),
    fog: useIsOpen("scene:fog"),
    glow: useIsOpen("scene:glow"),
    light: useIsOpen("scene:light"),
  };
  const openSection = (section: SceneSection, anchor: HTMLElement) =>
    popover.open(1, {
      key: `scene:${section}`,
      title: titles[section],
      anchorTop: anchorTopOf(anchor),
      actions: section === "fog" ? <FogSwitch look={look} /> : undefined,
      render: () =>
        section === "light" ? <LightEditor look={look} /> : <SectionEditor section={section} look={look} />,
    });

  const resetAll = () => {
    popover.close(1);
    setAutoOff(false);
    store.update((doc) =>
      SECTIONS.reduce((next, section) => setIn(next, `scene.${section}`, undefined), doc as LayerStyle)
    );
  };
  // Off writes nothing: the map keeps drawing the automatic scene until a section is edited.
  const toggleAuto = () => (custom ? resetAll() : setAutoOff(true));
  // Nothing edited: the panel opens on Auto again next time.
  useEffect(() => () => setAutoOff(false), []);

  const rows = SECTIONS.filter((s) => s !== "fog" || terrainOn);
  const entry: PopoverEntry = {
    key: "sky",
    title: t("view3d.sky"),
    anchorTop: 0,
    render: () => null,
  };
  const glyphOf = (summary: ReturnType<typeof summaryOf>, hidden?: string): ReactNode => (
    <>
      {hidden && (
        <Icon
          iconName={ICON_NAME.EYE_SLASH}
          aria-label={hidden}
          sx={{ fontSize: 12, color: "text.disabled" }}
        />
      )}
      {summary.swatches.map((background, i) => (
        <SwatchBox key={i} swatch={{ background }} />
      ))}
      {summary.zoom && <Icon iconName={ICON_NAME.ZOOM_IN} sx={{ fontSize: 12, color: "text.secondary" }} />}
    </>
  );

  return (
    <PopoverFrame
      entry={entry}
      width={VIEW_WIDTH}
      onClose={onClose}
      onBack={onBack}
      backTitle={t("view3d.title")}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 3,
          px: 3,
          pb: 2,
          borderBottom: 1,
          borderColor: "divider",
        }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" fontWeight={600}>
            {t("view3d.auto")}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t(custom ? "view3d.auto_caption_off" : "view3d.auto_caption_on")}
          </Typography>
        </Box>
        <Switch
          size="small"
          checked={!custom}
          onChange={toggleAuto}
          inputProps={{ role: "switch", "aria-label": t("view3d.auto_aria") }}
        />
      </Box>
      <Box sx={{ pt: 2, display: "flex", flexDirection: "column" }}>
        {rows.map((section) => {
          const summary = summaryOf(section);
          const note = notes[section];
          return custom ? (
            <Tooltip key={section} title={note ?? ""} placement="left">
              <Box>
                <GroupRow
                  label={titles[section]}
                  value={summary.text}
                  glyph={glyphOf(summary, note)}
                  ariaLabel={`${titles[section]}, ${summary.text}`}
                  off={!!note && !open[section]}
                  onOpen={(anchor) => openSection(section, anchor)}
                />
              </Box>
            </Tooltip>
          ) : (
            <Row key={section} label={titles[section]} off={!!note}>
              <Box
                title={note}
                sx={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0, height: 40 }}>
                {glyphOf(summary, note)}
                <Typography variant="body2" noWrap color={note ? "text.disabled" : undefined}>
                  {summary.text}
                </Typography>
              </Box>
            </Row>
          );
        })}
        {custom ? (
          <ResetLink onClick={resetAll} />
        ) : (
          <Typography variant="caption" color="text.secondary" sx={{ px: 3, pt: 2 }}>
            {t("view3d.auto_hint")}
          </Typography>
        )}
      </Box>
    </PopoverFrame>
  );
}
