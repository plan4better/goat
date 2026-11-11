"use client";

// The View popover's content (3D spec 8.2): 2D | 3D, Globe when zoomed out, and in 3D Terrain with its
// exaggeration, 3D buildings with their opacity, the Sky and atmosphere row for editors and the hint on tilting. The switches show what
// the map draws (missing scene keys: terrain on, buildings on unless a project layer extrudes) and write the scene.
import {
  Box,
  ButtonBase,
  Collapse,
  Divider,
  Slider,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { buildingsSetting, withBuildings } from "@/lib/scene/buildings";
import { graphicsSupport, shownMode } from "@/lib/scene/support";
import type { ViewMode } from "@/lib/scene/view";
import { setProjection, setViewMode } from "@/lib/store/map/slice";
import { SCENE_DEFAULTS } from "@/lib/style/generated/scene";
import type { Scene } from "@/lib/style/generated/types";

import { useSceneDocument, useSceneStoreContext } from "@/hooks/map/useSceneStore";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { PopoverFrame } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import type { PopoverEntry } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { LABEL_WIDTH } from "@/components/map/panels/styleEditor/rows";

/** The View popover's width. */
export const VIEW_WIDTH = 300;

/** The exaggeration steps the slider offers. */
export const EXAGGERATIONS = [1, 1.5, 2, 3] as const;

/** Whether the scene's sky, fog, glow or light is the editor's own. */
export const isCustomScene = (scene: Scene | undefined): boolean =>
  !!(scene?.sky || scene?.fog || scene?.glow || scene?.light);

/** The open project's view mode and projection (2D and mercator before the page set them). */
export function useProjectView(): { mode: ViewMode; projection: "mercator" | "globe" } {
  // A saved 3D view shows in 2D where 3D would be drawn in software; the saved mode stays.
  const mode = shownMode(useAppSelector((state) => state.map.view?.mode ?? "2d"));
  const projection = useAppSelector((state) => state.map.view?.projection ?? "mercator");
  return { mode, projection };
}

/** A row of the View popover: a name and its control (prototype `.vr`). */
function ViewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box
      sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 3, minHeight: 40 }}>
      <Typography variant="body2" fontWeight={600}>
        {label}
      </Typography>
      {children}
    </Box>
  );
}

function SwitchControl({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <ViewRow label={label}>
      <Switch
        size="small"
        checked={on}
        onChange={onToggle}
        inputProps={{ role: "switch", "aria-label": label }}
      />
    </ViewRow>
  );
}

/** A setting's slider under its switch: a caption, the slider and the value it shows. */
function SliderRow({
  label,
  shown,
  ...slider
}: {
  label: string;
  shown: string;
  min: number;
  max: number;
  step: number;
  value: number;
  getAriaValueText: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: `${LABEL_WIDTH}px minmax(0, 1fr) 36px`,
        columnGap: 3,
        alignItems: "center",
        minHeight: 32,
        pb: 1,
      }}>
      <Typography variant="caption" color="text.secondary" noWrap>
        {label}
      </Typography>
      <Slider
        size="small"
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={slider.value}
        aria-label={label}
        getAriaValueText={slider.getAriaValueText}
        onChange={(_, value) => slider.onChange(value as number)}
      />
      <Typography variant="body2" sx={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {shown}
      </Typography>
    </Box>
  );
}

export interface ViewPanelProps {
  /** The deployment's terrain tiles; none: no Terrain row. */
  terrainUrl?: string;
  /** Whether the basemap has a way to 3D buildings. */
  hasBuildings: boolean;
  /** A drawn project layer extrudes: the basemap's buildings start off. */
  projectExtrudes: boolean;
  /** The Sky and atmosphere row (editors). */
  showSky: boolean;
  onClose: () => void;
  onOpenSky: () => void;
}

