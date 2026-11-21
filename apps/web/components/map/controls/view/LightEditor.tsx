"use client";

// The Light popover (3D spec 8.3): where the light comes from, on a sky chart (drag the point: left and right for the
// direction, up and down for the height) and on the Direction and Height sliders; then Intensity and Color, fixed or by
// zoom. The automatic light stands with the camera; the first edit writes it as the light on the map it is there.
import { Box, Typography } from "@mui/material";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { type AutoLook, autoLightAt } from "@/lib/scene/auto";
import type { SceneLight } from "@/lib/style/generated/types";

import { SceneValueRow, sectionShown, useSceneCamera } from "@/components/map/controls/view/SceneValueRow";
import { SkyChart, type SkyPosition } from "@/components/map/controls/view/SkyChart";
import { useEditor, useMapZoom, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { SliderRow } from "@/components/map/panels/styleEditor/rows";

/** The sliders' and the chart's step. */
const STEP = 5;

/** The Light row's summary: "Direction 225°, 30°", or "Auto · from the camera" for the automatic light. */
export function lightSummary(light: SceneLight | null, t: TFunction): string {
  if (!light) return t("view3d.summary_light_auto");
  const auto = autoLightAt(14, 0);
  return t("view3d.summary_direction", {
    direction: Math.round(light.direction ?? auto.direction),
    altitude: Math.round(light.altitude ?? auto.altitude),
  });
}

const clampHeight = (altitude: number) => Math.max(0, Math.min(90, altitude));
const wrapDirection = (direction: number) => ((direction % 360) + 360) % 360;
const snap = (n: number) => Math.round(n / STEP) * STEP;

export function LightEditor({ look }: { look: AutoLook }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const stored = useStyleValue<SceneLight | undefined>("scene.light");
  const camera = useSceneCamera();
  // Read again when the map stops: the automatic light follows the camera.
  useMapZoom();
  const auto = autoLightAt(camera().zoom, camera().bearing);
  const point: SkyPosition = {
    azimuth: stored?.direction ?? auto.direction,
    altitude: clampHeight(stored?.altitude ?? auto.altitude),
  };

  /** One write of the light; an automatic light is written whole first, as it stands for the camera now. */
  const write = (patch: Partial<SceneLight>) => {
    const base = stored ?? sectionShown(store, look, "light", camera());
    store.set("scene.light", { ...base, ...patch });
  };

  const onPlace = (position: SkyPosition) => {
    const direction = wrapDirection(snap(Math.max(0, Math.min(360, position.azimuth))));
    const altitude = snap(clampHeight(position.altitude));
    if (direction !== stored?.direction || altitude !== stored?.altitude) write({ direction, altitude });
  };
  const onStep = (across: number, up: number) => {
    if (across) write({ direction: wrapDirection(Math.round(point.azimuth) + across * STEP) });
    if (up) write({ altitude: clampHeight(Math.round(point.altitude) + up * STEP) });
  };

  const rose = (t("view3d.compass_points") as string).split(",");
  const az = Math.round(point.azimuth);
  const ariaLabel = t("view3d.chart_light", {
    altitude: Math.round(point.altitude),
    azimuth: az,
    compass: rose[Math.round(wrapDirection(az) / 45) % 8],
  });

  return (
    <Box sx={{ display: "flex", flexDirection: "column" }}>
      <SkyChart
        point={point}
        axis={(t("view3d.chart_axis") as string).split(",")}
        ariaLabel={ariaLabel}
        onPlace={onPlace}
        onStep={onStep}
      />
      <Typography component="p" variant="caption" color="text.secondary" sx={{ px: 3, pb: 1.5 }}>
        {t("view3d.light_caption")}
      </Typography>
      <SliderRow
        label={t("view3d.direction")}
        min={0}
        max={355}
        step={STEP}
        unit="°"
        value={Math.round(point.azimuth)}
        onChange={(direction) => write({ direction: wrapDirection(direction) })}
      />
      <SliderRow
        label={t("view3d.height")}
        min={0}
        max={90}
        step={STEP}
        unit="°"
        value={Math.round(point.altitude)}
        onChange={(altitude) => write({ altitude })}
      />
      <SceneValueRow path="scene.light.intensity" label={t("view3d.intensity")} kind="number" look={look} />
      <SceneValueRow path="scene.light.color" label={t("view3d.light_color")} kind="color" look={look} />
    </Box>
  );
}
