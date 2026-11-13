"use client";

// The View popover's content (3D spec 8.2): 2D | 3D, Globe when zoomed out, and in 3D Terrain with its
// exaggeration, 3D buildings with their opacity, the Sky and atmosphere row for editors and the hint on tilting. The switches show what
// the map draws (missing scene keys: terrain on, buildings on unless a project layer extrudes) and write the scene.
// Its rows are the style editor's (Row, SliderRow, NavRow), so they keep the measures of the popovers beside it.
import {
  Box,
  Collapse,
  Divider,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useTranslation } from "react-i18next";

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
import { NavRow, Row, SliderRow } from "@/components/map/panels/styleEditor/rows";

/** The View popover's width. */
export const VIEW_WIDTH = 300;

/** The terrain's exaggeration the style allows (goatlib's limits), in the slider's steps. */
const EXAGGERATION = { min: 1, max: 3, step: 0.5 } as const;

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

/** A setting that is on or off: its name in full (longer than the rows' label column) and the switch at the row's end,
 * where the other rows keep their actions. */
function SwitchControl({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <Row
      actions={
        <Switch
          size="small"
          checked={on}
          onChange={onToggle}
          inputProps={{ role: "switch", "aria-label": label }}
        />
      }>
      <Typography variant="body2" fontWeight={600} noWrap>
        {label}
      </Typography>
    </Row>
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
  const buildings = buildingsSetting(scene);
  const buildingsOn = buildings.on ?? !projectExtrudes;
  const any3d = !!terrainUrl || hasBuildings;

  const entry: PopoverEntry = { key: "view", title: t("view3d.title"), anchorTop: 0, render: () => null };
  return (
    <PopoverFrame entry={entry} width={VIEW_WIDTH} onClose={onClose}>
      <Row>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={mode}
          role="radiogroup"
          aria-label={t("view3d.map_view")}
          onChange={(_, next: ViewMode | null) => next && next !== mode && dispatch(setViewMode(next))}
          sx={{ "& .MuiToggleButton-root": { textTransform: "none", py: 0.5, minHeight: 32 } }}>
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
      </Row>
      {noThree && (
        <Typography
          id="view3d-no-3d"
          component="p"
          variant="caption"
          color="text.secondary"
          sx={{ px: 3, pb: 2 }}>
          {t("view3d.needs_acceleration")}
        </Typography>
      )}
      <SwitchControl
        label={t("view3d.globe")}
        on={globe}
        onToggle={() => dispatch(setProjection(globe ? "mercator" : "globe"))}
      />
      <Collapse in={three && any3d} timeout={reducedMotion ? 0 : 200} unmountOnExit>
        <Divider sx={{ my: 1 }} />
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
                {...EXAGGERATION}
                unit="x"
                value={exaggeration}
                onChange={(value) =>
                  store?.set("scene.terrain", {
                    exaggeration: Math.min(EXAGGERATION.max, Math.max(EXAGGERATION.min, value)),
                  })
                }
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
                min={0}
                max={1}
                step={0.05}
                pct
                value={buildings.opacity}
                onChange={(opacity) =>
                  store?.set(
                    "scene.buildings",
                    withBuildings(scene, { opacity: Math.min(1, Math.max(0, opacity)) })
                  )
                }
              />
            )}
          </>
        )}
      </Collapse>
      {showSky && (three || globe) && (
        <NavRow
          ariaLabel={`${t("view3d.sky")}, ${t(isCustomScene(scene) ? "view3d.custom" : "view3d.auto")}`}
          value={
            <Box component="span" sx={{ display: "flex", gap: 2 }}>
              <Box
                component="span"
                sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {t("view3d.sky")}
              </Box>
              <Box component="span" sx={{ color: "text.secondary", fontWeight: 400 }}>
                {t(isCustomScene(scene) ? "view3d.custom" : "view3d.auto")}
              </Box>
            </Box>
          }
          onOpen={onOpenSky}
        />
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