export function ViewPanel({
  terrainUrl,
  hasBuildings,
  projectExtrudes,
  showSky,
  onClose,
  onOpenSky,
}: ViewPanelProps) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const store = useSceneStoreContext();
  const scene = useSceneDocument(store);
  const { mode, projection } = useProjectView();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const three = mode === "3d";
  const globe = projection === "globe";
  const noThree = graphicsSupport() === "software";

  const terrainOn = scene?.terrain !== false;
  const exaggeration =
    (scene?.terrain ? scene.terrain.exaggeration : undefined) ??
    (SCENE_DEFAULTS["terrain.exaggeration"] as number);
  const step = Math.max(
    0,
    EXAGGERATIONS.findIndex((e) => e >= exaggeration)
  );
  const buildings = buildingsSetting(scene);
  const buildingsOn = buildings.on ?? !projectExtrudes;
  const buildingsPercent = Math.round(buildings.opacity * 100);
  const any3d = !!terrainUrl || hasBuildings;

  const entry: PopoverEntry = { key: "view", title: t("view3d.title"), anchorTop: 0, render: () => null };
  return (
    <PopoverFrame entry={entry} width={VIEW_WIDTH} onClose={onClose}>
      <Box sx={{ px: 3, pt: 1 }}>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={mode}
          role="radiogroup"
          aria-label={t("view3d.map_view")}
          onChange={(_, next: ViewMode | null) => next && next !== mode && dispatch(setViewMode(next))}
          sx={{ mb: 1, "& .MuiToggleButton-root": { textTransform: "none", py: 0.5, minHeight: 32 } }}>
          {(["2d", "3d"] as const).map((m) => (
            <ToggleButton
              key={m}
              value={m}
              role="radio"
              aria-checked={mode === m}
              disabled={m === "3d" && noThree}
              aria-describedby={m === "3d" && noThree ? "view3d-no-3d" : undefined}>
              {t(`view3d.mode_${m}`)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {noThree && (
          <Typography id="view3d-no-3d" component="p" variant="caption" color="text.secondary" sx={{ mb: 1 }}>
            {t("view3d.needs_acceleration")}
          </Typography>
        )}
        <SwitchControl
          label={t("view3d.globe")}
          on={globe}
          onToggle={() => dispatch(setProjection(globe ? "mercator" : "globe"))}
        />
        <Collapse in={three && any3d} timeout={reducedMotion ? 0 : 200} unmountOnExit>
          <Divider sx={{ mt: 1.5, mb: 0.5 }} />
          {terrainUrl && (
            <>
              <SwitchControl
                label={t("view3d.terrain")}
                on={terrainOn}
                onToggle={() => store?.set("scene.terrain", terrainOn ? false : undefined)}
              />
              {terrainOn && (
                <SliderRow
                  label={t("view3d.exaggeration")}
                  shown={`${EXAGGERATIONS[step]}x`}
                  min={0}
                  max={EXAGGERATIONS.length - 1}
                  step={1}
                  value={step}
                  getAriaValueText={(i) => `${EXAGGERATIONS[i]}x`}
                  onChange={(i) => store?.set("scene.terrain", { exaggeration: EXAGGERATIONS[i] })}
                />
              )}
            </>
          )}
          {hasBuildings && (
            <>
              <SwitchControl
                label={t("view3d.buildings")}
                on={buildingsOn}
                onToggle={() => store?.set("scene.buildings", withBuildings(scene, { on: !buildingsOn }))}
              />
              {buildingsOn && (
                <SliderRow
                  label={t("view3d.buildings_opacity")}
                  shown={`${buildingsPercent}%`}
                  min={0}
                  max={100}
                  step={5}
                  value={buildingsPercent}
                  getAriaValueText={(percent) => `${percent}%`}
                  onChange={(percent) =>
                    store?.set("scene.buildings", withBuildings(scene, { opacity: percent / 100 }))
                  }
                />
              )}
            </>
          )}
        </Collapse>
      </Box>
      {showSky && (three || globe) && (
        <ButtonBase
          onClick={onOpenSky}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            width: "100%",
            minHeight: 40,
            px: 3,
            textAlign: "left",
            "&:hover": { bgcolor: "action.hover" },
          }}>
          <Typography variant="body2" fontWeight={600} sx={{ flex: 1, minWidth: 0 }}>
            {t("view3d.sky")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t(isCustomScene(scene) ? "view3d.custom" : "view3d.auto")}
          </Typography>
          <Icon iconName={ICON_NAME.CHEVRON_RIGHT} sx={{ fontSize: 12, color: "text.secondary" }} />
        </ButtonBase>
      )}
      {three && (
        <Typography
          component="p"
          variant="caption"
          color="text.secondary"
          sx={{ mx: 3, mt: 2, pt: 3, borderTop: 1, borderColor: "divider", lineHeight: "18px" }}>
          {t("view3d.hint")}
        </Typography>
      )}
    </PopoverFrame>
  );
}
